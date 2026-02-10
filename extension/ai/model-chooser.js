/**
 * LEGACY MODULE — NOT USED IN PRODUCTION PATH.
 *
 * This file is kept only as historical reference for previous model-selection
 * experiments. Active model selection now lives in `LlmEngine` and uses
 * `ModelSelection` policies with benchmark/rate-limit data.
 *
 * Do not import this file in background bootstrap or UI runtime paths.
 * In MV3, minimizing loaded scripts reduces complexity and restart overhead.
 */
(function initModelChooser(global) {
  class ModelChooser {
    constructor({ chromeApi, modelRegistry, benchmarkStore, benchmarker, eventLogger }) {
      this.chromeApi = chromeApi;
      this.modelRegistry = modelRegistry;
      this.benchmarkStore = benchmarkStore;
      this.benchmarker = benchmarker;
      this.aiCommon = global.NT && global.NT.AiCommon ? global.NT.AiCommon : null;
      this.time = global.NT && global.NT.Time ? global.NT.Time : null;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
    }

    async choose({ taskType, policy, modelSpecs, tabId } = {}) {
      const validSpecs = this.filterValidSpecs(modelSpecs);
      const decision = {
        policy: policy || 'fastest',
        reason: null,
        considered: this.buildConsidered(validSpecs)
      };

      if (!validSpecs.length) {
        decision.reason = 'NO_MODELS';
        return this.finalizeDecision(null, decision, tabId, taskType);
      }

      if (decision.policy === 'cheapest') {
        const chosen = this.pickCheapest(validSpecs);
        decision.reason = 'MIN_COST';
        return this.finalizeDecision(chosen, decision, tabId, taskType);
      }

      if (decision.policy === 'smartest') {
        const chosen = this.pickSmartest(validSpecs);
        decision.reason = 'MAX_RANK';
        return this.finalizeDecision(chosen, decision, tabId, taskType);
      }

      const fastest = await this.pickFastest(validSpecs, decision);
      decision.reason = fastest.reason;
      if (fastest.considered) {
        decision.considered = fastest.considered;
      }
      return this.finalizeDecision(fastest.modelSpec, decision, tabId, taskType);
    }

    filterValidSpecs(modelSpecs) {
      if (!Array.isArray(modelSpecs) || !this.modelRegistry || !this.modelRegistry.byKey) {
        return [];
      }

      const unique = new Set();
      const valid = [];
      modelSpecs.forEach((spec) => {
        if (!spec || unique.has(spec)) {
          return;
        }
        if (this.modelRegistry.byKey[spec]) {
          unique.add(spec);
          valid.push(spec);
        }
      });

      return valid;
    }

    buildConsidered(modelSpecs) {
      return modelSpecs.map((spec) => this.describeSpec(spec));
    }

    describeSpec(modelSpec) {
      const entry = this.modelRegistry && this.modelRegistry.byKey
        ? this.modelRegistry.byKey[modelSpec]
        : null;
      if (!entry) {
        return { modelSpec };
      }

      return {
        modelSpec,
        modelId: entry.id,
        tier: entry.tier,
        sum_1M: entry.sum_1M,
        capabilityRank: entry.capabilityRank,
        medianMs: null
      };
    }

    pickCheapest(modelSpecs) {
      return modelSpecs.reduce((best, spec) => {
        if (!best) {
          return spec;
        }
        return this.isCheaper(spec, best) ? spec : best;
      }, null);
    }

    pickSmartest(modelSpecs) {
      return modelSpecs.reduce((best, spec) => {
        if (!best) {
          return spec;
        }
        const entry = this.modelRegistry.byKey[spec];
        const bestEntry = this.modelRegistry.byKey[best];
        if (!entry || !bestEntry) {
          return best;
        }
        if (entry.capabilityRank !== bestEntry.capabilityRank) {
          return entry.capabilityRank > bestEntry.capabilityRank ? spec : best;
        }
        return this.isCheaper(spec, best) ? spec : best;
      }, null);
    }

    async pickFastest(modelSpecs, decision) {
      const freshBenchmarks = await this.benchmarkStore.getAll();
      const considered = decision.considered.map((item) => ({ ...item }));

      considered.forEach((entry) => {
        const bench = freshBenchmarks[entry.modelSpec];
        if (bench && typeof bench.medianMs === 'number') {
          entry.medianMs = bench.medianMs;
        }
      });

      const withBench = considered.filter((entry) => typeof entry.medianMs === 'number');
      if (withBench.length) {
        const fastest = this.pickFastestFromBench(withBench, modelSpecs);
        const missing = modelSpecs.filter((spec) => !freshBenchmarks[spec]);
        if (missing.length && this.benchmarker && typeof this.benchmarker.scheduleBenchmarks === 'function') {
          this.benchmarker.scheduleBenchmarks(missing, { force: false, reason: 'missing' });
        }
        return { modelSpec: fastest, reason: 'MIN_LATENCY', considered };
      }

      const candidates = this.selectPrebenchCandidates(modelSpecs);
      const quick = this.benchmarker && typeof this.benchmarker.quickPrebench === 'function'
        ? await this.benchmarker.quickPrebench(candidates, {
          maxModels: 5,
          budgetMs: 3000
        })
        : null;

      const quickResults = quick && quick.results ? quick.results : {};
      considered.forEach((entry) => {
        const quickEntry = quickResults[entry.modelSpec];
        if (quickEntry && typeof quickEntry.medianMs === 'number') {
          entry.medianMs = quickEntry.medianMs;
        }
      });

      const quickBench = considered.filter((entry) => typeof entry.medianMs === 'number');
      if (quickBench.length) {
        const fastest = this.pickFastestFromBench(quickBench, modelSpecs);
        if (this.benchmarker && typeof this.benchmarker.scheduleBenchmarks === 'function') {
          this.benchmarker.scheduleBenchmarks(modelSpecs, { force: false, reason: 'full' });
        }
        return { modelSpec: fastest, reason: 'QUICK_BENCH', considered };
      }

      const fallback = this.pickCheapest(modelSpecs);
      if (this.benchmarker && typeof this.benchmarker.scheduleBenchmarks === 'function') {
        this.benchmarker.scheduleBenchmarks(modelSpecs, { force: false, reason: 'full' });
      }
      return { modelSpec: fallback, reason: 'NO_BENCH', considered };
    }

    pickFastestFromBench(benchEntries, modelSpecs) {
      const fastest = benchEntries.reduce((best, entry) => {
        if (!best) {
          return entry;
        }
        if (entry.medianMs !== best.medianMs) {
          return entry.medianMs < best.medianMs ? entry : best;
        }
        const smarter = this.pickSmartest([entry.modelSpec, best.modelSpec]);
        if (smarter && smarter !== best.modelSpec) {
          return entry;
        }
        return this.isCheaper(entry.modelSpec, best.modelSpec) ? entry : best;
      }, null);

      if (fastest && fastest.modelSpec) {
        return fastest.modelSpec;
      }

      return modelSpecs[0];
    }

    selectPrebenchCandidates(modelSpecs) {
      const entries = modelSpecs.map((spec) => ({
        spec,
        entry: this.modelRegistry.byKey[spec]
      }));

      entries.sort((a, b) => {
        const rankA = a.entry ? a.entry.capabilityRank : 0;
        const rankB = b.entry ? b.entry.capabilityRank : 0;
        if (rankA !== rankB) {
          return rankB - rankA;
        }
        return this.sortByPrice(a.entry, b.entry);
      });

      return entries.map((item) => item.spec);
    }

    sortByPrice(entryA, entryB) {
      const aValue = entryA && typeof entryA.sum_1M === 'number' ? entryA.sum_1M : Number.POSITIVE_INFINITY;
      const bValue = entryB && typeof entryB.sum_1M === 'number' ? entryB.sum_1M : Number.POSITIVE_INFINITY;
      if (aValue === bValue) {
        return 0;
      }
      return aValue - bValue;
    }

    isCheaper(spec, candidate) {
      const entry = this.modelRegistry.byKey[spec];
      const other = this.modelRegistry.byKey[candidate];
      const price = typeof entry.sum_1M === 'number' ? entry.sum_1M : Number.POSITIVE_INFINITY;
      const otherPrice = typeof other.sum_1M === 'number' ? other.sum_1M : Number.POSITIVE_INFINITY;
      if (price === otherPrice) {
        return spec < candidate;
      }
      return price < otherPrice;
    }

    finalizeDecision(modelSpec, decision, tabId, taskType) {
      const chosenSpec = modelSpec || null;
      const parsed = this.aiCommon && typeof this.aiCommon.parseModelSpec === 'function'
        ? this.aiCommon.parseModelSpec(chosenSpec)
        : { id: '', tier: 'standard' };
      const result = {
        chosenModelSpec: chosenSpec,
        chosenModelId: parsed.id || null,
        serviceTier: this.aiCommon && typeof this.aiCommon.mapServiceTier === 'function'
          ? this.aiCommon.mapServiceTier(parsed.tier)
          : 'default',
        decision: {
          ...decision,
          considered: decision.considered.map((item) => ({ ...item }))
        }
      };

      this.logEvent('info', 'chooser', 'Model decision finalized', {
        source: 'background',
        modelSpec: result.chosenModelSpec,
        stage: decision.policy
      });
      return result;
    }

    storeDecision(tabId, result, taskType) {
      // legacy no-op: model decision persistence moved to BG TabStateStore
    }

    now() {
      return this.time && typeof this.time.now === 'function' ? this.time.now() : Date.now();
    }

    logEvent(level, tag, message, meta) {
      if (!this.eventLogger) {
        return;
      }
      this.eventLogger({ level, tag, message, meta });
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.ModelChooser = ModelChooser;
})(globalThis);
