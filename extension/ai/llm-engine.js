/**
 * AI request engine focused on model selection and retry orchestration.
 *
 * `LlmEngine` is the narrow throat for request-time model choice. It combines
 * throughput EWMA from real requests, latency fallback benchmarks,
 * capability/cost preferences, real-time rate-limit state, cooldown windows,
 * and fairness penalties from recent usage.
 *
 * Request token estimates power both availability checks and transport budget
 * reservations, while `hintBatchSize` increases pressure-aware risk penalties
 * for backlog-heavy translation batches.
 *
 * The engine never writes tab/UI state directly. It returns `{json, decision}`
 * while background owns persistence of decisions and user-visible status.
 */
(function initLlmEngine(global) {
  class LlmEngine {
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
      this.responseCall = responseCall;
      this.modelRegistry = modelRegistry || { byKey: {} };
      this.benchmarkStore = benchmarkStore;
      this.benchmarker = benchmarker;
      this.rateLimitStore = rateLimitStore;
      this.perfStore = perfStore || null;
      this.loadScheduler = loadScheduler;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.eventFactory = eventFactory || null;
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

    async getModelSpec({ tabId, taskType, selectedModelSpecs, modelSelection, estTokens, pressureTokens, hintPrevModelSpec }) {
      const normalizedSelection = global.NT.ModelSelection.normalize(modelSelection, null);
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

      const available = prepared.filter((item) => item.availability && item.availability.ok);
      let chosen = null;
      let reason = 'fallback';

      let scored = [];
      if (available.length) {
        scored = available
          .map((item) => ({
            candidate: item,
            score: this.scoreCandidate(item, normalizedSelection)
          }))
          .sort((a, b) => this.compareScored(a, b));
        const bestScored = scored[0];
        const hysteresisWinner = this.pickByHysteresis({
          scored,
          bestScored,
          hintPrevModelSpec,
          selection: normalizedSelection
        });
        chosen = hysteresisWinner || bestScored.candidate;
        reason = hysteresisWinner ? 'hysteresis_keep_prev' : this.resolveReason(normalizedSelection);
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

      if (chosen && this.rateLimitStore && typeof this.rateLimitStore.markChosen === 'function') {
        await this.rateLimitStore.markChosen(chosen.modelSpec, { now });
      }

      const decision = {
        chosenModelSpec: chosen ? chosen.modelSpec : null,
        chosenModelId: chosen ? chosen.id : null,
        serviceTier: chosen ? this.mapServiceTier(chosen.tier) : 'default',
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
              timeoutMs: requestMeta && Number.isFinite(Number(requestMeta.timeoutMs)) ? Number(requestMeta.timeoutMs) : 90000
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

    resolveReason(selection) {
      if (selection.speed && selection.preference === 'smartest') {
        return 'score_speed_smartest';
      }
      if (selection.speed && selection.preference === 'cheapest') {
        return 'score_speed_cheapest';
      }
      if (selection.speed) {
        return 'score_speed';
      }
      if (selection.preference === 'smartest') {
        return 'score_smartest';
      }
      if (selection.preference === 'cheapest') {
        return 'score_cheapest';
      }
      return 'score_speed';
    }

    scoreCandidate(candidate, selection) {
      let score = 0;
      const latencyMs = this.clamp(Number.isFinite(candidate.latencyMs) ? candidate.latencyMs : 50000, 80, 50000);
      const cost = Number.isFinite(candidate.cost) ? candidate.cost : 1e9;

      if (selection.speed) {
        if (typeof candidate.tps === 'number' && Number.isFinite(candidate.tps) && candidate.tps > 0) {
          score += Math.log(1 + candidate.tps) * 12;
        } else {
          score += (-Math.log(1 + latencyMs / 200)) * 9;
        }
        score -= Math.log(1 + latencyMs / 300) * 2.2;
      }

      if (selection.preference === 'smartest') {
        score += (candidate.capabilityRank || 0) / 10;
      }

      if (selection.preference === 'cheapest') {
        score += (-Math.log(1 + cost)) * 4;
      }

      score -= (candidate.limitRiskPenalty || 0);
      score -= (candidate.usagePenalty || 0) * 6;
      return score;
    }

    pickByHysteresis({ scored, bestScored, hintPrevModelSpec, selection }) {
      if (!selection || !selection.speed || !hintPrevModelSpec || !Array.isArray(scored) || !scored.length || !bestScored) {
        return null;
      }
      const prevScored = scored.find((entry) => entry.candidate.modelSpec === hintPrevModelSpec);
      if (!prevScored) {
        return null;
      }

      const prev = prevScored.candidate;
      const best = bestScored.candidate;
      const margin = Math.max(Math.abs(bestScored.score) * 0.08, 0.25);
      const nearBest = prevScored.score >= (bestScored.score - margin);
      const riskClose = (prev.limitRiskPenalty || 0) <= (best.limitRiskPenalty || 0) + 1.5;
      const tpsConsistency = !(typeof best.tps === 'number' && best.tps > 0) || (typeof prev.tps === 'number' && prev.tps > 0);
      return nearBest && riskClose && tpsConsistency ? prev : null;
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

    clamp(value, min, max) {
      if (!Number.isFinite(value)) {
        return max;
      }
      return Math.max(min, Math.min(max, value));
    }

    compareScored(a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const aLatency = Number.isFinite(a.candidate.latencyMs) ? a.candidate.latencyMs : Number.POSITIVE_INFINITY;
      const bLatency = Number.isFinite(b.candidate.latencyMs) ? b.candidate.latencyMs : Number.POSITIVE_INFINITY;
      if (aLatency !== bLatency) {
        return aLatency - bLatency;
      }
      if ((b.candidate.capabilityRank || 0) !== (a.candidate.capabilityRank || 0)) {
        return (b.candidate.capabilityRank || 0) - (a.candidate.capabilityRank || 0);
      }
      if (a.candidate.cost !== b.candidate.cost) {
        return a.candidate.cost - b.candidate.cost;
      }
      return a.candidate.modelSpec.localeCompare(b.candidate.modelSpec);
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
            cost: typeof entry.sum_1M === 'number' ? entry.sum_1M : Number.POSITIVE_INFINITY
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

    logEvent(level, tag, message, meta) {
      if (!this.eventLogger) {
        return;
      }
      if (this.eventFactory) {
        const event = level === 'error'
          ? this.eventFactory.error(tag, message, meta)
          : level === 'warn'
            ? this.eventFactory.warn(tag, message, meta)
            : this.eventFactory.info(tag, message, meta);
        this.eventLogger(event);
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
