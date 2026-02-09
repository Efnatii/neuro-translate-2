importScripts(
  'core/nt-namespace.js',
  'core/message-envelope.js',
  'core/ui-protocol.js',
  'core/ui-port-hub.js',
  'core/llm-client.js',
  'ai-common.js',
  'background/model-benchmark-store.js',
  'background/model-benchmarker.js',
  'background/model-chooser.js'
);

(function initBackground(global) {
  const AiCommon = global.NT && global.NT.AiCommon ? global.NT.AiCommon : null;
  const modelRegistry = AiCommon && typeof AiCommon.createModelRegistry === 'function'
    ? AiCommon.createModelRegistry()
    : { entries: [], byKey: {} };
  const benchmarkStore = new global.NT.ModelBenchmarkStore({ chromeApi: global.chrome });
  const llmClient = new global.NT.LlmClient({ chromeApi: global.chrome, fetchFn: global.fetch });
  const benchmarker = new global.NT.ModelBenchmarker({
    chromeApi: global.chrome,
    llmClient,
    benchmarkStore,
    modelRegistry
  });
  const modelChooser = new global.NT.ModelChooser({
    chromeApi: global.chrome,
    modelRegistry,
    benchmarkStore,
    benchmarker
  });
  const hub = new global.NT.UiPortHub({
    onCommand: ({ envelope }) => handleUiCommand(envelope)
  });
  hub.attachToRuntime();
  global.NT.runLlmRequest = runLlmRequest;

  if (global.chrome && global.chrome.runtime && global.chrome.runtime.onMessage) {
    global.chrome.runtime.onMessage.addListener((message) => handleRuntimeMessage(message));
  }

  if (global.chrome && global.chrome.storage && global.chrome.storage.onChanged) {
    global.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const watchedKeys = [
        'apiKey',
        'translationModelList',
        'modelSelectionPolicy',
        'translationStatusByTab',
        'translationVisibilityByTab',
        'modelBenchmarkStatus',
        'modelBenchmarks'
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
    });
  }

  function handleUiCommand(envelope) {
    if (!envelope || !envelope.payload) {
      return;
    }

    const payload = envelope.payload || {};
    if (payload.name !== 'BENCHMARK_SELECTED_MODELS') {
      return;
    }

    loadSelectedModels()
      .then((modelSpecs) => benchmarker.benchmarkSelected(modelSpecs, { force: Boolean(payload.payload && payload.payload.force) }))
      .catch(() => benchmarkStore.setStatus({ status: 'failed', errorCode: 'BENCHMARK_START_FAILED', updatedAt: Date.now() }));
  }

  function handleRuntimeMessage(message) {
    const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
    const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;

    if (!MessageEnvelope || !UiProtocol || !MessageEnvelope.isEnvelope(message)) {
      return;
    }

    if (message.type === UiProtocol.UI_COMMAND) {
      handleUiCommand(message);
    }
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

  async function runLlmRequest({ tabId, taskType, policy, modelSpecs, request }) {
    const decision = await modelChooser.choose({ tabId, taskType, policy, modelSpecs });
    if (!decision.chosenModelId) {
      const error = new Error('No model selected');
      error.code = 'NO_MODEL_SELECTED';
      throw error;
    }

    const safeRequest = request && typeof request === 'object' ? request : {};
    return llmClient.generateResponse({
      ...safeRequest,
      modelId: decision.chosenModelId,
      serviceTier: decision.serviceTier
    });
  }
})(globalThis);
