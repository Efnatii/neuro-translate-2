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
      this.inflightStore = null;
      this.loadScheduler = null;
      this.uiHub = null;
      this.eventFactory = null;
      this.ai = null;
      this.offscreenExecutor = null;

      this._inflightSweepTimer = null;
      this._lastLimitsBroadcastAt = 0;

      this._onStorageChanged = this._onStorageChanged.bind(this);
      this._onRuntimeMessage = this._onRuntimeMessage.bind(this);
      this._handleUiCommand = this._handleUiCommand.bind(this);
      this._runInflightSweepTick = this._runInflightSweepTick.bind(this);
    }

    async start() {
      this._initServices();
      await this.eventLogStore.load();
      await this._preloadState();
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
          modelBenchmarkStatus: null
        }
      });
      this.tabStateStore = new NT.TabStateStore({ chromeApi: this.chromeApi });
      this.inflightStore = new NT.InflightRequestStore({ chromeApi: this.chromeApi });

      this.offscreenExecutor = new NT.OffscreenExecutor({
        chromeApi: this.chromeApi,
        offscreenPath: 'offscreen/offscreen.html',
        eventFactory: this.eventFactory,
        eventLogFn: (event) => this._logEvent(event)
      });

      this.loadScheduler = new NT.AiLoadScheduler({
        rpm: 60,
        tpm: 60000,
        eventLogger: (event) => this._logEvent(event)
      });

      this.ai = new NT.AiModule({
        chromeApi: this.chromeApi,
        fetchFn: this.fetchFn,
        loadScheduler: this.loadScheduler,
        eventLogger: (event) => this._logEvent(event),
        offscreenExecutor: this.offscreenExecutor
      }).init();

      this.uiHub = new NT.UiPortHub({
        settingsStore: this.settingsStore,
        tabStateStore: this.tabStateStore,
        eventLogStore: this.eventLogStore,
        aiModule: this.ai,
        onCommand: ({ envelope }) => this._handleUiCommand(envelope),
        onEvent: (event) => this._logEvent(event)
      });
    }

    async _preloadState() {
      const state = await this.settingsStore.get(['modelBenchmarkStatus', 'modelSelection', 'modelSelectionPolicy']);
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
    }

    _attachListeners() {
      this.uiHub.attachToRuntime();
      if (this.chromeApi && this.chromeApi.runtime && this.chromeApi.runtime.onMessage) {
        this.chromeApi.runtime.onMessage.addListener(this._onRuntimeMessage);
      }
      if (this.chromeApi && this.chromeApi.storage && this.chromeApi.storage.onChanged) {
        this.chromeApi.storage.onChanged.addListener(this._onStorageChanged);
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

        const result = await this.ai.request({
          tabId,
          taskType,
          selectedModelSpecs: settings.translationModelList,
          modelSelection: settings.modelSelection,
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
      const data = await this.settingsStore.get(['translationModelList', 'modelSelection', 'modelSelectionPolicy']);
      const modelSelection = this.ai.normalizeSelection(data.modelSelection, data.modelSelectionPolicy);
      if (!data.modelSelection) {
        await this.settingsStore.set({ modelSelection });
      }
      return {
        translationModelList: Array.isArray(data.translationModelList) ? data.translationModelList : [],
        modelSelection
      };
    }

    _handleUiCommand(envelope) {
      if (!envelope || !envelope.payload) {
        return;
      }
      const payload = envelope.payload || {};
      if (payload.name === 'LOG_EVENT') {
        const event = payload.payload && typeof payload.payload === 'object' ? payload.payload : null;
        if (event) {
          this._logEvent({ ...event, meta: { ...(event.meta || {}), source: 'ui' } });
        }
        return;
      }

      if (payload.name === 'CLEAR_EVENT_LOG') {
        this.eventLogStore.clear().then(() => this.uiHub.broadcastEventReset()).catch(() => {});
        this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'Event log cleared', { source: 'ui' }));
        return;
      }

      if (payload.name !== 'BENCHMARK_SELECTED_MODELS') {
        return;
      }

      this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.BENCH_START, 'Benchmark request received', { source: 'ui' }));
      this._loadSelectedModels()
        .then((modelSpecs) => this.ai.benchmarkSelected(modelSpecs, { force: Boolean(payload.payload && payload.payload.force) }))
        .catch(() => this.settingsStore.set({
          modelBenchmarkStatus: { status: 'failed', errorCode: 'BENCHMARK_START_FAILED', updatedAt: Date.now() }
        }));
    }

    _onRuntimeMessage(message, sender, sendResponse) {
      const MessageEnvelope = NT && NT.MessageEnvelope ? NT.MessageEnvelope : null;
      const UiProtocol = NT && NT.UiProtocol ? NT.UiProtocol : null;
      if (!MessageEnvelope || !UiProtocol || !MessageEnvelope.isEnvelope(message)) {
        return false;
      }

      if (message.type === UiProtocol.UI_COMMAND) {
        this._handleUiCommand(message);
        if (message.payload && (message.payload.name === 'LOG_EVENT' || message.payload.name === 'CLEAR_EVENT_LOG')) {
          this._respondWithTimeout(sendResponse, { ok: true });
          return true;
        }
      }
      return false;
    }

    _onStorageChanged(changes, areaName) {
      if (areaName !== 'local') {
        return;
      }
      const watchedKeys = ['translationStatusByTab', 'translationVisibilityByTab', 'modelBenchmarkStatus', 'modelBenchmarks'];
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

    async _loadSelectedModels() {
      const data = await this.settingsStore.get(['translationModelList']);
      return Array.isArray(data.translationModelList) ? data.translationModelList : [];
    }
  }

  NT.BackgroundApp = BackgroundApp;
})(globalThis);
