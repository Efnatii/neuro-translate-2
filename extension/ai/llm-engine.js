/**
 * AI request engine focused on model selection and retry orchestration.
 *
 * Role:
 * - Select the best model per request and execute response calls under
 *   scheduler/rate-limit constraints.
 *
 * Public contract:
 * - `request(...)` returns `{json, decision}`.
 * - `getModelSpec(...)` returns deterministic decision metadata for chosen model.
 *
 * Dependencies:
 * - `AiRuntimeBase` shared runtime helpers, benchmark/performance/rate-limit
 *   stores, `AiLoadScheduler`, and `AiResponseCall`.
 *
 * Side effects:
 * - Schedules benchmark tasks, marks chosen model fairness windows, applies
 *   cooldowns on 429, and emits diagnostic events.
 *
 * Boundary:
 * - This class does not persist tab/UI state directly; background orchestration
 *   remains owner of tab-scoped status writes.
 */
(function initLlmEngine(global) {
  const NT = global.NT || (global.NT = {});
  const AiRuntimeBase = NT.AiRuntimeBase || class {
    now() { return Date.now(); }
    logEvent() {}
    parseModelSpec() { return { id: '', tier: 'standard' }; }
    mapServiceTier() { return 'default'; }
  };

  class LlmEngine extends AiRuntimeBase {
    constructor({
      responseCall,
      modelRegistry,
      benchmarkStore,
      benchmarker,
      rateLimitStore,
      perfStore,
      loadScheduler,
      eventLogger,
      eventFactory
    } = {}) {
      super({
        time: NT.Time,
        eventFactory,
        eventLogger,
        aiCommon: NT.AiCommon || null
      });
      this.responseCall = responseCall;
      this.modelRegistry = modelRegistry || { byKey: {} };
      this.benchmarkStore = benchmarkStore;
      this.benchmarker = benchmarker;
      this.rateLimitStore = rateLimitStore;
      this.perfStore = perfStore || null;
      this.loadScheduler = loadScheduler;
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

    async getModelSpec({ tabId, taskType, selectedModelSpecs, modelSelection, estTokens, pressureTokens, hintPrevModelSpec }) {
      const SelectionPolicy = NT.AiModelSelection || NT.ModelSelection;
      const normalizedSelection = SelectionPolicy && typeof SelectionPolicy.normalize === 'function'
        ? SelectionPolicy.normalize(modelSelection, null)
        : { speed: true, preference: null };
      const candidates = this.normalizeCandidates(selectedModelSpecs);
      if (!candidates.length) {
        const error = new Error('NO_MODELS_SELECTED');
        error.code = 'NO_MODELS_SELECTED';
        throw error;
      }

      const policy = this.toPolicyString(normalizedSelection);
      const now = Date.now();
      const rateSnapshots = this.rateLimitStore ? await this.rateLimitStore.getAll() : {};
      const perfMap = this.perfStore ? await this.perfStore.getAll() : {};
      if (this.rateLimitStore && typeof this.rateLimitStore.withCached === 'function') {
        this.rateLimitStore.withCached(rateSnapshots);
      }

      const enriched = candidates.map((candidate) => {
        const availability = this.rateLimitStore
          ? this.rateLimitStore.computeAvailability(candidate.modelSpec, { estTokens, now })
          : { ok: true, waitMs: 0, reason: 'unknown_limits' };
        const snapshot = rateSnapshots[candidate.modelSpec] || null;
        return {
          ...candidate,
          availability,
          snapshot,
          perf: this.getFreshPerfEntry(perfMap[candidate.modelSpec] || null, now),
          usagePenalty: this.rateLimitStore ? this.rateLimitStore.usagePenalty(snapshot, now) : 0,
          limitRiskPenalty: this.limitRiskPenalty(snapshot, estTokens, pressureTokens)
        };
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
        const perf = item.perf || null;
        const tps = perf && typeof perf.ewmaTps === 'number' ? perf.ewmaTps : null;
        const realLatencyMs = perf && typeof perf.ewmaLatencyMs === 'number' ? perf.ewmaLatencyMs : null;
        const pingLatencyMs = bench && typeof bench.medianMs === 'number' ? bench.medianMs : null;
        return {
          ...item,
          tps,
          realLatencyMs,
          pingLatencyMs,
          latencyMs: realLatencyMs || pingLatencyMs || Number.POSITIVE_INFINITY
        };
      });

      if (normalizedSelection.speed && !prepared.some((item) => typeof item.tps === 'number' && item.tps > 0) && this.benchmarker && typeof this.benchmarker.maybeCalibrateThroughput === 'function') {
        this.benchmarker.maybeCalibrateThroughput(candidates.map((item) => item.modelSpec), { reason: 'no_tps' });
      }

      const chooser = NT.ModelChooser || null;
      const chosenResult = chooser && typeof chooser.choose === 'function'
        ? chooser.choose({
          prepared,
          selection: normalizedSelection,
          hintPrevModelSpec
        })
        : this._fallbackChoose(prepared, normalizedSelection, hintPrevModelSpec);
      const chosen = chosenResult && chosenResult.chosen ? chosenResult.chosen : null;
      const reason = chosenResult && chosenResult.reason ? chosenResult.reason : 'fallback';
      const scored = chosenResult && Array.isArray(chosenResult.scored) ? chosenResult.scored : [];

      if (chosen && this.rateLimitStore && typeof this.rateLimitStore.markChosen === 'function') {
        await this.rateLimitStore.markChosen(chosen.modelSpec, { now });
      }

      const decision = {
        chosenModelSpec: chosen ? chosen.modelSpec : null,
        chosenModelId: chosen ? chosen.id : null,
        serviceTier: chosen ? this.mapServiceTier(chosen.tier) : 'default',
        promptCachingSupported: Boolean(chosen && typeof chosen.cachedInputPrice === 'number' && Number.isFinite(chosen.cachedInputPrice)),
        policy,
        reason,
        candidates: prepared.slice(0, 12).map((item) => ({
          spec: item.modelSpec,
          ok: Boolean(item.availability && item.availability.ok),
          waitMs: item.availability ? item.availability.waitMs : 0,
          tps: typeof item.tps === 'number' ? Number(item.tps.toFixed(2)) : null,
          latMs: Number.isFinite(item.latencyMs) ? Math.round(item.latencyMs) : null,
          rank: item.capabilityRank,
          cost: item.cost
        }))
      };

      const bestScored = scored.length ? scored[0] : null;
      const prevScored = scored.find((entry) => entry.candidate.modelSpec === hintPrevModelSpec) || null;
      const keptPrev = Boolean(reason === 'hysteresis_keep_prev');

      this.logEvent('info', global.NT.EventTypes ? global.NT.EventTypes.Tags.AI_CHOOSE : 'ai.choose', 'model selected', {
        tabId,
        taskType,
        chosen: decision.chosenModelSpec,
        bestSpec: bestScored ? bestScored.candidate.modelSpec : decision.chosenModelSpec,
        keptPrev,
        bestScore: bestScored ? Number(bestScored.score.toFixed(3)) : null,
        prevScore: prevScored ? Number(prevScored.score.toFixed(3)) : null,
        reason: decision.reason,
        policy: decision.policy
      });

      return decision;
    }

    _fallbackChoose(prepared, normalizedSelection, hintPrevModelSpec) {
      const available = (prepared || []).filter((item) => item.availability && item.availability.ok);
      if (available.length) {
        const sorted = available
          .slice()
          .sort((a, b) => {
            const aLatency = Number.isFinite(a.latencyMs) ? a.latencyMs : Number.POSITIVE_INFINITY;
            const bLatency = Number.isFinite(b.latencyMs) ? b.latencyMs : Number.POSITIVE_INFINITY;
            if (aLatency !== bLatency) {
              return aLatency - bLatency;
            }
            return (a.modelSpec || '').localeCompare(b.modelSpec || '');
          });
        const chosen = sorted.find((item) => item.modelSpec === hintPrevModelSpec) || sorted[0];
        return {
          chosen,
          reason: chosen && chosen.modelSpec === hintPrevModelSpec ? 'hysteresis_keep_prev' : 'score_speed',
          scored: []
        };
      }
      const chosen = (prepared || []).reduce((best, item) => {
        if (!best) {
          return item;
        }
        const wait = item.availability ? item.availability.waitMs : Number.POSITIVE_INFINITY;
        const bestWait = best.availability ? best.availability.waitMs : Number.POSITIVE_INFINITY;
        return wait < bestWait ? item : best;
      }, null);
      return {
        chosen,
        reason: 'rate_limited_all',
        scored: []
      };
    }

    async request({ tabId, taskType, input, maxOutputTokens, temperature, store, background, selectedModelSpecs, modelSelection, signal, hintPrevModelSpec, hintBatchSize, requestMeta } = {}) {
      const estTokens = this.estimateTokens({ input, maxOutputTokens });
      const pressureTokens = this.estimatePressureTokens(estTokens, hintBatchSize);
      const requestId = this.buildRequestId({ tabId, taskType, requestMeta });
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
          estTokens,
          pressureTokens,
          hintPrevModelSpec
        });

        try {
          const response = await this.responseCall.send({
            modelSpec: decision.chosenModelSpec,
            modelId: decision.chosenModelId,
            serviceTier: decision.serviceTier,
            input,
            maxOutputTokens,
            temperature,
            store,
            background,
            signal,
            meta: {
              requestId,
              estTokens,
              timeoutMs: requestMeta && Number.isFinite(Number(requestMeta.timeoutMs)) ? Number(requestMeta.timeoutMs) : 90000,
              promptCacheKey: this.buildPromptCacheKey({
                tabId,
                taskType,
                requestMeta,
                modelSpec: decision.chosenModelSpec,
                promptCachingSupported: decision.promptCachingSupported === true
              })
            }
          });
          return { response, decision };
        } catch (error) {
          if (error && error.status === 429 && this.rateLimitStore && decision.chosenModelSpec) {
            const retryAfterMs = error.retryAfterMs || 30000;
            await this.rateLimitStore.applyCooldown(decision.chosenModelSpec, { now: Date.now(), retryAfterMs });
            this.logEvent('warn', global.NT.EventTypes ? global.NT.EventTypes.Tags.AI_COOLDOWN : 'ai.cooldown', 'cooldown applied', {
              modelSpec: decision.chosenModelSpec,
              retryAfterMs
            });
          }
          if (error && error.retryAfterMs && this.loadScheduler) {
            this.loadScheduler.onRateLimited({ retryAfterMs: error.retryAfterMs, kind: 'LLM_REQUEST' });
          }
          this.logEvent('warn', global.NT.EventTypes ? global.NT.EventTypes.Tags.AI_REQUEST : 'ai.request', error && error.message ? error.message : 'LLM attempt failed', {
            modelSpec: decision.chosenModelSpec,
            status: error && error.status ? error.status : null,
            retryAfterMs: error && error.retryAfterMs ? error.retryAfterMs : null,
            stage: 'attempt'
          });
          throw error;
        }
      };

      try {
        const attemptResult = this.retryLoop
          ? await this.retryLoop.run(executeAttempt)
          : await executeAttempt();
        this.logEvent('info', global.NT.EventTypes ? global.NT.EventTypes.Tags.AI_RESPONSE : 'ai.response', 'LLM ok', {
          latencyMs: Date.now() - startedAt,
          status: attemptResult.response.status
        });
        return {
          json: attemptResult.response.json,
          decision: attemptResult.decision
        };
      } catch (error) {
        this.logEvent('error', global.NT.EventTypes ? global.NT.EventTypes.Tags.AI_REQUEST : 'ai.request', error && error.message ? error.message : 'LLM failed', {
          status: error && error.status ? error.status : null,
          retryAfterMs: error && error.retryAfterMs ? error.retryAfterMs : null,
          stage: 'terminal'
        });
        throw error;
      }
    }

    getFreshPerfEntry(entry, nowTs) {
      if (!entry || typeof entry !== 'object') {
        return null;
      }
      if (typeof entry.updatedAt === 'number' && (nowTs - entry.updatedAt) > (12 * 60 * 60 * 1000)) {
        return null;
      }
      return entry;
    }

    limitRiskPenalty(snapshot, estTokens, pressureTokens) {
      if (!snapshot || typeof snapshot !== 'object') {
        return 0;
      }
      let penalty = 0;
      if (typeof snapshot.remainingRequests === 'number' && snapshot.remainingRequests < 3) {
        penalty += 2;
      }
      if (typeof snapshot.remainingTokens === 'number') {
        if (snapshot.remainingTokens < pressureTokens * 1.2) {
          penalty += 3.5;
        } else if (snapshot.remainingTokens < pressureTokens * 2.0) {
          penalty += 1.8;
        } else if (snapshot.remainingTokens < estTokens * 1.2) {
          penalty += 3;
        }
      }
      return penalty;
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
            cost: typeof entry.sum_1M === 'number' ? entry.sum_1M : Number.POSITIVE_INFINITY,
            cachedInputPrice: typeof entry.cachedInputPrice === 'number' && Number.isFinite(entry.cachedInputPrice)
              ? entry.cachedInputPrice
              : null
          };
        });
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
      const maxOutput = typeof maxOutputTokens === 'number' ? maxOutputTokens : 512;
      return Math.ceil(promptLength / 4) + maxOutput;
    }


    estimatePressureTokens(estTokens, hintBatchSize) {
      const batch = Number.isFinite(Number(hintBatchSize)) ? Number(hintBatchSize) : 1;
      const bounded = Math.max(1, Math.min(12, Math.round(batch)));
      return estTokens * bounded;
    }

    buildRequestId({ tabId, taskType, requestMeta } = {}) {
      const meta = requestMeta && typeof requestMeta === 'object' ? requestMeta : {};
      if (meta.requestId) {
        return String(meta.requestId);
      }
      const safeTask = taskType || 'unknown';
      const safeJob = meta.jobId || `tab${tabId === null || tabId === undefined ? 'na' : String(tabId)}`;
      const safeBlock = meta.blockId || meta.blockIndex || 'block0';
      const safeAttempt = Number.isFinite(Number(meta.attempt)) ? Number(meta.attempt) : 1;
      return `${safeJob}:${safeBlock}:${safeAttempt}:${safeTask}`;
    }

    buildPromptCacheKey({ tabId, taskType, requestMeta, modelSpec, promptCachingSupported } = {}) {
      if (promptCachingSupported !== true) {
        return null;
      }
      const safeTask = typeof taskType === 'string' ? taskType : '';
      if (!safeTask.startsWith('translation_')) {
        return null;
      }
      const meta = requestMeta && typeof requestMeta === 'object' ? requestMeta : {};
      const jobId = meta.jobId ? String(meta.jobId) : `tab${tabId === null || tabId === undefined ? 'na' : String(tabId)}`;
      const source = [
        `task=${safeTask}`,
        `job=${jobId}`,
        `model=${modelSpec || 'unknown'}`
      ].join('|');
      return `nt:pc:${this._hashText(source)}`;
    }

    _hashText(text) {
      const src = typeof text === 'string' ? text : String(text || '');
      let hash = 0;
      for (let i = 0; i < src.length; i += 1) {
        hash = ((hash << 5) - hash) + src.charCodeAt(i);
        hash |= 0;
      }
      return Math.abs(hash);
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.LlmEngine = LlmEngine;
})(globalThis);
