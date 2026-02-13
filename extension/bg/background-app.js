/**
 * Файл реализует центральный класс service worker для MV3-расширения.
 *
 * Классы внутри:
 * - `BackgroundApp` — главный оркестратор background-слоя: поднимает сторы,
 *   подключает AI-модуль, обслуживает runtime/UI команды и рассылает patch-события.
 *
 * За что отвечает:
 * - восстановление устойчивого состояния после перезапуска воркера;
 * - обработка команд UI (`SETTINGS_PATCH`, `GET_API_KEY`, benchmark и т.д.);
 * - безопасная публикация snapshot/patch через `UiPortHub`;
 * - интеграция с offscreen transport, rate limits и event log.
 *
 * Что НЕ делает:
 * - не рендерит UI и не хранит секреты в snapshot/broadcast;
 * - не переносит бизнес-логику в popup/debug, оставляя UI тонким клиентом.
 */
(function initBackgroundApp(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  class BackgroundApp {
    constructor({ chromeApi, fetchFn } = {}) {
      this.chromeApi = chromeApi;
      this.fetchFn = fetchFn;

      this.eventLogStore = null;
      this.settingsStore = null;
      this.tabStateStore = null;
      this.inflightStore = null;
      this.rateLimiter = null;
      this.loadScheduler = null;
      this.uiHub = null;
      this.eventFactory = null;
      this.ai = null;
      this.offscreenExecutor = null;
      this.installGuard = null;
      this.redactor = null;
      this.migrations = null;

      this._inflightSweepTimer = null;
      this._lastLimitsBroadcastAt = 0;

      this._onStorageChanged = this._onStorageChanged.bind(this);
      this._handleUiCommand = this._handleUiCommand.bind(this);
      this._runInflightSweepTick = this._runInflightSweepTick.bind(this);
    }

    async start() {
      this._initServices();
      await this.eventLogStore.load();
      if (this.migrations) {
        await this.migrations.run();
      }
      await this._preloadState();
      if (this.installGuard && typeof this.installGuard.runChecks === 'function') {
        await this.installGuard.runChecks({
          offscreenExecutor: this.offscreenExecutor,
          requireOpenAiHost: true
        });
      }
      this._logEvent(this.eventFactory.info('INSTALL_CHECK_COMPLETE', 'Install checks finished', {
        mode: this.offscreenExecutor ? this.offscreenExecutor.mode : 'unknown',
        disabledReason: this.offscreenExecutor ? this.offscreenExecutor.disabledReason : null
      }));
      this._startInflightSweeper();
      this._attachListeners();
      this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.BG_START, 'Background started', { source: 'background' }));
    }

    _initServices() {
      this.eventFactory = new NT.EventFactory({ time: NT.Time, source: 'bg' });
      this.redactor = new NT.Redactor();
      this.eventLogStore = new BG.EventLogStore({
        chromeApi: this.chromeApi,
        limit: 800,
        redactor: this.redactor
      });
      this.settingsStore = new NT.SettingsStore({
        chromeApi: this.chromeApi,
        eventSink: (event) => this._logEvent(event)
      });
      this.tabStateStore = new BG.TabStateStore({ chromeApi: this.chromeApi });
      this.inflightStore = new BG.InflightRequestStore({ chromeApi: this.chromeApi });

      this.offscreenExecutor = new BG.OffscreenExecutor({
        chromeApi: this.chromeApi,
        offscreenPath: 'offscreen/offscreen.html',
        eventFactory: this.eventFactory,
        eventLogFn: (event) => this._logEvent(event)
      });

      this.rateLimiter = new NT.RateLimiter({ rpm: 60, tpm: 60000 });
      this.loadScheduler = new BG.LoadScheduler({
        rateLimiter: this.rateLimiter,
        eventLogger: (event) => this._logEvent(event)
      });

      this.ai = new NT.AiModule({
        chromeApi: this.chromeApi,
        fetchFn: this.fetchFn,
        loadScheduler: this.loadScheduler,
        eventLogger: (event) => this._logEvent(event),
        offscreenExecutor: this.offscreenExecutor
      }).init();

      this.uiHub = new BG.UiPortHub({
        settingsStore: this.settingsStore,
        tabStateStore: this.tabStateStore,
        eventLogStore: this.eventLogStore,
        aiFacade: this.ai,
        offscreenExecutor: this.offscreenExecutor,
        redactor: this.redactor,
        onCommand: (ctx) => this._handleUiCommand(ctx),
        onEvent: (event) => this._logEvent(event)
      });

      this.installGuard = new BG.InstallGuard({
        chromeApi: this.chromeApi,
        eventFactory: this.eventFactory,
        emitEventFn: (event) => this._logEvent(event)
      });

      this.migrations = new BG.MigrationManager({
        settingsStore: this.settingsStore,
        aiStores: [this.ai && this.ai.benchmarkStore, this.ai && this.ai.rateLimitStore, this.ai && this.ai.perfStore],
        bgStores: [this.tabStateStore, this.inflightStore, this.eventLogStore],
        eventSink: (event) => this._logEvent(event)
      });
    }

    async _preloadState() {
      if (this.ai && typeof this.ai.sweepBenchmarkLeaseIfExpired === 'function') {
        await this.ai.sweepBenchmarkLeaseIfExpired();
      }
    }

    _attachListeners() {
      this.uiHub.attachToRuntime();
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
      if (result.ok && row && row.modelSpec && result.headers && this.ai) {
        await this.ai.adoptRateLimitHeaders(row.modelSpec, result.headers, { receivedAt: Date.now() });
      }

      this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.AI_RESPONSE, result.ok ? 'Adopted cached offscreen result' : 'Adopted cached offscreen error', {
        requestId: row.requestId,
        modelSpec: row.modelSpec || null,
        status: result.status || null,
        adopted: true
      }));
    }

    async _releaseReservation(modelSpec, requestId) {
      if (!this.ai || !modelSpec || !requestId) {
        return;
      }
      await this.ai.releaseReservation(modelSpec, requestId);
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
      const modelSelection = this._resolveModelSelection(data);
      return {
        translationModelList: Array.isArray(data.translationModelList) ? data.translationModelList : [],
        modelSelection
      };
    }

    _resolveModelSelection(state) {
      if (state && state.modelSelection && typeof state.modelSelection === 'object') {
        const preference = state.modelSelection.preference === 'smartest' || state.modelSelection.preference === 'cheapest'
          ? state.modelSelection.preference
          : null;
        return {
          speed: state.modelSelection.speed !== false,
          preference
        };
      }

      const legacyPolicy = state && typeof state.modelSelectionPolicy === 'string'
        ? state.modelSelectionPolicy
        : null;
      if (legacyPolicy === 'smartest') {
        return { speed: false, preference: 'smartest' };
      }
      if (legacyPolicy === 'cheapest') {
        return { speed: false, preference: 'cheapest' };
      }
      if (legacyPolicy === 'fastest') {
        return { speed: true, preference: null };
      }
      return { speed: true, preference: null };
    }

    async _handleUiCommand({ name, payload, env, port } = {}) {
      const commandName = typeof name === 'string' ? name : '';
      const commandPayload = payload && typeof payload === 'object' ? payload : {};
      if (!commandName) {
        const error = new Error('Missing command name');
        error.code = 'BAD_COMMAND';
        throw error;
      }

      if (commandName === 'LOG_EVENT') {
        const event = commandPayload && typeof commandPayload === 'object' ? commandPayload : null;
        if (event) {
          this._logEvent({ ...event, meta: { ...(event.meta || {}), source: 'ui' } });
        }
        return { logged: true };
      }

      if (commandName === 'CLEAR_EVENT_LOG') {
        await this.eventLogStore.clear();
        this.uiHub.broadcastEventReset();
        this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'Event log cleared', { source: 'ui' }));
        return { cleared: true };
      }

      if (commandName === 'LOAD_OLDER_EVENTS') {
        const beforeSeq = typeof commandPayload.beforeSeq === 'number' ? commandPayload.beforeSeq : null;
        const limit = this._clampEventPageLimit(commandPayload.limit);
        const result = beforeSeq
          ? await this.eventLogStore.getBefore(beforeSeq, limit)
          : await this.eventLogStore.getTail(limit);
        return {
          items: Array.isArray(result.items) ? result.items : [],
          seq: typeof result.seq === 'number' ? result.seq : 0,
          hasMore: beforeSeq ? Array.isArray(result.items) && result.items.length >= limit : false
        };
      }

      if (commandName === 'SETTINGS_PATCH') {
        const incomingPatch = commandPayload && typeof commandPayload.patch === 'object' ? commandPayload.patch : null;
        if (!incomingPatch) {
          const error = new Error('Invalid SETTINGS_PATCH payload');
          error.code = 'BAD_SETTINGS_PATCH';
          throw error;
        }
        const allowedKeys = ['apiKey', 'translationModelList', 'modelSelection', 'modelSelectionPolicy'];
        const patch = {};
        allowedKeys.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(incomingPatch, key)) {
            patch[key] = incomingPatch[key];
          }
        });
        if (!Object.keys(patch).length) {
          const error = new Error('SETTINGS_PATCH has no allowed keys');
          error.code = 'EMPTY_SETTINGS_PATCH';
          throw error;
        }
        await this.settingsStore.applyPatch(patch);
        this._logEvent(this.eventFactory.info('UI_SETTINGS_PATCH_APPLIED', 'Applied settings patch from UI', {
          source: 'ui',
          keys: Object.keys(patch)
        }));
        return { applied: true };
      }

      if (commandName === 'GET_API_KEY') {
        const data = await this.settingsStore.get(['apiKey']);
        return { apiKey: data && typeof data.apiKey === 'string' ? data.apiKey : '' };
      }

      if (commandName === 'BENCHMARK_SELECTED_MODELS') {
        this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.BENCH_START, 'Benchmark request received', { source: 'ui' }));
        this._loadSelectedModels()
          .then((modelSpecs) => this.ai.benchmarkSelected(modelSpecs, { force: Boolean(commandPayload.force) }))
          .catch(() => this.ai.setBenchmarkFailed('BENCHMARK_START_FAILED'));
        return { started: true };
      }

      const error = new Error(`Unknown command: ${commandName}`);
      error.code = 'UNKNOWN_UI_COMMAND';
      throw error;
    }

    _clampEventPageLimit(limit) {
      const value = Number(limit);
      if (!Number.isFinite(value)) {
        return 200;
      }
      return Math.max(50, Math.min(400, Math.floor(value)));
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
      this.settingsStore.get(['translationModelList'])
        .then((settings) => {
          const selected = Array.isArray(settings.translationModelList) ? settings.translationModelList : [];
          if (!this.ai || typeof this.ai.buildModelLimitsSnapshot !== 'function') {
            return {};
          }
          return this.ai.buildModelLimitsSnapshot({ selectedModelSpecs: selected, maxModels: 20 });
        })
        .then((modelLimitsBySpec) => {
          this.uiHub.broadcastPatch({ modelLimitsBySpec: modelLimitsBySpec || {} });
        })
        .catch(() => {});
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
