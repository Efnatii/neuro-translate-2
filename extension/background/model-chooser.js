(function initModelChooser(global) {
  class ModelChooser {
    constructor({ chromeApi, modelRegistry, benchmarkStore, benchmarker }) {
      this.chromeApi = chromeApi;
      this.modelRegistry = modelRegistry;
      this.benchmarkStore = benchmarkStore;
      this.benchmarker = benchmarker;
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

      const fastest = await this.pickFastest(validSpecs);
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

    async pickFastest(modelSpecs) {
      const missingBench = await this.ensureBenchmarks(modelSpecs);
      const benchmarks = await this.loadBenchmarks(modelSpecs);

      if (missingBench || benchmarks.some((entry) => entry.medianMs === null)) {
        return { modelSpec: this.pickCheapest(modelSpecs), reason: 'NO_BENCH', considered: benchmarks };
      }

      const fastest = benchmarks.reduce((best, entry) => {
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

      return { modelSpec: fastest ? fastest.modelSpec : modelSpecs[0], reason: 'MIN_LATENCY', considered: benchmarks };
    }

    async ensureBenchmarks(modelSpecs) {
      const entries = await Promise.all(modelSpecs.map((spec) => this.benchmarkStore.get(spec)));
      const missing = entries.some((entry) => !entry || typeof entry.medianMs !== 'number');
      if (missing) {
        await this.benchmarker.benchmarkSelected(modelSpecs, { force: false });
      }
      return missing;
    }

    async loadBenchmarks(modelSpecs) {
      const entries = [];
      for (const spec of modelSpecs) {
        const stored = await this.benchmarkStore.get(spec);
        const considered = this.describeSpec(spec);
        considered.medianMs = stored && typeof stored.medianMs === 'number' ? stored.medianMs : null;
        entries.push(considered);
      }
      return entries;
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
      const parsed = this.parseModelSpec(chosenSpec);
      const result = {
        chosenModelSpec: chosenSpec,
        chosenModelId: parsed.id || null,
        serviceTier: this.mapServiceTier(parsed.tier),
        decision: {
          ...decision,
          considered: decision.considered.map((item) => ({ ...item }))
        }
      };

      if (tabId !== null && tabId !== undefined) {
        this.storeDecision(tabId, result, taskType);
      }

      return result;
    }

    storeDecision(tabId, result, taskType) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return;
      }

      const payload = {
        chosenModelSpec: result.chosenModelSpec,
        chosenModelId: result.chosenModelId,
        serviceTier: result.serviceTier,
        decision: result.decision,
        taskType: taskType || 'unknown',
        updatedAt: Date.now()
      };

      this.chromeApi.storage.local.get({ translationStatusByTab: {} }, (data) => {
        const status = { ...(data.translationStatusByTab || {}) };
        const current = status[tabId] || {};
        status[tabId] = {
          ...current,
          modelDecision: payload
        };
        this.chromeApi.storage.local.set({ translationStatusByTab: status });
      });
    }

    parseModelSpec(modelSpec) {
      const AiCommon = global.NT && global.NT.AiCommon ? global.NT.AiCommon : null;
      if (AiCommon && typeof AiCommon.parseModelSpec === 'function') {
        return AiCommon.parseModelSpec(modelSpec);
      }

      const [idPart, tierPart] = String(modelSpec || '').split(':');
      return { id: idPart || '', tier: tierPart || 'standard' };
    }

    mapServiceTier(tier) {
      const normalized = String(tier || '').trim().toLowerCase();
      if (normalized === 'flex') {
        return 'flex';
      }
      if (normalized === 'priority') {
        return 'priority';
      }
      return 'default';
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.ModelChooser = ModelChooser;
})(globalThis);
