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
      this.translationMemoryStore = null;
      this.inflightStore = null;
      this.tabSessionManager = null;
      this.jobQueue = null;
      this.rateLimitBudgetStore = null;
      this.credentialsStore = null;
      this.credentialsProvider = null;
      this.securityAudit = null;
      this.loadScheduler = null;
      this.uiHub = null;
      this.eventFactory = null;
      this.ai = null;
      this.offscreenExecutor = null;
      this.translationCall = null;
      this.translationAgent = null;
      this.translationOrchestrator = null;
      this.toolManifest = null;
      this.toolPolicyResolver = null;
      this.scheduler = null;
      this.jobRunner = null;
      this._instanceId = `bg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this._activeTabId = null;
      this._securityState = {
        credentials: null,
        lastConnectionTest: null,
        lastAudit: null
      };

      this._lastLimitsBroadcastAt = 0;
      this._lastJobCompactionAt = 0;
      this._jobCompactionIntervalMs = 2 * 60 * 1000;

      this._onStorageChanged = this._onStorageChanged.bind(this);
      this._onRuntimeMessage = this._onRuntimeMessage.bind(this);
      this._handleUiCommand = this._handleUiCommand.bind(this);
      this._handleContentMessage = this._handleContentMessage.bind(this);
      this._onTabRemoved = this._onTabRemoved.bind(this);
      this._onTabUpdated = this._onTabUpdated.bind(this);
      this._onTabActivated = this._onTabActivated.bind(this);
      this._onRuntimeInstalled = this._onRuntimeInstalled.bind(this);
      this._onRuntimeStartup = this._onRuntimeStartup.bind(this);
      this._onAlarm = this._onAlarm.bind(this);
    }

    async start() {
      this._initServices();
      await this.eventLogStore.load();
      await this._preloadState();
      await this._refreshActiveTabId().catch(() => null);
      if (this.translationMemoryStore && typeof this.translationMemoryStore.init === 'function') {
        await this.translationMemoryStore.init().catch(() => ({ ok: false }));
        await this._maybeRunTranslationMemoryGc().catch(() => ({ ok: false }));
      }
      await this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
      await this._sweepInflight().catch(() => {});
      if (this.translationOrchestrator && typeof this.translationOrchestrator.restoreStateAfterRestart === 'function') {
        await this.translationOrchestrator.restoreStateAfterRestart();
      }
      await this._warmupOffscreenCapabilities().catch(() => {});
      await this._recoverOffscreenInflightAfterRestart().catch(() => ({ ok: false }));
      await this._refreshSecurityState().catch(() => {});
      await this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
      this._attachListeners();
      if (this.scheduler && typeof this.scheduler.ensureAlarms === 'function') {
        await this.scheduler.ensureAlarms().catch(() => ({ ok: false }));
      }
      if (this.scheduler && typeof this.scheduler.tick === 'function') {
        await this.scheduler.tick('startup').catch(() => ({ ok: false }));
      }
      this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.BG_START, 'Фоновый сервис запущен', { source: 'background' }));
    }

    _initServices() {
      this.eventLogStore = new NT.EventLogStore({ chromeApi: this.chromeApi, limit: 800 });
      this.eventFactory = new NT.EventFactory({ time: NT.Time, source: 'bg' });
      this.settingsStore = new NT.SettingsStore({
        chromeApi: this.chromeApi,
        defaults: {
          settingsSchemaVersion: NT.AgentSettingsPolicy && NT.AgentSettingsPolicy.SCHEMA_VERSION
            ? NT.AgentSettingsPolicy.SCHEMA_VERSION
            : 2,
          translationAgentSettingsV2: NT.AgentSettingsPolicy && NT.AgentSettingsPolicy.DEFAULT_USER_SETTINGS
            ? JSON.parse(JSON.stringify(NT.AgentSettingsPolicy.DEFAULT_USER_SETTINGS))
            : null,
          translationModelList: [],
          modelSelection: null,
          modelSelectionPolicy: null,
          modelBenchmarkStatus: null,
          translationPipelineEnabled: false,
          translationAgentModelPolicy: null,
          translationAgentProfile: 'auto',
          translationAgentTools: {},
          translationAgentTuning: {},
          translationAgentExecutionMode: 'agent',
          translationAgentAllowedModels: [],
          translationMemoryEnabled: true,
          translationMemoryMaxPages: 200,
          translationMemoryMaxBlocks: 5000,
          translationMemoryMaxAgeDays: 30,
          translationMemoryGcOnStartup: true,
          translationMemoryIgnoredQueryParams: ['utm_*', 'fbclid', 'gclid'],
          translationCategoryMode: 'auto',
          translationCategoryList: [],
          translationPageCacheEnabled: true,
          translationApiCacheEnabled: true,
          translationCompareDiffThreshold: 8000,
          translationPopupActiveTab: 'control'
        }
      });
      this.tabStateStore = new NT.TabStateStore({ chromeApi: this.chromeApi });
      this.translationJobStore = new NT.TranslationJobStore({ chromeApi: this.chromeApi });
      this.pageCacheStore = new NT.TranslationPageCacheStore({ chromeApi: this.chromeApi });
      this.translationMemoryStore = new NT.TranslationMemoryStore({ chromeApi: this.chromeApi });
      this.inflightStore = new NT.InflightRequestStore({ chromeApi: this.chromeApi });
      this.tabSessionManager = NT.TabSessionManager
        ? new NT.TabSessionManager({
          chromeApi: this.chromeApi,
          jobStore: this.translationJobStore,
          tabStateStore: this.tabStateStore,
          normalizeUrlFn: (value) => {
            const UrlNormalizer = NT.UrlNormalizer || null;
            return UrlNormalizer && typeof UrlNormalizer.normalizeUrl === 'function'
              ? UrlNormalizer.normalizeUrl(value || '')
              : String(value || '').trim();
          }
        })
        : null;
      this.jobQueue = NT.JobQueue
        ? new NT.JobQueue({ chromeApi: this.chromeApi })
        : null;
      this.rateLimitBudgetStore = NT.RateLimitBudgetStore
        ? new NT.RateLimitBudgetStore({ chromeApi: this.chromeApi })
        : null;
      this.credentialsStore = NT.CredentialsStore
        ? new NT.CredentialsStore({ chromeApi: this.chromeApi })
        : null;
      this.credentialsProvider = NT.CredentialsProvider
        ? new NT.CredentialsProvider({ credentialsStore: this.credentialsStore })
        : null;

      const RuntimePaths = NT.RuntimePaths || null;
      const offscreenPath = RuntimePaths && typeof RuntimePaths.withPrefix === 'function'
        ? RuntimePaths.withPrefix(this.chromeApi, 'offscreen/offscreen.html')
        : 'offscreen/offscreen.html';

      this.offscreenExecutor = new NT.OffscreenExecutor({
        chromeApi: this.chromeApi,
        offscreenPath,
        inflightStore: this.inflightStore,
        maxConcurrentRequests: 1,
        activeTabIdProvider: () => this._activeTabId,
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
        offscreenExecutor: this.offscreenExecutor,
        credentialsProvider: this.credentialsProvider
      }).init();

      this.translationCall = new NT.TranslationCall({
        runLlmRequest: (args) => this._runLlmRequest(args)
      });

      this.translationAgent = new NT.TranslationAgent({
        runLlmRequest: (args) => this._runLlmRequest(args),
        eventFactory: this.eventFactory,
        eventLogFn: (event) => this._logEvent(event),
        persistJobState: async (job) => {
          if (!this.translationJobStore || !job || !job.id) {
            return;
          }
          await this.translationJobStore.upsertJob(job);
          if (!this.tabStateStore || job.tabId === null || job.tabId === undefined) {
            return;
          }
          const agentState = this.translationAgent && typeof this.translationAgent.toUiSnapshot === 'function'
            ? this.translationAgent.toUiSnapshot(job.agentState || null)
            : (job.agentState || null);
          await this.tabStateStore.upsertStatusPatch(job.tabId, {
            status: job.status || 'preparing',
            message: job.message || 'Планирование...',
            translationJobId: job.id,
            agentState,
            updatedAt: Date.now()
          });
        }
      });

      this.toolManifest = NT.ToolManifest
        ? new NT.ToolManifest({
          toolsetSemver: '1.0.0'
        })
        : null;
      this.toolPolicyResolver = NT.ToolPolicyResolver
        ? new NT.ToolPolicyResolver({
          toolManifest: this.toolManifest
        })
        : null;
      this.securityAudit = NT.SecurityAudit
        ? new NT.SecurityAudit({
          chromeApi: this.chromeApi,
          credentialsStore: this.credentialsStore,
          toolManifest: this.toolManifest
        })
        : null;

      this.translationOrchestrator = new NT.TranslationOrchestrator({
        chromeApi: this.chromeApi,
        settingsStore: this.settingsStore,
        tabStateStore: this.tabStateStore,
        jobStore: this.translationJobStore,
        pageCacheStore: this.pageCacheStore,
        translationMemoryStore: this.translationMemoryStore,
        toolManifest: this.toolManifest,
        toolPolicyResolver: this.toolPolicyResolver,
        capabilitiesProvider: ({ tabId }) => this._buildCapabilitiesForTab(tabId),
        translationCall: this.translationCall,
        translationAgent: this.translationAgent,
        eventFactory: this.eventFactory,
        eventLogFn: (event) => this._logEvent(event),
        onUiPatch: (patch) => {
          if (this.uiHub) {
            this.uiHub.broadcastPatch(patch);
          }
        },
        onCapabilitiesChanged: () => {
          this._broadcastRuntimeToolingPatch().catch(() => {});
        }
      });

      this.uiHub = new NT.UiPortHub({
        settingsStore: this.settingsStore,
        tabStateStore: this.tabStateStore,
        translationJobStore: this.translationJobStore,
        eventLogStore: this.eventLogStore,
        aiModule: this.ai,
        runtimeSnapshotProvider: ({ tabId, portName, uiCaps, toolsetWanted }) => this._buildUiRuntimeSnapshot({
          tabId,
          portName,
          uiCaps,
          toolsetWanted
        }),
        onHello: () => {
          this._broadcastRuntimeToolingPatch().catch(() => {});
        },
        onCommand: ({ port, envelope }) => {
          this._handleUiCommand(envelope, { port }).catch((error) => {
            this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'Команда UI завершилась ошибкой', {
              source: 'ui',
              message: error && error.message ? error.message : 'неизвестно'
            }));
          });
        },
        onEvent: (event) => this._logEvent(event)
      });

      this.jobRunner = NT.JobRunner
        ? new NT.JobRunner({
          chromeApi: this.chromeApi,
          jobStore: this.translationJobStore,
          translationOrchestrator: this.translationOrchestrator,
          offscreenExecutor: this.offscreenExecutor,
          retryPolicy: NT.RetryPolicy || null,
          ownerInstanceId: this._instanceId
        })
        : null;

      this.scheduler = NT.Scheduler
        ? new NT.Scheduler({
          chromeApi: this.chromeApi,
          jobStore: this.translationJobStore,
          jobQueue: this.jobQueue,
          jobRunner: this.jobRunner,
          activeTabIdProvider: () => this._activeTabId,
          onBeforeTick: async () => this._sweepInflight(),
          onAfterTick: async ({ elapsedMs, processed, pendingWork, reason }) => {
            await this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
            this._logEvent(this.eventFactory.info(
              NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.BG_START : 'bg.start',
              'Scheduler tick завершён',
              {
                reason,
                elapsedMs,
                processed,
                pendingWork
              }
            ));
            this._broadcastRuntimeToolingPatch().catch(() => {});
          },
          eventFactory: this.eventFactory,
          eventLogFn: (event) => this._logEvent(event),
          maxJobsPerTick: 3,
          maxMsPerTick: 1500
        })
        : null;
    }

    async _preloadState() {
      if (this.settingsStore && typeof this.settingsStore.ensureMigrated === 'function') {
        await this.settingsStore.ensureMigrated().catch(() => ({}));
      }
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
        'translationAgentExecutionMode',
        'translationAgentAllowedModels',
        'translationMemoryEnabled',
        'translationMemoryMaxPages',
        'translationMemoryMaxBlocks',
        'translationMemoryMaxAgeDays',
        'translationMemoryGcOnStartup',
        'translationMemoryIgnoredQueryParams',
        'translationCategoryMode',
        'translationCategoryList',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationCompareDiffThreshold',
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
      if (!Object.prototype.hasOwnProperty.call(state, 'translationAgentExecutionMode')) {
        await this.settingsStore.set({ translationAgentExecutionMode: 'agent' });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationAgentAllowedModels')) {
        await this.settingsStore.set({ translationAgentAllowedModels: [] });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationMemoryEnabled')) {
        await this.settingsStore.set({ translationMemoryEnabled: true });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationMemoryMaxPages')) {
        await this.settingsStore.set({ translationMemoryMaxPages: 200 });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationMemoryMaxBlocks')) {
        await this.settingsStore.set({ translationMemoryMaxBlocks: 5000 });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationMemoryMaxAgeDays')) {
        await this.settingsStore.set({ translationMemoryMaxAgeDays: 30 });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationMemoryGcOnStartup')) {
        await this.settingsStore.set({ translationMemoryGcOnStartup: true });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationMemoryIgnoredQueryParams')) {
        await this.settingsStore.set({ translationMemoryIgnoredQueryParams: ['utm_*', 'fbclid', 'gclid'] });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationCategoryMode')) {
        await this.settingsStore.set({ translationCategoryMode: 'auto' });
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
      if (!Object.prototype.hasOwnProperty.call(state, 'translationCompareDiffThreshold')) {
        await this.settingsStore.set({ translationCompareDiffThreshold: 8000 });
      }
      if (!Object.prototype.hasOwnProperty.call(state, 'translationPopupActiveTab')) {
        await this.settingsStore.set({ translationPopupActiveTab: 'control' });
      }
    }

    async _maybeRunTranslationMemoryGc() {
      if (!this.settingsStore || !this.translationMemoryStore || typeof this.translationMemoryStore.runGc !== 'function') {
        return { ok: false, code: 'MEMORY_GC_UNAVAILABLE' };
      }
      const state = await this.settingsStore.get([
        'translationMemoryEnabled',
        'translationMemoryGcOnStartup',
        'translationMemoryMaxPages',
        'translationMemoryMaxBlocks',
        'translationMemoryMaxAgeDays'
      ]);
      if (state.translationMemoryEnabled === false || state.translationMemoryGcOnStartup === false) {
        return { ok: true, skipped: true };
      }
      return this.translationMemoryStore.runGc({
        maxPages: Number.isFinite(Number(state.translationMemoryMaxPages))
          ? Number(state.translationMemoryMaxPages)
          : 200,
        maxBlocks: Number.isFinite(Number(state.translationMemoryMaxBlocks))
          ? Number(state.translationMemoryMaxBlocks)
          : 5000,
        maxAgeDays: Number.isFinite(Number(state.translationMemoryMaxAgeDays))
          ? Number(state.translationMemoryMaxAgeDays)
          : 30
      });
    }

    async _refreshActiveTabId({ tabIdHint = null } = {}) {
      let activeTabId = Number.isFinite(Number(tabIdHint)) ? Number(tabIdHint) : null;
      if (!Number.isFinite(Number(activeTabId)) && this.chromeApi && this.chromeApi.tabs && typeof this.chromeApi.tabs.query === 'function') {
        activeTabId = await new Promise((resolve) => {
          try {
            this.chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              const first = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
              resolve(first && Number.isFinite(Number(first.id)) ? Number(first.id) : null);
            });
          } catch (_) {
            resolve(null);
          }
        });
      }
      this._activeTabId = Number.isFinite(Number(activeTabId)) ? Number(activeTabId) : null;
      if (this.tabSessionManager && typeof this.tabSessionManager.setActiveTab === 'function') {
        await this.tabSessionManager.setActiveTab(this._activeTabId).catch(() => null);
      }
      if (this.jobQueue && typeof this.jobQueue.setActiveTab === 'function') {
        await this.jobQueue.setActiveTab(this._activeTabId).catch(() => null);
      }
      return this._activeTabId;
    }

    async _hydrateRuntimeSchedulers() {
      const activeJobs = this.translationJobStore && typeof this.translationJobStore.listActiveJobs === 'function'
        ? await this.translationJobStore.listActiveJobs().catch(() => [])
        : [];
      if (this.tabSessionManager && typeof this.tabSessionManager.hydrateFromStores === 'function') {
        await this.tabSessionManager.hydrateFromStores().catch(() => []);
      }
      if (this.jobQueue && typeof this.jobQueue.syncFromJobs === 'function') {
        await this.jobQueue.syncFromJobs(activeJobs, {
          activeTabId: this._activeTabId
        }).catch(() => null);
      }
      const now = Date.now();
      if (
        this.translationJobStore
        && typeof this.translationJobStore.compactInactiveJobs === 'function'
        && (now - this._lastJobCompactionAt) >= this._jobCompactionIntervalMs
      ) {
        this._lastJobCompactionAt = now;
        await this.translationJobStore.compactInactiveJobs({
          traceLimit: 140,
          patchLimit: 220,
          diffLimit: 20
        }).catch(() => ({ ok: false }));
      }
      return {
        ok: true,
        activeJobsCount: Array.isArray(activeJobs) ? activeJobs.length : 0
      };
    }

    _buildCapabilitiesForTab(tabId) {
      const contentCapsByTab = this.translationOrchestrator && typeof this.translationOrchestrator.getContentCapabilitiesSnapshot === 'function'
        ? this.translationOrchestrator.getContentCapabilitiesSnapshot()
        : {};
      const numericTabId = Number(tabId);
      const content = Number.isFinite(numericTabId)
        ? (contentCapsByTab[String(numericTabId)] || null)
        : null;
      const offscreen = this.offscreenExecutor && typeof this.offscreenExecutor.getOffscreenCaps === 'function'
        ? this.offscreenExecutor.getOffscreenCaps()
        : null;
      const offscreenState = this.offscreenExecutor && typeof this.offscreenExecutor.getOffscreenState === 'function'
        ? this.offscreenExecutor.getOffscreenState()
        : null;
      const ui = this.uiHub && typeof this.uiHub.getUiCapsSnapshot === 'function'
        ? this.uiHub.getUiCapsSnapshot()
        : {};
      return {
        bg: {
          toolsetVersion: this.toolManifest && this.toolManifest.version ? this.toolManifest.version : 'toolset/v1',
          supportsToolExecutionEngine: Boolean(NT.ToolExecutionEngine),
          supportsToolPolicyResolver: Boolean(this.toolPolicyResolver),
          supportsPreviousResponseRecovery: true,
          activeTabId: Number.isFinite(Number(this._activeTabId)) ? Number(this._activeTabId) : null
        },
        content,
        contentCapsByTab,
        offscreen: {
          ...(offscreen && typeof offscreen === 'object' ? offscreen : {}),
          ...(offscreenState && typeof offscreenState === 'object' ? offscreenState : {})
        },
        ui
      };
    }

    _safeClone(value, fallback = null) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }

    _buildSecurityRuntimeSnapshot() {
      const src = this._securityState && typeof this._securityState === 'object'
        ? this._securityState
        : {};
      return {
        credentials: src.credentials && typeof src.credentials === 'object'
          ? this._safeClone(src.credentials, {})
          : null,
        lastConnectionTest: src.lastConnectionTest && typeof src.lastConnectionTest === 'object'
          ? this._safeClone(src.lastConnectionTest, {})
          : null,
        lastAudit: src.lastAudit && typeof src.lastAudit === 'object'
          ? this._safeClone(src.lastAudit, {})
          : null
      };
    }

    async _refreshSecurityState() {
      if (this.credentialsStore && typeof this.credentialsStore.getPublicSnapshot === 'function') {
        this._securityState.credentials = await this.credentialsStore.getPublicSnapshot().catch(() => null);
      }
      return this._buildSecurityRuntimeSnapshot();
    }

    async _broadcastSecurityPatch() {
      await this._refreshSecurityState().catch(() => ({}));
      if (!this.uiHub || typeof this.uiHub.broadcastPatch !== 'function') {
        return;
      }
      this.uiHub.broadcastPatch({
        security: this._buildSecurityRuntimeSnapshot()
      });
    }

    async _buildUiRuntimeSnapshot({ tabId = null, portName = null, uiCaps = null, toolsetWanted = null } = {}) {
      const toolset = this.toolManifest && typeof this.toolManifest.getPublicSummary === 'function'
        ? this.toolManifest.getPublicSummary()
        : null;
      await this._refreshSecurityState().catch(() => ({}));
      const caps = this._buildCapabilitiesForTab(tabId);
      const settings = this.settingsStore && typeof this.settingsStore.getPublicSnapshot === 'function'
        ? await this.settingsStore.getPublicSnapshot().catch(() => ({}))
        : {};
      const effectiveSettings = settings && settings.effectiveSettings && typeof settings.effectiveSettings === 'object'
        ? settings.effectiveSettings
        : {};
      const profileDefaults = effectiveSettings.agent && typeof effectiveSettings.agent.toolConfigDefault === 'object'
        ? effectiveSettings.agent.toolConfigDefault
        : {};
      const userOverrides = effectiveSettings.agent && typeof effectiveSettings.agent.toolConfigUser === 'object'
        ? effectiveSettings.agent.toolConfigUser
        : {};
      let agentProposal = null;
      let policyStage = null;
      if (Number.isFinite(Number(tabId)) && this.translationJobStore && typeof this.translationJobStore.getActiveJob === 'function') {
        const activeJob = await this.translationJobStore.getActiveJob(Number(tabId)).catch(() => null);
        if (activeJob && activeJob.agentState && activeJob.agentState.toolPolicyProposal && typeof activeJob.agentState.toolPolicyProposal === 'object') {
          agentProposal = activeJob.agentState.toolPolicyProposal;
        }
        policyStage = this._resolveToolPolicyStage(activeJob);
      }
      const resolvedPolicy = this.toolPolicyResolver && typeof this.toolPolicyResolver.resolve === 'function'
        ? this.toolPolicyResolver.resolve({
          profileDefaults,
          userOverrides,
          agentProposal,
          stage: policyStage,
          capabilities: {
            content: caps.content,
            offscreen: caps.offscreen,
            ui: caps.ui
          }
        })
        : {
          effective: {},
          reasons: {},
          capabilitiesSummary: {
            content: caps.content || null,
            offscreen: caps.offscreen || null,
            ui: caps.ui || null
          }
        };
      const wanted = toolsetWanted && typeof toolsetWanted === 'object' ? toolsetWanted : {};
      const wantedHash = typeof wanted.toolsetHash === 'string' && wanted.toolsetHash ? wanted.toolsetHash : null;
      const wantedId = typeof wanted.toolsetId === 'string' && wanted.toolsetId ? wanted.toolsetId : null;
      const wantedMinSemver = typeof wanted.minSemver === 'string' && wanted.minSemver ? wanted.minSemver : null;
      const hashMatches = !wantedHash || !toolset || !toolset.toolsetHash
        ? true
        : wantedHash === toolset.toolsetHash;
      const idMatches = !wantedId || !toolset || !toolset.toolsetId
        ? true
        : wantedId === toolset.toolsetId;
      const semverOk = !wantedMinSemver || !toolset || !toolset.toolsetSemver
        ? true
        : this._isSemverGte(toolset.toolsetSemver, wantedMinSemver);
      const tabSessions = this.tabSessionManager && typeof this.tabSessionManager.listSessions === 'function'
        ? await this.tabSessionManager.listSessions().catch(() => [])
        : [];
      const queueStats = this.jobQueue && typeof this.jobQueue.stats === 'function'
        ? await this.jobQueue.stats().catch(() => null)
        : null;
      const budgetSnapshot = this.rateLimitBudgetStore && typeof this.rateLimitBudgetStore.getBudgetSnapshot === 'function'
        ? await this.rateLimitBudgetStore.getBudgetSnapshot({ provider: 'openai' }).catch(() => null)
        : null;
      const activeJobs = this.translationJobStore && typeof this.translationJobStore.listActiveJobs === 'function'
        ? await this.translationJobStore.listActiveJobs().catch(() => [])
        : [];
      const activeJobsSummary = Array.isArray(activeJobs)
        ? activeJobs
          .map((job) => ({
            id: job && job.id ? job.id : null,
            tabId: Number.isFinite(Number(job && job.tabId)) ? Number(job.tabId) : null,
            status: job && job.status ? String(job.status) : null,
            stage: job && job.runtime && job.runtime.stage ? String(job.runtime.stage) : null,
            progress: Number.isFinite(Number(job && job.totalBlocks))
              && Number(job.totalBlocks) > 0
              ? Math.max(0, Math.min(100, Math.round((Number(job.completedBlocks || 0) / Number(job.totalBlocks)) * 100)))
              : (job && job.status === 'done' ? 100 : 0),
            leaseUntilTs: Number.isFinite(Number(job && job.leaseUntilTs)) ? Number(job.leaseUntilTs) : null,
            nextRetryAtTs: job && job.runtime && job.runtime.retry && Number.isFinite(Number(job.runtime.retry.nextRetryAtTs))
              ? Number(job.runtime.retry.nextRetryAtTs)
              : null,
            lastErrorCode: job && job.runtime && job.runtime.retry && job.runtime.retry.lastError && job.runtime.retry.lastError.code
              ? String(job.runtime.retry.lastError.code)
              : (job && job.lastError && job.lastError.code ? String(job.lastError.code) : null)
          }))
          .filter((job) => Boolean(job.id))
          : [];
      return {
        toolset,
        effectiveToolPolicy: resolvedPolicy.effective || {},
        effectiveToolPolicyReasons: resolvedPolicy.reasons || {},
        security: this._buildSecurityRuntimeSnapshot(),
        negotiation: {
          client: {
            portName: portName || null,
            uiCaps: uiCaps && typeof uiCaps === 'object' ? uiCaps : null,
            toolsetWanted: wanted
          },
          result: {
            hashMatches,
            idMatches,
            semverOk,
            action: (hashMatches && idMatches && semverOk)
              ? 'accepted'
              : 'accept_snapshot_and_refresh_local_cache'
          }
        },
        serverCaps: {
          bg: caps.bg || {},
          contentCapsByTab: caps.contentCapsByTab || {},
          offscreen: caps.offscreen || null,
          offscreenCaps: caps.offscreen || null,
          uiCapsByPort: caps.ui || {},
          capabilitiesSummary: resolvedPolicy.capabilitiesSummary || null,
          schedulerRuntime: {
            activeTabId: Number.isFinite(Number(this._activeTabId)) ? Number(this._activeTabId) : null,
            tabSessions: Array.isArray(tabSessions) ? tabSessions : [],
            queueStats: queueStats && typeof queueStats === 'object' ? queueStats : null,
            budget: budgetSnapshot && typeof budgetSnapshot === 'object' ? budgetSnapshot : null,
            activeJobs: activeJobsSummary
          }
        }
      };
    }

    async _broadcastRuntimeToolingPatch() {
      if (!this.uiHub || typeof this.uiHub.broadcastPatch !== 'function') {
        return;
      }
      const runtime = await this._buildUiRuntimeSnapshot({ tabId: null }).catch(() => null);
      if (!runtime) {
        return;
      }
      this.uiHub.broadcastPatch({
        toolset: runtime.toolset || null,
        effectiveToolPolicy: runtime.effectiveToolPolicy || {},
        effectiveToolPolicyReasons: runtime.effectiveToolPolicyReasons || {},
        security: runtime.security || null,
        negotiation: runtime.negotiation || null,
        serverCaps: runtime.serverCaps || null
      });
    }

    _attachListeners() {
      this.uiHub.attachToRuntime();
      if (this.chromeApi && this.chromeApi.runtime && this.chromeApi.runtime.onMessage) {
        this.chromeApi.runtime.onMessage.addListener(this._onRuntimeMessage);
      }
      if (this.chromeApi && this.chromeApi.runtime && this.chromeApi.runtime.onInstalled) {
        this.chromeApi.runtime.onInstalled.addListener(this._onRuntimeInstalled);
      }
      if (this.chromeApi && this.chromeApi.runtime && this.chromeApi.runtime.onStartup) {
        this.chromeApi.runtime.onStartup.addListener(this._onRuntimeStartup);
      }
      if (this.chromeApi && this.chromeApi.alarms && this.chromeApi.alarms.onAlarm) {
        this.chromeApi.alarms.onAlarm.addListener(this._onAlarm);
      }
      if (this.chromeApi && this.chromeApi.storage && this.chromeApi.storage.onChanged) {
        this.chromeApi.storage.onChanged.addListener(this._onStorageChanged);
      }
      if (this.chromeApi && this.chromeApi.tabs && this.chromeApi.tabs.onRemoved) {
        this.chromeApi.tabs.onRemoved.addListener(this._onTabRemoved);
      }
      if (this.chromeApi && this.chromeApi.tabs && this.chromeApi.tabs.onUpdated) {
        this.chromeApi.tabs.onUpdated.addListener(this._onTabUpdated);
      }
      if (this.chromeApi && this.chromeApi.tabs && this.chromeApi.tabs.onActivated) {
        this.chromeApi.tabs.onActivated.addListener(this._onTabActivated);
      }
    }

    async _onRuntimeInstalled() {
      await this._refreshActiveTabId().catch(() => null);
      await this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
      if (this.scheduler && typeof this.scheduler.ensureAlarms === 'function') {
        await this.scheduler.ensureAlarms().catch(() => ({ ok: false }));
      }
      if (this.scheduler && typeof this.scheduler.kickNow === 'function') {
        await this.scheduler.kickNow({ reason: 'runtime.onInstalled' }).catch(() => ({ ok: false }));
      }
      this._broadcastRuntimeToolingPatch().catch(() => {});
    }

    async _onRuntimeStartup() {
      await this._refreshActiveTabId().catch(() => null);
      await this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
      if (this.scheduler && typeof this.scheduler.ensureAlarms === 'function') {
        await this.scheduler.ensureAlarms().catch(() => ({ ok: false }));
      }
      if (this.scheduler && typeof this.scheduler.kickNow === 'function') {
        await this.scheduler.kickNow({ reason: 'runtime.onStartup' }).catch(() => ({ ok: false }));
      }
      this._broadcastRuntimeToolingPatch().catch(() => {});
    }

    async _onAlarm(alarm) {
      if (!this.scheduler || typeof this.scheduler.onAlarm !== 'function') {
        return;
      }
      await this.scheduler.onAlarm(alarm).catch((error) => {
        this._logEvent(this.eventFactory.warn(
          NT.EventTypes.Tags.BG_ERROR,
          'Ошибка alarm scheduler',
          { message: error && error.message ? error.message : 'неизвестно' }
        ));
      });
    }

    _kickScheduler(reason) {
      if (!this.scheduler || typeof this.scheduler.kickNow !== 'function') {
        return;
      }
      this.scheduler.kickNow({ reason: reason || 'job_changed' }).catch(() => ({ ok: false }));
      this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
    }

    async _sweepInflight() {
      if (this.inflightStore && typeof this.inflightStore.sweep === 'function') {
        await this.inflightStore.sweep({ maxAgeMs: 24 * 60 * 60 * 1000 }).catch(() => ({ ok: false, removed: 0 }));
      }
      if (this.offscreenExecutor && typeof this.offscreenExecutor.adoptPending === 'function') {
        await this.offscreenExecutor.adoptPending({ limit: 80 }).catch(() => ({ ok: false, adopted: 0 }));
      }
      const now = Date.now();
      const expiredRows = await this.inflightStore.listExpired(now);
      for (const row of expiredRows) {
        let adopted = false;
        try {
          const cached = await this._getOffscreenCachedResult(row.requestId);
          if (cached) {
            await this._applyAdoptedResult(row, cached);
            if (this.inflightStore && typeof this.inflightStore.markDone === 'function') {
              await this.inflightStore.markDone(row.requestId, {
                rawJson: cached && cached.json ? cached.json : null,
                rawResult: cached,
                requestKey: row && row.requestKey ? row.requestKey : null,
                payloadHash: row && row.payloadHash ? row.payloadHash : null
              });
            }
            adopted = true;
          } else {
            await this._releaseReservation(row.modelSpec, row.requestId);
            if (this.inflightStore && typeof this.inflightStore.markFailed === 'function') {
              await this.inflightStore.markFailed(row.requestId, {
                requestKey: row && row.requestKey ? row.requestKey : null,
                payloadHash: row && row.payloadHash ? row.payloadHash : null,
                error: {
                  code: 'LEASE_EXPIRED',
                  message: 'inflight lease expired without cached result'
                }
              });
            }
            this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.BG_ERROR, 'Lease inflight истёк без кэшированного результата', {
              requestId: row.requestId,
              tabId: row.tabId,
              jobId: row.jobId || null,
              blockId: row.blockId || null
            }));
          }
        } catch (error) {
          if (this.inflightStore && typeof this.inflightStore.markFailed === 'function') {
            await this.inflightStore.markFailed(row.requestId, {
              requestKey: row && row.requestKey ? row.requestKey : null,
              payloadHash: row && row.payloadHash ? row.payloadHash : null,
              error: {
                code: 'ADOPT_FAILED',
                message: error && error.message ? error.message : 'adoption failed'
              }
            });
          }
          this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.BG_ERROR, 'Ошибка усыновления inflight-результата', {
            requestId: row.requestId,
            message: error && error.message ? error.message : 'неизвестно'
          }));
        } finally {
          if (!adopted && row && row.requestId && this.inflightStore && typeof this.inflightStore.upsert === 'function') {
            await this.inflightStore.upsert(row.requestId, {
              updatedAt: Date.now(),
              leaseUntilTs: null
            });
          }
        }
      }
    }

    async _warmupOffscreenCapabilities() {
      if (!this.offscreenExecutor || !this.offscreenExecutor.offscreenManager || typeof this.offscreenExecutor.offscreenManager.ensureReady !== 'function') {
        return { ok: false, skipped: true };
      }
      const ready = await this.offscreenExecutor.offscreenManager.ensureReady({
        helloPayload: {
          clientVersion: 'bg-capability-warmup'
        }
      }).catch(() => false);
      if (!ready) {
        return { ok: false };
      }
      if (this.uiHub && typeof this._broadcastRuntimeToolingPatch === 'function') {
        await this._broadcastRuntimeToolingPatch().catch(() => {});
      }
      return { ok: true };
    }

    async _recoverOffscreenInflightAfterRestart() {
      if (!this.offscreenExecutor || typeof this.offscreenExecutor.recoverInflightRequests !== 'function') {
        return { ok: false, skipped: true };
      }
      const out = await this.offscreenExecutor.recoverInflightRequests({ limit: 120 }).catch(() => ({ ok: false }));
      if (out && out.ok) {
        this._logEvent(this.eventFactory.info(
          NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume',
          'Offscreen inflight recovery выполнен',
          {
            activeInOffscreen: Number(out.activeInOffscreen || 0),
            attached: Number(out.attached || 0),
            adoptedDone: Number(out.adoptedDone || 0),
            markedLost: Number(out.markedLost || 0)
          }
        ));
      }
      return out;
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

      this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.AI_RESPONSE, result.ok ? 'Подхвачен кэшированный offscreen-результат' : 'Подхвачена кэшированная offscreen-ошибка', {
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

    _resolveSharedBudgetProvider() {
      return 'openai';
    }

    _extractRetryAfterMs(headersLike) {
      const headers = this._headersToObject(headersLike);
      const rawMs = headers['retry-after-ms'];
      if (rawMs !== undefined && rawMs !== null && rawMs !== '') {
        const value = Number(rawMs);
        if (Number.isFinite(value)) {
          return Math.max(0, Math.round(value));
        }
      }
      const rawSec = headers['retry-after'];
      if (rawSec === undefined || rawSec === null || rawSec === '') {
        return null;
      }
      const seconds = Number(rawSec);
      if (Number.isFinite(seconds)) {
        return Math.max(0, Math.round(seconds * 1000));
      }
      return null;
    }

    async _markJobWaitingForBudget({ jobId, waitMs, reasonCode } = {}) {
      if (!jobId || !this.translationJobStore || typeof this.translationJobStore.getJob !== 'function') {
        return;
      }
      const job = await this.translationJobStore.getJob(jobId).catch(() => null);
      if (!job || !job.id) {
        return;
      }
      const status = String(job.status || '').toLowerCase();
      if (status === 'done' || status === 'failed' || status === 'cancelled') {
        return;
      }
      const now = Date.now();
      const wait = Math.max(250, Math.min(Number.isFinite(Number(waitMs)) ? Number(waitMs) : 30 * 1000, 15 * 60 * 1000));
      const runtime = this.translationOrchestrator && typeof this.translationOrchestrator._ensureJobRuntime === 'function'
        ? this.translationOrchestrator._ensureJobRuntime(job, { now })
        : (job.runtime && typeof job.runtime === 'object' ? job.runtime : {});
      runtime.status = 'QUEUED';
      runtime.retry = runtime.retry && typeof runtime.retry === 'object' ? runtime.retry : {};
      runtime.retry.nextRetryAtTs = now + wait;
      runtime.retry.lastError = {
        code: reasonCode || 'RATE_LIMIT_BUDGET_WAIT',
        message: `Ожидание общего rate-limit бюджета ${Math.ceil(wait / 1000)}с`
      };
      runtime.lease = runtime.lease && typeof runtime.lease === 'object' ? runtime.lease : {};
      runtime.lease.leaseUntilTs = null;
      runtime.lease.heartbeatTs = now;
      runtime.lease.op = 'rate_limit_wait';
      runtime.lease.opId = job.id;
      job.runtime = runtime;
      if (status === 'running' || status === 'completing') {
        job.status = 'preparing';
      }
      job.message = `Ожидаю общий лимит запросов (${Math.ceil(wait / 1000)}с)`;
      job.updatedAt = now;

      if (this.translationOrchestrator && typeof this.translationOrchestrator._saveJob === 'function') {
        await this.translationOrchestrator._saveJob(job, { setActive: true }).catch(() => null);
      } else {
        await this.translationJobStore.upsertJob(job).catch(() => null);
      }
    }

    _buildDeterministicRequestMeta({ tabId, taskType, request }) {
      const src = request && typeof request === 'object' ? request : {};
      const attempt = Number.isFinite(Number(src.attempt)) ? Number(src.attempt) : 1;
      const jobId = src.jobId || `tab${tabId === null || tabId === undefined ? 'na' : String(tabId)}`;
      const blockId = src.blockId || src.blockIndex || 'block0';
      const safeTask = taskType || 'unknown';
      const requestId = src.requestId || `${jobId}:${blockId}:${attempt}:${safeTask}`;
      const stage = typeof src.stage === 'string' && src.stage
        ? src.stage
        : (safeTask.includes('planning') ? 'planning' : 'execution');
      return {
        requestId,
        jobId,
        blockId,
        tabId: Number.isFinite(Number(tabId)) ? Number(tabId) : null,
        attempt,
        stage,
        timeoutMs: Number.isFinite(Number(src.timeoutMs)) ? Number(src.timeoutMs) : 90000
      };
    }

    async _runLlmRequest({ tabId, taskType, request }) {
      const settings = await this._readLlmSettings();
      const safeRequest = request && typeof request === 'object' ? request : {};
      const requestResponsesOptions = this._pickResponsesOptions(safeRequest);
      const settingsResponsesOptions = this._buildResponsesOptionsFromSettings({
        settings,
        taskType,
        request: safeRequest
      });
      const responsesOptions = this._mergeResponsesOptions(settingsResponsesOptions, requestResponsesOptions);
      const requestMeta = this._buildDeterministicRequestMeta({ tabId, taskType, request: safeRequest });
      const selectedModelSpecs = this._resolveSelectedModelSpecs({
        settingsModelList: settings.translationModelList,
        requestedAllowed: safeRequest.allowedModelSpecs || safeRequest.allowedModels || null
      });
      if (responsesOptions.reasoning && !this._supportsReasoningForSelection(selectedModelSpecs)) {
        delete responsesOptions.reasoning;
        await this._appendAgentWarningReport({
          jobId: requestMeta.jobId || null,
          title: 'Reasoning не применён',
          body: 'Текущая модель/allowlist не поддерживает reasoning-параметры; запрос выполнен без reasoning.',
          meta: {
            code: 'REASONING_NOT_SUPPORTED',
            selectedModelSpecs: selectedModelSpecs.slice(0, 6)
          }
        }).catch(() => {});
      }
      const requestKey = `${requestMeta.jobId || 'nojob'}:${requestMeta.blockId || 'noblock'}:${requestMeta.attempt || 1}:${taskType || 'unknown'}`;
      const payloadHash = this._hashLlmPayload({
        taskType: taskType || 'unknown',
        request: {
          input: safeRequest.input || null,
          maxOutputTokens: safeRequest.maxOutputTokens,
          temperature: safeRequest.temperature,
          store: safeRequest.store,
          background: safeRequest.background,
          stream: safeRequest.stream === true,
          selectedModelSpecs,
          responsesOptions
        }
      });
      if (this.inflightStore && typeof this.inflightStore.findByKey === 'function') {
        const existing = await this.inflightStore.findByKey(requestKey).catch(() => null);
        if (existing && existing.status === 'done' && existing.payloadHash === payloadHash && existing.rawJson && typeof existing.rawJson === 'object') {
          return existing.rawJson;
        }
      }
      const estTokens = this._estimateRequestTokens(safeRequest.input, safeRequest.maxOutputTokens);
      const now = Date.now();
      let sharedBudgetGrantId = null;
      if (this.rateLimitBudgetStore && typeof this.rateLimitBudgetStore.reserve === 'function') {
        const budgetProvider = this._resolveSharedBudgetProvider();
        const reserve = await this.rateLimitBudgetStore.reserve({
          provider: budgetProvider,
          jobId: requestMeta.jobId || null,
          model: null,
          estTokens,
          estRequests: 1,
          leaseMs: requestMeta.timeoutMs
        }).catch(() => ({ ok: true }));
        if (!reserve || reserve.ok !== true) {
          const waitMs = Math.max(250, Number.isFinite(Number(reserve && reserve.waitMs)) ? Number(reserve.waitMs) : 30 * 1000);
          await this._markJobWaitingForBudget({
            jobId: requestMeta.jobId || null,
            waitMs,
            reasonCode: 'RATE_LIMIT_BUDGET_WAIT'
          }).catch(() => null);
          const error = new Error('Shared rate-limit budget is temporarily exhausted');
          error.code = 'OPENAI_429';
          error.status = 429;
          error.retryAfterMs = waitMs;
          error.reason = reserve && reserve.reason ? reserve.reason : 'budget_wait';
          throw error;
        }
        sharedBudgetGrantId = reserve.grantId || null;
      }

      await this.inflightStore.upsert(requestMeta.requestId, {
        requestKey,
        payloadHash,
        status: 'pending',
        tabId,
        jobId: requestMeta.jobId,
        blockId: requestMeta.blockId,
        attempt: requestMeta.attempt,
        taskType: taskType || 'unknown',
        stage: requestMeta.stage || null,
        mode: safeRequest.stream === true ? 'stream' : 'nonstream',
        meta: {
          jobId: requestMeta.jobId || null,
          blockId: requestMeta.blockId || null,
          stage: requestMeta.stage || null
        },
        modelSpec: null,
        estTokens,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attemptDeadlineTs: now + requestMeta.timeoutMs,
        leaseUntilTs: this.inflightStore.nextLease(now)
      });

      let abortListener = null;
      if (safeRequest.signal && typeof safeRequest.signal.addEventListener === 'function' && this.offscreenExecutor && typeof this.offscreenExecutor.cancel === 'function') {
        abortListener = () => {
          this.offscreenExecutor.cancel(requestMeta.requestId).catch(() => ({ ok: false }));
        };
        try {
          safeRequest.signal.addEventListener('abort', abortListener, { once: true });
        } catch (_) {
          abortListener = null;
        }
      }

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
          selectedModelSpecs,
          modelSelection: effectiveModelSelection,
          input: safeRequest.input,
          maxOutputTokens: safeRequest.maxOutputTokens,
          temperature: safeRequest.temperature,
          store: safeRequest.store,
          background: safeRequest.background,
          signal: safeRequest.signal,
          stream: safeRequest.stream === true,
          onEvent: typeof safeRequest.onEvent === 'function' ? safeRequest.onEvent : null,
          hintPrevModelSpec: prevModelSpec,
          hintBatchSize: Number.isFinite(Number(safeRequest.hintBatchSize)) ? Number(safeRequest.hintBatchSize) : 1,
          requestMeta,
          responsesOptions
        });

        const decision = result && result.decision ? result.decision : null;
        const json = result ? result.json : null;
        const headers = result && result.headers ? result.headers : null;
        const status = result && Number.isFinite(Number(result.status)) ? Number(result.status) : 200;
        const connection = result && result.connection && typeof result.connection === 'object'
          ? result.connection
          : null;

        await this._recordRateLimitHeaders({
          requestMeta,
          modelSpec: decision && decision.chosenModelSpec ? decision.chosenModelSpec : null,
          headers,
          status
        }).catch(() => {});

        if (json && typeof json === 'object' && !Array.isArray(json)) {
          const ntMeta = {
            requestId: requestMeta.requestId,
            taskType: taskType || 'unknown',
            jobId: requestMeta.jobId || null,
            blockId: requestMeta.blockId || null,
            attempt: requestMeta.attempt || 1,
            chosenModelSpec: decision ? decision.chosenModelSpec || null : null,
            chosenModelId: decision ? decision.chosenModelId || null : null,
            serviceTier: decision ? decision.serviceTier || 'default' : 'default',
            policy: decision ? decision.policy || null : null,
            reason: decision ? decision.reason || null : null,
            usage: this._extractUsageSnapshot(json && json.usage ? json.usage : null),
            rate: null,
            cachedInputSupported: decision ? Boolean(decision.promptCachingSupported) : false,
            connection: connection
              ? {
                endpointHost: connection.endpointHost || null,
                hasAuth: connection.hasAuth === true,
                mode: connection.mode || null
              }
              : null,
            requestOptions: this._sanitizeRequestOptionsForMeta(responsesOptions)
          };
          if (ntMeta.chosenModelSpec && this.ai && typeof this.ai.getModelLimitsSnapshot === 'function') {
            try {
              const limitsBySpec = await this.ai.getModelLimitsSnapshot({
                selectedModelSpecs: [ntMeta.chosenModelSpec],
                limit: 1,
                now: Date.now()
              });
              ntMeta.rate = this._extractRateSnapshot(
                limitsBySpec && typeof limitsBySpec === 'object'
                  ? limitsBySpec[ntMeta.chosenModelSpec]
                  : null
              );
            } catch (_) {
              ntMeta.rate = null;
            }
          }
          try {
            json.__nt = ntMeta;
          } catch (_) {
            // best-effort metadata only
          }
        }

        if (result && result.decision && result.decision.chosenModelSpec) {
          await this.inflightStore.upsert(requestMeta.requestId, {
            modelSpec: result.decision.chosenModelSpec,
            updatedAt: Date.now(),
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

        if (this.inflightStore && typeof this.inflightStore.markDone === 'function') {
          await this.inflightStore.markDone(requestMeta.requestId, {
            requestKey,
            payloadHash,
            rawJson: result ? result.json : null,
            rawResult: result ? {
              ok: true,
              status: status,
              json: result.json,
              headers: this._headersToObject(headers),
              connection: connection
                ? {
                  endpointHost: connection.endpointHost || null,
                  hasAuth: connection.hasAuth === true,
                  mode: connection.mode || null
                }
                : null
            } : null,
            decision: decision || null,
            resultSummary: {
              ok: true,
              modelSpec: decision && decision.chosenModelSpec ? decision.chosenModelSpec : null,
              connection: connection
                ? {
                  endpointHost: connection.endpointHost || null,
                  hasAuth: connection.hasAuth === true,
                  mode: connection.mode || null
                }
                : null
            }
          });
        } else {
          await this.inflightStore.remove(requestMeta.requestId);
        }
        this._broadcastRuntimeToolingPatch().catch(() => {});
        return result ? result.json : null;
      } catch (error) {
        const errorCode = error && (error.code || error.name) ? (error.code || error.name) : 'REQUEST_FAILED';
        const aborted = errorCode === 'ABORT_ERR' || errorCode === 'ABORTED' || errorCode === 'AbortError';
        if (error && Number(error.status) === 429) {
          await this._recordRateLimitHeaders({
            requestMeta,
            modelSpec: null,
            headers: error.headers || null,
            status: 429
          }).catch(() => {});
          if (this.rateLimitBudgetStore && typeof this.rateLimitBudgetStore.on429 === 'function') {
            await this.rateLimitBudgetStore.on429({
              provider: this._resolveSharedBudgetProvider(),
              jobId: requestMeta.jobId || null,
              model: null,
              retryAfterMs: Number.isFinite(Number(error.retryAfterMs))
                ? Number(error.retryAfterMs)
                : this._extractRetryAfterMs(error.headers || null),
              headersSubset: this._extractRateLimitHeadersSubset(error.headers || null)
            }).catch(() => null);
          }
        }
        if (this.inflightStore) {
          if (aborted && typeof this.inflightStore.markCancelled === 'function') {
            await this.inflightStore.markCancelled(requestMeta.requestId);
          } else if (typeof this.inflightStore.markFailed === 'function') {
            await this.inflightStore.markFailed(requestMeta.requestId, {
              requestKey,
              payloadHash,
              error: {
                code: errorCode,
                message: error && error.message ? error.message : 'request failed'
              }
            });
          } else {
            await this.inflightStore.remove(requestMeta.requestId);
          }
        }
        throw error;
      } finally {
        if (sharedBudgetGrantId && this.rateLimitBudgetStore && typeof this.rateLimitBudgetStore.release === 'function') {
          await this.rateLimitBudgetStore.release({
            grantId: sharedBudgetGrantId,
            usedTokens: estTokens,
            usedRequests: 1
          }).catch(() => null);
        }
        if (abortListener && safeRequest.signal && typeof safeRequest.signal.removeEventListener === 'function') {
          try {
            safeRequest.signal.removeEventListener('abort', abortListener);
          } catch (_) {
            // best-effort
          }
        }
      }
    }

    _hashLlmPayload(payload) {
      const source = payload && typeof payload === 'object' ? payload : {};
      const text = JSON.stringify(source);
      let hash = 2166136261;
      for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
      return (hash >>> 0).toString(16);
    }

    _pickResponsesOptions(request) {
      const src = request && typeof request === 'object' ? request : {};
      const out = {};
      if (Array.isArray(src.tools)) {
        out.tools = src.tools;
      }
      if (src.toolChoice !== undefined) {
        out.tool_choice = src.toolChoice;
      } else if (src.tool_choice !== undefined) {
        out.tool_choice = src.tool_choice;
      }
      if (typeof src.parallelToolCalls === 'boolean') {
        out.parallel_tool_calls = src.parallelToolCalls;
      } else if (typeof src.parallel_tool_calls === 'boolean') {
        out.parallel_tool_calls = src.parallel_tool_calls;
      }
      if (typeof src.previousResponseId === 'string' && src.previousResponseId) {
        out.previous_response_id = src.previousResponseId;
      } else if (typeof src.previous_response_id === 'string' && src.previous_response_id) {
        out.previous_response_id = src.previous_response_id;
      }
      if (src.reasoning && typeof src.reasoning === 'object') {
        out.reasoning = src.reasoning;
      }
      if (src.text && typeof src.text === 'object') {
        out.text = src.text;
      }
      if (src.truncation !== undefined) {
        out.truncation = src.truncation;
      }
      if (typeof src.promptCacheKey === 'string' && src.promptCacheKey.trim()) {
        out.prompt_cache_key = src.promptCacheKey.trim().slice(0, 128);
      } else if (typeof src.prompt_cache_key === 'string' && src.prompt_cache_key.trim()) {
        out.prompt_cache_key = src.prompt_cache_key.trim().slice(0, 128);
      }
      if (typeof src.promptCacheRetention === 'string' && src.promptCacheRetention.trim()) {
        out.prompt_cache_retention = src.promptCacheRetention.trim();
      } else if (typeof src.prompt_cache_retention === 'string' && src.prompt_cache_retention.trim()) {
        out.prompt_cache_retention = src.prompt_cache_retention.trim();
      }
      if (src.maxToolCalls !== undefined) {
        out.max_tool_calls = src.maxToolCalls;
      } else if (src.max_tool_calls !== undefined) {
        out.max_tool_calls = src.max_tool_calls;
      }
      if (typeof src.stream === 'boolean') {
        out.stream = src.stream;
      }
      return out;
    }

    _buildResponsesOptionsFromSettings({ settings, taskType, request } = {}) {
      const safeSettings = settings && typeof settings === 'object' ? settings : {};
      const out = {};
      const safeTaskType = typeof taskType === 'string' ? taskType : '';
      const safeRequest = request && typeof request === 'object' ? request : {};
      if (!safeTaskType.startsWith('translation_')) {
        return out;
      }
      const reasoning = safeSettings.reasoning && typeof safeSettings.reasoning === 'object'
        ? safeSettings.reasoning
        : null;
      if (reasoning) {
        const effort = typeof reasoning.reasoningEffort === 'string' && reasoning.reasoningEffort
          ? reasoning.reasoningEffort
          : 'medium';
        const summary = typeof reasoning.reasoningSummary === 'string' && reasoning.reasoningSummary
          ? reasoning.reasoningSummary
          : 'auto';
        out.reasoning = { effort, summary };
      }
      const caching = safeSettings.caching && typeof safeSettings.caching === 'object'
        ? safeSettings.caching
        : null;
      if (caching && caching.compatCache !== false) {
        const retentionRaw = typeof caching.promptCacheRetention === 'string'
          ? caching.promptCacheRetention
          : 'auto';
        if (retentionRaw && retentionRaw !== 'disabled') {
          const mappedRetention = retentionRaw === 'in_memory'
            ? 'in-memory'
            : (retentionRaw === 'extended' ? '24h' : retentionRaw);
          out.prompt_cache_retention = mappedRetention;
          const promptCacheKey = typeof caching.promptCacheKey === 'string' && caching.promptCacheKey.trim()
            ? caching.promptCacheKey.trim().slice(0, 128)
            : '';
          if (promptCacheKey) {
            out.prompt_cache_key = promptCacheKey;
          } else {
            const fallbackKey = this._buildPromptCacheKeyFromRequest({
              taskType: safeTaskType,
              request: safeRequest
            });
            if (fallbackKey) {
              out.prompt_cache_key = fallbackKey;
            }
          }
        }
      }
      return out;
    }

    _buildPromptCacheKeyFromRequest({ taskType, request } = {}) {
      const safeTaskType = typeof taskType === 'string' ? taskType : 'translation';
      const safeRequest = request && typeof request === 'object' ? request : {};
      const keySource = [
        safeTaskType,
        safeRequest.jobId || '',
        safeRequest.blockId || safeRequest.blockIndex || '',
        safeRequest.agentRoute || '',
        typeof safeRequest.targetLang === 'string' ? safeRequest.targetLang : ''
      ].join('|');
      if (!keySource.trim()) {
        return '';
      }
      return `nt:pc:${this._hashLlmPayload({ keySource })}`;
    }

    _mergeResponsesOptions(base, override) {
      const left = base && typeof base === 'object' ? base : {};
      const right = override && typeof override === 'object' ? override : {};
      const out = {
        ...left,
        ...right
      };
      if (left.reasoning && !right.reasoning) {
        out.reasoning = left.reasoning;
      }
      return out;
    }

    _sanitizeRequestOptionsForMeta(options) {
      const src = options && typeof options === 'object' ? options : {};
      const out = {};
      if (src.reasoning && typeof src.reasoning === 'object') {
        out.reasoning = {
          effort: src.reasoning.effort || null,
          summary: src.reasoning.summary || null
        };
      }
      if (Object.prototype.hasOwnProperty.call(src, 'prompt_cache_retention')) {
        out.prompt_cache_retention = src.prompt_cache_retention;
      }
      if (typeof src.prompt_cache_key === 'string' && src.prompt_cache_key) {
        out.prompt_cache_key = '[configured]';
      }
      if (Object.prototype.hasOwnProperty.call(src, 'tool_choice')) {
        out.tool_choice = src.tool_choice;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'parallel_tool_calls')) {
        out.parallel_tool_calls = src.parallel_tool_calls;
      }
      if (Number.isFinite(Number(src.max_tool_calls))) {
        out.max_tool_calls = Number(src.max_tool_calls);
      }
      if (Array.isArray(src.tools)) {
        out.tools = { count: src.tools.length };
      }
      if (Object.prototype.hasOwnProperty.call(src, 'previous_response_id')) {
        out.previous_response_id = src.previous_response_id || null;
      }
      return out;
    }

    _headersToObject(headersLike) {
      if (!headersLike) {
        return {};
      }
      if (headersLike && typeof headersLike === 'object' && !headersLike.get) {
        return { ...headersLike };
      }
      if (typeof headersLike.get !== 'function') {
        return {};
      }
      const keys = [
        'x-ratelimit-limit-requests',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-tokens',
        'x-ratelimit-reset-requests',
        'x-ratelimit-reset-tokens',
        'retry-after',
        'retry-after-ms',
        'x-request-id'
      ];
      const out = {};
      keys.forEach((key) => {
        try {
          const value = headersLike.get(key);
          if (value !== null && value !== undefined && String(value).trim()) {
            out[key] = String(value);
          }
        } catch (_) {
          // ignore malformed header accessors
        }
      });
      return out;
    }

    _extractRateLimitHeadersSubset(headersLike) {
      const headers = this._headersToObject(headersLike);
      const keys = [
        'x-ratelimit-limit-requests',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-tokens',
        'x-ratelimit-reset-requests',
        'x-ratelimit-reset-tokens'
      ];
      const subset = {};
      keys.forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(headers, key)) {
          subset[key] = headers[key];
        }
      });
      return Object.keys(subset).length ? subset : null;
    }

    async _recordRateLimitHeaders({ requestMeta, modelSpec, headers, status } = {}) {
      const subset = this._extractRateLimitHeadersSubset(headers);
      if (!subset) {
        return;
      }
      if (this.rateLimitBudgetStore && typeof this.rateLimitBudgetStore.updateFromHeaders === 'function') {
        await this.rateLimitBudgetStore.updateFromHeaders({
          provider: this._resolveSharedBudgetProvider(),
          model: typeof modelSpec === 'string' && modelSpec ? modelSpec : null,
          headersSubset: subset,
          ts: Date.now()
        }).catch(() => null);
      }
      const meta = requestMeta && typeof requestMeta === 'object' ? requestMeta : {};
      const jobId = meta.jobId || null;
      if (!jobId || !this.translationJobStore || typeof this.translationJobStore.getJob !== 'function') {
        return;
      }
      const job = await this.translationJobStore.getJob(jobId).catch(() => null);
      if (!job || !job.agentState || typeof job.agentState !== 'object') {
        return;
      }
      let resolvedModel = typeof modelSpec === 'string' && modelSpec ? modelSpec : null;
      if (!resolvedModel && this.inflightStore && typeof this.inflightStore.get === 'function') {
        const inflight = await this.inflightStore.get(meta.requestId).catch(() => null);
        resolvedModel = inflight && inflight.modelSpec ? inflight.modelSpec : null;
      }

      const item = {
        ts: Date.now(),
        model: resolvedModel,
        status: Number.isFinite(Number(status)) ? Number(status) : null,
        headersSubset: subset,
        requestId: meta.requestId || null
      };
      job.agentState.lastRateLimits = item;
      const history = Array.isArray(job.agentState.rateLimitHistory)
        ? job.agentState.rateLimitHistory.slice()
        : [];
      history.push(item);
      job.agentState.rateLimitHistory = history.slice(-20);
      job.updatedAt = Date.now();
      await this.translationJobStore.upsertJob(job).catch(() => {});

      if (this.tabStateStore && job.tabId !== null && job.tabId !== undefined) {
        const agentState = this.translationAgent && typeof this.translationAgent.toUiSnapshot === 'function'
          ? this.translationAgent.toUiSnapshot(job.agentState || null)
          : job.agentState;
        await this.tabStateStore.upsertStatusPatch(job.tabId, {
          agentState,
          updatedAt: job.updatedAt
        }).catch(() => {});
      }

      if (this.uiHub && this.translationAgent && typeof this.translationAgent.toUiSnapshot === 'function') {
        this.uiHub.broadcastPatch({
          agentState: this.translationAgent.toUiSnapshot(job.agentState || null)
        });
      }
      this._broadcastRuntimeToolingPatch().catch(() => {});
    }

    _extractUsageSnapshot(usage) {
      if (!usage || typeof usage !== 'object') {
        return null;
      }
      const pickNumber = (...keys) => {
        for (let i = 0; i < keys.length; i += 1) {
          const key = keys[i];
          const value = usage[key];
          if (Number.isFinite(Number(value))) {
            return Number(value);
          }
        }
        return null;
      };
      const inputTokens = pickNumber('inputTokens', 'input_tokens', 'prompt_tokens');
      const outputTokens = pickNumber('outputTokens', 'output_tokens', 'completion_tokens');
      let totalTokens = pickNumber('totalTokens', 'total_tokens');
      if (totalTokens === null && (inputTokens !== null || outputTokens !== null)) {
        totalTokens = Number(inputTokens || 0) + Number(outputTokens || 0);
      }
      if (inputTokens === null && outputTokens === null && totalTokens === null) {
        return null;
      }
      return { inputTokens, outputTokens, totalTokens };
    }

    _extractRateSnapshot(snapshot) {
      if (!snapshot || typeof snapshot !== 'object') {
        return null;
      }
      return {
        remainingRequests: snapshot.remainingRequests === undefined ? null : snapshot.remainingRequests,
        remainingTokens: snapshot.remainingTokens === undefined ? null : snapshot.remainingTokens,
        limitRequests: snapshot.limitRequests === undefined ? null : snapshot.limitRequests,
        limitTokens: snapshot.limitTokens === undefined ? null : snapshot.limitTokens,
        resetRequestsAt: snapshot.resetRequestsAt || null,
        resetTokensAt: snapshot.resetTokensAt || null,
        reservedRequests: snapshot.reservedRequests === undefined ? null : snapshot.reservedRequests,
        reservedTokens: snapshot.reservedTokens === undefined ? null : snapshot.reservedTokens,
        cooldownUntilTs: snapshot.cooldownUntilTs || null
      };
    }

    async _readLlmSettings() {
      const data = await this.settingsStore.get([
        'settingsSchemaVersion',
        'translationAgentSettingsV2',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationAgentModelPolicy',
        'translationAgentProfile',
        'translationApiCacheEnabled',
        'translationAgentAllowedModels'
      ]);
      const resolvedSettings = this.settingsStore && typeof this.settingsStore.getResolvedSettings === 'function'
        ? await this.settingsStore.getResolvedSettings().catch(() => null)
        : null;
      const effectiveV2 = resolvedSettings && resolvedSettings.effectiveSettings && typeof resolvedSettings.effectiveSettings === 'object'
        ? resolvedSettings.effectiveSettings
        : null;
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
        schemaVersion: resolvedSettings && Number.isFinite(Number(resolvedSettings.schemaVersion))
          ? Number(resolvedSettings.schemaVersion)
          : Number(data.settingsSchemaVersion || 1),
        userSettings: resolvedSettings && resolvedSettings.userSettings
          ? resolvedSettings.userSettings
          : (data.translationAgentSettingsV2 || null),
        effectiveSettings: effectiveV2,
        agent: effectiveV2 && effectiveV2.agent ? effectiveV2.agent : null,
        reasoning: effectiveV2 && effectiveV2.reasoning ? effectiveV2.reasoning : null,
        caching: effectiveV2 && effectiveV2.caching ? effectiveV2.caching : null,
        models: effectiveV2 && effectiveV2.models ? effectiveV2.models : null,
        translationModelList: effectiveModels,
        modelSelection,
        translationAgentModelPolicy,
        translationAgentProfile: data.translationAgentProfile
          || (effectiveV2 && effectiveV2.legacyProjection ? effectiveV2.legacyProjection.translationAgentProfile : null)
          || 'auto',
        translationApiCacheEnabled: effectiveV2 && effectiveV2.caching
          ? effectiveV2.caching.compatCache !== false
          : (data.translationApiCacheEnabled !== false),
        translationAgentAllowedModels: effectiveV2 && effectiveV2.models
          ? this._sanitizeModelList(effectiveV2.models.agentAllowedModels)
          : this._sanitizeModelList(data.translationAgentAllowedModels)
      };
    }

    _resolveSelectedModelSpecs({ settingsModelList, requestedAllowed } = {}) {
      const fromSettings = this._sanitizeModelList(settingsModelList);
      const requested = this._sanitizeModelList(requestedAllowed);
      if (!requested.length) {
        return fromSettings.length ? fromSettings : this._buildDefaultModelList();
      }
      const available = new Set(fromSettings.length ? fromSettings : this._buildDefaultModelList());
      const intersect = requested.filter((spec) => available.has(spec));
      return intersect.length ? intersect : (fromSettings.length ? fromSettings : this._buildDefaultModelList());
    }

    _supportsReasoningForSelection(modelSpecs) {
      const specs = Array.isArray(modelSpecs) ? modelSpecs : [];
      if (!specs.length) {
        return true;
      }
      return specs.some((spec) => this._supportsReasoningForModelSpec(spec));
    }

    _supportsReasoningForModelSpec(modelSpec) {
      const parsed = this._parseModelSpec(modelSpec);
      const id = parsed && typeof parsed.id === 'string' ? parsed.id.toLowerCase() : '';
      if (!id) {
        return false;
      }
      // Best-effort gate: current reasoning-capable families in this project.
      return id.startsWith('o') || id.startsWith('gpt-5');
    }

    _parseModelSpec(spec) {
      const AiCommon = NT && NT.AiCommon ? NT.AiCommon : null;
      if (AiCommon && typeof AiCommon.parseModelSpec === 'function') {
        return AiCommon.parseModelSpec(spec);
      }
      const raw = typeof spec === 'string' ? spec.trim() : '';
      if (!raw) {
        return { id: '', tier: 'standard' };
      }
      const parts = raw.split(':');
      return {
        id: (parts[0] || '').trim(),
        tier: (parts[1] || 'standard').trim()
      };
    }

    async _appendAgentWarningReport({ jobId, title, body, meta } = {}) {
      if (!jobId || !this.translationJobStore || typeof this.translationJobStore.getJob !== 'function') {
        return;
      }
      const job = await this.translationJobStore.getJob(jobId).catch(() => null);
      if (!job || !job.agentState || typeof job.agentState !== 'object') {
        return;
      }
      const state = job.agentState;
      state.reports = Array.isArray(state.reports) ? state.reports : [];
      state.reports.push({
        ts: Date.now(),
        type: 'warning',
        title: title || 'Предупреждение',
        body: body || '',
        meta: meta && typeof meta === 'object' ? meta : {}
      });
      state.reports = state.reports.slice(-100);
      state.updatedAt = Date.now();
      job.updatedAt = Date.now();
      await this.translationJobStore.upsertJob(job).catch(() => {});
      if (this.tabStateStore && job.tabId !== null && job.tabId !== undefined) {
        const agentState = this.translationAgent && typeof this.translationAgent.toUiSnapshot === 'function'
          ? this.translationAgent.toUiSnapshot(state)
          : state;
        await this.tabStateStore.upsertStatusPatch(job.tabId, {
          agentState,
          updatedAt: job.updatedAt
        }).catch(() => {});
      }
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

    async _handleUiCommand(envelope, { port } = {}) {
      if (!envelope || !envelope.payload) {
        return { ok: false, error: { code: 'INVALID_UI_COMMAND', message: 'Отсутствует payload конверта' } };
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
        this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'Журнал событий очищен', { source: 'ui' }));
        return { ok: true };
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.BENCHMARK_SELECTED_MODELS : 'BENCHMARK_SELECTED_MODELS')) {
        this._logEvent(this.eventFactory.info(NT.EventTypes.Tags.BENCH_START, 'Получен запрос на бенчмарк', { source: 'ui' }));
        try {
          const modelSpecs = await this._loadSelectedModels();
          await this.ai.benchmarkSelected(modelSpecs, { force: Boolean(commandPayload.force) });
          return { ok: true };
        } catch (_) {
          await this.settingsStore.set({
            modelBenchmarkStatus: { status: 'failed', errorCode: 'BENCHMARK_START_FAILED', updatedAt: Date.now() }
          });
          return { ok: false, error: { code: 'BENCHMARK_START_FAILED', message: 'Не удалось запустить бенчмарк' } };
        }
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.SET_SETTINGS : 'SET_SETTINGS')) {
        const settingsPatch = commandPayload && commandPayload.patch && typeof commandPayload.patch === 'object'
          ? commandPayload.patch
          : {};
        let updateResult = null;
        if (!this.settingsStore || typeof this.settingsStore.applySettingsPatch !== 'function') {
          updateResult = {
            ok: false,
            error: {
              code: 'SETTINGS_STORE_UNAVAILABLE',
              message: 'SettingsStore не поддерживает applySettingsPatch'
            }
          };
        } else {
          updateResult = await this.settingsStore.applySettingsPatch({
            patch: settingsPatch,
            expectedSchemaVersion: commandPayload.expectedSchemaVersion,
            legacySettings: commandPayload.legacySettings && typeof commandPayload.legacySettings === 'object'
              ? commandPayload.legacySettings
              : null
          });
        }
        const requestId = envelope && envelope.meta ? envelope.meta.requestId || null : null;
        const resultPatch = {
          type: UiProtocol && UiProtocol.UI_SETTINGS_RESULT ? UiProtocol.UI_SETTINGS_RESULT : 'ui:settings:result',
          requestId,
          ok: updateResult && updateResult.ok === true,
          error: updateResult && updateResult.error ? updateResult.error : null
        };
        if (this.uiHub && port) {
          this.uiHub.sendPatchToPort(port, resultPatch, { stage: 'settings-result', requestId });
        }
        if (updateResult && updateResult.ok) {
          const snapshot = await this.settingsStore.getPublicSnapshot().catch(() => null);
          if (snapshot && this.uiHub) {
            this.uiHub.broadcastPatch({ settings: snapshot });
          }
        }
        return updateResult;
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.SET_CONNECTION_MODE : 'SET_CONNECTION_MODE')) {
        const mode = commandPayload && typeof commandPayload.mode === 'string' ? commandPayload.mode : 'PROXY';
        const result = await this._setConnectionMode(mode);
        await this._broadcastSecurityPatch().catch(() => {});
        return result;
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.SAVE_BYOK_KEY : 'SAVE_BYOK_KEY')) {
        const key = commandPayload && typeof commandPayload.key === 'string' ? commandPayload.key : '';
        const persist = Boolean(commandPayload && commandPayload.persist === true);
        const result = await this._saveByokKey({ key, persist });
        await this._broadcastSecurityPatch().catch(() => {});
        return result;
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.CLEAR_BYOK_KEY : 'CLEAR_BYOK_KEY')) {
        const result = await this._clearByokKey();
        await this._broadcastSecurityPatch().catch(() => {});
        return result;
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.SAVE_PROXY_CONFIG : 'SAVE_PROXY_CONFIG')) {
        const result = await this._saveProxyConfig(commandPayload || {});
        await this._broadcastSecurityPatch().catch(() => {});
        return result;
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.CLEAR_PROXY_CONFIG : 'CLEAR_PROXY_CONFIG')) {
        const result = await this._clearProxyConfig();
        await this._broadcastSecurityPatch().catch(() => {});
        return result;
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.BG_TEST_CONNECTION : 'BG_TEST_CONNECTION')) {
        const result = await this._testConnection({ commandPayload: commandPayload || {} });
        this._securityState.lastConnectionTest = result && typeof result === 'object'
          ? result
          : null;
        await this._broadcastSecurityPatch().catch(() => {});
        return result;
      }

      if (commandName === (UiProtocol && UiProtocol.Commands ? UiProtocol.Commands.RUN_SECURITY_AUDIT : 'RUN_SECURITY_AUDIT')) {
        const result = await this._runSecurityAudit();
        this._securityState.lastAudit = result && result.report ? result.report : null;
        await this._broadcastSecurityPatch().catch(() => {});
        return result;
      }

      if (!this.translationOrchestrator) {
        return { ok: false, error: { code: 'ORCHESTRATOR_UNAVAILABLE', message: 'Оркестратор перевода недоступен' } };
      }

      const tabId = this._resolveCommandTabId(envelope, commandPayload);
      if (Number.isFinite(Number(tabId))) {
        await this._refreshActiveTabId({ tabIdHint: Number(tabId) }).catch(() => null);
      }
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
          this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.TRANSLATION_FAIL, 'Запуск перевода отклонён', {
            source: 'ui',
            tabId,
            reason: result.error && result.error.code ? result.error.code : 'неизвестно'
          }));
        } else if (result.job && result.job.id && this.tabSessionManager && Number.isFinite(Number(tabId))) {
          await this.tabSessionManager.attachJob(Number(tabId), result.job.id, {
            state: 'planning'
          }).catch(() => null);
        }
        this._kickScheduler('ui:start_translation');
        return result;
      }

      if (commandName === commands.CANCEL_TRANSLATION || commandName === 'CANCEL_TRANSLATION') {
        const result = await this.translationOrchestrator.cancelJob({ tabId, reason: 'USER_CANCELLED' });
        if (result && result.ok && result.job && result.job.id && this.offscreenExecutor && typeof this.offscreenExecutor.cancelByJobId === 'function') {
          await this.offscreenExecutor.cancelByJobId(result.job.id, { maxRequests: 20 }).catch(() => ({ ok: false, cancelled: 0 }));
        }
        if (this.tabSessionManager && Number.isFinite(Number(tabId))) {
          await this.tabSessionManager.detachJob(Number(tabId), result && result.job ? result.job.id : null).catch(() => null);
        }
        this._kickScheduler('ui:cancel_translation');
        return result;
      }

      if (commandName === commands.SET_TRANSLATION_CATEGORIES || commandName === 'SET_TRANSLATION_CATEGORIES') {
        const result = await this.translationOrchestrator.applyCategorySelection({
          tabId,
          categories: Array.isArray(commandPayload.categories) ? commandPayload.categories : [],
          jobId: commandPayload.jobId || null
        });
        this._kickScheduler('ui:set_translation_categories');
        return result;
      }

      if (commandName === commands.CLEAR_TRANSLATION_DATA || commandName === 'CLEAR_TRANSLATION_DATA') {
        const activeJob = (tabId !== null && tabId !== undefined && this.translationJobStore && typeof this.translationJobStore.getActiveJob === 'function')
          ? await this.translationJobStore.getActiveJob(tabId).catch(() => null)
          : null;
        const result = await this.translationOrchestrator.clearJobData({
          tabId,
          includeCache: commandPayload.includeCache !== false
        });
        if (activeJob && activeJob.id && this.offscreenExecutor && typeof this.offscreenExecutor.cancelByJobId === 'function') {
          await this.offscreenExecutor.cancelByJobId(activeJob.id, { maxRequests: 20 }).catch(() => ({ ok: false, cancelled: 0 }));
        }
        if (this.tabSessionManager && Number.isFinite(Number(tabId))) {
          await this.tabSessionManager.detachJob(Number(tabId), activeJob && activeJob.id ? activeJob.id : null).catch(() => null);
        }
        this._kickScheduler('ui:clear_translation_data');
        return result;
      }

      if (commandName === commands.ERASE_TRANSLATION_MEMORY || commandName === 'ERASE_TRANSLATION_MEMORY') {
        const result = await this.translationOrchestrator.eraseTranslationMemory({
          tabId,
          scope: commandPayload && commandPayload.scope === 'all' ? 'all' : 'page'
        });
        this._kickScheduler('ui:erase_translation_memory');
        return result;
      }

      if (commandName === commands.APPLY_AUTOTUNE_PROPOSAL || commandName === 'APPLY_AUTOTUNE_PROPOSAL') {
        const result = await this.translationOrchestrator.applyAutoTuneProposal({
          tabId,
          jobId: commandPayload.jobId || null,
          proposalId: commandPayload.proposalId || null
        });
        this._kickScheduler('ui:apply_autotune_proposal');
        return result;
      }

      if (commandName === commands.REJECT_AUTOTUNE_PROPOSAL || commandName === 'REJECT_AUTOTUNE_PROPOSAL') {
        const result = await this.translationOrchestrator.rejectAutoTuneProposal({
          tabId,
          jobId: commandPayload.jobId || null,
          proposalId: commandPayload.proposalId || null,
          reason: commandPayload.reason || ''
        });
        this._kickScheduler('ui:reject_autotune_proposal');
        return result;
      }

      if (commandName === commands.RESET_AUTOTUNE_OVERRIDES || commandName === 'RESET_AUTOTUNE_OVERRIDES') {
        const result = await this.translationOrchestrator.resetAutoTuneOverrides({
          tabId,
          jobId: commandPayload.jobId || null
        });
        this._kickScheduler('ui:reset_autotune_overrides');
        return result;
      }

      if (commandName === commands.SET_TRANSLATION_VISIBILITY || commandName === 'SET_TRANSLATION_VISIBILITY') {
        const result = await this.translationOrchestrator.setVisibility({
          tabId,
          visible: Boolean(commandPayload.visible),
          mode: typeof commandPayload.mode === 'string' ? commandPayload.mode : null
        });
        this._kickScheduler('ui:set_translation_visibility');
        return result;
      }

      if (commandName === commands.RETRY_FAILED_BLOCKS || commandName === 'RETRY_FAILED_BLOCKS') {
        const result = await this.translationOrchestrator.retryFailed({ tabId, jobId: commandPayload.jobId || null });
        this._kickScheduler('ui:retry_failed_blocks');
        return result;
      }

      if (commandName === commands.SET_PAUSE_OTHER_TABS || commandName === 'SET_PAUSE_OTHER_TABS') {
        if (!this.jobQueue || typeof this.jobQueue.setPauseOtherTabs !== 'function') {
          return { ok: false, error: { code: 'JOB_QUEUE_UNAVAILABLE', message: 'JobQueue недоступен' } };
        }
        const enabled = commandPayload && commandPayload.enabled === true;
        const result = await this.jobQueue.setPauseOtherTabs({
          enabled,
          activeTabId: this._activeTabId
        }).catch(() => null);
        await this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
        this._broadcastRuntimeToolingPatch().catch(() => {});
        this._kickScheduler('ui:set_pause_other_tabs');
        return { ok: true, pauseOtherTabs: result && result.pauseOtherTabs === true };
      }

      if (commandName === commands.KICK_SCHEDULER || commandName === 'KICK_SCHEDULER') {
        this._kickScheduler('ui:kick_scheduler');
        return { ok: true };
      }

      this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.UI_COMMAND, 'Неизвестная команда UI', {
        source: 'ui',
        stage: commandName || 'неизвестно'
      }));
      return { ok: false, error: { code: 'UNKNOWN_UI_COMMAND', message: String(commandName || 'неизвестно') } };
    }

    async _setConnectionMode(mode) {
      if (!this.credentialsStore || typeof this.credentialsStore.setMode !== 'function') {
        return { ok: false, error: { code: 'CREDENTIALS_STORE_UNAVAILABLE', message: 'CredentialsStore недоступен' } };
      }
      const next = await this.credentialsStore.setMode(mode).catch((error) => {
        throw error;
      });
      return {
        ok: true,
        mode: next
      };
    }

    _toProxyOriginPattern(baseUrl) {
      try {
        const parsed = new URL(String(baseUrl || ''));
        return `${parsed.protocol}//${parsed.host}/*`;
      } catch (_) {
        return null;
      }
    }

    async _ensureProxyPermission(baseUrl) {
      const pattern = this._toProxyOriginPattern(baseUrl);
      if (!pattern) {
        const error = new Error('Invalid proxy URL');
        error.code = 'PROXY_URL_INVALID';
        throw error;
      }
      if (!this.chromeApi || !this.chromeApi.permissions || typeof this.chromeApi.permissions.contains !== 'function') {
        return { ok: true, pattern, granted: true, skipped: true };
      }
      const hasPermission = await new Promise((resolve) => {
        this.chromeApi.permissions.contains({ origins: [pattern] }, (allowed) => {
          resolve(Boolean(allowed));
        });
      });
      if (hasPermission) {
        return { ok: true, pattern, granted: true };
      }
      if (typeof this.chromeApi.permissions.request !== 'function') {
        const error = new Error('Proxy origin permission is required');
        error.code = 'PROXY_PERMISSION_REQUIRED';
        throw error;
      }
      const granted = await new Promise((resolve) => {
        this.chromeApi.permissions.request({ origins: [pattern] }, (allowed) => {
          resolve(Boolean(allowed));
        });
      });
      if (!granted) {
        const error = new Error('Proxy origin permission denied');
        error.code = 'PROXY_PERMISSION_DENIED';
        throw error;
      }
      return { ok: true, pattern, granted };
    }

    async _saveByokKey({ key, persist } = {}) {
      if (!this.credentialsStore || typeof this.credentialsStore.setByokKey !== 'function') {
        return { ok: false, error: { code: 'CREDENTIALS_STORE_UNAVAILABLE', message: 'CredentialsStore недоступен' } };
      }
      const safeKey = typeof key === 'string' ? key.trim() : '';
      if (!safeKey) {
        return { ok: false, error: { code: 'NO_API_KEY', message: 'Пустой ключ BYOK' } };
      }
      const result = await this.credentialsStore.setByokKey(safeKey, { persist: Boolean(persist) });
      return {
        ok: true,
        mode: 'BYOK',
        persist: Boolean(result && result.persist)
      };
    }

    async _clearByokKey() {
      if (!this.credentialsStore || typeof this.credentialsStore.clearByokKey !== 'function') {
        return { ok: false, error: { code: 'CREDENTIALS_STORE_UNAVAILABLE', message: 'CredentialsStore недоступен' } };
      }
      await this.credentialsStore.clearByokKey();
      return { ok: true };
    }

    async _saveProxyConfig(payload) {
      if (!this.credentialsStore || typeof this.credentialsStore.setProxyConfig !== 'function') {
        return { ok: false, error: { code: 'CREDENTIALS_STORE_UNAVAILABLE', message: 'CredentialsStore недоступен' } };
      }
      const source = payload && typeof payload === 'object' ? payload : {};
      const baseUrl = typeof source.baseUrl === 'string' ? source.baseUrl : '';
      try {
        await this._ensureProxyPermission(baseUrl);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error && error.code ? error.code : 'PROXY_PERMISSION_REQUIRED',
            message: error && error.message ? error.message : 'Недостаточно прав для proxy origin'
          }
        };
      }
      try {
        const saved = await this.credentialsStore.setProxyConfig({
          baseUrl,
          authHeaderName: source.authHeaderName || 'X-NT-Token',
          authToken: source.authToken || '',
          projectId: source.projectId || '',
          persistToken: source.persistToken === true
        });
        return { ok: true, proxy: saved && saved.proxy ? saved.proxy : null, mode: 'PROXY' };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error && error.code ? error.code : 'PROXY_CONFIG_INVALID',
            message: error && error.message ? error.message : 'Ошибка сохранения proxy-конфига'
          }
        };
      }
    }

    async _clearProxyConfig() {
      if (!this.credentialsStore || typeof this.credentialsStore.clearProxyConfig !== 'function') {
        return { ok: false, error: { code: 'CREDENTIALS_STORE_UNAVAILABLE', message: 'CredentialsStore недоступен' } };
      }
      await this.credentialsStore.clearProxyConfig();
      return { ok: true };
    }

    async _testConnection({ commandPayload } = {}) {
      const payload = commandPayload && typeof commandPayload === 'object' ? commandPayload : {};
      const startTs = Date.now();
      const llmClient = this.ai && this.ai.llmClient ? this.ai.llmClient : null;
      if (!llmClient || typeof llmClient.generateMinimalPingRaw !== 'function') {
        return { ok: false, error: { code: 'LLM_CLIENT_UNAVAILABLE', message: 'LLM client недоступен' } };
      }
      const models = await this._loadSelectedModels().catch(() => []);
      const modelSpec = Array.isArray(models) && models.length ? models[0] : null;
      const modelId = this._parseModelSpec(modelSpec).id || 'gpt-4o-mini';
      const timeoutMs = Number.isFinite(Number(payload.timeoutMs))
        ? Math.max(3000, Math.min(45000, Math.round(Number(payload.timeoutMs))))
        : 12000;
      try {
        const raw = await llmClient.generateMinimalPingRaw({
          modelId,
          serviceTier: 'default',
          meta: {
            timeoutMs,
            connectionTest: true
          }
        });
        const headersSubset = this._extractRateLimitHeadersSubset(raw && raw.headers ? raw.headers : null);
        const connection = raw && raw.connection && typeof raw.connection === 'object'
          ? raw.connection
          : (llmClient && typeof llmClient.getLastConnectionInfo === 'function'
            ? llmClient.getLastConnectionInfo()
            : null);
        return {
          ok: true,
          latencyMs: Math.max(0, Date.now() - startTs),
          mode: connection && connection.mode ? connection.mode : null,
          endpointHost: connection && connection.endpointHost ? connection.endpointHost : null,
          hasAuth: connection ? connection.hasAuth === true : null,
          headersSubset
        };
      } catch (error) {
        const connection = llmClient && typeof llmClient.getLastConnectionInfo === 'function'
          ? llmClient.getLastConnectionInfo()
          : null;
        return {
          ok: false,
          latencyMs: Math.max(0, Date.now() - startTs),
          mode: connection && connection.mode ? connection.mode : null,
          endpointHost: connection && connection.endpointHost ? connection.endpointHost : null,
          hasAuth: connection ? connection.hasAuth === true : null,
          error: {
            code: error && error.code ? error.code : 'TEST_CONNECTION_FAILED',
            message: error && error.message ? error.message : 'Connection test failed'
          }
        };
      }
    }

    async _runSecurityAudit() {
      if (!this.securityAudit || typeof this.securityAudit.run !== 'function') {
        return { ok: false, error: { code: 'SECURITY_AUDIT_UNAVAILABLE', message: 'SecurityAudit недоступен' } };
      }
      try {
        const report = await this.securityAudit.run();
        return { ok: true, report };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error && error.code ? error.code : 'SECURITY_AUDIT_FAILED',
            message: error && error.message ? error.message : 'Security audit failed'
          }
        };
      }
    }

    _resolveCommandTabId(envelope, commandPayload) {
      if (commandPayload && Number.isFinite(Number(commandPayload.tabId))) {
        return Number(commandPayload.tabId);
      }
      if (envelope && envelope.meta && Number.isFinite(Number(envelope.meta.tabId))) {
        return Number(envelope.meta.tabId);
      }
      return Number.isFinite(Number(this._activeTabId)) ? Number(this._activeTabId) : null;
    }

    async _handleContentMessage(message, sender) {
      if (!this.translationOrchestrator) {
        return { ok: false, error: { code: 'ORCHESTRATOR_UNAVAILABLE', message: 'Оркестратор перевода недоступен' } };
      }
      const protocol = NT && NT.TranslationProtocol ? NT.TranslationProtocol : null;
      if (this.tabSessionManager && protocol && typeof protocol.unwrap === 'function') {
        try {
          const parsed = protocol.unwrap(message);
          const type = parsed && parsed.type ? parsed.type : null;
          const payload = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
          if (type === protocol.CS_HELLO_CAPS) {
            const senderTabId = sender && sender.tab && Number.isFinite(Number(sender.tab.id))
              ? Number(sender.tab.id)
              : (Number.isFinite(Number(payload.tabId)) ? Number(payload.tabId) : null);
            if (Number.isFinite(Number(senderTabId))) {
              await this.tabSessionManager.setContentCaps(senderTabId, payload.contentCaps || null).catch(() => null);
            }
          }
        } catch (_) {
          // best-effort session update only
        }
      }
      const result = await this.translationOrchestrator.handleContentMessage({ message, sender });
      this._kickScheduler('content:message');
      this._broadcastRuntimeToolingPatch().catch(() => {});
      return result;
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
      if (areaName !== 'local' && areaName !== 'session') {
        return;
      }
      const allChangedKeys = Object.keys(changes || {});
      if (!allChangedKeys.length) {
        return;
      }
      const credentialKeys = this.credentialsStore && typeof this.credentialsStore.getStorageKeys === 'function'
        ? this.credentialsStore.getStorageKeys()
        : null;
      const credentialLocalKey = credentialKeys && credentialKeys.localKey ? credentialKeys.localKey : 'nt.credentials.local.v1';
      const credentialSessionKey = credentialKeys && credentialKeys.sessionKey ? credentialKeys.sessionKey : 'nt.credentials.session.v1';
      if (
        (areaName === 'local' && allChangedKeys.includes(credentialLocalKey))
        || (areaName === 'session' && allChangedKeys.includes(credentialSessionKey))
      ) {
        this._broadcastSecurityPatch().catch(() => {});
        if (areaName === 'session') {
          return;
        }
      }
      if (areaName !== 'local') {
        return;
      }
      const settingsKeys = [
        'settingsSchemaVersion',
        'translationAgentSettingsV2',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationAgentModelPolicy',
        'translationPipelineEnabled',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationAgentExecutionMode',
        'translationAgentAllowedModels',
        'translationCategoryMode',
        'translationCategoryList',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationCompareDiffThreshold',
        'translationPopupActiveTab',
        'translationVisibilityByTab',
        'translationDisplayModeByTab'
      ];
      const watchedKeys = [
        'translationStatusByTab',
        'modelBenchmarkStatus',
        'modelBenchmarks'
      ];
      const changedKeys = allChangedKeys.filter((key) => watchedKeys.includes(key) || settingsKeys.includes(key));
      if (!changedKeys.length) {
        return;
      }
      const patch = {};
      changedKeys.forEach((key) => {
        if (watchedKeys.includes(key)) {
          patch[key] = changes[key].newValue;
        }
      });
      const hasSettingsChange = changedKeys.some((key) => settingsKeys.includes(key));
      if (hasSettingsChange && this.settingsStore && typeof this.settingsStore.getPublicSnapshot === 'function') {
        this.settingsStore.getPublicSnapshot()
          .then((settingsSnapshot) => {
            this.uiHub.broadcastPatch({
              changedKeys,
              patch: {
                ...patch,
                settings: settingsSnapshot
              }
            });
            this._broadcastRuntimeToolingPatch().catch(() => {});
          })
          .catch(() => {
            this.uiHub.broadcastPatch({ changedKeys, patch });
          });
        return;
      }
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
      if (!Number.isFinite(numericTabId)) {
        return;
      }
      if (this.tabSessionManager && typeof this.tabSessionManager.onTabRemoved === 'function') {
        this.tabSessionManager.onTabRemoved(numericTabId).catch(() => null);
      }
      if (this.jobQueue && typeof this.jobQueue.stats === 'function') {
        this._hydrateRuntimeSchedulers().catch(() => ({ ok: false }));
      }
      if (!this.translationOrchestrator) {
        return;
      }
      this.translationOrchestrator.cancelJob({
        tabId: numericTabId,
        reason: 'TAB_CLOSED'
      }).then((result) => {
        if (result && result.cancelled) {
          if (result.job && result.job.id && this.offscreenExecutor && typeof this.offscreenExecutor.cancelByJobId === 'function') {
            this.offscreenExecutor.cancelByJobId(result.job.id, { maxRequests: 20 }).catch(() => ({ ok: false, cancelled: 0 }));
          }
          this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.TRANSLATION_CANCEL, 'Задача перевода отменена из-за закрытия вкладки', {
            tabId: numericTabId,
            isWindowClosing: Boolean(removeInfo && removeInfo.isWindowClosing)
          }));
          this._kickScheduler('tab_removed');
          this._broadcastRuntimeToolingPatch().catch(() => {});
        }
      }).catch((error) => {
        this._logEvent(this.eventFactory.warn(NT.EventTypes.Tags.BG_ERROR, 'Не удалось отменить перевод при закрытии вкладки', {
          tabId: numericTabId,
          message: error && error.message ? error.message : 'неизвестно'
        }));
      });
    }

    _onTabActivated(activeInfo) {
      const numericTabId = activeInfo && Number.isFinite(Number(activeInfo.tabId))
        ? Number(activeInfo.tabId)
        : null;
      this._refreshActiveTabId({ tabIdHint: numericTabId })
        .then(() => this._hydrateRuntimeSchedulers())
        .then(() => this._broadcastRuntimeToolingPatch())
        .catch(() => ({ ok: false }));
    }

    _onTabUpdated(tabId, changeInfo, tab) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return;
      }
      const info = changeInfo && typeof changeInfo === 'object' ? changeInfo : {};
      if (this.tabSessionManager && typeof this.tabSessionManager.onTabUpdated === 'function') {
        this.tabSessionManager.onTabUpdated(numericTabId, info).catch(() => null);
      }
      if (!info.url || !this.translationJobStore || typeof this.translationJobStore.getActiveJob !== 'function') {
        return;
      }
      this.translationJobStore.getActiveJob(numericTabId).then((job) => {
        if (!job || !job.id) {
          return null;
        }
        const status = String(job.status || '').toLowerCase();
        if (status === 'done' || status === 'failed' || status === 'cancelled' || status === 'awaiting_categories') {
          return null;
        }
        const next = { ...job };
        next.url = info.url || (tab && tab.url ? tab.url : job.url);
        next.status = 'preparing';
        next.message = 'URL изменился, выполняю перескан страницы';
        next.scanReceived = false;
        next.currentBatchId = null;
        next.updatedAt = Date.now();
        if (this.translationOrchestrator && typeof this.translationOrchestrator._saveJob === 'function') {
          return this.translationOrchestrator._saveJob(next, { setActive: true });
        }
        return this.translationJobStore.upsertJob(next);
      }).then(() => {
        this._kickScheduler('tab_updated');
        this._broadcastRuntimeToolingPatch().catch(() => {});
      }).catch(() => null);
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

    _isSemverGte(actual, required) {
      const parse = (value) => {
        const raw = typeof value === 'string' ? value.trim() : '';
        const match = raw.match(/^(\d+)\.(\d+)\.(\d+)$/);
        if (!match) {
          return null;
        }
        return [Number(match[1]), Number(match[2]), Number(match[3])];
      };
      const left = parse(actual);
      const right = parse(required);
      if (!left || !right) {
        return true;
      }
      for (let i = 0; i < 3; i += 1) {
        if (left[i] > right[i]) {
          return true;
        }
        if (left[i] < right[i]) {
          return false;
        }
      }
      return true;
    }

    _resolveToolPolicyStage(job) {
      const phase = job && job.agentState && typeof job.agentState.phase === 'string'
        ? job.agentState.phase
        : '';
      if (!phase) {
        return null;
      }
      if (phase.indexOf('proofread') >= 0) {
        return 'proofreading';
      }
      if (phase.indexOf('planning') >= 0 || phase.indexOf('awaiting_categories') >= 0) {
        return 'planning';
      }
      return 'execution';
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
