/**
 * Main AI module facade consumed by background orchestration.
 *
 * Role:
 * - Serve as the AI narrow throat: background and UI bridge code call this
 *   class instead of touching AI stores and transport internals directly.
 *
 * Public contract:
 * - Runtime actions: `request`, `benchmarkSelected`.
 * - Policy normalization: `normalizeSelection`.
 * - Read models: `getRegistry`.
 * - Read diagnostics: `getBenchmarkSnapshot`, `getModelLimitsSnapshot`.
 * - Best-effort maintenance: `adoptRateLimitHeaders`, `releaseReservation`.
 *
 * Dependencies:
 * - Composes AI internals (`ModelBenchmarkStore`, `ModelRateLimitStore`,
 *   `ModelPerformanceStore`, `LlmClient`, `AiPingCall`, `AiResponseCall`,
 *   `ModelBenchmarker`, `LlmEngine`) and optional `OffscreenExecutor`.
 *
 * Side effects:
 * - Reads/writes benchmark and rate-limit persistence via owned stores.
 * - Emits AI events through injected logger and AI-scoped `EventFactory`.
 */
(function initAiModule(global) {
  const NT = global.NT || (global.NT = {});

  class AiModule {
    constructor({ chromeApi, fetchFn, loadScheduler, eventLogger, benchmarkStore, rateLimitStore, perfStore, offscreenExecutor, credentialsProvider } = {}) {
      this.chromeApi = chromeApi;
      this.fetchFn = fetchFn;
      this.loadScheduler = loadScheduler;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.injectedBenchmarkStore = benchmarkStore || null;
      this.injectedRateLimitStore = rateLimitStore || null;
      this.injectedPerfStore = perfStore || null;
      this.offscreenExecutor = offscreenExecutor || null;
      this.credentialsProvider = credentialsProvider || null;

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
      const AiCommon = NT.AiCommon;
      this.modelRegistry = AiCommon && typeof AiCommon.createModelRegistry === 'function'
        ? AiCommon.createModelRegistry()
        : { entries: [], byKey: {} };

      this.benchmarkStore = this.injectedBenchmarkStore || new NT.ModelBenchmarkStore({ chromeApi: this.chromeApi });
      this.rateLimitStore = this.injectedRateLimitStore || new NT.ModelRateLimitStore({ chromeApi: this.chromeApi });
      this.perfStore = this.injectedPerfStore || new NT.ModelPerformanceStore({ chromeApi: this.chromeApi });
      this.llmClient = new NT.LlmClient({
        chromeApi: this.chromeApi,
        fetchFn: this.fetchFn,
        time: NT.Time,
        offscreenExecutor: this.offscreenExecutor,
        credentialsProvider: this.credentialsProvider
      });
      this.eventFactory = new NT.EventFactory({ time: NT.Time, source: 'ai' });

      this.pingCall = new NT.AiPingCall({
        llmClient: this.llmClient,
        rateLimitStore: this.rateLimitStore,
        perfStore: this.perfStore,
        eventFactory: this.eventFactory,
        eventLogger: this.eventLogger,
        time: NT.Time
      });

      this.responseCall = new NT.AiResponseCall({
        llmClient: this.llmClient,
        rateLimitStore: this.rateLimitStore,
        perfStore: this.perfStore,
        eventFactory: this.eventFactory,
        eventLogger: this.eventLogger,
        time: NT.Time
      });

      this.benchmarker = new NT.ModelBenchmarker({
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

      this.llmEngine = new NT.LlmEngine({
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
      return this.modelRegistry || { entries: [], byKey: {} };
    }

    normalizeSelection(modelSelection, legacyPolicy) {
      const Policy = NT.AiModelSelection || NT.ModelSelection || null;
      if (Policy && typeof Policy.normalize === 'function') {
        return Policy.normalize(modelSelection, legacyPolicy);
      }
      return { speed: true, preference: null };
    }

    async getBenchmarkSnapshot() {
      if (!this.benchmarkStore) {
        return { modelBenchmarkStatus: null, modelBenchmarks: {} };
      }
      if (typeof this.benchmarkStore.getSnapshot === 'function') {
        return this.benchmarkStore.getSnapshot();
      }
      const modelBenchmarks = typeof this.benchmarkStore.getAllEntries === 'function'
        ? await this.benchmarkStore.getAllEntries()
        : {};
      const modelBenchmarkStatus = typeof this.benchmarkStore.getStatus === 'function'
        ? await this.benchmarkStore.getStatus()
        : null;
      return { modelBenchmarkStatus, modelBenchmarks };
    }

    async getModelLimitsSnapshot({ selectedModelSpecs = [], limit = 20, now } = {}) {
      if (!this.rateLimitStore || typeof this.rateLimitStore.getAll !== 'function') {
        return {};
      }
      const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(50, Math.floor(Number(limit)))) : 20;
      const nowTs = typeof now === 'number' ? now : Date.now();
      const all = await this.rateLimitStore.getAll();
      const fromSelected = Array.isArray(selectedModelSpecs)
        ? selectedModelSpecs.filter((spec) => typeof spec === 'string' && spec)
        : [];
      const keys = fromSelected.length
        ? fromSelected.slice(0, safeLimit)
        : Object.keys(all).slice(0, safeLimit);

      const out = {};
      keys.forEach((modelSpec) => {
        const snapshot = all[modelSpec];
        if (!snapshot || typeof snapshot !== 'object') {
          return;
        }

        const reservations = Array.isArray(snapshot.reservations)
          ? snapshot.reservations.filter((item) => item && item.id && typeof item.leaseUntilTs === 'number' && item.leaseUntilTs > nowTs)
          : [];
        const reserved = reservations.reduce((acc, item) => {
          const requests = Number.isFinite(Number(item.requests)) ? Math.max(0, Number(item.requests)) : 0;
          const tokens = Number.isFinite(Number(item.tokens)) ? Math.max(0, Number(item.tokens)) : 0;
          return {
            requests: acc.requests + requests,
            tokens: acc.tokens + tokens
          };
        }, { requests: 0, tokens: 0 });

        out[modelSpec] = {
          cooldownUntilTs: typeof snapshot.cooldownUntilTs === 'number' ? snapshot.cooldownUntilTs : null,
          remainingRequests: snapshot.remainingRequests === undefined ? null : snapshot.remainingRequests,
          remainingTokens: snapshot.remainingTokens === undefined ? null : snapshot.remainingTokens,
          limitRequests: snapshot.limitRequests === undefined ? null : snapshot.limitRequests,
          limitTokens: snapshot.limitTokens === undefined ? null : snapshot.limitTokens,
          resetRequestsAt: snapshot.resetRequestsAt || null,
          resetTokensAt: snapshot.resetTokensAt || null,
          reservedRequests: reserved.requests,
          reservedTokens: reserved.tokens
        };
      });

      return out;
    }

    async adoptRateLimitHeaders(modelSpec, headers, { receivedAt } = {}) {
      if (!this.rateLimitStore || !modelSpec || !headers || typeof headers.get !== 'function') {
        return;
      }
      try {
        await this.rateLimitStore.upsertFromHeaders(modelSpec, headers, { receivedAt });
      } catch (_) {
        // best-effort adoption
      }
    }

    async releaseReservation(modelSpec, requestId) {
      if (!this.rateLimitStore || !modelSpec || !requestId) {
        return;
      }
      try {
        await this.rateLimitStore.release(modelSpec, requestId);
      } catch (_) {
        // best-effort cleanup
      }
    }

    benchmarkSelected(modelSpecs, { force } = {}) {
      return this.benchmarker.benchmarkSelected(modelSpecs, { force });
    }

    request({ tabId, taskType, selectedModelSpecs, modelSelection, input, maxOutputTokens, temperature, store, background, signal, hintPrevModelSpec, hintBatchSize, requestMeta, responsesOptions, stream = false, onEvent = null } = {}) {
      return this.llmEngine.request({
        tabId,
        taskType,
        selectedModelSpecs,
        modelSelection: this.normalizeSelection(modelSelection, null),
        input,
        maxOutputTokens,
        temperature,
        store,
        background,
        signal,
        hintPrevModelSpec,
        hintBatchSize: Number.isFinite(Number(hintBatchSize)) ? Number(hintBatchSize) : 1,
        requestMeta,
        responsesOptions,
        stream,
        onEvent
      });
    }
  }

  NT.AiModule = AiModule;
})(globalThis);
