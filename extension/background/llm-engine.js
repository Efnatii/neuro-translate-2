(function initLlmEngine(global) {
  class LlmEngine {
    constructor({
      chromeApi,
      llmClient,
      modelRegistry,
      benchmarkStore,
      benchmarker,
      rateLimitStore,
      loadScheduler,
      eventLogger
    } = {}) {
      this.chromeApi = chromeApi;
      this.llmClient = llmClient;
      this.modelRegistry = modelRegistry || { byKey: {} };
      this.benchmarkStore = benchmarkStore;
      this.benchmarker = benchmarker;
      this.rateLimitStore = rateLimitStore;
      this.loadScheduler = loadScheduler;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.aiCommon = global.NT && global.NT.AiCommon ? global.NT.AiCommon : null;
      const RetryLoop = global.NT && global.NT.RetryLoop ? global.NT.RetryLoop : null;
      this.retryLoop = RetryLoop
        ? new RetryLoop({
          maxAttempts: 2,
          maxTotalMs: 15000,
          baseDelayMs: 800,
          maxDelayMs: 3500,
          multiplier: 2,
          jitterMs: 250
        })
        : null;
    }

    async getModelSpec({ tabId, taskType, selectedModelSpecs, modelSelection, estTokens }) {
      const normalizedSelection = this.normalizeModelSelection(modelSelection);
      const candidates = this.normalizeCandidates(selectedModelSpecs);
      if (!candidates.length) {
        const error = new Error('NO_MODELS_SELECTED');
        error.code = 'NO_MODELS_SELECTED';
        throw error;
      }

      const policy = this.toPolicyString(normalizedSelection);
      const now = Date.now();
      const rateSnapshots = this.rateLimitStore ? await this.rateLimitStore.getAll() : {};
      if (this.rateLimitStore && typeof this.rateLimitStore.withCached === 'function') {
        this.rateLimitStore.withCached(rateSnapshots);
      }
      const enriched = candidates.map((candidate) => {
        const availability = this.rateLimitStore
          ? this.rateLimitStore.computeAvailability(candidate.modelSpec, { estTokens, now })
          : { ok: true, waitMs: 0, reason: 'unknown_limits' };
        return { ...candidate, availability };
      });

      if (normalizedSelection.speed && this.benchmarker) {
        this.benchmarker.scheduleBenchmarks(candidates.map((item) => item.modelSpec), { force: false, reason: 'auto' });
      }

      let benchmarks = this.benchmarkStore ? await this.benchmarkStore.getAll() : {};
      if (normalizedSelection.speed) {
        const hasFresh = enriched.some((item) => {
          const bench = benchmarks[item.modelSpec];
          return bench && typeof bench.medianMs === 'number';
        });

        if (!hasFresh && this.benchmarker && typeof this.benchmarker.quickPrebench === 'function') {
          await this.benchmarker.quickPrebench(candidates.map((item) => item.modelSpec), {
            maxModels: 4,
            budgetMs: 1200
          });
          benchmarks = this.benchmarkStore ? await this.benchmarkStore.getAll() : {};
        }
      }

      const prepared = enriched.map((item) => {
        const bench = benchmarks[item.modelSpec] || null;
        return {
          ...item,
          latency: bench && typeof bench.medianMs === 'number' ? bench.medianMs : Number.POSITIVE_INFINITY
        };
      });

      const available = prepared.filter((item) => item.availability && item.availability.ok);
      let chosen = null;
      let reason = 'fallback';

      if (available.length) {
        const picked = this.pickCandidate(available, normalizedSelection);
        chosen = picked.candidate;
        reason = picked.reason;
      } else {
        chosen = prepared.reduce((best, item) => {
          if (!best) {
            return item;
          }
          const wait = item.availability ? item.availability.waitMs : Number.POSITIVE_INFINITY;
          const bestWait = best.availability ? best.availability.waitMs : Number.POSITIVE_INFINITY;
          return wait < bestWait ? item : best;
        }, null);
        reason = 'rate_limited_all';
      }

      const decision = {
        chosenModelSpec: chosen ? chosen.modelSpec : null,
        chosenModelId: chosen ? chosen.id : null,
        serviceTier: chosen ? this.mapServiceTier(chosen.tier) : 'default',
        policy,
        reason,
        candidates: prepared.map((item) => ({
          modelSpec: item.modelSpec,
          rank: item.capabilityRank,
          cost: item.cost,
          latency: Number.isFinite(item.latency) ? item.latency : null,
          available: Boolean(item.availability && item.availability.ok),
          waitMs: item.availability ? item.availability.waitMs : 0,
          blockReason: item.availability ? item.availability.reason : 'unknown_limits'
        }))
      };

      if (tabId !== null && tabId !== undefined) {
        await this.storeDecision(tabId, decision, taskType);
      }

      return decision;
    }

    async request({
      tabId,
      taskType,
      input,
      maxOutputTokens,
      temperature,
      store,
      background,
      selectedModelSpecs,
      modelSelection,
      signal
    } = {}) {
      const estTokens = this.estimateTokens({ input, maxOutputTokens });
      const startedAt = Date.now();

      const executeAttempt = async () => {
        await this.loadScheduler.reserveSlot({
          kind: 'LLM_REQUEST',
          estTokens,
          estRpm: 1,
          priority: 'high',
          signal
        });

        const decision = await this.getModelSpec({
          tabId,
          taskType,
          selectedModelSpecs,
          modelSelection,
          estTokens
        });

        try {
          const response = await this.llmClient.generateResponseRaw({
            modelId: decision.chosenModelId,
            serviceTier: decision.serviceTier,
            input,
            maxOutputTokens,
            temperature,
            store,
            background,
            signal
          });
          if (this.rateLimitStore) {
            await this.rateLimitStore.upsertFromHeaders(decision.chosenModelSpec, response.headers, { receivedAt: Date.now() });
          }
          return response;
        } catch (error) {
          if (this.rateLimitStore && error && error.headers) {
            await this.rateLimitStore.upsertFromHeaders(decision.chosenModelSpec, error.headers, { receivedAt: Date.now() });
          }
          if (error && error.retryAfterMs && this.loadScheduler) {
            this.loadScheduler.onRateLimited({ retryAfterMs: error.retryAfterMs, kind: 'LLM_REQUEST' });
          }
          this.logEvent('warn', 'llm', error && error.message ? error.message : 'LLM attempt failed', {
            modelSpec: decision.chosenModelSpec,
            status: error && error.status ? error.status : null,
            retryAfterMs: error && error.retryAfterMs ? error.retryAfterMs : null,
            stage: 'attempt'
          });
          throw error;
        }
      };

      try {
        const response = this.retryLoop
          ? await this.retryLoop.run(executeAttempt)
          : await executeAttempt();
        this.logEvent('info', 'llm', 'LLM ok', {
          latencyMs: Date.now() - startedAt,
          status: response.status
        });
        return response.json;
      } catch (error) {
        this.logEvent('error', 'llm', error && error.message ? error.message : 'LLM failed', {
          status: error && error.status ? error.status : null,
          retryAfterMs: error && error.retryAfterMs ? error.retryAfterMs : null,
          stage: 'terminal'
        });
        throw error;
      }
    }

    pickCandidate(candidates, modelSelection) {
      const speed = Boolean(modelSelection && modelSelection.speed);
      const preference = modelSelection && modelSelection.preference ? modelSelection.preference : null;

      if (!speed && preference === 'smartest') {
        const chosen = this.pickSmartest(candidates);
        return { candidate: chosen, reason: 'smartest_max_rank' };
      }
      if (!speed && preference === 'cheapest') {
        const chosen = this.pickCheapest(candidates);
        return { candidate: chosen, reason: 'cheapest_min_cost' };
      }
      if (speed && !preference) {
        const chosen = this.pickSpeed(candidates);
        return { candidate: chosen, reason: 'speed_min_latency' };
      }
      if (speed && preference === 'smartest') {
        const topRank = Math.max(...candidates.map((item) => item.capabilityRank || 0));
        const subset = candidates.filter((item) => (item.capabilityRank || 0) >= topRank - 3);
        if (subset.length) {
          return { candidate: this.pickSpeed(subset), reason: 'speed_top_rank_window' };
        }
        return { candidate: this.pickSpeed(candidates), reason: 'speed_fallback' };
      }
      if (speed && preference === 'cheapest') {
        const minCost = Math.min(...candidates.map((item) => item.cost));
        const subset = candidates.filter((item) => item.cost <= minCost * 1.25);
        if (subset.length) {
          return { candidate: this.pickSpeed(subset), reason: 'speed_cost_window' };
        }
        return { candidate: this.pickSpeed(candidates), reason: 'speed_fallback' };
      }

      return { candidate: this.pickSpeed(candidates), reason: 'speed_default' };
    }

    pickSmartest(candidates) {
      return candidates.slice().sort((a, b) => {
        if ((b.capabilityRank || 0) !== (a.capabilityRank || 0)) {
          return (b.capabilityRank || 0) - (a.capabilityRank || 0);
        }
        if (a.latency !== b.latency) {
          return a.latency - b.latency;
        }
        if (a.cost !== b.cost) {
          return a.cost - b.cost;
        }
        return a.modelSpec.localeCompare(b.modelSpec);
      })[0];
    }

    pickCheapest(candidates) {
      return candidates.slice().sort((a, b) => {
        if (a.cost !== b.cost) {
          return a.cost - b.cost;
        }
        if (a.latency !== b.latency) {
          return a.latency - b.latency;
        }
        if ((b.capabilityRank || 0) !== (a.capabilityRank || 0)) {
          return (b.capabilityRank || 0) - (a.capabilityRank || 0);
        }
        return a.modelSpec.localeCompare(b.modelSpec);
      })[0];
    }

    pickSpeed(candidates) {
      return candidates.slice().sort((a, b) => {
        if (a.latency !== b.latency) {
          return a.latency - b.latency;
        }
        if ((b.capabilityRank || 0) !== (a.capabilityRank || 0)) {
          return (b.capabilityRank || 0) - (a.capabilityRank || 0);
        }
        if (a.cost !== b.cost) {
          return a.cost - b.cost;
        }
        return a.modelSpec.localeCompare(b.modelSpec);
      })[0];
    }

    normalizeCandidates(selectedModelSpecs) {
      if (!Array.isArray(selectedModelSpecs)) {
        return [];
      }
      const seen = new Set();
      return selectedModelSpecs
        .filter((modelSpec) => {
          if (!modelSpec || seen.has(modelSpec) || !this.modelRegistry.byKey[modelSpec]) {
            return false;
          }
          seen.add(modelSpec);
          return true;
        })
        .map((modelSpec) => {
          const entry = this.modelRegistry.byKey[modelSpec];
          return {
            modelSpec,
            id: entry.id,
            tier: entry.tier,
            capabilityRank: typeof entry.capabilityRank === 'number' ? entry.capabilityRank : 0,
            cost: typeof entry.sum_1M === 'number' ? entry.sum_1M : Number.POSITIVE_INFINITY
          };
        });
    }

    normalizeModelSelection(selection) {
      const source = selection && typeof selection === 'object' ? selection : {};
      const speed = source.speed !== false;
      const preference = source.preference === 'smartest' || source.preference === 'cheapest'
        ? source.preference
        : null;
      return { speed, preference };
    }

    toPolicyString(modelSelection) {
      const speed = Boolean(modelSelection && modelSelection.speed);
      const preference = modelSelection && modelSelection.preference ? modelSelection.preference : null;
      if (speed && preference) {
        return `speed+${preference}`;
      }
      if (speed) {
        return 'speed';
      }
      return preference || 'speed';
    }

    mapServiceTier(tier) {
      if (this.aiCommon && typeof this.aiCommon.mapServiceTier === 'function') {
        return this.aiCommon.mapServiceTier(tier);
      }
      return 'default';
    }

    estimateTokens({ input, maxOutputTokens }) {
      let promptLength = 0;
      if (typeof input === 'string') {
        promptLength = input.length;
      } else {
        try {
          promptLength = JSON.stringify(input || '').length;
        } catch (error) {
          promptLength = 0;
        }
      }
      const maxOutput = typeof maxOutputTokens === 'number' ? maxOutputTokens : 0;
      return Math.ceil(promptLength / 4) + maxOutput;
    }

    async storeDecision(tabId, decision, taskType) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return;
      }

      const payload = {
        chosenModelSpec: decision.chosenModelSpec,
        chosenModelId: decision.chosenModelId,
        serviceTier: decision.serviceTier,
        decision: {
          policy: decision.policy,
          reason: decision.reason,
          candidates: decision.candidates
        },
        taskType: taskType || 'unknown',
        updatedAt: Date.now()
      };

      await new Promise((resolve) => {
        this.chromeApi.storage.local.get({ translationStatusByTab: {} }, (data) => {
          const status = { ...(data.translationStatusByTab || {}) };
          const current = status[tabId] || {};
          status[tabId] = {
            ...current,
            modelDecision: payload
          };
          this.chromeApi.storage.local.set({ translationStatusByTab: status }, () => resolve());
        });
      });
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
  global.NT.LlmEngine = LlmEngine;
})(globalThis);
