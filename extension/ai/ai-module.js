/**
 * Main AI facade consumed by background orchestration.
 *
 * Public API remains intentionally narrow: `request`, `benchmarkSelected`, and
 * `getRegistry`. Internal services (stores/client/calls/engine/benchmarker) are
 * composed here and hidden from external modules.
 *
 * This module also builds AI-scoped event factory instances so emitted events
 * share taxonomy/shape across request and benchmark flows.
 *
 * Model performance snapshots are encapsulated behind `ModelPerformanceStore`
 * and injected into the engine/benchmarker. The store remains internal to keep
 * `AiModule` as a narrow facade and avoid leaking persistence internals.
 *
 * Batch hints (`hintBatchSize`) and offscreen transport wiring are also threaded
 * here so downstream selection can account for backlog pressure without widening
 * public contracts in unrelated modules.
 */
(function initAiModule(global) {
  const NT = global.NT || (global.NT = {});

  class AiModule {
    constructor({ chromeApi, fetchFn, loadScheduler, eventLogger, benchmarkStore, rateLimitStore, perfStore, offscreenExecutor } = {}) {
      this.chromeApi = chromeApi;
      this.fetchFn = fetchFn;
      this.loadScheduler = loadScheduler;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.injectedBenchmarkStore = benchmarkStore || null;
      this.injectedRateLimitStore = rateLimitStore || null;
      this.injectedPerfStore = perfStore || null;
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
        offscreenExecutor: this.offscreenExecutor
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
      return this.modelRegistry;
    }

    benchmarkSelected(modelSpecs, { force } = {}) {
      return this.benchmarker.benchmarkSelected(modelSpecs, { force });
    }

    request({ tabId, taskType, selectedModelSpecs, modelSelection, input, maxOutputTokens, temperature, store, background, signal, hintPrevModelSpec, hintBatchSize, requestMeta } = {}) {
      return this.llmEngine.request({
        tabId,
        taskType,
        selectedModelSpecs,
        modelSelection,
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
  }

  NT.AiModule = AiModule;
})(globalThis);
