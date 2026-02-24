/**
 * Debug page controller for live diagnostics stream.
 *
 * State is hydrated from snapshot/patch messages via `UiModule`; no direct
 * storage access is used in this controller. Event log updates are incremental:
 * append deltas, reset notifications, and explicit older-page requests.
 *
 * Rendering keeps rows compact and wrapped to avoid horizontal scrolling while
 * preserving full message/meta visibility.
 *
 * The page also renders compact per-model rate-limit state from snapshot/patch
 * (`modelLimitsBySpec`) to explain cooldown/reservation waits in real time.
 */
(function initDebugPage(global) {
  class DetailsStateManager {
    constructor({ doc, storageKeyPrefix, ui }) {
      this.doc = doc;
      this.storageKeyPrefix = typeof storageKeyPrefix === 'string' && storageKeyPrefix
        ? storageKeyPrefix
        : 'nt.ui.details';
      this.ui = ui || null;
    }

    async init() {
      if (!this.doc || typeof this.doc.querySelectorAll !== 'function') {
        return;
      }
      let collapseState = {};
      if (this.ui && typeof this.ui.getSettingsSnapshot === 'function') {
        const settings = await this.ui.getSettingsSnapshot().catch(() => null);
        const userSettings = settings && settings.userSettings && typeof settings.userSettings === 'object'
          ? settings.userSettings
          : {};
        const uiSettings = userSettings.ui && typeof userSettings.ui === 'object'
          ? userSettings.ui
          : {};
        collapseState = uiSettings.collapseState && typeof uiSettings.collapseState === 'object'
          ? uiSettings.collapseState
          : {};
      }
      const detailsList = Array.from(this.doc.querySelectorAll('details[data-section]'));
      detailsList.forEach((details) => {
        if (!details) {
          return;
        }
        const sectionId = details.getAttribute('data-section');
        if (!sectionId) {
          return;
        }
        if (Object.prototype.hasOwnProperty.call(collapseState, sectionId)) {
          details.open = Boolean(collapseState[sectionId]);
        }
        details.addEventListener('toggle', () => {
          if (this.ui && typeof this.ui.queueSettingsPatch === 'function') {
            this.ui.queueSettingsPatch({
              userSettings: {
                ui: {
                  collapseState: {
                    [sectionId]: details.open
                  }
                }
              }
            });
          }
        });
      });
    }
  }

  class DebugPage {
    constructor({ doc, ui }) {
      this.doc = doc;
      this.ui = ui;
      this.reportExporter = global.NT && global.NT.ReportExporter
        ? new global.NT.ReportExporter({ doc: this.doc, win: global, chromeApi: global.chrome })
        : null;
      this.diffHighlighter = global.NT && global.NT.DiffHighlighter
        ? new global.NT.DiffHighlighter()
        : null;
      this.state = {
        tabId: null,
        url: '',
        origin: '',
        status: null,
        benchmarkStatus: null,
        benchmarks: {},
        modelLimitsBySpec: {},
        translationJob: null,
        translationProgress: 0,
        failedBlocksCount: 0,
        lastError: null,
        settings: null,
        agentState: null,
        selectedCategories: [],
        availableCategories: [],
        recentDiffItems: [],
        toolset: null,
        effectiveToolPolicy: {},
        serverCaps: null,
        schedulerRuntime: null,
        negotiation: null,
        security: {
          credentials: null,
          lastConnectionTest: null,
          lastAudit: null
        },
        translationDisplayMode: 'translated',
        eventLog: { seq: 0, items: [] },
        filters: { level: 'all', q: '', tag: 'all' },
        oldestSeq: null,
        compare: {
          search: '',
          status: 'all',
          selectedBlockId: null,
          selectedPatchSeq: null
        },
        classifier: {
          category: 'all',
          rule: ''
        },
        sessionsOnlyActive: false,
        autotune: {
          selectedProposalId: null
        },
        perfSnapshot: null,
        perfExportStatus: '—'
      };
      this.fields = {};
      this.pendingLoadOlderRequestId = null;
      this.renderTimer = null;
      this.initialSection = null;
      this.fixedTabId = null;
    }

    async init() {
      this.cacheElements();
      this.bindEventControls();
      new DetailsStateManager({ doc: this.doc, storageKeyPrefix: 'nt.ui.debug.details', ui: this.ui }).init();
      await this._migrateLegacyUiState();
      this.state = { ...this.state, ...this.readQuery() };
      this.fixedTabId = Number.isFinite(Number(this.state.tabId)) ? Number(this.state.tabId) : null;
      if (this.ui && typeof this.ui.setHelloContext === 'function') {
        this.ui.setHelloContext({ tabId: this.fixedTabId });
      }
      this.initialSection = this.state.section || null;
      if (this.initialSection) {
        this._openSection(this.initialSection);
      }
      this.render();
    }

    async _migrateLegacyUiState() {
      try {
        if (!global.localStorage) {
          return;
        }
        const markerKey = 'nt.ui.settings.v2.debug.migrated';
        if (global.localStorage.getItem(markerKey) === '1') {
          return;
        }
        const collapseState = {};
        const detailsList = Array.from(this.doc.querySelectorAll('details[data-section]'));
        detailsList.forEach((details) => {
          const sectionId = details && typeof details.getAttribute === 'function'
            ? details.getAttribute('data-section')
            : null;
          if (!sectionId) {
            return;
          }
          const key = `nt.ui.debug.details.${sectionId}`;
          const value = global.localStorage.getItem(key);
          if (value === '1') {
            collapseState[sectionId] = true;
          } else if (value === '0') {
            collapseState[sectionId] = false;
          }
        });
        if (Object.keys(collapseState).length) {
          this.ui.queueSettingsPatch({
            userSettings: {
              ui: {
                collapseState
              }
            }
          });
        }
        global.localStorage.setItem(markerKey, '1');
      } catch (_) {
        // best-effort migration only
      }
    }

    cacheElements() {
      this.fields.site = this.doc.querySelector('[data-field="site"]');
      this.fields.progress = this.doc.querySelector('[data-field="progress"]');
      this.fields.completed = this.doc.querySelector('[data-field="completed"]');
      this.fields.total = this.doc.querySelector('[data-field="total"]');
      this.fields.inProgress = this.doc.querySelector('[data-field="inProgress"]');
      this.fields.message = this.doc.querySelector('[data-field="message"]');
      this.fields.decisionPolicy = this.doc.querySelector('[data-field="decision-policy"]');
      this.fields.decisionModel = this.doc.querySelector('[data-field="decision-model"]');
      this.fields.decisionReason = this.doc.querySelector('[data-field="decision-reason"]');
      this.fields.translationJobId = this.doc.querySelector('[data-field="translation-job-id"]');
      this.fields.translationJobStatus = this.doc.querySelector('[data-field="translation-job-status"]');
      this.fields.runtimeStage = this.doc.querySelector('[data-field="runtime-stage"]');
      this.fields.runtimeLease = this.doc.querySelector('[data-field="runtime-lease"]');
      this.fields.runtimeRetry = this.doc.querySelector('[data-field="runtime-retry"]');
      this.fields.offscreenState = this.doc.querySelector('[data-field="offscreen-state"]');
      this.fields.schedulerSessions = this.doc.querySelector('[data-field="scheduler-sessions"]');
      this.fields.schedulerSessionsTable = this.doc.querySelector('[data-field="scheduler-sessions-table"]');
      this.fields.schedulerQueue = this.doc.querySelector('[data-field="scheduler-queue"]');
      this.fields.schedulerBudget = this.doc.querySelector('[data-field="scheduler-budget"]');
      this.fields.translationProgress = this.doc.querySelector('[data-field="translation-progress"]');
      this.fields.translationFailedCount = this.doc.querySelector('[data-field="translation-failed-count"]');
      this.fields.translationLastError = this.doc.querySelector('[data-field="translation-last-error"]');
      this.fields.translationLastErrorBaseUrl = this.doc.querySelector('[data-field="translation-last-error-base-url"]');
      this.fields.translationLastErrorTransport = this.doc.querySelector('[data-field="translation-last-error-transport"]');
      this.fields.translationLastErrorEndpointHost = this.doc.querySelector('[data-field="translation-last-error-endpoint-host"]');
      this.fields.translationLastErrorOnline = this.doc.querySelector('[data-field="translation-last-error-online"]');
      this.fields.translationLastErrorProbeStatus = this.doc.querySelector('[data-field="translation-last-error-probe-status"]');
      this.fields.translationLastErrorProbeError = this.doc.querySelector('[data-field="translation-last-error-probe-error"]');
      this.fields.translationLastErrorProbeSteps = this.doc.querySelector('[data-field="translation-last-error-probe-steps"]');
      this.fields.agentPhase = this.doc.querySelector('[data-field="agent-phase"]');
      this.fields.agentProfile = this.doc.querySelector('[data-field="agent-profile"]');
      this.fields.agentCategories = this.doc.querySelector('[data-field="agent-categories"]');
      this.fields.agentGlossarySize = this.doc.querySelector('[data-field="agent-glossary-size"]');
      this.fields.agentCompressions = this.doc.querySelector('[data-field="agent-compressions"]');
      this.fields.agentContextSummary = this.doc.querySelector('[data-field="agent-context-summary"]');
      this.fields.agentRateLast = this.doc.querySelector('[data-field="agent-rate-last"]');
      this.fields.agentRateHistory = this.doc.querySelector('[data-field="agent-rate-history"]');
      this.fields.agentChecklist = this.doc.querySelector('[data-field="agent-checklist"]');
      this.fields.agentTools = this.doc.querySelector('[data-field="agent-tools"]');
      this.fields.agentToolTrace = this.doc.querySelector('[data-field="agent-tool-trace"]');
      this.fields.agentReports = this.doc.querySelector('[data-field="agent-reports"]');
      this.fields.autotuneStatus = this.doc.querySelector('[data-field="autotune-status"]');
      this.fields.autotuneProposals = this.doc.querySelector('[data-field="autotune-proposals"]');
      this.fields.autotuneProposalDetails = this.doc.querySelector('[data-field="autotune-proposal-details"]');
      this.fields.settingsSchema = this.doc.querySelector('[data-field="settings-schema"]');
      this.fields.settingsProfile = this.doc.querySelector('[data-field="settings-profile"]');
      this.fields.settingsReasoning = this.doc.querySelector('[data-field="settings-reasoning"]');
      this.fields.settingsCache = this.doc.querySelector('[data-field="settings-cache"]');
      this.fields.settingsTools = this.doc.querySelector('[data-field="settings-tools"]');
      this.fields.settingsModels = this.doc.querySelector('[data-field="settings-models"]');
      this.fields.settingsOverrides = this.doc.querySelector('[data-field="settings-overrides"]');
      this.fields.toolsetHash = this.doc.querySelector('[data-field="toolset-hash"]');
      this.fields.capabilitiesSummary = this.doc.querySelector('[data-field="capabilities-summary"]');
      this.fields.memoryPageKey = this.doc.querySelector('[data-field="memory-page-key"]');
      this.fields.memoryDomHash = this.doc.querySelector('[data-field="memory-dom-hash"]');
      this.fields.memoryUrl = this.doc.querySelector('[data-field="memory-url"]');
      this.fields.memoryRestore = this.doc.querySelector('[data-field="memory-restore"]');
      this.fields.memoryOps = this.doc.querySelector('[data-field="memory-ops"]');
      this.fields.diffList = this.doc.querySelector('[data-field="diff-list"]');
      this.fields.patchEventsCount = this.doc.querySelector('[data-field="patch-events-count"]');
      this.fields.coalescedCount = this.doc.querySelector('[data-field="coalesced-count"]');
      this.fields.deltaApplyLatency = this.doc.querySelector('[data-field="delta-apply-latency"]');
      this.fields.compareSearch = this.doc.querySelector('[data-field="compare-search"]');
      this.fields.compareStatus = this.doc.querySelector('[data-field="compare-status"]');
      this.fields.compareBlocks = this.doc.querySelector('[data-field="compare-blocks"]');
      this.fields.diffOriginal = this.doc.querySelector('[data-field="diff-original"]');
      this.fields.diffTranslated = this.doc.querySelector('[data-field="diff-translated"]');
      this.fields.diffRendered = this.doc.querySelector('[data-field="diff-rendered"]');
      this.fields.patchTimeline = this.doc.querySelector('[data-field="patch-timeline"]');
      this.fields.patchDetails = this.doc.querySelector('[data-field="patch-details"]');
      this.fields.classifierSummary = this.doc.querySelector('[data-field="classifier-summary"]');
      this.fields.classifierBlocks = this.doc.querySelector('[data-field="classifier-blocks"]');
      this.fields.classifierCategoryFilter = this.doc.querySelector('[data-field="classifier-category-filter"]');
      this.fields.classifierRuleFilter = this.doc.querySelector('[data-field="classifier-rule-filter"]');
      this.fields.classifierReclassifyForce = this.doc.querySelector('[data-action="classifier-reclassify-force"]');
      this.fields.framesSummary = this.doc.querySelector('[data-field="frames-summary"]');
      this.fields.framesTable = this.doc.querySelector('[data-field="frames-table"]');
      this.fields.shadowSummary = this.doc.querySelector('[data-field="shadow-summary"]');
      this.fields.compareHighlightsSupported = this.doc.querySelector('[data-field="compare-highlights-supported"]');
      this.fields.compareModeActive = this.doc.querySelector('[data-field="compare-mode-active"]');
      this.fields.compareHighlightsCounters = this.doc.querySelector('[data-field="compare-highlights-counters"]');
      this.fields.recomputeHighlights = this.doc.querySelector('[data-action="recompute-highlights"]');
      this.fields.exportTextMode = this.doc.querySelector('[data-field="export-text-mode"]');
      this.fields.exportJson = this.doc.querySelector('[data-action="export-json"]');
      this.fields.exportHtml = this.doc.querySelector('[data-action="export-html"]');
      this.fields.exportCopy = this.doc.querySelector('[data-action="export-copy"]');
      this.fields.copyDiagnostics = this.doc.querySelector('[data-action="copy-diagnostics"]');
      this.fields.exportStatus = this.doc.querySelector('[data-field="export-status"]');
      this.fields.securityAuditButton = this.doc.querySelector('[data-action="security-audit"]');
      this.fields.securityCredentials = this.doc.querySelector('[data-field="security-credentials"]');
      this.fields.securityTestConnection = this.doc.querySelector('[data-field="security-test-connection"]');
      this.fields.securityAuditStatus = this.doc.querySelector('[data-field="security-audit-status"]');
      this.fields.securityAuditReport = this.doc.querySelector('[data-field="security-audit-report"]');
      this.fields.benchStatus = this.doc.querySelector('[data-field="bench-status"]');
      this.fields.benchCurrent = this.doc.querySelector('[data-field="bench-current"]');
      this.fields.benchMessage = this.doc.querySelector('[data-field="bench-message"]');
      this.fields.benchTable = this.doc.querySelector('[data-field="bench-table"]');
      this.fields.rateCurrentModel = this.doc.querySelector('[data-field="rate-current-model"]');
      this.fields.rateTable = this.doc.querySelector('[data-field="rate-table"]');
      this.fields.eventLevel = this.doc.querySelector('[data-field="event-level"]');
      this.fields.eventTag = this.doc.querySelector('[data-field="event-tag"]');
      this.fields.eventSearch = this.doc.querySelector('[data-field="event-search"]');
      this.fields.eventLog = this.doc.querySelector('[data-field="event-log"]');
      this.fields.eventCopy = this.doc.querySelector('[data-action="event-copy"]');
      this.fields.eventClear = this.doc.querySelector('[data-action="event-clear"]');
      this.fields.eventOlder = this.doc.querySelector('[data-action="event-older"]');
      this.fields.kickScheduler = this.doc.querySelector('[data-action="kick-scheduler"]');
      this.fields.pauseOtherTabs = this.doc.querySelector('[data-action="pause-other-tabs"]');
      this.fields.sessionsOnlyActive = this.doc.querySelector('[data-field="sessions-only-active"]');
      this.fields.perfSummary = this.doc.querySelector('[data-field="perf-summary"]');
      this.fields.perfGlobalTable = this.doc.querySelector('[data-field="perf-global-table"]');
      this.fields.perfJobsTable = this.doc.querySelector('[data-field="perf-jobs-table"]');
      this.fields.perfExportStatus = this.doc.querySelector('[data-field="perf-export-status"]');
      this.fields.exportPerfSnapshot = this.doc.querySelector('[data-action="export-perf-snapshot"]');
    }

    readQuery() {
      const params = new URLSearchParams(global.location.search);
      const tabId = Number(params.get('tabId'));
      const url = params.get('url') || '';
      const section = params.get('section') || '';
      let origin = '';
      if (url) {
        try {
          origin = new URL(url).origin;
        } catch (error) {
          origin = url;
        }
      }
      return {
        tabId: Number.isFinite(tabId) ? tabId : null,
        url,
        origin,
        section: section || null
      };
    }

    applySnapshot(payload) {
      if (!payload) {
        return;
      }
      if (payload.settings && typeof payload.settings === 'object') {
        this.state.settings = this._mergeObjects(this.state.settings || {}, payload.settings);
      }
      if (this.fixedTabId === null && payload.tabId !== null && payload.tabId !== undefined) {
        this.state.tabId = payload.tabId;
      }
      if (payload.translationStatusByTab) {
        this.state.status = this.state.tabId !== null ? payload.translationStatusByTab[this.state.tabId] || null : null;
      }
      if (payload.translationDisplayModeByTab && this.state.tabId !== null) {
        const map = payload.translationDisplayModeByTab;
        if (Object.prototype.hasOwnProperty.call(map, this.state.tabId)) {
          this.state.translationDisplayMode = this._normalizeDisplayMode(map[this.state.tabId]);
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'modelBenchmarkStatus')) {
        this.state.benchmarkStatus = payload.modelBenchmarkStatus || null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'modelBenchmarks')) {
        this.state.benchmarks = payload.modelBenchmarks || {};
      }
      if (payload.modelLimitsBySpec) {
        this.state.modelLimitsBySpec = payload.modelLimitsBySpec || {};
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'translationJob')) {
        this.state.translationJob = payload.translationJob || null;
        this.state.autotune.selectedProposalId = null;
        if (this.state.translationJob && this.state.translationJob.displayMode) {
          this.state.translationDisplayMode = this._normalizeDisplayMode(this.state.translationJob.displayMode);
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'translationProgress')) {
        this.state.translationProgress = Number(payload.translationProgress || 0);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'failedBlocksCount')) {
        this.state.failedBlocksCount = Number(payload.failedBlocksCount || 0);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'lastError')) {
        this.state.lastError = payload.lastError || null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'agentState')) {
        this.state.agentState = payload.agentState || null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'selectedCategories')) {
        this.state.selectedCategories = Array.isArray(payload.selectedCategories) ? payload.selectedCategories : [];
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'availableCategories')) {
        this.state.availableCategories = Array.isArray(payload.availableCategories) ? payload.availableCategories : [];
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'recentDiffItems')) {
        this.state.recentDiffItems = Array.isArray(payload.recentDiffItems) ? payload.recentDiffItems : [];
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'toolset')) {
        this.state.toolset = payload.toolset && typeof payload.toolset === 'object' ? payload.toolset : null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'effectiveToolPolicy')) {
        this.state.effectiveToolPolicy = payload.effectiveToolPolicy && typeof payload.effectiveToolPolicy === 'object'
          ? payload.effectiveToolPolicy
          : {};
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'serverCaps')) {
        this.state.serverCaps = payload.serverCaps && typeof payload.serverCaps === 'object'
          ? payload.serverCaps
          : null;
        this.state.schedulerRuntime = this.state.serverCaps
          && this.state.serverCaps.schedulerRuntime
          && typeof this.state.serverCaps.schedulerRuntime === 'object'
          ? this.state.serverCaps.schedulerRuntime
          : null;
        if (
          this.state.serverCaps
          && this.state.serverCaps.perf
          && typeof this.state.serverCaps.perf === 'object'
        ) {
          this.state.perfSnapshot = this.state.serverCaps.perf;
        }
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'perfSnapshot')) {
        this.state.perfSnapshot = payload.perfSnapshot && typeof payload.perfSnapshot === 'object'
          ? payload.perfSnapshot
          : this.state.perfSnapshot;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'negotiation')) {
        this.state.negotiation = payload.negotiation && typeof payload.negotiation === 'object'
          ? payload.negotiation
          : null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'security')) {
        const sec = payload.security && typeof payload.security === 'object' ? payload.security : {};
        this.state.security = {
          credentials: sec.credentials && typeof sec.credentials === 'object' ? sec.credentials : null,
          lastConnectionTest: sec.lastConnectionTest && typeof sec.lastConnectionTest === 'object' ? sec.lastConnectionTest : null,
          lastAudit: sec.lastAudit && typeof sec.lastAudit === 'object' ? sec.lastAudit : null
        };
      }
      if (payload.eventLog) {
        this._mergeEventLogSnapshot(payload.eventLog.items || []);
        this.state.eventLog.seq = typeof payload.eventLog.seq === 'number' ? payload.eventLog.seq : this.state.eventLog.seq;
      }

      if (this.state.status) {
        if (this.state.status.agentState) {
          this.state.agentState = this.state.status.agentState;
        }
        if (Array.isArray(this.state.status.selectedCategories) && this.state.status.selectedCategories.length) {
          this.state.selectedCategories = this.state.status.selectedCategories;
        }
        if (Array.isArray(this.state.status.availableCategories) && this.state.status.availableCategories.length) {
          this.state.availableCategories = this.state.status.availableCategories;
        }
        if (Array.isArray(this.state.status.recentDiffItems) && this.state.status.recentDiffItems.length) {
          this.state.recentDiffItems = this.state.status.recentDiffItems;
        }
      }

      if (this.ui.portClient && typeof this.ui.portClient.acknowledgeSnapshot === 'function') {
        this.ui.portClient.acknowledgeSnapshot();
      }
      this.render();
    }

    applyPatch(payload) {
      if (!payload) {
        return;
      }
      const patch = payload.patch && typeof payload.patch === 'object'
        ? payload.patch
        : payload;
      const mergedPatch = patch && patch.settings && typeof patch.settings === 'object'
        ? { ...patch.settings, ...patch }
        : patch;

      if (mergedPatch.translationStatusByTab) {
        this.state.status = this.state.tabId !== null ? mergedPatch.translationStatusByTab[this.state.tabId] || null : null;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'translationDisplayModeByTab') && this.state.tabId !== null) {
        const map = mergedPatch.translationDisplayModeByTab || {};
        if (Object.prototype.hasOwnProperty.call(map, this.state.tabId)) {
          this.state.translationDisplayMode = this._normalizeDisplayMode(map[this.state.tabId]);
        }
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'modelBenchmarkStatus')) {
        this.state.benchmarkStatus = mergedPatch.modelBenchmarkStatus || null;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'modelBenchmarks')) {
        this.state.benchmarks = mergedPatch.modelBenchmarks || {};
      }

      if (mergedPatch.modelLimitsBySpec) {
        this.state.modelLimitsBySpec = mergedPatch.modelLimitsBySpec || {};
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'translationJob')) {
        this.state.translationJob = mergedPatch.translationJob || null;
        this.state.autotune.selectedProposalId = null;
        if (this.state.translationJob && this.state.translationJob.displayMode) {
          this.state.translationDisplayMode = this._normalizeDisplayMode(this.state.translationJob.displayMode);
        }
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'translationProgress')) {
        this.state.translationProgress = Number(mergedPatch.translationProgress || 0);
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'failedBlocksCount')) {
        this.state.failedBlocksCount = Number(mergedPatch.failedBlocksCount || 0);
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'lastError')) {
        this.state.lastError = mergedPatch.lastError || null;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'agentState')) {
        this.state.agentState = mergedPatch.agentState || null;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'selectedCategories')) {
        this.state.selectedCategories = Array.isArray(mergedPatch.selectedCategories) ? mergedPatch.selectedCategories : [];
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'availableCategories')) {
        this.state.availableCategories = Array.isArray(mergedPatch.availableCategories) ? mergedPatch.availableCategories : [];
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'recentDiffItems')) {
        this.state.recentDiffItems = Array.isArray(mergedPatch.recentDiffItems) ? mergedPatch.recentDiffItems : [];
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'toolset')) {
        this.state.toolset = mergedPatch.toolset && typeof mergedPatch.toolset === 'object'
          ? mergedPatch.toolset
          : this.state.toolset;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'effectiveToolPolicy')) {
        this.state.effectiveToolPolicy = mergedPatch.effectiveToolPolicy && typeof mergedPatch.effectiveToolPolicy === 'object'
          ? mergedPatch.effectiveToolPolicy
          : this.state.effectiveToolPolicy;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'serverCaps')) {
        this.state.serverCaps = mergedPatch.serverCaps && typeof mergedPatch.serverCaps === 'object'
          ? mergedPatch.serverCaps
          : this.state.serverCaps;
        this.state.schedulerRuntime = this.state.serverCaps
          && this.state.serverCaps.schedulerRuntime
          && typeof this.state.serverCaps.schedulerRuntime === 'object'
          ? this.state.serverCaps.schedulerRuntime
          : this.state.schedulerRuntime;
        if (
          this.state.serverCaps
          && this.state.serverCaps.perf
          && typeof this.state.serverCaps.perf === 'object'
        ) {
          this.state.perfSnapshot = this.state.serverCaps.perf;
        }
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'perfSnapshot')) {
        this.state.perfSnapshot = mergedPatch.perfSnapshot && typeof mergedPatch.perfSnapshot === 'object'
          ? mergedPatch.perfSnapshot
          : this.state.perfSnapshot;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'negotiation')) {
        this.state.negotiation = mergedPatch.negotiation && typeof mergedPatch.negotiation === 'object'
          ? mergedPatch.negotiation
          : this.state.negotiation;
      }
      if (Object.prototype.hasOwnProperty.call(mergedPatch, 'security')) {
        const sec = mergedPatch.security && typeof mergedPatch.security === 'object' ? mergedPatch.security : {};
        this.state.security = {
          credentials: sec.credentials && typeof sec.credentials === 'object'
            ? sec.credentials
            : (this.state.security ? this.state.security.credentials : null),
          lastConnectionTest: sec.lastConnectionTest && typeof sec.lastConnectionTest === 'object'
            ? sec.lastConnectionTest
            : (this.state.security ? this.state.security.lastConnectionTest : null),
          lastAudit: sec.lastAudit && typeof sec.lastAudit === 'object'
            ? sec.lastAudit
            : (this.state.security ? this.state.security.lastAudit : null)
        };
      }
      if (
        Object.prototype.hasOwnProperty.call(mergedPatch, 'schemaVersion')
        || Object.prototype.hasOwnProperty.call(mergedPatch, 'userSettings')
        || Object.prototype.hasOwnProperty.call(mergedPatch, 'effectiveSettings')
        || Object.prototype.hasOwnProperty.call(mergedPatch, 'overrides')
      ) {
        this.state.settings = this._mergeObjects(this.state.settings || {}, {
          schemaVersion: mergedPatch.schemaVersion,
          userSettings: mergedPatch.userSettings,
          effectiveSettings: mergedPatch.effectiveSettings,
          overrides: mergedPatch.overrides
        });
      }

      if (this.state.status) {
        if (this.state.status.agentState) {
          this.state.agentState = this.state.status.agentState;
        }
        if (Array.isArray(this.state.status.selectedCategories) && this.state.status.selectedCategories.length) {
          this.state.selectedCategories = this.state.status.selectedCategories;
        }
        if (Array.isArray(this.state.status.availableCategories) && this.state.status.availableCategories.length) {
          this.state.availableCategories = this.state.status.availableCategories;
        }
        if (Array.isArray(this.state.status.recentDiffItems) && this.state.status.recentDiffItems.length) {
          this.state.recentDiffItems = this.state.status.recentDiffItems;
        }
      }

      if (mergedPatch.eventLogAppend && mergedPatch.eventLogAppend.item) {
        const entry = mergedPatch.eventLogAppend.item;
        const exists = this.state.eventLog.items.some((item) => item && item.seq === entry.seq);
        if (!exists) {
          this.state.eventLog.items.push(entry);
          this.state.eventLog.items.sort((a, b) => (a.seq || 0) - (b.seq || 0));
          if (this.state.eventLog.items.length > 800) {
            this.state.eventLog.items = this.state.eventLog.items.slice(-800);
          }
          this.state.oldestSeq = this.state.eventLog.items.length ? this.state.eventLog.items[0].seq : null;
        }
        this.state.eventLog.seq = Math.max(this.state.eventLog.seq || 0, mergedPatch.eventLogAppend.seq || 0);
        this.scheduleEventRender();
      }

      if (mergedPatch.eventLogReset) {
        this.state.eventLog = { seq: this.state.eventLog.seq || 0, items: [] };
        this.state.oldestSeq = null;
        this.scheduleEventRender();
      }

      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      if (payload.type === UiProtocol.UI_EVENT_LOG_PAGE_RESULT) {
        if (!this.pendingLoadOlderRequestId || payload.requestId !== this.pendingLoadOlderRequestId) {
          return;
        }
        this.pendingLoadOlderRequestId = null;
        const incoming = Array.isArray(payload.items) ? payload.items : [];
        const existing = new Set(this.state.eventLog.items.map((item) => item.seq));
        const merged = incoming.filter((item) => item && !existing.has(item.seq)).concat(this.state.eventLog.items);
        merged.sort((a, b) => (a.seq || 0) - (b.seq || 0));
        this.state.eventLog.items = merged;
        this.state.oldestSeq = merged.length ? merged[0].seq : null;
        this.scheduleEventRender();
      }

      this.renderStatus();
      this.renderRuntimeTooling();
      this.renderTranslationJob();
      this.renderFramesShadow();
      this.renderCompareRendering();
      this.renderPerf();
      this.renderClassifier();
      this.renderAgent();
      this.renderSettingsSummary();
      this.renderMemory();
      this.renderDiff();
      this.renderCompareAndPatches();
      this.renderBenchmarks();
      this.renderRateLimits();
    }

    _mergeEventLogSnapshot(items) {
      const incoming = Array.isArray(items) ? items : [];
      const map = new Map();
      this.state.eventLog.items.forEach((item) => {
        if (item && typeof item.seq === 'number') {
          map.set(item.seq, item);
        }
      });
      incoming.forEach((item) => {
        if (item && typeof item.seq === 'number') {
          map.set(item.seq, item);
        }
      });
      this.state.eventLog.items = Array.from(map.values()).sort((a, b) => a.seq - b.seq);
      this.state.oldestSeq = this.state.eventLog.items.length ? this.state.eventLog.items[0].seq : null;
    }

    bindEventControls() {
      if (this.fields.eventLevel) {
        this.fields.eventLevel.addEventListener('change', () => {
          this.state.filters.level = this.fields.eventLevel.value || 'all';
          this.renderEventLog();
        });
      }
      if (this.fields.eventTag) {
        this.fields.eventTag.addEventListener('change', () => {
          this.state.filters.tag = this.fields.eventTag.value || 'all';
          this.renderEventLog();
        });
      }
      if (this.fields.eventSearch) {
        this.fields.eventSearch.addEventListener('input', () => {
          this.state.filters.q = this.fields.eventSearch.value || '';
          this.renderEventLog();
        });
      }
      if (this.fields.eventCopy) {
        this.fields.eventCopy.addEventListener('click', () => this.copyEventJson());
      }
      if (this.fields.eventClear) {
        this.fields.eventClear.addEventListener('click', () => {
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.CLEAR_EVENT_LOG
            : 'CLEAR_EVENT_LOG';
          this.ui.sendUiCommand(command, {});
        });
      }
      if (this.fields.eventOlder) {
        this.fields.eventOlder.addEventListener('click', () => this.loadOlderEvents());
      }
      if (this.fields.kickScheduler) {
        this.fields.kickScheduler.addEventListener('click', () => {
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.KICK_SCHEDULER
            : 'KICK_SCHEDULER';
          this.ui.sendUiCommand(command, {});
        });
      }
      if (this.fields.pauseOtherTabs) {
        this.fields.pauseOtherTabs.addEventListener('click', () => {
          const runtime = this.state.schedulerRuntime && typeof this.state.schedulerRuntime === 'object'
            ? this.state.schedulerRuntime
            : {};
          const queue = runtime.queueStats && typeof runtime.queueStats === 'object'
            ? runtime.queueStats
            : {};
          const nextEnabled = !(queue.pauseOtherTabs === true);
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.SET_PAUSE_OTHER_TABS
            : 'SET_PAUSE_OTHER_TABS';
          this.ui.sendUiCommand(command, { enabled: nextEnabled });
        });
      }
      if (this.fields.sessionsOnlyActive) {
        this.fields.sessionsOnlyActive.addEventListener('change', () => {
          this.state.sessionsOnlyActive = this.fields.sessionsOnlyActive.checked === true;
          this.renderTranslationJob();
        });
      }
      if (this.fields.compareSearch) {
        this.fields.compareSearch.addEventListener('input', () => {
          this.state.compare.search = this.fields.compareSearch.value || '';
          this.renderCompareAndPatches();
        });
      }
      if (this.fields.compareStatus) {
        this.fields.compareStatus.addEventListener('change', () => {
          this.state.compare.status = this.fields.compareStatus.value || 'all';
          this.renderCompareAndPatches();
        });
      }
      if (this.fields.classifierCategoryFilter) {
        this.fields.classifierCategoryFilter.addEventListener('change', () => {
          this.state.classifier.category = this.fields.classifierCategoryFilter.value || 'all';
          this.renderClassifier();
        });
      }
      if (this.fields.classifierRuleFilter) {
        this.fields.classifierRuleFilter.addEventListener('input', () => {
          this.state.classifier.rule = this.fields.classifierRuleFilter.value || '';
          this.renderClassifier();
        });
      }
      if (this.fields.classifierReclassifyForce) {
        this.fields.classifierReclassifyForce.addEventListener('click', () => {
          const tabIdCandidate = Number.isFinite(Number(this.state.tabId))
            ? Number(this.state.tabId)
            : (this.state.translationJob && Number.isFinite(Number(this.state.translationJob.tabId))
              ? Number(this.state.translationJob.tabId)
              : null);
          if (!Number.isFinite(tabIdCandidate)) {
            return;
          }
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.RECLASSIFY_BLOCKS
            : 'RECLASSIFY_BLOCKS';
          const jobId = this.state.translationJob && this.state.translationJob.id
            ? this.state.translationJob.id
            : null;
          this.ui.sendUiCommand(command, {
            tabId: tabIdCandidate,
            jobId,
            force: true
          });
        });
      }
      if (this.fields.recomputeHighlights) {
        this.fields.recomputeHighlights.addEventListener('click', () => {
          const tabIdCandidate = Number.isFinite(Number(this.state.tabId))
            ? Number(this.state.tabId)
            : (this.state.translationJob && Number.isFinite(Number(this.state.translationJob.tabId))
              ? Number(this.state.translationJob.tabId)
              : null);
          if (!Number.isFinite(tabIdCandidate)) {
            return;
          }
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.SET_TRANSLATION_VISIBILITY
            : 'SET_TRANSLATION_VISIBILITY';
          this.ui.sendUiCommand(command, {
            tabId: tabIdCandidate,
            mode: 'compare',
            visible: true
          });
        });
      }
      if (this.fields.compareBlocks) {
        this.fields.compareBlocks.addEventListener('click', (event) => {
          const target = event && event.target && typeof event.target.closest === 'function'
            ? event.target.closest('[data-action]')
            : null;
          if (!target) {
            return;
          }
          const action = target.getAttribute('data-action');
          const blockId = target.getAttribute('data-block-id');
          if (!blockId) {
            return;
          }
          if (action === 'open-compare-block') {
            this.state.compare.selectedBlockId = blockId;
            this.state.compare.selectedPatchSeq = null;
            this.renderCompareAndPatches();
            return;
          }
          if (action === 'request-block-action') {
            const proofAction = target.getAttribute('data-proof-action') === 'literal'
              ? 'literal'
              : 'style_improve';
            this.requestBlockAction(blockId, proofAction);
          }
        });
      }
      if (this.fields.patchTimeline) {
        this.fields.patchTimeline.addEventListener('click', (event) => {
          const target = event && event.target && typeof event.target.closest === 'function'
            ? event.target.closest('[data-action="open-patch"]')
            : null;
          if (!target) {
            return;
          }
          const seq = Number(target.getAttribute('data-patch-seq'));
          if (!Number.isFinite(seq)) {
            return;
          }
          this.state.compare.selectedPatchSeq = seq;
          this.renderCompareAndPatches();
        });
      }
      if (this.fields.autotuneProposals) {
        this.fields.autotuneProposals.addEventListener('click', (event) => {
          const target = event && event.target && typeof event.target.closest === 'function'
            ? event.target.closest('[data-action="open-autotune-proposal"]')
            : null;
          if (!target) {
            return;
          }
          const proposalId = target.getAttribute('data-proposal-id');
          if (!proposalId) {
            return;
          }
          this.state.autotune.selectedProposalId = proposalId;
          this.renderAgent();
        });
      }
      if (this.fields.exportJson) {
        this.fields.exportJson.addEventListener('click', () => this.exportReport('json'));
      }
      if (this.fields.exportHtml) {
        this.fields.exportHtml.addEventListener('click', () => this.exportReport('html'));
      }
      if (this.fields.exportCopy) {
        this.fields.exportCopy.addEventListener('click', () => this.exportReport('copy'));
      }
      if (this.fields.copyDiagnostics) {
        this.fields.copyDiagnostics.addEventListener('click', () => {
          this.copyDiagnostics();
        });
      }
      if (this.fields.exportPerfSnapshot) {
        this.fields.exportPerfSnapshot.addEventListener('click', () => {
          this.exportPerfSnapshot();
        });
      }
      if (this.fields.securityAuditButton) {
        this.fields.securityAuditButton.addEventListener('click', () => {
          if (typeof this.ui.runSecurityAudit === 'function') {
            this.ui.runSecurityAudit();
            this.renderSecurity({ pending: true });
          } else {
            const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
            const command = UiProtocol && UiProtocol.Commands
              ? UiProtocol.Commands.RUN_SECURITY_AUDIT
              : 'RUN_SECURITY_AUDIT';
            this.ui.sendUiCommand(command, {});
          }
        });
      }
    }

    loadOlderEvents() {
      const oldest = this.state.oldestSeq || (this.state.eventLog.items.length ? this.state.eventLog.items[0].seq : null);
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.EVENT_LOG_PAGE
        : 'EVENT_LOG_PAGE';
      const requestId = this.ui.sendUiCommand(command, { beforeSeq: oldest, limit: 200 }, {});
      this.pendingLoadOlderRequestId = requestId;
    }

    render() {
      if (this.fields.site) {
        this.fields.site.textContent = `Сайт: ${this.state.origin || '—'}`;
      }
      this.renderStatus();
      this.renderRuntimeTooling();
      this.renderTranslationJob();
      this.renderFramesShadow();
      this.renderCompareRendering();
      this.renderPerf();
      this.renderClassifier();
      this.renderAgent();
      this.renderSettingsSummary();
      this.renderMemory();
      this.renderDiff();
      this.renderCompareAndPatches();
      this.renderSecurity();
      this.renderBenchmarks();
      this.renderRateLimits();
      this.renderEventLog();
    }

    renderStatus() {
      const status = this.state.status || {};
      if (this.fields.progress) {
        this.fields.progress.value = Math.max(0, Math.min(100, Number(status.progress || 0)));
      }
      if (this.fields.completed) {
        this.fields.completed.textContent = String(status.completed || 0);
      }
      if (this.fields.total) {
        this.fields.total.textContent = String(status.total || 0);
      }
      if (this.fields.inProgress) {
        this.fields.inProgress.textContent = String(status.inProgress || 0);
      }
      if (this.fields.message) {
        this.fields.message.textContent = status.message || status.status || 'нет данных';
      }
      const md = status.modelDecision || {};
      if (this.fields.decisionPolicy) {
        this.fields.decisionPolicy.textContent = md.decision && md.decision.policy ? md.decision.policy : '—';
      }
      if (this.fields.decisionModel) {
        this.fields.decisionModel.textContent = md.chosenModelSpec || '—';
      }
      if (this.fields.decisionReason) {
        this.fields.decisionReason.textContent = md.decision && md.decision.reason ? md.decision.reason : '—';
      }
    }

    renderRuntimeTooling() {
      const toolset = this.state.toolset && typeof this.state.toolset === 'object'
        ? this.state.toolset
        : null;
      const serverCaps = this.state.serverCaps && typeof this.state.serverCaps === 'object'
        ? this.state.serverCaps
        : null;
      const capsSummary = serverCaps && serverCaps.capabilitiesSummary && typeof serverCaps.capabilitiesSummary === 'object'
        ? serverCaps.capabilitiesSummary
        : null;
      const negotiation = this.state.negotiation && typeof this.state.negotiation === 'object'
        ? this.state.negotiation
        : null;
      const negotiationResult = negotiation && negotiation.result && typeof negotiation.result === 'object'
        ? negotiation.result
        : null;

      if (this.fields.toolsetHash) {
        this.fields.toolsetHash.textContent = toolset && toolset.toolsetHash ? toolset.toolsetHash : '—';
      }
      if (this.fields.capabilitiesSummary) {
        if (!capsSummary) {
          this.fields.capabilitiesSummary.textContent = '—';
          return;
        }
        const content = capsSummary.content && typeof capsSummary.content === 'object' ? capsSummary.content : {};
        const offscreen = capsSummary.offscreen && typeof capsSummary.offscreen === 'object' ? capsSummary.offscreen : {};
        const compareDiffThreshold = this.state.settings && Number.isFinite(Number(this.state.settings.translationCompareDiffThreshold))
          ? Math.max(500, Math.min(50000, Math.round(Number(this.state.settings.translationCompareDiffThreshold))))
          : null;
        const line = [
          `content.apply_delta=${content.supportsApplyDelta === false ? 'off' : 'on'}`,
          `offscreen.stream=${offscreen.supportsStream === false ? 'off' : 'on'}`,
          `offscreen.abort=${offscreen.supportsAbort === false ? 'off' : 'on'}`,
          `selector=${content.selectorStability || 'unknown'}`,
          compareDiffThreshold !== null ? `compare.threshold=${compareDiffThreshold}` : '',
          negotiationResult && negotiationResult.action ? `negotiation=${negotiationResult.action}` : ''
        ].filter(Boolean).join(' | ');
        this.fields.capabilitiesSummary.textContent = line || '—';
      }
    }

    renderTranslationJob() {
      const job = this.state.translationJob || null;
      const status = this.state.status && typeof this.state.status === 'object'
        ? this.state.status
        : null;
      const runtime = job && job.runtime && typeof job.runtime === 'object'
        ? job.runtime
        : (status && status.runtime && typeof status.runtime === 'object'
          ? status.runtime
          : null);
      const offscreen = this.state.serverCaps && this.state.serverCaps.offscreen && typeof this.state.serverCaps.offscreen === 'object'
        ? this.state.serverCaps.offscreen
        : null;
      const schedulerRuntime = this.state.schedulerRuntime && typeof this.state.schedulerRuntime === 'object'
        ? this.state.schedulerRuntime
        : {};
      const queueStats = schedulerRuntime.queueStats && typeof schedulerRuntime.queueStats === 'object'
        ? schedulerRuntime.queueStats
        : {};
      const tabSessions = Array.isArray(schedulerRuntime.tabSessions)
        ? schedulerRuntime.tabSessions
        : [];
      const sessionsOnlyActive = this.state.sessionsOnlyActive === true;
      const visibleSessions = sessionsOnlyActive
        ? tabSessions.filter((item) => item && item.activeJobId)
        : tabSessions;
      const activeJobs = Array.isArray(schedulerRuntime.activeJobs)
        ? schedulerRuntime.activeJobs
        : [];
      const activeJobsByTab = {};
      activeJobs.forEach((row) => {
        const tab = Number.isFinite(Number(row && row.tabId)) ? Number(row.tabId) : null;
        if (tab === null) {
          return;
        }
        activeJobsByTab[tab] = row;
      });
      const budget = schedulerRuntime.budget && typeof schedulerRuntime.budget === 'object'
        ? schedulerRuntime.budget
        : null;
      if (this.fields.translationJobId) {
        this.fields.translationJobId.textContent = job && job.id ? job.id : '—';
      }
      if (this.fields.translationJobStatus) {
        this.fields.translationJobStatus.textContent = job && job.status ? this._jobStatusLabel(job.status) : '—';
      }
      if (this.fields.runtimeStage) {
        this.fields.runtimeStage.textContent = runtime && runtime.stage ? String(runtime.stage) : '—';
      }
      if (this.fields.runtimeLease) {
        const leaseTs = runtime && runtime.lease && Number.isFinite(Number(runtime.lease.leaseUntilTs))
          ? Number(runtime.lease.leaseUntilTs)
          : null;
        if (!leaseTs) {
          this.fields.runtimeLease.textContent = '—';
        } else {
          const leftMs = Math.max(0, leaseTs - Date.now());
          this.fields.runtimeLease.textContent = `${this.formatTs(leaseTs)} (через ${Math.ceil(leftMs / 1000)}с)`;
        }
      }
      if (this.fields.runtimeRetry) {
        const attempt = runtime && runtime.retry && Number.isFinite(Number(runtime.retry.attempt))
          ? Number(runtime.retry.attempt)
          : 0;
        const nextRetryAtTs = runtime && runtime.retry && Number.isFinite(Number(runtime.retry.nextRetryAtTs))
          ? Number(runtime.retry.nextRetryAtTs)
          : 0;
        const lastCode = runtime && runtime.retry && runtime.retry.lastError && runtime.retry.lastError.code
          ? runtime.retry.lastError.code
          : null;
        if (!attempt && !nextRetryAtTs && !lastCode) {
          this.fields.runtimeRetry.textContent = '—';
        } else {
          const nextText = nextRetryAtTs ? this.formatTs(nextRetryAtTs) : '—';
          this.fields.runtimeRetry.textContent = `attempt=${attempt} next=${nextText}${lastCode ? ` code=${lastCode}` : ''}`;
        }
      }
      if (this.fields.offscreenState) {
        if (!offscreen) {
          this.fields.offscreenState.textContent = '—';
        } else {
          const connected = offscreen.connected === false ? 'disconnected' : 'connected';
          const active = Number.isFinite(Number(offscreen.activeRequestsCount))
            ? Number(offscreen.activeRequestsCount)
            : 0;
          this.fields.offscreenState.textContent = `${connected}, active=${active}`;
        }
      }
      if (this.fields.schedulerSessions) {
        const activeSessions = tabSessions.filter((item) => item && item.activeJobId).length;
        this.fields.schedulerSessions.textContent = `${tabSessions.length} tabs, active=${activeSessions}${sessionsOnlyActive ? ' (filter)' : ''}`;
      }
      if (this.fields.sessionsOnlyActive) {
        this.fields.sessionsOnlyActive.checked = sessionsOnlyActive;
      }
      if (this.fields.schedulerSessionsTable) {
        this.fields.schedulerSessionsTable.innerHTML = '';
        if (!visibleSessions.length) {
          const emptyRow = this.doc.createElement('tr');
          const emptyCell = this.doc.createElement('td');
          emptyCell.colSpan = 8;
          emptyCell.textContent = '—';
          emptyRow.appendChild(emptyCell);
          this.fields.schedulerSessionsTable.appendChild(emptyRow);
        } else {
          visibleSessions.forEach((session) => {
            const tabId = Number.isFinite(Number(session && session.tabId)) ? Number(session.tabId) : null;
            const jobRow = tabId !== null ? activeJobsByTab[tabId] : null;
            const tr = this.doc.createElement('tr');
            const cells = [
              tabId === null ? '—' : String(tabId),
              session && session.normalizedUrl
                ? String(session.normalizedUrl).slice(0, 90)
                : (session && session.url ? String(session.url).slice(0, 90) : '—'),
              jobRow && jobRow.id ? String(jobRow.id) : (session && session.activeJobId ? String(session.activeJobId) : '—'),
              jobRow && jobRow.stage ? String(jobRow.stage) : (session && session.state ? String(session.state) : '—'),
              jobRow && jobRow.status ? String(jobRow.status) : (session && session.state ? String(session.state) : '—'),
              jobRow && jobRow.leaseUntilTs ? this.formatTs(jobRow.leaseUntilTs) : '—',
              jobRow && jobRow.nextRetryAtTs ? this.formatTs(jobRow.nextRetryAtTs) : '—',
              jobRow && jobRow.lastErrorCode ? String(jobRow.lastErrorCode) : '—'
            ];
            cells.forEach((text) => {
              const td = this.doc.createElement('td');
              td.textContent = text;
              tr.appendChild(td);
            });
            this.fields.schedulerSessionsTable.appendChild(tr);
          });
        }
      }
      if (this.fields.schedulerQueue) {
        const queued = Number.isFinite(Number(queueStats.queuedCount)) ? Number(queueStats.queuedCount) : 0;
        const waiting = Number.isFinite(Number(queueStats.waitingCount)) ? Number(queueStats.waitingCount) : 0;
        const running = Number.isFinite(Number(queueStats.runningCount)) ? Number(queueStats.runningCount) : 0;
        const pause = queueStats.pauseOtherTabs === true ? 'pause=on' : 'pause=off';
        this.fields.schedulerQueue.textContent = `q=${queued} w=${waiting} r=${running} ${pause}`;
      }
      if (this.fields.schedulerBudget) {
        if (!budget) {
          this.fields.schedulerBudget.textContent = '—';
        } else {
          const remReq = budget.requestsRemaining === null || budget.requestsRemaining === undefined ? '—' : String(budget.requestsRemaining);
          const remTok = budget.tokensRemaining === null || budget.tokensRemaining === undefined ? '—' : String(budget.tokensRemaining);
          const cool = budget.cooldownUntilTs ? this.formatTs(budget.cooldownUntilTs) : '—';
          this.fields.schedulerBudget.textContent = `req=${remReq} tok=${remTok} cooldown=${cool}`;
        }
      }
      if (this.fields.pauseOtherTabs) {
        this.fields.pauseOtherTabs.textContent = queueStats.pauseOtherTabs === true
          ? 'Возобновить другие вкладки'
          : 'Пауза других вкладок';
      }
      if (this.fields.translationProgress) {
        const progress = Number.isFinite(Number(this.state.translationProgress)) ? Number(this.state.translationProgress) : 0;
        this.fields.translationProgress.textContent = `${Math.max(0, Math.min(100, Math.round(progress)))}%`;
      }
      if (this.fields.translationFailedCount) {
        this.fields.translationFailedCount.textContent = String(this.state.failedBlocksCount || 0);
      }
      if (this.fields.translationLastError) {
        this.fields.translationLastError.textContent = this.state.lastError && this.state.lastError.message
          ? this.state.lastError.message
          : '—';
      }
      const debug = this._resolveLastErrorDebugPayload();
      if (this.fields.translationLastErrorBaseUrl) {
        this.fields.translationLastErrorBaseUrl.textContent = debug && debug.baseUrl ? String(debug.baseUrl) : '—';
      }
      if (this.fields.translationLastErrorTransport) {
        const transportTried = debug && Array.isArray(debug.transportTried) ? debug.transportTried : [];
        this.fields.translationLastErrorTransport.textContent = transportTried.length
          ? transportTried.join(' -> ')
          : '—';
      }
      if (this.fields.translationLastErrorEndpointHost) {
        this.fields.translationLastErrorEndpointHost.textContent = debug && debug.endpointHost ? String(debug.endpointHost) : '—';
      }
      if (this.fields.translationLastErrorOnline) {
        if (debug && typeof debug.online === 'boolean') {
          this.fields.translationLastErrorOnline.textContent = debug.online ? 'online' : 'offline';
        } else {
          this.fields.translationLastErrorOnline.textContent = '—';
        }
      }
      const probe = debug && debug.probe && typeof debug.probe === 'object' ? debug.probe : null;
      if (this.fields.translationLastErrorProbeStatus) {
        if (!probe) {
          this.fields.translationLastErrorProbeStatus.textContent = '—';
        } else if (probe.ok === true) {
          const statusText = Number.isFinite(Number(probe.status)) ? `HTTP ${Number(probe.status)}` : 'HTTP —';
          this.fields.translationLastErrorProbeStatus.textContent = `ok (${statusText})`;
        } else {
          const nameText = probe.name ? String(probe.name) : 'error';
          this.fields.translationLastErrorProbeStatus.textContent = `failed (${nameText})`;
        }
      }
      if (this.fields.translationLastErrorProbeError) {
        this.fields.translationLastErrorProbeError.textContent = probe && probe.errorMessage
          ? String(probe.errorMessage)
          : '—';
      }
      if (this.fields.translationLastErrorProbeSteps) {
        const steps = probe && Array.isArray(probe.steps) ? probe.steps : [];
        this.renderList(this.fields.translationLastErrorProbeSteps, steps, (step) => {
          const row = step && typeof step === 'object' ? step : {};
          const name = row.name ? String(row.name) : 'step';
          if (Number.isFinite(Number(row.status))) {
            return `${name}: HTTP ${Number(row.status)}${row.ok === true ? ' (ok)' : ''}`;
          }
          const errMessage = row.errMessage ? String(row.errMessage) : '—';
          return `${name}: ${errMessage}`;
        });
      }
    }

    renderFramesShadow() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const frameMetrics = job && job.frameMetrics && typeof job.frameMetrics === 'object'
        ? job.frameMetrics
        : {};
      const frames = frameMetrics.frames && typeof frameMetrics.frames === 'object'
        ? frameMetrics.frames
        : {};
      const byFrame = frames.byFrame && typeof frames.byFrame === 'object'
        ? frames.byFrame
        : {};
      if (this.fields.framesSummary) {
        const totalSeen = Number.isFinite(Number(frames.totalSeen)) ? Number(frames.totalSeen) : 0;
        const injectedOk = Number.isFinite(Number(frames.injectedOk)) ? Number(frames.injectedOk) : 0;
        const skippedNoPerm = Number.isFinite(Number(frames.skippedNoPerm)) ? Number(frames.skippedNoPerm) : 0;
        const scannedOk = Number.isFinite(Number(frames.scannedOk)) ? Number(frames.scannedOk) : 0;
        const applyOk = Number.isFinite(Number(frames.applyOk)) ? Number(frames.applyOk) : 0;
        this.fields.framesSummary.textContent = `total=${totalSeen} | injectedOk=${injectedOk} | skippedNoPerm=${skippedNoPerm} | scannedOk=${scannedOk} | applyOk=${applyOk}`;
      }
      if (this.fields.framesTable) {
        this.fields.framesTable.innerHTML = '';
        const rows = Object.keys(byFrame)
          .map((key) => byFrame[key])
          .filter((row) => row && typeof row === 'object')
          .sort((left, right) => {
            const a = Number.isFinite(Number(left.frameId)) ? Number(left.frameId) : Number.POSITIVE_INFINITY;
            const b = Number.isFinite(Number(right.frameId)) ? Number(right.frameId) : Number.POSITIVE_INFINITY;
            if (a !== b) {
              return a - b;
            }
            const leftUrl = left.frameUrl ? String(left.frameUrl) : '';
            const rightUrl = right.frameUrl ? String(right.frameUrl) : '';
            return leftUrl.localeCompare(rightUrl);
          });
        if (!rows.length) {
          const tr = this.doc.createElement('tr');
          const td = this.doc.createElement('td');
          td.colSpan = 5;
          td.textContent = '—';
          tr.appendChild(td);
          this.fields.framesTable.appendChild(tr);
        } else {
          rows.forEach((row) => {
            const tr = this.doc.createElement('tr');
            const values = [
              Number.isFinite(Number(row.frameId)) ? String(Number(row.frameId)) : '—',
              row.frameUrl ? String(row.frameUrl).slice(0, 140) : '—',
              row.injected === false ? 'no' : 'yes',
              Number.isFinite(Number(row.scannedBlocksCount)) ? String(Number(row.scannedBlocksCount)) : '0',
              row.skippedReason ? String(row.skippedReason) : '—'
            ];
            values.forEach((value) => {
              const td = this.doc.createElement('td');
              td.textContent = value;
              tr.appendChild(td);
            });
            this.fields.framesTable.appendChild(tr);
          });
        }
      }
      if (this.fields.shadowSummary) {
        const shadow = frameMetrics.shadowDom && typeof frameMetrics.shadowDom === 'object'
          ? frameMetrics.shadowDom
          : {};
        const openRootsVisited = Number.isFinite(Number(shadow.openRootsVisited))
          ? Number(shadow.openRootsVisited)
          : 0;
        const textNodesFromShadow = Number.isFinite(Number(shadow.textNodesFromShadow))
          ? Number(shadow.textNodesFromShadow)
          : 0;
        this.fields.shadowSummary.textContent = `openRootsVisited=${openRootsVisited} | textNodesFromShadow=${textNodesFromShadow}`;
      }
    }

    renderCompareRendering() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const frameMetrics = job && job.frameMetrics && typeof job.frameMetrics === 'object'
        ? job.frameMetrics
        : {};
      const highlights = frameMetrics.highlights && typeof frameMetrics.highlights === 'object'
        ? frameMetrics.highlights
        : {};
      if (this.fields.compareHighlightsSupported) {
        if (typeof highlights.supported === 'boolean') {
          this.fields.compareHighlightsSupported.textContent = highlights.supported ? 'yes' : 'no';
        } else {
          this.fields.compareHighlightsSupported.textContent = '—';
        }
      }
      if (this.fields.compareModeActive) {
        const mode = job && typeof job.compareRendering === 'string'
          ? job.compareRendering
          : (typeof highlights.mode === 'string' ? highlights.mode : 'auto');
        this.fields.compareModeActive.textContent = mode || 'auto';
      }
      if (this.fields.compareHighlightsCounters) {
        const appliedCount = Number.isFinite(Number(highlights.appliedCount))
          ? Number(highlights.appliedCount)
          : 0;
        const fallbackCount = Number.isFinite(Number(highlights.fallbackCount))
          ? Number(highlights.fallbackCount)
          : 0;
        this.fields.compareHighlightsCounters.textContent = `highlightsApplied=${appliedCount} | fallbacks=${fallbackCount}`;
      }
      if (this.fields.recomputeHighlights) {
        this.fields.recomputeHighlights.disabled = !job;
      }
    }

    renderPerf() {
      const snapshot = this.state.perfSnapshot && typeof this.state.perfSnapshot === 'object'
        ? this.state.perfSnapshot
        : null;
      const globalMetrics = snapshot && snapshot.global && snapshot.global.totals && typeof snapshot.global.totals === 'object'
        ? snapshot.global.totals
        : {};
      const ring = snapshot && snapshot.global && Array.isArray(snapshot.global.ring)
        ? snapshot.global.ring
        : [];
      const offenders = snapshot && Array.isArray(snapshot.topOffenders)
        ? snapshot.topOffenders
        : [];
      const jobs = snapshot && Array.isArray(snapshot.jobs)
        ? snapshot.jobs
        : [];
      if (this.fields.perfSummary) {
        const updatedAt = snapshot && Number.isFinite(Number(snapshot.updatedAt))
          ? this.formatTs(Number(snapshot.updatedAt))
          : '—';
        this.fields.perfSummary.textContent = `updated=${updatedAt} | jobs=${jobs.length} | offenders=${offenders.length} | ring=${ring.length}`;
      }
      if (this.fields.perfGlobalTable) {
        this.fields.perfGlobalTable.innerHTML = '';
        const rows = [
          ['applyDeltaCount', Number.isFinite(Number(globalMetrics.applyDeltaCount)) ? Number(globalMetrics.applyDeltaCount) : 0],
          ['coalescedCount', Number.isFinite(Number(globalMetrics.coalescedCount)) ? Number(globalMetrics.coalescedCount) : 0],
          ['rebindAttempts', Number.isFinite(Number(globalMetrics.rebindAttempts)) ? Number(globalMetrics.rebindAttempts) : 0],
          ['offscreenBytesOut', Number.isFinite(Number(globalMetrics.offscreenBytesOut)) ? Number(globalMetrics.offscreenBytesOut) : 0],
          ['offscreenBytesIn', Number.isFinite(Number(globalMetrics.offscreenBytesIn)) ? Number(globalMetrics.offscreenBytesIn) : 0],
          ['storageBytesEstimate', Number.isFinite(Number(globalMetrics.storageBytesEstimate)) ? Number(globalMetrics.storageBytesEstimate) : 0]
        ];
        rows.forEach((row) => {
          const tr = this.doc.createElement('tr');
          tr.appendChild(this.cell(String(row[0])));
          tr.appendChild(this.cell(String(row[1])));
          this.fields.perfGlobalTable.appendChild(tr);
        });
      }
      if (this.fields.perfJobsTable) {
        this.fields.perfJobsTable.innerHTML = '';
        if (!offenders.length) {
          const tr = this.doc.createElement('tr');
          const td = this.doc.createElement('td');
          td.colSpan = 7;
          td.textContent = '—';
          tr.appendChild(td);
          this.fields.perfJobsTable.appendChild(tr);
        } else {
          offenders.slice(0, 20).forEach((item) => {
            const metrics = item && item.metrics && typeof item.metrics === 'object'
              ? item.metrics
              : {};
            const tr = this.doc.createElement('tr');
            const values = [
              item && item.jobId ? String(item.jobId).slice(0, 24) : '—',
              item && item.status ? String(item.status) : '—',
              Number.isFinite(Number(item && item.score)) ? Number(item.score).toFixed(2) : '0.00',
              Number.isFinite(Number(metrics.scanTimeMs)) ? String(Number(metrics.scanTimeMs)) : '0',
              Number.isFinite(Number(metrics.classifyTimeMs)) ? String(Number(metrics.classifyTimeMs)) : '0',
              Number.isFinite(Number(metrics.applyDeltaCount)) ? String(Number(metrics.applyDeltaCount)) : '0',
              Number.isFinite(Number(metrics.avgDeltaLatencyMs)) ? Number(metrics.avgDeltaLatencyMs).toFixed(2) : '0.00'
            ];
            values.forEach((value) => {
              const td = this.doc.createElement('td');
              td.textContent = value;
              tr.appendChild(td);
            });
            this.fields.perfJobsTable.appendChild(tr);
          });
        }
      }
      if (this.fields.perfExportStatus) {
        this.fields.perfExportStatus.textContent = this.state.perfExportStatus || '—';
      }
    }

    async _sendUiCommandWithResponse(name, payload = {}) {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!global.chrome || !global.chrome.runtime || typeof global.chrome.runtime.sendMessage !== 'function') {
        return { ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'chrome.runtime unavailable' } };
      }
      const requestId = MessageEnvelope && typeof MessageEnvelope.newId === 'function'
        ? MessageEnvelope.newId()
        : `debug-${Date.now()}`;
      const tabIdCandidate = Number.isFinite(Number(this.state.tabId))
        ? Number(this.state.tabId)
        : (this.state.translationJob && Number.isFinite(Number(this.state.translationJob.tabId))
          ? Number(this.state.translationJob.tabId)
          : null);
      const type = UiProtocol && UiProtocol.UI_COMMAND ? UiProtocol.UI_COMMAND : 'ui:command';
      const meta = {
        source: 'debug',
        tabId: Number.isFinite(Number(tabIdCandidate)) ? Number(tabIdCandidate) : null,
        requestId
      };
      const envelope = MessageEnvelope && typeof MessageEnvelope.wrap === 'function'
        ? MessageEnvelope.wrap(type, { name, payload }, meta)
        : {
          v: 1,
          id: requestId,
          type,
          ts: Date.now(),
          meta,
          payload: { name, payload }
        };
      return new Promise((resolve) => {
        try {
          global.chrome.runtime.sendMessage(envelope, (response) => {
            const lastError = global.chrome && global.chrome.runtime ? global.chrome.runtime.lastError : null;
            if (lastError) {
              resolve({
                ok: false,
                error: {
                  code: 'RUNTIME_SEND_FAILED',
                  message: lastError.message || 'sendMessage failed'
                }
              });
              return;
            }
            resolve(response || { ok: false, error: { code: 'EMPTY_RESPONSE', message: 'No response' } });
          });
        } catch (error) {
          resolve({
            ok: false,
            error: {
              code: 'RUNTIME_SEND_FAILED',
              message: error && error.message ? error.message : 'sendMessage failed'
            }
          });
        }
      });
    }

    async exportPerfSnapshot() {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.EXPORT_PERF_SNAPSHOT
        : 'EXPORT_PERF_SNAPSHOT';
      if (this.fields.exportPerfSnapshot) {
        this.fields.exportPerfSnapshot.disabled = true;
      }
      this.state.perfExportStatus = 'requesting...';
      this.renderPerf();
      const response = await this._sendUiCommandWithResponse(command, {});
      if (!response || response.ok !== true || !response.snapshot || typeof response.snapshot !== 'object') {
        const message = response && response.error && response.error.message
          ? response.error.message
          : 'export failed';
        this.state.perfExportStatus = `error: ${message}`;
        if (this.fields.exportPerfSnapshot) {
          this.fields.exportPerfSnapshot.disabled = false;
        }
        this.renderPerf();
        return;
      }
      this.state.perfSnapshot = response.snapshot;
      const payload = JSON.stringify(response.snapshot, null, 2);
      try {
        await this.copyText(payload);
        this.state.perfExportStatus = `copied to clipboard (${payload.length} chars)`;
      } catch (_) {
        this.state.perfExportStatus = `snapshot ready (${payload.length} chars)`;
      }
      if (this.fields.exportPerfSnapshot) {
        this.fields.exportPerfSnapshot.disabled = false;
      }
      this.renderPerf();
    }

    renderClassifier() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const classification = job && job.classification && typeof job.classification === 'object'
        ? job.classification
        : null;
      const summary = classification && classification.summary && typeof classification.summary === 'object'
        ? classification.summary
        : null;
      const countsByCategory = summary && summary.countsByCategory && typeof summary.countsByCategory === 'object'
        ? summary.countsByCategory
        : {};
      const confidenceByCategory = summary
        && summary.confidenceStats
        && summary.confidenceStats.byCategory
        && typeof summary.confidenceStats.byCategory === 'object'
        ? summary.confidenceStats.byCategory
        : {};
      const byBlockId = classification && classification.byBlockId && typeof classification.byBlockId === 'object'
        ? classification.byBlockId
        : {};

      if (this.fields.classifierReclassifyForce) {
        this.fields.classifierReclassifyForce.disabled = !job;
      }

      const categoryKeys = Array.from(new Set(
        Object.keys(countsByCategory)
          .concat(Object.keys(byBlockId).map((blockId) => {
            const row = byBlockId[blockId] && typeof byBlockId[blockId] === 'object' ? byBlockId[blockId] : {};
            return row.category ? String(row.category) : '';
          }))
          .filter(Boolean)
      ));
      categoryKeys.sort();

      if (this.fields.classifierCategoryFilter) {
        const current = this.state.classifier && this.state.classifier.category
          ? this.state.classifier.category
          : 'all';
        this.fields.classifierCategoryFilter.innerHTML = '';
        const allOption = this.doc.createElement('option');
        allOption.value = 'all';
        allOption.textContent = 'Category: all';
        this.fields.classifierCategoryFilter.appendChild(allOption);
        categoryKeys.forEach((category) => {
          const option = this.doc.createElement('option');
          option.value = category;
          option.textContent = `Category: ${category}`;
          this.fields.classifierCategoryFilter.appendChild(option);
        });
        this.fields.classifierCategoryFilter.value = categoryKeys.includes(current) ? current : 'all';
        this.state.classifier.category = this.fields.classifierCategoryFilter.value;
      }
      if (this.fields.classifierRuleFilter) {
        const currentRule = this.state.classifier && typeof this.state.classifier.rule === 'string'
          ? this.state.classifier.rule
          : '';
        if (this.fields.classifierRuleFilter.value !== currentRule) {
          this.fields.classifierRuleFilter.value = currentRule;
        }
      }

      const summaryRows = categoryKeys.map((category) => {
        const count = Number.isFinite(Number(countsByCategory[category])) ? Number(countsByCategory[category]) : 0;
        const confRow = confidenceByCategory[category] && typeof confidenceByCategory[category] === 'object'
          ? confidenceByCategory[category]
          : {};
        const avg = Number.isFinite(Number(confRow.avg)) ? Number(confRow.avg) : 0;
        return `${category} | count=${count} | avgConf=${avg.toFixed(3)}`;
      });
      const stale = job && job.classificationStale === true ? 'stale=yes' : 'stale=no';
      const classifierVersion = classification && classification.classifierVersion
        ? String(classification.classifierVersion)
        : 'n/a';
      const domHash = classification && classification.domHash
        ? String(classification.domHash)
        : (job && job.domHash ? String(job.domHash) : 'n/a');
      const headerRow = `version=${classifierVersion} | domHash=${domHash} | ${stale}`;
      this.renderList(this.fields.classifierSummary, [headerRow].concat(summaryRows), (item) => String(item || ''));

      const blockRows = this._collectClassifierRows({
        job,
        byBlockId
      });
      const categoryFilter = this.state.classifier && typeof this.state.classifier.category === 'string'
        ? this.state.classifier.category
        : 'all';
      const ruleFilter = this.state.classifier && typeof this.state.classifier.rule === 'string'
        ? this.state.classifier.rule.trim().toLowerCase()
        : '';
      const filtered = blockRows.filter((row) => {
        if (categoryFilter !== 'all' && row.category !== categoryFilter) {
          return false;
        }
        if (!ruleFilter) {
          return true;
        }
        return row.reasons.some((reason) => String(reason || '').toLowerCase().includes(ruleFilter));
      });
      this.renderList(this.fields.classifierBlocks, filtered.slice(0, 500), (row) => {
        const reasonText = row.reasons.length ? row.reasons.join(',') : '-';
        return `${row.blockId} | ${row.category} | c=${row.confidence.toFixed(3)} | ${reasonText} | ${row.preview}`;
      });
    }

    _collectClassifierRows({ job, byBlockId } = {}) {
      const rows = [];
      const classified = byBlockId && typeof byBlockId === 'object' ? byBlockId : {};
      const blocksById = job && job.blocksById && typeof job.blocksById === 'object'
        ? job.blocksById
        : {};
      const fromSummary = job && Array.isArray(job.blockSummaries) ? job.blockSummaries : [];
      const fallbackPreviewById = {};
      fromSummary.forEach((item) => {
        if (!item || !item.blockId) {
          return;
        }
        fallbackPreviewById[item.blockId] = item.originalSnippet || '';
      });
      Object.keys(classified).forEach((blockId) => {
        const row = classified[blockId] && typeof classified[blockId] === 'object'
          ? classified[blockId]
          : {};
        const block = blocksById[blockId] && typeof blocksById[blockId] === 'object'
          ? blocksById[blockId]
          : null;
        const previewText = block && typeof block.originalText === 'string'
          ? block.originalText
          : (fallbackPreviewById[blockId] || '');
        rows.push({
          blockId,
          category: row.category ? String(row.category) : 'unknown',
          confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : 0,
          reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 8).map((item) => String(item || '')).filter(Boolean) : [],
          preview: String(previewText || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        });
      });
      rows.sort((left, right) => {
        if (left.category !== right.category) {
          return left.category.localeCompare(right.category);
        }
        return left.blockId.localeCompare(right.blockId);
      });
      return rows;
    }

    _resolveLastErrorDebugPayload() {
      const fromState = this.state.lastError && typeof this.state.lastError === 'object'
        ? this.state.lastError
        : null;
      const fromStatus = this.state.status && this.state.status.lastError && typeof this.state.status.lastError === 'object'
        ? this.state.status.lastError
        : null;
      const pickDebug = (errorValue) => {
        if (!errorValue || typeof errorValue !== 'object') {
          return null;
        }
        if (errorValue.error && typeof errorValue.error === 'object' && errorValue.error.debug && typeof errorValue.error.debug === 'object') {
          return errorValue.error.debug;
        }
        if (errorValue.debug && typeof errorValue.debug === 'object') {
          return errorValue.debug;
        }
        return null;
      };
      return pickDebug(fromState) || pickDebug(fromStatus) || null;
    }

    renderAgent() {
      const fallback = this.state.status && this.state.status.agentState ? this.state.status.agentState : null;
      const agent = this.state.agentState || fallback || null;
      if (this.fields.agentPhase) {
        this.fields.agentPhase.textContent = agent && agent.phase ? this._phaseLabel(agent.phase) : '—';
      }
      if (this.fields.agentProfile) {
        this.fields.agentProfile.textContent = agent && agent.profile ? this._profileLabel(agent.profile) : '—';
      }
      if (this.fields.agentCategories) {
        const categories = Array.isArray(this.state.selectedCategories) && this.state.selectedCategories.length
          ? this.state.selectedCategories
          : (agent && Array.isArray(agent.selectedCategories) ? agent.selectedCategories : []);
        this.fields.agentCategories.textContent = categories.length ? categories.join(', ') : '—';
      }
      if (this.fields.agentGlossarySize) {
        this.fields.agentGlossarySize.textContent = String(agent && Number.isFinite(Number(agent.glossarySize)) ? Number(agent.glossarySize) : 0);
      }
      if (this.fields.agentCompressions) {
        this.fields.agentCompressions.textContent = String(agent && Number.isFinite(Number(agent.compressedContextCount)) ? Number(agent.compressedContextCount) : 0);
      }
      if (this.fields.agentContextSummary) {
        this.fields.agentContextSummary.textContent = agent && agent.contextSummary ? agent.contextSummary : '—';
      }
      if (this.fields.agentRateLast) {
        const lastRate = agent && agent.lastRateLimits && typeof agent.lastRateLimits === 'object'
          ? agent.lastRateLimits
          : null;
        if (!lastRate) {
          this.fields.agentRateLast.textContent = '—';
        } else {
          const model = lastRate.model || '—';
          const headers = lastRate.headersSubset && typeof lastRate.headersSubset === 'object'
            ? lastRate.headersSubset
            : {};
          const remReq = headers['x-ratelimit-remaining-requests'] || '—';
          const limReq = headers['x-ratelimit-limit-requests'] || '—';
          const remTok = headers['x-ratelimit-remaining-tokens'] || '—';
          const limTok = headers['x-ratelimit-limit-tokens'] || '—';
          this.fields.agentRateLast.textContent = `${model} | RPM ${remReq}/${limReq} | TPM ${remTok}/${limTok}`;
        }
      }

      this.renderList(this.fields.agentRateHistory, agent && Array.isArray(agent.rateLimitHistory) ? agent.rateLimitHistory : [], (item) => {
        const ts = item && item.ts ? this.formatTs(item.ts) : '—';
        const model = item && item.model ? item.model : '—';
        const headers = item && item.headersSubset && typeof item.headersSubset === 'object'
          ? item.headersSubset
          : {};
        const remReq = headers['x-ratelimit-remaining-requests'] || '—';
        const limReq = headers['x-ratelimit-limit-requests'] || '—';
        const remTok = headers['x-ratelimit-remaining-tokens'] || '—';
        const limTok = headers['x-ratelimit-limit-tokens'] || '—';
        const resetReq = headers['x-ratelimit-reset-requests'] || '—';
        const resetTok = headers['x-ratelimit-reset-tokens'] || '—';
        return `${ts} | ${model} | RPM ${remReq}/${limReq} (reset ${resetReq}) | TPM ${remTok}/${limTok} (reset ${resetTok})`;
      });

      this.renderList(this.fields.agentChecklist, agent && Array.isArray(agent.checklist) ? agent.checklist : [], (item) => {
        const status = item && item.status ? this._checklistStatusLabel(item.status) : 'ожидание';
        const title = item && item.title ? item.title : item && item.id ? item.id : 'пункт';
        const details = item && item.details ? ` | ${item.details}` : '';
        return `${status} | ${title}${details}`;
      });

      this.renderList(this.fields.agentTools, agent && Array.isArray(agent.toolHistory) ? agent.toolHistory : [], (item) => {
        const ts = item && item.ts ? this.formatTs(item.ts) : '—';
        const tool = item && item.tool ? item.tool : 'инструмент';
        const status = this._toolStatusLabel(item && item.status ? item.status : 'ok');
        const msg = item && item.message ? item.message : '';
        return `${ts} | ${tool} | ${status}${msg ? ` | ${msg}` : ''}`;
      });

      this.renderList(this.fields.agentToolTrace, agent && Array.isArray(agent.toolExecutionTrace) ? agent.toolExecutionTrace : [], (item) => {
        const ts = item && item.ts ? this.formatTs(item.ts) : '—';
        const tool = item && item.tool ? item.tool : 'инструмент';
        const status = this._toolStatusLabel(item && item.status ? item.status : 'ok');
        const mode = item && item.mode ? item.mode : 'auto';
        const forced = item && item.forced ? 'forced' : 'normal';
        const msg = item && item.message ? item.message : '';
        const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : null;
        const callId = meta && meta.callId ? ` | call_id=${meta.callId}` : '';
        const args = meta && meta.args ? ` | args=${JSON.stringify(meta.args).slice(0, 220)}` : '';
        const output = meta && meta.output ? ` | output=${String(meta.output).slice(0, 220)}` : '';
        return `${ts} | ${tool} | mode=${mode} | ${forced} | ${status}${callId}${msg ? ` | ${msg}` : ''}${args}${output}`;
      });

      this.renderList(this.fields.agentReports, agent && Array.isArray(agent.reports) ? agent.reports : [], (item) => {
        const ts = item && item.ts ? this.formatTs(item.ts) : '—';
        const type = item && item.type ? item.type : 'заметка';
        const title = item && item.title ? item.title : 'отчёт';
        const body = item && item.body ? item.body : '';
        const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : null;
        const usage = meta && meta.usage && typeof meta.usage === 'object' ? meta.usage : null;
        const rate = meta && meta.rate && typeof meta.rate === 'object' ? meta.rate : null;
        const requestOptions = meta && meta.requestOptions && typeof meta.requestOptions === 'object'
          ? meta.requestOptions
          : null;
        const compactMeta = meta
          ? ` | model=${meta.chosenModelSpec || '—'} | tok=${usage && usage.totalTokens !== undefined && usage.totalTokens !== null ? usage.totalTokens : '—'} | rpm=${rate && rate.remainingRequests !== undefined && rate.remainingRequests !== null ? rate.remainingRequests : '—'} | tpm=${rate && rate.remainingTokens !== undefined && rate.remainingTokens !== null ? rate.remainingTokens : '—'}${requestOptions ? ` | req=${JSON.stringify(requestOptions).slice(0, 140)}` : ''}${meta.cached ? ' | cached' : ''}`
          : '';
        return `${ts} | ${type} | ${title}${body ? ` | ${body}` : ''}${compactMeta}`;
      });

      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const runSettings = job && job.runSettings && typeof job.runSettings === 'object'
        ? job.runSettings
        : null;
      const autoTune = runSettings && runSettings.autoTune && typeof runSettings.autoTune === 'object'
        ? runSettings.autoTune
        : null;
      const proposals = autoTune && Array.isArray(autoTune.proposals)
        ? autoTune.proposals.slice().reverse().slice(0, 120)
        : [];
      if (this.fields.autotuneStatus) {
        if (!autoTune) {
          this.fields.autotuneStatus.textContent = '—';
        } else {
          const pending = proposals.filter((item) => item && item.status === 'proposed').length;
          this.fields.autotuneStatus.textContent = `enabled=${autoTune.enabled !== false ? 'on' : 'off'} | mode=${autoTune.mode === 'ask_user' ? 'ask_user' : 'auto_apply'} | proposals=${proposals.length} | pending=${pending}`;
        }
      }
      if (this.fields.autotuneProposals) {
        this.fields.autotuneProposals.innerHTML = '';
        proposals.forEach((item) => {
          if (!item || !item.id) {
            return;
          }
          const row = this.doc.createElement('div');
          row.className = 'debug__list-item';
          const ts = this.formatTs(item.ts);
          const reasonShort = item.reason && item.reason.short ? String(item.reason.short) : '—';
          row.textContent = `${item.id} | ${ts} | ${item.stage || '—'} | ${item.status || '—'} | ${item.diffSummary || '—'} | ${reasonShort}`;
          const button = this.doc.createElement('button');
          button.type = 'button';
          button.className = 'debug__mini-btn';
          button.setAttribute('data-action', 'open-autotune-proposal');
          button.setAttribute('data-proposal-id', item.id);
          button.textContent = 'Детали';
          row.appendChild(button);
          this.fields.autotuneProposals.appendChild(row);
        });
        if (!proposals.length) {
          const empty = this.doc.createElement('div');
          empty.className = 'debug__list-item';
          empty.textContent = '—';
          this.fields.autotuneProposals.appendChild(empty);
        }
      }
      if (!this.state.autotune.selectedProposalId && proposals.length) {
        this.state.autotune.selectedProposalId = proposals[0].id;
      }
      const selectedProposal = proposals.find((item) => item && item.id === this.state.autotune.selectedProposalId)
        || (proposals.length ? proposals[0] : null);
      if (this.fields.autotuneProposalDetails) {
        this.fields.autotuneProposalDetails.textContent = selectedProposal
          ? JSON.stringify({
            id: selectedProposal.id,
            ts: selectedProposal.ts || null,
            stage: selectedProposal.stage || null,
            status: selectedProposal.status || null,
            diffSummary: selectedProposal.diffSummary || '',
            reason: selectedProposal.reason || null,
            warnings: Array.isArray(selectedProposal.warnings) ? selectedProposal.warnings : [],
            patch: selectedProposal.patch || {},
            effectiveAfterApply: selectedProposal.status === 'applied'
              ? (runSettings && runSettings.effectiveSummary ? runSettings.effectiveSummary : null)
              : null
          }, null, 2)
          : '—';
      }
    }

    renderSettingsSummary() {
      const settings = this.state.settings && typeof this.state.settings === 'object'
        ? this.state.settings
        : {};
      const schemaVersion = Number.isFinite(Number(settings.schemaVersion))
        ? Number(settings.schemaVersion)
        : '—';
      const user = settings.userSettings && typeof settings.userSettings === 'object'
        ? settings.userSettings
        : {};
      const effective = settings.effectiveSettings && typeof settings.effectiveSettings === 'object'
        ? settings.effectiveSettings
        : {};
      const overrides = settings.overrides && typeof settings.overrides === 'object'
        ? settings.overrides
        : {};
      const changed = Array.isArray(overrides.changed) ? overrides.changed : [];

      const userReasoning = user.reasoning && typeof user.reasoning === 'object' ? user.reasoning : {};
      const effReasoning = effective.reasoning && typeof effective.reasoning === 'object' ? effective.reasoning : {};
      const userCaching = user.caching && typeof user.caching === 'object' ? user.caching : {};
      const effCaching = effective.caching && typeof effective.caching === 'object' ? effective.caching : {};
      const userModels = user.models && typeof user.models === 'object' ? user.models : {};
      const effModels = effective.models && typeof effective.models === 'object' ? effective.models : {};
      const effAgent = effective.agent && typeof effective.agent === 'object' ? effective.agent : {};
      const toolConfigEffective = effAgent.toolConfigEffective && typeof effAgent.toolConfigEffective === 'object'
        ? effAgent.toolConfigEffective
        : {};

      const profileText = `user=${user.profile || '—'} | effective=${effective.effectiveProfile || effective.profile || '—'}`;
      const reasoningText = `${effReasoning.reasoningEffort || userReasoning.reasoningEffort || '—'} / ${effReasoning.reasoningSummary || userReasoning.reasoningSummary || '—'} (mode=${userReasoning.reasoningMode || effReasoning.reasoningMode || '—'})`;
      const cacheText = `${effCaching.promptCacheRetention || userCaching.promptCacheRetention || '—'} | key=${effCaching.promptCacheKey || userCaching.promptCacheKey || '—'} | compat=${effCaching.compatCache !== false ? 'on' : 'off'}`;
      const toolText = Object.keys(toolConfigEffective).length
        ? Object.keys(toolConfigEffective).slice(0, 6).map((key) => `${key}:${toolConfigEffective[key]}`).join(', ')
        : '—';
      const modelAllowlist = Array.isArray(effModels.agentAllowedModels) && effModels.agentAllowedModels.length
        ? effModels.agentAllowedModels
        : (Array.isArray(userModels.agentAllowedModels) ? userModels.agentAllowedModels : []);
      const compareDiffThreshold = Number.isFinite(Number(settings.translationCompareDiffThreshold))
        ? Math.max(500, Math.min(50000, Math.round(Number(settings.translationCompareDiffThreshold))))
        : null;
      const modelsText = [
        `allowlist=${modelAllowlist.length}`,
        `routing=${effModels.modelRoutingMode || userModels.modelRoutingMode || '—'}`,
        compareDiffThreshold !== null ? `compareDiff=${compareDiffThreshold}` : ''
      ].filter(Boolean).join(' | ');
      const overridesText = changed.length ? changed.slice(0, 10).join(', ') : 'нет';

      if (this.fields.settingsSchema) {
        this.fields.settingsSchema.textContent = String(schemaVersion);
      }
      if (this.fields.settingsProfile) {
        this.fields.settingsProfile.textContent = profileText;
      }
      if (this.fields.settingsReasoning) {
        this.fields.settingsReasoning.textContent = reasoningText;
      }
      if (this.fields.settingsCache) {
        this.fields.settingsCache.textContent = cacheText;
      }
      if (this.fields.settingsTools) {
        this.fields.settingsTools.textContent = toolText;
      }
      if (this.fields.settingsModels) {
        this.fields.settingsModels.textContent = modelsText;
      }
      if (this.fields.settingsOverrides) {
        this.fields.settingsOverrides.textContent = overridesText;
      }
    }

    renderMemory() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const agent = this.state.agentState && typeof this.state.agentState === 'object'
        ? this.state.agentState
        : null;
      const context = job && job.memoryContext && typeof job.memoryContext === 'object'
        ? job.memoryContext
        : (agent && agent.memory && agent.memory.context && typeof agent.memory.context === 'object'
          ? agent.memory.context
          : null);
      const restore = job && job.memoryRestore && typeof job.memoryRestore === 'object'
        ? job.memoryRestore
        : (agent && agent.memory && agent.memory.lastRestore && typeof agent.memory.lastRestore === 'object'
          ? agent.memory.lastRestore
          : null);
      if (this.fields.memoryPageKey) {
        this.fields.memoryPageKey.textContent = context && context.pageKey ? context.pageKey : '—';
      }
      if (this.fields.memoryDomHash) {
        this.fields.memoryDomHash.textContent = context && context.domHash ? context.domHash : '—';
      }
      if (this.fields.memoryUrl) {
        this.fields.memoryUrl.textContent = context && context.normalizedUrl ? context.normalizedUrl : '—';
      }
      if (this.fields.memoryRestore) {
        if (!restore) {
          this.fields.memoryRestore.textContent = '—';
        } else {
          this.fields.memoryRestore.textContent = `restored=${Number(restore.restoredCount || 0)} | coverage=${restore.coverage || '—'} | match=${restore.matchType || '—'}`;
        }
      }
      const reports = agent && Array.isArray(agent.reports) ? agent.reports : [];
      const trace = agent && Array.isArray(agent.toolExecutionTrace) ? agent.toolExecutionTrace : [];
      const ops = reports
        .filter((item) => item && (item.type === 'memory' || (item.meta && item.meta.pageKey)))
        .slice(-8)
        .map((item) => {
          const ts = item && item.ts ? this.formatTs(item.ts) : '—';
          return `${ts} | ${item.title || item.type || 'memory'} | ${item.body || ''}`;
        })
        .concat(
          trace
            .filter((item) => item && typeof item.tool === 'string' && item.tool.indexOf('memory') === 0)
            .slice(-8)
            .map((item) => {
              const ts = item && item.ts ? this.formatTs(item.ts) : '—';
              return `${ts} | ${item.tool} | ${item.status || 'ok'} | ${item.message || ''}`;
            })
        );
      this.renderList(this.fields.memoryOps, ops, (line) => line);
    }

    renderDiff() {
      const fromStatus = this.state.status && Array.isArray(this.state.status.recentDiffItems)
        ? this.state.status.recentDiffItems
        : [];
      const list = Array.isArray(this.state.recentDiffItems) && this.state.recentDiffItems.length
        ? this.state.recentDiffItems
        : fromStatus;
      this.renderList(this.fields.diffList, list, (item) => {
        const id = item && item.blockId ? item.blockId : 'блок';
        const cat = item && item.category ? item.category : 'прочее';
        const before = item && item.before ? item.before : '';
        const after = item && item.after ? item.after : '';
        return `${id} [${cat}] | "${before}" -> "${after}"`;
      });
      const agent = this.state.agentState && typeof this.state.agentState === 'object'
        ? this.state.agentState
        : null;
      const patchHistory = Array.isArray(agent && agent.patchHistory) ? agent.patchHistory : [];
      const toolTrace = Array.isArray(agent && agent.toolExecutionTrace) ? agent.toolExecutionTrace : [];
      const coalesced = toolTrace.reduce((acc, item) => {
        const qos = item && item.qos && typeof item.qos === 'object'
          ? item.qos
          : (item && item.meta && item.meta.qos && typeof item.meta.qos === 'object' ? item.meta.qos : null);
        const value = qos && Number.isFinite(Number(qos.coalescedCount))
          ? Number(qos.coalescedCount)
          : 0;
        return acc + Math.max(0, value);
      }, 0);
      const latencyValues = patchHistory
        .map((item) => item && item.meta && Number.isFinite(Number(item.meta.latencyMs)) ? Number(item.meta.latencyMs) : null)
        .filter((value) => value !== null);
      const avgLatency = latencyValues.length
        ? `${Math.round(latencyValues.reduce((a, b) => a + b, 0) / latencyValues.length)}ms`
        : '—';
      if (this.fields.patchEventsCount) {
        this.fields.patchEventsCount.textContent = String(patchHistory.length);
      }
      if (this.fields.coalescedCount) {
        this.fields.coalescedCount.textContent = String(coalesced);
      }
      if (this.fields.deltaApplyLatency) {
        this.fields.deltaApplyLatency.textContent = avgLatency;
      }
    }

    renderCompareAndPatches() {
      const blocks = this._collectCompareBlocks();
      const compareState = this.state.compare && typeof this.state.compare === 'object'
        ? this.state.compare
        : { search: '', status: 'all', selectedBlockId: null, selectedPatchSeq: null };
      const search = String(compareState.search || '').trim().toLowerCase();
      const statusFilter = compareState.status || 'all';
      const filtered = blocks.filter((item) => {
        if (!item) {
          return false;
        }
        if (statusFilter !== 'all' && item.status !== statusFilter) {
          return false;
        }
        if (!search) {
          return true;
        }
        const haystack = `${item.blockId || ''} ${item.category || ''}`.toLowerCase();
        return haystack.includes(search);
      });
      if (!compareState.selectedBlockId || !filtered.some((item) => item.blockId === compareState.selectedBlockId)) {
        compareState.selectedBlockId = filtered.length ? filtered[0].blockId : null;
        compareState.selectedPatchSeq = null;
      }
      this.state.compare = compareState;

      if (this.fields.compareSearch && this.fields.compareSearch.value !== compareState.search) {
        this.fields.compareSearch.value = compareState.search || '';
      }
      if (this.fields.compareStatus && this.fields.compareStatus.value !== compareState.status) {
        this.fields.compareStatus.value = compareState.status || 'all';
      }

      if (this.fields.compareBlocks) {
        this.fields.compareBlocks.innerHTML = '';
        const visible = filtered.slice(0, 400);
        visible.forEach((item) => {
          const row = this.doc.createElement('div');
          row.className = 'debug__list-item';
          const qualityLabel = item.qualityTag ? ` | quality=${item.qualityTag}` : '';
          const marker = compareState.selectedBlockId === item.blockId ? '* ' : '';
          row.textContent = `${marker}${item.blockId} [${item.category}] ${item.status} | len ${item.originalLength}/${item.translatedLength}${qualityLabel}`;
          const button = this.doc.createElement('button');
          button.type = 'button';
          button.className = 'debug__mini-btn';
          button.setAttribute('data-action', 'open-compare-block');
          button.setAttribute('data-block-id', item.blockId);
          button.textContent = 'Открыть diff';
          row.appendChild(button);
          const literalButton = this.doc.createElement('button');
          literalButton.type = 'button';
          literalButton.className = 'debug__mini-btn';
          literalButton.setAttribute('data-action', 'request-block-action');
          literalButton.setAttribute('data-block-id', item.blockId);
          literalButton.setAttribute('data-proof-action', 'literal');
          literalButton.textContent = 'Сделать дословно';
          row.appendChild(literalButton);
          const styleButton = this.doc.createElement('button');
          styleButton.type = 'button';
          styleButton.className = 'debug__mini-btn';
          styleButton.setAttribute('data-action', 'request-block-action');
          styleButton.setAttribute('data-block-id', item.blockId);
          styleButton.setAttribute('data-proof-action', 'style_improve');
          styleButton.textContent = 'Улучшить стиль';
          row.appendChild(styleButton);
          this.fields.compareBlocks.appendChild(row);
        });
        if (!visible.length) {
          const empty = this.doc.createElement('div');
          empty.className = 'debug__list-item';
          empty.textContent = '—';
          this.fields.compareBlocks.appendChild(empty);
        }
      }

      const selected = filtered.find((item) => item.blockId === compareState.selectedBlockId) || null;
      const originalText = selected && selected.originalSnippet ? selected.originalSnippet : '';
      const translatedText = selected && selected.translatedSnippet ? selected.translatedSnippet : '';
      if (this.fields.diffOriginal) {
        this.fields.diffOriginal.textContent = originalText || '—';
      }
      if (this.fields.diffTranslated) {
        this.fields.diffTranslated.textContent = translatedText || '—';
      }
      if (this.fields.diffRendered) {
        if (!selected) {
          this.fields.diffRendered.textContent = '—';
        } else if (this.diffHighlighter && (originalText || translatedText)) {
          const built = this.diffHighlighter.buildDiff(originalText, translatedText, {
            maxTokens: 320,
            maxMatrixCells: 150000
          });
          this.fields.diffRendered.innerHTML = built && typeof built.html === 'string'
            ? built.html
            : this._escapeHtml(translatedText || originalText || '');
        } else {
          this.fields.diffRendered.textContent = translatedText || originalText || '—';
        }
      }

      const agent = this.state.agentState && typeof this.state.agentState === 'object'
        ? this.state.agentState
        : null;
      const patchHistory = Array.isArray(agent && agent.patchHistory) ? agent.patchHistory : [];
      const timeline = selected
        ? patchHistory.filter((item) => item && item.blockId === selected.blockId).slice(-220)
        : [];
      if (this.fields.patchTimeline) {
        this.fields.patchTimeline.innerHTML = '';
        timeline.forEach((item) => {
          const row = this.doc.createElement('div');
          row.className = 'debug__list-item';
          const ts = this.formatTs(item.ts);
          row.textContent = `${ts} | ${item.kind || 'delta'} | seq=${item.seq || '—'} | ${item.phase || 'execution'}`;
          const button = this.doc.createElement('button');
          button.type = 'button';
          button.className = 'debug__mini-btn';
          button.setAttribute('data-action', 'open-patch');
          button.setAttribute('data-patch-seq', String(item.seq || ''));
          button.textContent = 'Детали';
          row.appendChild(button);
          this.fields.patchTimeline.appendChild(row);
        });
        if (!timeline.length) {
          const empty = this.doc.createElement('div');
          empty.className = 'debug__list-item';
          empty.textContent = '—';
          this.fields.patchTimeline.appendChild(empty);
        }
      }

      const selectedPatch = timeline.find((item) => Number(item.seq) === Number(compareState.selectedPatchSeq))
        || (timeline.length ? timeline[timeline.length - 1] : null);
      if (this.fields.patchDetails) {
        this.fields.patchDetails.textContent = selectedPatch
          ? JSON.stringify(selectedPatch, null, 2)
          : '—';
      }
    }

    renderSecurity({ pending = false } = {}) {
      const security = this.state.security && typeof this.state.security === 'object'
        ? this.state.security
        : {};
      const credentials = security.credentials && typeof security.credentials === 'object'
        ? security.credentials
        : null;
      const proxy = credentials && credentials.proxy && typeof credentials.proxy === 'object'
        ? credentials.proxy
        : {};
      if (this.fields.securityCredentials) {
        if (!credentials) {
          this.fields.securityCredentials.textContent = '—';
        } else {
          this.fields.securityCredentials.textContent = `mode=${credentials.mode || '—'}, byokPersisted=${credentials.byokPersisted === true}, proxy=${proxy.baseUrl || '—'}, proxyToken=${proxy.hasAuthToken === true}`;
        }
      }
      if (this.fields.securityTestConnection) {
        const test = security.lastConnectionTest && typeof security.lastConnectionTest === 'object'
          ? security.lastConnectionTest
          : null;
        if (!test) {
          this.fields.securityTestConnection.textContent = '—';
        } else if (test.ok) {
          this.fields.securityTestConnection.textContent = `OK ${test.latencyMs}ms ${test.endpointHost || ''}`.trim();
        } else {
          const code = test.error && test.error.code ? test.error.code : 'FAILED';
          this.fields.securityTestConnection.textContent = `FAIL ${code}`;
        }
      }
      if (this.fields.securityAuditStatus) {
        if (pending) {
          this.fields.securityAuditStatus.textContent = 'running...';
        } else if (security.lastAudit && typeof security.lastAudit === 'object') {
          const ts = this.formatTs(security.lastAudit.ts);
          this.fields.securityAuditStatus.textContent = `ready (${ts})`;
        } else {
          this.fields.securityAuditStatus.textContent = '—';
        }
      }
      if (this.fields.securityAuditReport) {
        this.fields.securityAuditReport.textContent = security.lastAudit && typeof security.lastAudit === 'object'
          ? JSON.stringify(security.lastAudit, null, 2)
          : '—';
      }
    }

    _collectCompareBlocks() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const fromJob = job && Array.isArray(job.blockSummaries)
        ? job.blockSummaries
        : [];
      if (fromJob.length) {
        return fromJob.map((item) => ({
          blockId: item.blockId || 'block',
          category: item.category || 'unknown',
          status: item.status || 'PENDING',
          qualityTag: item.qualityTag || 'raw',
          originalLength: Number(item.originalLength || 0),
          translatedLength: Number(item.translatedLength || 0),
          originalSnippet: item.originalSnippet || '',
          translatedSnippet: item.translatedSnippet || ''
        }));
      }
      const diffItems = Array.isArray(this.state.recentDiffItems) ? this.state.recentDiffItems : [];
      return diffItems.map((item) => ({
        blockId: item && item.blockId ? item.blockId : 'block',
        category: item && item.category ? item.category : 'unknown',
        status: 'DONE',
        qualityTag: item && item.qualityTag ? item.qualityTag : 'raw',
        originalLength: item && item.before ? String(item.before).length : 0,
        translatedLength: item && item.after ? String(item.after).length : 0,
        originalSnippet: item && item.before ? item.before : '',
        translatedSnippet: item && item.after ? item.after : ''
      }));
    }

    requestBlockAction(blockId, action) {
      const id = typeof blockId === 'string' ? blockId.trim() : '';
      if (!id) {
        return;
      }
      const tabIdCandidate = Number.isFinite(Number(this.state.tabId))
        ? Number(this.state.tabId)
        : (this.state.translationJob && Number.isFinite(Number(this.state.translationJob.tabId))
          ? Number(this.state.translationJob.tabId)
          : null);
      if (!Number.isFinite(tabIdCandidate)) {
        if (this.fields.message) {
          this.fields.message.textContent = 'Не удалось определить tabId для команды вычитки.';
        }
        return;
      }
      const jobId = this.state.translationJob && this.state.translationJob.id
        ? this.state.translationJob.id
        : null;
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.REQUEST_BLOCK_ACTION
        : 'REQUEST_BLOCK_ACTION';
      this.ui.sendUiCommand(command, {
        tabId: tabIdCandidate,
        jobId,
        blockId: id,
        action: action === 'literal' ? 'literal' : 'style_improve'
      });
      if (this.fields.message) {
        this.fields.message.textContent = `Запрошена вычитка блока ${id} (${action === 'literal' ? 'дословно' : 'стиль'})`;
      }
    }

    async exportReport(kind) {
      if (!this.reportExporter) {
        this._setExportStatus('exporter_unavailable');
        return;
      }
      const mode = this.fields.exportTextMode && this.fields.exportTextMode.value
        ? this.fields.exportTextMode.value
        : 'snippets';
      const snapshot = this._buildExportSnapshot();
      const reportJson = this.reportExporter.buildReportJson({
        snapshot,
        jobId: this.state.translationJob && this.state.translationJob.id ? this.state.translationJob.id : null,
        includeTextMode: mode,
        limits: { totalChars: 3 * 1024 * 1024 }
      });
      if (kind === 'json') {
        const payload = JSON.stringify(reportJson, null, 2);
        this.reportExporter.download({
          filename: this._exportFilename('json'),
          mime: 'application/json;charset=utf-8',
          contentString: payload
        });
        this._setExportStatus(`JSON сохранён (${payload.length} chars)`);
        return;
      }
      if (kind === 'html') {
        const html = this.reportExporter.buildReportHtml(reportJson);
        this.reportExporter.download({
          filename: this._exportFilename('html'),
          mime: 'text/html;charset=utf-8',
          contentString: html
        });
        this._setExportStatus(`HTML сохранён (${html.length} chars)`);
        return;
      }
      if (kind === 'copy') {
        const payload = JSON.stringify(reportJson, null, 2);
        await this.reportExporter.copyToClipboard(payload);
        this._setExportStatus(`JSON скопирован (${payload.length} chars)`);
      }
    }

    async copyDiagnostics() {
      const payload = this._buildDiagnosticsPayload();
      const redaction = global.NT
        && global.NT.Redaction
        && typeof global.NT.Redaction.redactDeep === 'function'
        ? global.NT.Redaction.redactDeep.bind(global.NT.Redaction)
        : (global.NT && typeof global.NT.redactDeep === 'function' ? global.NT.redactDeep : ((value) => value));
      const redacted = redaction(payload, {});
      const serialized = JSON.stringify(redacted, null, 2);
      await this.copyText(serialized);
      this._setExportStatus(`Diagnostics copied (${serialized.length} chars)`);
    }

    _buildDiagnosticsPayload() {
      const snapshot = this._buildExportSnapshot();
      const status = this.state.status && typeof this.state.status === 'object'
        ? this.state.status
        : {};
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const runtime = status.runtime && typeof status.runtime === 'object'
        ? status.runtime
        : (job && job.runtime && typeof job.runtime === 'object' ? job.runtime : {});
      const agent = this._resolveAgentState();
      const trace = agent && Array.isArray(agent.toolExecutionTrace)
        ? agent.toolExecutionTrace
        : [];
      const reports = agent && Array.isArray(agent.reports) ? agent.reports : [];
      const checklist = agent && Array.isArray(agent.checklist) ? agent.checklist : [];
      const eventItems = this.state.eventLog && Array.isArray(this.state.eventLog.items)
        ? this.state.eventLog.items
        : [];
      const errorEvents = eventItems
        .filter((item) => item && String(item.level || '').toLowerCase() === 'error')
        .slice(-20)
        .map((item) => ({
          seq: Number.isFinite(Number(item.seq)) ? Number(item.seq) : null,
          ts: Number.isFinite(Number(item.ts)) ? Number(item.ts) : null,
          tag: item.tag ? String(item.tag) : null,
          message: this._clipString(item.message, 260),
          meta: this._jsonPreview(item.meta, 360)
        }));
      const frameMetrics = job && job.frameMetrics && typeof job.frameMetrics === 'object'
        ? job.frameMetrics
        : {};
      const classification = job && job.classification && typeof job.classification === 'object'
        ? job.classification
        : {};
      const summary = classification.summary && typeof classification.summary === 'object'
        ? classification.summary
        : {};
      const toolTraceLast50 = trace.slice(-50).map((item) => this._compactToolTrace(item));
      const perfTotals = this.state.perfSnapshot
        && this.state.perfSnapshot.global
        && this.state.perfSnapshot.global.totals
        && typeof this.state.perfSnapshot.global.totals === 'object'
        ? this.state.perfSnapshot.global.totals
        : {};

      return {
        kind: 'nt_diagnostics',
        generatedAt: Date.now(),
        meta: {
          tabId: Number.isFinite(Number(this.state.tabId)) ? Number(this.state.tabId) : null,
          origin: this.state.origin || null,
          url: this.state.url || null,
          status: status.status || null,
          message: this._clipString(status.message || (job ? job.message : ''), 220)
        },
        snapshot: {
          status: snapshot.status || null,
          translationJob: snapshot.translationJob || null,
          schedulerRuntime: snapshot.status && snapshot.status.runtime ? snapshot.status.runtime : null,
          security: snapshot.security || null,
          selectedCategories: snapshot.selectedCategories || [],
          availableCategories: snapshot.availableCategories || []
        },
        keyMetrics: {
          progress: Number.isFinite(Number(this.state.translationProgress)) ? Number(this.state.translationProgress) : 0,
          failedBlocks: Number.isFinite(Number(this.state.failedBlocksCount)) ? Number(this.state.failedBlocksCount) : 0,
          totalBlocks: job && Number.isFinite(Number(job.totalBlocks)) ? Number(job.totalBlocks) : 0,
          completedBlocks: job && Number.isFinite(Number(job.completedBlocks)) ? Number(job.completedBlocks) : 0,
          pendingBlocks: job && Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : null,
          frameMetrics,
          classifierSummary: summary,
          perf: {
            scanTimeMs: Number.isFinite(Number(perfTotals.scanTimeMs)) ? Number(perfTotals.scanTimeMs) : null,
            classifyTimeMs: Number.isFinite(Number(perfTotals.classifyTimeMs)) ? Number(perfTotals.classifyTimeMs) : null,
            applyDeltaCount: Number.isFinite(Number(perfTotals.applyDeltaCount)) ? Number(perfTotals.applyDeltaCount) : null,
            coalescedCount: Number.isFinite(Number(perfTotals.coalescedCount)) ? Number(perfTotals.coalescedCount) : null,
            avgDeltaLatencyMs: Number.isFinite(Number(perfTotals.avgDeltaLatencyMs)) ? Number(perfTotals.avgDeltaLatencyMs) : null,
            rebindAttempts: Number.isFinite(Number(perfTotals.rebindAttempts)) ? Number(perfTotals.rebindAttempts) : null,
            memoryCacheHitRate: Number.isFinite(Number(perfTotals.memoryCacheHitRate)) ? Number(perfTotals.memoryCacheHitRate) : null,
            storageBytesEstimate: Number.isFinite(Number(perfTotals.storageBytesEstimate)) ? Number(perfTotals.storageBytesEstimate) : null
          },
          agent: {
            phase: agent && agent.phase ? String(agent.phase) : null,
            reportsCount: reports.length,
            checklistCount: checklist.length,
            traceCount: trace.length
          }
        },
        errors: {
          stateLastError: this._compactError(this.state.lastError),
          statusLastError: this._compactError(status.lastError),
          jobLastError: this._compactError(job && job.lastError ? job.lastError : null),
          runtimeRetryLastError: this._compactError(runtime && runtime.retry ? runtime.retry.lastError : null),
          recentErrorEvents: errorEvents
        },
        toolTraceLast50,
        diagnosticsHint: this._clipString(job && job.message ? job.message : status.message, 240)
      };
    }

    _resolveAgentState() {
      const fallback = this.state.status && this.state.status.agentState && typeof this.state.status.agentState === 'object'
        ? this.state.status.agentState
        : null;
      return this.state.agentState && typeof this.state.agentState === 'object'
        ? this.state.agentState
        : fallback;
    }

    _compactToolTrace(item) {
      const row = item && typeof item === 'object' ? item : {};
      const meta = row.meta && typeof row.meta === 'object' ? row.meta : {};
      return {
        ts: Number.isFinite(Number(row.ts)) ? Number(row.ts) : null,
        tool: row.tool ? String(row.tool) : null,
        status: row.status ? String(row.status) : null,
        mode: row.mode ? String(row.mode) : null,
        forced: row.forced === true,
        message: this._clipString(row.message, 220),
        meta: {
          callId: meta.callId ? String(meta.callId) : null,
          args: this._jsonPreview(meta.args, 420),
          output: this._jsonPreview(meta.output, 420),
          qos: meta.qos ? this._jsonPreview(meta.qos, 220) : null
        }
      };
    }

    _compactError(errorValue) {
      if (!errorValue || typeof errorValue !== 'object') {
        return null;
      }
      const debug = errorValue.debug && typeof errorValue.debug === 'object'
        ? errorValue.debug
        : (errorValue.error && errorValue.error.debug && typeof errorValue.error.debug === 'object'
          ? errorValue.error.debug
          : null);
      return {
        code: errorValue.code ? String(errorValue.code) : null,
        message: this._clipString(errorValue.message, 320),
        ts: Number.isFinite(Number(errorValue.ts)) ? Number(errorValue.ts) : null,
        debug: debug ? this._jsonPreview(debug, 480) : null
      };
    }

    _clipString(value, limit = 200) {
      if (value === null || value === undefined) {
        return null;
      }
      const text = String(value).replace(/\s+/g, ' ').trim();
      const max = Number.isFinite(Number(limit)) ? Math.max(40, Number(limit)) : 200;
      if (!text.length) {
        return '';
      }
      if (text.length <= max) {
        return text;
      }
      return `${text.slice(0, max)}...`;
    }

    _jsonPreview(value, limit = 260) {
      if (value === null || value === undefined) {
        return null;
      }
      let serialized = '';
      try {
        serialized = JSON.stringify(value);
      } catch (_) {
        serialized = String(value);
      }
      const max = Number.isFinite(Number(limit)) ? Math.max(80, Number(limit)) : 260;
      if (serialized.length <= max) {
        return serialized;
      }
      return `${serialized.slice(0, max)}...`;
    }

    _buildExportSnapshot() {
      return {
        tabId: this.state.tabId,
        url: this.state.url,
        origin: this.state.origin,
        status: this.state.status,
        translationJob: this.state.translationJob,
        translationProgress: this.state.translationProgress,
        failedBlocksCount: this.state.failedBlocksCount,
        lastError: this.state.lastError,
        selectedCategories: this.state.selectedCategories,
        availableCategories: this.state.availableCategories,
        recentDiffItems: this.state.recentDiffItems,
        settings: this.state.settings,
        agentState: this.state.agentState,
        eventLog: this.state.eventLog,
        modelLimitsBySpec: this.state.modelLimitsBySpec,
        benchmarks: this.state.benchmarks,
        benchmarkStatus: this.state.benchmarkStatus,
        toolset: this.state.toolset,
        effectiveToolPolicy: this.state.effectiveToolPolicy,
        serverCaps: this.state.serverCaps,
        perfSnapshot: this.state.perfSnapshot,
        negotiation: this.state.negotiation,
        security: this.state.security
      };
    }

    _exportFilename(ext) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      return `nt-report-${stamp}.${ext}`;
    }

    _setExportStatus(text) {
      if (this.fields.exportStatus) {
        this.fields.exportStatus.textContent = text || '—';
      }
    }

    renderList(root, items, mapFn) {
      if (!root) {
        return;
      }
      const source = Array.isArray(items) ? items : [];
      root.innerHTML = '';
      const visible = source.slice(-40);
      visible.forEach((item) => {
        const row = this.doc.createElement('div');
        row.className = 'debug__list-item';
        row.textContent = mapFn(item);
        root.appendChild(row);
      });
      if (!visible.length) {
        const empty = this.doc.createElement('div');
        empty.className = 'debug__list-item';
        empty.textContent = '—';
        root.appendChild(empty);
      }
    }

    renderBenchmarks() {
      const status = this.state.benchmarkStatus || {};
      if (this.fields.benchStatus) {
        this.fields.benchStatus.textContent = status.status || '—';
      }
      if (this.fields.benchCurrent) {
        this.fields.benchCurrent.textContent = status.currentModelSpec || '—';
      }
      if (this.fields.benchMessage) {
        this.fields.benchMessage.textContent = status.message || status.reason || '—';
      }
      if (!this.fields.benchTable) {
        return;
      }
      this.fields.benchTable.innerHTML = '';
      const entries = Object.keys(this.state.benchmarks || {}).sort();
      entries.forEach((spec) => {
        const row = this.doc.createElement('tr');
        row.appendChild(this.cell(spec));
        row.appendChild(this.cell(String(Math.round((this.state.benchmarks[spec] || {}).medianMs || 0) || '—')));
        row.appendChild(this.cell(this.formatTs((this.state.benchmarks[spec] || {}).updatedAt)));
        this.fields.benchTable.appendChild(row);
      });
      if (!entries.length) {
        const row = this.doc.createElement('tr');
        row.appendChild(this.cell('—')); row.appendChild(this.cell('—')); row.appendChild(this.cell('—'));
        this.fields.benchTable.appendChild(row);
      }
    }


    renderRateLimits() {
      if (!this.fields.rateTable) {
        return;
      }
      const limits = this.state.modelLimitsBySpec || {};
      const rows = Object.keys(limits).sort();
      const currentModel = this.state.status && this.state.status.modelDecision
        ? this.state.status.modelDecision.chosenModelSpec || null
        : null;
      if (this.fields.rateCurrentModel) {
        this.fields.rateCurrentModel.textContent = currentModel || '—';
      }

      this.fields.rateTable.innerHTML = '';
      rows.forEach((spec) => {
        const item = limits[spec] || {};
        const remReq = item.remainingRequests === null || item.remainingRequests === undefined ? '—' : String(item.remainingRequests);
        const remTok = item.remainingTokens === null || item.remainingTokens === undefined ? '—' : String(item.remainingTokens);
        const reserved = `${item.reservedRequests || 0}/${item.reservedTokens || 0}`;
        const cooldown = this.formatCooldown(item.cooldownUntilTs);
        const reset = this.formatReset(item.resetRequestsAt, item.resetTokensAt);

        const row = this.doc.createElement('div');
        row.className = 'rate-row';
        if (spec === currentModel) {
          row.classList.add('rate-row--current');
        }
        row.appendChild(this.rateCell('rate-cell-model', spec));
        row.appendChild(this.rateCell('', remReq));
        row.appendChild(this.rateCell('', remTok));
        row.appendChild(this.rateCell('', reserved));
        row.appendChild(this.rateCell('', cooldown));
        row.appendChild(this.rateCell('', reset));
        this.fields.rateTable.appendChild(row);
      });

      if (!rows.length) {
        const row = this.doc.createElement('div');
        row.className = 'rate-row';
        row.textContent = 'данные лимитов пока отсутствуют';
        this.fields.rateTable.appendChild(row);
      }
    }

    _mergeObjects(base, patch) {
      const left = base && typeof base === 'object' ? this._cloneJson(base, {}) : {};
      const right = patch && typeof patch === 'object' ? patch : {};
      const mergeInto = (target, source) => {
        Object.keys(source).forEach((key) => {
          const value = source[key];
          if (value === undefined) {
            return;
          }
          if (Array.isArray(value)) {
            target[key] = value.slice();
            return;
          }
          if (value && typeof value === 'object') {
            const current = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
              ? target[key]
              : {};
            target[key] = mergeInto(current, value);
            return;
          }
          target[key] = value;
        });
        return target;
      };
      return mergeInto(left, right);
    }

    _cloneJson(value, fallback) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }

    rateCell(className, text) {
      const el = this.doc.createElement('div');
      el.className = `rate-cell ${className || ''}`.trim();
      el.textContent = text;
      return el;
    }

    formatCooldown(cooldownUntilTs) {
      if (typeof cooldownUntilTs !== 'number') {
        return '—';
      }
      const remain = Math.max(0, cooldownUntilTs - Date.now());
      if (remain <= 0) {
        return 'готово';
      }
      return `пауза ${Math.ceil(remain / 1000)}с`;
    }

    formatReset(reqTs, tokTs) {
      const req = typeof reqTs === 'number' ? Math.max(0, reqTs - Date.now()) : null;
      const tok = typeof tokTs === 'number' ? Math.max(0, tokTs - Date.now()) : null;
      const vals = [req, tok].filter((v) => typeof v === 'number');
      if (!vals.length) {
        return '—';
      }
      return `${Math.ceil(Math.min(...vals) / 1000)}s`;
    }

    scheduleEventRender() {
      if (this.renderTimer) {
        return;
      }
      this.renderTimer = global.setTimeout(() => {
        this.renderTimer = null;
        this.renderEventLog();
      }, 120);
    }

    renderEventLog() {
      if (!this.fields.eventLog) {
        return;
      }
      const filtered = this.getFilteredEvents();
      const visible = filtered.slice(-400);
      this.fields.eventLog.innerHTML = '';
      this.refreshTagOptions();

      visible.forEach((event) => {
        const row = this.doc.createElement('div');
        row.className = 'event-row';

        const time = this.doc.createElement('div');
        time.className = 'event-time';
        time.textContent = this.formatTs(event.ts);

        const level = this.doc.createElement('div');
        level.className = 'event-level';
        level.textContent = String(event.level || 'info');

        const content = this.doc.createElement('div');
        content.className = 'event-content';
        const tag = this.doc.createElement('div');
        tag.className = 'event-tag';
        tag.textContent = String(event.tag || 'general');
        const msg = this.doc.createElement('div');
        msg.className = 'event-msg';
        msg.textContent = String(event.message || '');
        const copyBtn = this.doc.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'event-copy-btn';
        copyBtn.textContent = 'Копировать';
        copyBtn.addEventListener('click', () => this.copySingleEvent(event));
        content.appendChild(tag);
        content.appendChild(msg);
        content.appendChild(copyBtn);

        const meta = this.doc.createElement('div');
        meta.className = 'event-meta';
        meta.textContent = this.formatMeta(event.meta || {});

        row.appendChild(time);
        row.appendChild(level);
        row.appendChild(content);
        row.appendChild(meta);
        this.fields.eventLog.appendChild(row);
      });

      if (!visible.length) {
        const empty = this.doc.createElement('div');
        empty.className = 'event-row';
        empty.textContent = 'нет событий';
        this.fields.eventLog.appendChild(empty);
      }
    }

    refreshTagOptions() {
      if (!this.fields.eventTag) {
        return;
      }
      const tags = ['all', ...Array.from(new Set(this.state.eventLog.items.map((item) => item.tag).filter(Boolean))).sort()];
      const current = this.state.filters.tag || 'all';
      this.fields.eventTag.innerHTML = '';
      tags.forEach((value) => {
        const opt = this.doc.createElement('option');
        opt.value = value;
        opt.textContent = value === 'all' ? 'Тег: все' : `Тег: ${value}`;
        this.fields.eventTag.appendChild(opt);
      });
      this.fields.eventTag.value = tags.includes(current) ? current : 'all';
      this.state.filters.tag = this.fields.eventTag.value;
    }

    getFilteredEvents() {
      const level = this.state.filters.level || 'all';
      const tag = this.state.filters.tag || 'all';
      const q = (this.state.filters.q || '').trim().toLowerCase();
      return this.state.eventLog.items.filter((item) => {
        if (!item) {
          return false;
        }
        if (level !== 'all' && item.level !== level) {
          return false;
        }
        if (tag !== 'all' && item.tag !== tag) {
          return false;
        }
        if (!q) {
          return true;
        }
        const haystack = `${item.tag || ''} ${item.message || ''} ${JSON.stringify(item.meta || {})}`.toLowerCase();
        return haystack.includes(q);
      });
    }

    _jobStatusLabel(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'idle') return 'ожидание';
      if (raw === 'preparing') return 'подготовка';
      if (raw === 'awaiting_categories') return 'ожидание категорий';
      if (raw === 'running') return 'выполняется';
      if (raw === 'completing') return 'завершение';
      if (raw === 'done') return 'готово';
      if (raw === 'failed') return 'ошибка';
      if (raw === 'cancelled') return 'отменено';
      return status || '—';
    }

    _normalizeDisplayMode(mode) {
      const raw = String(mode || '').trim().toLowerCase();
      if (raw === 'original' || raw === 'translated' || raw === 'compare') {
        return raw;
      }
      return 'translated';
    }

    _openSection(sectionId) {
      if (!sectionId || !this.doc || typeof this.doc.querySelector !== 'function') {
        return;
      }
      const section = this.doc.querySelector(`details[data-section="${sectionId}"]`);
      if (!section) {
        return;
      }
      section.open = true;
      try {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (_) {
        // best-effort only
      }
    }

    _phaseLabel(phase) {
      const raw = String(phase || '').trim().toLowerCase();
      if (raw === 'planned') return 'план готов';
      if (raw === 'running' || raw === 'translating') return 'перевод';
      if (raw === 'awaiting_categories') return 'ожидание категорий';
      if (raw === 'proofreading') return 'вычитка';
      if (raw === 'done') return 'завершено';
      if (raw === 'failed') return 'ошибка';
      if (raw === 'cache_restore') return 'восстановление из кэша';
      if (raw === 'idle') return 'ожидание';
      return phase || '—';
    }

    _profileLabel(profile) {
      const raw = String(profile || '').trim().toLowerCase();
      if (raw === 'balanced') return 'сбалансированный';
      if (raw === 'literal') return 'дословный';
      if (raw === 'readable') return 'читабельный';
      if (raw === 'technical') return 'технический';
      if (raw === 'auto') return 'авто';
      return profile || '—';
    }

    _checklistStatusLabel(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'done') return 'готово';
      if (raw === 'running') return 'в работе';
      if (raw === 'failed') return 'ошибка';
      if (raw === 'skipped') return 'пропуск';
      return 'ожидание';
    }

    _toolStatusLabel(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'ok') return 'ok';
      if (raw === 'warn') return 'предупреждение';
      if (raw === 'error') return 'ошибка';
      if (raw === 'skip' || raw === 'skipped') return 'пропуск';
      return status || '—';
    }

    formatMeta(meta) {
      const parts = [];
      if (meta.source) parts.push(`src=${meta.source}`);
      if (meta.tabId !== null && meta.tabId !== undefined) parts.push(`tab=${meta.tabId}`);
      if (meta.modelSpec) parts.push(`model=${meta.modelSpec}`);
      if (meta.status) parts.push(`status=${meta.status}`);
      if (meta.stage) parts.push(`stage=${meta.stage}`);
      if (meta.requestId) parts.push(`req=${meta.requestId}`);
      if (typeof meta.retryAfterMs === 'number') parts.push(`retry=${meta.retryAfterMs}ms`);
      if (typeof meta.latencyMs === 'number') parts.push(`latency=${Math.round(meta.latencyMs)}ms`);
      return parts.join(' · ') || '—';
    }

    _escapeHtml(text) {
      return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    formatTs(value) {
      const Time = global.NT && global.NT.Time ? global.NT.Time : null;
      if (Time && typeof Time.formatTime === 'function') {
        return Time.formatTime(value);
      }
      if (typeof value !== 'number') {
        return '—';
      }
      return new Date(value).toLocaleTimeString();
    }

    cell(text) {
      const td = this.doc.createElement('td');
      td.textContent = text;
      return td;
    }

    async copyEventJson() {
      const json = JSON.stringify(this.state.eventLog.items, null, 2);
      await this.copyText(json);
    }

    async copySingleEvent(event) {
      await this.copyText(JSON.stringify(event || {}, null, 2));
    }

    async copyText(text) {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        try {
          await global.navigator.clipboard.writeText(text);
          return;
        } catch (error) {
          // fallback
        }
      }
      const textarea = this.doc.createElement('textarea');
      textarea.value = text;
      this.doc.body.appendChild(textarea);
      textarea.select();
      this.doc.execCommand('copy');
      textarea.remove();
    }
  }

  const initialDebugQuery = new URLSearchParams(global.location.search);
  const initialDebugTabId = Number(initialDebugQuery.get('tabId'));
  const ui = new global.NT.UiModule({
    chromeApi: global.chrome,
    portName: 'debug',
    helloContext: {
      tabId: Number.isFinite(initialDebugTabId) ? initialDebugTabId : null
    }
  }).init();

  const page = new DebugPage({ doc: global.document, ui });
  ui.setHandlers({
    onSnapshot: (payload) => page.applySnapshot(payload),
    onPatch: (payload) => page.applyPatch(payload)
  });
  page.init();
})(globalThis);
