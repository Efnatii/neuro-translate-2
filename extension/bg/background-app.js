/**
 * Main background-module facade for MV3 service-worker orchestration.
 *
 * Role:
 * - Be the only background-side integration point for runtime messages, UI
 *   ports, storage change notifications, and request lifecycle control.
 *
 * Public contract:
 * - `start()` wires all services and listeners.
 * - Runtime/UI flows keep message protocol stable (`UiProtocol` envelopes).
 *
 * Dependencies:
 * - Local stores (`EventLogStore`, `SettingsStore`, `TabStateStore`,
 *   `InflightRequestStore`), background scheduler (`AiLoadScheduler`), UI hub
 *   (`UiPortHub`), AI facade (`AiModule`), and
 *   offscreen transport executor (`OffscreenExecutor`).
 *
 * Side effects:
 * - Reads/writes extension state in `chrome.storage.local`.
 * - Attaches runtime/storage listeners and periodic in-flight sweep timers.
 * - Emits persistent event-log entries for BG/AI/UI diagnostics.
 *
 * MV3 notes:
 * - Service workers are ephemeral; in-flight requests are lease-backed and can
 *   adopt offscreen cached results after restart to avoid stuck RUNNING states.
 */
(function initBackgroundApp(global) {
  const NT = global.NT;

  class BackgroundApp {
    constructor({ chromeApi, fetchFn } = {}) {
      this.chromeApi = chromeApi;
      this.fetchFn = fetchFn;

      this.eventLogStore = null;
      this.settingsStore = null;
      this.tabStateStore = null;
      this.translationJobStore = null;
      this.pageCacheStore = null;
      this.inflightStore = null;
      this.loadScheduler = null;
      this.uiHub = null;
      this.eventFactory = null;
      this.ai = null;
      this.offscreenExecutor = null;
      this.translationCall = null;
      this.translationAgent = null;
      this.translationOrchestrator = null;

      this._inflightSweepTimer = null;
      this._lastLimitsBroadcastAt = 0;

      this._onStorageChanged = this._onStorageChanged.bind(this);
      this._onRuntimeMessage = this._onRuntimeMessage.bind(this);
      this._handleUiCommand = this._handleUiCommand.bind(this);
      this._handleContentMessage = this._handleContentMessage.bind(this);
      this._runInflightSweepTick = this._runInflightSweepTick.bind(this);
      this._onTabRemoved = this._onTabRemoved.bind(this);
    }

    async start() {
      this._initServices();
      await this.eventLogStore.load();
      await this._preloadState();
      if (this.translationOrchestrator && typeof this.translationOrchestrator.restoreStateAfterRestart === 'function') {
        await this.translationOrchestrator.restoreStateAfterRestart();
      }
      this._startInflightSweeper();
      this._attachListeners();
      this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.BG_START, 'Background started', { source: 'background' }));
    }

    _initServices() {
      this.eventLogStore = new NT.EventLogStore({ chromeApi: this.chromeApi, limit: 800 });
      this.eventFactory = new NT.EventFactory({ time: NT.Time, source: 'bg' });
      this.settingsStore = new NT.SettingsStore({
        chromeApi: this.chromeApi,
        defaults: {
          translationModelList: [],
          modelSelection: null,
          modelSelectionPolicy: null,
          modelBenchmarkStatus: null,
          translationPipelineEnabled: false,
          translationAgentModelPolicy: null,
          translationAgentProfile: 'auto',
          translationAgentTools: {},
          translationAgentTuning: {},
          translationCategoryMode: 'all',
          translationCategoryList: [],
          translationPageCacheEnabled: true,
          translationApiCacheEnabled: true,
          translationPopupActiveTab: 'control'
        }
      });
      this.tabStateStore = new NT.TabStateStore({ chromeApi: this.chromeApi });
      this.translationJobStore = new NT.TranslationJobStore({ chromeApi: this.chromeApi });
      this.pageCacheStore = new NT.TranslationPageCacheStore({ chromeApi: this.chromeApi });
      this.inflightStore = new NT.InflightRequestStore({ chromeApi: this.chromeApi });

      const RuntimePaths = NT.RuntimePaths || null;
      const offscreenPath = RuntimePaths && typeof RuntimePaths.withPrefix === 'function'
        ? RuntimePaths.withPrefix(this.chromeApi, 'offscreen/offscreen.html')
        : 'offscreen/offscreen.html';

      this.offscreenExecutor = new NT.OffscreenExecutor({
        chromeApi: this.chromeApi,
        offscreenPath,
        eventFactory: this.eventFactory,
        eventLogFn: (event) => this._logEvent(event)
      });

      this.loadScheduler = new NT.AiLoadScheduler({
        eventLogger: (event) => this._logEvent(event)
      });

      this.ai = new NT.AiModule({
        chromeApi: this.chromeApi,
        fetchFn: this.fetchFn,
        loadScheduler: this.loadScheduler,
        eventLogger: (event) => this._logEvent(event),
        offscreenExecutor: this.offscreenExecutor
      }).init();

      this.translationCall = new NT.TranslationCall({
        runLlmRequest: (args) => this._runLlmRequest(args)
      });

      this.translationAgent = new NT.TranslationAgent({
        runLlmRequest: (args) => this._runLlmRequest(args),
        eventFactory: this.eventFactory,
        eventLogFn: (event) => this._logEvent(event)
      });

      this.translationOrchestrator = new NT.TranslationOrchestrator({
        chromeApi: this.chromeApi,
        settingsStore: this.settingsStore,
        tabStateStore: this.tabStateStore,
        jobStore: this.translationJobStore,
        pageCacheStore: this.pageCacheStore,
        translationCall: this.translationCall,
        translationAgent: this.translationAgent,
        eventFactory: this.eventFactory,
        eventLogFn: (event) => this._logEvent(event),
        onUiPatch: (patch) => {
          if (this.uiHub) {
            this.uiHub.broadcastPatch(patch);
          }
        }
      });

      this.uiHub = new NT.UiPortHub({
        settingsStore: this.settingsStore,
        tabStateStore: this.tabStateStore,
        translationJobStore: this.translationJobStore,
        eventLogStore: this.eventLogStore,
        aiModule: this.ai,
        onCommand: ({ envelope }) => {
          this._handleUiCommand(envelope).catch((error) => {
            this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'UI command failed', {
              source: 'ui',
              message: error && error.message ? error.message : 'unknown'
            }));
          });
        },
        onEvent: (event) => this._logEvent(event)
      });
    }

    async _preloadState() {
      const state = await this.settingsStore.get([
        'modelBenchmarkStatus',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationPipelineEnabled',
        'translationAgentModelPolicy',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationCategoryMode',
        'translationCategoryList',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationPopupActiveTab'
      ]);
      const status = state.modelBenchmarkStatus || null;
      const now = Date.now();
      if (status && status.status === 'running' && typeof status.leaseUntilTs === 'number' && status.leaseUntilTs < now) {
        await this.settingsStore.set({
          modelBenchmarkStatus: {
            status: 'failed',
            reason: 'LEASE_EXPIRED',
            total: status.total || 0,
            completed: status.completed || 0,
            updatedAt: now,
            finishedAt: now,
            currentModelSpec: status.currentModelSpec || null,
            leaseUntilTs: null
          }
        });
      }
      if (!state.modelSelection) {
        const modelSelection = this.ai.normalizeSelection(state.modelSelection, state.modelSelectionPolicy);
        await this.settingsStore.set({ modelSelection });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationPipelineEnabled')) {
        await this.settingsStore.set({ translationPipelineEnabled: false });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationAgentModelPolicy') || !state.translationAgentModelPolicy) {
        await this.settingsStore.set({
          translationAgentModelPolicy: this._normalizeAgentModelPolicy(state.translationAgentModelPolicy, state.modelSelection)
        });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationAgentProfile')) {
        await this.settingsStore.set({ translationAgentProfile: 'auto' });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationAgentTools')) {
        await this.settingsStore.set({ translationAgentTools: {} });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationAgentTuning')) {
        await this.settingsStore.set({ translationAgentTuning: {} });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationCategoryMode')) {
        await this.settingsStore.set({ translationCategoryMode: 'all' });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationCategoryList')) {
        await this.settingsStore.set({ translationCategoryList: [] });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationPageCacheEnabled')) {
        await this.settingsStore.set({ translationPageCacheEnabled: true });
      }
      const normalizedModelList = this._sanitizeModelList(state.translationModelList);
      const modelList = normalizedModelList.length
        ? normalizedModelList
        : this._buildDefaultModelList();
      const sourceList = Array.isArray(state.translationModelList) ? state.translationModelList : [];
      if (!this._sameModelList(sourceList, modelList)) {
        await this.settingsStore.set({ translationModelList: modelList });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationApiCacheEnabled')) {
        await this.settingsStore.set({ translationApiCacheEnabled: true });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationPopupActiveTab')) {
        await this.settingsStore.set({ translationPopupActiveTab: 'control' });
      }
    }

    _attachListeners() {
      this.uiHub.attachToRuntime();
      if (this.chromeApi && this.chromeApi.runtime && this.chromeApi.runtime.onMessage) {
        this.chromeApi.runtime.onMessage.addListener(this._onRuntimeMessage);
      }
      if (this.chromeApi && this.chromeApi.storage && this.chromeApi.storage.onChanged) {
        this.chromeApi.storage.onChanged.addListener(this._onStorageChanged);
      }
      if (this.chromeApi && this.chromeApi.tabs && this.chromeApi.tabs.onRemoved) {
        this.chromeApi.tabs.onRemoved.addListener(this._onTabRemoved);
      }
    }

    _startInflightSweeper() {
      if (this._inflightSweepTimer) {
        return;
      }
      this._inflightSweepTimer = global.setTimeout(this._runInflightSweepTick, this.inflightStore.SWEEP_INTERVAL_MS);
    }

    async _runInflightSweepTick() {
      this._inflightSweepTimer = null;
      try {
        await this._sweepInflight();
      } catch (error) {
        this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.BG_ERROR, 'Inflight sweep failed', { message: error && error.message ? error.message : 'unknown' }));
      } finally {
        this._inflightSweepTimer = global.setTimeout(this._runInflightSweepTick, this.inflightStore.SWEEP_INTERVAL_MS);
      }
    }

    async _sweepInflight() {
      const now = Date.now();
      const expiredRows = await this.inflightStore.listExpired(now);
      for (const row of expiredRows) {
        try {
          const cached = await this._getOffscreenCachedResult(row.requestId);
          if (cached) {
            await this._applyAdoptedResult(row, cached);
          } else {
            await this._releaseReservation(row.modelSpec, row.requestId);
            this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.BG_ERROR, 'Inflight expired without cached result', {
              requestId: row.requestId,
              tabId: row.tabId,
              jobId: row.jobId || null,
              blockId: row.blockId || null
            }));
          }
        } catch (error) {
          this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.BG_ERROR, 'Inflight adoption failed', {
            requestId: row.requestId,
            message: error && error.message ? error.message : 'unknown'
          }));
        } finally {
          await this.inflightStore.remove(row.requestId);
        }
      }
    }

    async _getOffscreenCachedResult(requestId) {
      if (!requestId || !this.offscreenExecutor) {
        return null;
      }
      try {
        return await this.offscreenExecutor.getCachedResult(requestId);
      } catch (_) {
        return null;
      }
    }

    async _applyAdoptedResult(row, result) {
      if (!result || typeof result !== 'object') {
        return;
      }
      if (result.ok && row && row.modelSpec && result.headers && this.ai && typeof this.ai.adoptRateLimitHeaders === 'function') {
        try {
          const headers = this._toHeaderAccessor(result.headers);
          await this.ai.adoptRateLimitHeaders(row.modelSpec, headers, { receivedAt: Date.now() });
        } catch (_) {
          // ignore best-effort header adoption
        }
      }

      this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.AI_RESPONSE, result.ok ? 'Adopted cached offscreen result' : 'Adopted cached offscreen error', {
        requestId: row.requestId,
        modelSpec: row.modelSpec || null,
        status: result.status || null,
        adopted: true
      }));
    }

    _toHeaderAccessor(rawHeaders) {
      return {
        get(name) {
          if (!rawHeaders || typeof rawHeaders !== 'object') {
            return null;
          }
          const key = String(name || '').toLowerCase();
          const keys = Object.keys(rawHeaders);
          for (const item of keys) {
            if (String(item).toLowerCase() === key) {
              return rawHeaders[item];
            }
          }
          return null;
        }
      };
    }

    async _releaseReservation(modelSpec, requestId) {
      if (!this.ai || typeof this.ai.releaseReservation !== 'function' || !modelSpec || !requestId) {
        return;
      }
      await this.ai.releaseReservation(modelSpec, requestId);
    }

    _estimateRequestTokens(input, maxOutputTokens) {
      let promptLength = 0;
      if (typeof input === 'string') {
        promptLength = input.length;
      } else {
        try {
          promptLength = JSON.stringify(input || '').length;
        } catch (_) {
          promptLength = 0;
        }
      }
      const maxOutput = typeof maxOutputTokens === 'number' ? maxOutputTokens : 512;
      return Math.ceil(promptLength / 4) + maxOutput;
    }

    _buildDeterministicRequestMeta({ tabId, taskType, request }) {
      const src = request && typeof request === 'object' ? request : {};
      const attempt = Number.isFinite(Number(src.attempt)) ? Number(src.attempt) : 1;
      const jobId = src.jobId || `tab${tabId === null || tabId === undefined ? 'na' : String(tabId)}`;
      const blockId = src.blockId || src.blockIndex || 'block0';
      const safeTask = taskType || 'unknown';
      const requestId = src.requestId || `${jobId}:${blockId}:${attempt}:${safeTask}`;
      return {
        requestId,
        jobId,
        blockId,
        attempt,
        timeoutMs: Number.isFinite(Number(src.timeoutMs)) ? Number(src.timeoutMs) : 90000
      };
    }

    async _runLlmRequest({ tabId, taskType, request }) {
      const settings = await this._readLlmSettings();
      const safeRequest = request && typeof request === 'object' ? request : {};
      const requestMeta = this._buildDeterministicRequestMeta({ tabId, taskType, request: safeRequest });
      const estTokens = this._estimateRequestTokens(safeRequest.input, safeRequest.maxOutputTokens);
      const now = Date.now();

      await this.inflightStore.upsert(requestMeta.requestId, {
        tabId,
        jobId: requestMeta.jobId,
        blockId: requestMeta.blockId,
        attempt: requestMeta.attempt,
        taskType: taskType || 'unknown',
        modelSpec: null,
        estTokens,
        startedAt: now,
        attemptDeadlineTs: now + requestMeta.timeoutMs,
        leaseUntilTs: this.inflightStore.nextLease(now)
      });

      try {
        const prevModelSpec = tabId !== null && tabId !== undefined
          ? await this.tabStateStore.getLastModelSpec(tabId)
          : null;
        const effectiveModelSelection = this._resolveEffectiveModelSelection({
          taskType,
          request: safeRequest,
          modelSelection: settings.modelSelection,
          translationAgentModelPolicy: settings.translationAgentModelPolicy,
          translationAgentProfile: settings.translationAgentProfile
        });

        const result = await this.ai.request({
          tabId,
          taskType,
          selectedModelSpecs: settings.translationModelList,
          modelSelection: effectiveModelSelection,
          input: safeRequest.input,
          maxOutputTokens: safeRequest.maxOutputTokens,
          temperature: safeRequest.temperature,
          store: safeRequest.store,
          background: safeRequest.background,
          signal: safeRequest.signal,
          hintPrevModelSpec: prevModelSpec,
          hintBatchSize: Number.isFinite(Number(safeRequest.hintBatchSize)) ? Number(safeRequest.hintBatchSize) : 1,
          requestMeta
        });

        if (result && result.decision && result.decision.chosenModelSpec) {
          await this.inflightStore.upsert(requestMeta.requestId, {
            modelSpec: result.decision.chosenModelSpec,
            leaseUntilTs: this.inflightStore.nextLease(Date.now())
          });
        }

        if (tabId !== null && tabId !== undefined && result && result.decision) {
          await this.tabStateStore.upsertModelDecision(tabId, {
            chosenModelSpec: result.decision.chosenModelSpec,
            chosenModelId: result.decision.chosenModelId,
            serviceTier: result.decision.serviceTier,
            decision: {
              policy: result.decision.policy,
              reason: result.decision.reason,
              candidates: result.decision.candidates
            },
            taskType: taskType || 'unknown',
            updatedAt: Date.now()
          });
          await this.tabStateStore.setLastModelSpec(tabId, result.decision.chosenModelSpec);
        }

        await this.inflightStore.remove(requestMeta.requestId);
        return result ? result.json : null;
      } catch (error) {
        await this.inflightStore.remove(requestMeta.requestId);
        throw error;
      }
    }

    async _readLlmSettings() {
      const data = await this.settingsStore.get([
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationAgentModelPolicy',
        'translationAgentProfile',
        'translationApiCacheEnabled'
      ]);
      const modelSelection = this.ai.normalizeSelection(data.modelSelection, data.modelSelectionPolicy);
      if (!data.modelSelection) {
        await this.settingsStore.set({ modelSelection });
      }
      const translationAgentModelPolicy = this._normalizeAgentModelPolicy(data.translationAgentModelPolicy, modelSelection);
      if (!data.translationAgentModelPolicy) {
        await this.settingsStore.set({ translationAgentModelPolicy });
      }
      const sourceModels = Array.isArray(data.translationModelList) ? data.translationModelList : [];
      const normalizedModels = this._sanitizeModelList(sourceModels);
      const effectiveModels = normalizedModels.length
        ? normalizedModels
        : this._buildDefaultModelList();
      if (!this._sameModelList(sourceModels, effectiveModels)) {
        await this.settingsStore.set({ translationModelList: effectiveModels });
      }
      return {
        translationModelList: effectiveModels,
        modelSelection,
        translationAgentModelPolicy,
        translationAgentProfile: data.translationAgentProfile || 'auto',
        translationApiCacheEnabled: data.translationApiCacheEnabled !== false
      };
    }

    _normalizeAgentModelPolicy(modelPolicy, fallbackSelection) {
      const fallback = this.ai.normalizeSelection(fallbackSelection, null);
      const source = modelPolicy && typeof modelPolicy === 'object' ? modelPolicy : {};
      const mode = source.mode === 'fixed' ? 'fixed' : 'auto';
      const hasSpeed = Object.prototype.hasOwnProperty.call(source, 'speed');
      const preference = source.preference === 'smartest' || source.preference === 'cheapest'
        ? source.preference
        : fallback.preference;
      return {
        mode,
        speed: hasSpeed ? source.speed !== false : fallback.speed !== false,
        preference,
        allowRouteOverride: source.allowRouteOverride !== false
      };
    }

    _resolveEffectiveModelSelection({
      taskType,
      request,
      modelSelection,
      translationAgentModelPolicy,
      translationAgentProfile
    } = {}) {
      const base = this.ai.normalizeSelection(modelSelection, null);
      const safeTask = typeof taskType === 'string' ? taskType : '';
      const req = request && typeof request === 'object' ? request : {};
      if (!safeTask.startsWith('translation_')) {
        return base;
      }

      const policy = this._normalizeAgentModelPolicy(translationAgentModelPolicy, base);
      let out = {
        speed: policy.speed !== false,
        preference: policy.preference
      };
      const profile = translationAgentProfile === 'balanced'
        || translationAgentProfile === 'literal'
        || translationAgentProfile === 'readable'
        || translationAgentProfile === 'technical'
        ? translationAgentProfile
        : 'auto';
      const route = req.agentRoute === 'strong' || req.agentRoute === 'fast'
        ? req.agentRoute
        : null;

      if (policy.mode === 'auto') {
        if (profile === 'technical' || profile === 'literal') {
          out = { speed: false, preference: 'smartest' };
        } else if (profile === 'readable') {
          out = { speed: true, preference: null };
        }
      }

      if (policy.allowRouteOverride !== false && route === 'strong') {
        out = { speed: false, preference: 'smartest' };
      } else if (policy.allowRouteOverride !== false && route === 'fast') {
        out = { speed: true, preference: out.preference === 'smartest' ? null : out.preference };
      }

      return this.ai.normalizeSelection(out, null);
    }

    async _handleUiCommand(envelope) {
      if (!envelope || !envelope.payload) {
        return { ok: false, error: { code: 'INVALID_UI_COMMAND', message: 'Missing envelope payload' } };
      }
      const UiProtocol = NT && NT.UiProtocol ? NT.UiProtocol : null;
      const payload = envelope.payload || {};
      const commandName = payload.name;
      const commandPayload = payload.payload && typeof payload.payload === 'object' ? payload.payload : {};

      if (commandName === 'LOG_EVENT') {
        const event = commandPayload && typeof commandPayload === 'object' ? commandPayload : null;
        if (event) {
          this._logEvent({ ...event, meta: { ...(event.meta || {}), source: 'ui' } });
        }
        return { ok: true };
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.CLEAR_EVENT_LOG : 'CLEAR_EVENT_LOG')) {
        await this.eventLogStore.clear();
        this.uiHub.broadcastEventReset();
        this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'Event log cleared', { source: 'ui' }));
        return { ok: true };
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.BENCHMARK_SELECTED_MODELS : 'BENCHMARK_SELECTED_MODELS')) {
        this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.BENCH_START, 'Benchmark request received', { source: 'ui' }));
        try {
          const modelSpecs = await this._loadSelectedModels();
          await this.ai.benchmarkSelected(modelSpecs, { force: Boolean(commandPayload.force) });
          return { ok: true };
        } catch (_) {
          await this.settingsStore.set({
            modelBenchmarkStatus: { status: 'failed', errorCode: 'BENCHMARK_START_FAILED', updatedAt: Date.now() }
          });
          return { ok: false, error: { code: 'BENCHMARK_START_FAILED', message: 'Benchmark start failed' } };
        }
      }

      if (!this.translationOrchestrator) {
        return { ok: false, error: { code: 'ORCHESTRATOR_UNAVAILABLE', message: 'Translation orchestrator is unavailable' } };
      }

      const tabId = this._resolveCommandTabId(envelope, commandPayload);
      const commands = UiProtocol && UiProtocol.Commands ? UiProtocol.Commands : {};
      if (commandName === commands.START_TRANSLATION || commandName === 'START_TRANSLATION') {
        await this._ensureTranslationPipelineEnabled();
        const result = await this.translationOrchestrator.startJob({
          tabId,
          url: commandPayload.url || '',
          targetLang: commandPayload.targetLang || 'ru',
          force: Boolean(commandPayload.force)
        });
        if (!result.ok) {
          this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.TRANSLATION_FAIL, 'Start translation rejected', {
            source: 'ui',
            tabId,
            reason: result.error && result.error.code ? result.error.code : 'unknown'
          }));
        }
        return result;
      }

      if (commandName === commands.CANCEL_TRANSLATION || commandName === 'CANCEL_TRANSLATION') {
        return this.translationOrchestrator.cancelJob({ tabId, reason: 'USER_CANCELLED' });
      }

      if (commandName === commands.SET_TRANSLATION_CATEGORIES || commandName === 'SET_TRANSLATION_CATEGORIES') {
        return this.translationOrchestrator.applyCategorySelection({
          tabId,
          categories: Array.isArray(commandPayload.categories) ? commandPayload.categories : [],
          jobId: commandPayload.jobId || null
        });
      }

      if (commandName === commands.CLEAR_TRANSLATION_DATA || commandName === 'CLEAR_TRANSLATION_DATA') {
        return this.translationOrchestrator.clearJobData({
          tabId,
          includeCache: commandPayload.includeCache !== false
        });
      }

      if (commandName === commands.SET_TRANSLATION_VISIBILITY || commandName === 'SET_TRANSLATION_VISIBILITY') {
        return this.translationOrchestrator.setVisibility({ tabId, visible: Boolean(commandPayload.visible) });
      }

      if (commandName === commands.RETRY_FAILED_BLOCKS || commandName === 'RETRY_FAILED_BLOCKS') {
        return this.translationOrchestrator.retryFailed({ tabId, jobId: commandPayload.jobId || null });
      }

      this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'Unknown UI command', {
        source: 'ui',
        stage: commandName || 'unknown'
      }));
      return { ok: false, error: { code: 'UNKNOWN_UI_COMMAND', message: String(commandName || 'unknown') } };
    }

    _resolveCommandTabId(envelope, commandPayload) {
      if (commandPayload && Number.isFinite(Number(commandPayload.tabId))) {
        return Number(commandPayload.tabId);
      }
      if (envelope && envelope.meta && Number.isFinite(Number(envelope.meta.tabId))) {
        return Number(envelope.meta.tabId);
      }
      return null;
    }

    async _handleContentMessage(message, sender) {
      if (!this.translationOrchestrator) {
        return { ok: false, error: { code: 'ORCHESTRATOR_UNAVAILABLE', message: 'Translation orchestrator unavailable' } };
      }
      return this.translationOrchestrator.handleContentMessage({ message, sender });
    }

    _onRuntimeMessage(message, sender, sendResponse) {
      const TranslationProtocol = NT && NT.TranslationProtocol ? NT.TranslationProtocol : null;
      if (TranslationProtocol && message && typeof message.type === 'string' && this.translationOrchestrator && this.translationOrchestrator.isContentMessageType(message.type)) {
        this._handleContentMessage(message, sender)
          .then((result) => this._respondWithTimeout(sendResponse, result || { ok: true }))
          .catch((error) => this._respondWithTimeout(sendResponse, {
            ok: false,
            error: { code: 'CONTENT_MESSAGE_FAILED', message: error && error.message ? error.message : 'unknown' }
          }));
        return true;
      }

      const MessageEnvelope = NT && NT.MessageEnvelope ? NT.MessageEnvelope : null;
      const UiProtocol = NT && NT.UiProtocol ? NT.UiProtocol : null;
      if (!MessageEnvelope || !UiProtocol || !MessageEnvelope.isEnvelope(message)) {
        return false;
      }

      if (message.type === UiProtocol.UI_COMMAND) {
        this._handleUiCommand(message)
          .then((result) => this._respondWithTimeout(sendResponse, result || { ok: true }))
          .catch((error) => this._respondWithTimeout(sendResponse, {
            ok: false,
            error: { code: 'UI_COMMAND_FAILED', message: error && error.message ? error.message : 'unknown' }
          }));
        return true;
      }
      return false;
    }

    _onStorageChanged(changes, areaName) {
      if (areaName !== 'local') {
        return;
      }
      const watchedKeys = [
        'translationStatusByTab',
        'translationVisibilityByTab',
        'modelBenchmarkStatus',
        'modelBenchmarks',
        'translationPipelineEnabled',
        'translationAgentModelPolicy',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationCategoryMode',
        'translationCategoryList',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationPopupActiveTab'
      ];
      const changedKeys = Object.keys(changes).filter((key) => watchedKeys.includes(key));
      if (!changedKeys.length) {
        return;
      }
      const patch = {};
      changedKeys.forEach((key) => {
        patch[key] = changes[key].newValue;
      });
      this.uiHub.broadcastPatch({ changedKeys, patch });
    }

    _logEvent(eventLike) {
      if (!this.eventLogStore) {
        return;
      }
      const event = eventLike && typeof eventLike === 'object' && typeof eventLike.ts === 'number' && typeof eventLike.level === 'string' && typeof eventLike.tag === 'string'
        ? eventLike
        : this.eventFactory.make(eventLike || {});

      this.eventLogStore.append(event)
        .then((entry) => {
          if (this.uiHub && entry) {
            this.uiHub.broadcastEventAppend(entry);
          }
          this._maybeBroadcastModelLimits(event);
        })
        .catch(() => {});
    }

    _maybeBroadcastModelLimits(event) {
      const now = Date.now();
      if (!event || !event.tag || (event.tag !== NT.EventTypes.Tags.AI_RATE_LIMIT && event.tag !== NT.EventTypes.Tags.AI_COOLDOWN)) {
        return;
      }
      if ((now - this._lastLimitsBroadcastAt) < 1000) {
        return;
      }
      this._lastLimitsBroadcastAt = now;
      this.uiHub.buildModelLimitsSnapshot().then((modelLimitsBySpec) => {
        this.uiHub.broadcastPatch({ modelLimitsBySpec });
      }).catch(() => {});
    }

    _respondWithTimeout(sendResponse, payload, timeoutMs = 2000) {
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
        } catch (_) {
          // ignore
        }
      }, timeoutMs);

      try {
        sendResponse(payload);
      } finally {
        settled = true;
        global.clearTimeout(timer);
      }
    }

    _onTabRemoved(tabId, removeInfo) {
      const numericTabId = Number(tabId);
      if (!this.translationOrchestrator || !Number.isFinite(numericTabId)) {
        return;
      }
      this.translationOrchestrator.cancelJob({
        tabId: numericTabId,
        reason: 'TAB_CLOSED'
      }).then((result) => {
        if (result && result.cancelled) {
          this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.TRANSLATION_CANCEL, 'Translation job cancelled because tab was removed', {
            tabId: numericTabId,
            isWindowClosing: Boolean(removeInfo && removeInfo.isWindowClosing)
          }));
        }
      }).catch((error) => {
        this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.BG_ERROR, 'Failed to cancel translation on tab removal', {
          tabId: numericTabId,
          message: error && error.message ? error.message : 'unknown'
        }));
      });
    }

    async _loadSelectedModels() {
      const data = await this.settingsStore.get(['translationModelList']);
      const source = Array.isArray(data.translationModelList) ? data.translationModelList : [];
      const normalized = this._sanitizeModelList(source);
      const effective = normalized.length ? normalized : this._buildDefaultModelList();
      if (!this._sameModelList(source, effective)) {
        await this.settingsStore.set({ translationModelList: effective });
      }
      return effective;
    }

    async _ensureTranslationPipelineEnabled() {
      if (!this.settingsStore || typeof this.settingsStore.get !== 'function' || typeof this.settingsStore.set !== 'function') {
        return;
      }
      const state = await this.settingsStore.get(['translationPipelineEnabled']);
      if (state && state.translationPipelineEnabled === true) {
        return;
      }
      await this.settingsStore.set({ translationPipelineEnabled: true });
    }

    _sanitizeModelList(inputList) {
      const source = Array.isArray(inputList) ? inputList : [];
      const registry = this.ai && typeof this.ai.getRegistry === 'function'
        ? this.ai.getRegistry()
        : { byKey: {} };
      const byKey = registry && registry.byKey && typeof registry.byKey === 'object'
        ? registry.byKey
        : {};
      const seen = new Set();
      const out = [];
      source.forEach((item) => {
        const key = typeof item === 'string' ? item.trim() : '';
        if (!key || seen.has(key) || !Object.prototype.hasOwnProperty.call(byKey, key)) {
          return;
        }
        seen.add(key);
        out.push(key);
      });
      return out;
    }

    _buildDefaultModelList() {
      const registry = this.ai && typeof this.ai.getRegistry === 'function'
        ? this.ai.getRegistry()
        : { entries: [] };
      const entries = registry && Array.isArray(registry.entries)
        ? registry.entries
        : [];
      const preferredIds = ['gpt-5-mini', 'gpt-4o-mini', 'o4-mini', 'gpt-5', 'gpt-4.1-mini', 'o3'];
      const preferred = [];
      const pushSpec = (id, tier) => {
        if (!id || !tier) {
          return;
        }
        const spec = `${id}:${tier}`;
        if (!preferred.includes(spec)) {
          preferred.push(spec);
        }
      };

      preferredIds.forEach((id) => {
        const standard = entries.find((entry) => entry && entry.id === id && entry.tier === 'standard');
        if (standard) {
          pushSpec(standard.id, standard.tier);
          return;
        }
        const flex = entries.find((entry) => entry && entry.id === id && entry.tier === 'flex');
        if (flex) {
          pushSpec(flex.id, flex.tier);
        }
      });

      if (preferred.length >= 3) {
        return preferred.slice(0, 6);
      }

      const fallback = entries
        .slice()
        .sort((a, b) => {
          const aId = a && a.id ? a.id : '';
          const bId = b && b.id ? b.id : '';
          if (aId !== bId) {
            return aId.localeCompare(bId);
          }
          const aTier = a && a.tier ? a.tier : 'standard';
          const bTier = b && b.tier ? b.tier : 'standard';
          return aTier.localeCompare(bTier);
        })
        .map((entry) => `${entry.id}:${entry.tier}`)
        .filter((spec, index, list) => spec && list.indexOf(spec) === index)
        .slice(0, 6);
      return fallback;
    }

    _sameModelList(a, b) {
      const left = Array.isArray(a) ? a : [];
      const right = Array.isArray(b) ? b : [];
      if (left.length !== right.length) {
        return false;
      }
      for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) {
          return false;
        }
      }
      return true;
    }
  }

  NT.BackgroundApp = BackgroundApp;
})(globalThis);
