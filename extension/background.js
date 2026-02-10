importScripts(
  'core/nt-namespace.js',
  'core/time.js',
  'core/rate-limiter.js',
  'core/retry-loop.js',
  'core/message-envelope.js',
  'core/ui-protocol.js',
  'core/ui-port-hub.js',
  'core/llm-client.js',
  'ai-common.js',
  'background/event-log-store.js',
  'background/load-scheduler.js',
  'background/model-benchmark-store.js',
  'background/model-benchmarker.js',
  'background/model-chooser.js',
  'background/model-rate-limit-store.js',
  'background/llm-engine.js'
);

(async function initBackground(global) {
  const AiCommon = global.NT && global.NT.AiCommon ? global.NT.AiCommon : null;
  const modelRegistry = AiCommon && typeof AiCommon.createModelRegistry === 'function'
    ? AiCommon.createModelRegistry()
    : { entries: [], byKey: {} };
  const benchmarkStore = new global.NT.ModelBenchmarkStore({ chromeApi: global.chrome });
  const llmClient = new global.NT.LlmClient({ chromeApi: global.chrome, fetchFn: global.fetch });
  const eventLogStore = new global.NT.EventLogStore({ chromeApi: global.chrome, limit: 600 });
  const rateLimitStore = new global.NT.ModelRateLimitStore({ chromeApi: global.chrome });
  await eventLogStore.load();
  const logEvent = (event) => {
    eventLogStore.append(event).catch(() => {});
  };
  const rateLimiter = new global.NT.RateLimiter({ rpm: 60, tpm: 60000 });
  const loadScheduler = new global.NT.LoadScheduler({ rateLimiter, eventLogger: logEvent });
  const benchmarker = new global.NT.ModelBenchmarker({
    chromeApi: global.chrome,
    llmClient,
    benchmarkStore,
    modelRegistry,
    loadScheduler,
    eventLogger: logEvent
  });
  const llmEngine = new global.NT.LlmEngine({
    chromeApi: global.chrome,
    llmClient,
    modelRegistry,
    benchmarkStore,
    benchmarker,
    rateLimitStore,
    loadScheduler,
    eventLogger: logEvent
  });
  const hub = new global.NT.UiPortHub({
    onCommand: ({ envelope }) => handleUiCommand(envelope),
    onEvent: (event) => logEvent(event)
  });
  await preloadState();
  hub.attachToRuntime();
  global.NT.runLlmRequest = runLlmRequest;
  const services = global.NT.Services || (global.NT.Services = {});
  services.benchmarkStore = benchmarkStore;
  services.benchmarker = benchmarker;
  services.llmEngine = llmEngine;
  services.llmClient = llmClient;
  services.eventLogStore = eventLogStore;
  services.rateLimiter = rateLimiter;
  services.rateLimitStore = rateLimitStore;
  services.loadScheduler = loadScheduler;
  services.logEvent = logEvent;

  if (global.chrome && global.chrome.runtime && global.chrome.runtime.onMessage) {
    global.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      return handleRuntimeMessage(message, sender, sendResponse);
    });
  }

  if (global.chrome && global.chrome.storage && global.chrome.storage.onChanged) {
    global.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const watchedKeys = [
        'apiKey',
        'translationModelList',
        'modelSelection',
        'translationStatusByTab',
        'translationVisibilityByTab',
        'modelBenchmarkStatus',
        'modelBenchmarks',
        'eventLog'
      ];
      const changedKeys = Object.keys(changes).filter((key) => watchedKeys.includes(key));

      if (!changedKeys.length) {
        return;
      }

      const patch = {};
      changedKeys.forEach((key) => {
        patch[key] = changes[key].newValue;
      });

      hub.broadcastPatch({ changedKeys, patch });

      if (changes.translationStatusByTab) {
        logEvent({
          level: 'info',
          tag: 'job',
          message: 'Translation status updated',
          meta: { source: 'background' }
        });
      }
    });
  }

  function handleUiCommand(envelope) {
    if (!envelope || !envelope.payload) {
      return;
    }

    const payload = envelope.payload || {};
    if (payload.name === 'LOG_EVENT') {
      const event = payload.payload && typeof payload.payload === 'object' ? payload.payload : null;
      if (event) {
        logEvent({
          ...event,
          meta: { ...(event.meta || {}), source: event.meta && event.meta.source ? event.meta.source : 'ui' }
        });
      }
      return;
    }
    if (payload.name === 'CLEAR_EVENT_LOG') {
      eventLogStore.clear().catch(() => {});
      logEvent({ level: 'warn', tag: 'ui', message: 'Event log cleared', meta: { source: 'ui' } });
      return;
    }
    if (payload.name !== 'BENCHMARK_SELECTED_MODELS') {
      return;
    }

    logEvent({ level: 'info', tag: 'bench', message: 'Benchmark request received', meta: { source: 'ui' } });
    loadSelectedModels()
      .then((modelSpecs) => benchmarker.benchmarkSelected(modelSpecs, { force: Boolean(payload.payload && payload.payload.force) }))
      .catch(() => benchmarkStore.setStatus({ status: 'failed', errorCode: 'BENCHMARK_START_FAILED', updatedAt: Date.now() }));
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
    const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;

    if (!MessageEnvelope || !UiProtocol || !MessageEnvelope.isEnvelope(message)) {
      return false;
    }

    if (message.type === UiProtocol.UI_COMMAND) {
      handleUiCommand(message);
      if (message.payload && (message.payload.name === 'LOG_EVENT' || message.payload.name === 'CLEAR_EVENT_LOG')) {
        respondWithTimeout(sendResponse, { ok: true });
        return true;
      }
    }
    return false;
  }

  function loadSelectedModels() {
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
      return Promise.resolve([]);
    }

    return new Promise((resolve) => {
      global.chrome.storage.local.get({ translationModelList: [] }, (result) => {
        const list = Array.isArray(result.translationModelList) ? result.translationModelList : [];
        resolve(list);
      });
    });
  }

  async function runLlmRequest({ tabId, taskType, request }) {
    const settings = await readLlmSettings();
    const safeRequest = request && typeof request === 'object' ? request : {};
    return llmEngine.request({
      tabId,
      taskType,
      selectedModelSpecs: settings.translationModelList,
      modelSelection: settings.modelSelection,
      input: safeRequest.input,
      maxOutputTokens: safeRequest.maxOutputTokens,
      temperature: safeRequest.temperature,
      store: safeRequest.store,
      background: safeRequest.background,
      signal: safeRequest.signal
    });
  }

  async function readLlmSettings() {
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
      return {
        translationModelList: [],
        modelSelection: defaultModelSelection()
      };
    }

    const data = await new Promise((resolve) => {
      global.chrome.storage.local.get(
        {
          translationModelList: [],
          modelSelection: null,
          modelSelectionPolicy: null
        },
        (result) => resolve(result || {})
      );
    });

    const modelSelection = normalizeModelSelection(data.modelSelection, data.modelSelectionPolicy);
    if (!data.modelSelection) {
      await new Promise((resolve) => {
        global.chrome.storage.local.set({ modelSelection }, () => resolve());
      });
    }

    return {
      translationModelList: Array.isArray(data.translationModelList) ? data.translationModelList : [],
      modelSelection
    };
  }

  function normalizeModelSelection(modelSelection, legacyPolicy) {
    if (modelSelection && typeof modelSelection === 'object') {
      const speed = modelSelection.speed !== false;
      const preference = modelSelection.preference === 'smartest' || modelSelection.preference === 'cheapest'
        ? modelSelection.preference
        : null;
      return { speed, preference };
    }

    if (legacyPolicy === 'smartest') {
      return { speed: false, preference: 'smartest' };
    }
    if (legacyPolicy === 'cheapest') {
      return { speed: false, preference: 'cheapest' };
    }
    return defaultModelSelection();
  }

  function defaultModelSelection() {
    return { speed: true, preference: null };
  }

  async function preloadState() {
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
      return;
    }

    const state = await new Promise((resolve) => {
      global.chrome.storage.local.get(
        {
          modelBenchmarkStatus: null,
          modelSelection: null,
          modelSelectionPolicy: null
        },
        (result) => resolve(result || {})
      );
    });

    const status = state.modelBenchmarkStatus || null;
    const now = Date.now();
    if (status && status.status === 'running' && typeof status.leaseUntilTs === 'number' && status.leaseUntilTs < now) {
      await benchmarkStore.setStatus({
        status: 'failed',
        reason: 'LEASE_EXPIRED',
        total: status.total || 0,
        completed: status.completed || 0,
        updatedAt: now,
        finishedAt: now,
        currentModelSpec: status.currentModelSpec || null,
        leaseUntilTs: null
      });
      logEvent({
        level: 'warn',
        tag: 'job',
        message: 'Benchmark lease expired',
        meta: { source: 'background', stage: 'lease' }
      });
    }

    if (!state.modelSelection) {
      const modelSelection = normalizeModelSelection(state.modelSelection, state.modelSelectionPolicy);
      await new Promise((resolve) => {
        global.chrome.storage.local.set({ modelSelection }, () => resolve());
      });
    }
  }

  function respondWithTimeout(sendResponse, payload, timeoutMs = 2000) {
    if (typeof sendResponse !== 'function') {
      return;
    }
    let settled = false;
    const timer = global.setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        sendResponse({ ok: false, timeout: true });
      } catch (error) {
        // ignore response timeout errors
      }
    }, timeoutMs);

    try {
      sendResponse(payload);
    } finally {
      settled = true;
      global.clearTimeout(timer);
    }
  }
})(globalThis);
