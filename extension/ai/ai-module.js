/**
 * Public AI facade used by `BackgroundApp` in MV3 service worker runtime.
 *
 * The module owns all AI internals: model registry, benchmark store,
 * rate-limit store, performance store, transport client, call wrappers,
 * benchmark runner, and LLM engine.
 *
 * Contracts:
 * - background accesses AI only via narrow methods on this class;
 * - no AI store instances are exposed to external modules;
 * - UI snapshot payload for model options/bench/limits is produced here.
 *
 * This file does not handle runtime ports, tab status persistence, or UI DOM.
 */
(function initAiModule(global) {
  const NT = global.NT || (global.NT = {});
  const AI = NT.Internal.ai;

  class AiModule {
    constructor({ chromeApi, fetchFn, loadScheduler, eventLogger, offscreenExecutor } = {}) {
      this.chromeApi = chromeApi;
      this.fetchFn = fetchFn;
      this.loadScheduler = loadScheduler;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.offscreenExecutor = offscreenExecutor || null;

      this.modelRegistry = null;
      this.benchmarkStore = null;
      this.rateLimitStore = null;
      this.perfStore = null;
      this.llmClient = null;
      this.eventFactory = null;
      this.pingCall = null;
      this.responseCall = null;
      this.benchmarker = null;
      this.llmEngine = null;
    }

    init() {
      const AiCommon = AI.AiCommon || null;
      this.modelRegistry = AiCommon && typeof AiCommon.createModelRegistry === 'function'
        ? AiCommon.createModelRegistry()
        : { entries: [], byKey: {} };

      this.benchmarkStore = new AI.ModelBenchmarkStore({ chromeApi: this.chromeApi });
      this.rateLimitStore = new AI.ModelRateLimitStore({ chromeApi: this.chromeApi });
      this.perfStore = new AI.ModelPerformanceStore({ chromeApi: this.chromeApi });

      this.llmClient = new AI.LlmClient({
        chromeApi: this.chromeApi,
        fetchFn: this.fetchFn,
        time: NT.Time,
        offscreenExecutor: this.offscreenExecutor
      });
      this.eventFactory = new NT.EventFactory({ time: NT.Time, source: 'ai' });

      this.pingCall = new AI.AiPingCall({
        llmClient: this.llmClient,
        rateLimitStore: this.rateLimitStore,
        perfStore: this.perfStore,
        eventFactory: this.eventFactory,
        eventLogger: this.eventLogger,
        time: NT.Time
      });

      this.responseCall = new AI.AiResponseCall({
        llmClient: this.llmClient,
        rateLimitStore: this.rateLimitStore,
        perfStore: this.perfStore,
        eventFactory: this.eventFactory,
        eventLogger: this.eventLogger,
        time: NT.Time
      });

      this.benchmarker = new AI.ModelBenchmarker({
        chromeApi: this.chromeApi,
        pingCall: this.pingCall,
        benchmarkStore: this.benchmarkStore,
        modelRegistry: this.modelRegistry,
        loadScheduler: this.loadScheduler,
        rateLimitStore: this.rateLimitStore,
        responseCall: this.responseCall,
        perfStore: this.perfStore,
        eventLogger: this.eventLogger,
        eventFactory: this.eventFactory
      });

      this.llmEngine = new AI.LlmEngine({
        responseCall: this.responseCall,
        modelRegistry: this.modelRegistry,
        benchmarkStore: this.benchmarkStore,
        benchmarker: this.benchmarker,
        rateLimitStore: this.rateLimitStore,
        perfStore: this.perfStore,
        loadScheduler: this.loadScheduler,
        eventLogger: this.eventLogger,
        eventFactory: this.eventFactory
      });

      return this;
    }

    getRegistry() {
      return this.modelRegistry;
    }

    benchmarkSelected(modelSpecs, { force } = {}) {
      return this.benchmarker.benchmarkSelected(modelSpecs, { force });
    }

    request({ tabId, taskType, selectedModelSpecs, modelSelection, input, maxOutputTokens, temperature, store, background, signal, hintPrevModelSpec, hintBatchSize, requestMeta } = {}) {
      const normalizedSelection = AI.AiModelSelection
        ? AI.AiModelSelection.normalize(modelSelection, null)
        : { speed: true, preference: null };
      return this.llmEngine.request({
        tabId,
        taskType,
        selectedModelSpecs,
        modelSelection: normalizedSelection,
        input,
        maxOutputTokens,
        temperature,
        store,
        background,
        signal,
        hintPrevModelSpec,
        hintBatchSize: Number.isFinite(Number(hintBatchSize)) ? Number(hintBatchSize) : 1,
        requestMeta
      });
    }

    async getUiSnapshot({ selectedModelSpecs, maxModels } = {}) {
      const AiCommon = AI.AiCommon || null;
      const modelOptions = AiCommon && typeof AiCommon.buildModelOptions === 'function'
        ? AiCommon.buildModelOptions(this.modelRegistry || { entries: [] })
        : [];
      const modelBenchmarkStatus = this.benchmarkStore ? await this.benchmarkStore.getStatus() : null;
      const modelBenchmarks = this.benchmarkStore ? await this.benchmarkStore.getAllEntries() : {};
      const modelLimitsBySpec = await this.buildModelLimitsSnapshot({ selectedModelSpecs, maxModels });
      return {
        modelOptions,
        modelBenchmarkStatus,
        modelBenchmarks,
        modelLimitsBySpec
      };
    }

    async buildModelLimitsSnapshot({ selectedModelSpecs, maxModels } = {}) {
      if (!this.rateLimitStore) {
        return {};
      }
      const all = await this.rateLimitStore.getAll();
      const now = Date.now();
      const limit = Number.isFinite(Number(maxModels)) ? Math.max(1, Math.floor(Number(maxModels))) : 20;
      const preferred = Array.isArray(selectedModelSpecs) ? selectedModelSpecs.slice(0, limit) : [];
      const keys = preferred.length ? preferred : Object.keys(all).slice(0, limit);
      const out = {};
      keys.forEach((modelSpec) => {
        const snapshot = all[modelSpec] || null;
        if (!snapshot) {
          return;
        }
        const reserved = this.rateLimitStore.summarizeReservations(snapshot, now);
        out[modelSpec] = {
          cooldownUntilTs: snapshot.cooldownUntilTs || null,
          remainingRequests: snapshot.remainingRequests === undefined ? null : snapshot.remainingRequests,
          remainingTokens: snapshot.remainingTokens === undefined ? null : snapshot.remainingTokens,
          limitRequests: snapshot.limitRequests === undefined ? null : snapshot.limitRequests,
          limitTokens: snapshot.limitTokens === undefined ? null : snapshot.limitTokens,
          resetRequestsAt: snapshot.resetRequestsAt || null,
          resetTokensAt: snapshot.resetTokensAt || null,
          reservedRequests: reserved.requests || 0,
          reservedTokens: reserved.tokens || 0
        };
      });
      return out;
    }

    async adoptRateLimitHeaders(modelSpec, rawHeadersObj, { receivedAt } = {}) {
      if (!this.rateLimitStore || !modelSpec || !rawHeadersObj) {
        return;
      }
      try {
        const headers = this._toHeaderAccessor(rawHeadersObj);
        await this.rateLimitStore.upsertFromHeaders(modelSpec, headers, {
          receivedAt: Number.isFinite(Number(receivedAt)) ? Number(receivedAt) : Date.now()
        });
      } catch (_) {
        // best effort only
      }
    }

    async releaseReservation(modelSpec, requestId) {
      if (!this.rateLimitStore || !modelSpec || !requestId) {
        return;
      }
      try {
        await this.rateLimitStore.release(modelSpec, requestId);
      } catch (_) {
        // best effort only
      }
    }

    async sweepBenchmarkLeaseIfExpired() {
      if (!this.benchmarkStore) {
        return;
      }
      const status = await this.benchmarkStore.getStatus();
      const now = Date.now();
      if (status && status.status === 'running' && typeof status.leaseUntilTs === 'number' && status.leaseUntilTs < now) {
        await this.benchmarkStore.setStatus({
          status: 'failed',
          reason: 'LEASE_EXPIRED',
          total: status.total || 0,
          completed: status.completed || 0,
          updatedAt: now,
          finishedAt: now,
          currentModelSpec: status.currentModelSpec || null,
          leaseUntilTs: null
        });
      }
    }

    async setBenchmarkFailed(errorCode) {
      if (!this.benchmarkStore) {
        return;
      }
      await this.benchmarkStore.setStatus({
        status: 'failed',
        errorCode: errorCode || 'BENCHMARK_FAILED',
        updatedAt: Date.now()
      });
    }

    _toHeaderAccessor(rawHeaders) {
      if (rawHeaders && typeof rawHeaders.get === 'function') {
        return rawHeaders;
      }
      const source = rawHeaders && typeof rawHeaders === 'object' ? rawHeaders : {};
      const map = {};
      Object.keys(source).forEach((key) => {
        map[String(key).toLowerCase()] = source[key];
      });
      return {
        get(name) {
          if (!name) {
            return null;
          }
          const value = map[String(name).toLowerCase()];
          return value === undefined || value === null ? null : String(value);
        }
      };
    }
  }

  NT.AiModule = AiModule;
})(globalThis);
