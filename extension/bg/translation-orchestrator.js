/**
 * Background orchestration for DOM translation jobs.
 *
 * The orchestrator owns job lifecycle, BG<->CS messaging, and per-tab status
 * synchronization for popup/debug pages.
 */
(function initTranslationOrchestrator(global) {
  const NT = global.NT || (global.NT = {});
  const KNOWN_CATEGORIES = Object.freeze([
    'main_content',
    'headings',
    'navigation',
    'ui_controls',
    'tables',
    'code',
    'captions',
    'footer',
    'legal',
    'ads',
    'unknown'
  ]);
  const LEGACY_CATEGORY_MAP = Object.freeze({
    heading: 'headings',
    paragraph: 'main_content',
    list: 'main_content',
    quote: 'main_content',
    button: 'ui_controls',
    label: 'ui_controls',
    navigation: 'navigation',
    table: 'tables',
    code: 'code',
    meta: 'footer',
    other: 'unknown'
  });

  class TranslationOrchestrator {
    constructor({
      chromeApi,
      settingsStore,
      tabStateStore,
      jobStore,
      perfProfiler,
      pageCacheStore,
      translationMemoryStore,
      toolManifest,
      toolPolicyResolver,
      translationCall,
      translationAgent,
      eventFactory,
      eventLogFn,
      onUiPatch,
      onCapabilitiesChanged,
      capabilitiesProvider
    } = {}) {
      this.chromeApi = chromeApi;
      this.settingsStore = settingsStore || null;
      this.tabStateStore = tabStateStore || null;
      this.jobStore = jobStore || null;
      this.perfProfiler = perfProfiler || null;
      this.pageCacheStore = pageCacheStore || null;
      this.translationMemoryStore = translationMemoryStore || null;
      this.toolManifest = toolManifest || null;
      this.toolPolicyResolver = toolPolicyResolver || null;
      this.translationCall = translationCall || null;
      this.translationAgent = translationAgent || null;
      this.runSettings = NT.RunSettings ? new NT.RunSettings() : null;
      this.eventFactory = eventFactory || null;
      this.eventLogFn = typeof eventLogFn === 'function' ? eventLogFn : null;
      this.onUiPatch = typeof onUiPatch === 'function' ? onUiPatch : null;
      this.onCapabilitiesChanged = typeof onCapabilitiesChanged === 'function' ? onCapabilitiesChanged : null;
      this.capabilitiesProvider = typeof capabilitiesProvider === 'function' ? capabilitiesProvider : null;

      if (this.translationAgent && typeof this.translationAgent.setPlanningCallbacks === 'function') {
        this.translationAgent.setPlanningCallbacks({
          classifyBlocksForJob: async ({ job, force } = {}) => this.classifyBlocksForJob({
            job,
            force: force === true
          }),
          getCategorySummaryForJob: ({ job } = {}) => this.getCategorySummaryForJob(job),
          setSelectedCategories: async ({ job, categories, mode, reason } = {}) => this._setSelectedCategories({
            job,
            categories: Array.isArray(categories) ? categories : [],
            mode: mode === 'add' || mode === 'remove' || mode === 'replace' ? mode : 'replace',
            reason: typeof reason === 'string' ? reason : ''
          }),
          setAgentCategoryRecommendations: ({ job, recommended, optional, excluded, reasonShort, reasonDetailed } = {}) => this._setAgentCategoryRecommendations({
            job,
            recommended: Array.isArray(recommended) ? recommended : [],
            optional: Array.isArray(optional) ? optional : [],
            excluded: Array.isArray(excluded) ? excluded : [],
            reasonShort,
            reasonDetailed
          })
        });
      }

      this.BATCH_SIZE = 8;
      this.JOB_LEASE_MS = 2 * 60 * 1000;
      this.MAX_JOB_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      this.APPLY_ACK_TIMEOUT_MS = 8000;
      this.APPLY_DELTA_ACK_TIMEOUT_MS = 2500;
      this.MEMORY_PAGE_INDEX_CAP = 5;
      this.PATCH_HISTORY_LIMIT = 2000;
      this.PATCH_DELTA_DEBOUNCE_MS = 320;
      this.PATCH_PREVIEW_CHARS = 160;
      this.COMPARE_DIFF_THRESHOLD_DEFAULT = 8000;
      this.processingJobs = new Set();
      this.pendingApplyAcks = new Map();
      this.pendingDeltaAcks = new Map();
      this.jobAbortControllers = new Map();
      this.contentCapsByTab = {};
      this.pendingPatchFlushByJob = new Map();
      this.pendingMemoryUpsertsByJob = new Map();
      this.jobSaveLocks = new Map();
    }

    isContentMessageType(type) {
      const protocol = NT.TranslationProtocol || null;
      return Boolean(protocol && protocol.isContentToBackground && protocol.isContentToBackground(type));
    }

    async startJob({ tabId, url, targetLang = 'ru', force = false } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId' } };
      }

      if (!(await this._isPipelineEnabled())) {
        return { ok: false, error: { code: 'PIPELINE_DISABLED', message: 'Р СџР В°Р в„–Р С—Р В»Р В°Р в„–Р Р… Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р С•РЎвЂљР С”Р В»РЎР‹РЎвЂЎРЎвЂР Р… (translationPipelineEnabled=false)' } };
      }

      const activeJob = await this.jobStore.getActiveJob(numericTabId);
      if (activeJob) {
        await this.cancelJob({ tabId: numericTabId, reason: 'REPLACED_BY_NEW_JOB' });
      }
      const previousJob = await this._getLastJobForTab(numericTabId);

      const injected = await this._ensureContentRuntime(numericTabId);
      if (!injected.ok) {
        return injected;
      }
      if (injected.warning && injected.warning.code === 'FRAME_INJECT_PARTIAL') {
        this._emitEvent(
          'warn',
          NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume',
          injected.warning.message || 'frame skipped: no host permission',
          {
            tabId: numericTabId,
            details: injected.warning.details || null
          }
        );
      }
      if (previousJob && previousJob.id) {
        const protocol = NT.TranslationProtocol || {};
        await this._sendToTab(numericTabId, {
          type: protocol.BG_RESTORE_ORIGINALS,
          jobId: previousJob.id
        });
      }

      const MessageEnvelope = NT.MessageEnvelope || null;
      const now = Date.now();
      const displayMode = await this._resolveTabDisplayMode(numericTabId);
      const compareDiffThreshold = await this._getCompareDiffThreshold();
      const compareRendering = await this._getCompareRendering();
      const job = {
        id: MessageEnvelope && typeof MessageEnvelope.newId === 'function'
          ? MessageEnvelope.newId()
          : `job-${now}-${Math.random().toString(16).slice(2)}`,
        tabId: numericTabId,
        url: url || '',
        targetLang: targetLang || 'ru',
        status: 'preparing',
        createdAt: now,
        updatedAt: now,
        leaseUntilTs: now + this._leaseMsForStatus('preparing'),
        totalBlocks: 0,
        completedBlocks: 0,
        pendingBlockIds: [],
        pendingRangeIds: [],
        failedBlockIds: [],
        blocksById: {},
        currentBatchId: null,
        lastError: null,
        message: 'Р РЋР С”Р В°Р Р…Р С‘РЎР‚РЎС“РЎР‹ РЎРѓР С•Р Т‘Р ВµРЎР‚Р В¶Р С‘Р СР С•Р Вµ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎвЂ№',
        attempts: 0,
        scanReceived: false,
        scanRequestedAt: now,
        scanNudgeTs: 0,
        forceTranslate: Boolean(force),
        pageSignature: null,
        cacheKey: null,
        availableCategories: [],
        selectedCategories: [],
        selectedRangeIds: [],
        classification: null,
        classificationStale: false,
        domHash: null,
        pageAnalysis: null,
        contentSessionId: null,
        categorySelectionConfirmed: false,
        agentState: null,
        recentDiffItems: [],
        translationMemoryBySource: {},
        memoryContext: null,
        memoryRestore: null,
        apiCacheEnabled: true,
        displayMode,
        compareDiffThreshold,
        compareRendering,
        proofreading: {
          enabled: false,
          mode: 'auto',
          pass: 0,
          pendingBlockIds: [],
          doneBlockIds: [],
          failedBlockIds: [],
          criteria: {
            preferTechnical: false,
            maxBlocksAuto: 120,
            minCharCount: 24,
            requireGlossaryConsistency: false
          },
          lastPlanTs: null,
          lastError: null
        },
        proofreadingState: {
          totalPasses: 0,
          completedPasses: 0,
          updatedAt: now
        }
      };

      const settings = await this._readAgentSettings().catch(() => null);
      const classifierObserveDomChanges = this._classifierObserveDomChangesEnabled(settings);
      const scanBudget = this._buildScanBudgetPayload(settings);
      this._ensureJobRunSettings(job, { settings });
      await this._saveJob(job, { setActive: true });
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_START : 'translation.start', 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р В·Р В°Р С—РЎС“РЎвЂ°Р ВµР Р…Р В°', {
        tabId: numericTabId,
        jobId: job.id,
        status: job.status
      });
      await this._syncVisibilityToContent(numericTabId, { contentSessionId: null, job }).catch(() => {});

      const protocol = NT.TranslationProtocol || {};
      const sent = await this._sendToTab(numericTabId, {
        type: protocol.BG_START_JOB,
        jobId: job.id,
        targetLang: job.targetLang,
        mode: this._normalizeDisplayMode(job.displayMode, true),
        compareDiffThreshold: this._normalizeCompareDiffThreshold(job.compareDiffThreshold),
        compareRendering: this._normalizeCompareRendering(job.compareRendering),
        classifierObserveDomChanges,
        ...scanBudget
      });

      if (!sent.ok) {
        const errorCode = sent && sent.error && typeof sent.error.code === 'string' && sent.error.code
          ? String(sent.error.code)
          : 'CONTENT_RUNTIME_UNREACHABLE';
        const normalizedCode = errorCode === 'SCAN_TOO_HEAVY'
          ? 'SCAN_TOO_HEAVY'
          : 'CONTENT_RUNTIME_UNREACHABLE';
        const errorMessage = sent && sent.error && sent.error.message
          ? sent.error.message
          : (normalizedCode === 'SCAN_TOO_HEAVY'
            ? 'DOM scan exceeded performance budget'
            : 'РќРµ СѓРґР°Р»РѕСЃСЊ Р·Р°РїСѓСЃС‚РёС‚СЊ РєРѕРЅС‚РµРЅС‚-СЂР°РЅС‚Р°Р№Рј');
        await this._markFailed(job, {
          code: normalizedCode,
          message: errorMessage
        });
        return { ok: false, error: { code: normalizedCode, message: errorMessage } };
      }

      return { ok: true, job: this._toJobSummary(job) };
    }

    async cancelJob({ tabId, reason = 'USER_CANCELLED' } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId' } };
      }
      const job = await this.jobStore.getActiveJob(numericTabId);
      if (!job) {
        return { ok: true, cancelled: false };
      }
      this._abortJobRequests(job.id, reason);
      this._clearPendingAckWaiters(job.id);
      await this._flushPatchEvents(job.id, { forceSave: true }).catch(() => ({ ok: false }));

      job.status = 'cancelled';
      if (reason === 'REPLACED_BY_NEW_JOB') {
        job.message = 'Р С›РЎвЂљР СР ВµР Р…Р ВµР Р…Р С•: Р В·Р В°Р СР ВµР Р…Р ВµР Р…Р С• Р Р…Р С•Р Р†Р С•Р в„– Р В·Р В°Р Т‘Р В°РЎвЂЎР ВµР в„–';
      } else if (reason === 'TAB_CLOSED') {
        job.message = 'Р С›РЎвЂљР СР ВµР Р…Р ВµР Р…Р С•: Р Р†Р С”Р В»Р В°Р Т‘Р С”Р В° Р В·Р В°Р С”РЎР‚РЎвЂ№РЎвЂљР В°';
      } else if (reason === 'USER_CLEAR') {
        job.message = 'Р С›РЎвЂљР СР ВµР Р…Р ВµР Р…Р С•: Р С•РЎвЂЎР С‘РЎРѓРЎвЂљР С”Р В° Р Т‘Р В°Р Р…Р Р…РЎвЂ№РЎвЂ¦ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В°';
      } else {
        job.message = 'Р С›РЎвЂљР СР ВµР Р…Р ВµР Р…Р С• Р С—Р С•Р В»РЎРЉР В·Р С•Р Р†Р В°РЎвЂљР ВµР В»Р ВµР С';
      }
      job.lastError = (reason === 'REPLACED_BY_NEW_JOB' || reason === 'TAB_CLOSED')
        ? null
        : { code: reason, message: 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р С•РЎвЂљР СР ВµР Р…РЎвЂР Р…' };
      job.currentBatchId = null;

      await this._saveJob(job, { clearActive: true });

      const protocol = NT.TranslationProtocol || {};
      await this._sendToTab(numericTabId, { type: protocol.BG_CANCEL_JOB, jobId: job.id });
      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р С•РЎвЂљР СР ВµР Р…Р ВµР Р…Р В°', {
        tabId: numericTabId,
        jobId: job.id,
        reason
      });

      return { ok: true, cancelled: true, job: this._toJobSummary(job) };
    }
    async applyCategorySelection({ tabId, categories, ids, jobId = null, mode = 'replace', reason = '' } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId' } };
      }
      let job = await this.jobStore.getActiveJob(numericTabId);
      if (!job && jobId) {
        try {
          const byId = await this.jobStore.getJob(jobId);
          if (byId && Number(byId.tabId) === numericTabId) {
            job = byId;
          }
        } catch (_) {
          // best-effort
        }
      }
      if (!job && this.jobStore && typeof this.jobStore.getLastJobId === 'function') {
        try {
          const lastJobId = await this.jobStore.getLastJobId(numericTabId);
          if (lastJobId) {
            const lastJob = await this.jobStore.getJob(lastJobId);
            if (lastJob && Number(lastJob.tabId) === numericTabId) {
              job = lastJob;
            }
          }
        } catch (_) {
          // best-effort
        }
      }
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р СњР ВµРЎвЂљ Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘ Р Т‘Р В»РЎРЏ Р С—РЎР‚Р С‘Р СР ВµР Р…Р ВµР Р…Р С‘РЎРЏ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–' } };
      }
      if (jobId && job.id !== jobId) {
        return { ok: false, error: { code: 'JOB_MISMATCH', message: 'Р СњР ВµРЎРѓР С•Р Р†Р С—Р В°Р Т‘Р ВµР Р…Р С‘Р Вµ jobId Р С—РЎР‚Р С‘ Р Р†РЎвЂ№Р В±Р С•РЎР‚Р Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–' } };
      }

      const effectiveMode = mode === 'add' || mode === 'remove' || mode === 'replace'
        ? mode
        : (job.status === 'done' ? 'add' : 'replace');
      const requestedCategories = Array.isArray(categories)
        ? categories
        : (Array.isArray(ids) ? ids : []);
      const updated = await this._setSelectedCategories({
        job,
        categories: requestedCategories,
        mode: effectiveMode,
        reason: reason || 'ui'
      });
      if (!updated.ok) {
        return updated;
      }
      if (updated.shouldRunExecution) {
        this._processJob(job.id).catch(() => {});
      }
      return {
        ok: true,
        job: this._toJobSummary(job),
        fromCache: Boolean(updated.fromCache),
        canSelectMore: this._shouldKeepJobActiveForCategoryExtensions(job),
        report: updated.report || null
      };
    }

    async reclassifyBlocks({ tabId, jobId = null, force = true } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId' } };
      }
      const job = await this._resolveJobForAutoTuneAction({
        tabId: numericTabId,
        jobId: jobId || null
      });
      if (!job || Number(job.tabId) !== numericTabId) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Т‘Р В»РЎРЏ reclassify Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°' } };
      }
      const classifyResult = await this.classifyBlocksForJob({
        job,
        force: force === true
      });
      if (!classifyResult.ok) {
        return classifyResult;
      }
      const summary = this.getCategorySummaryForJob(job);
      await this._saveJob(job, this._isTerminalStatus(job.status) ? { clearActive: true } : { setActive: true });
      return {
        ok: true,
        job: this._toJobSummary(job),
        domHash: classifyResult.domHash || null,
        classifierVersion: classifyResult.classifierVersion || null,
        classificationStale: classifyResult.classificationStale === true,
        summary: summary && summary.ok ? summary : null
      };
    }

    async clearJobData({ tabId, includeCache = true } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId' } };
      }

      const activeJob = await this.jobStore.getActiveJob(numericTabId);
      if (activeJob && (activeJob.status === 'preparing' || activeJob.status === 'planning' || activeJob.status === 'awaiting_categories' || activeJob.status === 'running' || activeJob.status === 'completing')) {
        await this.cancelJob({ tabId: numericTabId, reason: 'USER_CLEAR' });
      }

      const lastJob = await this._getLastJobForTab(numericTabId);
      const protocol = NT.TranslationProtocol || {};
      await this._ensureContentRuntime(numericTabId);
      this._recordRuntimeAction(lastJob, {
        tool: 'pageRuntime',
        status: 'warn',
        message: 'content.restore_originals.sent',
        meta: {
          includeCache: Boolean(includeCache),
          jobId: lastJob && lastJob.id ? lastJob.id : null
        }
      });
      await this._sendToTab(numericTabId, {
        type: protocol.BG_CANCEL_JOB,
        jobId: lastJob && lastJob.id ? lastJob.id : null
      });
      await this._sendToTab(numericTabId, {
        type: protocol.BG_RESTORE_ORIGINALS,
        jobId: lastJob && lastJob.id ? lastJob.id : null
      });
      await this._sendToTab(numericTabId, {
        type: protocol.BG_ERASE_JOB_DATA,
        jobId: lastJob && lastJob.id ? lastJob.id : null
      });

      let cacheCleared = false;
      if (includeCache && this.pageCacheStore && lastJob) {
        const removed = await this.pageCacheStore.removeEntry({
          key: lastJob.cacheKey || null,
          url: lastJob.url || '',
          targetLang: lastJob.targetLang || 'ru'
        });
        cacheCleared = Boolean(removed);
      }
      let memoryCleared = false;
      if (includeCache && this.translationMemoryStore && lastJob) {
        const memoryCtx = lastJob.memoryContext && typeof lastJob.memoryContext === 'object'
          ? lastJob.memoryContext
          : null;
        if (memoryCtx && memoryCtx.pageKey) {
          const removed = await this.translationMemoryStore.removePage(memoryCtx.pageKey).catch(() => ({ ok: false, removed: false }));
          memoryCleared = Boolean(removed && removed.removed);
        } else if (memoryCtx && memoryCtx.normalizedUrl) {
          const removedByUrl = await this.translationMemoryStore.removePagesByUrl(memoryCtx.normalizedUrl, {
            targetLang: lastJob.targetLang || 'ru'
          }).catch(() => ({ ok: false, removed: 0 }));
          memoryCleared = Number(removedByUrl && removedByUrl.removed || 0) > 0;
        }
      }

      if (this.tabStateStore && typeof this.tabStateStore.upsertStatusPatch === 'function') {
        await this.tabStateStore.upsertStatusPatch(numericTabId, {
          status: 'idle',
          progress: 0,
          total: 0,
          completed: 0,
          inProgress: 0,
          message: 'Р вЂќР В°Р Р…Р Р…РЎвЂ№Р Вµ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р С•РЎвЂЎР С‘РЎвЂ°Р ВµР Р…РЎвЂ№',
          failedBlocksCount: 0,
          translationJobId: null,
          lastError: null,
          selectedCategories: [],
          availableCategories: [],
          modelDecision: null,
          updatedAt: Date.now()
        });
        if (typeof this.tabStateStore.upsertDisplayMode === 'function') {
          await this.tabStateStore.upsertDisplayMode(numericTabId, 'original');
        } else if (typeof this.tabStateStore.upsertVisibility === 'function') {
          await this.tabStateStore.upsertVisibility(numericTabId, false);
        }
      }
      if (this.jobStore && typeof this.jobStore.clearTabHistory === 'function') {
        await this.jobStore.clearTabHistory(numericTabId);
      }

      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Р вЂќР В°Р Р…Р Р…РЎвЂ№Р Вµ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р С•РЎвЂЎР С‘РЎвЂ°Р ВµР Р…РЎвЂ№', {
        tabId: numericTabId,
        cacheCleared,
        memoryCleared
      });
      if (this.onUiPatch) {
        this.onUiPatch({
          translationJob: null,
          translationProgress: 0,
          failedBlocksCount: 0,
          lastError: null,
          agentState: null,
          selectedCategories: [],
          availableCategories: [],
          translationDisplayModeByTab: { [numericTabId]: 'original' },
          translationVisibilityByTab: { [numericTabId]: false }
        });
      }
      return { ok: true, cleared: true, cacheCleared, memoryCleared };
    }

    async eraseTranslationMemory({ tabId, scope = 'page' } = {}) {
      if (!this.translationMemoryStore) {
        return { ok: false, error: { code: 'MEMORY_STORE_UNAVAILABLE', message: 'Р ТђРЎР‚Р В°Р Р…Р С‘Р В»Р С‘РЎвЂ°Р Вµ Р С—Р В°Р СРЎРЏРЎвЂљР С‘ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р Р…Р С•' } };
      }
      const mode = scope === 'all' ? 'all' : 'page';
      if (mode === 'all') {
        await this.translationMemoryStore.clearAll().catch(() => ({ ok: false }));
        this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Р СџР В°Р СРЎРЏРЎвЂљРЎРЉ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р С—Р С•Р В»Р Р…Р С•РЎРѓРЎвЂљРЎРЉРЎР‹ Р С•РЎвЂЎР С‘РЎвЂ°Р ВµР Р…Р В°', {
          scope: 'all'
        });
        return { ok: true, scope: 'all', removed: true };
      }
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId Р Т‘Р В»РЎРЏ Р С•РЎвЂЎР С‘РЎРѓРЎвЂљР С”Р С‘ Р С—Р В°Р СРЎРЏРЎвЂљР С‘ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎвЂ№' } };
      }
      const active = await this.jobStore.getActiveJob(numericTabId);
      const last = await this._getLastJobForTab(numericTabId);
      const source = active || last || null;
      const memoryCtx = source && source.memoryContext && typeof source.memoryContext === 'object'
        ? source.memoryContext
        : null;
      if (memoryCtx && memoryCtx.pageKey) {
        const removed = await this.translationMemoryStore.removePage(memoryCtx.pageKey).catch(() => ({ ok: false, removed: false }));
        return { ok: true, scope: 'page', removed: Boolean(removed && removed.removed), pageKey: memoryCtx.pageKey };
      }
      if (memoryCtx && memoryCtx.normalizedUrl) {
        const removed = await this.translationMemoryStore.removePagesByUrl(memoryCtx.normalizedUrl, {
          targetLang: source && source.targetLang ? source.targetLang : 'ru'
        }).catch(() => ({ ok: false, removed: 0 }));
        return {
          ok: true,
          scope: 'page',
          removed: Number(removed && removed.removed || 0) > 0,
          removedCount: Number(removed && removed.removed || 0),
          normalizedUrl: memoryCtx.normalizedUrl
        };
      }
      return { ok: true, scope: 'page', removed: false };
    }

    async applyAutoTuneProposal({ tabId, jobId = null, proposalId } = {}) {
      if (!proposalId || typeof proposalId !== 'string') {
        return { ok: false, error: { code: 'INVALID_PROPOSAL_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ proposalId' } };
      }
      const job = await this._resolveJobForAutoTuneAction({ tabId, jobId });
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Т‘Р В»РЎРЏ Р С—РЎР‚Р С‘Р СР ВµР Р…Р ВµР Р…Р С‘РЎРЏ Р В°Р Р†РЎвЂљР С•-Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘ Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°' } };
      }
      const settings = await this._readAgentSettings();
      this._ensureJobRunSettings(job, { settings });
      const executed = await this._executeAutoTuneTool({
        job,
        settings,
        toolName: 'agent.apply_run_settings_proposal',
        args: { proposalId, confirmedByUser: true }
      });
      const refreshed = await this.jobStore.getJob(job.id).catch(() => null);
      const source = refreshed || job;
      return {
        ok: Boolean(executed && executed.ok !== false),
        result: executed || null,
        job: this._toJobSummary(source)
      };
    }

    async rejectAutoTuneProposal({ tabId, jobId = null, proposalId, reason = '' } = {}) {
      if (!proposalId || typeof proposalId !== 'string') {
        return { ok: false, error: { code: 'INVALID_PROPOSAL_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ proposalId' } };
      }
      const job = await this._resolveJobForAutoTuneAction({ tabId, jobId });
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Т‘Р В»РЎРЏ Р С•РЎвЂљР С”Р В»Р С•Р Р…Р ВµР Р…Р С‘РЎРЏ Р В°Р Р†РЎвЂљР С•-Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘ Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°' } };
      }
      const settings = await this._readAgentSettings();
      this._ensureJobRunSettings(job, { settings });
      const executed = await this._executeAutoTuneTool({
        job,
        settings,
        toolName: 'agent.reject_run_settings_proposal',
        args: { proposalId, reason: String(reason || '').slice(0, 240) }
      });
      const refreshed = await this.jobStore.getJob(job.id).catch(() => null);
      const source = refreshed || job;
      return {
        ok: Boolean(executed && executed.ok !== false),
        result: executed || null,
        job: this._toJobSummary(source)
      };
    }

    async resetAutoTuneOverrides({ tabId, jobId = null } = {}) {
      const job = await this._resolveJobForAutoTuneAction({ tabId, jobId });
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Т‘Р В»РЎРЏ РЎРѓР В±РЎР‚Р С•РЎРѓР В° Р В°Р Р†РЎвЂљР С•-Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р ВµР С” Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°' } };
      }
      const settings = await this._readAgentSettings();
      const runSettings = this._ensureJobRunSettings(job, { settings });
      const baseEffective = this.runSettings && typeof this.runSettings.computeBaseEffective === 'function'
        ? this.runSettings.computeBaseEffective({
          globalEffectiveSettings: settings && settings.effectiveSettings ? settings.effectiveSettings : {},
          jobContext: job
        })
        : {};
      const userApplied = this.runSettings && typeof this.runSettings.applyPatch === 'function'
        ? this.runSettings.applyPatch(baseEffective, runSettings.userOverrides || {})
        : { ...baseEffective, ...(runSettings.userOverrides || {}) };
      const diff = this.runSettings && typeof this.runSettings.diff === 'function'
        ? this.runSettings.diff(runSettings.effective || {}, userApplied)
        : { changedKeys: [] };
      runSettings.agentOverrides = {};
      runSettings.effective = userApplied;
      runSettings.autoTune.lastAppliedTs = Date.now();
      runSettings.autoTune.decisionLog = Array.isArray(runSettings.autoTune.decisionLog)
        ? runSettings.autoTune.decisionLog
        : [];
      runSettings.autoTune.decisionLog.push({
        ts: Date.now(),
        stage: this._resolvePatchPhase(job),
        decisionKey: 'ui_reset',
        inputsSummary: { source: 'ui' },
        patchSummary: diff.changedKeys.slice(0, 24),
        reasonShort: 'UI reset AutoTune overrides'
      });
      runSettings.autoTune.decisionLog = runSettings.autoTune.decisionLog.slice(-160);
      job.agentState = job.agentState && typeof job.agentState === 'object' ? job.agentState : {};
      job.agentState.reports = Array.isArray(job.agentState.reports) ? job.agentState.reports : [];
      job.agentState.reports.push({
        ts: Date.now(),
        type: 'autotune',
        title: 'Р С’Р Р†РЎвЂљР С•-Р Р…Р В°РЎРѓРЎвЂљРЎР‚Р С•Р в„–Р С”Р С‘ Р Т‘Р В»РЎРЏ Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘ РЎРѓР В±РЎР‚Р С•РЎв‚¬Р ВµР Р…РЎвЂ№',
        body: diff.changedKeys.length ? `Р РЋР В±РЎР‚Р С•РЎв‚¬Р ВµР Р…Р С• Р С—Р В°РЎР‚Р В°Р СР ВµРЎвЂљРЎР‚Р С•Р Р†: ${diff.changedKeys.length}` : 'Р ВР В·Р СР ВµР Р…Р ВµР Р…Р С‘Р в„– Р Р…Р Вµ Р В±РЎвЂ№Р В»Р С•',
        meta: { changedKeys: diff.changedKeys.slice(0, 24) }
      });
      job.agentState.reports = job.agentState.reports.slice(-120);
      await this._saveJob(job, this._isTerminalStatus(job.status) ? { clearActive: true } : { setActive: true });
      return { ok: true, job: this._toJobSummary(job), changedKeys: diff.changedKeys || [] };
    }

    async requestProofreadScope({ tabId, jobId = null, scope = 'all_selected_categories', category = null, blockIds = null, mode = 'auto' } = {}) {
      const job = await this._resolveJobForAutoTuneAction({ tabId, jobId });
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Т‘Р В»РЎРЏ Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘ Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°' } };
      }
      const settings = await this._readAgentSettings();
      this._ensureJobRunSettings(job, { settings });
      this._ensureJobProofreadingState(job);
      const args = {
        scope: scope === 'category' || scope === 'blocks' ? scope : 'all_selected_categories',
        mode: mode === 'manual' ? 'manual' : 'auto'
      };
      if (typeof category === 'string' && category.trim()) {
        args.category = category.trim();
      }
      if (Array.isArray(blockIds) && blockIds.length) {
        args.blockIds = blockIds.filter((item) => typeof item === 'string' && item).slice(0, 400);
      }
      const executed = await this._executeAutoTuneTool({
        job,
        settings,
        toolName: 'ui.request_proofread_scope',
        args
      });
      const refreshed = await this.jobStore.getJob(job.id).catch(() => null);
      const source = refreshed || job;
      if (executed && executed.ok !== false) {
        source.status = 'running';
        source.currentBatchId = source.currentBatchId || `${source.id}:proofreading`;
        await this._saveJob(source, { setActive: true });
        this._processJob(source.id).catch(() => {});
      }
      return {
        ok: Boolean(executed && executed.ok !== false),
        result: executed || null,
        job: this._toJobSummary(source)
      };
    }

    async requestBlockAction({ tabId, jobId = null, blockId, action } = {}) {
      const key = typeof blockId === 'string' ? blockId.trim() : '';
      if (!key) {
        return { ok: false, error: { code: 'INVALID_BLOCK_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ blockId' } };
      }
      const job = await this._resolveJobForAutoTuneAction({ tabId, jobId });
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Т‘Р В»РЎРЏ Р Т‘Р ВµР в„–РЎРѓРЎвЂљР Р†Р С‘РЎРЏ Р Р…Р В°Р Т‘ Р В±Р В»Р С•Р С”Р С•Р С Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°' } };
      }
      const settings = await this._readAgentSettings();
      this._ensureJobRunSettings(job, { settings });
      this._ensureJobProofreadingState(job);
      const executed = await this._executeAutoTuneTool({
        job,
        settings,
        toolName: 'ui.request_block_action',
        args: {
          blockId: key,
          action: action === 'literal' ? 'literal' : 'style_improve'
        }
      });
      const refreshed = await this.jobStore.getJob(job.id).catch(() => null);
      const source = refreshed || job;
      if (executed && executed.ok !== false) {
        source.status = 'running';
        source.currentBatchId = source.currentBatchId || `${source.id}:proofreading`;
        await this._saveJob(source, { setActive: true });
        this._processJob(source.id).catch(() => {});
      }
      return {
        ok: Boolean(executed && executed.ok !== false),
        result: executed || null,
        job: this._toJobSummary(source)
      };
    }

    async setVisibility({ tabId, visible, mode } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId' } };
      }

      const protocol = NT.TranslationProtocol || {};
      await this._ensureContentRuntime(numericTabId);
      let activeJob = null;
      try {
        activeJob = await this.jobStore.getActiveJob(numericTabId);
      } catch (_) {
        activeJob = null;
      }
      const contentSessionId = activeJob && typeof activeJob.contentSessionId === 'string' && activeJob.contentSessionId
        ? activeJob.contentSessionId
        : null;
      const displayMode = this._normalizeDisplayMode(mode, Boolean(visible));
      const compareDiffThreshold = await this._getCompareDiffThreshold({ job: activeJob });
      const compareRendering = await this._getCompareRendering({ job: activeJob });
      const visibilityPayload = {
        type: protocol.BG_SET_VISIBILITY,
        visible: displayMode !== 'original',
        mode: displayMode,
        compareDiffThreshold,
        compareRendering,
        ...(contentSessionId ? { contentSessionId } : {})
      };
      const visibilitySent = await this._sendToTab(numericTabId, visibilityPayload);
      if (
        visibilitySent
        && visibilitySent.ok
        && visibilitySent.response
        && visibilitySent.response.ignored === true
        && contentSessionId
      ) {
        await this._sendToTab(numericTabId, {
          type: protocol.BG_SET_VISIBILITY,
          visible: displayMode !== 'original',
          mode: displayMode,
          compareDiffThreshold,
          compareRendering
        });
      }
      if (this.tabStateStore && typeof this.tabStateStore.upsertDisplayMode === 'function') {
        await this.tabStateStore.upsertDisplayMode(numericTabId, displayMode);
      } else if (this.tabStateStore && typeof this.tabStateStore.upsertVisibility === 'function') {
        await this.tabStateStore.upsertVisibility(numericTabId, displayMode !== 'original');
      }
      if (activeJob && activeJob.id) {
        activeJob.displayMode = displayMode;
        activeJob.compareDiffThreshold = compareDiffThreshold;
        activeJob.compareRendering = compareRendering;
        await this._saveJob(activeJob, { setActive: true });
        this._queuePatchEvent(activeJob, {
          blockId: '__display_mode__',
          phase: this._resolvePatchPhase(activeJob),
          kind: 'toggle',
          prev: { textHash: null, textPreview: '' },
          next: { textHash: null, textPreview: '' },
          meta: {
            mode: displayMode
          }
        }, { forceFlush: true });
        await this._flushPatchEvents(activeJob.id, { forceSave: true });
      }
      return {
        ok: true,
        mode: displayMode,
        visible: displayMode !== 'original',
        compareDiffThreshold,
        compareRendering
      };
    }

    async _resolveTabVisibility(tabId) {
      const mode = await this._resolveTabDisplayMode(tabId);
      return mode !== 'original';
    }

    async _resolveTabDisplayMode(tabId) {
      try {
        if (this.tabStateStore && typeof this.tabStateStore.getDisplayMode === 'function') {
          const mode = await this.tabStateStore.getDisplayMode(tabId);
          if (mode === 'original' || mode === 'compare' || mode === 'translated') {
            return mode;
          }
        }
      } catch (_) {
        // best-effort fallback below
      }
      try {
        if (this.tabStateStore && typeof this.tabStateStore.getVisibility === 'function') {
          const visible = await this.tabStateStore.getVisibility(tabId);
          return visible ? 'translated' : 'original';
        }
      } catch (_) {
        // best-effort fallback below
      }
      return 'translated';
    }

    async _syncVisibilityToContent(tabId, { contentSessionId = null, job = null } = {}) {
      const protocol = NT.TranslationProtocol || {};
      const mode = await this._resolveTabDisplayMode(tabId);
      const visible = mode !== 'original';
      const compareDiffThreshold = await this._getCompareDiffThreshold({ job });
      const compareRendering = await this._getCompareRendering({ job });
      try {
        const out = await this._sendToTab(tabId, {
          type: protocol.BG_SET_VISIBILITY,
          visible,
          mode,
          compareDiffThreshold,
          compareRendering,
          ...(contentSessionId ? { contentSessionId } : {})
        });
        if (out && out.ok && out.response && out.response.ignored === true && contentSessionId) {
          await this._sendToTab(tabId, {
            type: protocol.BG_SET_VISIBILITY,
            visible,
            mode,
            compareDiffThreshold,
            compareRendering
          });
        }
      } catch (_) {
        // best-effort
      }
      return visible;
    }

    async _resolveJobForAutoTuneAction({ tabId, jobId = null } = {}) {
      if (jobId && this.jobStore && typeof this.jobStore.getJob === 'function') {
        const byId = await this.jobStore.getJob(jobId).catch(() => null);
        if (byId) {
          return byId;
        }
      }
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return null;
      }
      const active = await this.jobStore.getActiveJob(numericTabId).catch(() => null);
      if (active) {
        return active;
      }
      return this._getLastJobForTab(numericTabId);
    }

    async _executeAutoTuneTool({ job, settings, toolName, args } = {}) {
      const AgentToolRegistry = NT.AgentToolRegistry || null;
      if (!AgentToolRegistry || !job || !job.id || !toolName) {
        return { ok: false, code: 'AUTOTUNE_TOOL_UNAVAILABLE' };
      }
      const runLlmRequest = this.translationAgent && typeof this.translationAgent.runLlmRequest === 'function'
        ? this.translationAgent.runLlmRequest
        : null;
      const toolRegistry = new AgentToolRegistry({
        translationAgent: this.translationAgent,
        persistJobState: async (nextJob) => {
          if (!nextJob || !nextJob.id) {
            return;
          }
          await this._saveJob(nextJob, this._isTerminalStatus(nextJob.status) ? { clearActive: true } : { setActive: true });
        },
        runLlmRequest,
        toolManifest: this.toolManifest,
        toolPolicyResolver: this.toolPolicyResolver,
        toolExecutionEngine: NT.ToolExecutionEngine
          ? new NT.ToolExecutionEngine({
            toolManifest: this.toolManifest,
            persistJobState: async (nextJob) => {
              if (!nextJob || !nextJob.id) {
                return;
              }
              await this._saveJob(nextJob, this._isTerminalStatus(nextJob.status) ? { clearActive: true } : { setActive: true });
            }
          })
          : null,
        capabilities: this._buildRuntimeCapabilities(job.tabId),
        translationMemoryStore: this.translationMemoryStore,
        memorySettings: settings && typeof settings === 'object'
          ? {
            enabled: settings.translationMemoryEnabled !== false,
            maxPages: settings.translationMemoryMaxPages,
            maxBlocks: settings.translationMemoryMaxBlocks,
            maxAgeDays: settings.translationMemoryMaxAgeDays
          }
          : null,
        applyDelta: async ({ job: deltaJob, blockId, text, isFinal }) => this._applyDeltaToTab({
          job: deltaJob || job,
          blockId,
          text,
          isFinal
        }),
        getJobSignal: (jobId) => {
          const controller = this._getJobAbortController(jobId);
          return controller && controller.signal ? controller.signal : null;
        },
        classifyBlocksForJob: async ({ job: targetJob, force }) => this.classifyBlocksForJob({
          job: targetJob || job,
          force: force === true
        }),
        getCategorySummaryForJob: ({ job: targetJob }) => this.getCategorySummaryForJob(targetJob || job),
        setSelectedCategories: async ({ job: targetJob, categories, mode, reason: selectReason }) => this._setSelectedCategories({
          job: targetJob || job,
          categories: Array.isArray(categories) ? categories : [],
          mode: mode === 'add' || mode === 'remove' || mode === 'replace' ? mode : 'replace',
          reason: typeof selectReason === 'string' ? selectReason : ''
        }),
        setAgentCategoryRecommendations: ({ job: targetJob, recommended, optional, excluded, reasonShort, reasonDetailed }) => this._setAgentCategoryRecommendations({
          job: targetJob || job,
          recommended: Array.isArray(recommended) ? recommended : [],
          optional: Array.isArray(optional) ? optional : [],
          excluded: Array.isArray(excluded) ? excluded : [],
          reasonShort,
          reasonDetailed
        })
      });
      const blocks = Object.keys(job.blocksById || {})
        .map((id) => job.blocksById[id])
        .filter(Boolean);
      let output = null;
      try {
        output = await toolRegistry.execute({
          name: toolName,
          arguments: JSON.stringify(args || {}),
          job,
          blocks,
          settings,
          callId: `ui_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
          source: 'ui',
          requestId: null
        });
      } catch (error) {
        return {
          ok: false,
          code: error && error.code ? error.code : 'AUTOTUNE_TOOL_FAILED',
          message: error && error.message ? error.message : 'AutoTune tool execution failed'
        };
      }
      if (typeof output !== 'string') {
        return {
          ok: true,
          frameId: senderFrameId,
          documentId: senderDocumentId,
          frameUrl: senderFrameUrl
        };
      }
      try {
        const parsed = JSON.parse(output);
        return parsed && typeof parsed === 'object' ? parsed : { ok: true, value: parsed };
      } catch (_) {
        return { ok: true, outputString: output };
      }
    }

    async retryFailed({ tabId, jobId } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ tabId' } };
      }

      const sourceJob = jobId
        ? await this.jobStore.getJob(jobId)
        : await this._getLastJobForTab(numericTabId);
      if (!sourceJob) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Т‘Р В»РЎРЏ Р С—Р С•Р Р†РЎвЂљР С•РЎР‚Р В° Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°' } };
      }
      if (!Array.isArray(sourceJob.failedBlockIds) || !sourceJob.failedBlockIds.length) {
        return { ok: false, error: { code: 'NO_FAILED_BLOCKS', message: 'Р СњР ВµРЎвЂљ Р С•РЎв‚¬Р С‘Р В±Р С•РЎвЂЎР Р…РЎвЂ№РЎвЂ¦ Р В±Р В»Р С•Р С”Р С•Р Р† Р Т‘Р В»РЎРЏ Р С—Р С•Р Р†РЎвЂљР С•РЎР‚Р Р…Р С•Р в„– Р С—Р С•Р С—РЎвЂ№РЎвЂљР С”Р С‘' } };
      }

      const pendingBlockIds = sourceJob.failedBlockIds.slice();
      sourceJob.failedBlockIds = [];
      sourceJob.pendingBlockIds = pendingBlockIds;
      sourceJob.status = 'running';
      sourceJob.message = 'Р СџР С•Р Р†РЎвЂљР С•РЎР‚РЎРЏРЎР‹ Р С•РЎв‚¬Р С‘Р В±Р С•РЎвЂЎР Р…РЎвЂ№Р Вµ Р В±Р В»Р С•Р С”Р С‘';
      sourceJob.lastError = null;
      sourceJob.currentBatchId = null;

      await this._saveJob(sourceJob, { setActive: true });
      await this._ensureContentRuntime(numericTabId);
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Р СџР С•Р Р†РЎвЂљР С•РЎР‚Р Р…Р С• Р В·Р В°Р С—РЎС“РЎРѓР С”Р В°РЎР‹ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р С•РЎв‚¬Р С‘Р В±Р С•РЎвЂЎР Р…РЎвЂ№РЎвЂ¦ Р В±Р В»Р С•Р С”Р С•Р Р†', {
        tabId: numericTabId,
        jobId: sourceJob.id,
        blockCount: pendingBlockIds.length
      });
      this._processJob(sourceJob.id).catch(() => {});
      return { ok: true, job: this._toJobSummary(sourceJob) };
    }

    async restoreStateAfterRestart() {
      const activeJobs = await this.jobStore.listActiveJobs();
      const now = Date.now();
      const settings = await this._readAgentSettings().catch(() => null);
      for (const job of activeJobs) {
        if (!job) {
          continue;
        }
        const leaseExpiredAtRestore = typeof job.leaseUntilTs === 'number' && job.leaseUntilTs < now;
        this._ensureJobRunSettings(job, { settings });
        await this._saveJob(job, { setActive: true });
        if (leaseExpiredAtRestore) {
          const hasCreatedAt = Number.isFinite(Number(job.createdAt));
          const createdAt = hasCreatedAt ? Number(job.createdAt) : now;
          const tooOld = hasCreatedAt && (now - createdAt > this.MAX_JOB_AGE_MS);
          if (tooOld) {
            await this._markFailed(job, {
              code: 'JOB_TOO_OLD',
              message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° РЎРѓР В»Р С‘РЎв‚¬Р С”Р С•Р С РЎРѓРЎвЂљР В°РЎР‚Р В°РЎРЏ Р Т‘Р В»РЎРЏ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С‘РЎРЏ Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°'
            });
            continue;
          }
          job.status = 'preparing';
          job.message = 'Р вЂ™Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С‘Р Вµ Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°; Р С—Р ВµРЎР‚Р ВµРЎРѓР С”Р В°Р Р…Р С‘РЎР‚РЎС“РЎР‹ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎС“';
          job.scanReceived = false;
          job.scanRequestedAt = Date.now();
          job.scanNudgeTs = 0;
          job.currentBatchId = null;
          await this._saveJob(job, { setActive: true });
        }
        const tabReady = await this._ensureJobTabReady(job);
        if (!tabReady.ok) {
          await this._markFailed(job, tabReady.error || {
            code: 'TAB_UNAVAILABLE_AFTER_RESTART',
            message: 'Р вЂ™Р С”Р В»Р В°Р Т‘Р С”Р В° Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р Р…Р В° Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°; Р С—РЎР‚Р С•Р Т‘Р С•Р В»Р В¶Р С‘РЎвЂљРЎРЉ Р В·Р В°Р Т‘Р В°РЎвЂЎРЎС“ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р Р…Р ВµР В»РЎРЉР В·РЎРЏ'
          });
          continue;
        }
        if (job.status === 'preparing' || job.status === 'planning' || job.status === 'awaiting_categories') {
          const injected = await this._ensureContentRuntime(job.tabId);
          if (!injected.ok) {
            await this._markFailed(job, {
              code: injected.error && injected.error.code ? injected.error.code : 'INJECT_FAILED',
              message: injected.error && injected.error.message ? injected.error.message : 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р С—Р С•Р Р†РЎвЂљР С•РЎР‚Р Р…Р С• Р Р†Р Р…Р ВµР Т‘РЎР‚Р С‘РЎвЂљРЎРЉ Р С”Р С•Р Р…РЎвЂљР ВµР Р…РЎвЂљ-РЎР‚Р В°Р Р…РЎвЂљР В°Р в„–Р С Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°'
            });
            continue;
          }
          await this._syncVisibilityToContent(job.tabId, {
            contentSessionId: job.contentSessionId || null,
            job
          }).catch(() => {});
          job.compareDiffThreshold = await this._getCompareDiffThreshold({ job });
          job.compareRendering = await this._getCompareRendering({ job });
          const protocol = NT.TranslationProtocol || {};
          job.scanRequestedAt = Date.now();
          job.scanNudgeTs = 0;
          const scanBudget = this._buildScanBudgetPayload(settings);
          const sent = await this._sendToTab(job.tabId, {
            type: protocol.BG_START_JOB,
            jobId: job.id,
            targetLang: job.targetLang || 'ru',
            mode: this._normalizeDisplayMode(job.displayMode, true),
            compareDiffThreshold: this._normalizeCompareDiffThreshold(job.compareDiffThreshold),
            compareRendering: this._normalizeCompareRendering(job.compareRendering),
            classifierObserveDomChanges: this._classifierObserveDomChangesEnabled(settings),
            ...scanBudget
          });
          if (!sent.ok) {
            await this._markFailed(job, {
              code: 'CONTENT_RUNTIME_UNREACHABLE',
              message: sent.error && sent.error.message ? sent.error.message : 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р Р†Р С•Р В·Р С•Р В±Р Р…Р С•Р Р†Р С‘РЎвЂљРЎРЉ Р С—Р С•Р Т‘Р С–Р С•РЎвЂљР С•Р Р†Р С”РЎС“ Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘ Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°'
            });
            continue;
          }
          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р В° Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°', {
            tabId: job.tabId,
            jobId: job.id,
            status: job.status
          });
          continue;
        }
        if (job.status === 'running' || job.status === 'completing') {
          const injected = await this._ensureContentRuntime(job.tabId);
          if (!injected.ok) {
            await this._markFailed(job, {
              code: injected.error && injected.error.code ? injected.error.code : 'INJECT_FAILED',
              message: injected.error && injected.error.message ? injected.error.message : 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р С‘РЎвЂљРЎРЉ Р С”Р С•Р Р…РЎвЂљР ВµР Р…РЎвЂљ-РЎР‚Р В°Р Р…РЎвЂљР В°Р в„–Р С Р Т‘Р В»РЎРЏ Р Р†РЎвЂ№Р С—Р С•Р В»Р Р…РЎРЏР ВµР СР С•Р в„– Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘'
            });
            continue;
          }
          await this._syncVisibilityToContent(job.tabId, {
            contentSessionId: job.contentSessionId || null,
            job
          }).catch(() => {});
          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Р вЂ™Р С•Р В·Р С•Р В±Р Р…Р С•Р Р†Р В»РЎРЏРЎР‹ Р Р†РЎвЂ№Р С—Р С•Р В»Р Р…РЎРЏР Р†РЎв‚¬РЎС“РЎР‹РЎРѓРЎРЏ Р В·Р В°Р Т‘Р В°РЎвЂЎРЎС“ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°', {
            tabId: job.tabId,
            jobId: job.id,
            status: job.status
          });
          this._processJob(job.id).catch(() => {});
        }
      }
    }

    async handleContentMessage({ message, sender } = {}) {
      const protocol = NT.TranslationProtocol || {};
      const tabId = sender && sender.tab && Number.isFinite(Number(sender.tab.id))
        ? Number(sender.tab.id)
        : null;
      const senderFrameId = sender && Number.isFinite(Number(sender.frameId))
        ? Number(sender.frameId)
        : null;
      const senderDocumentId = sender && typeof sender.documentId === 'string' && sender.documentId
        ? sender.documentId
        : null;
      const senderFrameUrl = sender && typeof sender.url === 'string' && sender.url
        ? sender.url
        : null;
      let parsed = null;
      if (protocol && typeof protocol.unwrap === 'function') {
        try {
          parsed = protocol.unwrap(message);
        } catch (_) {
          parsed = null;
        }
      }
      if (!parsed || typeof parsed !== 'object') {
        parsed = {
          type: message && message.type ? message.type : null,
          payload: message,
          meta: {},
          envelopeId: null
        };
      }
      const type = typeof parsed.type === 'string' ? parsed.type : null;
      const msg = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      const meta = parsed && parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      const contentCaps = msg && msg.contentCaps && typeof msg.contentCaps === 'object'
        ? msg.contentCaps
        : (meta && meta.clientCaps && meta.clientCaps.content && typeof meta.clientCaps.content === 'object'
          ? meta.clientCaps.content
          : null);
      if (!type || !protocol) {
        return { ok: false, error: { code: 'INVALID_CONTENT_MESSAGE', message: 'Р С›РЎвЂљРЎРѓРЎС“РЎвЂљРЎРѓРЎвЂљР Р†РЎС“Р ВµРЎвЂљ РЎвЂљР С‘Р С— РЎРѓР С•Р С•Р В±РЎвЂ°Р ВµР Р…Р С‘РЎРЏ' } };
      }

      if (type === protocol.CS_READY) {
        if (tabId !== null) {
          this._updateContentCapabilities(tabId, contentCaps, {
            frameId: senderFrameId,
            documentId: senderDocumentId,
            frameUrl: senderFrameUrl
          });
        }
        if (tabId !== null) {
          const active = await this.jobStore.getActiveJob(tabId);
          if (active && (active.status === 'preparing' || active.status === 'planning' || active.status === 'running' || active.status === 'completing' || active.status === 'awaiting_categories')) {
            const incomingSessionId = (msg && typeof msg.contentSessionId === 'string' && msg.contentSessionId)
              ? msg.contentSessionId
              : null;
            const previousSessionId = (active && typeof active.contentSessionId === 'string' && active.contentSessionId)
              ? active.contentSessionId
              : null;
            const hasSessionChanged = Boolean(incomingSessionId && previousSessionId && incomingSessionId !== previousSessionId);
            if (incomingSessionId) {
              active.contentSessionId = incomingSessionId;
            }

            const canSkipRescan = (
              active.status === 'awaiting_categories'
              && active.scanReceived === true
              && !hasSessionChanged
            );
            if (canSkipRescan) {
              active.displayMode = await this._resolveTabDisplayMode(tabId);
              active.compareDiffThreshold = await this._getCompareDiffThreshold({ job: active });
              await this._saveJob(active, { setActive: true });
              const sessionId = incomingSessionId || previousSessionId || null;
              await this._syncVisibilityToContent(tabId, { contentSessionId: sessionId, job: active }).catch(() => {});
              return { ok: true };
            }

            try {
              const prefix = `${active.id}:`;
              Array.from(this.pendingApplyAcks.keys()).forEach((key) => {
                if (typeof key === 'string' && key.indexOf(prefix) === 0) {
                  this.pendingApplyAcks.delete(key);
                }
              });
              Array.from(this.pendingDeltaAcks.keys()).forEach((key) => {
                if (typeof key === 'string' && key.indexOf(prefix) === 0) {
                  this.pendingDeltaAcks.delete(key);
                }
              });
            } catch (_) {
              // best-effort cleanup
            }
            active.status = 'preparing';
            active.message = 'Р С™Р С•Р Р…РЎвЂљР ВµР Р…РЎвЂљ-РЎРѓР С”РЎР‚Р С‘Р С—РЎвЂљ Р С—Р ВµРЎР‚Р ВµР С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎРЎвЂР Р…; Р С—Р ВµРЎР‚Р ВµРЎРѓР С”Р В°Р Р…Р С‘РЎР‚РЎС“РЎР‹ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎС“';
            active.scanReceived = false;
            active.scanRequestedAt = Date.now();
            active.scanNudgeTs = 0;
            active.currentBatchId = null;
            active.displayMode = await this._resolveTabDisplayMode(tabId);
            active.reconnectCount = Number.isFinite(Number(active.reconnectCount))
              ? Number(active.reconnectCount) + 1
              : 1;
            this._recordRuntimeAction(active, {
              tool: 'pageRuntime',
              status: 'warn',
              message: 'content.rescan.requested',
              meta: {
                jobId: active.id,
                reconnectCount: active.reconnectCount,
                hasSessionChanged
              }
            });
            await this._saveJob(active, { setActive: true });
            const sessionId = incomingSessionId || previousSessionId || null;
            active.compareDiffThreshold = await this._getCompareDiffThreshold({ job: active });
            active.compareRendering = await this._getCompareRendering({ job: active });
            await this._syncVisibilityToContent(tabId, { contentSessionId: sessionId, job: active }).catch(() => {});
            const reconnectSettings = await this._readAgentSettings().catch(() => null);
            const scanBudget = this._buildScanBudgetPayload(reconnectSettings);
            await this._sendToTab(tabId, {
              type: protocol.BG_START_JOB,
              jobId: active.id,
              targetLang: active.targetLang || 'ru',
              mode: this._normalizeDisplayMode(active.displayMode, true),
              compareDiffThreshold: this._normalizeCompareDiffThreshold(active.compareDiffThreshold),
              compareRendering: this._normalizeCompareRendering(active.compareRendering),
              classifierObserveDomChanges: this._classifierObserveDomChangesEnabled(reconnectSettings),
              ...scanBudget,
              ...(sessionId ? { contentSessionId: sessionId } : {})
            });
            this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Р С™Р С•Р Р…РЎвЂљР ВµР Р…РЎвЂљ-РЎРѓР С”РЎР‚Р С‘Р С—РЎвЂљ Р С—Р ВµРЎР‚Р ВµР С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎРЎвЂР Р…, Р В·Р В°Р Т‘Р В°РЎвЂЎР В° Р Р†Р С•Р В·Р С•Р В±Р Р…Р С•Р Р†Р В»Р ВµР Р…Р В°', {
              tabId,
              jobId: active.id
            });
          }
        }
        return { ok: true };
      }
      if (type === protocol.CS_HELLO_CAPS) {
        if (tabId !== null) {
          this._updateContentCapabilities(tabId, contentCaps, {
            frameId: senderFrameId,
            documentId: senderDocumentId,
            frameUrl: senderFrameUrl
          });
        }
        const runtimeCaps = this._buildRuntimeCapabilities(tabId);
        return {
          ok: true,
          tabId,
          frameId: senderFrameId,
          documentId: senderDocumentId,
          frameUrl: senderFrameUrl,
          contentCaps: tabId !== null ? (this.contentCapsByTab[String(tabId)] || null) : null,
          serverCaps: runtimeCaps && typeof runtimeCaps === 'object' ? runtimeCaps : {},
          toolsetWanted: meta && meta.toolsetWanted && typeof meta.toolsetWanted === 'object'
            ? meta.toolsetWanted
            : null
        };
      }
      if (type === protocol.CS_SCAN_RESULT) {
        return this._handleScanResult({
          message: msg,
          tabId,
          frameId: senderFrameId,
          documentId: senderDocumentId,
          frameUrl: senderFrameUrl
        });
      }
      if (type === protocol.CS_SCAN_PROGRESS) {
        return this._handleScanProgress({
          message: msg,
          tabId,
          frameId: senderFrameId
        });
      }
      if (type === protocol.CS_APPLY_ACK) {
        return this._handleApplyAck({ message: msg, tabId, frameId: senderFrameId });
      }
      if (type === protocol.CS_APPLY_DELTA_ACK) {
        return this._handleApplyDeltaAck({ message: msg, tabId, frameId: senderFrameId });
      }
      return { ok: false, error: { code: 'UNKNOWN_CONTENT_MESSAGE', message: `Р СњР ВµР С—Р С•Р Т‘Р Т‘Р ВµРЎР‚Р В¶Р С‘Р Р†Р В°Р ВµР СРЎвЂ№Р в„– РЎвЂљР С‘Р С— РЎРѓР С•Р С•Р В±РЎвЂ°Р ВµР Р…Р С‘РЎРЏ: ${type}` } };
    }

    _updateContentCapabilities(tabId, caps, frameMeta = null) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return;
      }
      const source = caps && typeof caps === 'object' ? caps : {};
      const meta = frameMeta && typeof frameMeta === 'object' ? frameMeta : {};
      const frameId = Number.isFinite(Number(meta.frameId)) ? Number(meta.frameId) : 0;
      const frameKey = String(frameId);
      const normalized = {
        domIndexerVersion: typeof source.domIndexerVersion === 'string' ? source.domIndexerVersion : 'v1',
        supportsApplyDelta: source.supportsApplyDelta !== false,
        supportsRestoreOriginal: source.supportsRestoreOriginal !== false,
        supportsHighlights: source.supportsHighlights === true,
        shadowDomScan: source.shadowDomScan !== false,
        maxDomWritesPerSecondHint: Number.isFinite(Number(source.maxDomWritesPerSecondHint))
          ? Math.max(1, Math.round(Number(source.maxDomWritesPerSecondHint)))
          : 24,
        selectorStability: source.selectorStability === 'high' || source.selectorStability === 'low'
          ? source.selectorStability
          : 'medium',
        frameId,
        documentId: typeof meta.documentId === 'string' && meta.documentId ? meta.documentId : null,
        frameUrl: typeof meta.frameUrl === 'string' && meta.frameUrl ? meta.frameUrl : null,
        updatedAt: Date.now()
      };
      const key = String(numericTabId);
      const current = this.contentCapsByTab[key] && typeof this.contentCapsByTab[key] === 'object'
        ? this.contentCapsByTab[key]
        : {};
      const byFrame = current.byFrame && typeof current.byFrame === 'object'
        ? { ...current.byFrame }
        : {};
      byFrame[frameKey] = normalized;
      const topFrameCaps = byFrame['0'] && typeof byFrame['0'] === 'object'
        ? byFrame['0']
        : normalized;
      this.contentCapsByTab[key] = {
        ...topFrameCaps,
        byFrame,
        frameCount: Object.keys(byFrame).length,
        updatedAt: Date.now()
      };
      if (this.onCapabilitiesChanged) {
        this.onCapabilitiesChanged({
          source: 'content',
          tabId: numericTabId,
          contentCaps: this.contentCapsByTab[key]
        });
      }
    }

    getContentCapabilitiesSnapshot() {
      return this.contentCapsByTab && typeof this.contentCapsByTab === 'object'
        ? JSON.parse(JSON.stringify(this.contentCapsByTab))
        : {};
    }

    _buildRuntimeCapabilities(tabId) {
      const external = this.capabilitiesProvider
        ? this.capabilitiesProvider({ tabId })
        : {};
      const contentCapsByTab = this.getContentCapabilitiesSnapshot();
      const contentCaps = contentCapsByTab && typeof contentCapsByTab === 'object'
        ? contentCapsByTab[String(tabId)] || null
        : null;
      return {
        ...(external && typeof external === 'object' ? external : {}),
        content: contentCaps
      };
    }

    async _handleScanProgress({ message, tabId, frameId = null }) {
      const jobId = message && message.jobId ? message.jobId : null;
      if (!jobId) {
        return { ok: false, error: { code: 'INVALID_SCAN_PROGRESS', message: 'РўСЂРµР±СѓРµС‚СЃСЏ jobId' } };
      }
      const job = await this.jobStore.getJob(jobId).catch(() => null);
      if (!job) {
        return { ok: true, ignored: true };
      }
      if (tabId !== null && job.tabId !== tabId) {
        return { ok: true, ignored: true };
      }
      if (this._isTerminalStatus(job.status)) {
        return { ok: true, ignored: true };
      }
      const progress = message && message.progress && typeof message.progress === 'object'
        ? message.progress
        : {};
      if (progress.routeChanged === true) {
        job.classificationStale = true;
        const routeHref = typeof progress.href === 'string' && progress.href ? progress.href : null;
        job.message = routeHref
          ? `Route changed; reclassify recommended (${routeHref})`
          : 'Route changed; reclassify recommended';
        if (this.tabStateStore && typeof this.tabStateStore.upsertStatusPatch === 'function') {
          await this.tabStateStore.upsertStatusPatch(job.tabId, {
            status: job.status || 'preparing',
            message: job.message,
            translationJobId: job.id,
            updatedAt: Date.now()
          }).catch(() => null);
        }
        await this._saveJob(job, { setActive: true });
        return { ok: true, routeChanged: true };
      }
      const visitedNodes = Number.isFinite(Number(progress.visitedNodes)) ? Number(progress.visitedNodes) : 0;
      const blocks = Number.isFinite(Number(progress.blocks)) ? Number(progress.blocks) : 0;
      const activeFrameId = Number.isFinite(Number(progress.frameId))
        ? Number(progress.frameId)
        : (Number.isFinite(Number(frameId)) ? Number(frameId) : 0);
      const now = Date.now();
      const lastTs = Number.isFinite(Number(job.scanProgressTs)) ? Number(job.scanProgressTs) : 0;
      if ((now - lastTs) < 450) {
        return { ok: true, throttled: true };
      }
      job.scanProgressTs = now;
      job.message = `Scanning DOM: nodes=${visitedNodes}, blocks=${blocks}, frame=${activeFrameId}`;
      if (job.agentState && job.agentState.frameMetrics && job.agentState.frameMetrics.frames) {
        const frames = job.agentState.frameMetrics.frames;
        frames.byFrame = frames.byFrame && typeof frames.byFrame === 'object' ? frames.byFrame : {};
        const key = String(activeFrameId);
        const current = frames.byFrame[key] && typeof frames.byFrame[key] === 'object'
          ? frames.byFrame[key]
          : {
            frameId: activeFrameId,
            frameUrl: typeof message.frameUrl === 'string' && message.frameUrl ? message.frameUrl : null,
            documentId: null,
            injected: true,
            scannedBlocksCount: 0,
            skippedReason: null
          };
        current.scannedBlocksCount = Math.max(
          Number.isFinite(Number(current.scannedBlocksCount)) ? Number(current.scannedBlocksCount) : 0,
          blocks
        );
        if (typeof message.frameUrl === 'string' && message.frameUrl) {
          current.frameUrl = message.frameUrl;
        }
        frames.byFrame[key] = current;
      }
      if (this.tabStateStore && typeof this.tabStateStore.upsertStatusPatch === 'function') {
        await this.tabStateStore.upsertStatusPatch(job.tabId, {
          status: job.status || 'preparing',
          message: job.message,
          translationJobId: job.id,
          updatedAt: now
        }).catch(() => null);
      }
      return { ok: true };
    }

    async _handleScanResult({ message, tabId, frameId = null, documentId = null, frameUrl = null }) {
      const jobId = message && message.jobId ? message.jobId : null;
      if (!jobId) {
        return { ok: false, error: { code: 'INVALID_SCAN_RESULT', message: 'Р СћРЎР‚Р ВµР В±РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ jobId' } };
      }
      const job = await this.jobStore.getJob(jobId);
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: `Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В°: ${jobId}` } };
      }
      if (tabId !== null && job.tabId !== tabId) {
        return { ok: false, error: { code: 'TAB_MISMATCH', message: 'Р СњР ВµРЎРѓР С•Р Р†Р С—Р В°Р Т‘Р ВµР Р…Р С‘Р Вµ Р Р†Р С”Р В»Р В°Р Т‘Р С”Р С‘ Р Р† РЎР‚Р ВµР В·РЎС“Р В»РЎРЉРЎвЂљР В°РЎвЂљР Вµ РЎРѓР С”Р В°Р Р…Р С‘РЎР‚Р С•Р Р†Р В°Р Р…Р С‘РЎРЏ' } };
      }
      if (message && typeof message.contentSessionId === 'string' && message.contentSessionId) {
        job.contentSessionId = message.contentSessionId;
      }
      if (this._isTerminalStatus(job.status)) {
        return { ok: true, ignored: true };
      }
      const scanError = message && message.scanError && typeof message.scanError === 'object'
        ? message.scanError
        : null;
      if (scanError && scanError.code === 'SCAN_TOO_HEAVY') {
        await this._markFailed(job, {
          code: 'SCAN_TOO_HEAVY',
          message: scanError.message || 'DOM scan exceeded performance budget'
        });
        return {
          ok: false,
          error: {
            code: 'SCAN_TOO_HEAVY',
            message: scanError.message || 'DOM scan exceeded performance budget'
          }
        };
      }
      const scanPerf = message && message.scanPerf && typeof message.scanPerf === 'object'
        ? message.scanPerf
        : null;
      if (scanPerf && Number.isFinite(Number(scanPerf.scanTimeMs))) {
        this._recordPerfJobMetric(job, 'scanTimeMs', Number(scanPerf.scanTimeMs));
      }
      if (scanPerf && scanPerf.abortedByBudget === true) {
        if (!job.agentState || typeof job.agentState !== 'object') {
          job.agentState = {};
        }
        const reports = Array.isArray(job.agentState.reports) ? job.agentState.reports : [];
        const hasBudgetReport = reports.some((item) => item && item.code === 'SCAN_DEGRADED');
        if (!hasBudgetReport) {
          reports.push({
            ts: Date.now(),
            code: 'SCAN_DEGRADED',
            level: 'warn',
            summary: 'Scan budget reached; using partial DOM snapshot',
            detail: {
              scanTimeMs: Number.isFinite(Number(scanPerf.scanTimeMs)) ? Number(scanPerf.scanTimeMs) : null,
              visitedNodes: Number.isFinite(Number(scanPerf.visitedNodes)) ? Number(scanPerf.visitedNodes) : null
            }
          });
          job.agentState.reports = reports.slice(-120);
        }
        job.message = 'Scan budget reached; using partial snapshot';
      }

      const payloadFrameId = Number.isFinite(Number(message && message.frameId))
        ? Number(message.frameId)
        : (Number.isFinite(Number(frameId)) ? Number(frameId) : 0);
      const normalized = this._normalizeBlocks(message.blocks, {
        frameId: payloadFrameId
      });
      this._mergeFrameShadowMetricsIntoJob(job, {
        frameId: payloadFrameId,
        frameUrl: typeof frameUrl === 'string' && frameUrl
          ? frameUrl
          : (typeof message.frameUrl === 'string' ? message.frameUrl : null),
        documentId: typeof documentId === 'string' && documentId
          ? documentId
          : (typeof message.documentId === 'string' ? message.documentId : null),
        scanStats: message && message.scanStats && typeof message.scanStats === 'object'
          ? message.scanStats
          : null
      });
      if (job.agentState && job.agentState.frameMetrics && job.agentState.frameMetrics.frames) {
        const frames = job.agentState.frameMetrics.frames;
        frames.byFrame = frames.byFrame && typeof frames.byFrame === 'object' ? frames.byFrame : {};
        const frameCounts = {};
        normalized.forEach((item) => {
          const id = Number.isFinite(Number(item && item.frameId)) ? Number(item.frameId) : 0;
          const key = String(id);
          frameCounts[key] = Number.isFinite(Number(frameCounts[key])) ? Number(frameCounts[key]) + 1 : 1;
          if (!frames.byFrame[key] || typeof frames.byFrame[key] !== 'object') {
            frames.byFrame[key] = {
              frameId: id,
              frameUrl: typeof item.frameUrl === 'string' && item.frameUrl ? item.frameUrl : null,
              documentId: null,
              injected: true,
              scannedBlocksCount: 0,
              skippedReason: null
            };
          } else if (!frames.byFrame[key].frameUrl && typeof item.frameUrl === 'string' && item.frameUrl) {
            frames.byFrame[key].frameUrl = item.frameUrl;
          }
        });
        Object.keys(frameCounts).forEach((key) => {
          const row = frames.byFrame[key] && typeof frames.byFrame[key] === 'object'
            ? frames.byFrame[key]
            : null;
          if (!row) {
            return;
          }
          row.scannedBlocksCount = Math.max(
            Number.isFinite(Number(row.scannedBlocksCount)) ? Number(row.scannedBlocksCount) : 0,
            Number(frameCounts[key] || 0)
          );
          row.injected = row.injected !== false;
          frames.byFrame[key] = row;
        });
        frames.totalSeen = Math.max(Number.isFinite(Number(frames.totalSeen)) ? Number(frames.totalSeen) : 0, Object.keys(frameCounts).length);
        frames.scannedOk = Math.max(Number.isFinite(Number(frames.scannedOk)) ? Number(frames.scannedOk) : 0, Object.keys(frameCounts).length);
        const injectedCount = Object.keys(frames.byFrame)
          .map((key) => frames.byFrame[key])
          .filter((row) => row && row.injected !== false)
          .length;
        frames.injectedOk = Math.max(Number.isFinite(Number(frames.injectedOk)) ? Number(frames.injectedOk) : 0, injectedCount);
        job.agentState.frameMetrics.frames = frames;
      }
      const settings = await this._readAgentSettings();
      job.compareDiffThreshold = this._normalizeCompareDiffThreshold(settings.translationCompareDiffThreshold);
      await this._computeMemoryContext({
        job,
        blocks: normalized,
        settings
      });
      const memoryRestore = await this._restoreFromTranslationMemory({
        job,
        blocks: normalized,
        settings,
        applyToTab: true
      });
      if (memoryRestore && memoryRestore.appliedCount > 0) {
        job.memoryRestore = memoryRestore;
      }
      this._recordRuntimeAction(job, {
        tool: 'pageRuntime',
        status: 'ok',
        message: 'content.scan.received',
        meta: {
          blockCount: normalized.length,
          categories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice() : []
        }
      });
      const resumeCandidate = job.categorySelectionConfirmed === true
        && Array.isArray(job.selectedCategories)
        && job.selectedCategories.length > 0;
      if (resumeCandidate) {
        const resumed = await this._resumeAfterReloadScan({ job, normalized, settings });
        if (resumed) {
          return resumed;
        }
      }
      const allowMemoryAwaitingShortcut = false;
      if (
        allowMemoryAwaitingShortcut
        && (
        memoryRestore
        && memoryRestore.ok
        && memoryRestore.coverage === 'full_page'
        && memoryRestore.matchType === 'exact_page_key'
        && !resumeCandidate
        )
      ) {
        const latest = await this.jobStore.getJob(job.id);
        if (!latest || this._isTerminalStatus(latest.status)) {
          return { ok: true, ignored: true };
        }
        if (message && typeof message.contentSessionId === 'string' && message.contentSessionId) {
          latest.contentSessionId = message.contentSessionId;
        }
        const blocksById = {};
        normalized.forEach((item) => {
          blocksById[item.blockId] = item;
        });
        const availableCategories = this._collectAvailableCategories(blocksById);
        const recommendedCategories = this._normalizeSelectedCategories(
          Array.isArray(memoryRestore.recommendedCategories) ? memoryRestore.recommendedCategories : availableCategories,
          availableCategories,
          availableCategories
        );
        latest.scanReceived = true;
        latest.blocksById = blocksById;
        latest.totalBlocks = 0;
        latest.pendingBlockIds = [];
        latest.pendingRangeIds = [];
        latest.failedBlockIds = [];
        latest.completedBlocks = 0;
        latest.status = 'awaiting_categories';
        latest.message = `Р вЂ™Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С• Р С‘Р В· Р С—Р В°Р СРЎРЏРЎвЂљР С‘: ${memoryRestore.restoredCount} Р В±Р В»Р С•Р С”Р С•Р Р†. Р вЂ™РЎвЂ№Р В±Р ВµРЎР‚Р С‘РЎвЂљР Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘.`;
        latest.pageSignature = this._buildPageSignature(normalized);
        latest.cacheKey = this.pageCacheStore
          ? this.pageCacheStore.buildKey({ url: latest.url || '', targetLang: latest.targetLang || 'ru' })
          : null;
        latest.availableCategories = availableCategories;
        latest.selectedCategories = recommendedCategories;
        latest.selectedRangeIds = [];
        latest.apiCacheEnabled = settings.translationApiCacheEnabled !== false;
        this._ensureMemoryAgentState(latest, settings, memoryRestore);
        await this._saveJob(latest, { setActive: true });
        return {
          ok: true,
          blockCount: normalized.length,
          awaitingCategorySelection: true,
          fromMemory: true,
          availableCategories,
          selectedCategories: recommendedCategories
        };
      }
      const scanBlocksById = {};
      normalized.forEach((item) => {
        if (!item || !item.blockId) {
          return;
        }
        if (!item.quality || typeof item.quality !== 'object') {
          item.quality = {
            tag: 'raw',
            lastUpdatedTs: null,
            modelUsed: null,
            routeUsed: null,
            pass: null
          };
        }
        scanBlocksById[item.blockId] = item;
      });
      const preRanges = this._normalizePreRanges(message && message.preRanges, scanBlocksById);
      const preRangesById = {};
      preRanges.forEach((range) => {
        if (!range || !range.rangeId) {
          return;
        }
        preRangesById[range.rangeId] = range;
      });
      const pageStats = this._buildPreanalysisStats({
        blocksById: scanBlocksById,
        preRanges,
        scanStats: message && message.scanStats && typeof message.scanStats === 'object'
          ? message.scanStats
          : null
      });
      const preanalysisVersion = 'dom-preanalysis/1.0.0';

      job.scanReceived = true;
      job.blocksById = scanBlocksById;
      job.totalBlocks = 0;
      job.pendingBlockIds = [];
      job.pendingRangeIds = [];
      job.failedBlockIds = [];
      job.completedBlocks = 0;
      job.pageSignature = this._buildPageSignature(normalized);
      job.cacheKey = this.pageCacheStore
        ? this.pageCacheStore.buildKey({ url: job.url || '', targetLang: job.targetLang || 'ru' })
        : null;
      job.availableCategories = [];
      job.selectedCategories = [];
      job.selectedRangeIds = [];
      job.categorySelectionConfirmed = false;
      job.pageAnalysis = {
        domHash: job.domHash || job.pageSignature || null,
        blocksById: scanBlocksById,
        preRangesById,
        stats: pageStats,
        preanalysisVersion,
        updatedAt: Date.now()
      };
      job.status = normalized.length ? 'planning' : 'done';
      job.message = normalized.length
        ? `Pre-analysis Р·Р°РІРµСЂС€С‘РЅ (${normalized.length} Р±Р»РѕРєРѕРІ). РђРіРµРЅС‚ С„РѕСЂРјРёСЂСѓРµС‚ РїР»Р°РЅ.`
        : 'РџРµСЂРµРІРѕРґРёРјС‹С… Р±Р»РѕРєРѕРІ РЅРµ РЅР°Р№РґРµРЅРѕ';
      if (!normalized.length) {
        await this._saveJob(job, { clearActive: true });
        return { ok: true, blockCount: 0 };
      }
      await this._saveJob(job, { setActive: true });

      const planningSettings = {
        ...settings,
        translationCategoryMode: 'auto',
        translationCategoryList: []
      };
      this._ensureJobRunSettings(job, { settings: planningSettings });
      const prepared = await this._prepareAgentJob({
        job,
        blocks: normalized,
        settings: planningSettings
      });
      if (!prepared || !prepared.agentState) {
        await this._markFailed(job, {
          code: 'PREPARE_AGENT_STATE_FAILED',
          message: 'РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕРґРіРѕС‚РѕРІРёС‚СЊ СЃРѕСЃС‚РѕСЏРЅРёРµ planning-Р°РіРµРЅС‚Р°'
        });
        return {
          ok: false,
          error: {
            code: 'PREPARE_AGENT_STATE_FAILED',
            message: 'РќРµ СѓРґР°Р»РѕСЃСЊ РїРѕРґРіРѕС‚РѕРІРёС‚СЊ СЃРѕСЃС‚РѕСЏРЅРёРµ planning-Р°РіРµРЅС‚Р°'
          }
        };
      }
      if (!this.translationAgent || typeof this.translationAgent.runPlanning !== 'function') {
        await this._markFailed(job, {
          code: 'PLANNING_RUNNER_UNAVAILABLE',
          message: 'Planning runner unavailable'
        });
        return {
          ok: false,
          error: {
            code: 'PLANNING_RUNNER_UNAVAILABLE',
            message: 'Planning runner unavailable'
          }
        };
      }

      let planningResult = null;
      try {
        planningResult = await this.translationAgent.runPlanning({
          job,
          blocks: normalized,
          settings: planningSettings
        });
      } catch (error) {
        const planningError = {
          code: error && error.code ? error.code : 'PLANNING_FAILED',
          message: error && error.message ? error.message : 'Planning loop failed'
        };
        await this._markFailed(job, planningError);
        return {
          ok: false,
          error: planningError
        };
      }

      let latest = null;
      try {
        latest = await this.jobStore.getJob(job.id);
      } catch (_) {
        latest = null;
      }
      if (!latest || this._isTerminalStatus(latest.status) || latest.tabId !== job.tabId) {
        return { ok: true, ignored: true };
      }
      if (latest.status !== 'awaiting_categories') {
        const missing = planningResult && Array.isArray(planningResult.missingRequired)
          ? planningResult.missingRequired
          : [];
        await this._markFailed(latest, {
          code: 'PLANNING_INCOMPLETE',
          message: `Planning Р·Р°РІРµСЂС€РёР»СЃСЏ Р±РµР· Р·Р°РїСЂРѕСЃР° РєР°С‚РµРіРѕСЂРёР№ РїРѕР»СЊР·РѕРІР°С‚РµР»СЏ. Missing: ${missing.join(', ') || 'unknown'}`
        });
        return {
          ok: false,
          error: {
            code: 'PLANNING_INCOMPLETE',
            message: 'Planning Р·Р°РІРµСЂС€РёР»СЃСЏ Р±РµР· СЌС‚Р°РїР° awaiting_categories'
          }
        };
      }

      const recommendations = latest.agentState
        && latest.agentState.categoryRecommendations
        && typeof latest.agentState.categoryRecommendations === 'object'
        ? latest.agentState.categoryRecommendations
        : null;
      const availableCategories = Array.isArray(latest.availableCategories)
        ? latest.availableCategories.slice()
        : [];
      const selectedCategories = Array.isArray(latest.selectedCategories)
        ? latest.selectedCategories.slice()
        : (recommendations && Array.isArray(recommendations.recommended)
          ? recommendations.recommended.slice()
          : []);

      await this._saveJob(latest, { setActive: true });
      return {
        ok: true,
        blockCount: normalized.length,
        awaitingCategorySelection: true,
        availableCategories,
        selectedCategories
      };
    }

    async _resumeAfterReloadScan({ job, normalized, settings } = {}) {
      if (!job || !Array.isArray(normalized)) {
        return null;
      }
      this._recordRuntimeAction(job, {
        tool: 'pageRuntime',
        status: 'ok',
        message: 'content.resume.reload_scan',
        meta: {
          blockCount: normalized.length,
          categories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : []
        }
      });

      const oldBlocksById = job.blocksById && typeof job.blocksById === 'object'
        ? job.blocksById
        : {};
      const memory = job.translationMemoryBySource && typeof job.translationMemoryBySource === 'object'
        ? job.translationMemoryBySource
        : null;
      const hasMemory = Boolean(memory && Object.keys(memory).length > 0);
      if (!hasMemory) {
        try {
          const oldBlocks = Object.keys(oldBlocksById)
            .map((id) => oldBlocksById[id])
            .filter(Boolean);
          const oldItems = oldBlocks
            .filter((block) => block && block.blockId && typeof block.translatedText === 'string' && block.translatedText)
            .map((block) => ({ blockId: block.blockId, text: block.translatedText }));
          if (oldItems.length) {
            this._updateTranslationMemory(job, oldBlocks, oldItems);
          }
        } catch (_) {
          // best-effort only
        }
      }

      const blocksById = {};
      normalized.forEach((item) => {
        if (!item || !item.blockId) {
          return;
        }
        blocksById[item.blockId] = { ...item };
      });
      const availableCategories = this._collectAvailableCategories(blocksById, this._classificationByBlockId(job));
      const availableSet = new Set(availableCategories);
      const effectiveSelectedCategories = [];
      (Array.isArray(job.selectedCategories) ? job.selectedCategories : []).forEach((item) => {
        const category = this._normalizeCategory(String(item || ''));
        if (!availableSet.has(category) || effectiveSelectedCategories.includes(category)) {
          return;
        }
        effectiveSelectedCategories.push(category);
      });
      if (!effectiveSelectedCategories.length) {
        this._recordRuntimeAction(job, {
          tool: 'pageRuntime',
          status: 'warn',
          message: 'content.resume.categories_mismatch',
          meta: {
            availableCategories: availableCategories.slice(0, 24)
          }
        });
        return null;
      }

      job.blocksById = blocksById;
      const selectedSet = new Set(effectiveSelectedCategories);
      const restoredByMemory = this._buildCachedItemsForBatch(job, { blocks: normalized });
      const restoredMap = {};
      restoredByMemory.forEach((item) => {
        if (!item || !item.blockId || typeof item.text !== 'string') {
          return;
        }
        if (!blocksById[item.blockId]) {
          return;
        }
        const block = blocksById[item.blockId];
        const category = this._resolveBlockCategory({
          blockId: item.blockId,
          block,
          classificationByBlockId: this._classificationByBlockId(job)
        });
        if (!selectedSet.has(category)) {
          return;
        }
        restoredMap[item.blockId] = item.text;
      });
      const restoredItems = Object.keys(restoredMap).map((blockId) => ({ blockId, text: restoredMap[blockId] }));
      const restoredBlockIds = [];
      restoredItems.forEach((item) => {
        if (job.blocksById && job.blocksById[item.blockId]) {
          job.blocksById[item.blockId].translatedText = item.text;
          restoredBlockIds.push(item.blockId);
        }
      });
      const restoredApply = await this._applyItemsToTab({
        job,
        items: restoredItems,
        batchPrefix: 'reload_restore'
      });
      if (!restoredApply.ok) {
        this._emitEvent(
          'warn',
          NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume',
          'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р С—Р С•Р Р†РЎвЂљР С•РЎР‚Р Р…Р С• Р С—РЎР‚Р С‘Р СР ВµР Р…Р С‘РЎвЂљРЎРЉ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р Р…РЎвЂ№Р Вµ Р С—Р ВµРЎР‚Р ВµР Р†Р ВµР Т‘РЎвЂР Р…Р Р…РЎвЂ№Р Вµ Р В±Р В»Р С•Р С”Р С‘ Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С–РЎР‚РЎС“Р В·Р С”Р С‘',
          {
            tabId: job.tabId,
            jobId: job.id,
            restoredCount: restoredItems.length
          }
        );
        restoredBlockIds.forEach((blockId) => {
          if (job.blocksById && job.blocksById[blockId]) {
            job.blocksById[blockId].translatedText = '';
          }
        });
      }

      const selectedBlockIds = this._resolveSelectedBlockIds(job, effectiveSelectedCategories, this._classificationByBlockId(job));
      const selectedRangeIds = this._resolveSelectedRangeIds(job, effectiveSelectedCategories);
      const pendingBlockIds = [];
      let completedBlocks = 0;
      selectedBlockIds.forEach((blockId) => {
        const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
        const translatedText = block && typeof block.translatedText === 'string' ? block.translatedText : '';
        if (translatedText) {
          completedBlocks += 1;
        } else {
          pendingBlockIds.push(blockId);
        }
      });

      job.scanReceived = true;
      job.totalBlocks = selectedBlockIds.length;
      job.pendingBlockIds = pendingBlockIds;
      job.selectedRangeIds = selectedRangeIds;
      job.pendingRangeIds = this._resolvePendingRangeIds(job, selectedRangeIds);
      job.failedBlockIds = Array.isArray(job.failedBlockIds)
        ? job.failedBlockIds.filter((id) => selectedBlockIds.includes(id))
        : [];
      job.completedBlocks = completedBlocks;
      job.currentBatchId = null;
      job.lastError = null;
      job.pageSignature = this._buildPageSignature(normalized);
      job.cacheKey = this.pageCacheStore
        ? this.pageCacheStore.buildKey({ url: job.url || '', targetLang: job.targetLang || 'ru' })
        : null;
      job.availableCategories = availableCategories;
      job.selectedCategories = effectiveSelectedCategories;
      job.apiCacheEnabled = settings && Object.prototype.hasOwnProperty.call(settings, 'translationApiCacheEnabled')
        ? settings.translationApiCacheEnabled !== false
        : (job.apiCacheEnabled !== false);
      job.proofreadingState = {
        totalPasses: this._resolvePlannedProofreadingPasses(job),
        completedPasses: 0,
        updatedAt: Date.now()
      };
      const proof = this._ensureJobProofreadingState(job);
      proof.enabled = false;
      proof.mode = 'auto';
      proof.pass = 0;
      proof.pendingBlockIds = [];
      proof.doneBlockIds = [];
      proof.failedBlockIds = [];
      proof.lastPlanTs = null;
      proof.lastError = null;
      if (job.agentState && typeof job.agentState === 'object') {
        job.agentState.selectedCategories = effectiveSelectedCategories.slice();
      }

      if (!job.totalBlocks) {
        job.status = 'done';
        job.message = 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р С‘Р СРЎвЂ№РЎвЂ¦ Р В±Р В»Р С•Р С”Р С•Р Р† Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р С•';
        this._recordRuntimeAction(job, {
          tool: 'pageRuntime',
          status: 'ok',
          message: 'content.resume.empty',
          meta: {
            restoredCount: completedBlocks
          }
        });
        await this._saveJob(job, { clearActive: true });
        return {
          ok: true,
          blockCount: normalized.length,
          awaitingCategorySelection: false,
          resumed: true,
          restoredCount: completedBlocks
        };
      }

      if (!pendingBlockIds.length) {
        job.status = 'done';
        job.message = 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р… Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С–РЎР‚РЎС“Р В·Р С”Р С‘ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎвЂ№';
        this._recordRuntimeAction(job, {
          tool: 'pageRuntime',
          status: 'ok',
          message: 'content.resume.complete',
          meta: {
            restoredCount: completedBlocks,
            totalBlocks: job.totalBlocks
          }
        });
        if (this.translationAgent && job.agentState && typeof this.translationAgent.finalizeJob === 'function') {
          this.translationAgent.finalizeJob(job);
        }
        const keepActiveAfterDone = this._shouldKeepJobActiveForCategoryExtensions(job);
        await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
        return {
          ok: true,
          blockCount: normalized.length,
          awaitingCategorySelection: false,
          resumed: true,
          restoredCount: completedBlocks,
          canSelectMore: keepActiveAfterDone
        };
      }

      job.status = 'running';
      job.message = 'Р вЂ™Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С• Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С–РЎР‚РЎС“Р В·Р С”Р С‘ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎвЂ№; Р С—РЎР‚Р С•Р Т‘Р С•Р В»Р В¶Р В°РЎР‹ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘';
      this._recordRuntimeAction(job, {
        tool: 'pageRuntime',
        status: 'ok',
        message: 'content.resume.running',
        meta: {
          restoredCount: completedBlocks,
          pendingCount: pendingBlockIds.length,
          totalBlocks: job.totalBlocks
        }
      });
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(job, 'resumed', `Р вЂ™Р С•Р В·Р С•Р В±Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С•; Р С•РЎРѓРЎвЂљР В°Р В»Р С•РЎРѓРЎРЉ Р В±Р В»Р С•Р С”Р С•Р Р†: ${pendingBlockIds.length}`);
      }
      await this._saveJob(job, { setActive: true });
      this._processJob(job.id).catch(() => {});
      return {
        ok: true,
        blockCount: normalized.length,
        awaitingCategorySelection: false,
        resumed: true,
        restoredCount: completedBlocks
      };
    }

    async _handleApplyAck({ message, tabId, frameId = null }) {
      const jobId = message && message.jobId ? message.jobId : null;
      const batchId = message && message.batchId ? message.batchId : null;
      if (!jobId || !batchId) {
        return { ok: false, error: { code: 'INVALID_APPLY_ACK', message: 'Р СћРЎР‚Р ВµР В±РЎС“РЎР‹РЎвЂљРЎРѓРЎРЏ jobId Р С‘ batchId' } };
      }
      const sessionIdFromMsg = message && typeof message.contentSessionId === 'string' && message.contentSessionId
        ? message.contentSessionId
        : null;
      let job = null;
      try {
        job = await this.jobStore.getJob(jobId);
      } catch (_) {
        job = null;
      }
      const sessionIdFromJob = job && typeof job.contentSessionId === 'string' && job.contentSessionId
        ? job.contentSessionId
        : null;
      if (sessionIdFromMsg && sessionIdFromJob && sessionIdFromMsg !== sessionIdFromJob) {
        return { ok: true, ignored: true };
      }

      const keys = [];
      const pushKey = (key) => {
        if (key && !keys.includes(key)) {
          keys.push(key);
        }
      };
      pushKey(this._ackKey(jobId, batchId, sessionIdFromMsg));
      pushKey(this._ackKey(jobId, batchId, sessionIdFromJob));
      pushKey(this._ackKey(jobId, batchId, null));

      let waiter = null;
      for (let i = 0; i < keys.length; i += 1) {
        waiter = this.pendingApplyAcks.get(keys[i]);
        if (waiter) {
          break;
        }
      }
      if (!waiter) {
        return { ok: true, ignored: true };
      }
      waiter.resolve({
        ok: message.ok !== false,
        appliedCount: Number.isFinite(Number(message.appliedCount)) ? Number(message.appliedCount) : null,
        tabId,
        frameId: Number.isFinite(Number(frameId))
          ? Number(frameId)
          : (Number.isFinite(Number(message.frameId)) ? Number(message.frameId) : null)
      });
      return { ok: true };
    }

    async _handleApplyDeltaAck({ message, tabId, frameId = null }) {
      const jobId = message && message.jobId ? message.jobId : null;
      const blockId = message && message.blockId ? message.blockId : null;
      const deltaId = message && typeof message.deltaId === 'string' && message.deltaId
        ? message.deltaId
        : null;
      if (!jobId || !blockId) {
        return { ok: false, error: { code: 'INVALID_APPLY_DELTA_ACK', message: 'Р СћРЎР‚Р ВµР В±РЎС“РЎР‹РЎвЂљРЎРѓРЎРЏ jobId Р С‘ blockId' } };
      }
      const sessionIdFromMsg = message && typeof message.contentSessionId === 'string' && message.contentSessionId
        ? message.contentSessionId
        : null;
      let job = null;
      try {
        job = await this.jobStore.getJob(jobId);
      } catch (_) {
        job = null;
      }
      const sessionIdFromJob = job && typeof job.contentSessionId === 'string' && job.contentSessionId
        ? job.contentSessionId
        : null;
      if (sessionIdFromMsg && sessionIdFromJob && sessionIdFromMsg !== sessionIdFromJob) {
        return { ok: true, ignored: true };
      }

      const keys = [];
      const pushKey = (key) => {
        if (key && !keys.includes(key)) {
          keys.push(key);
        }
      };
      pushKey(this._deltaAckKey(jobId, blockId, deltaId, sessionIdFromMsg));
      pushKey(this._deltaAckKey(jobId, blockId, deltaId, sessionIdFromJob));
      pushKey(this._deltaAckKey(jobId, blockId, deltaId, null));
      pushKey(this._deltaAckKey(jobId, blockId, null, sessionIdFromMsg));
      pushKey(this._deltaAckKey(jobId, blockId, null, sessionIdFromJob));
      pushKey(this._deltaAckKey(jobId, blockId, null, null));

      let waiter = null;
      for (let i = 0; i < keys.length; i += 1) {
        waiter = this.pendingDeltaAcks.get(keys[i]);
        if (waiter) {
          break;
        }
      }
      if (!waiter) {
        return { ok: true, ignored: true };
      }
      waiter.resolve({
        ok: message.ok !== false,
        applied: message.applied === true,
        isFinal: message.isFinal === true,
        prevTextHash: typeof message.prevTextHash === 'string' ? message.prevTextHash : null,
        nextTextHash: typeof message.nextTextHash === 'string' ? message.nextTextHash : null,
        nodeCountTouched: Number.isFinite(Number(message.nodeCountTouched))
          ? Number(message.nodeCountTouched)
          : 0,
        displayMode: typeof message.displayMode === 'string' ? message.displayMode : null,
        compare: message && message.compare && typeof message.compare === 'object'
          ? message.compare
          : null,
        rebindAttempts: Number.isFinite(Number(message.rebindAttempts))
          ? Math.max(0, Number(message.rebindAttempts))
          : 0,
        tabId,
        frameId: Number.isFinite(Number(frameId))
          ? Number(frameId)
          : (Number.isFinite(Number(message.frameId)) ? Number(message.frameId) : null)
      });
      return { ok: true };
    }

    async _processJob(jobId) {
      if (!jobId || this.processingJobs.has(jobId)) {
        return;
      }
      this.processingJobs.add(jobId);
      try {
        while (true) {
          const job = await this.jobStore.getJob(jobId);
          if (!job || job.status !== 'running') {
            break;
          }
          if (this.translationAgent && job.agentState) {
            if (typeof this.translationAgent.runProgressAuditTool === 'function') {
              this.translationAgent.runProgressAuditTool({ job, reason: 'loop_start', mandatory: true });
            } else if (typeof this.translationAgent.maybeAudit === 'function') {
              this.translationAgent.maybeAudit({ job, reason: 'loop_start', mandatory: true });
            }
          }
          const agentSettings = await this._readAgentSettings();
          if (this._shouldUseAgentExecution(agentSettings)) {
            const agentResult = await this._processJobAgentExecution(job, agentSettings);
            if (!agentResult || !agentResult.fallbackLegacy) {
              if (agentResult && agentResult.continueLoop) {
                continue;
              }
              break;
            }
          }
          const nextBatch = this._buildNextBatch(job);
          if (!nextBatch) {
            const proofreadRan = await this._runProofreadingPassIfNeeded(job);
            if (proofreadRan) {
              continue;
            }
            job.status = job.failedBlockIds.length ? 'failed' : 'done';
            job.message = job.failedBlockIds.length ? 'Р вЂ”Р В°Р Р†Р ВµРЎР‚РЎв‚¬Р ВµР Р…Р С• РЎРѓ Р С•РЎв‚¬Р С‘Р В±Р С”Р В°Р СР С‘ Р Р† Р В±Р В»Р С•Р С”Р В°РЎвЂ¦' : 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р…';
            if (this.translationAgent && job.agentState) {
              if (job.status === 'done' && typeof this.translationAgent.finalizeJob === 'function') {
                this.translationAgent.finalizeJob(job);
              }
              if (job.status === 'failed' && typeof this.translationAgent.markFailed === 'function') {
                this.translationAgent.markFailed(job, {
                  code: 'FAILED_BLOCKS_PRESENT',
                  message: 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р… РЎРѓ Р С•РЎв‚¬Р С‘Р В±Р С”Р В°Р СР С‘ Р Р† Р В±Р В»Р С•Р С”Р В°РЎвЂ¦'
                });
              }
            }
            if (job.status === 'done') {
              await this._waitForPendingMemoryUpserts(job.id, { timeoutMs: 3500 }).catch(() => ({ ok: false }));
              await this._persistJobCache(job).catch(() => {});
            }
            const keepActiveAfterDone = job.status === 'done' && this._shouldKeepJobActiveForCategoryExtensions(job);
            if (keepActiveAfterDone) {
              job.message = 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р… Р Т‘Р В»РЎРЏ Р Р†РЎвЂ№Р В±РЎР‚Р В°Р Р…Р Р…РЎвЂ№РЎвЂ¦ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–. Р СљР С•Р В¶Р Р…Р С• Р Т‘Р С•Р В±Р В°Р Р†Р С‘РЎвЂљРЎРЉ Р ВµРЎвЂ°РЎвЂ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘.';
            }
            await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
            if (job.failedBlockIds.length) {
              this._emitEvent('error', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р… РЎРѓ Р С•РЎв‚¬Р С‘Р В±Р С”Р В°Р СР С‘', {
                tabId: job.tabId,
                jobId: job.id,
                failedBlocksCount: job.failedBlockIds.length,
                blockCount: job.totalBlocks
              });
            }
            break;
          }

          const batch = nextBatch;
          job.currentBatchId = batch.batchId;
          job.message = `Р С’Р С–Р ВµР Р…РЎвЂљ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р С‘РЎвЂљ Р В±Р В°РЎвЂљРЎвЂЎ ${batch.index + 1}`;
          if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
            this.translationAgent.markPhase(job, 'translating', `Р вЂР В°РЎвЂљРЎвЂЎ ${batch.index + 1}`);
          }
          await this._saveJob(job, { setActive: true });

          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_SENT : 'translation.batch.sent', 'Р вЂ”Р В°Р С—РЎР‚Р С•РЎв‚¬Р ВµР Р… Р В±Р В°РЎвЂљРЎвЂЎ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В°', {
            tabId: job.tabId,
            jobId: job.id,
            batchId: batch.batchId,
            blockCount: batch.blocks.length,
            attempt: job.attempts + 1
          });

          try {
            const cachedItems = this._buildCachedItemsForBatch(job, batch);
            const unresolvedBlocks = batch.blocks.filter((block) => !cachedItems.some((item) => item.blockId === block.blockId));
            const agentContext = this.translationAgent && typeof this.translationAgent.buildBatchContext === 'function'
              ? this.translationAgent.buildBatchContext({ job, batch })
              : null;
            let translated = { items: cachedItems.slice(), report: null };
            if (unresolvedBlocks.length) {
              const requestController = this._getJobAbortController(job.id);
              const requestSignal = requestController ? requestController.signal : null;
              const fresh = await this.translationCall.translateBatch(unresolvedBlocks, {
                tabId: job.tabId,
                jobId: job.id,
                batchId: batch.batchId,
                targetLang: job.targetLang || 'ru',
                attempt: (job.attempts || 0) + 1,
                agentContext,
                signal: requestSignal,
                cacheEnabled: Object.prototype.hasOwnProperty.call(job, 'apiCacheEnabled')
                  ? job.apiCacheEnabled !== false
                  : true
              });
              translated = {
                items: cachedItems.concat(fresh.items || []),
                report: fresh.report || null
              };
              this._updateTranslationMemory(job, unresolvedBlocks, fresh.items || []);
            }
            const itemMap = {};
            (translated.items || []).forEach((item) => {
              if (!item || !item.blockId || typeof item.text !== 'string') {
                return;
              }
              itemMap[item.blockId] = item.text;
            });
            translated.items = batch.blockIds.map((blockId) => ({
              blockId,
              text: Object.prototype.hasOwnProperty.call(itemMap, blockId)
                ? itemMap[blockId]
                : ((job.blocksById && job.blocksById[blockId] && typeof job.blocksById[blockId].originalText === 'string')
                  ? job.blocksById[blockId].originalText
                  : '')
            }));

            const protocol = NT.TranslationProtocol || {};
            const compareDiffThreshold = await this._getCompareDiffThreshold({ job });
            const compareRendering = await this._getCompareRendering({ job });
            this._recordRuntimeAction(job, {
              tool: 'pageRuntime',
              status: 'ok',
              message: 'content.apply_batch.sent',
              meta: {
                batchId: batch.batchId,
                items: Array.isArray(translated.items) ? translated.items.length : 0,
                blockCount: Array.isArray(batch.blockIds) ? batch.blockIds.length : 0
              }
            });
            const sent = await this._sendToTab(job.tabId, {
              type: protocol.BG_APPLY_BATCH,
              jobId: job.id,
              batchId: batch.batchId,
              items: translated.items || [],
              compareDiffThreshold,
              compareRendering,
              contentSessionId: job.contentSessionId || null
            });
            if (!sent.ok) {
              throw new Error(sent.error && sent.error.message ? sent.error.message : 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р С•РЎвЂљР С—РЎР‚Р В°Р Р†Р С‘РЎвЂљРЎРЉ Р В±Р В°РЎвЂљРЎвЂЎ Р Р† Р С”Р С•Р Р…РЎвЂљР ВµР Р…РЎвЂљ-РЎР‚Р В°Р Р…РЎвЂљР В°Р в„–Р С');
            }

            const ack = await this._waitForApplyAck(job.id, batch.batchId, this.APPLY_ACK_TIMEOUT_MS);
            if (!ack.ok) {
              throw new Error('Р СњР Вµ Р С—Р С•Р В»РЎС“РЎвЂЎР ВµР Р…Р С• Р С—Р С•Р Т‘РЎвЂљР Р†Р ВµРЎР‚Р В¶Р Т‘Р ВµР Р…Р С‘Р Вµ Р С—РЎР‚Р С‘Р СР ВµР Р…Р ВµР Р…Р С‘РЎРЏ Р С•РЎвЂљ Р С”Р С•Р Р…РЎвЂљР ВµР Р…РЎвЂљ-РЎРѓР С”РЎР‚Р С‘Р С—РЎвЂљР В°');
            }
            this._recordRuntimeAction(job, {
              tool: 'pageRuntime',
              status: 'ok',
              message: 'content.apply_batch.ack',
              meta: {
                batchId: batch.batchId,
                appliedCount: Number.isFinite(Number(ack.appliedCount))
                  ? Number(ack.appliedCount)
                  : 0
              }
            });

            const refreshed = await this.jobStore.getJob(job.id);
            if (!refreshed || refreshed.status !== 'running') {
              break;
            }
            (translated.items || []).forEach((item) => {
              if (!item || !item.blockId || typeof item.text !== 'string') {
                return;
              }
              if (refreshed.blocksById && refreshed.blocksById[item.blockId]) {
                refreshed.blocksById[item.blockId].translatedText = item.text;
              }
            });
            refreshed.attempts = (refreshed.attempts || 0) + 1;
            refreshed.pendingBlockIds = refreshed.pendingBlockIds.filter((id) => !batch.blockIds.includes(id));
            refreshed.completedBlocks = Math.min(
              refreshed.totalBlocks,
              (refreshed.completedBlocks || 0) + (ack.appliedCount || batch.blockIds.length)
            );
            refreshed.currentBatchId = null;
            refreshed.message = 'Р вЂР В°РЎвЂљРЎвЂЎ Р С—РЎР‚Р С‘Р СР ВµР Р…РЎвЂР Р…';
            if (this.translationAgent && refreshed.agentState && typeof this.translationAgent.recordBatchSuccess === 'function') {
              this.translationAgent.recordBatchSuccess({
                job: refreshed,
                batch,
                translatedItems: translated.items || [],
                report: translated.report || null
              });
              refreshed.recentDiffItems = refreshed.agentState && Array.isArray(refreshed.agentState.recentDiffItems)
                ? refreshed.agentState.recentDiffItems.slice(-20)
                : [];
            }
            await this._saveJob(refreshed, { setActive: true });
            this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_APPLIED : 'translation.batch.applied', 'Р вЂР В°РЎвЂљРЎвЂЎ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р С—РЎР‚Р С‘Р СР ВµР Р…РЎвЂР Р…', {
              tabId: refreshed.tabId,
              jobId: refreshed.id,
              batchId: batch.batchId,
              blockCount: batch.blockIds.length
            });
          } catch (error) {
            const refreshed = await this.jobStore.getJob(job.id);
            if (!refreshed) {
              break;
            }
            if (refreshed.status !== 'running') {
              break;
            }
            refreshed.pendingBlockIds = refreshed.pendingBlockIds.filter((id) => !batch.blockIds.includes(id));
            refreshed.failedBlockIds = this._mergeUnique(refreshed.failedBlockIds, batch.blockIds);
            refreshed.currentBatchId = null;
            refreshed.lastError = this._normalizeJobError(error, {
              fallbackCode: 'BATCH_FAILED',
              fallbackMessage: 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В° Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р В±Р В°РЎвЂљРЎвЂЎР В°'
            });
            refreshed.message = `Р С›РЎв‚¬Р С‘Р В±Р С”Р В° Р В±Р В°РЎвЂљРЎвЂЎР В°: ${refreshed.lastError.message}`;
            this._recordRuntimeAction(refreshed, {
              tool: 'pageRuntime',
              status: 'error',
              message: 'content.apply_batch.failed',
              meta: {
                batchId: batch && batch.batchId ? batch.batchId : null,
                error: refreshed.lastError || null
              }
            });
            if (this.translationAgent && refreshed.agentState && typeof this.translationAgent.recordBatchFailure === 'function') {
              this.translationAgent.recordBatchFailure({
                job: refreshed,
                batch,
                error: refreshed.lastError
              });
            }
            await this._saveJob(refreshed, { setActive: true });
          }
        }
      } finally {
        this.processingJobs.delete(jobId);
        const latest = await this.jobStore.getJob(jobId);
        if (!latest || (latest.status !== 'running' && latest.status !== 'preparing' && latest.status !== 'completing')) {
          this._dropJobAbortController(jobId);
        }
      }
    }

    _shouldUseAgentExecution(settings) {
      const mode = settings && settings.translationAgentExecutionMode === 'agent'
        ? 'agent'
        : 'legacy';
      return mode === 'agent';
    }

    async _processJobAgentExecution(job, settings) {
      const AgentToolRegistry = NT.AgentToolRegistry || null;
      const AgentRunner = NT.AgentRunner || null;
      const runLlmRequest = this.translationAgent && typeof this.translationAgent.runLlmRequest === 'function'
        ? this.translationAgent.runLlmRequest
        : null;
      if (!AgentToolRegistry || !AgentRunner || !runLlmRequest) {
        return { continueLoop: false, fallbackLegacy: true };
      }
      this._ensureJobRunSettings(job, { settings });
      const toolRegistry = new AgentToolRegistry({
        translationAgent: this.translationAgent,
        persistJobState: async (nextJob) => {
          if (!nextJob || !nextJob.id) {
            return;
          }
          await this._saveJob(nextJob, { setActive: true });
        },
        runLlmRequest,
        toolManifest: this.toolManifest,
        toolPolicyResolver: this.toolPolicyResolver,
        toolExecutionEngine: NT.ToolExecutionEngine
          ? new NT.ToolExecutionEngine({
            toolManifest: this.toolManifest,
            persistJobState: async (nextJob) => {
              if (!nextJob || !nextJob.id) {
                return;
              }
              await this._saveJob(nextJob, { setActive: true });
            }
          })
          : null,
        capabilities: this._buildRuntimeCapabilities(job.tabId),
        translationMemoryStore: this.translationMemoryStore,
        memorySettings: settings && typeof settings === 'object'
          ? {
            enabled: settings.translationMemoryEnabled !== false,
            maxPages: settings.translationMemoryMaxPages,
            maxBlocks: settings.translationMemoryMaxBlocks,
            maxAgeDays: settings.translationMemoryMaxAgeDays
          }
          : null,
        applyDelta: async ({ job: deltaJob, blockId, text, isFinal }) => this._applyDeltaToTab({
          job: deltaJob || job,
          blockId,
          text,
          isFinal
        }),
        getJobSignal: (jobId) => {
          const controller = this._getJobAbortController(jobId);
          return controller && controller.signal ? controller.signal : null;
        },
        classifyBlocksForJob: async ({ job: targetJob, force }) => this.classifyBlocksForJob({
          job: targetJob || job,
          force: force === true
        }),
        getCategorySummaryForJob: ({ job: targetJob }) => this.getCategorySummaryForJob(targetJob || job),
        setSelectedCategories: async ({ job: targetJob, categories, mode, reason: selectReason }) => this._setSelectedCategories({
          job: targetJob || job,
          categories: Array.isArray(categories) ? categories : [],
          mode: mode === 'add' || mode === 'remove' || mode === 'replace' ? mode : 'replace',
          reason: typeof selectReason === 'string' ? selectReason : ''
        }),
        setAgentCategoryRecommendations: ({ job: targetJob, recommended, optional, excluded, reasonShort, reasonDetailed }) => this._setAgentCategoryRecommendations({
          job: targetJob || job,
          recommended: Array.isArray(recommended) ? recommended : [],
          optional: Array.isArray(optional) ? optional : [],
          excluded: Array.isArray(excluded) ? excluded : [],
          reasonShort,
          reasonDetailed
        })
      });
      const runner = new AgentRunner({
        toolRegistry,
        persistJobState: async (nextJob) => {
          if (!nextJob || !nextJob.id) {
            return;
          }
          await this._saveJob(nextJob, { setActive: true });
        }
      });

      const proofState = this._ensureJobProofreadingState(job);
      const translatePending = Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0;
      const plannedProofPasses = this._resolvePlannedProofreadingPasses(job);
      if (translatePending <= 0 && !proofState.enabled && plannedProofPasses > 0) {
        proofState.enabled = true;
        proofState.mode = 'auto';
        proofState.pass = proofState.pass > 0 ? proofState.pass : 1;
        proofState.pendingBlockIds = [];
        proofState.doneBlockIds = [];
        proofState.failedBlockIds = [];
        proofState.lastPlanTs = null;
        proofState.lastError = null;
        if (job.agentState && typeof job.agentState === 'object') {
          job.agentState.phase = 'proofreading_in_progress';
          job.agentState.status = 'running';
        }
      }
      const runProofreading = translatePending <= 0 && proofState.enabled === true;

      let result = null;
      try {
        result = runProofreading
          ? await runner.runProofreading({
            job,
            blocks: Object.keys(job.blocksById || {}).map((id) => job.blocksById[id]).filter(Boolean),
            settings,
            runLlmRequest
          })
          : await runner.runExecution({
            job,
            blocks: Object.keys(job.blocksById || {}).map((id) => job.blocksById[id]).filter(Boolean),
            settings,
            runLlmRequest
          });
      } catch (error) {
        const normalizedError = (error && typeof error === 'object')
          ? error
          : {
            code: runProofreading ? 'AGENT_PROOFREADING_FAILED' : 'AGENT_EXECUTION_FAILED',
            message: runProofreading ? 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В° Р В°Р С–Р ВµР Р…РЎвЂљ-Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘' : 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В° Р В°Р С–Р ВµР Р…РЎвЂљ-Р С‘РЎРѓР С—Р С•Р В»Р Р…Р ВµР Р…Р С‘РЎРЏ'
          };
        const requeued = await this._requeueJobForBackpressure(job, normalizedError);
        if (requeued) {
          return { continueLoop: false };
        }
        await this._markFailed(job, normalizedError);
        return { continueLoop: false };
      }

      const refreshed = await this.jobStore.getJob(job.id);
      if (!refreshed) {
        return { continueLoop: false };
      }
      if (!result || result.ok === false) {
        const normalizedError = (result && result.error && typeof result.error === 'object')
          ? result.error
          : {
            code: runProofreading ? 'AGENT_PROOFREADING_FAILED' : 'AGENT_EXECUTION_FAILED',
            message: runProofreading
              ? 'Р вЂ™РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р В° Р В°Р С–Р ВµР Р…РЎвЂљР С•Р С Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬Р С‘Р В»Р В°РЎРѓРЎРЉ Р С•РЎв‚¬Р С‘Р В±Р С”Р С•Р в„–'
              : 'Р ВРЎРѓР С—Р С•Р В»Р Р…Р ВµР Р…Р С‘Р Вµ Р В°Р С–Р ВµР Р…РЎвЂљР С•Р С Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬Р С‘Р В»Р С•РЎРѓРЎРЉ Р С•РЎв‚¬Р С‘Р В±Р С”Р С•Р в„–'
          };
        const requeued = await this._requeueJobForBackpressure(refreshed, normalizedError);
        if (requeued) {
          return { continueLoop: false };
        }
        await this._markFailed(refreshed, normalizedError);
        return { continueLoop: false };
      }
      if (refreshed.status !== 'running') {
        return { continueLoop: false };
      }

      const refreshedPending = Array.isArray(refreshed.pendingBlockIds) ? refreshed.pendingBlockIds.length : 0;
      const refreshedProof = this._ensureJobProofreadingState(refreshed);
      const proofPending = Array.isArray(refreshedProof.pendingBlockIds) ? refreshedProof.pendingBlockIds.length : 0;

      if (!runProofreading) {
        if (refreshedPending > 0) {
          refreshed.message = `Р С’Р С–Р ВµР Р…РЎвЂљ Р Р†РЎвЂ№Р С—Р С•Р В»Р Р…РЎРЏР ВµРЎвЂљ Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘; Р С•РЎРѓРЎвЂљР В°Р В»Р С•РЎРѓРЎРЉ Р В±Р В»Р С•Р С”Р С•Р Р†: ${refreshedPending}`;
          if (this.translationAgent && refreshed.agentState && typeof this.translationAgent.markPhase === 'function') {
            this.translationAgent.markPhase(refreshed, 'translating', refreshed.message);
          }
          await this._saveJob(refreshed, { setActive: true });
          if (result && result.yielded) {
            global.setTimeout(() => {
              this._processJob(refreshed.id).catch(() => {});
            }, 0);
            return { continueLoop: false };
          }
          return { continueLoop: true };
        }
        if (refreshedProof.enabled === true) {
          refreshed.message = 'Р СџР ВµРЎР‚Р ВµРЎвЂ¦Р С•Р Т‘ Р С” Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р Вµ';
          if (this.translationAgent && refreshed.agentState && typeof this.translationAgent.markPhase === 'function') {
            this.translationAgent.markPhase(refreshed, 'proofreading', refreshed.message);
          }
          await this._saveJob(refreshed, { setActive: true });
          return { continueLoop: true };
        }
      } else if (proofPending > 0) {
        refreshed.message = `Р С’Р С–Р ВµР Р…РЎвЂљ Р Р†РЎвЂ№Р С—Р С•Р В»Р Р…РЎРЏР ВµРЎвЂљ Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”РЎС“; Р С•РЎРѓРЎвЂљР В°Р В»Р С•РЎРѓРЎРЉ Р В±Р В»Р С•Р С”Р С•Р Р†: ${proofPending}`;
        if (this.translationAgent && refreshed.agentState && typeof this.translationAgent.markPhase === 'function') {
          this.translationAgent.markPhase(refreshed, 'proofreading', refreshed.message);
        }
        await this._saveJob(refreshed, { setActive: true });
        if (result && result.yielded) {
          global.setTimeout(() => {
            this._processJob(refreshed.id).catch(() => {});
          }, 0);
          return { continueLoop: false };
        }
        return { continueLoop: true };
      }

      refreshed.status = refreshed.failedBlockIds.length ? 'failed' : 'done';
      refreshed.message = refreshed.failedBlockIds.length ? 'Р вЂ”Р В°Р Р†Р ВµРЎР‚РЎв‚¬Р ВµР Р…Р С• РЎРѓ Р С•РЎв‚¬Р С‘Р В±Р С”Р В°Р СР С‘ Р Р† Р В±Р В»Р С•Р С”Р В°РЎвЂ¦' : 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р…';
      if (this.translationAgent && refreshed.agentState) {
        if (refreshed.status === 'done' && typeof this.translationAgent.finalizeJob === 'function') {
          this.translationAgent.finalizeJob(refreshed);
        }
        if (refreshed.status === 'failed' && typeof this.translationAgent.markFailed === 'function') {
          this.translationAgent.markFailed(refreshed, {
            code: 'FAILED_BLOCKS_PRESENT',
            message: 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р… РЎРѓ Р С•РЎв‚¬Р С‘Р В±Р С”Р В°Р СР С‘ Р Р† Р В±Р В»Р С•Р С”Р В°РЎвЂ¦'
          });
        }
      }
      if (refreshed.status === 'done') {
        await this._waitForPendingMemoryUpserts(refreshed.id, { timeoutMs: 3500 }).catch(() => ({ ok: false }));
        await this._persistJobCache(refreshed).catch(() => {});
      }
      const keepActiveAfterDone = refreshed.status === 'done' && this._shouldKeepJobActiveForCategoryExtensions(refreshed);
      if (keepActiveAfterDone) {
        refreshed.message = 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р… Р Т‘Р В»РЎРЏ Р Р†РЎвЂ№Р В±РЎР‚Р В°Р Р…Р Р…РЎвЂ№РЎвЂ¦ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–. Р СљР С•Р В¶Р Р…Р С• Р Т‘Р С•Р В±Р В°Р Р†Р С‘РЎвЂљРЎРЉ Р ВµРЎвЂ°РЎвЂ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘.';
      }
      await this._saveJob(refreshed, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
      if (refreshed.failedBlockIds.length) {
        this._emitEvent('error', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р… РЎРѓ Р С•РЎв‚¬Р С‘Р В±Р С”Р В°Р СР С‘', {
          tabId: refreshed.tabId,
          jobId: refreshed.id,
          failedBlocksCount: refreshed.failedBlockIds.length,
          blockCount: refreshed.totalBlocks
        });
      }
      return { continueLoop: false };
    }

    async _applyDeltaToTab({ job, blockId, text, isFinal = false, meta = null } = {}) {
      if (!job || !job.id || !Number.isFinite(Number(job.tabId)) || !blockId || typeof text !== 'string') {
        return { ok: false, applied: false };
      }
      const protocol = NT.TranslationProtocol || {};
      let displayMode = this._normalizeDisplayMode(job.displayMode, true);
      try {
        displayMode = await this._resolveTabDisplayMode(job.tabId);
      } catch (_) {
        displayMode = this._normalizeDisplayMode(job.displayMode, true);
      }
      const compareDiffThreshold = await this._getCompareDiffThreshold({ job });
      const compareRendering = await this._getCompareRendering({ job });
      job.displayMode = displayMode;
      job.compareDiffThreshold = compareDiffThreshold;
      const deltaId = `${job.id}:${blockId}:delta:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const startedAt = Date.now();
      const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
      const targetFrameId = Number.isFinite(Number(block && block.frameId))
        ? Number(block.frameId)
        : 0;
      const localBlockId = block && typeof block.localBlockId === 'string' && block.localBlockId
        ? block.localBlockId
        : (() => {
          const match = /^f\d+:(.+)$/.exec(String(blockId || ''));
          return match ? match[1] : String(blockId || '');
        })();
      const prevText = block && typeof block.translatedText === 'string' && block.translatedText
        ? block.translatedText
        : (block && typeof block.originalText === 'string' ? block.originalText : '');
      this._recordRuntimeAction(job, {
        tool: 'pageRuntime',
        status: 'ok',
        message: 'content.apply_delta.sent',
        meta: {
          blockId,
          isFinal: Boolean(isFinal),
          charCount: text.length
        }
      });
      const sent = await this._sendToTab(job.tabId, {
        type: protocol.BG_APPLY_DELTA,
        jobId: job.id,
        blockId,
        localBlockId,
        frameId: targetFrameId,
        deltaId,
        text,
        isFinal: Boolean(isFinal),
        mode: displayMode,
        compareDiffThreshold,
        compareRendering,
        contentSessionId: job.contentSessionId || null
      });
      if (!sent.ok) {
        this._recordRuntimeAction(job, {
          tool: 'pageRuntime',
          status: 'error',
          message: 'content.apply_delta.failed',
          meta: {
            blockId,
            error: sent && sent.error && sent.error.message ? sent.error.message : 'send_failed'
          }
        });
        return { ok: false, applied: false };
      }
      const ack = await this._waitForApplyDeltaAck(job.id, blockId, deltaId, this.APPLY_DELTA_ACK_TIMEOUT_MS);
      if (!ack.ok) {
        this._recordRuntimeAction(job, {
          tool: 'pageRuntime',
          status: 'error',
          message: 'content.apply_delta.failed',
          meta: {
            blockId,
            error: 'ack_timeout'
          }
        });
        return { ok: false, applied: false };
      }
      this._recordRuntimeAction(job, {
        tool: 'pageRuntime',
        status: 'ok',
        message: 'content.apply_delta.ack',
        meta: {
          blockId,
          applied: ack.applied !== false,
          isFinal: Boolean(isFinal),
          latencyMs: Math.max(0, Date.now() - startedAt),
          nodeCountTouched: Number.isFinite(Number(ack.nodeCountTouched))
            ? Number(ack.nodeCountTouched)
            : 0
        }
      });
      const deltaLatencyMs = Math.max(0, Date.now() - startedAt);
      this._recordPerfJobMetric(job, 'deltaLatencyMs', deltaLatencyMs);
      if (ack.applied !== false) {
        this._recordPerfJobMetric(job, 'applyDeltaCount', 1);
      }
      if (Number.isFinite(Number(ack.rebindAttempts)) && Number(ack.rebindAttempts) > 0) {
        this._recordPerfJobMetric(job, 'rebindAttempts', Number(ack.rebindAttempts));
      }
      if (ack.applied !== false && block) {
        block.translatedText = text;
      }
      if (ack.applied !== false) {
        const ackFrameId = Number.isFinite(Number(ack.frameId)) ? Number(ack.frameId) : null;
        const metricFrameId = Number.isFinite(Number(block && block.frameId))
          ? Number(block.frameId)
          : (ackFrameId !== null ? ackFrameId : 0);
        this._mergeFrameShadowMetricsIntoJob(job, {
          frameId: metricFrameId
        });
        if (job.agentState && job.agentState.frameMetrics && job.agentState.frameMetrics.frames) {
          const frames = job.agentState.frameMetrics.frames;
          frames.applyOk = Number.isFinite(Number(frames.applyOk)) ? Number(frames.applyOk) + 1 : 1;
          if (ack.compare && typeof ack.compare === 'object') {
            const highlights = job.agentState.frameMetrics.highlights && typeof job.agentState.frameMetrics.highlights === 'object'
              ? job.agentState.frameMetrics.highlights
              : { supported: false, mode: 'auto', appliedCount: 0, fallbackCount: 0 };
            if (typeof ack.compare.supported === 'boolean') {
              highlights.supported = ack.compare.supported;
            }
            if (typeof ack.compare.mode === 'string' && ack.compare.mode) {
              highlights.mode = ack.compare.mode;
            }
            if (ack.compare.highlightApplied === true) {
              highlights.appliedCount = Number.isFinite(Number(highlights.appliedCount))
                ? Number(highlights.appliedCount) + 1
                : 1;
            }
            if (ack.compare.fallback === true) {
              highlights.fallbackCount = Number.isFinite(Number(highlights.fallbackCount))
                ? Number(highlights.fallbackCount) + 1
                : 1;
            }
            job.agentState.frameMetrics.highlights = highlights;
          }
        }
      }
      if (ack.applied !== false) {
        this._queuePatchEvent(job, {
          blockId,
          phase: this._resolvePatchPhase(job),
          kind: isFinal ? 'final' : 'delta',
          prev: {
            textHash: ack.prevTextHash || this._hashTextStable(prevText),
            textPreview: this._buildPatchPreview(prevText)
          },
          next: {
            textHash: ack.nextTextHash || this._hashTextStable(text),
            textPreview: this._buildPatchPreview(text)
          },
          meta: {
            modelUsed: block && block.modelUsed ? block.modelUsed : null,
            routeUsed: block && block.routeUsed ? block.routeUsed : null,
            callId: meta && typeof meta.callId === 'string' ? meta.callId : null,
            responseId: meta && typeof meta.responseId === 'string' ? meta.responseId : null,
            latencyMs: deltaLatencyMs,
            nodeCountTouched: Number.isFinite(Number(ack.nodeCountTouched))
              ? Number(ack.nodeCountTouched)
              : 0,
            displayMode: ack && typeof ack.displayMode === 'string' ? ack.displayMode : null
          }
        }, {
          debounceKey: isFinal ? null : `delta:${blockId}`,
          forceFlush: Boolean(isFinal)
        });
        if (isFinal) {
          await this._flushPatchEvents(job.id, { forceSave: true });
        }
      }
      return {
        ok: true,
        applied: ack.applied !== false,
        prevTextHash: ack.prevTextHash || null,
        nextTextHash: ack.nextTextHash || null,
        nodeCountTouched: Number.isFinite(Number(ack.nodeCountTouched))
          ? Number(ack.nodeCountTouched)
          : 0,
        displayMode: ack && typeof ack.displayMode === 'string'
          ? ack.displayMode
          : null
      };
    }

    _buildNextBatch(job) {
      if (this.translationAgent && job && job.agentState && typeof this.translationAgent.buildNextBatch === 'function') {
        const fromAgent = this.translationAgent.buildNextBatch(job);
        if (fromAgent) {
          return fromAgent;
        }
      }
      const pending = Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds : [];
      if (!pending.length) {
        return null;
      }
      const blockIds = pending.slice(0, this.BATCH_SIZE);
      const blocks = blockIds
        .map((blockId) => (job.blocksById && job.blocksById[blockId]) ? job.blocksById[blockId] : null)
        .filter(Boolean);
      if (!blocks.length) {
        return null;
      }
      const index = Math.floor(((job.totalBlocks || 0) - pending.length) / this.BATCH_SIZE);
      return {
        batchId: `${job.id}:batch:${index}`,
        index,
        blockIds,
        blocks
      };
    }

    async _runProofreadingPassIfNeeded(job) {
      if (!job || job.status !== 'running') {
        return false;
      }
      if (Array.isArray(job.pendingBlockIds) && job.pendingBlockIds.length) {
        return false;
      }
      if (Array.isArray(job.failedBlockIds) && job.failedBlockIds.length) {
        return false;
      }

      const totalPasses = this._resolvePlannedProofreadingPasses(job);
      if (totalPasses <= 0) {
        return false;
      }

      const currentState = job.proofreadingState && typeof job.proofreadingState === 'object'
        ? job.proofreadingState
        : {};
      const completedPasses = Number.isFinite(Number(currentState.completedPasses))
        ? Math.max(0, Number(currentState.completedPasses))
        : 0;
      if (completedPasses >= totalPasses) {
        return false;
      }

      const passIndex = completedPasses + 1;
      const blocks = this._collectProofreadBlocks(job);
      if (!blocks.length) {
        job.proofreadingState = {
          totalPasses,
          completedPasses: totalPasses,
          updatedAt: Date.now()
        };
        return false;
      }

      const chunkSize = this._resolveProofreadBatchSize(job);
      const protocol = NT.TranslationProtocol || {};
      const chunks = [];
      for (let offset = 0; offset < blocks.length; offset += chunkSize) {
        const chunkBlocks = blocks.slice(offset, offset + chunkSize);
        const chunkIndex = Math.floor(offset / chunkSize);
        chunks.push({
          batchId: `${job.id}:proofread:${passIndex}:${chunkIndex}`,
          index: chunkIndex,
          blockIds: chunkBlocks.map((item) => item.blockId),
          blocks: chunkBlocks
        });
      }

      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_SENT : 'translation.batch.sent', 'Р вЂ”Р В°Р С—РЎС“РЎвЂ°Р ВµР Р… Р С—РЎР‚Р С•РЎвЂ¦Р С•Р Т‘ Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘', {
        tabId: job.tabId,
        jobId: job.id,
        passIndex,
        totalPasses,
        blockCount: blocks.length
      });
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(job, 'proofreading', `Р СџРЎР‚Р С•РЎвЂ¦Р С•Р Т‘ ${passIndex}/${totalPasses}`);
      }
      job.currentBatchId = `${job.id}:proofread:${passIndex}`;
      job.message = `Р вЂ™РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р В°: Р С—РЎР‚Р С•РЎвЂ¦Р С•Р Т‘ ${passIndex}/${totalPasses}`;
      await this._saveJob(job, { setActive: true });

      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const refreshedBefore = await this.jobStore.getJob(job.id);
        if (!refreshedBefore || refreshedBefore.status !== 'running') {
          return true;
        }
        const requestController = this._getJobAbortController(job.id);
        const requestSignal = requestController ? requestController.signal : null;
        const proofreadInputBlocks = chunk.blocks.map((block) => ({
          blockId: block.blockId,
          originalText: typeof block.translatedText === 'string' && block.translatedText
            ? block.translatedText
            : block.originalText,
          category: block.category || null,
          pathHint: block.pathHint || null
        }));
        const baseContext = this.translationAgent && typeof this.translationAgent.buildBatchContext === 'function'
          ? this.translationAgent.buildBatchContext({ job: refreshedBefore, batch: chunk })
          : null;
        const agentContext = {
          ...(baseContext || {}),
          routeHint: 'strong',
          batchGuidance: 'Proofread and polish existing translated text. Keep meaning, placeholders, code fragments, numbers, and UI constraints unchanged unless incorrect.'
        };

        try {
          const translated = await this.translationCall.translateBatch(proofreadInputBlocks, {
            tabId: refreshedBefore.tabId,
            jobId: refreshedBefore.id,
            batchId: chunk.batchId,
            targetLang: refreshedBefore.targetLang || 'ru',
            attempt: (refreshedBefore.attempts || 0) + 1,
            agentContext,
            signal: requestSignal,
            cacheEnabled: Object.prototype.hasOwnProperty.call(refreshedBefore, 'apiCacheEnabled')
              ? refreshedBefore.apiCacheEnabled !== false
              : true
          });

          const itemMap = {};
          (translated && Array.isArray(translated.items) ? translated.items : []).forEach((item) => {
            if (!item || !item.blockId || typeof item.text !== 'string') {
              return;
            }
            itemMap[item.blockId] = item.text;
          });
          const normalizedItems = chunk.blockIds.map((blockId) => ({
            blockId,
            text: Object.prototype.hasOwnProperty.call(itemMap, blockId)
              ? itemMap[blockId]
              : ((refreshedBefore.blocksById && refreshedBefore.blocksById[blockId] && typeof refreshedBefore.blocksById[blockId].translatedText === 'string')
                ? refreshedBefore.blocksById[blockId].translatedText
                : (refreshedBefore.blocksById && refreshedBefore.blocksById[blockId] && typeof refreshedBefore.blocksById[blockId].originalText === 'string'
                  ? refreshedBefore.blocksById[blockId].originalText
                  : ''))
          }));

          this._recordRuntimeAction(refreshedBefore, {
            tool: 'pageRuntime',
            status: 'ok',
            message: 'content.apply_batch.sent',
            meta: {
              batchId: chunk.batchId,
              items: normalizedItems.length,
              blockCount: chunk.blockIds.length,
              phase: 'proofreading'
            }
          });
          const compareDiffThreshold = await this._getCompareDiffThreshold({ job: refreshedBefore });
          const compareRendering = await this._getCompareRendering({ job: refreshedBefore });
          const sent = await this._sendToTab(refreshedBefore.tabId, {
            type: protocol.BG_APPLY_BATCH,
            jobId: refreshedBefore.id,
            batchId: chunk.batchId,
            items: normalizedItems,
            compareDiffThreshold,
            compareRendering,
            contentSessionId: refreshedBefore.contentSessionId || null
          });
          if (!sent.ok) {
            throw new Error(sent.error && sent.error.message ? sent.error.message : 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р С•РЎвЂљР С—РЎР‚Р В°Р Р†Р С‘РЎвЂљРЎРЉ Р В±Р В°РЎвЂљРЎвЂЎ Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘ Р Р† Р С”Р С•Р Р…РЎвЂљР ВµР Р…РЎвЂљ-РЎР‚Р В°Р Р…РЎвЂљР В°Р в„–Р С');
          }

          const ack = await this._waitForApplyAck(refreshedBefore.id, chunk.batchId, this.APPLY_ACK_TIMEOUT_MS);
          if (!ack.ok) {
            throw new Error('Р СњР Вµ Р С—Р С•Р В»РЎС“РЎвЂЎР ВµР Р…Р С• Р С—Р С•Р Т‘РЎвЂљР Р†Р ВµРЎР‚Р В¶Р Т‘Р ВµР Р…Р С‘Р Вµ Р С—РЎР‚Р С‘Р СР ВµР Р…Р ВµР Р…Р С‘РЎРЏ Р Т‘Р В»РЎРЏ Р В±Р В°РЎвЂљРЎвЂЎР В° Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘');
          }
          this._recordRuntimeAction(refreshedBefore, {
            tool: 'pageRuntime',
            status: 'ok',
            message: 'content.apply_batch.ack',
            meta: {
              batchId: chunk.batchId,
              appliedCount: Number.isFinite(Number(ack.appliedCount))
                ? Number(ack.appliedCount)
                : 0,
              phase: 'proofreading'
            }
          });

          const refreshed = await this.jobStore.getJob(job.id);
          if (!refreshed || refreshed.status !== 'running') {
            return true;
          }
          normalizedItems.forEach((item) => {
            if (!item || !item.blockId || typeof item.text !== 'string') {
              return;
            }
            if (refreshed.blocksById && refreshed.blocksById[item.blockId]) {
              refreshed.blocksById[item.blockId].translatedText = item.text;
            }
          });
          refreshed.attempts = (refreshed.attempts || 0) + 1;
          refreshed.currentBatchId = null;
          refreshed.message = `Р вЂ™РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р В°: Р С—РЎР‚Р С•РЎвЂ¦Р С•Р Т‘ ${passIndex}/${totalPasses}, Р В±Р В°РЎвЂљРЎвЂЎ ${i + 1}/${chunks.length}`;
          if (this.translationAgent && refreshed.agentState && typeof this.translationAgent.recordBatchSuccess === 'function') {
            this.translationAgent.recordBatchSuccess({
              job: refreshed,
              batch: chunk,
              translatedItems: normalizedItems,
              report: translated && translated.report ? translated.report : {
                summary: `Proofread pass ${passIndex} chunk ${i + 1}/${chunks.length}`,
                quality: 'ok',
                notes: []
              }
            });
            refreshed.recentDiffItems = refreshed.agentState && Array.isArray(refreshed.agentState.recentDiffItems)
              ? refreshed.agentState.recentDiffItems.slice(-20)
              : [];
          }
          await this._saveJob(refreshed, { setActive: true });
        } catch (error) {
          const refreshed = await this.jobStore.getJob(job.id);
          if (!refreshed || refreshed.status !== 'running') {
            return true;
          }
          refreshed.lastError = this._normalizeJobError(error, {
            fallbackCode: 'PROOFREAD_BATCH_FAILED',
            fallbackMessage: 'Р С›РЎв‚¬Р С‘Р В±Р С”Р В° Р В±Р В°РЎвЂљРЎвЂЎР В° Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘'
          });
          refreshed.message = `Р СџРЎР‚Р ВµР Т‘РЎС“Р С—РЎР‚Р ВµР В¶Р Т‘Р ВµР Р…Р С‘Р Вµ Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘: ${refreshed.lastError.message}`;
          this._recordRuntimeAction(refreshed, {
            tool: 'pageRuntime',
            status: 'error',
            message: 'content.apply_batch.failed',
            meta: {
              batchId: chunk.batchId,
              error: refreshed.lastError || null,
              phase: 'proofreading'
            }
          });
          refreshed.proofreadingState = {
            totalPasses,
            completedPasses: passIndex - 1,
            updatedAt: Date.now()
          };
          await this._saveJob(refreshed, { setActive: true });
          this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Р СџРЎР‚Р С•РЎвЂ¦Р С•Р Т‘ Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬Р С‘Р В»РЎРѓРЎРЏ Р С•РЎв‚¬Р С‘Р В±Р С”Р С•Р в„–, Р С—РЎР‚Р С•Р Т‘Р С•Р В»Р В¶Р В°РЎР‹ РЎРѓ РЎвЂљР ВµР С”РЎС“РЎвЂ°Р С‘Р С Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р С•Р С', {
            tabId: refreshed.tabId,
            jobId: refreshed.id,
            passIndex,
            message: refreshed.lastError.message
          });
          return false;
        }
      }

      const afterPass = await this.jobStore.getJob(job.id);
      if (!afterPass || afterPass.status !== 'running') {
        return true;
      }
      afterPass.proofreadingState = {
        totalPasses,
        completedPasses: passIndex,
        updatedAt: Date.now()
      };
      afterPass.currentBatchId = null;
      afterPass.message = `Р вЂ™РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р В°: Р С—РЎР‚Р С•РЎвЂ¦Р С•Р Т‘ ${passIndex}/${totalPasses} Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р…`;
      await this._saveJob(afterPass, { setActive: true });
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_APPLIED : 'translation.batch.applied', 'Р СџРЎР‚Р С•РЎвЂ¦Р С•Р Т‘ Р Р†РЎвЂ№РЎвЂЎР С‘РЎвЂљР С”Р С‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬РЎвЂР Р…', {
        tabId: afterPass.tabId,
        jobId: afterPass.id,
        passIndex,
        totalPasses
      });
      return true;
    }

    _collectProofreadBlocks(job) {
      if (!job || !job.blocksById || typeof job.blocksById !== 'object') {
        return [];
      }
      const pendingSet = new Set(Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds : []);
      return Object.keys(job.blocksById)
        .map((id) => job.blocksById[id])
        .filter((block) => {
          if (!block || !block.blockId || pendingSet.has(block.blockId)) {
            return false;
          }
          return typeof block.translatedText === 'string' && block.translatedText.trim().length > 0;
        });
    }

    _resolvePlannedProofreadingPasses(job) {
      const plan = job && job.agentState && job.agentState.plan && typeof job.agentState.plan === 'object'
        ? job.agentState.plan
        : null;
      const passes = plan && Number.isFinite(Number(plan.proofreadingPasses))
        ? Number(plan.proofreadingPasses)
        : 0;
      return Math.max(0, passes);
    }

    _resolveProofreadBatchSize(job) {
      const plan = job && job.agentState && job.agentState.plan && typeof job.agentState.plan === 'object'
        ? job.agentState.plan
        : null;
      const planned = plan && Number.isFinite(Number(plan.batchSize))
        ? Number(plan.batchSize)
        : this.BATCH_SIZE;
      return Math.max(1, Math.round(planned || this.BATCH_SIZE));
    }

    _ackKey(jobId, batchId, sessionId) {
      return `${jobId}:${batchId}:${sessionId || 'none'}`;
    }

    _deltaAckKey(jobId, blockId, deltaId, sessionId) {
      return `${jobId}:${blockId}:delta:${deltaId || 'none'}:${sessionId || 'none'}`;
    }

    async _waitForApplyAck(jobId, batchId, timeoutMs) {
      let sessionId = null;
      try {
        const job = await this.jobStore.getJob(jobId);
        sessionId = job && typeof job.contentSessionId === 'string' && job.contentSessionId
          ? job.contentSessionId
          : null;
      } catch (_) {
        sessionId = null;
      }
      const key = this._ackKey(jobId, batchId, sessionId);
      const legacyKey = this._ackKey(jobId, batchId, null);
      return new Promise((resolve) => {
        const keys = key === legacyKey ? [key] : [key, legacyKey];
        let waiter = null;
        const cleanup = () => {
          keys.forEach((entryKey) => {
            if (this.pendingApplyAcks.get(entryKey) === waiter) {
              this.pendingApplyAcks.delete(entryKey);
            }
          });
        };
        const timer = global.setTimeout(() => {
          cleanup();
          resolve({ ok: false, timeout: true });
        }, timeoutMs);
        waiter = {
          resolve: (value) => {
            global.clearTimeout(timer);
            cleanup();
            resolve(value || { ok: true });
          }
        };
        keys.forEach((entryKey) => {
          this.pendingApplyAcks.set(entryKey, waiter);
        });
      });
    }

    async _waitForApplyDeltaAck(jobId, blockId, deltaId, timeoutMs) {
      let sessionId = null;
      try {
        const job = await this.jobStore.getJob(jobId);
        sessionId = job && typeof job.contentSessionId === 'string' && job.contentSessionId
          ? job.contentSessionId
          : null;
      } catch (_) {
        sessionId = null;
      }
      const key = this._deltaAckKey(jobId, blockId, deltaId || null, sessionId);
      const legacyKey = this._deltaAckKey(jobId, blockId, deltaId || null, null);
      const noDeltaKey = this._deltaAckKey(jobId, blockId, null, sessionId);
      const noDeltaLegacyKey = this._deltaAckKey(jobId, blockId, null, null);
      return new Promise((resolve) => {
        const keys = [];
        const pushKey = (entryKey) => {
          if (entryKey && !keys.includes(entryKey)) {
            keys.push(entryKey);
          }
        };
        pushKey(key);
        pushKey(legacyKey);
        pushKey(noDeltaKey);
        pushKey(noDeltaLegacyKey);
        let waiter = null;
        const cleanup = () => {
          keys.forEach((entryKey) => {
            if (this.pendingDeltaAcks.get(entryKey) === waiter) {
              this.pendingDeltaAcks.delete(entryKey);
            }
          });
        };
        const timer = global.setTimeout(() => {
          cleanup();
          resolve({ ok: false, timeout: true });
        }, timeoutMs);
        waiter = {
          resolve: (value) => {
            global.clearTimeout(timer);
            cleanup();
            resolve(value || { ok: true });
          }
        };
        keys.forEach((entryKey) => {
          this.pendingDeltaAcks.set(entryKey, waiter);
        });
      });
    }

    async _runWithJobSaveLock(jobId, fn) {
      const key = String(jobId || '');
      if (!key || typeof fn !== 'function') {
        return null;
      }
      const current = this.jobSaveLocks.get(key) || Promise.resolve();
      let result;
      const next = current
        .catch(() => null)
        .then(async () => {
          result = await fn();
          return result;
        });
      this.jobSaveLocks.set(key, next);
      try {
        await next;
        return result;
      } finally {
        if (this.jobSaveLocks.get(key) === next) {
          this.jobSaveLocks.delete(key);
        }
      }
    }

    async _saveJob(job, { setActive = false, clearActive = false } = {}) {
      if (!job || !job.id) {
        return;
      }
      return this._runWithJobSaveLock(job.id, async () => {
        let prev = null;
        try {
          prev = await this.jobStore.getJob(job.id);
        } catch (_) {
          prev = null;
        }
        const allowResumeFromDone = Boolean(
          prev
          && prev.status === 'done'
          && job.status === 'running'
          && Array.isArray(job.pendingBlockIds)
          && job.pendingBlockIds.length > 0
        );
        if (prev && this._isTerminalStatus(prev.status) && !this._isTerminalStatus(job.status) && !allowResumeFromDone) {
          job.status = prev.status;
          job.message = prev.message || job.message;
          job.lastError = prev.lastError || job.lastError;
          job.currentBatchId = null;
          const prevCompleted = Number.isFinite(Number(prev.completedBlocks)) ? Number(prev.completedBlocks) : 0;
          const nextCompleted = Number.isFinite(Number(job.completedBlocks)) ? Number(job.completedBlocks) : 0;
          const prevTotal = Number.isFinite(Number(prev.totalBlocks)) ? Number(prev.totalBlocks) : 0;
          const nextTotal = Number.isFinite(Number(job.totalBlocks)) ? Number(job.totalBlocks) : 0;
          job.completedBlocks = Math.max(prevCompleted, nextCompleted);
          job.totalBlocks = Math.max(prevTotal, nextTotal);
        }
        if (!job.displayMode && prev && prev.displayMode) {
          job.displayMode = prev.displayMode;
        }
        let tabDisplayMode = null;
        if (Number.isFinite(Number(job.tabId))) {
          try {
            tabDisplayMode = await this._resolveTabDisplayMode(Number(job.tabId));
          } catch (_) {
            tabDisplayMode = null;
          }
        }
        if (tabDisplayMode === 'original' || tabDisplayMode === 'translated' || tabDisplayMode === 'compare') {
          job.displayMode = tabDisplayMode;
        }
        if ((!job.runSettings || typeof job.runSettings !== 'object') && prev && prev.runSettings && typeof prev.runSettings === 'object') {
          job.runSettings = prev.runSettings;
        }
        this._ensureJobRunSettings(job, { settings: null });
        this._ensureJobProofreadingState(job);
        job.displayMode = this._normalizeDisplayMode(job.displayMode, true);
        if (
          (!Number.isFinite(Number(job.compareDiffThreshold)) || Number(job.compareDiffThreshold) <= 0)
          && prev
          && Number.isFinite(Number(prev.compareDiffThreshold))
        ) {
          job.compareDiffThreshold = prev.compareDiffThreshold;
        }
        job.compareDiffThreshold = this._normalizeCompareDiffThreshold(job.compareDiffThreshold);
        if ((!job.compareRendering || typeof job.compareRendering !== 'string') && prev && typeof prev.compareRendering === 'string') {
          job.compareRendering = prev.compareRendering;
        }
        job.compareRendering = this._normalizeCompareRendering(job.compareRendering);
        if (this._isTerminalStatus(job.status)) {
          setActive = false;
          clearActive = true;
        }
        const now = Date.now();
        this._ensureJobRuntime(job, { prev, now });
        const leaseMs = this._leaseMsForStatus(job.status);
        job.updatedAt = now;
        const runtimeLease = job.runtime
          && job.runtime.lease
          && Number.isFinite(Number(job.runtime.lease.leaseUntilTs))
          ? Number(job.runtime.lease.leaseUntilTs)
          : null;
        const runtimeStatus = job.runtime && typeof job.runtime.status === 'string'
          ? String(job.runtime.status).toUpperCase()
          : null;
        const hasBackoff = Boolean(
          job.runtime
          && job.runtime.retry
          && Number.isFinite(Number(job.runtime.retry.nextRetryAtTs))
          && Number(job.runtime.retry.nextRetryAtTs) > now
        );
        if (runtimeStatus === 'IDLE' || (runtimeStatus === 'QUEUED' && hasBackoff)) {
          job.leaseUntilTs = null;
          if (job.runtime && job.runtime.lease) {
            job.runtime.lease.leaseUntilTs = null;
          }
        } else if (runtimeLease !== null && runtimeLease > now) {
          job.leaseUntilTs = runtimeLease;
        } else {
          job.leaseUntilTs = leaseMs ? now + leaseMs : null;
          if (job.runtime && job.runtime.lease) {
            job.runtime.lease.leaseUntilTs = job.leaseUntilTs;
          }
        }
        this._updateJobPerfSnapshot(job);
        await this.jobStore.upsertJob(job);
        if (setActive) {
          await this.jobStore.setActiveJob(job.tabId, job.id);
        }
        if (clearActive) {
          await this.jobStore.clearActiveJob(job.tabId, job.id);
        }
        await this._syncTabStatus(job);
        this._emitUiPatch(job);
      });
    }

    _runtimeStatusFromJobStatus(status) {
      const value = String(status || '').toLowerCase();
      if (value === 'done') return 'DONE';
      if (value === 'failed') return 'FAILED';
      if (value === 'cancelled') return 'CANCELLED';
      if (value === 'awaiting_categories') return 'IDLE';
      if (value === 'preparing') return 'QUEUED';
      if (value === 'planning' || value === 'running' || value === 'completing') return 'RUNNING';
      return 'IDLE';
    }

    _runtimeStageFromJob(job) {
      const status = String(job && job.status ? job.status : '').toLowerCase();
      if (status === 'preparing') {
        return 'scanning';
      }
      if (status === 'planning') {
        return 'planning';
      }
      if (status === 'awaiting_categories') {
        return 'awaiting_categories';
      }
      const proof = job && job.proofreading && typeof job.proofreading === 'object'
        ? job.proofreading
        : null;
      if (proof && (proof.enabled === true || (Array.isArray(proof.pendingBlockIds) && proof.pendingBlockIds.length))) {
        return 'proofreading';
      }
      const phase = job && job.agentState && typeof job.agentState.phase === 'string'
        ? String(job.agentState.phase).toLowerCase()
        : '';
      if (phase.includes('proofread')) {
        return 'proofreading';
      }
      if (phase.includes('planning') || phase.includes('awaiting_categories') || phase.includes('planned')) {
        return 'planning';
      }
      return 'execution';
    }

    _ensureJobRuntime(job, { prev = null, now = Date.now() } = {}) {
      if (!job || typeof job !== 'object') {
        return null;
      }
      const prevRuntime = prev && prev.runtime && typeof prev.runtime === 'object'
        ? prev.runtime
        : {};
      const src = job.runtime && typeof job.runtime === 'object'
        ? job.runtime
        : {};
      const lease = src.lease && typeof src.lease === 'object' ? src.lease : {};
      const retry = src.retry && typeof src.retry === 'object' ? src.retry : {};
      const watchdog = src.watchdog && typeof src.watchdog === 'object' ? src.watchdog : {};
      const hasLeaseUntil = Object.prototype.hasOwnProperty.call(lease, 'leaseUntilTs');
      const hasHeartbeat = Object.prototype.hasOwnProperty.call(lease, 'heartbeatTs');
      job.runtime = {
        ownerInstanceId: src.ownerInstanceId
          || prevRuntime.ownerInstanceId
          || null,
        status: src.status || this._runtimeStatusFromJobStatus(job.status),
        stage: src.stage || this._runtimeStageFromJob(job),
        lease: {
          leaseUntilTs: hasLeaseUntil
            ? (Number.isFinite(Number(lease.leaseUntilTs)) ? Number(lease.leaseUntilTs) : null)
            : (Number.isFinite(Number(job.leaseUntilTs)) ? Number(job.leaseUntilTs) : null),
          heartbeatTs: hasHeartbeat
            ? (Number.isFinite(Number(lease.heartbeatTs)) ? Number(lease.heartbeatTs) : now)
            : now,
          op: typeof lease.op === 'string' ? lease.op : null,
          opId: lease.opId || null
        },
        retry: {
          attempt: Math.max(0, Number(retry.attempt) || 0),
          maxAttempts: Math.max(1, Number(retry.maxAttempts) || 4),
          nextRetryAtTs: Number.isFinite(Number(retry.nextRetryAtTs))
            ? Number(retry.nextRetryAtTs)
            : 0,
          firstAttemptTs: Number.isFinite(Number(retry.firstAttemptTs))
            ? Number(retry.firstAttemptTs)
            : null,
          lastError: retry.lastError && typeof retry.lastError === 'object'
            ? { ...retry.lastError }
            : null
        },
        watchdog: {
          lastProgressTs: Number.isFinite(Number(watchdog.lastProgressTs))
            ? Number(watchdog.lastProgressTs)
            : now,
          lastProgressKey: typeof watchdog.lastProgressKey === 'string'
            ? watchdog.lastProgressKey
            : ''
        }
      };
      if (this._isTerminalStatus(job.status)) {
        job.runtime.status = this._runtimeStatusFromJobStatus(job.status);
        job.runtime.lease.leaseUntilTs = null;
      }
      return job.runtime;
    }

    _isTerminalStatus(status) {
      return status === 'cancelled' || status === 'failed' || status === 'done';
    }

    _leaseMsForStatus(status) {
      if (status === 'preparing' || status === 'planning' || status === 'running' || status === 'completing') {
        return 10 * 60 * 1000;
      }
      if (status === 'awaiting_categories') {
        return 24 * 60 * 60 * 1000;
      }
      return null;
    }

    async _syncTabStatus(job) {
      if (!this.tabStateStore || !job || job.tabId === null || job.tabId === undefined) {
        return;
      }
      const total = Number.isFinite(Number(job.totalBlocks)) ? Number(job.totalBlocks) : 0;
      const completed = Number.isFinite(Number(job.completedBlocks)) ? Number(job.completedBlocks) : 0;
      const failed = Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0;
      const isTerminal = this._isTerminalStatus(job.status);
      const inProgress = isTerminal ? 0 : Math.max(0, total - completed - failed);
      const lastErrorMessage = job.lastError
        && typeof job.lastError === 'object'
        && typeof job.lastError.message === 'string'
        && job.lastError.message.trim()
        ? job.lastError.message.trim()
        : '';
      const statusMessage = lastErrorMessage || job.message || job.status;
      const progress = total > 0
        ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
        : (job.status === 'done' ? 100 : 0);
      const agentState = this.translationAgent && typeof this.translationAgent.toUiSnapshot === 'function'
        ? this.translationAgent.toUiSnapshot(job.agentState || null)
        : (job.agentState || null);
      const displayMode = await this._resolveTabDisplayMode(job.tabId);
      const compareDiffThreshold = this._normalizeCompareDiffThreshold(job.compareDiffThreshold);
      const compareRendering = this._normalizeCompareRendering(job.compareRendering);
      const patchHistoryCount = job && job.agentState && Array.isArray(job.agentState.patchHistory)
        ? job.agentState.patchHistory.length
        : 0;
      const runtime = this._ensureJobRuntime(job, { now: Date.now() });

      await this.tabStateStore.upsertStatusPatch(job.tabId, {
        status: job.status,
        progress,
        total,
        completed,
        inProgress,
        message: statusMessage,
        failedBlocksCount: failed,
        translationJobId: job.id,
        lastError: job.lastError || null,
        selectedCategories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
        availableCategories: Array.isArray(job.availableCategories) ? job.availableCategories.slice(0, 24) : [],
        pageSignature: job.pageSignature || null,
        agentState,
        recentDiffItems: Array.isArray(job.recentDiffItems) ? job.recentDiffItems.slice(-20) : [],
        displayMode,
        compareDiffThreshold,
        compareRendering,
        patchHistoryCount,
        runtime: runtime && typeof runtime === 'object'
          ? {
            status: runtime.status || null,
            stage: runtime.stage || null,
            leaseUntilTs: runtime.lease && Number.isFinite(Number(runtime.lease.leaseUntilTs))
              ? Number(runtime.lease.leaseUntilTs)
              : null,
            heartbeatTs: runtime.lease && Number.isFinite(Number(runtime.lease.heartbeatTs))
              ? Number(runtime.lease.heartbeatTs)
              : null,
            attempt: runtime.retry && Number.isFinite(Number(runtime.retry.attempt))
              ? Number(runtime.retry.attempt)
              : 0,
            nextRetryAtTs: runtime.retry && Number.isFinite(Number(runtime.retry.nextRetryAtTs))
              ? Number(runtime.retry.nextRetryAtTs)
              : 0,
            lastErrorCode: runtime.retry && runtime.retry.lastError && runtime.retry.lastError.code
              ? runtime.retry.lastError.code
              : null
          }
          : null,
        updatedAt: job.updatedAt
      });
    }

    _emitUiPatch(job) {
      if (!this.onUiPatch || !job) {
        return;
      }
      const failedBlocksCount = Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0;
      const total = Number.isFinite(Number(job.totalBlocks)) ? Number(job.totalBlocks) : 0;
      const completed = Number.isFinite(Number(job.completedBlocks)) ? Number(job.completedBlocks) : 0;
      const translationProgress = total > 0
        ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
        : (job.status === 'done' ? 100 : 0);
      const agentState = this.translationAgent && typeof this.translationAgent.toUiSnapshot === 'function'
        ? this.translationAgent.toUiSnapshot(job.agentState || null)
        : (job.agentState || null);
      const displayMode = this._normalizeDisplayMode(job.displayMode, true);
      const compareDiffThreshold = this._normalizeCompareDiffThreshold(job.compareDiffThreshold);
      const compareRendering = this._normalizeCompareRendering(job.compareRendering);
      const runtime = this._ensureJobRuntime(job, { now: Date.now() });

      this.onUiPatch({
        translationJob: this._toJobSummary(job),
        translationProgress,
        failedBlocksCount,
        lastError: job.lastError || null,
        agentState,
        selectedCategories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
        availableCategories: Array.isArray(job.availableCategories) ? job.availableCategories.slice(0, 24) : [],
        recentDiffItems: Array.isArray(job.recentDiffItems) ? job.recentDiffItems.slice(-20) : [],
        translationCompareDiffThreshold: compareDiffThreshold,
        translationCompareRendering: compareRendering,
        translationDisplayModeByTab: { [job.tabId]: displayMode },
        translationVisibilityByTab: { [job.tabId]: displayMode !== 'original' },
        runtime: runtime && typeof runtime === 'object'
          ? {
            status: runtime.status || null,
            stage: runtime.stage || null,
            leaseUntilTs: runtime.lease && Number.isFinite(Number(runtime.lease.leaseUntilTs))
              ? Number(runtime.lease.leaseUntilTs)
              : null,
            heartbeatTs: runtime.lease && Number.isFinite(Number(runtime.lease.heartbeatTs))
              ? Number(runtime.lease.heartbeatTs)
              : null,
            attempt: runtime.retry && Number.isFinite(Number(runtime.retry.attempt))
              ? Number(runtime.retry.attempt)
              : 0,
            nextRetryAtTs: runtime.retry && Number.isFinite(Number(runtime.retry.nextRetryAtTs))
              ? Number(runtime.retry.nextRetryAtTs)
              : 0,
            lastErrorCode: runtime.retry && runtime.retry.lastError && runtime.retry.lastError.code
              ? runtime.retry.lastError.code
              : null
          }
          : null
      });
    }

    _normalizeDisplayMode(mode, visibleFallback = true) {
      if (mode === 'original' || mode === 'compare' || mode === 'translated') {
        return mode;
      }
      return visibleFallback === false ? 'original' : 'translated';
    }

    _normalizeCompareDiffThreshold(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return this.COMPARE_DIFF_THRESHOLD_DEFAULT;
      }
      return Math.max(500, Math.min(50000, Math.round(numeric)));
    }

    _normalizeCompareRendering(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'highlights' || raw === 'wrappers' || raw === 'auto') {
        return raw;
      }
      return 'auto';
    }

    async _getCompareDiffThreshold({ job = null } = {}) {
      if (job && Number.isFinite(Number(job.compareDiffThreshold))) {
        return this._normalizeCompareDiffThreshold(job.compareDiffThreshold);
      }
      if (this.settingsStore && typeof this.settingsStore.get === 'function') {
        try {
          const state = await this.settingsStore.get(['translationCompareDiffThreshold']);
          return this._normalizeCompareDiffThreshold(state.translationCompareDiffThreshold);
        } catch (_) {
          // fall back below
        }
      }
      return this.COMPARE_DIFF_THRESHOLD_DEFAULT;
    }

    async _getCompareRendering({ job = null } = {}) {
      if (job && typeof job.compareRendering === 'string') {
        return this._normalizeCompareRendering(job.compareRendering);
      }
      if (this.settingsStore && typeof this.settingsStore.getResolvedSettings === 'function') {
        try {
          const resolved = await this.settingsStore.getResolvedSettings();
          const effective = resolved && resolved.effectiveSettings && typeof resolved.effectiveSettings === 'object'
            ? resolved.effectiveSettings
            : null;
          const ui = effective && effective.ui && typeof effective.ui === 'object'
            ? effective.ui
            : null;
          if (ui && typeof ui.compareRendering === 'string') {
            return this._normalizeCompareRendering(ui.compareRendering);
          }
        } catch (_) {
          // fallback below
        }
      }
      if (this.settingsStore && typeof this.settingsStore.get === 'function') {
        try {
          const state = await this.settingsStore.get(['translationCompareRendering']);
          if (state && typeof state.translationCompareRendering === 'string') {
            return this._normalizeCompareRendering(state.translationCompareRendering);
          }
        } catch (_) {
          // fallback below
        }
      }
      return 'auto';
    }

    _resolvePatchPhase(job, batchPrefix = '') {
      const prefix = String(batchPrefix || '').toLowerCase();
      if (prefix.includes('proofread')) {
        return 'proofreading';
      }
      if (prefix.includes('restore') || prefix.includes('cache') || prefix.includes('memory')) {
        return 'restore';
      }
      const phase = job && job.agentState && typeof job.agentState.phase === 'string'
        ? String(job.agentState.phase).toLowerCase()
        : '';
      const proof = job && job.proofreading && typeof job.proofreading === 'object'
        ? job.proofreading
        : null;
      if (proof && (proof.enabled === true || (Array.isArray(proof.pendingBlockIds) && proof.pendingBlockIds.length))) {
        return 'proofreading';
      }
      if (phase.includes('proofread')) {
        return 'proofreading';
      }
      if (phase.includes('planning') || phase.includes('awaiting_categories') || phase.includes('planned')) {
        return 'planning';
      }
      if (phase.includes('restore') || phase.includes('cache')) {
        return 'restore';
      }
      return 'execution';
    }

    _resolvePatchKindForBatchPrefix(batchPrefix) {
      const prefix = String(batchPrefix || '').toLowerCase();
      if (prefix.includes('restore') || prefix.includes('cache') || prefix.includes('memory')) {
        return 'restore';
      }
      return 'final';
    }

    _buildPatchPreview(text) {
      const src = String(text || '').replace(/\s+/g, ' ').trim();
      const edge = Math.max(40, Number(this.PATCH_PREVIEW_CHARS || 160));
      if (!src) {
        return '(len=0)';
      }
      if (src.length <= (edge * 2) + 10) {
        return `${src} (len=${src.length})`;
      }
      return `${src.slice(0, edge)} ... ${src.slice(-edge)} (len=${src.length})`;
    }

    _queuePatchEvent(job, rawEvent, { debounceKey = null, forceFlush = false } = {}) {
      if (!job || !job.id || !rawEvent || typeof rawEvent !== 'object') {
        return;
      }
      const jobId = job.id;
      const bucket = this.pendingPatchFlushByJob.get(jobId) || {
        events: [],
        debounced: new Map(),
        timerId: null
      };
      const event = {
        ts: Number.isFinite(Number(rawEvent.ts)) ? Number(rawEvent.ts) : Date.now(),
        jobId: job.id,
        tabId: Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : null,
        blockId: rawEvent.blockId ? String(rawEvent.blockId) : 'unknown',
        phase: rawEvent.phase || this._resolvePatchPhase(job),
        kind: rawEvent.kind || 'delta',
        prev: rawEvent.prev && typeof rawEvent.prev === 'object' ? rawEvent.prev : { textHash: null, textPreview: '' },
        next: rawEvent.next && typeof rawEvent.next === 'object' ? rawEvent.next : { textHash: null, textPreview: '' },
        meta: rawEvent.meta && typeof rawEvent.meta === 'object' ? rawEvent.meta : {}
      };
      if (debounceKey) {
        if (bucket.debounced.has(debounceKey)) {
          bucket.debounced.delete(debounceKey);
        }
        bucket.debounced.set(debounceKey, event);
      } else {
        bucket.events.push(event);
      }

      this.pendingPatchFlushByJob.set(jobId, bucket);
      if (forceFlush) {
        if (bucket.timerId) {
          global.clearTimeout(bucket.timerId);
          bucket.timerId = null;
        }
        this._flushPatchEvents(jobId, { forceSave: true }).catch(() => {});
        return;
      }

      if (!bucket.timerId) {
        bucket.timerId = global.setTimeout(() => {
          this._flushPatchEvents(jobId, { forceSave: false }).catch(() => {});
        }, Math.max(80, Number(this.PATCH_DELTA_DEBOUNCE_MS || 320)));
      }
    }

    async _flushPatchEvents(jobId, { forceSave = false } = {}) {
      if (!jobId) {
        return { ok: false, flushed: 0 };
      }
      const bucket = this.pendingPatchFlushByJob.get(jobId);
      if (!bucket) {
        return { ok: true, flushed: 0 };
      }
      if (bucket.timerId) {
        global.clearTimeout(bucket.timerId);
        bucket.timerId = null;
      }
      this.pendingPatchFlushByJob.delete(jobId);
      const mergedEvents = []
        .concat(Array.isArray(bucket.events) ? bucket.events : [])
        .concat(Array.from(bucket.debounced instanceof Map ? bucket.debounced.values() : []));
      if (!mergedEvents.length && !forceSave) {
        return { ok: true, flushed: 0 };
      }

      let job = null;
      try {
        job = await this.jobStore.getJob(jobId);
      } catch (_) {
        job = null;
      }
      if (!job) {
        return { ok: false, flushed: 0 };
      }
      const flushed = this._appendPatchHistory(job, mergedEvents);
      if (flushed <= 0 && !forceSave) {
        return { ok: true, flushed: 0 };
      }
      await this._saveJob(job, this._isTerminalStatus(job.status) ? { clearActive: true } : { setActive: true });
      return { ok: true, flushed };
    }

    _appendPatchHistory(job, events) {
      if (!job || !Array.isArray(events) || !events.length) {
        return 0;
      }
      job.agentState = job.agentState && typeof job.agentState === 'object'
        ? job.agentState
        : {};
      const state = job.agentState;
      state.patchHistory = Array.isArray(state.patchHistory) ? state.patchHistory : [];
      state.patchSeq = Number.isFinite(Number(state.patchSeq))
        ? Number(state.patchSeq)
        : 0;
      let appended = 0;
      events.forEach((item) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const nextSeq = state.patchSeq + 1;
        state.patchSeq = nextSeq;
        const kind = item.kind === 'final' || item.kind === 'restore' || item.kind === 'toggle'
          ? item.kind
          : 'delta';
        const normalized = {
          seq: nextSeq,
          ts: Number.isFinite(Number(item.ts)) ? Number(item.ts) : Date.now(),
          jobId: job.id,
          tabId: Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : null,
          blockId: item.blockId ? String(item.blockId) : 'unknown',
          phase: item.phase || this._resolvePatchPhase(job),
          kind,
          prev: {
            textHash: item.prev && typeof item.prev.textHash === 'string' ? item.prev.textHash : null,
            textPreview: item.prev && typeof item.prev.textPreview === 'string'
              ? item.prev.textPreview.slice(0, 1000)
              : ''
          },
          next: {
            textHash: item.next && typeof item.next.textHash === 'string' ? item.next.textHash : null,
            textPreview: item.next && typeof item.next.textPreview === 'string'
              ? item.next.textPreview.slice(0, 1000)
              : ''
          },
          meta: item.meta && typeof item.meta === 'object'
            ? { ...item.meta }
            : {}
        };
        state.patchHistory.push(normalized);
        appended += 1;
        if (normalized.kind !== 'toggle' && normalized.blockId !== '__display_mode__') {
          const block = job.blocksById && job.blocksById[normalized.blockId]
            ? job.blocksById[normalized.blockId]
            : null;
          const nextDiff = {
            blockId: normalized.blockId,
            category: this._normalizeCategory(block && (block.category || block.pathHint) || 'unknown'),
            before: normalized.prev.textPreview || '',
            after: normalized.next.textPreview || ''
          };
          job.recentDiffItems = Array.isArray(job.recentDiffItems) ? job.recentDiffItems : [];
          job.recentDiffItems = job.recentDiffItems.concat([nextDiff]).slice(-20);
        }
      });
      if (state.patchHistory.length > this.PATCH_HISTORY_LIMIT) {
        state.patchHistory = state.patchHistory.slice(-this.PATCH_HISTORY_LIMIT);
      }
      state.updatedAt = Date.now();
      job.updatedAt = Date.now();
      return appended;
    }

    _buildBlockSummaries(job, { limit = 500 } = {}) {
      if (!job || !job.blocksById || typeof job.blocksById !== 'object') {
        return [];
      }
      const pending = new Set(Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds : []);
      const failed = new Set(Array.isArray(job.failedBlockIds) ? job.failedBlockIds : []);
      const max = Number.isFinite(Number(limit)) ? Math.max(20, Math.round(Number(limit))) : 500;
      return Object.keys(job.blocksById)
        .slice(0, max)
        .map((blockId) => {
          const block = job.blocksById[blockId] || {};
          const originalText = typeof block.originalText === 'string' ? block.originalText : '';
          const translatedText = typeof block.translatedText === 'string' ? block.translatedText : '';
          const quality = block && block.quality && typeof block.quality === 'object'
            ? block.quality
            : null;
          const status = failed.has(blockId)
            ? 'FAILED'
            : pending.has(blockId)
              ? 'PENDING'
              : (translatedText ? 'DONE' : 'PENDING');
          return {
            blockId,
            frameId: Number.isFinite(Number(block.frameId)) ? Number(block.frameId) : 0,
            category: this._normalizeCategory(block.category || block.pathHint || 'unknown'),
            status,
            originalLength: originalText.length,
            translatedLength: translatedText.length,
            originalHash: block.originalHash || this._hashTextStable(originalText),
            translatedHash: translatedText ? this._hashTextStable(translatedText) : null,
            qualityTag: quality && typeof quality.tag === 'string' ? quality.tag : 'raw',
            originalSnippet: this._buildPatchPreview(originalText),
            translatedSnippet: translatedText ? this._buildPatchPreview(translatedText) : ''
          };
        });
    }

    _mergeFrameShadowMetricsIntoJob(job, {
      frameId = null,
      frameUrl = null,
      documentId = null,
      scanStats = null
    } = {}) {
      if (!job || typeof job !== 'object') {
        return;
      }
      job.agentState = job.agentState && typeof job.agentState === 'object'
        ? job.agentState
        : {};
      const state = job.agentState;
      state.frameMetrics = state.frameMetrics && typeof state.frameMetrics === 'object'
        ? state.frameMetrics
        : {
          frames: {
            totalSeen: 0,
            injectedOk: 0,
            skippedNoPerm: 0,
            scannedOk: 0,
            applyOk: 0,
            byFrame: {}
          },
          shadowDom: {
            openRootsVisited: 0,
            textNodesFromShadow: 0
          },
          highlights: {
            supported: false,
            mode: 'auto',
            appliedCount: 0,
            fallbackCount: 0
          }
        };
      const metrics = state.frameMetrics;
      const frames = metrics.frames && typeof metrics.frames === 'object'
        ? metrics.frames
        : {};
      frames.byFrame = frames.byFrame && typeof frames.byFrame === 'object' ? frames.byFrame : {};

      if (Number.isFinite(Number(frameId))) {
        const key = String(Number(frameId));
        const current = frames.byFrame[key] && typeof frames.byFrame[key] === 'object'
          ? frames.byFrame[key]
          : {
            frameId: Number(frameId),
            frameUrl: null,
            documentId: null,
            injected: true,
            scannedBlocksCount: 0,
            skippedReason: null
          };
        if (typeof frameUrl === 'string' && frameUrl) {
          current.frameUrl = frameUrl;
        }
        if (typeof documentId === 'string' && documentId) {
          current.documentId = documentId;
        }
        if (scanStats && Number.isFinite(Number(scanStats.totalTextNodes))) {
          current.scannedBlocksCount = Math.max(
            Number(current.scannedBlocksCount || 0),
            Number(scanStats.totalTextNodes)
          );
        }
        frames.byFrame[key] = current;
      }

      const statFrames = scanStats && scanStats.frames && typeof scanStats.frames === 'object'
        ? scanStats.frames
        : null;
      if (statFrames) {
        frames.totalSeen = Math.max(frames.totalSeen || 0, Number(statFrames.totalSeen || 0));
        frames.scannedOk = Math.max(frames.scannedOk || 0, Number(statFrames.scannedOk || 0));
        frames.skippedNoPerm = Math.max(frames.skippedNoPerm || 0, Number(statFrames.skippedNoPerm || 0));
        if (frames.skippedNoPerm > 0 && Array.isArray(statFrames.skipped)) {
          statFrames.skipped.slice(0, 24).forEach((row, idx) => {
            const key = `skip_${idx}`;
            if (!frames.byFrame[key]) {
              frames.byFrame[key] = {
                frameId: null,
                frameUrl: row && row.framePath ? row.framePath : null,
                documentId: null,
                injected: false,
                scannedBlocksCount: 0,
                skippedReason: row && row.reason ? row.reason : 'no_host_permission_or_cross_origin'
              };
            }
          });
        }
      }
      const injectedFrameCount = Object.keys(frames.byFrame)
        .map((key) => frames.byFrame[key])
        .filter((row) => row && row.injected !== false)
        .length;
      frames.injectedOk = Math.max(frames.injectedOk || 0, injectedFrameCount);
      metrics.frames = frames;

      const shadowStats = scanStats && scanStats.shadowDom && typeof scanStats.shadowDom === 'object'
        ? scanStats.shadowDom
        : null;
      if (shadowStats) {
        metrics.shadowDom.openRootsVisited = Math.max(
          Number(metrics.shadowDom.openRootsVisited || 0),
          Number(shadowStats.openRootsVisited || 0)
        );
        metrics.shadowDom.textNodesFromShadow = Math.max(
          Number(metrics.shadowDom.textNodesFromShadow || 0),
          Number(shadowStats.textNodesFromShadow || 0)
        );
      }

      state.frameMetrics = metrics;
    }

    _recordRuntimeAction(job, payload) {
      try {
        if (!job || !job.agentState || !this.translationAgent || typeof this.translationAgent.recordRuntimeAction !== 'function') {
          return null;
        }
        return this.translationAgent.recordRuntimeAction(job, payload || {});
      } catch (_) {
        return null;
      }
    }

    _estimateJsonBytes(value) {
      try {
        const text = JSON.stringify(value);
        return typeof text === 'string' ? text.length : 0;
      } catch (_) {
        return 0;
      }
    }

    _recordPerfJobMetric(job, key, value) {
      if (!this.perfProfiler || typeof this.perfProfiler.recordJobMetric !== 'function' || !job || !job.id || !key) {
        return;
      }
      if (typeof this.perfProfiler.attachJobContext === 'function') {
        this.perfProfiler.attachJobContext(job.id, {
          tabId: Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : null,
          status: typeof job.status === 'string' ? job.status : null
        });
      }
      this.perfProfiler.recordJobMetric(job.id, key, value);
    }

    _recordPerfMemoryCache(job, { lookups = 0, hits = 0 } = {}) {
      if (!job || !job.id) {
        return;
      }
      const safeLookups = Number.isFinite(Number(lookups)) ? Math.max(0, Number(lookups)) : 0;
      const safeHits = Number.isFinite(Number(hits)) ? Math.max(0, Number(hits)) : 0;
      if (safeLookups > 0) {
        this._recordPerfJobMetric(job, 'memoryCacheLookup', safeLookups);
      }
      if (safeHits > 0) {
        this._recordPerfJobMetric(job, 'memoryCacheHit', safeHits);
      }
    }

    _computeCoalescedCountFromTrace(job) {
      const trace = job && job.agentState && Array.isArray(job.agentState.toolExecutionTrace)
        ? job.agentState.toolExecutionTrace
        : [];
      return trace.reduce((acc, item) => {
        const qos = item && item.qos && typeof item.qos === 'object'
          ? item.qos
          : (item && item.meta && item.meta.qos && typeof item.meta.qos === 'object' ? item.meta.qos : null);
        const value = qos && Number.isFinite(Number(qos.coalescedCount))
          ? Number(qos.coalescedCount)
          : 0;
        return acc + Math.max(0, value);
      }, 0);
    }

    _updateJobPerfSnapshot(job) {
      if (!job || !job.id) {
        return;
      }
      const bytes = this._estimateJsonBytes(job);
      this._recordPerfJobMetric(job, 'storageBytesEstimate', bytes);
      const coalesced = this._computeCoalescedCountFromTrace(job);
      this._recordPerfJobMetric(job, 'coalescedCount', coalesced);

      if (!job.agentState || typeof job.agentState !== 'object') {
        job.agentState = {};
      }
      const perf = job.agentState.perf && typeof job.agentState.perf === 'object'
        ? job.agentState.perf
        : {};
      perf.storageBytesEstimate = bytes;
      perf.coalescedCount = coalesced;
      perf.updatedAt = Date.now();
      if (this.perfProfiler && typeof this.perfProfiler.getSnapshot === 'function') {
        const snapshot = this.perfProfiler.getSnapshot();
        const jobs = snapshot && Array.isArray(snapshot.jobs) ? snapshot.jobs : [];
        const row = jobs.find((item) => item && item.jobId === job.id);
        if (row && row.metrics && typeof row.metrics === 'object') {
          perf.metrics = row.metrics;
        }
      }
      job.agentState.perf = perf;
    }

    _toJobSummary(job) {
      if (!job) {
        return null;
      }
      const runtime = this._ensureJobRuntime(job, { now: Date.now() });
      const runSettings = this._ensureJobRunSettings(job, { settings: null });
      const proofreading = this._ensureJobProofreadingState(job);
      const autoTune = runSettings && runSettings.autoTune && typeof runSettings.autoTune === 'object'
        ? runSettings.autoTune
        : null;
      const pendingProposal = autoTune && Array.isArray(autoTune.proposals)
        ? autoTune.proposals.slice().reverse().find((item) => item && item.status === 'proposed')
        : null;
      const lastDecision = autoTune && Array.isArray(autoTune.decisionLog) && autoTune.decisionLog.length
        ? autoTune.decisionLog[autoTune.decisionLog.length - 1]
        : null;
      return {
        id: job.id,
        tabId: job.tabId,
        status: job.status,
        message: job.message || '',
        totalBlocks: Number(job.totalBlocks || 0),
        completedBlocks: Number(job.completedBlocks || 0),
        failedBlocksCount: Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0,
        pendingRangesCount: Array.isArray(job.pendingRangeIds) ? job.pendingRangeIds.length : 0,
        currentBatchId: job.currentBatchId || null,
        selectedCategories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
        selectedRangeIds: Array.isArray(job.selectedRangeIds) ? job.selectedRangeIds.slice(0, 120) : [],
        availableCategories: Array.isArray(job.availableCategories) ? job.availableCategories.slice(0, 24) : [],
        classification: job.classification && typeof job.classification === 'object'
          ? {
            classifierVersion: job.classification.classifierVersion || null,
            domHash: job.classification.domHash || null,
            summary: job.classification.summary && typeof job.classification.summary === 'object'
              ? job.classification.summary
              : null,
            byBlockId: job.classification.byBlockId && typeof job.classification.byBlockId === 'object'
              ? job.classification.byBlockId
              : {},
            ts: Number.isFinite(Number(job.classification.ts)) ? Number(job.classification.ts) : null,
            stale: job.classificationStale === true
          }
          : null,
        domHash: job.domHash || (job.classification && job.classification.domHash) || null,
        classificationStale: job.classificationStale === true,
        categoryRecommendations: job.agentState
          && job.agentState.categoryRecommendations
          && typeof job.agentState.categoryRecommendations === 'object'
          ? job.agentState.categoryRecommendations
          : null,
        frameMetrics: job.agentState
          && job.agentState.frameMetrics
          && typeof job.agentState.frameMetrics === 'object'
          ? job.agentState.frameMetrics
          : null,
        perf: job.agentState
          && job.agentState.perf
          && typeof job.agentState.perf === 'object'
          ? job.agentState.perf
          : null,
        pageSignature: job.pageSignature || null,
        memoryContext: job.memoryContext && typeof job.memoryContext === 'object'
          ? {
            pageKey: job.memoryContext.pageKey || null,
            normalizedUrl: job.memoryContext.normalizedUrl || null,
            domHash: job.memoryContext.domHash || null,
            domSigVersion: job.memoryContext.domSigVersion || null
          }
          : null,
        memoryRestore: job.memoryRestore && typeof job.memoryRestore === 'object'
          ? job.memoryRestore
          : null,
        agentPhase: job.agentState && job.agentState.phase ? job.agentState.phase : null,
        agentProfile: job.agentState && job.agentState.profile ? job.agentState.profile : null,
        displayMode: this._normalizeDisplayMode(job.displayMode, true),
        compareDiffThreshold: this._normalizeCompareDiffThreshold(job.compareDiffThreshold),
        compareRendering: this._normalizeCompareRendering(job.compareRendering),
        runSettings: runSettings
          ? {
            effectiveSummary: this.runSettings && typeof this.runSettings.serializeForAgent === 'function'
              ? this.runSettings.serializeForAgent(runSettings.effective)
              : (runSettings.effective || null),
            agentOverrides: runSettings.agentOverrides && typeof runSettings.agentOverrides === 'object'
              ? runSettings.agentOverrides
              : {},
            userOverrides: runSettings.userOverrides && typeof runSettings.userOverrides === 'object'
              ? runSettings.userOverrides
              : {},
            autoTune: {
              enabled: autoTune ? autoTune.enabled !== false : true,
              mode: autoTune && autoTune.mode === 'ask_user' ? 'ask_user' : 'auto_apply',
              lastProposalId: autoTune && typeof autoTune.lastProposalId === 'string' ? autoTune.lastProposalId : null,
              pendingProposal: pendingProposal || null,
              lastDecision: lastDecision || null,
              proposals: autoTune && Array.isArray(autoTune.proposals) ? autoTune.proposals.slice(-60) : [],
              decisionLog: autoTune && Array.isArray(autoTune.decisionLog) ? autoTune.decisionLog.slice(-120) : []
            }
          }
          : null,
        proofreading: {
          enabled: proofreading.enabled === true,
          mode: proofreading.mode === 'manual' ? 'manual' : 'auto',
          pass: Number.isFinite(Number(proofreading.pass)) ? Number(proofreading.pass) : 0,
          pendingCount: Array.isArray(proofreading.pendingBlockIds) ? proofreading.pendingBlockIds.length : 0,
          doneCount: Array.isArray(proofreading.doneBlockIds) ? proofreading.doneBlockIds.length : 0,
          failedCount: Array.isArray(proofreading.failedBlockIds) ? proofreading.failedBlockIds.length : 0,
          lastPlanTs: Number.isFinite(Number(proofreading.lastPlanTs)) ? Number(proofreading.lastPlanTs) : null,
          lastError: proofreading.lastError && typeof proofreading.lastError === 'object'
            ? proofreading.lastError
            : null
        },
        patchHistoryCount: job.agentState && Array.isArray(job.agentState.patchHistory)
          ? job.agentState.patchHistory.length
          : 0,
        runtime: runtime && typeof runtime === 'object'
          ? {
            status: runtime.status || null,
            stage: runtime.stage || null,
            leaseUntilTs: runtime.lease && Number.isFinite(Number(runtime.lease.leaseUntilTs))
              ? Number(runtime.lease.leaseUntilTs)
              : null,
            heartbeatTs: runtime.lease && Number.isFinite(Number(runtime.lease.heartbeatTs))
              ? Number(runtime.lease.heartbeatTs)
              : null,
            op: runtime.lease && runtime.lease.op ? runtime.lease.op : null,
            opId: runtime.lease && runtime.lease.opId ? runtime.lease.opId : null,
            attempt: runtime.retry && Number.isFinite(Number(runtime.retry.attempt))
              ? Number(runtime.retry.attempt)
              : 0,
            nextRetryAtTs: runtime.retry && Number.isFinite(Number(runtime.retry.nextRetryAtTs))
              ? Number(runtime.retry.nextRetryAtTs)
              : 0,
            maxAttempts: runtime.retry && Number.isFinite(Number(runtime.retry.maxAttempts))
              ? Number(runtime.retry.maxAttempts)
              : 0,
            lastErrorCode: runtime.retry && runtime.retry.lastError && runtime.retry.lastError.code
              ? runtime.retry.lastError.code
              : null
          }
          : null,
        blockSummaries: this._buildBlockSummaries(job, { limit: 500 }),
        updatedAt: job.updatedAt || null
      };
    }

    _extractErrorDebug(errorLike) {
      const source = errorLike && typeof errorLike === 'object' ? errorLike : null;
      if (!source) {
        return null;
      }
      const nested = source.error && typeof source.error === 'object'
        ? source.error
        : null;
      const debug = nested && nested.debug && typeof nested.debug === 'object'
        ? nested.debug
        : (source.debug && typeof source.debug === 'object' ? source.debug : null);
      if (!debug) {
        return null;
      }
      const out = {};
      if (typeof debug.baseUrl === 'string' && debug.baseUrl) {
        out.baseUrl = debug.baseUrl.slice(0, 180);
      }
      if (Array.isArray(debug.transportTried)) {
        const transports = debug.transportTried
          .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
          .filter((value) => value === 'fetch' || value === 'xhr');
        if (transports.length) {
          out.transportTried = transports.slice(0, 3);
        }
      }
      if (typeof debug.endpoint === 'string' && debug.endpoint) {
        out.endpoint = debug.endpoint;
      }
      if (typeof debug.endpointHost === 'string' && debug.endpointHost) {
        out.endpointHost = debug.endpointHost;
      }
      if (typeof debug.online === 'boolean') {
        out.online = debug.online;
      } else if (debug.online === null) {
        out.online = null;
      }
      if (typeof debug.ua === 'string' && debug.ua) {
        out.ua = debug.ua.slice(0, 280);
      }
      const probe = debug.probe && typeof debug.probe === 'object' ? debug.probe : null;
      if (probe) {
        const safeProbe = {
          ok: probe.ok === true
        };
        if (typeof probe.online === 'boolean') {
          safeProbe.online = probe.online;
          if (!Object.prototype.hasOwnProperty.call(out, 'online')) {
            out.online = probe.online;
          }
        } else if (probe.online === null) {
          safeProbe.online = null;
          if (!Object.prototype.hasOwnProperty.call(out, 'online')) {
            out.online = null;
          }
        }
        if (typeof probe.ua === 'string' && probe.ua) {
          safeProbe.ua = probe.ua.slice(0, 280);
          if (!Object.prototype.hasOwnProperty.call(out, 'ua')) {
            out.ua = probe.ua.slice(0, 280);
          }
        }
        if (Number.isFinite(Number(probe.status))) {
          safeProbe.status = Number(probe.status);
        }
        if (typeof probe.note === 'string' && probe.note) {
          safeProbe.note = probe.note;
        }
        if (typeof probe.errorMessage === 'string' && probe.errorMessage) {
          safeProbe.errorMessage = probe.errorMessage.slice(0, 260);
        }
        if (typeof probe.name === 'string' && probe.name) {
          safeProbe.name = probe.name.slice(0, 120);
        }
        if (Array.isArray(probe.steps)) {
          safeProbe.steps = probe.steps.slice(0, 8).map((step, index) => {
            const row = step && typeof step === 'object' ? step : {};
            const outStep = {
              name: typeof row.name === 'string' && row.name
                ? row.name.slice(0, 80)
                : `step_${index + 1}`,
              ok: row.ok === true
            };
            if (Number.isFinite(Number(row.status))) {
              outStep.status = Number(row.status);
            }
            if (typeof row.errName === 'string' && row.errName) {
              outStep.errName = row.errName.slice(0, 120);
            }
            if (typeof row.errMessage === 'string' && row.errMessage) {
              outStep.errMessage = row.errMessage.slice(0, 220);
            }
            if (Number.isFinite(Number(row.ms))) {
              outStep.ms = Math.max(0, Math.round(Number(row.ms)));
            }
            return outStep;
          });
        }
        out.probe = safeProbe;
      }
      return Object.keys(out).length ? out : null;
    }

    _buildFetchFailedHint(errorLike) {
      const source = errorLike && typeof errorLike === 'object' ? errorLike : null;
      if (!source) {
        return '';
      }
      const directCode = source.code && typeof source.code === 'string'
        ? source.code
        : null;
      const nestedCode = source.error && typeof source.error === 'object' && typeof source.error.code === 'string'
        ? source.error.code
        : null;
      const code = directCode || nestedCode || '';
      if (code !== 'FETCH_FAILED') {
        return '';
      }
      const debug = this._extractErrorDebug(source);
      const probe = debug && debug.probe && typeof debug.probe === 'object'
        ? debug.probe
        : null;
      if (!probe || typeof probe.ok !== 'boolean') {
        return '';
      }
      if (probe.ok === false) {
        return 'Р СџР С•РЎвЂ¦Р С•Р В¶Р Вµ, Р Т‘Р С•Р СР ВµР Р… api.openai.com Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р… Р С‘Р В· РЎРѓР ВµРЎвЂљР С‘/Р В±Р В»Р С•Р С”Р С‘РЎР‚РЎС“Р ВµРЎвЂљРЎРѓРЎРЏ (DNS/РЎвЂћР В°Р ВµРЎР‚Р Р†Р С•Р В»/AdGuard/uBlock/РЎРѓР ВµРЎР‚РЎвЂљР С‘РЎвЂћР С‘Р С”Р В°РЎвЂљ).';
      }
      return 'Р РЋР ВµРЎвЂљРЎРЉ Р Т‘Р С• api.openai.com Р ВµРЎРѓРЎвЂљРЎРЉ, Р С‘РЎвЂ°Р С‘ CSP/permissions Р С‘Р В»Р С‘ Р В±Р В»Р С•Р С” POST.';
    }

    _normalizeJobError(errorLike, { fallbackCode = 'TRANSLATION_FAILED', fallbackMessage = 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬Р С‘Р В»РЎРѓРЎРЏ Р С•РЎв‚¬Р С‘Р В±Р С”Р С•Р в„–' } = {}) {
      const source = errorLike && typeof errorLike === 'object'
        ? errorLike
        : {};
      const code = source.code && typeof source.code === 'string'
        ? source.code
        : (source.error && source.error.code && typeof source.error.code === 'string'
          ? source.error.code
          : fallbackCode);
      const rawMessage = source.message && typeof source.message === 'string'
        ? source.message
        : (source.error && source.error.message && typeof source.error.message === 'string'
          ? source.error.message
          : fallbackMessage);
      const hint = this._buildFetchFailedHint(source);
      const separator = rawMessage && /[.!?РІР‚В¦]$/.test(rawMessage.trim()) ? ' ' : '. ';
      const message = hint
        ? `${rawMessage}${separator}${hint}`
        : rawMessage;
      const normalized = {
        code,
        message
      };
      const debug = this._extractErrorDebug(source);
      if (debug) {
        normalized.error = {
          code,
          message: rawMessage,
          debug
        };
      }
      return normalized;
    }

    _retryAfterMsFromError(errorLike) {
      const source = errorLike && typeof errorLike === 'object' ? errorLike : {};
      const direct = Number(source.retryAfterMs || source.retry_after_ms || source.retryAfter);
      if (Number.isFinite(direct)) {
        return Math.max(250, Math.min(Math.round(direct), 15 * 60 * 1000));
      }
      const headers = source.headers && typeof source.headers === 'object' ? source.headers : null;
      if (!headers) {
        return null;
      }
      const readHeader = (name) => {
        if (typeof headers.get === 'function') {
          try {
            return headers.get(name);
          } catch (_) {
            return null;
          }
        }
        const keys = Object.keys(headers || {});
        for (let i = 0; i < keys.length; i += 1) {
          if (String(keys[i]).toLowerCase() === String(name).toLowerCase()) {
            return headers[keys[i]];
          }
        }
        return null;
      };
      const msRaw = Number(readHeader('retry-after-ms'));
      if (Number.isFinite(msRaw)) {
        return Math.max(250, Math.min(Math.round(msRaw), 15 * 60 * 1000));
      }
      const secRaw = Number(readHeader('retry-after'));
      if (Number.isFinite(secRaw)) {
        return Math.max(250, Math.min(Math.round(secRaw * 1000), 15 * 60 * 1000));
      }
      return null;
    }

    _isBackpressureError(errorLike) {
      const source = errorLike && typeof errorLike === 'object' ? errorLike : {};
      const code = source.code && typeof source.code === 'string' ? source.code : '';
      const status = Number(source.status || source.httpStatus || (source.http && source.http.status));
      if (code === 'RATE_LIMIT_BUDGET_WAIT' || code === 'OPENAI_429' || code === 'OFFSCREEN_BACKPRESSURE') {
        return true;
      }
      if (Number.isFinite(status) && status === 429) {
        return true;
      }
      return false;
    }

    async _requeueJobForBackpressure(job, errorLike) {
      if (!job || !job.id || !this._isBackpressureError(errorLike)) {
        return false;
      }
      const latest = await this.jobStore.getJob(job.id).catch(() => null);
      if (!latest || this._isTerminalStatus(latest.status)) {
        return false;
      }
      const now = Date.now();
      const sourceCode = errorLike && typeof errorLike.code === 'string'
        ? String(errorLike.code)
        : 'RATE_LIMIT_BUDGET_WAIT';
      const isOffscreenBackpressure = sourceCode === 'OFFSCREEN_BACKPRESSURE';
      const waitMs = this._retryAfterMsFromError(errorLike) || 30 * 1000;
      const runtime = this._ensureJobRuntime(latest, { now });
      runtime.status = 'QUEUED';
      runtime.retry = runtime.retry && typeof runtime.retry === 'object' ? runtime.retry : {};
      runtime.retry.nextRetryAtTs = now + waitMs;
      runtime.retry.lastError = {
        code: isOffscreenBackpressure ? 'OFFSCREEN_BACKPRESSURE' : 'RATE_LIMIT_BUDGET_WAIT',
        message: isOffscreenBackpressure
          ? `Р С›Р В¶Р С‘Р Т‘Р В°РЎР‹ РЎРѓР В»Р С•РЎвЂљ offscreen ${Math.ceil(waitMs / 1000)}РЎРѓ`
          : `Р С›Р В¶Р С‘Р Т‘Р В°РЎР‹ Р В»Р С‘Р СР С‘РЎвЂљ API ${Math.ceil(waitMs / 1000)}РЎРѓ`
      };
      runtime.lease = runtime.lease && typeof runtime.lease === 'object' ? runtime.lease : {};
      runtime.lease.leaseUntilTs = null;
      runtime.lease.heartbeatTs = now;
      runtime.lease.op = isOffscreenBackpressure ? 'offscreen_wait' : 'rate_limit_wait';
      runtime.lease.opId = latest.id;
      latest.status = 'preparing';
      latest.message = isOffscreenBackpressure
        ? `Р С›Р В¶Р С‘Р Т‘Р В°РЎР‹ РЎРѓР В»Р С•РЎвЂљ offscreen ${Math.ceil(waitMs / 1000)}РЎРѓ`
        : `Р С›Р В¶Р С‘Р Т‘Р В°РЎР‹ Р В»Р С‘Р СР С‘РЎвЂљ API ${Math.ceil(waitMs / 1000)}РЎРѓ`;
      latest.runtime = runtime;
      await this._saveJob(latest, { setActive: true });
      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.AI_RATE_LIMIT : 'ai.rate_limit', latest.message, {
        tabId: latest.tabId,
        jobId: latest.id,
        waitMs
      });
      return true;
    }

    async _markFailed(job, error) {
      if (!job) {
        return;
      }
      this._abortJobRequests(job.id, 'FAILED');
      this._clearPendingAckWaiters(job.id);
      await this._flushPatchEvents(job.id, { forceSave: true }).catch(() => ({ ok: false }));
      job.status = 'failed';
      job.lastError = this._normalizeJobError(error, {
        fallbackCode: 'TRANSLATION_FAILED',
        fallbackMessage: 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р В·Р В°Р Р†Р ВµРЎР‚РЎв‚¬Р С‘Р В»РЎРѓРЎРЏ Р С•РЎв‚¬Р С‘Р В±Р С”Р С•Р в„–'
      });
      job.message = job.lastError.message;
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markFailed === 'function') {
        this.translationAgent.markFailed(job, job.lastError);
      }
      await this._saveJob(job, { clearActive: true });
      this._emitEvent('error', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', job.lastError.message, {
        tabId: job.tabId,
        jobId: job.id,
        failedBlocksCount: Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0
      });
      this._dropJobAbortController(job.id);
    }

    async _ensureContentRuntime(tabId) {
      if (!this.chromeApi || !this.chromeApi.scripting || typeof this.chromeApi.scripting.executeScript !== 'function') {
        return { ok: false, error: { code: 'SCRIPTING_UNAVAILABLE', message: 'chrome.scripting РЅРµРґРѕСЃС‚СѓРїРµРЅ' } };
      }
      const RuntimePaths = NT.RuntimePaths || null;
      const resolvePath = (relativePath) => (
        RuntimePaths && typeof RuntimePaths.withPrefix === 'function'
          ? RuntimePaths.withPrefix(this.chromeApi, relativePath)
          : relativePath
      );
      const files = [
        resolvePath('core/nt-namespace.js'),
        resolvePath('core/message-envelope.js'),
        resolvePath('core/translation-protocol.js'),
        resolvePath('content/dom-indexer.js'),
        resolvePath('content/dom-classifier.js'),
        resolvePath('content/diff-highlighter.js'),
        resolvePath('content/highlight-engine.js'),
        resolvePath('content/dom-applier.js'),
        resolvePath('content/content-runtime.js')
      ];
      try {
        await this.chromeApi.scripting.executeScript({
          target: { tabId, allFrames: true },
          files
        });
        return { ok: true, allFrames: true };
      } catch (errorAllFrames) {
        try {
          await this.chromeApi.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            files
          });
          return {
            ok: true,
            allFrames: false,
            warning: {
              code: 'FRAME_INJECT_PARTIAL',
              message: 'frame skipped: no host permission',
              details: errorAllFrames && errorAllFrames.message ? errorAllFrames.message : 'allFrames inject failed'
            }
          };
        } catch (errorTopOnly) {
          const primary = errorTopOnly || errorAllFrames;
          return {
            ok: false,
            error: {
              code: 'INJECT_FAILED',
              message: primary && primary.message ? primary.message : 'РќРµ СѓРґР°Р»РѕСЃСЊ РІРЅРµРґСЂРёС‚СЊ РєРѕРЅС‚РµРЅС‚-СЂР°РЅС‚Р°Р№Рј'
            }
          };
        }
      }
    }

    async _sendToTab(tabId, message) {
      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.sendMessage !== 'function') {
        return { ok: false, error: { code: 'TABS_API_UNAVAILABLE', message: 'chrome.tabs.sendMessage Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р…' } };
      }
      try {
        const protocol = NT.TranslationProtocol || {};
        let outgoingMessage = message;
        const explicitTargetFrameId = message && Number.isFinite(Number(message.targetFrameId))
          ? Number(message.targetFrameId)
          : null;
        const explicitFrameId = message && Number.isFinite(Number(message.frameId))
          ? Number(message.frameId)
          : null;
        let targetFrameId = explicitTargetFrameId !== null
          ? explicitTargetFrameId
          : (message && typeof message.type === 'string' && message.type.indexOf('translation:bg:') === 0 ? 0 : null);
        const targetDocumentId = message && typeof message.targetDocumentId === 'string' && message.targetDocumentId
          ? message.targetDocumentId
          : (message && typeof message.documentId === 'string' && message.documentId
            ? message.documentId
            : null);
        if (targetFrameId === null && explicitFrameId !== null && !targetDocumentId) {
          // Backward-compatible routing for non-translation messages.
          // translation:bg:* defaults to top frame and ignores payload frameId.
          // Other transports may still route by explicit frameId.
          targetFrameId = explicitFrameId;
        }
        if (message && typeof message === 'object' && typeof message.type === 'string' && typeof protocol.wrap === 'function') {
          try {
            const payload = { ...message };
            delete payload.type;
            delete payload.targetFrameId;
            delete payload.targetDocumentId;
            outgoingMessage = protocol.wrap(message.type, payload, {
              source: 'background',
              tabId,
              frameId: targetFrameId,
              documentId: targetDocumentId,
              frameUrl: typeof payload.frameUrl === 'string' ? payload.frameUrl : null,
              stage: message.type,
              requestId: payload.batchId || payload.jobId || null
            });
          } catch (_) {
            outgoingMessage = message;
          }
        }
        return await new Promise((resolve) => {
          const callback = (response) => {
            const runtimeError = this.chromeApi.runtime && this.chromeApi.runtime.lastError
              ? this.chromeApi.runtime.lastError
              : null;
            if (runtimeError) {
              resolve({
                ok: false,
                error: {
                  code: 'TAB_SEND_FAILED',
                  message: runtimeError.message || 'Р РЋР В±Р С•Р в„– tabs.sendMessage'
                }
              });
              return;
            }
            resolve(response && response.ok === false ? { ok: false, error: response.error || { code: 'UNKNOWN', message: 'Р СњР ВµР С‘Р В·Р Р†Р ВµРЎРѓРЎвЂљР Р…Р В°РЎРЏ Р С•РЎв‚¬Р С‘Р В±Р С”Р В° Р Р†Р С”Р В»Р В°Р Т‘Р С”Р С‘' } } : { ok: true, response });
          };
          if (targetFrameId !== null || targetDocumentId) {
            const sendOptions = {};
            if (targetFrameId !== null) {
              sendOptions.frameId = targetFrameId;
            }
            if (targetDocumentId) {
              sendOptions.documentId = targetDocumentId;
            }
            this.chromeApi.tabs.sendMessage(tabId, outgoingMessage, sendOptions, callback);
            return;
          }
          this.chromeApi.tabs.sendMessage(tabId, outgoingMessage, callback);
        });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'TAB_SEND_FAILED', message: error && error.message ? error.message : 'Р РЋР В±Р С•Р в„– tabs.sendMessage' }
        };
      }
    }

    _normalizeBlocks(input, { frameId = 0 } = {}) {
      const list = Array.isArray(input) ? input : [];
      const out = [];
      const seen = new Set();
      const fallbackFrameId = Number.isFinite(Number(frameId)) ? Number(frameId) : 0;
      const parsePrefixedBlockId = (value) => {
        const raw = typeof value === 'string' ? value.trim() : '';
        const match = /^f(\d+):(.+)$/.exec(raw);
        if (!match) {
          return null;
        }
        return {
          frameId: Number(match[1]),
          localBlockId: match[2]
        };
      };
      list.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const originalText = typeof item.originalText === 'string' ? item.originalText.trim() : '';
        if (!originalText) {
          return;
        }
        const parsed = parsePrefixedBlockId(item.blockId);
        const itemFrameId = Number.isFinite(Number(item.frameId))
          ? Number(item.frameId)
          : (parsed ? parsed.frameId : fallbackFrameId);
        const localBlockId = typeof item.localBlockId === 'string' && item.localBlockId
          ? item.localBlockId
          : (parsed ? parsed.localBlockId : (item.blockId || `b${index}`));
        const blockId = parsed
          ? item.blockId
          : `f${itemFrameId}:${localBlockId}`;
        if (seen.has(blockId)) {
          return;
        }
        seen.add(blockId);
        out.push({
          blockId,
          localBlockId,
          frameId: itemFrameId,
          frameUrl: typeof item.frameUrl === 'string' && item.frameUrl ? item.frameUrl : null,
          originalText,
          originalHash: this._hashTextStable(originalText),
          charCount: originalText.length,
          domOrder: Number.isFinite(Number(item.domOrder)) ? Number(item.domOrder) : index,
          stableNodeKey: typeof item.stableNodeKey === 'string' && item.stableNodeKey ? item.stableNodeKey : null,
          pathHint: item.pathHint || null,
          rootHint: typeof item.rootHint === 'string' && item.rootHint ? item.rootHint : null,
          nodePath: typeof item.nodePath === 'string' && item.nodePath ? item.nodePath : null,
          anchor: this._sanitizeBlockAnchor(item.anchor, {
            frameId: itemFrameId,
            rootHint: item.rootHint,
            nodePath: item.nodePath,
            stableNodeKey: item.stableNodeKey
          }),
          preCategory: this._normalizePreCategory(item.preCategory || item.category || 'unknown'),
          featuresMini: this._sanitizeBlockFeaturesMini(item.featuresMini || item.features),
          category: this._normalizeCategory(item.category || 'unknown'),
          features: this._sanitizeBlockFeatures(item.features)
        });
      });
      return out;
    }

    _normalizePreCategory(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (!raw) {
        return 'unknown';
      }
      if (raw === 'other') {
        return 'unknown';
      }
      return raw.slice(0, 40);
    }

    _sanitizeBlockAnchor(input, fallback = {}) {
      const src = input && typeof input === 'object' ? input : {};
      const frameId = Number.isFinite(Number(src.frameId))
        ? Number(src.frameId)
        : (Number.isFinite(Number(fallback.frameId)) ? Number(fallback.frameId) : 0);
      const rootHint = typeof src.rootHint === 'string' && src.rootHint
        ? src.rootHint
        : (typeof fallback.rootHint === 'string' ? fallback.rootHint : '');
      const nodePath = typeof src.nodePath === 'string' && src.nodePath
        ? src.nodePath
        : (typeof fallback.nodePath === 'string' ? fallback.nodePath : '');
      const stableNodeKey = typeof src.stableNodeKey === 'string' && src.stableNodeKey
        ? src.stableNodeKey
        : (typeof fallback.stableNodeKey === 'string' ? fallback.stableNodeKey : '');
      return {
        frameId,
        rootHint: rootHint.slice(0, 180),
        nodePath: nodePath.slice(0, 260),
        stableNodeKey: stableNodeKey.slice(0, 320)
      };
    }

    _sanitizeBlockFeaturesMini(input) {
      const src = input && typeof input === 'object' ? input : {};
      return {
        tag: typeof src.tag === 'string' ? src.tag.slice(0, 24).toLowerCase() : '',
        role: typeof src.role === 'string' ? src.role.slice(0, 40).toLowerCase() : '',
        inputType: typeof src.inputType === 'string' ? src.inputType.slice(0, 32).toLowerCase() : '',
        hrefType: ['nav', 'external', 'anchor', 'none'].includes(String(src.hrefType || '').toLowerCase())
          ? String(src.hrefType || '').toLowerCase()
          : 'none',
        isEditable: src.isEditable === true,
        isCodeLike: src.isCodeLike === true,
        isHidden: src.isHidden === true,
        isInNav: src.isInNav === true,
        isInFooter: src.isInFooter === true,
        isInHeader: src.isInHeader === true,
        isInMain: src.isInMain === true,
        hasTableContext: src.hasTableContext === true,
        textLen: Number.isFinite(Number(src.textLen)) ? Math.max(0, Math.round(Number(src.textLen))) : 0,
        wordCount: Number.isFinite(Number(src.wordCount)) ? Math.max(0, Math.round(Number(src.wordCount))) : 0
      };
    }

    _sanitizeBlockFeatures(input) {
      const src = input && typeof input === 'object' ? input : {};
      const classTokens = Array.isArray(src.classTokens)
        ? src.classTokens
          .map((token) => String(token || '').trim().toLowerCase())
          .filter(Boolean)
          .slice(0, 6)
        : [];
      const bool = (value) => value === true;
      const capped = (value, limit) => {
        if (typeof value !== 'string') {
          return '';
        }
        return value.trim().slice(0, limit);
      };
      return {
        tag: capped(src.tag, 24).toLowerCase(),
        role: capped(src.role, 40).toLowerCase(),
        ariaLabel: capped(src.ariaLabel, 160),
        inputType: capped(src.inputType, 32).toLowerCase(),
        hrefType: ['nav', 'external', 'anchor', 'none'].includes(String(src.hrefType || '').toLowerCase())
          ? String(src.hrefType || '').toLowerCase()
          : 'none',
        isEditable: bool(src.isEditable),
        isCodeLike: bool(src.isCodeLike),
        isHidden: bool(src.isHidden),
        isInNav: bool(src.isInNav),
        isInFooter: bool(src.isInFooter),
        isInHeader: bool(src.isInHeader),
        isInMain: bool(src.isInMain),
        isInDialog: bool(src.isInDialog),
        hasListContext: bool(src.hasListContext),
        hasTableContext: bool(src.hasTableContext),
        langHint: capped(src.langHint, 20).toLowerCase(),
        classTokens,
        idHint: capped(src.idHint, 64),
        textLen: Number.isFinite(Number(src.textLen)) ? Math.max(0, Math.round(Number(src.textLen))) : 0,
        wordCount: Number.isFinite(Number(src.wordCount)) ? Math.max(0, Math.round(Number(src.wordCount))) : 0,
        punctuationRatio: Number.isFinite(Number(src.punctuationRatio))
          ? Math.max(0, Math.min(1, Number(src.punctuationRatio)))
          : 0,
        uppercaseRatio: Number.isFinite(Number(src.uppercaseRatio))
          ? Math.max(0, Math.min(1, Number(src.uppercaseRatio)))
          : 0
      };
    }

    _normalizePreRanges(input, blocksById = null) {
      const list = Array.isArray(input) ? input : [];
      const safeBlocksById = blocksById && typeof blocksById === 'object' ? blocksById : {};
      const out = [];
      list.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const blockIds = Array.isArray(item.blockIds)
          ? item.blockIds.map((value) => String(value || '').trim()).filter(Boolean)
          : [];
        if (!blockIds.length) {
          return;
        }
        const existingBlockIds = blockIds.filter((blockId) => safeBlocksById[blockId]);
        if (!existingBlockIds.length) {
          return;
        }
        const domOrders = existingBlockIds
          .map((blockId) => {
            const block = safeBlocksById[blockId];
            return Number.isFinite(Number(block && block.domOrder))
              ? Number(block.domOrder)
              : null;
          })
          .filter((value) => value !== null);
        const domOrderFrom = Number.isFinite(Number(item.domOrderFrom))
          ? Number(item.domOrderFrom)
          : (domOrders.length ? Math.min(...domOrders) : index);
        const domOrderTo = Number.isFinite(Number(item.domOrderTo))
          ? Number(item.domOrderTo)
          : (domOrders.length ? Math.max(...domOrders) : domOrderFrom);
        const preCategory = this._normalizePreCategory(item.preCategory || 'unknown');
        out.push({
          rangeId: typeof item.rangeId === 'string' && item.rangeId
            ? item.rangeId
            : `r${index}`,
          preCategory,
          blockIds: existingBlockIds,
          domOrderFrom,
          domOrderTo,
          anchorHint: typeof item.anchorHint === 'string' ? item.anchorHint.slice(0, 320) : ''
        });
      });
      return out.sort((left, right) => Number(left.domOrderFrom || 0) - Number(right.domOrderFrom || 0));
    }

    _buildPreanalysisStats({ blocksById, preRanges, scanStats } = {}) {
      const map = blocksById && typeof blocksById === 'object' ? blocksById : {};
      const ranges = Array.isArray(preRanges) ? preRanges : [];
      const scan = scanStats && typeof scanStats === 'object' ? scanStats : {};
      const outByPreCategory = {};
      let totalChars = 0;
      Object.keys(map).forEach((blockId) => {
        const block = map[blockId] && typeof map[blockId] === 'object' ? map[blockId] : {};
        const preCategory = this._normalizePreCategory(block.preCategory || 'unknown');
        outByPreCategory[preCategory] = Number.isFinite(Number(outByPreCategory[preCategory]))
          ? Number(outByPreCategory[preCategory]) + 1
          : 1;
        const text = typeof block.originalText === 'string' ? block.originalText : '';
        totalChars += text.length;
      });
      const externalByPre = scan.byPreCategory && typeof scan.byPreCategory === 'object'
        ? scan.byPreCategory
        : null;
      if (externalByPre) {
        Object.keys(externalByPre).forEach((key) => {
          const value = Number(externalByPre[key]);
          if (!Number.isFinite(value) || value <= 0) {
            return;
          }
          const normalizedKey = this._normalizePreCategory(key);
          if (!Object.prototype.hasOwnProperty.call(outByPreCategory, normalizedKey)) {
            outByPreCategory[normalizedKey] = Math.max(0, Math.round(value));
          }
        });
      }
      return {
        blockCount: Object.keys(map).length,
        totalChars,
        byPreCategory: outByPreCategory,
        rangeCount: ranges.length
      };
    }

    _defaultBlockQuality() {
      return {
        tag: 'raw',
        lastUpdatedTs: null,
        modelUsed: null,
        routeUsed: null,
        pass: null
      };
    }

    _normalizeClassificationPayload(input) {
      const src = input && typeof input === 'object' ? input : {};
      return {
        confidence: Number.isFinite(Number(src.confidence))
          ? Math.max(0, Math.min(1, Number(src.confidence)))
          : 0,
        reasons: Array.isArray(src.reasons)
          ? src.reasons.slice(0, 16).map((item) => String(item || '')).filter(Boolean)
          : []
      };
    }

    _blockRescanMatchKey(block) {
      const row = block && typeof block === 'object' ? block : {};
      const frameId = Number.isFinite(Number(row.frameId)) ? Number(row.frameId) : 0;
      const stableNodeKey = typeof row.stableNodeKey === 'string' ? row.stableNodeKey.trim() : '';
      const pathHint = typeof row.pathHint === 'string' ? row.pathHint.trim() : '';
      const rootHint = typeof row.rootHint === 'string' ? row.rootHint.trim() : '';
      const nodePath = typeof row.nodePath === 'string' ? row.nodePath.trim() : '';
      const originalText = typeof row.originalText === 'string' ? row.originalText : '';
      const originalHash = typeof row.originalHash === 'string' && row.originalHash
        ? row.originalHash
        : this._hashTextStable(originalText);
      const charCount = Number.isFinite(Number(row.charCount))
        ? Math.max(0, Math.round(Number(row.charCount)))
        : originalText.length;
      return `${frameId}|${stableNodeKey}|${rootHint}|${nodePath}|${pathHint}|${charCount}|${originalHash}`;
    }

    _copyBlockPersistentState(targetBlock, sourceBlock) {
      if (!targetBlock || typeof targetBlock !== 'object' || !sourceBlock || typeof sourceBlock !== 'object') {
        return;
      }
      if (typeof sourceBlock.translatedText === 'string' && sourceBlock.translatedText) {
        targetBlock.translatedText = sourceBlock.translatedText;
      }
      if (sourceBlock.quality && typeof sourceBlock.quality === 'object') {
        targetBlock.quality = {
          ...sourceBlock.quality
        };
      }
      if (sourceBlock.translationMeta && typeof sourceBlock.translationMeta === 'object') {
        targetBlock.translationMeta = {
          ...sourceBlock.translationMeta
        };
      }
      if (Number.isFinite(Number(sourceBlock.lastTranslatedAt))) {
        targetBlock.lastTranslatedAt = Number(sourceBlock.lastTranslatedAt);
      }
    }

    _mergeRescannedBlocksWithState({ previousBlocksById, rescannedBlocks, classificationByBlockId } = {}) {
      const oldById = previousBlocksById && typeof previousBlocksById === 'object'
        ? previousBlocksById
        : {};
      const scanned = Array.isArray(rescannedBlocks) ? rescannedBlocks : [];
      const classifiedById = classificationByBlockId && typeof classificationByBlockId === 'object'
        ? classificationByBlockId
        : {};
      const translatedByKey = {};
      Object.keys(oldById).forEach((blockId) => {
        const block = oldById[blockId];
        if (!block || typeof block !== 'object') {
          return;
        }
        const translatedText = typeof block.translatedText === 'string' ? block.translatedText : '';
        if (!translatedText) {
          return;
        }
        const key = this._blockRescanMatchKey(block);
        if (!translatedByKey[key]) {
          translatedByKey[key] = [];
        }
        translatedByKey[key].push(block);
      });

      const nextById = {};
      scanned.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const blockId = item.blockId || `b${index}`;
        const nextBlock = {
          ...item
        };
        const classified = classifiedById[blockId] && typeof classifiedById[blockId] === 'object'
          ? classifiedById[blockId]
          : null;
        if (classified) {
          nextBlock.category = this._normalizeCategory(classified.category || nextBlock.category || 'unknown');
          nextBlock.classification = this._normalizeClassificationPayload(classified);
        } else {
          nextBlock.category = this._normalizeCategory(nextBlock.category || 'unknown');
          nextBlock.classification = nextBlock.classification && typeof nextBlock.classification === 'object'
            ? this._normalizeClassificationPayload(nextBlock.classification)
            : this._normalizeClassificationPayload({});
        }

        let matched = oldById[blockId] && typeof oldById[blockId] === 'object'
          ? oldById[blockId]
          : null;
        if (!matched || typeof matched.translatedText !== 'string' || !matched.translatedText) {
          const key = this._blockRescanMatchKey(nextBlock);
          const bucket = translatedByKey[key];
          if (Array.isArray(bucket) && bucket.length) {
            matched = bucket.shift();
          }
        }
        if (matched) {
          this._copyBlockPersistentState(nextBlock, matched);
        }
        if (!nextBlock.quality || typeof nextBlock.quality !== 'object') {
          nextBlock.quality = this._defaultBlockQuality();
        }
        nextById[blockId] = nextBlock;
      });
      return nextById;
    }

    _normalizeCategory(category) {
      if (typeof category !== 'string') {
        return 'unknown';
      }
      const raw = category.trim().toLowerCase();
      if (!raw) {
        return 'unknown';
      }
      if (KNOWN_CATEGORIES.includes(raw)) {
        return raw;
      }
      if (Object.prototype.hasOwnProperty.call(LEGACY_CATEGORY_MAP, raw)) {
        return LEGACY_CATEGORY_MAP[raw];
      }
      if (raw.includes('h1') || raw.includes('h2') || raw.includes('h3') || raw.includes('h4') || raw.includes('h5') || raw.includes('h6') || raw.includes('title')) {
        return 'headings';
      }
      if (raw.includes('nav') || raw.includes('menu')) {
        return 'navigation';
      }
      if (raw.includes('btn') || raw.includes('button') || raw.includes('label') || raw.includes('input') || raw.includes('form')) {
        return 'ui_controls';
      }
      if (raw.includes('table') || raw.includes('th') || raw.includes('td') || raw.includes('thead') || raw.includes('tbody')) {
        return 'tables';
      }
      if (raw.includes('code') || raw.includes('pre')) {
        return 'code';
      }
      if (raw.includes('caption') || raw.includes('figcaption')) {
        return 'captions';
      }
      if (raw.includes('footer') || raw.includes('copyright') || raw.includes('meta')) {
        return 'footer';
      }
      if (raw.includes('cookie') || raw.includes('consent') || raw.includes('privacy') || raw.includes('terms') || raw.includes('legal')) {
        return 'legal';
      }
      if (raw.includes('ad') || raw.includes('sponsor') || raw.includes('banner') || raw.includes('promo')) {
        return 'ads';
      }
      if (raw.includes('content') || raw.includes('article') || raw.includes('paragraph') || raw.includes('text') || raw.includes('list') || raw.includes('quote')) {
        return 'main_content';
      }
      return 'unknown';
    }

    _resolveBlockCategory({ blockId, block, classificationByBlockId = null } = {}) {
      const classified = classificationByBlockId && typeof classificationByBlockId === 'object'
        ? classificationByBlockId[blockId]
        : null;
      if (classified && typeof classified === 'object' && typeof classified.category === 'string') {
        return this._normalizeCategory(classified.category);
      }
      return this._normalizeCategory(block && block.category ? block.category : (block && block.pathHint ? block.pathHint : 'unknown'));
    }

    _collectAvailableCategories(blocksById, classificationByBlockId = null) {
      const map = blocksById && typeof blocksById === 'object' ? blocksById : {};
      const seen = new Set();
      const out = [];
      Object.keys(map).forEach((blockId) => {
        const block = map[blockId];
        const category = this._resolveBlockCategory({
          blockId,
          block,
          classificationByBlockId
        });
        if (seen.has(category)) {
          return;
        }
        seen.add(category);
        out.push(category);
      });
      const order = KNOWN_CATEGORIES.slice();
      return out.sort((a, b) => {
        const indexA = order.indexOf(a);
        const indexB = order.indexOf(b);
        return (indexA >= 0 ? indexA : order.length) - (indexB >= 0 ? indexB : order.length);
      });
    }

    _normalizeSelectedCategories(input, availableCategories, fallback) {
      const available = Array.isArray(availableCategories) ? availableCategories : [];
      const availableSet = new Set(available);
      const source = Array.isArray(input) ? input : [];
      const normalizeToAvailable = (value) => {
        const raw = String(value || '').trim();
        if (!raw) {
          return '';
        }
        if (availableSet.has(raw)) {
          return raw;
        }
        const lowered = raw.toLowerCase();
        if (availableSet.has(lowered)) {
          return lowered;
        }
        const normalizedKnown = this._normalizeCategory(raw);
        if (availableSet.has(normalizedKnown)) {
          return normalizedKnown;
        }
        return '';
      };
      const selected = [];
      source.forEach((item) => {
        const category = normalizeToAvailable(item);
        if (!availableSet.has(category) || selected.includes(category)) {
          return;
        }
        selected.push(category);
      });
      if (selected.length) {
        return selected;
      }
      const fallbackSource = Array.isArray(fallback) ? fallback : [];
      fallbackSource.forEach((item) => {
        const category = normalizeToAvailable(item);
        if (!availableSet.has(category) || selected.includes(category)) {
          return;
        }
        selected.push(category);
      });
      if (selected.length) {
        return selected;
      }
      return Array.isArray(fallback) && fallback.length ? [] : available.slice();
    }

    _filterBlockIdsByCategories(blocksById, categories, classificationByBlockId = null) {
      const map = blocksById && typeof blocksById === 'object' ? blocksById : {};
      const selectedSet = new Set(Array.isArray(categories) ? categories : []);
      if (!selectedSet.size) {
        return [];
      }
      return Object.keys(map).filter((blockId) => {
        const block = map[blockId];
        const category = this._resolveBlockCategory({
          blockId,
          block,
          classificationByBlockId
        });
        return selectedSet.has(category);
      });
    }

    _resolveSelectedBlockIds(job, categories, classificationByBlockId = null) {
      const safeJob = job && typeof job === 'object' ? job : {};
      const blocksById = safeJob.blocksById && typeof safeJob.blocksById === 'object'
        ? safeJob.blocksById
        : {};
      const selectedSet = new Set(Array.isArray(categories) ? categories : []);
      if (!selectedSet.size) {
        return [];
      }
      const taxonomy = safeJob.agentState && safeJob.agentState.taxonomy && typeof safeJob.agentState.taxonomy === 'object'
        ? safeJob.agentState.taxonomy
        : null;
      const out = [];
      const seen = new Set();
      const pushBlock = (blockId) => {
        const id = typeof blockId === 'string' ? blockId : '';
        if (!id || seen.has(id) || !blocksById[id]) {
          return;
        }
        seen.add(id);
        out.push(id);
      };
      if (taxonomy) {
        const blockToCategory = taxonomy.blockToCategory && typeof taxonomy.blockToCategory === 'object'
          ? taxonomy.blockToCategory
          : {};
        Object.keys(blockToCategory).forEach((blockId) => {
          const categoryId = String(blockToCategory[blockId] || '').trim().toLowerCase();
          if (!selectedSet.has(categoryId)) {
            return;
          }
          pushBlock(blockId);
        });

        const rangeToCategory = taxonomy.rangeToCategory && typeof taxonomy.rangeToCategory === 'object'
          ? taxonomy.rangeToCategory
          : {};
        const preRangesById = safeJob.pageAnalysis && safeJob.pageAnalysis.preRangesById && typeof safeJob.pageAnalysis.preRangesById === 'object'
          ? safeJob.pageAnalysis.preRangesById
          : {};
        Object.keys(rangeToCategory).forEach((rangeId) => {
          const categoryId = String(rangeToCategory[rangeId] || '').trim().toLowerCase();
          if (!selectedSet.has(categoryId)) {
            return;
          }
          const range = preRangesById[rangeId] && typeof preRangesById[rangeId] === 'object'
            ? preRangesById[rangeId]
            : null;
          const blockIds = range && Array.isArray(range.blockIds) ? range.blockIds : [];
          blockIds.forEach((blockId) => pushBlock(blockId));
        });
      }
      if (!out.length) {
        return this._filterBlockIdsByCategories(blocksById, Array.from(selectedSet), classificationByBlockId);
      }
      return out.sort((left, right) => {
        const a = blocksById[left] && Number.isFinite(Number(blocksById[left].domOrder))
          ? Number(blocksById[left].domOrder)
          : 0;
        const b = blocksById[right] && Number.isFinite(Number(blocksById[right].domOrder))
          ? Number(blocksById[right].domOrder)
          : 0;
        return a - b;
      });
    }

    _resolveCategoryUnit(job, categoryId) {
      const safeJob = job && typeof job === 'object' ? job : {};
      const key = typeof categoryId === 'string' ? categoryId.trim().toLowerCase() : '';
      if (!key) {
        return 'block';
      }
      const pipeline = safeJob.agentState && safeJob.agentState.pipeline && typeof safeJob.agentState.pipeline === 'object'
        ? safeJob.agentState.pipeline
        : null;
      const batching = pipeline && pipeline.batching && typeof pipeline.batching === 'object'
        ? pipeline.batching
        : null;
      const categoryCfg = batching && batching[key] && typeof batching[key] === 'object'
        ? batching[key]
        : null;
      return categoryCfg && categoryCfg.unit === 'range' ? 'range' : 'block';
    }

    _resolveSelectedRangeIds(job, categories) {
      const safeJob = job && typeof job === 'object' ? job : {};
      const selectedSet = new Set(Array.isArray(categories) ? categories : []);
      if (!selectedSet.size) {
        return [];
      }
      const taxonomy = safeJob.agentState && safeJob.agentState.taxonomy && typeof safeJob.agentState.taxonomy === 'object'
        ? safeJob.agentState.taxonomy
        : null;
      if (!taxonomy) {
        return [];
      }
      const rangeToCategory = taxonomy.rangeToCategory && typeof taxonomy.rangeToCategory === 'object'
        ? taxonomy.rangeToCategory
        : {};
      const preRangesById = safeJob.pageAnalysis && safeJob.pageAnalysis.preRangesById && typeof safeJob.pageAnalysis.preRangesById === 'object'
        ? safeJob.pageAnalysis.preRangesById
        : {};
      const out = [];
      Object.keys(rangeToCategory).forEach((rangeId) => {
        const categoryId = String(rangeToCategory[rangeId] || '').trim().toLowerCase();
        if (!selectedSet.has(categoryId)) {
          return;
        }
        if (this._resolveCategoryUnit(safeJob, categoryId) !== 'range') {
          return;
        }
        if (!preRangesById[rangeId] || typeof preRangesById[rangeId] !== 'object') {
          return;
        }
        out.push(rangeId);
      });
      return out.sort((left, right) => {
        const rangeA = preRangesById[left] && typeof preRangesById[left] === 'object' ? preRangesById[left] : {};
        const rangeB = preRangesById[right] && typeof preRangesById[right] === 'object' ? preRangesById[right] : {};
        const a = Number.isFinite(Number(rangeA.domOrderFrom)) ? Number(rangeA.domOrderFrom) : 0;
        const b = Number.isFinite(Number(rangeB.domOrderFrom)) ? Number(rangeB.domOrderFrom) : 0;
        if (a !== b) {
          return a - b;
        }
        return String(left).localeCompare(String(right));
      });
    }

    _resolvePendingRangeIds(job, selectedRangeIds = null) {
      const safeJob = job && typeof job === 'object' ? job : {};
      const preRangesById = safeJob.pageAnalysis && safeJob.pageAnalysis.preRangesById && typeof safeJob.pageAnalysis.preRangesById === 'object'
        ? safeJob.pageAnalysis.preRangesById
        : {};
      const sourceRangeIds = Array.isArray(selectedRangeIds)
        ? selectedRangeIds
        : (Array.isArray(safeJob.selectedRangeIds) ? safeJob.selectedRangeIds : []);
      const out = [];
      sourceRangeIds.forEach((rangeId) => {
        const id = typeof rangeId === 'string' ? rangeId : '';
        if (!id) {
          return;
        }
        const range = preRangesById[id] && typeof preRangesById[id] === 'object'
          ? preRangesById[id]
          : null;
        if (!range) {
          return;
        }
        const blockIds = Array.isArray(range.blockIds) ? range.blockIds : [];
        const hasPendingBlock = blockIds.some((blockId) => {
          const block = safeJob.blocksById && safeJob.blocksById[blockId] ? safeJob.blocksById[blockId] : null;
          const translatedText = block && typeof block.translatedText === 'string' ? block.translatedText : '';
          return !translatedText;
        });
        if (hasPendingBlock) {
          out.push(id);
        }
      });
      return out;
    }

    _recalculateSelectionProgress(job, classificationByBlockId = null) {
      if (!job || typeof job !== 'object') {
        return null;
      }
      const selectedCategories = Array.isArray(job.selectedCategories) ? job.selectedCategories : [];
      if (!selectedCategories.length) {
        return null;
      }
      const selectedBlockIds = this._resolveSelectedBlockIds(job, selectedCategories, classificationByBlockId);
      const selectedRangeIds = this._resolveSelectedRangeIds(job, selectedCategories);
      const selectedSet = new Set(selectedBlockIds);
      const pendingBlockIds = [];
      let completedBlocks = 0;
      selectedBlockIds.forEach((blockId) => {
        const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
        const translatedText = block && typeof block.translatedText === 'string' ? block.translatedText : '';
        if (translatedText) {
          completedBlocks += 1;
        } else {
          pendingBlockIds.push(blockId);
        }
      });
      job.totalBlocks = selectedBlockIds.length;
      job.completedBlocks = completedBlocks;
      job.pendingBlockIds = pendingBlockIds;
      job.selectedRangeIds = selectedRangeIds;
      job.pendingRangeIds = this._resolvePendingRangeIds(job, job.selectedRangeIds);
      job.failedBlockIds = Array.isArray(job.failedBlockIds)
        ? job.failedBlockIds.filter((blockId) => selectedSet.has(blockId))
        : [];
      return {
        selectedBlockIds,
        pendingBlockIds,
        selectedRangeIds: Array.isArray(job.selectedRangeIds) ? job.selectedRangeIds.slice() : [],
        pendingRangeIds: Array.isArray(job.pendingRangeIds) ? job.pendingRangeIds.slice() : [],
        completedBlocks
      };
    }

    _isFullCategorySelection(selectedCategories, availableCategories) {
      const selected = Array.isArray(selectedCategories) ? selectedCategories : [];
      const available = Array.isArray(availableCategories) ? availableCategories : [];
      if (!available.length) {
        return false;
      }
      if (selected.length !== available.length) {
        return false;
      }
      const set = new Set(selected);
      return available.every((category) => set.has(category));
    }

    _mergeCategorySelection({ base, requested, available } = {}) {
      const availableList = Array.isArray(available) ? available : [];
      const availableSet = new Set(availableList);
      const ordered = [];
      const pushUnique = (input) => {
        const list = Array.isArray(input) ? input : [];
        list.forEach((item) => {
          const category = this._normalizeCategory(String(item || ''));
          if (!availableSet.has(category) || ordered.includes(category)) {
            return;
          }
          ordered.push(category);
        });
      };
      pushUnique(base);
      pushUnique(requested);
      return ordered.length ? ordered : [];
    }

    _classificationByBlockId(job) {
      if (!job || !job.classification || typeof job.classification !== 'object') {
        return {};
      }
      return job.classification.byBlockId && typeof job.classification.byBlockId === 'object'
        ? job.classification.byBlockId
        : {};
    }

    _classifierObserveDomChangesEnabled(settings) {
      if (!settings || typeof settings !== 'object') {
        return false;
      }
      if (settings.classifier && typeof settings.classifier === 'object') {
        return settings.classifier.observeDomChanges === true;
      }
      return settings.translationClassifierObserveDomChanges === true;
    }

    _buildScanBudgetPayload(settings) {
      const src = settings && typeof settings === 'object' ? settings : {};
      const perf = src.perf && typeof src.perf === 'object' ? src.perf : src;
      const maxTextNodesPerScan = Number.isFinite(Number(perf.maxTextNodesPerScan))
        ? Math.max(200, Math.min(30000, Math.round(Number(perf.maxTextNodesPerScan))))
        : 5000;
      const yieldEveryNNodes = Number.isFinite(Number(perf.yieldEveryNNodes))
        ? Math.max(80, Math.min(2500, Math.round(Number(perf.yieldEveryNNodes))))
        : 260;
      const abortScanIfOverMs = Number.isFinite(Number(perf.abortScanIfOverMs))
        ? Math.max(0, Math.min(120000, Math.round(Number(perf.abortScanIfOverMs))))
        : 0;
      const degradeOnHeavy = perf.degradeOnHeavy !== false;
      return {
        maxTextNodesPerScan,
        yieldEveryNNodes,
        abortScanIfOverMs,
        degradeOnHeavy
      };
    }

    async classifyBlocksForJob({ job, force = false } = {}) {
      if (!job || !job.id || !Number.isFinite(Number(job.tabId))) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р СњР ВµРЎвЂљ Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘ Р Т‘Р В»РЎРЏ Р С”Р В»Р В°РЎРѓРЎРѓР С‘РЎвЂћР С‘Р С”Р В°РЎвЂ Р С‘Р С‘' } };
      }
      const injected = await this._ensureContentRuntime(job.tabId);
      if (!injected.ok) {
        return injected;
      }
      const protocol = NT.TranslationProtocol || {};
      const settings = await this._readAgentSettings().catch(() => ({}));
      const scanBudget = this._buildScanBudgetPayload(settings);
      const payload = {
        type: protocol.BG_CLASSIFY_BLOCKS,
        jobId: job.id,
        force: Boolean(force),
        classifierObserveDomChanges: this._classifierObserveDomChangesEnabled(settings),
        ...scanBudget
      };
      if (job.contentSessionId) {
        payload.contentSessionId = job.contentSessionId;
      }
      let sent = await this._sendToTab(job.tabId, payload);
      if (sent && sent.ok && sent.response && sent.response.ignored === true && job.contentSessionId) {
        sent = await this._sendToTab(job.tabId, {
          type: protocol.BG_CLASSIFY_BLOCKS,
          jobId: job.id,
          force: Boolean(force),
          classifierObserveDomChanges: this._classifierObserveDomChangesEnabled(settings),
          ...scanBudget
        });
      }
      if (!sent || !sent.ok) {
        return {
          ok: false,
          error: sent && sent.error
            ? sent.error
            : { code: 'CLASSIFY_FAILED', message: 'Р СњР Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ Р С—Р С•Р В»РЎС“РЎвЂЎР С‘РЎвЂљРЎРЉ Р С”Р В»Р В°РЎРѓРЎРѓР С‘РЎвЂћР С‘Р С”Р В°РЎвЂ Р С‘РЎР‹ Р С‘Р В· content-script' }
        };
      }
      const response = sent.response && typeof sent.response === 'object' ? sent.response : {};
      if (response.ok === false) {
        return {
          ok: false,
          error: response.error && typeof response.error === 'object'
            ? response.error
            : { code: 'CLASSIFY_FAILED', message: 'Р С™Р В»Р В°РЎРѓРЎРѓР С‘РЎвЂћР С‘Р С”Р В°РЎвЂ Р С‘РЎРЏ Р Р†Р ВµРЎР‚Р Р…РЎС“Р В»Р В° Р С•РЎв‚¬Р С‘Р В±Р С”РЎС“' }
        };
      }
      let byBlockId = response.byBlockId && typeof response.byBlockId === 'object'
        ? response.byBlockId
        : {};
      const summary = response.summary && typeof response.summary === 'object'
        ? response.summary
        : { countsByCategory: {}, confidenceStats: {} };
      const classifierVersion = typeof response.classifierVersion === 'string' && response.classifierVersion
        ? response.classifierVersion
        : 'dom-classifier/unknown';
      const classifyPerf = response && response.classifyPerf && typeof response.classifyPerf === 'object'
        ? response.classifyPerf
        : null;
      if (classifyPerf && Number.isFinite(Number(classifyPerf.classifyTimeMs))) {
        this._recordPerfJobMetric(job, 'classifyTimeMs', Number(classifyPerf.classifyTimeMs));
      }
      if (classifyPerf && Number.isFinite(Number(classifyPerf.scanTimeMs))) {
        this._recordPerfJobMetric(job, 'scanTimeMs', Number(classifyPerf.scanTimeMs));
      }
      const domHash = typeof response.domHash === 'string' && response.domHash
        ? response.domHash
        : null;
      const previousDomHash = typeof job.domHash === 'string' && job.domHash
        ? job.domHash
        : (job.classification && typeof job.classification.domHash === 'string' && job.classification.domHash
          ? job.classification.domHash
          : null);
      const domHashMismatch = Boolean(
        force !== true
        && previousDomHash
        && domHash
        && previousDomHash !== domHash
      );
      if (domHashMismatch) {
        const preservedClassification = job.classification && typeof job.classification === 'object'
          ? job.classification
          : null;
        job.classificationStale = true;
        if (job.agentState && typeof job.agentState === 'object') {
          job.agentState.classifier = {
            version: preservedClassification && typeof preservedClassification.classifierVersion === 'string'
              ? preservedClassification.classifierVersion
              : classifierVersion,
            domHash: previousDomHash || null,
            stale: true,
            summary: preservedClassification && preservedClassification.summary && typeof preservedClassification.summary === 'object'
              ? preservedClassification.summary
              : {},
            mismatch: true
          };
        }
        await this._saveJob(job);
        return {
          ok: true,
          domHash: previousDomHash || null,
          classifierVersion: preservedClassification && typeof preservedClassification.classifierVersion === 'string'
            ? preservedClassification.classifierVersion
            : classifierVersion,
          summary: preservedClassification && preservedClassification.summary && typeof preservedClassification.summary === 'object'
            ? preservedClassification.summary
            : {},
          byBlockId: preservedClassification && preservedClassification.byBlockId && typeof preservedClassification.byBlockId === 'object'
            ? preservedClassification.byBlockId
            : {},
          classificationStale: true
        };
      }
      const rescannedBlocks = Array.isArray(response.blocks)
        ? this._normalizeBlocks(response.blocks)
        : [];
      const parseFrameBlockId = (value) => {
        const raw = typeof value === 'string' ? value.trim() : '';
        const match = /^f(\d+):(.+)$/.exec(raw);
        if (!match) {
          return null;
        }
        return {
          frameId: Number(match[1]),
          localBlockId: match[2]
        };
      };
      const aliasToCanonicalBlockId = {};
      const registerAlias = (alias, canonical) => {
        const aliasKey = typeof alias === 'string' ? alias.trim() : '';
        const canonicalKey = typeof canonical === 'string' ? canonical.trim() : '';
        if (!aliasKey || !canonicalKey || Object.prototype.hasOwnProperty.call(aliasToCanonicalBlockId, aliasKey)) {
          return;
        }
        aliasToCanonicalBlockId[aliasKey] = canonicalKey;
      };
      const registerCanonicalBlockId = (value) => {
        const canonical = typeof value === 'string' ? value.trim() : '';
        if (!canonical) {
          return;
        }
        registerAlias(canonical, canonical);
        const parsed = parseFrameBlockId(canonical);
        if (parsed && parsed.localBlockId) {
          registerAlias(parsed.localBlockId, canonical);
          return;
        }
        if (!canonical.includes(':')) {
          registerAlias(`f0:${canonical}`, canonical);
        }
      };
      rescannedBlocks.forEach((block) => {
        registerCanonicalBlockId(block && block.blockId ? block.blockId : '');
      });
      const jobBlocksByIdRaw = job.blocksById && typeof job.blocksById === 'object'
        ? job.blocksById
        : {};
      Object.keys(jobBlocksByIdRaw).forEach((blockId) => registerCanonicalBlockId(blockId));
      const canonicalizeBlockId = (value) => {
        const raw = typeof value === 'string' ? value.trim() : '';
        if (!raw) {
          return '';
        }
        if (Object.prototype.hasOwnProperty.call(aliasToCanonicalBlockId, raw)) {
          return aliasToCanonicalBlockId[raw];
        }
        const parsed = parseFrameBlockId(raw);
        if (parsed && parsed.localBlockId && Object.prototype.hasOwnProperty.call(aliasToCanonicalBlockId, parsed.localBlockId)) {
          return aliasToCanonicalBlockId[parsed.localBlockId];
        }
        const prefixed = `f0:${raw}`;
        if (Object.prototype.hasOwnProperty.call(aliasToCanonicalBlockId, prefixed)) {
          return aliasToCanonicalBlockId[prefixed];
        }
        return raw;
      };
      byBlockId = Object.keys(byBlockId).reduce((acc, rawBlockId) => {
        const canonicalBlockId = canonicalizeBlockId(rawBlockId);
        if (!canonicalBlockId) {
          return acc;
        }
        acc[canonicalBlockId] = byBlockId[rawBlockId];
        return acc;
      }, {});
      const rescannedCanonicalBlocks = rescannedBlocks.map((row) => {
        const block = row && typeof row === 'object' ? row : null;
        if (!block || !block.blockId) {
          return block;
        }
        const canonicalBlockId = canonicalizeBlockId(block.blockId);
        if (!canonicalBlockId || canonicalBlockId === block.blockId) {
          return block;
        }
        const parsedCanonical = parseFrameBlockId(canonicalBlockId);
        return {
          ...block,
          blockId: canonicalBlockId,
          localBlockId: parsedCanonical && parsedCanonical.localBlockId
            ? parsedCanonical.localBlockId
            : (block.localBlockId || canonicalBlockId)
        };
      }).filter(Boolean);

      let blocksById = job.blocksById && typeof job.blocksById === 'object' ? job.blocksById : {};
      if (rescannedCanonicalBlocks.length && (force === true || !Object.keys(blocksById).length)) {
        const previousBlocksById = {};
        Object.keys(blocksById).forEach((blockId) => {
          const block = blocksById[blockId];
          previousBlocksById[blockId] = block;
          const canonicalBlockId = canonicalizeBlockId(blockId);
          if (canonicalBlockId && !Object.prototype.hasOwnProperty.call(previousBlocksById, canonicalBlockId)) {
            previousBlocksById[canonicalBlockId] = block;
          }
        });
        blocksById = this._mergeRescannedBlocksWithState({
          previousBlocksById,
          rescannedBlocks: rescannedCanonicalBlocks,
          classificationByBlockId: byBlockId
        });
        job.blocksById = blocksById;
      }
      Object.keys(blocksById).forEach((blockId) => {
        const block = blocksById[blockId];
        const classified = byBlockId[blockId];
        if (!block || !classified || typeof classified !== 'object') {
          return;
        }
        block.category = this._normalizeCategory(classified.category || block.category || 'unknown');
        block.classification = this._normalizeClassificationPayload(classified);
        if (!block.quality || typeof block.quality !== 'object') {
          block.quality = this._defaultBlockQuality();
        }
      });

      job.classification = {
        classifierVersion,
        domHash,
        byBlockId,
        summary,
        ts: Date.now()
      };
      job.classificationStale = response.classificationStale === true || domHashMismatch;
      job.domHash = domHash || job.domHash || null;
      job.availableCategories = this._collectAvailableCategories(blocksById, byBlockId);
      if (job.categorySelectionConfirmed === true) {
        this._recalculateSelectionProgress(job, byBlockId);
      }
      if (job.agentState && typeof job.agentState === 'object') {
        job.agentState.classifier = {
          version: classifierVersion,
          domHash: job.domHash,
          stale: job.classificationStale === true,
          summary,
          mismatch: domHashMismatch
        };
      }
      await this._saveJob(job);
      return {
        ok: true,
        domHash: job.domHash,
        classifierVersion,
        summary,
        byBlockId,
        classificationStale: job.classificationStale === true
      };
    }

    getCategorySummaryForJob(job) {
      if (!job || !job.id) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р СњР ВµРЎвЂљ Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘ Р Т‘Р В»РЎРЏ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–' } };
      }
      const byBlockId = this._classificationByBlockId(job);
      const blocksById = job.blocksById && typeof job.blocksById === 'object' ? job.blocksById : {};
      const buckets = {};
      KNOWN_CATEGORIES.forEach((category) => {
        buckets[category] = {
          key: category,
          count: 0,
          confidenceSum: 0,
          examples: []
        };
      });
      Object.keys(blocksById).forEach((blockId) => {
        const block = blocksById[blockId] || {};
        const classified = byBlockId[blockId] && typeof byBlockId[blockId] === 'object'
          ? byBlockId[blockId]
          : {};
        const category = this._resolveBlockCategory({
          blockId,
          block,
          classificationByBlockId: byBlockId
        });
        const confidence = Number.isFinite(Number(classified.confidence))
          ? Math.max(0, Math.min(1, Number(classified.confidence)))
          : 0;
        const entry = buckets[category] || (buckets[category] = {
          key: category,
          count: 0,
          confidenceSum: 0,
          examples: []
        });
        entry.count += 1;
        entry.confidenceSum += confidence;
        if (entry.examples.length < 3) {
          entry.examples.push({
            blockId,
            preview: this._buildPatchPreview(typeof block.originalText === 'string' ? block.originalText : ''),
            reasons: Array.isArray(classified.reasons) ? classified.reasons.slice(0, 6) : []
          });
        }
      });
      const categories = Object.keys(buckets)
        .map((key) => {
          const row = buckets[key];
          const avg = row.count > 0 ? row.confidenceSum / row.count : 0;
          return {
            key,
            count: row.count,
            avgConfidence: Number(avg.toFixed(3)),
            examples: row.examples.slice(0, 3)
          };
        })
        .filter((row) => row.count > 0)
        .sort((left, right) => {
          const idxA = KNOWN_CATEGORIES.indexOf(left.key);
          const idxB = KNOWN_CATEGORIES.indexOf(right.key);
          return (idxA >= 0 ? idxA : KNOWN_CATEGORIES.length) - (idxB >= 0 ? idxB : KNOWN_CATEGORIES.length);
        });
      return {
        ok: true,
        domHash: job.domHash || (job.classification && job.classification.domHash) || null,
        classificationStale: job.classificationStale === true,
        categories
      };
    }

    async _setSelectedCategories({ job, categories, mode = 'replace', reason = '' } = {}) {
      if (!job || !job.id) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р СњР ВµРЎвЂљ Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘ Р Т‘Р В»РЎРЏ Р Р†РЎвЂ№Р В±Р С•РЎР‚Р В° Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–' } };
      }
      const state = String(job.status || '').toLowerCase();
      const canSelect = state === 'awaiting_categories' || state === 'running' || state === 'done' || state === 'failed';
      if (!canSelect) {
        return {
          ok: false,
          error: {
            code: 'INVALID_JOB_STATE',
            message: `Р вЂ™РЎвЂ№Р В±Р С•РЎР‚ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„– Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р ВµР Р… Р Р† РЎРѓРЎвЂљР В°РЎвЂљРЎС“РЎРѓР Вµ ${job.status || 'unknown'}`
          }
        };
      }

      const classifyResult = await this.classifyBlocksForJob({ job, force: false });
      if (!classifyResult.ok) {
        return classifyResult;
      }
      if (job.classificationStale === true) {
        return {
          ok: false,
          error: {
            code: 'CLASSIFICATION_STALE',
            message: 'Р С™Р В»Р В°РЎРѓРЎРѓР С‘РЎвЂћР С‘Р С”Р В°РЎвЂ Р С‘РЎРЏ РЎС“РЎРѓРЎвЂљР В°РЎР‚Р ВµР В»Р В°. Р вЂ™РЎвЂ№Р С—Р С•Р В»Р Р…Р С‘РЎвЂљР Вµ reclassify(force=true) Р С—Р ВµРЎР‚Р ВµР Т‘ Р Р†РЎвЂ№Р В±Р С•РЎР‚Р С•Р С Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–.'
          },
          stale: true,
          domHash: job.domHash || null
        };
      }

      const validMode = mode === 'add' || mode === 'remove' || mode === 'replace' ? mode : 'replace';
      const classificationByBlockId = this._classificationByBlockId(job);
      const availableCategories = this._collectAvailableCategories(job.blocksById, classificationByBlockId);
      if (!availableCategories.length) {
        return {
          ok: false,
          error: { code: 'NO_AVAILABLE_CATEGORIES', message: 'Р С™Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…РЎвЂ№ Р Т‘Р В»РЎРЏ РЎвЂљР ВµР С”РЎС“РЎвЂ°Р ВµР в„– РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎвЂ№' }
        };
      }

      const existingSelected = this._normalizeSelectedCategories(job.selectedCategories, availableCategories, []);
      const requestedSelected = this._normalizeSelectedCategories(categories, availableCategories, []);
      let selectedCategories = [];
      if (validMode === 'replace') {
        selectedCategories = requestedSelected.slice();
      } else if (validMode === 'add') {
        selectedCategories = this._mergeCategorySelection({
          base: existingSelected,
          requested: requestedSelected,
          available: availableCategories
        });
      } else {
        const removeSet = new Set(requestedSelected);
        selectedCategories = existingSelected.filter((category) => !removeSet.has(category));
      }
      if (!selectedCategories.length) {
        return {
          ok: false,
          error: { code: 'NO_CATEGORIES_SELECTED', message: 'Р вЂ™РЎвЂ№Р В±Р ВµРЎР‚Р С‘РЎвЂљР Вµ РЎвЂ¦Р С•РЎвЂљРЎРЏ Р В±РЎвЂ№ Р С•Р Т‘Р Р…РЎС“ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘РЎР‹' }
        };
      }

      const selectedBlockIds = this._resolveSelectedBlockIds(job, selectedCategories, classificationByBlockId);
      if (!selectedBlockIds.length) {
        return {
          ok: false,
          error: { code: 'NO_BLOCKS_FOR_SELECTED_CATEGORIES', message: 'Р вЂќР В»РЎРЏ Р Р†РЎвЂ№Р В±РЎР‚Р В°Р Р…Р Р…РЎвЂ№РЎвЂ¦ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„– Р Р…Р ВµРЎвЂљ Р В±Р В»Р С•Р С”Р С•Р Р†' }
        };
      }

      const selectedRangeIds = this._resolveSelectedRangeIds(job, selectedCategories);
      const selectedSet = new Set(selectedBlockIds);
      const pendingBlockIds = [];
      let completedBlocks = 0;
      selectedBlockIds.forEach((blockId) => {
        const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
        const translatedText = block && typeof block.translatedText === 'string' ? block.translatedText : '';
        if (translatedText) {
          completedBlocks += 1;
        } else {
          pendingBlockIds.push(blockId);
        }
      });
      const pendingRangeIds = this._resolvePendingRangeIds(job, selectedRangeIds);

      job.availableCategories = availableCategories;
      job.selectedCategories = selectedCategories;
      job.selectedRangeIds = selectedRangeIds;
      job.categorySelectionConfirmed = true;
      job.totalBlocks = selectedBlockIds.length;
      job.completedBlocks = completedBlocks;
      job.pendingBlockIds = pendingBlockIds;
      job.pendingRangeIds = pendingRangeIds;
      job.failedBlockIds = Array.isArray(job.failedBlockIds)
        ? job.failedBlockIds.filter((blockId) => selectedSet.has(blockId))
        : [];
      job.lastError = null;
      job.currentBatchId = null;
      if (job.agentState && typeof job.agentState === 'object') {
        job.agentState.selectedCategories = selectedCategories.slice();
      }

      if (!pendingBlockIds.length) {
        const keepActiveAfterDone = !this._isFullCategorySelection(selectedCategories, availableCategories);
        job.status = 'done';
        job.message = keepActiveAfterDone
          ? 'Р вЂ”Р В°Р С—РЎР‚Р С•РЎв‚¬Р ВµР Р…Р Р…РЎвЂ№Р Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ РЎС“Р В¶Р Вµ Р С—Р ВµРЎР‚Р ВµР Р†Р ВµР Т‘Р ВµР Р…РЎвЂ№. Р СљР С•Р В¶Р Р…Р С• Р Т‘Р С•Р В±Р В°Р Р†Р С‘РЎвЂљРЎРЉ Р Т‘Р С•Р С—Р С•Р В»Р Р…Р С‘РЎвЂљР ВµР В»РЎРЉР Р…РЎвЂ№Р Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘.'
          : 'Р вЂ™РЎвЂ№Р В±РЎР‚Р В°Р Р…Р Р…РЎвЂ№Р Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ РЎС“Р В¶Р Вµ Р С—Р ВµРЎР‚Р ВµР Р†Р ВµР Т‘Р ВµР Р…РЎвЂ№';
        if (this.translationAgent && job.agentState && typeof this.translationAgent.finalizeJob === 'function') {
          this.translationAgent.finalizeJob(job);
        }
        await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
        return {
          ok: true,
          fromCache: false,
          shouldRunExecution: false,
          report: {
            mode: validMode,
            reason: String(reason || '').slice(0, 240),
            selectedCategories,
            pendingCount: 0,
            pendingRangeCount: 0,
            completedBlocks
          }
        };
      }

      job.status = 'running';
      job.message = `Р С™Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ Р С—РЎР‚Р С‘Р СР ВµР Р…Р ВµР Р…РЎвЂ№ (${validMode}): ${selectedCategories.join(', ')}`;
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(job, 'translating', job.message);
      }

      const settings = await this._readAgentSettings();
      let cacheRes = { ok: false, fromCache: false };
      if (settings.translationPageCacheEnabled !== false && !job.forceTranslate) {
        cacheRes = await this._tryApplyCachedJob({ job, settings });
        if (cacheRes && cacheRes.ok && cacheRes.fromCache) {
          const refreshed = this._resolveSelectedBlockIds(job, job.selectedCategories, classificationByBlockId);
          const refreshedSet = new Set(refreshed);
          const refreshedPending = [];
          let refreshedCompleted = 0;
          refreshed.forEach((blockId) => {
            const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
            const translatedText = block && typeof block.translatedText === 'string' ? block.translatedText : '';
            if (translatedText) {
              refreshedCompleted += 1;
            } else {
              refreshedPending.push(blockId);
            }
          });
          job.totalBlocks = refreshed.length;
          job.completedBlocks = refreshedCompleted;
          job.pendingBlockIds = refreshedPending;
          job.pendingRangeIds = this._resolvePendingRangeIds(job, job.selectedRangeIds);
          job.failedBlockIds = Array.isArray(job.failedBlockIds)
            ? job.failedBlockIds.filter((blockId) => refreshedSet.has(blockId))
            : [];
        }
      }

      if (!Array.isArray(job.pendingBlockIds) || !job.pendingBlockIds.length) {
        const keepActiveAfterDone = !this._isFullCategorySelection(job.selectedCategories, job.availableCategories);
        job.status = 'done';
        job.message = keepActiveAfterDone
          ? 'Р С™Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…РЎвЂ№ Р С‘Р В· Р С”РЎРЊРЎв‚¬Р В°. Р СљР С•Р В¶Р Р…Р С• Р Т‘Р С•Р В±Р В°Р Р†Р С‘РЎвЂљРЎРЉ Р Т‘Р С•Р С—Р С•Р В»Р Р…Р С‘РЎвЂљР ВµР В»РЎРЉР Р…РЎвЂ№Р Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘.'
          : 'Р вЂ™РЎвЂ№Р В±РЎР‚Р В°Р Р…Р Р…РЎвЂ№Р Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…РЎвЂ№ Р С‘Р В· Р С”РЎРЊРЎв‚¬Р В°';
        if (this.translationAgent && job.agentState && typeof this.translationAgent.finalizeJob === 'function') {
          this.translationAgent.finalizeJob(job);
        }
        await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
        return {
          ok: true,
          fromCache: Boolean(cacheRes && cacheRes.fromCache),
          shouldRunExecution: false,
          report: {
            mode: validMode,
            reason: String(reason || '').slice(0, 240),
            selectedCategories: job.selectedCategories.slice(),
            pendingCount: 0,
            pendingRangeCount: 0,
            completedBlocks: job.completedBlocks
          }
        };
      }

      await this._saveJob(job, { setActive: true });
      return {
        ok: true,
        fromCache: Boolean(cacheRes && cacheRes.fromCache),
        shouldRunExecution: true,
        report: {
          mode: validMode,
          reason: String(reason || '').slice(0, 240),
          selectedCategories: job.selectedCategories.slice(),
          pendingCount: job.pendingBlockIds.length,
          pendingRangeCount: Array.isArray(job.pendingRangeIds) ? job.pendingRangeIds.length : 0,
          completedBlocks: job.completedBlocks
        }
      };
    }

    _setAgentCategoryRecommendations({ job, recommended, optional, excluded, reasonShort, reasonDetailed } = {}) {
      if (!job || !job.id) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р СњР ВµРЎвЂљ Р В·Р В°Р Т‘Р В°РЎвЂЎР С‘ Р Т‘Р В»РЎРЏ РЎР‚Р ВµР С”Р С•Р СР ВµР Р…Р Т‘Р В°РЎвЂ Р С‘Р в„– Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р в„–' } };
      }
      const normalizeCategoryIds = (list) => {
        const source = Array.isArray(list) ? list : [];
        const out = [];
        source.forEach((value) => {
          const raw = String(value || '').trim();
          if (!raw) {
            return;
          }
          const canonical = raw.toLowerCase();
          if (!/^[a-z0-9_.-]{1,64}$/.test(canonical)) {
            return;
          }
          if (out.includes(canonical)) {
            return;
          }
          out.push(canonical);
        });
        return out;
      };
      const normalizedRecommended = normalizeCategoryIds(recommended);
      const normalizedOptional = normalizeCategoryIds(optional);
      const normalizedExcluded = normalizeCategoryIds(excluded);
      const optionalFiltered = normalizedOptional.filter((item) => !normalizedRecommended.includes(item));
      const excludedFiltered = normalizedExcluded.filter((item) => !normalizedRecommended.includes(item) && !optionalFiltered.includes(item));
      if (!job.agentState || typeof job.agentState !== 'object') {
        job.agentState = {};
      }
      job.agentState.categoryRecommendations = {
        recommended: normalizedRecommended.slice(),
        optional: optionalFiltered.slice(),
        excluded: excludedFiltered.slice(),
        reasonShort: typeof reasonShort === 'string' ? reasonShort.slice(0, 320) : '',
        reasonDetailed: typeof reasonDetailed === 'string' ? reasonDetailed.slice(0, 2000) : '',
        updatedAt: Date.now()
      };
      const availableSet = new Set(Array.isArray(job.availableCategories) ? job.availableCategories : []);
      normalizedRecommended.forEach((item) => availableSet.add(item));
      optionalFiltered.forEach((item) => availableSet.add(item));
      excludedFiltered.forEach((item) => availableSet.add(item));
      job.availableCategories = Array.from(availableSet);
      return {
        ok: true,
        recommended: normalizedRecommended,
        optional: optionalFiltered,
        excluded: excludedFiltered
      };
    }

    _shouldKeepJobActiveForCategoryExtensions(job) {
      if (!job || job.status !== 'done') {
        return false;
      }
      const selected = Array.isArray(job.selectedCategories) ? job.selectedCategories : [];
      const available = Array.isArray(job.availableCategories) ? job.availableCategories : [];
      return available.length > 0 && !this._isFullCategorySelection(selected, available);
    }

    async _prepareAgentJob({ job, blocks, settings } = {}) {
      const safeBlocks = Array.isArray(blocks) ? blocks : [];
      if (!this.translationAgent || typeof this.translationAgent.prepareJob !== 'function') {
        return {
          blocks: safeBlocks,
          selectedCategories: [],
          agentState: null
        };
      }
      try {
        const prepared = await this.translationAgent.prepareJob({
          job,
          blocks: safeBlocks,
          settings
        });
        if (!prepared) {
          return {
            blocks: safeBlocks,
            selectedCategories: [],
            agentState: null
          };
        }
        if (!Array.isArray(prepared.blocks)) {
          prepared.blocks = safeBlocks;
        }
        return prepared;
      } catch (error) {
        this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Р СџР В»Р В°Р Р…Р С‘РЎР‚Р С•Р Р†Р В°Р Р…Р С‘Р Вµ Р В°Р С–Р ВµР Р…РЎвЂљР С•Р С Р Р…Р Вµ РЎС“Р Т‘Р В°Р В»Р С•РЎРѓРЎРЉ; Р С‘РЎРѓР С—Р С•Р В»РЎРЉР В·Р С•Р Р†Р В°Р Р… Р В±Р В°Р В·Р С•Р Р†РЎвЂ№Р в„– Р В±Р В°РЎвЂљРЎвЂЎР С‘Р Р…Р С–', {
          tabId: job && job.tabId !== undefined ? job.tabId : null,
          jobId: job && job.id ? job.id : null,
          message: error && error.message ? error.message : 'Р Р…Р ВµР С‘Р В·Р Р†Р ВµРЎРѓРЎвЂљР Р…Р С•'
        });
        return {
          blocks: safeBlocks,
          selectedCategories: [],
          agentState: null
        };
      }
    }

    async _readAgentSettings() {
      if (!this.settingsStore || typeof this.settingsStore.get !== 'function') {
        return {
          translationAgentModelPolicy: null,
          translationAgentProfile: 'auto',
          translationAgentTools: {},
          translationAgentTuning: {
            autoTuneEnabled: true,
            autoTuneMode: 'auto_apply'
          },
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
          translationClassifierObserveDomChanges: false,
          translationPerfMaxTextNodesPerScan: 5000,
          translationPerfYieldEveryNNodes: 260,
          translationPerfAbortScanIfOverMs: 0,
          translationPerfDegradedScanOnHeavy: true,
          translationCompareDiffThreshold: this.COMPARE_DIFF_THRESHOLD_DEFAULT,
          translationCompareRendering: 'auto',
          schemaVersion: 1,
          userSettings: null,
          effectiveSettings: null,
          reasoning: null,
          caching: null,
          models: null,
          classifier: {
            observeDomChanges: false
          },
          perf: {
            maxTextNodesPerScan: 5000,
            yieldEveryNNodes: 260,
            abortScanIfOverMs: 0,
            degradeOnHeavy: true
          },
          toolConfigEffective: {}
        };
      }
      const resolved = typeof this.settingsStore.getResolvedSettings === 'function'
        ? await this.settingsStore.getResolvedSettings().catch(() => null)
        : null;
      const effective = resolved && resolved.effectiveSettings && typeof resolved.effectiveSettings === 'object'
        ? resolved.effectiveSettings
        : null;
      const settings = await this.settingsStore.get([
        'settingsSchemaVersion',
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
        'translationClassifierObserveDomChanges',
        'translationPerfMaxTextNodesPerScan',
        'translationPerfYieldEveryNNodes',
        'translationPerfAbortScanIfOverMs',
        'translationPerfDegradedScanOnHeavy',
        'translationCompareDiffThreshold',
        'translationCompareRendering',
        'translationModelList'
      ]);
      return {
        translationAgentModelPolicy: settings.translationAgentModelPolicy && typeof settings.translationAgentModelPolicy === 'object'
          ? settings.translationAgentModelPolicy
          : null,
        translationAgentProfile: settings.translationAgentProfile
          || (effective && effective.legacyProjection ? effective.legacyProjection.translationAgentProfile : null)
          || 'auto',
        translationAgentTools: settings.translationAgentTools && typeof settings.translationAgentTools === 'object'
          ? settings.translationAgentTools
          : {},
        translationAgentTuning: settings.translationAgentTuning && typeof settings.translationAgentTuning === 'object'
          ? {
            ...settings.translationAgentTuning,
            autoTuneEnabled: settings.translationAgentTuning.autoTuneEnabled !== false,
            autoTuneMode: settings.translationAgentTuning.autoTuneMode === 'ask_user' ? 'ask_user' : 'auto_apply'
          }
          : {
            autoTuneEnabled: true,
            autoTuneMode: 'auto_apply'
          },
        translationAgentExecutionMode: effective && effective.agent && effective.agent.agentMode === 'legacy'
          ? 'legacy'
          : (settings.translationAgentExecutionMode === 'legacy' ? 'legacy' : 'agent'),
        translationAgentAllowedModels: effective && effective.models
          ? (Array.isArray(effective.models.agentAllowedModels)
            ? effective.models.agentAllowedModels.filter((item, idx, arr) => typeof item === 'string' && item && arr.indexOf(item) === idx)
            : [])
          : (Array.isArray(settings.translationAgentAllowedModels)
            ? settings.translationAgentAllowedModels.filter((item, idx, arr) => typeof item === 'string' && item && arr.indexOf(item) === idx)
            : []),
        translationCategoryMode: settings.translationCategoryMode || 'auto',
        translationCategoryList: Array.isArray(settings.translationCategoryList)
          ? settings.translationCategoryList
          : [],
        translationPageCacheEnabled: settings.translationPageCacheEnabled !== false,
        translationApiCacheEnabled: settings.translationApiCacheEnabled !== false,
        translationClassifierObserveDomChanges: settings.translationClassifierObserveDomChanges === true,
        classifier: {
          observeDomChanges: settings.translationClassifierObserveDomChanges === true
        },
        translationPerfMaxTextNodesPerScan: Number.isFinite(Number(settings.translationPerfMaxTextNodesPerScan))
          ? Math.max(200, Math.min(30000, Math.round(Number(settings.translationPerfMaxTextNodesPerScan))))
          : 5000,
        translationPerfYieldEveryNNodes: Number.isFinite(Number(settings.translationPerfYieldEveryNNodes))
          ? Math.max(80, Math.min(2500, Math.round(Number(settings.translationPerfYieldEveryNNodes))))
          : 260,
        translationPerfAbortScanIfOverMs: Number.isFinite(Number(settings.translationPerfAbortScanIfOverMs))
          ? Math.max(0, Math.min(120000, Math.round(Number(settings.translationPerfAbortScanIfOverMs))))
          : 0,
        translationPerfDegradedScanOnHeavy: settings.translationPerfDegradedScanOnHeavy !== false,
        perf: {
          maxTextNodesPerScan: Number.isFinite(Number(settings.translationPerfMaxTextNodesPerScan))
            ? Math.max(200, Math.min(30000, Math.round(Number(settings.translationPerfMaxTextNodesPerScan))))
            : 5000,
          yieldEveryNNodes: Number.isFinite(Number(settings.translationPerfYieldEveryNNodes))
            ? Math.max(80, Math.min(2500, Math.round(Number(settings.translationPerfYieldEveryNNodes))))
            : 260,
          abortScanIfOverMs: Number.isFinite(Number(settings.translationPerfAbortScanIfOverMs))
            ? Math.max(0, Math.min(120000, Math.round(Number(settings.translationPerfAbortScanIfOverMs))))
            : 0,
          degradeOnHeavy: settings.translationPerfDegradedScanOnHeavy !== false
        },
        translationCompareDiffThreshold: this._normalizeCompareDiffThreshold(settings.translationCompareDiffThreshold),
        translationCompareRendering: this._normalizeCompareRendering(
          (effective && effective.ui && typeof effective.ui === 'object'
            ? effective.ui.compareRendering
            : null)
          || (typeof settings.translationCompareRendering === 'string'
            ? settings.translationCompareRendering
            : 'auto')
        ),
        translationModelList: Array.isArray(settings.translationModelList) ? settings.translationModelList : [],
        translationMemoryEnabled: effective && effective.memory
          ? effective.memory.enabled !== false
          : (settings.translationMemoryEnabled !== false),
        translationMemoryMaxPages: effective && effective.memory && Number.isFinite(Number(effective.memory.maxPages))
          ? Number(effective.memory.maxPages)
          : (Number.isFinite(Number(settings.translationMemoryMaxPages)) ? Number(settings.translationMemoryMaxPages) : 200),
        translationMemoryMaxBlocks: effective && effective.memory && Number.isFinite(Number(effective.memory.maxBlocks))
          ? Number(effective.memory.maxBlocks)
          : (Number.isFinite(Number(settings.translationMemoryMaxBlocks)) ? Number(settings.translationMemoryMaxBlocks) : 5000),
        translationMemoryMaxAgeDays: effective && effective.memory && Number.isFinite(Number(effective.memory.maxAgeDays))
          ? Number(effective.memory.maxAgeDays)
          : (Number.isFinite(Number(settings.translationMemoryMaxAgeDays)) ? Number(settings.translationMemoryMaxAgeDays) : 30),
        translationMemoryGcOnStartup: effective && effective.memory
          ? effective.memory.gcOnStartup !== false
          : (settings.translationMemoryGcOnStartup !== false),
        translationMemoryIgnoredQueryParams: effective && effective.memory && Array.isArray(effective.memory.ignoredQueryParams)
          ? effective.memory.ignoredQueryParams.slice()
          : (Array.isArray(settings.translationMemoryIgnoredQueryParams)
            ? settings.translationMemoryIgnoredQueryParams.slice()
            : ['utm_*', 'fbclid', 'gclid']),
        schemaVersion: resolved && Number.isFinite(Number(resolved.schemaVersion))
          ? Number(resolved.schemaVersion)
          : Number(settings.settingsSchemaVersion || 1),
        userSettings: resolved && resolved.userSettings ? resolved.userSettings : null,
        effectiveSettings: effective,
        reasoning: effective && effective.reasoning ? effective.reasoning : null,
        caching: effective && effective.caching ? effective.caching : null,
        models: effective && effective.models ? effective.models : null,
        toolConfigEffective: effective && effective.agent && effective.agent.toolConfigEffective && typeof effective.agent.toolConfigEffective === 'object'
          ? effective.agent.toolConfigEffective
          : {}
      };
    }

    _ensureJobRunSettings(job, { settings = null } = {}) {
      if (!job || typeof job !== 'object') {
        return null;
      }
      const src = job.runSettings && typeof job.runSettings === 'object'
        ? job.runSettings
        : {};
      const userOverrides = src.userOverrides && typeof src.userOverrides === 'object'
        ? src.userOverrides
        : {};
      const agentOverrides = src.agentOverrides && typeof src.agentOverrides === 'object'
        ? src.agentOverrides
        : {};
      const autoTune = src.autoTune && typeof src.autoTune === 'object'
        ? src.autoTune
        : {};
      const canComputeBase = Boolean(
        this.runSettings
        && typeof this.runSettings.computeBaseEffective === 'function'
        && settings
        && settings.effectiveSettings
      );
      const baseEffective = canComputeBase
        ? this.runSettings.computeBaseEffective({
          globalEffectiveSettings: settings.effectiveSettings,
          jobContext: job
        })
        : null;
      let effective = src.effective && typeof src.effective === 'object'
        ? src.effective
        : {};
      if (baseEffective && this.runSettings && typeof this.runSettings.applyPatch === 'function') {
        const withUser = this.runSettings.applyPatch(baseEffective, userOverrides);
        effective = this.runSettings.applyPatch(withUser, agentOverrides);
      } else if (!src.effective && this.runSettings && typeof this.runSettings.computeBaseEffective === 'function') {
        effective = this.runSettings.computeBaseEffective({
          globalEffectiveSettings: {},
          jobContext: job
        });
      }
      job.runSettings = {
        effective,
        userOverrides,
        agentOverrides,
        autoTune: {
          enabled: this._resolveAutoTuneEnabledFromSettings(settings, autoTune.enabled),
          mode: this._resolveAutoTuneModeFromSettings(settings, autoTune.mode),
          lastProposalId: typeof autoTune.lastProposalId === 'string' ? autoTune.lastProposalId : null,
          proposals: Array.isArray(autoTune.proposals) ? autoTune.proposals.slice(-100) : [],
          decisionLog: Array.isArray(autoTune.decisionLog) ? autoTune.decisionLog.slice(-160) : [],
          lastAppliedTs: Number.isFinite(Number(autoTune.lastAppliedTs)) ? Number(autoTune.lastAppliedTs) : 0,
          antiFlap: autoTune.antiFlap && typeof autoTune.antiFlap === 'object'
            ? autoTune.antiFlap
            : { byKey: {} }
        }
      };
      return job.runSettings;
    }

    _ensureJobProofreadingState(job) {
      if (!job || typeof job !== 'object') {
        return {
          enabled: false,
          mode: 'auto',
          pass: 0,
          pendingBlockIds: [],
          doneBlockIds: [],
          failedBlockIds: [],
          criteria: {
            preferTechnical: false,
            maxBlocksAuto: 120,
            minCharCount: 24,
            requireGlossaryConsistency: false
          },
          lastPlanTs: null,
          lastError: null
        };
      }
      const src = job.proofreading && typeof job.proofreading === 'object'
        ? job.proofreading
        : {};
      const out = {
        enabled: src.enabled === true,
        mode: src.mode === 'manual' ? 'manual' : 'auto',
        pass: Number.isFinite(Number(src.pass)) ? Math.max(0, Math.min(2, Math.round(Number(src.pass)))) : 0,
        pendingBlockIds: Array.isArray(src.pendingBlockIds) ? src.pendingBlockIds.slice() : [],
        doneBlockIds: Array.isArray(src.doneBlockIds) ? src.doneBlockIds.slice() : [],
        failedBlockIds: Array.isArray(src.failedBlockIds) ? src.failedBlockIds.slice() : [],
        criteria: {
          preferTechnical: Boolean(src.criteria && src.criteria.preferTechnical === true),
          maxBlocksAuto: Number.isFinite(Number(src.criteria && src.criteria.maxBlocksAuto))
            ? Math.max(1, Math.min(2000, Math.round(Number(src.criteria.maxBlocksAuto))))
            : 120,
          minCharCount: Number.isFinite(Number(src.criteria && src.criteria.minCharCount))
            ? Math.max(0, Math.min(2000, Math.round(Number(src.criteria.minCharCount))))
            : 24,
          requireGlossaryConsistency: Boolean(src.criteria && src.criteria.requireGlossaryConsistency === true)
        },
        lastPlanTs: Number.isFinite(Number(src.lastPlanTs)) ? Number(src.lastPlanTs) : null,
        lastError: src.lastError && typeof src.lastError === 'object' ? src.lastError : null
      };
      if (out.enabled && out.pass === 0) {
        out.pass = 1;
      }
      job.proofreading = out;
      return out;
    }

    _resolveAutoTuneEnabledFromSettings(settings, fallback) {
      const tuning = settings && settings.translationAgentTuning && typeof settings.translationAgentTuning === 'object'
        ? settings.translationAgentTuning
        : {};
      if (Object.prototype.hasOwnProperty.call(tuning, 'autoTuneEnabled')) {
        return tuning.autoTuneEnabled !== false;
      }
      if (typeof fallback === 'boolean') {
        return fallback;
      }
      return true;
    }

    _resolveAutoTuneModeFromSettings(settings, fallback) {
      const tuning = settings && settings.translationAgentTuning && typeof settings.translationAgentTuning === 'object'
        ? settings.translationAgentTuning
        : {};
      const raw = typeof tuning.autoTuneMode === 'string' ? tuning.autoTuneMode : fallback;
      return raw === 'ask_user' ? 'ask_user' : 'auto_apply';
    }

    _hashTextStable(text) {
      const src = typeof text === 'string' ? text : String(text || '');
      let hash = 2166136261;
      for (let i = 0; i < src.length; i += 1) {
        hash ^= src.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
      return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    async _computeMemoryContext({ job, blocks, settings } = {}) {
      if (!job || !Array.isArray(blocks)) {
        return null;
      }
      const urlNormalizer = NT.UrlNormalizer || null;
      const domSignature = NT.DomSignature || null;
      const ignored = settings && Array.isArray(settings.translationMemoryIgnoredQueryParams)
        ? settings.translationMemoryIgnoredQueryParams
        : ['utm_*', 'fbclid', 'gclid'];
      const normalizedUrl = urlNormalizer && typeof urlNormalizer.normalizeUrl === 'function'
        ? urlNormalizer.normalizeUrl(job.url || '', { ignoredQueryParams: ignored })
        : (job.url || '');
      const domInfo = domSignature && typeof domSignature.buildDomSignature === 'function'
        ? await domSignature.buildDomSignature(blocks).catch(() => null)
        : null;
      const domHash = domInfo && typeof domInfo.domHash === 'string' && domInfo.domHash
        ? domInfo.domHash
        : this._hashTextStable(
          blocks.map((item, idx) => `${idx}|${item.category || ''}|${item.pathHint || ''}|${(item.originalText || '').length}`).join('\n')
        );
      const domSigVersion = domInfo && typeof domInfo.domSigVersion === 'string'
        ? domInfo.domSigVersion
        : 'v1';
      const pageKeySource = `${normalizedUrl}|${String(job.targetLang || 'ru').toLowerCase()}|${domHash}`;
      const pageKey = domSignature && typeof domSignature.hashTextSha256 === 'function'
        ? await domSignature.hashTextSha256(pageKeySource).catch(() => this._hashTextStable(pageKeySource))
        : this._hashTextStable(pageKeySource);

      blocks.forEach((block) => {
        if (!block || typeof block !== 'object') {
          return;
        }
        if (!block.originalHash) {
          block.originalHash = this._hashTextStable(String(block.originalText || '').trim());
        }
      });

      job.memoryContext = {
        normalizedUrl,
        domHash,
        domSigVersion,
        signaturePreview: domInfo && typeof domInfo.signaturePreview === 'string' ? domInfo.signaturePreview : null,
        pageKey,
        updatedAt: Date.now()
      };
      return job.memoryContext;
    }

    _buildBlockMemoryKey(targetLang, originalHash) {
      const lang = typeof targetLang === 'string' && targetLang ? targetLang.toLowerCase() : 'ru';
      const hash = typeof originalHash === 'string' ? originalHash : '';
      return this._hashTextStable(`${lang}|${hash}`);
    }

    _buildPageRecommendedCategories(pageRecord, fallback) {
      const out = [];
      const categories = pageRecord && pageRecord.categories && typeof pageRecord.categories === 'object'
        ? Object.keys(pageRecord.categories)
        : [];
      categories.forEach((value) => {
        const category = this._normalizeCategory(value);
        if (!out.includes(category)) {
          out.push(category);
        }
      });
      if (out.length) {
        return out;
      }
      return Array.isArray(fallback) ? fallback.slice() : [];
    }

    _ensureMemoryAgentState(job, settings, memoryRestore) {
      if (!job) {
        return;
      }
      const now = Date.now();
      const state = job.agentState && typeof job.agentState === 'object'
        ? job.agentState
        : {};
      if (!Array.isArray(state.reports)) {
        state.reports = [];
      }
      if (!Array.isArray(state.toolExecutionTrace)) {
        state.toolExecutionTrace = [];
      }
      if (!Array.isArray(state.toolHistory)) {
        state.toolHistory = [];
      }
      if (!Array.isArray(state.checklist)) {
        state.checklist = this.translationAgent && typeof this.translationAgent._buildInitialChecklist === 'function'
          ? this.translationAgent._buildInitialChecklist()
          : [];
      }
      state.profile = state.profile || (settings && settings.translationAgentProfile ? settings.translationAgentProfile : 'auto');
      state.phase = 'memory_restored';
      state.status = 'ready';
      state.updatedAt = now;
      const restoredCount = memoryRestore && Number.isFinite(Number(memoryRestore.restoredCount))
        ? Number(memoryRestore.restoredCount)
        : 0;
      const report = {
        ts: now,
        type: 'memory',
        title: 'Р вЂ™Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С‘Р Вµ Р С‘Р В· Р С—Р В°Р СРЎРЏРЎвЂљР С‘',
        body: `Р вЂ™Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С• Р В±Р В»Р С•Р С”Р С•Р Р†: ${restoredCount}`,
        meta: {
          matchType: memoryRestore && memoryRestore.matchType ? memoryRestore.matchType : 'unknown',
          pageKey: memoryRestore && memoryRestore.pageKey ? memoryRestore.pageKey : null,
          restoredCount
        }
      };
      state.reports.push(report);
      state.reports = state.reports.slice(-120);
      const traceItem = {
        ts: now,
        tool: 'memory.restore',
        mode: 'forced',
        status: restoredCount > 0 ? 'ok' : 'warn',
        forced: true,
        message: `restored=${restoredCount}`,
        meta: {
          callId: `system:memory_restore:${now}`,
          source: 'system',
          output: `restored=${restoredCount}`,
          args: {
            matchType: memoryRestore && memoryRestore.matchType ? memoryRestore.matchType : 'unknown'
          }
        }
      };
      state.toolExecutionTrace.push(traceItem);
      state.toolExecutionTrace = state.toolExecutionTrace.slice(-320);
      state.toolHistory.push({
        ts: now,
        tool: 'memory.restore',
        mode: 'forced',
        status: restoredCount > 0 ? 'ok' : 'warn',
        message: `restored=${restoredCount}`
      });
      state.toolHistory = state.toolHistory.slice(-140);
      const checklistItem = state.checklist.find((item) => item && item.id === 'memory_restored');
      if (checklistItem) {
        checklistItem.status = restoredCount > 0 ? 'done' : (checklistItem.status || 'pending');
        checklistItem.details = restoredCount > 0 ? `Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С•=${restoredCount}` : checklistItem.details;
        checklistItem.updatedAt = now;
      }
      state.memory = {
        lastRestore: memoryRestore || null,
        context: job.memoryContext || null
      };
      job.agentState = state;
      job.recentDiffItems = Array.isArray(state.recentDiffItems) ? state.recentDiffItems.slice(-20) : (job.recentDiffItems || []);
    }

    async _restoreFromTranslationMemory({ job, blocks, settings, applyToTab = true } = {}) {
      if (!job || !Array.isArray(blocks) || !this.translationMemoryStore) {
        return { ok: false, restoredCount: 0, coverage: 'none', reason: 'memory_store_unavailable' };
      }
      if (settings && settings.translationMemoryEnabled === false) {
        return { ok: false, restoredCount: 0, coverage: 'none', reason: 'memory_disabled' };
      }
      const context = job.memoryContext && typeof job.memoryContext === 'object'
        ? job.memoryContext
        : await this._computeMemoryContext({ job, blocks, settings });
      if (!context || !context.pageKey) {
        return { ok: false, restoredCount: 0, coverage: 'none', reason: 'memory_context_missing' };
      }
      let match = null;
      try {
        match = await this.translationMemoryStore.findBestPage({
          pageKey: context.pageKey,
          normalizedUrl: context.normalizedUrl || '',
          domHash: context.domHash || ''
        });
      } catch (_) {
        match = { page: null, matchType: 'lookup_failed' };
      }
      const page = match && match.page && typeof match.page === 'object' ? match.page : null;
      const restoredItems = [];
      const sourceBlocks = blocks.slice();
      for (let i = 0; i < sourceBlocks.length; i += 1) {
        const block = sourceBlocks[i];
        if (!block || !block.blockId) {
          continue;
        }
        const originalHash = block.originalHash || this._hashTextStable(String(block.originalText || '').trim());
        block.originalHash = originalHash;
        let translatedText = null;
        let restoredQualityTag = null;
        if (page && page.blocks && page.blocks[block.blockId] && typeof page.blocks[block.blockId] === 'object') {
          const record = page.blocks[block.blockId];
          if (record.originalHash && record.originalHash === originalHash && typeof record.translatedText === 'string' && record.translatedText) {
            translatedText = record.translatedText;
            restoredQualityTag = typeof record.qualityTag === 'string' ? record.qualityTag : null;
          }
        }
        if (!translatedText) {
          const blockKey = this._buildBlockMemoryKey(job.targetLang || 'ru', originalHash);
          const blockRecord = await this.translationMemoryStore.getBlock(blockKey).catch(() => null);
          if (blockRecord && typeof blockRecord.translatedText === 'string' && blockRecord.translatedText) {
            translatedText = blockRecord.translatedText;
            restoredQualityTag = typeof blockRecord.qualityTag === 'string' ? blockRecord.qualityTag : null;
            await this.translationMemoryStore.touchBlock(blockKey).catch(() => ({ ok: false }));
          }
        }
        if (!translatedText) {
          continue;
        }
        block.translatedText = translatedText;
        block.quality = block.quality && typeof block.quality === 'object' ? block.quality : {};
        block.quality.tag = restoredQualityTag === 'proofread' || restoredQualityTag === 'literal' || restoredQualityTag === 'styled'
          ? restoredQualityTag
          : 'raw';
        block.quality.lastUpdatedTs = Date.now();
        restoredItems.push({
          blockId: block.blockId,
          text: translatedText
        });
      }
      this._recordPerfMemoryCache(job, {
        lookups: sourceBlocks.length,
        hits: restoredItems.length
      });

      let appliedCount = 0;
      if (applyToTab && restoredItems.length) {
        const applied = await this._applyItemsToTab({
          job,
          items: restoredItems,
          batchPrefix: 'memory_restore'
        });
        if (!applied.ok) {
          restoredItems.forEach((item) => {
            const block = blocks.find((row) => row && row.blockId === item.blockId);
            if (block) {
              block.translatedText = '';
            }
          });
          return {
            ok: false,
            restoredCount: 0,
            coverage: 'none',
            reason: 'memory_apply_failed'
          };
        }
        appliedCount = Number.isFinite(Number(applied.appliedTotal)) ? Number(applied.appliedTotal) : restoredItems.length;
      } else {
        appliedCount = restoredItems.length;
      }

      if (restoredItems.length) {
        this._updateTranslationMemory(job, blocks, restoredItems);
      }
      if (page && page.pageKey) {
        await this.translationMemoryStore.touchPage(page.pageKey).catch(() => ({ ok: false }));
      }
      const recommendedCategories = this._buildPageRecommendedCategories(
        page,
        this._collectAvailableCategories(
          blocks.reduce((acc, block) => {
            if (block && block.blockId) {
              acc[block.blockId] = block;
            }
            return acc;
          }, {})
        )
      );
      const coverage = restoredItems.length >= blocks.length && blocks.length > 0
        ? 'full_page'
        : (restoredItems.length > 0 ? 'partial' : 'none');
      const result = {
        ok: true,
        restoredCount: restoredItems.length,
        appliedCount,
        coverage,
        matchType: match && match.matchType ? match.matchType : 'miss',
        pageKey: page && page.pageKey ? page.pageKey : null,
        recommendedCategories
      };
      if (restoredItems.length) {
        this._recordRuntimeAction(job, {
          tool: 'memory.restore',
          status: 'ok',
          message: 'memory.restore.applied',
          meta: {
            restoredCount: restoredItems.length,
            coverage,
            matchType: result.matchType,
            pageKey: result.pageKey
          }
        });
        this._ensureMemoryAgentState(job, settings, result);
      } else {
        this._recordRuntimeAction(job, {
          tool: 'memory.restore',
          status: 'warn',
          message: 'memory.restore.miss',
          meta: {
            matchType: result.matchType,
            pageKey: result.pageKey
          }
        });
      }
      return result;
    }

    _buildPageSignature(blocks) {
      const list = Array.isArray(blocks) ? blocks : [];
      const src = list
        .map((item) => `${item.originalText || ''}::${item.category || ''}`)
        .join('|');
      let hash = 0;
      for (let i = 0; i < src.length; i += 1) {
        hash = ((hash << 5) - hash) + src.charCodeAt(i);
        hash |= 0;
      }
      return `p${list.length}:${Math.abs(hash)}`;
    }

    async _tryApplyCachedJob({ job, settings } = {}) {
      const miss = (reason) => {
        this._recordRuntimeAction(job, {
          tool: 'cacheManager',
          status: 'warn',
          message: 'cache.restore.miss',
          meta: {
            reason: reason || 'unknown',
            cacheKey: job && job.cacheKey ? job.cacheKey : null
          }
        });
        return { ok: false, fromCache: false };
      };
      const isTerminalNow = async () => {
        try {
          const latest = await this.jobStore.getJob(job.id);
          return Boolean(latest && this._isTerminalStatus(latest.status));
        } catch (_) {
          return false;
        }
      };
      if (!this.pageCacheStore || !job || !job.url || !job.pageSignature) {
        return miss('cache_unavailable');
      }
      const useCache = settings && settings.translationPageCacheEnabled !== false;
      if (!useCache) {
        return miss('cache_disabled');
      }
      if (job.forceTranslate) {
        return miss('force_translate');
      }
      this._recordRuntimeAction(job, {
        tool: 'cacheManager',
        status: 'ok',
        message: 'cache.restore.try',
        meta: {
          cacheKey: job.cacheKey || null,
          pageSignature: job.pageSignature || null,
          categories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : []
        }
      });
      let cacheEntry = null;
      try {
        cacheEntry = await this.pageCacheStore.getEntry({
          url: job.url,
          targetLang: job.targetLang || 'ru'
        });
      } catch (_) {
        return miss('cache_read_failed');
      }
      if (!cacheEntry || cacheEntry.signature !== job.pageSignature) {
        return miss('signature_mismatch_or_missing');
      }

      const selectedBlockIds = this._resolveSelectedBlockIds(job, job.selectedCategories, this._classificationByBlockId(job));
      if (!selectedBlockIds.length) {
        return miss('no_selected_blocks');
      }
      const selectedSet = new Set(selectedBlockIds);
      const selectedBlocks = selectedBlockIds
        .map((id) => (job.blocksById && job.blocksById[id] ? job.blocksById[id] : null))
        .filter(Boolean);

      if (cacheEntry.memoryMap && typeof cacheEntry.memoryMap === 'object') {
        if (!job.translationMemoryBySource || typeof job.translationMemoryBySource !== 'object') {
          job.translationMemoryBySource = {};
        }
        Object.keys(cacheEntry.memoryMap).slice(0, 3000).forEach((key) => {
          if (!key || Object.prototype.hasOwnProperty.call(job.translationMemoryBySource, key)) {
            return;
          }
          const value = cacheEntry.memoryMap[key];
          if (typeof value !== 'string' || !value) {
            return;
          }
          job.translationMemoryBySource[key] = value;
        });
      }

      const cacheItemsById = {};
      const memoryItems = this._buildCachedItemsForBatch(job, { blocks: selectedBlocks });
      memoryItems.forEach((item) => {
        if (!item || !item.blockId || typeof item.text !== 'string') {
          return;
        }
        if (!selectedSet.has(item.blockId)) {
          return;
        }
        cacheItemsById[item.blockId] = item.text;
      });

      if (Array.isArray(cacheEntry.items)) {
        cacheEntry.items.forEach((item) => {
          if (!item || !item.blockId || typeof item.text !== 'string') {
            return;
          }
          if (!selectedSet.has(item.blockId) || Object.prototype.hasOwnProperty.call(cacheItemsById, item.blockId)) {
            return;
          }
          cacheItemsById[item.blockId] = item.text;
        });
      }

      const cacheItems = Object.keys(cacheItemsById).map((blockId) => ({
        blockId,
        text: cacheItemsById[blockId]
      }));
      if (!cacheItems.length) {
        return miss('no_cache_items_for_selection');
      }
      if (await isTerminalNow()) {
        return miss('job_terminal_before_apply');
      }

      const applied = await this._applyItemsToTab({
        job,
        items: cacheItems,
        batchPrefix: 'cache'
      });
      if (!applied.ok) {
        return miss('cache_apply_failed');
      }
      if (await isTerminalNow()) {
        return miss('job_terminal_after_apply');
      }

      cacheItems.forEach((item) => {
        if (job.blocksById && job.blocksById[item.blockId]) {
          job.blocksById[item.blockId].translatedText = item.text;
        }
      });
      this._updateTranslationMemory(job, selectedBlocks, cacheItems);

      let reusedCount = 0;
      let pendingCount = 0;
      selectedBlockIds.forEach((blockId) => {
        const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
        const translatedText = block && typeof block.translatedText === 'string' ? block.translatedText : '';
        if (translatedText) {
          reusedCount += 1;
        } else {
          pendingCount += 1;
        }
      });

      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Р СџР ВµРЎР‚Р ВµР Р†Р С•Р Т‘ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р… Р С‘Р В· Р С”РЎРЊРЎв‚¬Р В°', {
        tabId: job.tabId,
        jobId: job.id,
        blockCount: Number(applied.appliedTotal || 0)
      });
      this._recordRuntimeAction(job, {
        tool: 'cacheManager',
        status: 'ok',
        message: 'cache.restore.applied',
        meta: {
          appliedCount: Number(applied.appliedTotal || 0),
          reusedCount,
          pendingCount,
          categories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
          cacheKey: job.cacheKey || null
        }
      });
      return {
        ok: true,
        appliedCount: Number(applied.appliedTotal || 0),
        reusedCount,
        pendingCount,
        fromCache: true
      };
    }

    async _tryRestoreAwaitingFromPageCache({ job, blocks, settings, message } = {}) {
      if (!this.pageCacheStore || !job || !Array.isArray(blocks) || !blocks.length) {
        return null;
      }
      if (!job.url || !job.targetLang) {
        return null;
      }
      if (settings && settings.translationPageCacheEnabled === false) {
        return null;
      }
      if (job.forceTranslate) {
        return null;
      }

      const pageSignature = this._buildPageSignature(blocks);
      if (!pageSignature) {
        return null;
      }

      let cacheEntry = null;
      try {
        cacheEntry = await this.pageCacheStore.getEntry({
          url: job.url,
          targetLang: job.targetLang || 'ru'
        });
      } catch (_) {
        return null;
      }
      if (!cacheEntry) {
        return null;
      }
      const signatureMatch = cacheEntry.signature === pageSignature;
      const cachedBlockCount = Number.isFinite(Number(cacheEntry.blockCount))
        ? Number(cacheEntry.blockCount)
        : 0;
      const blockCountClose = cachedBlockCount > 0
        ? Math.abs(cachedBlockCount - blocks.length) <= 1
        : false;
      const coverageIsFull = Boolean(cacheEntry && cacheEntry.coverage && cacheEntry.coverage.isFull === true);
      const canUseUrlFallback = !signatureMatch && coverageIsFull && blockCountClose;
      if (!signatureMatch && !canUseUrlFallback) {
        return null;
      }

      const items = Array.isArray(cacheEntry.items)
        ? cacheEntry.items.filter((item) => item && item.blockId && typeof item.text === 'string' && item.text)
        : [];
      if (!items.length) {
        return null;
      }

      const blocksById = {};
      blocks.forEach((item) => {
        if (item && item.blockId) {
          blocksById[item.blockId] = item;
        }
      });
      const itemMap = {};
      items.forEach((item) => {
        if (blocksById[item.blockId] && !Object.prototype.hasOwnProperty.call(itemMap, item.blockId)) {
          itemMap[item.blockId] = item.text;
        }
      });
      const cachedBlockIds = Object.keys(itemMap);
      if (!cachedBlockIds.length) {
        return null;
      }

      const latest = await this.jobStore.getJob(job.id);
      if (!latest || this._isTerminalStatus(latest.status)) {
        return { ok: true, ignored: true };
      }
      if (message && typeof message.contentSessionId === 'string' && message.contentSessionId) {
        latest.contentSessionId = message.contentSessionId;
      }

      const availableCategories = this._collectAvailableCategories(blocksById);
      const coverageCategories = cacheEntry && cacheEntry.coverage && Array.isArray(cacheEntry.coverage.categories)
        ? cacheEntry.coverage.categories
        : [];
      const recommendedCategories = this._normalizeSelectedCategories(
        coverageCategories.length ? coverageCategories : availableCategories,
        availableCategories,
        availableCategories
      );

      latest.scanReceived = true;
      latest.blocksById = blocksById;
      latest.totalBlocks = 0;
      latest.pendingBlockIds = [];
      latest.pendingRangeIds = [];
      latest.failedBlockIds = [];
      latest.completedBlocks = 0;
      latest.status = 'awaiting_categories';
      latest.message = signatureMatch
        ? `Р СњР В°Р в„–Р Т‘Р ВµР Р… Р С”РЎРЊРЎв‚¬ РЎРѓРЎвЂљРЎР‚Р В°Р Р…Р С‘РЎвЂ РЎвЂ№ (${cachedBlockIds.length} Р В±Р В»Р С•Р С”Р С•Р Р†). Р вЂ™РЎвЂ№Р В±Р ВµРЎР‚Р С‘РЎвЂљР Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ Р Т‘Р В»РЎРЏ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С‘РЎРЏ.`
        : `Р СњР В°Р в„–Р Т‘Р ВµР Р… Р С”РЎРЊРЎв‚¬ Р С—Р С• URL (${cachedBlockIds.length} Р В±Р В»Р С•Р С”Р С•Р Р†). Р СџР С•Р Т‘РЎвЂљР Р†Р ВµРЎР‚Р Т‘Р С‘РЎвЂљР Вµ Р С”Р В°РЎвЂљР ВµР С–Р С•РЎР‚Р С‘Р С‘ Р Т‘Р В»РЎРЏ Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С‘РЎРЏ.`;
      latest.pageSignature = pageSignature;
      latest.cacheKey = this.pageCacheStore
        ? this.pageCacheStore.buildKey({ url: latest.url || '', targetLang: latest.targetLang || 'ru' })
        : null;
      latest.availableCategories = availableCategories;
      latest.selectedCategories = recommendedCategories;
      latest.selectedRangeIds = [];
      latest.apiCacheEnabled = settings.translationApiCacheEnabled !== false;
      if (!latest.memoryRestore || typeof latest.memoryRestore !== 'object') {
        latest.memoryRestore = {
          ok: true,
          restoredCount: cachedBlockIds.length,
          appliedCount: 0,
          coverage: cachedBlockIds.length >= blocks.length ? 'full_page' : 'partial',
          matchType: signatureMatch ? 'page_cache_signature' : 'page_cache_url_fallback',
          pageKey: latest.memoryContext && latest.memoryContext.pageKey ? latest.memoryContext.pageKey : null,
          recommendedCategories: recommendedCategories.slice()
        };
      }
      this._recordRuntimeAction(latest, {
        tool: 'cacheManager',
        status: 'ok',
        message: 'cache.awaiting_restore.ready',
        meta: {
          cacheKey: latest.cacheKey || null,
          cachedCount: cachedBlockIds.length,
          signatureMatch,
          categories: recommendedCategories.slice(0, 24)
        }
      });
      if (this.translationAgent && latest.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(latest, 'cache_restore', latest.message);
      }
      await this._saveJob(latest, { setActive: true });
      return {
        ok: true,
        blockCount: blocks.length,
        awaitingCategorySelection: true,
        fromCache: true,
        availableCategories,
        selectedCategories: recommendedCategories
      };
    }

    async _applyItemsToTab({ job, items, batchPrefix } = {}) {
      const safeItems = (Array.isArray(items) ? items : [])
        .filter((item) => item && item.blockId && typeof item.text === 'string');
      if (!job || !job.id || !Number.isFinite(Number(job.tabId))) {
        return { ok: false, appliedTotal: 0 };
      }
      if (!safeItems.length) {
        return { ok: true, appliedTotal: 0 };
      }
      const protocol = NT.TranslationProtocol || {};
      const chunkSize = 40;
      let appliedTotal = 0;
      const compareDiffThreshold = await this._getCompareDiffThreshold({ job });
      const compareRendering = await this._getCompareRendering({ job });
      try {
        for (let offset = 0; offset < safeItems.length; offset += chunkSize) {
          try {
            const latest = await this.jobStore.getJob(job.id);
            if (latest && this._isTerminalStatus(latest.status)) {
              return { ok: false, appliedTotal };
            }
          } catch (_) {
            // best-effort only
          }
          const chunkIndex = Math.floor(offset / chunkSize);
          const batchId = `${job.id}:${batchPrefix || 'restore'}:${chunkIndex}`;
          const chunk = safeItems.slice(offset, offset + chunkSize);
          this._recordRuntimeAction(job, {
            tool: 'pageRuntime',
            status: 'ok',
            message: 'content.apply_batch.sent',
            meta: {
              batchId,
              items: chunk.length,
              blockCount: chunk.length,
              phase: batchPrefix || 'restore'
            }
          });
          const sent = await this._sendToTab(job.tabId, {
            type: protocol.BG_APPLY_BATCH,
            jobId: job.id,
            batchId,
            items: chunk,
            compareDiffThreshold,
            compareRendering,
            contentSessionId: job.contentSessionId || null
          });
          if (!sent.ok) {
            this._recordRuntimeAction(job, {
              tool: 'pageRuntime',
              status: 'error',
              message: 'content.apply_batch.failed',
              meta: {
                batchId,
                phase: batchPrefix || 'restore',
                error: sent && sent.error && sent.error.message ? sent.error.message : 'send_failed'
              }
            });
            return { ok: false, appliedTotal };
          }
          const ack = await this._waitForApplyAck(job.id, batchId, this.APPLY_ACK_TIMEOUT_MS);
          if (!ack.ok) {
            this._recordRuntimeAction(job, {
              tool: 'pageRuntime',
              status: 'error',
              message: 'content.apply_batch.failed',
              meta: {
                batchId,
                phase: batchPrefix || 'restore',
                error: 'ack_failed'
              }
            });
            return { ok: false, appliedTotal };
          }
          this._recordRuntimeAction(job, {
            tool: 'pageRuntime',
            status: 'ok',
            message: 'content.apply_batch.ack',
            meta: {
              batchId,
              appliedCount: Number.isFinite(Number(ack.appliedCount))
                ? Number(ack.appliedCount)
                : 0,
              phase: batchPrefix || 'restore'
            }
          });
          let hasPatchEvents = false;
          chunk.forEach((item) => {
            if (!item || !item.blockId || typeof item.text !== 'string') {
              return;
            }
            const block = job.blocksById && job.blocksById[item.blockId]
              ? job.blocksById[item.blockId]
              : null;
            const prevText = block && typeof block.translatedText === 'string' && block.translatedText
              ? block.translatedText
              : (block && typeof block.originalText === 'string' ? block.originalText : '');
            if (block) {
              block.translatedText = item.text;
            }
            this._queuePatchEvent(job, {
              blockId: item.blockId,
              phase: this._resolvePatchPhase(job, batchPrefix || ''),
              kind: this._resolvePatchKindForBatchPrefix(batchPrefix),
              prev: {
                textHash: this._hashTextStable(prevText),
                textPreview: this._buildPatchPreview(prevText)
              },
              next: {
                textHash: this._hashTextStable(item.text),
                textPreview: this._buildPatchPreview(item.text)
              },
              meta: {
                modelUsed: block && block.modelUsed ? block.modelUsed : null,
                routeUsed: block && block.routeUsed ? block.routeUsed : null,
                responseId: null,
                callId: null
              }
            });
            hasPatchEvents = true;
          });
          if (hasPatchEvents) {
            await this._flushPatchEvents(job.id, {
              forceSave: this._resolvePatchKindForBatchPrefix(batchPrefix) !== 'delta'
            });
          }
          appliedTotal += Number.isFinite(Number(ack.appliedCount))
            ? Number(ack.appliedCount)
            : chunk.length;
        }
        return { ok: true, appliedTotal };
      } catch (error) {
        this._recordRuntimeAction(job, {
          tool: 'pageRuntime',
          status: 'error',
          message: 'content.apply_batch.failed',
          meta: {
            batchPrefix: batchPrefix || 'restore',
            error: error && error.message ? error.message : 'unknown'
          }
        });
        return { ok: false, appliedTotal };
      }
    }

    async _persistJobCache(job) {
      if (!this.pageCacheStore || !job || !job.pageSignature || !job.url) {
        return null;
      }
      if (job.status !== 'done') {
        return null;
      }
      const items = this._toCachedItems(job);
      if (!items.length) {
        return null;
      }
      const settings = await this._readAgentSettings();
      if (settings.translationPageCacheEnabled === false) {
        return null;
      }
      try {
        const stored = await this.pageCacheStore.putEntry({
          url: job.url,
          targetLang: job.targetLang || 'ru',
          signature: job.pageSignature,
          items,
          blockCount: job.totalBlocks || items.length,
          modelSpecs: Array.isArray(settings.translationModelList) ? settings.translationModelList : [],
          profile: job.agentState && job.agentState.profile ? job.agentState.profile : 'auto',
          categoryMode: job.agentState && job.agentState.categoryMode ? job.agentState.categoryMode : 'all',
          categories: Array.isArray(job.selectedCategories) ? job.selectedCategories : [],
          toolMode: job.agentState && job.agentState.toolConfig ? job.agentState.toolConfig : {},
          contextSummary: job.agentState && typeof job.agentState.contextSummary === 'string' ? job.agentState.contextSummary : '',
          memoryMap: job.translationMemoryBySource && typeof job.translationMemoryBySource === 'object'
            ? job.translationMemoryBySource
            : {},
          coverage: {
            categories: Array.isArray(job.selectedCategories) ? job.selectedCategories : [],
            isFull: this._isFullCategorySelection(job.selectedCategories, job.availableCategories)
          }
        });
        if (stored) {
          this._recordRuntimeAction(job, {
            tool: 'cacheManager',
            status: 'ok',
            message: 'cache.persist.ok',
            meta: {
              cacheKey: job.cacheKey || null,
              pageSignature: job.pageSignature || null,
              categories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
              blockCount: items.length
            }
          });
          return stored;
        }
        this._recordRuntimeAction(job, {
          tool: 'cacheManager',
          status: 'warn',
          message: 'cache.persist.failed',
          meta: {
            cacheKey: job.cacheKey || null,
            pageSignature: job.pageSignature || null,
            error: 'empty_cache_entry'
          }
        });
        return null;
      } catch (error) {
        this._recordRuntimeAction(job, {
          tool: 'cacheManager',
          status: 'warn',
          message: 'cache.persist.failed',
          meta: {
            cacheKey: job.cacheKey || null,
            pageSignature: job.pageSignature || null,
            error: error && error.message ? error.message : 'Р С•РЎв‚¬Р С‘Р В±Р С”Р В° РЎРѓР С•РЎвЂ¦РЎР‚Р В°Р Р…Р ВµР Р…Р С‘РЎРЏ Р С”РЎРЊРЎв‚¬Р В°'
          }
        });
        return null;
      }
    }

    _toCachedItems(job) {
      const blocks = job && job.blocksById && typeof job.blocksById === 'object'
        ? Object.keys(job.blocksById).map((key) => job.blocksById[key]).filter(Boolean)
        : [];
      const translated = [];
      blocks.forEach((block) => {
        if (!block || !block.blockId) {
          return;
        }
        const translatedText = typeof block.translatedText === 'string' ? block.translatedText : null;
        if (translatedText && translatedText !== block.originalText) {
          translated.push({
            blockId: block.blockId,
            text: translatedText
          });
        }
      });
      return translated;
    }

    _buildCachedItemsForBatch(job, batch) {
      if (!job || !batch || !Array.isArray(batch.blocks)) {
        return [];
      }
      const memory = job.translationMemoryBySource && typeof job.translationMemoryBySource === 'object'
        ? job.translationMemoryBySource
        : {};
      const out = [];
      batch.blocks.forEach((block) => {
        const sourceText = block && typeof block.originalText === 'string' ? block.originalText.trim() : '';
        if (!sourceText) {
          return;
        }
        const key = this._translationMemoryKey(sourceText, block.category || null, job.targetLang || 'ru');
        if (!Object.prototype.hasOwnProperty.call(memory, key)) {
          return;
        }
        const text = memory[key];
        if (typeof text !== 'string' || !text) {
          return;
        }
        out.push({
          blockId: block.blockId,
          text
        });
      });
      this._recordPerfMemoryCache(job, {
        lookups: batch.blocks.length,
        hits: out.length
      });
      return out;
    }

    _updateTranslationMemory(job, blocks, items) {
      if (!job) {
        return;
      }
      if (!job.translationMemoryBySource || typeof job.translationMemoryBySource !== 'object') {
        job.translationMemoryBySource = {};
      }
      const indexById = {};
      (Array.isArray(blocks) ? blocks : []).forEach((block) => {
        if (!block || !block.blockId) {
          return;
        }
        indexById[block.blockId] = block;
      });

      (Array.isArray(items) ? items : []).forEach((item) => {
        if (!item || !item.blockId || typeof item.text !== 'string') {
          return;
        }
        const block = indexById[item.blockId];
        const sourceText = block && typeof block.originalText === 'string' ? block.originalText.trim() : '';
        if (!sourceText) {
          return;
        }
        const key = this._translationMemoryKey(sourceText, block.category || null, job.targetLang || 'ru');
        job.translationMemoryBySource[key] = item.text;
      });

      const keys = Object.keys(job.translationMemoryBySource);
      if (keys.length > 4000) {
        keys.slice(0, keys.length - 4000).forEach((key) => {
          delete job.translationMemoryBySource[key];
        });
      }
      const upsertPromise = this._upsertPersistentMemoryEntries({ job, blocks, items }).catch(() => {});
      this._trackPendingMemoryUpsert(job.id, upsertPromise);
    }

    async _upsertPersistentMemoryEntries({ job, blocks, items } = {}) {
      if (!this.translationMemoryStore || !job || !Array.isArray(items) || !items.length) {
        return;
      }
      const settings = await this._readAgentSettings().catch(() => null);
      if (settings && settings.translationMemoryEnabled === false) {
        return;
      }
      const sourceBlocks = Array.isArray(blocks) ? blocks : [];
      const byId = {};
      sourceBlocks.forEach((block) => {
        if (block && block.blockId) {
          byId[block.blockId] = block;
        }
      });
      const context = job.memoryContext && typeof job.memoryContext === 'object'
        ? job.memoryContext
        : await this._computeMemoryContext({
          job,
          blocks: sourceBlocks.length
            ? sourceBlocks
            : Object.keys(job.blocksById || {}).map((blockId) => job.blocksById[blockId]).filter(Boolean),
          settings: settings || {}
        });
      if (!context || !context.pageKey) {
        return;
      }
      let pageRecord = await this.translationMemoryStore.getPage(context.pageKey).catch(() => null);
      const expectedPageRev = Number.isFinite(Number(pageRecord && pageRecord.rev))
        ? Number(pageRecord.rev)
        : 0;
      const now = Date.now();
      if (!pageRecord) {
        pageRecord = {
          pageKey: context.pageKey,
          url: context.normalizedUrl || '',
          title: '',
          domHash: context.domHash || '',
          domSigVersion: context.domSigVersion || 'v1',
          createdAt: now,
          updatedAt: now,
          lastUsedAt: now,
          targetLang: job.targetLang || 'ru',
          categories: {},
          blocks: {}
        };
      }
      if (!pageRecord.blocks || typeof pageRecord.blocks !== 'object' || Array.isArray(pageRecord.blocks)) {
        pageRecord.blocks = {};
      }
      if (!pageRecord.categories || typeof pageRecord.categories !== 'object' || Array.isArray(pageRecord.categories)) {
        pageRecord.categories = {};
      }

      for (let i = 0; i < items.length; i += 1) {
        const item = items[i];
        if (!item || !item.blockId || typeof item.text !== 'string') {
          continue;
        }
        const block = byId[item.blockId]
          || (job.blocksById && job.blocksById[item.blockId] ? job.blocksById[item.blockId] : null);
        if (!block) {
          continue;
        }
        const originalHash = block.originalHash || this._hashTextStable(String(block.originalText || '').trim());
        const blockKey = this._buildBlockMemoryKey(job.targetLang || 'ru', originalHash);
        const qualityTag = block.quality && typeof block.quality === 'object'
          && (block.quality.tag === 'proofread' || block.quality.tag === 'literal' || block.quality.tag === 'styled')
          ? block.quality.tag
          : 'raw';
        await this.translationMemoryStore.upsertBlock({
          blockKey,
          originalHash,
          targetLang: job.targetLang || 'ru',
          translatedText: item.text,
          qualityTag,
          modelUsed: block.modelUsed || null,
          routeUsed: block.routeUsed || null,
          sourcePageKeys: [context.pageKey]
        }).catch(() => ({ ok: false }));

        pageRecord.blocks[item.blockId] = {
          originalHash,
          translatedText: item.text,
          qualityTag,
          modelUsed: block.modelUsed || null,
          routeUsed: block.routeUsed || null,
          updatedAt: now
        };
        const category = this._normalizeCategory(block.category || block.pathHint || 'unknown');
        if (!pageRecord.categories[category] || typeof pageRecord.categories[category] !== 'object') {
          pageRecord.categories[category] = {
            translatedBlockIds: [],
            stats: {
              count: 0,
              passCount: 1,
              proofreadCount: 0,
              proofreadCoverage: 0
            },
            doneAt: null
          };
        }
        const categoryEntry = pageRecord.categories[category];
        categoryEntry.translatedBlockIds = Array.isArray(categoryEntry.translatedBlockIds)
          ? categoryEntry.translatedBlockIds
          : [];
        if (!categoryEntry.translatedBlockIds.includes(item.blockId)) {
          categoryEntry.translatedBlockIds.push(item.blockId);
        }
        categoryEntry.stats = categoryEntry.stats && typeof categoryEntry.stats === 'object'
          ? categoryEntry.stats
          : { count: 0, passCount: 1, proofreadCount: 0, proofreadCoverage: 0 };
        categoryEntry.stats.count = categoryEntry.translatedBlockIds.length;
        const proofreadCount = categoryEntry.translatedBlockIds.reduce((acc, id) => {
          const row = pageRecord.blocks && pageRecord.blocks[id] && typeof pageRecord.blocks[id] === 'object'
            ? pageRecord.blocks[id]
            : null;
          const tag = row && typeof row.qualityTag === 'string' ? row.qualityTag : 'raw';
          return acc + (tag === 'proofread' || tag === 'literal' || tag === 'styled' ? 1 : 0);
        }, 0);
        categoryEntry.stats.proofreadCount = proofreadCount;
        categoryEntry.stats.proofreadCoverage = categoryEntry.stats.count > 0
          ? Number((proofreadCount / categoryEntry.stats.count).toFixed(4))
          : 0;
        categoryEntry.doneAt = now;
      }

      pageRecord.updatedAt = now;
      pageRecord.lastUsedAt = now;
      await this.translationMemoryStore.upsertPage(pageRecord, {
        expectedRev: expectedPageRev,
        maxRetries: 3
      }).catch(() => ({ ok: false }));
    }

    _translationMemoryKey(sourceText, category, lang) {
      const src = `${String(lang || 'ru').toLowerCase()}::${String(category || 'unknown').toLowerCase()}::${String(sourceText || '').trim()}`;
      let hash = 0;
      for (let i = 0; i < src.length; i += 1) {
        hash = ((hash << 5) - hash) + src.charCodeAt(i);
        hash |= 0;
      }
      return `m${Math.abs(hash)}`;
    }

    _mergeUnique(base, append) {
      const seen = new Set(Array.isArray(base) ? base : []);
      const out = Array.isArray(base) ? base.slice() : [];
      (Array.isArray(append) ? append : []).forEach((id) => {
        if (!id || seen.has(id)) {
          return;
        }
        seen.add(id);
        out.push(id);
      });
      return out;
    }

    async _isPipelineEnabled() {
      if (!this.settingsStore || typeof this.settingsStore.get !== 'function') {
        return false;
      }
      const settings = await this.settingsStore.get(['translationPipelineEnabled']);
      return Boolean(settings.translationPipelineEnabled);
    }

    async _getLastJobForTab(tabId) {
      const lastJobId = await this.jobStore.getLastJobId(tabId);
      if (!lastJobId) {
        return null;
      }
      return this.jobStore.getJob(lastJobId);
    }

    _emitEvent(level, tag, message, meta) {
      if (!this.eventLogFn) {
        return;
      }
      if (this.eventFactory) {
        const event = level === 'error'
          ? this.eventFactory.error(tag, message, meta)
          : level === 'warn'
            ? this.eventFactory.warn(tag, message, meta)
            : this.eventFactory.info(tag, message, meta);
        this.eventLogFn(event);
        return;
      }
      this.eventLogFn({ level, tag, message, meta });
    }

    async _ensureJobTabReady(job) {
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р С•РЎвЂљРЎРѓРЎС“РЎвЂљРЎРѓРЎвЂљР Р†РЎС“Р ВµРЎвЂљ' } };
      }
      const currentTabId = Number(job.tabId);
      const currentAvailable = await this._isTabAvailable(currentTabId);
      if (currentAvailable) {
        return { ok: true, tabId: currentTabId, recovered: false };
      }

      const recoveredTabId = await this._findReplacementTabId(job.url || '');
      if (!Number.isFinite(recoveredTabId)) {
        return {
          ok: false,
          error: {
            code: 'TAB_UNAVAILABLE_AFTER_RESTART',
            message: 'Р ВРЎРѓРЎвЂ¦Р С•Р Т‘Р Р…Р В°РЎРЏ Р Р†Р С”Р В»Р В°Р Т‘Р С”Р В° Р Р…Р ВµР Т‘Р С•РЎРѓРЎвЂљРЎС“Р С—Р Р…Р В°, Р С‘ Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…Р В° Р В·Р В°Р СР ВµРЎвЂ°Р В°РЎР‹РЎвЂ°Р В°РЎРЏ Р Р†Р С”Р В»Р В°Р Т‘Р С”Р В° РЎРѓ РЎРѓР С•Р Р†Р С—Р В°Р Т‘Р В°РЎР‹РЎвЂ°Р С‘Р С URL'
          }
        };
      }

      await this._rebindJobToTab(job, recoveredTabId);
      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Р вЂ”Р В°Р Т‘Р В°РЎвЂЎР В° Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В° Р Р†Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р В° Р Р† Р В·Р В°Р СР ВµРЎвЂ°Р В°РЎР‹РЎвЂ°Р ВµР в„– Р Р†Р С”Р В»Р В°Р Т‘Р С”Р Вµ Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°', {
        jobId: job.id,
        tabId: recoveredTabId,
        previousTabId: currentTabId
      });
      return { ok: true, tabId: recoveredTabId, recovered: true };
    }

    async _isTabAvailable(tabId) {
      if (!Number.isFinite(Number(tabId))) {
        return false;
      }
      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.get !== 'function') {
        return true;
      }
      return new Promise((resolve) => {
        try {
          this.chromeApi.tabs.get(Number(tabId), (tab) => {
            const runtimeError = this.chromeApi.runtime && this.chromeApi.runtime.lastError
              ? this.chromeApi.runtime.lastError
              : null;
            if (runtimeError || !tab) {
              resolve(false);
              return;
            }
            resolve(true);
          });
        } catch (_) {
          resolve(false);
        }
      });
    }

    async _findReplacementTabId(url) {
      if (!url || !this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.query !== 'function') {
        return null;
      }
      const target = this._normalizeUrlForRecovery(url);
      if (!target) {
        return null;
      }
      try {
        const tabs = await new Promise((resolve) => {
          this.chromeApi.tabs.query({}, (items) => resolve(Array.isArray(items) ? items : []));
        });
        for (const tab of tabs) {
          const candidateId = tab && Number.isFinite(Number(tab.id)) ? Number(tab.id) : null;
          if (candidateId === null) {
            continue;
          }
          const candidateUrl = this._normalizeUrlForRecovery(tab.url || '');
          if (!candidateUrl) {
            continue;
          }
          if (candidateUrl === target) {
            return candidateId;
          }
        }
      } catch (_) {
        return null;
      }
      return null;
    }

    _normalizeUrlForRecovery(url) {
      if (typeof url !== 'string' || !url) {
        return '';
      }
      try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname || '/'}`;
      } catch (_) {
        return url.split('#')[0].split('?')[0];
      }
    }

    async _rebindJobToTab(job, nextTabId) {
      if (!job || !Number.isFinite(Number(nextTabId))) {
        return;
      }
      const nextId = Number(nextTabId);
      const prevId = Number(job.tabId);
      if (Number.isFinite(prevId) && prevId !== nextId && this.jobStore && typeof this.jobStore.clearActiveJob === 'function') {
        await this.jobStore.clearActiveJob(prevId, job.id);
      }
      job.tabId = nextId;
      job.message = 'Р вЂ™Р С•РЎРѓРЎРѓРЎвЂљР В°Р Р…Р С•Р Р†Р В»Р ВµР Р…Р С• Р С—Р С•РЎРѓР В»Р Вµ Р С—Р ВµРЎР‚Р ВµР В·Р В°Р С—РЎС“РЎРѓР С”Р В°; Р С—Р ВµРЎР‚Р ВµР С—Р С•Р Т‘Р С”Р В»РЎР‹РЎвЂЎР В°РЎР‹ runtime Р С—Р ВµРЎР‚Р ВµР Р†Р С•Р Т‘Р В°';
      await this._saveJob(job, { setActive: true });
    }

    _getJobAbortController(jobId) {
      if (!jobId || typeof global.AbortController !== 'function') {
        return null;
      }
      const existing = this.jobAbortControllers.get(jobId);
      if (existing && existing.signal && !existing.signal.aborted) {
        return existing;
      }
      const next = new global.AbortController();
      this.jobAbortControllers.set(jobId, next);
      return next;
    }

    _abortJobRequests(jobId, reason) {
      if (!jobId) {
        return;
      }
      const controller = this.jobAbortControllers.get(jobId);
      if (!controller || !controller.signal || controller.signal.aborted) {
        return;
      }
      try {
        controller.abort(reason || 'TRANSLATION_CANCELLED');
      } catch (_) {
        // no-op
      }
    }

    _dropJobAbortController(jobId) {
      if (!jobId) {
        return;
      }
      this.jobAbortControllers.delete(jobId);
    }

    _clearPendingAckWaiters(jobId) {
      if (!jobId) {
        return;
      }
      const prefix = `${jobId}:`;
      Array.from(this.pendingApplyAcks.keys()).forEach((key) => {
        if (typeof key === 'string' && key.indexOf(prefix) === 0) {
          this.pendingApplyAcks.delete(key);
        }
      });
      Array.from(this.pendingDeltaAcks.keys()).forEach((key) => {
        if (typeof key === 'string' && key.indexOf(prefix) === 0) {
          this.pendingDeltaAcks.delete(key);
        }
      });
      const patchBucket = this.pendingPatchFlushByJob.get(jobId);
      if (patchBucket && patchBucket.timerId) {
        try {
          global.clearTimeout(patchBucket.timerId);
        } catch (_) {
          // best-effort
        }
      }
      this.pendingPatchFlushByJob.delete(jobId);
      this._dropPendingMemoryUpserts(jobId);
    }

    _trackPendingMemoryUpsert(jobId, promise) {
      if (!jobId || !promise || typeof promise.then !== 'function') {
        return;
      }
      let bucket = this.pendingMemoryUpsertsByJob.get(jobId);
      if (!bucket) {
        bucket = new Set();
        this.pendingMemoryUpsertsByJob.set(jobId, bucket);
      }
      bucket.add(promise);
      const detach = () => {
        const current = this.pendingMemoryUpsertsByJob.get(jobId);
        if (!current) {
          return;
        }
        current.delete(promise);
        if (!current.size) {
          this.pendingMemoryUpsertsByJob.delete(jobId);
        }
      };
      promise.then(detach).catch(detach);
    }

    async _waitForPendingMemoryUpserts(jobId, { timeoutMs = 3000 } = {}) {
      if (!jobId) {
        return { ok: true, waited: false, pending: 0 };
      }
      const bucket = this.pendingMemoryUpsertsByJob.get(jobId);
      if (!bucket || !bucket.size) {
        return { ok: true, waited: false, pending: 0 };
      }
      const pending = Array.from(bucket);
      if (!pending.length) {
        return { ok: true, waited: false, pending: 0 };
      }
      const timeout = Number.isFinite(Number(timeoutMs))
        ? Math.max(200, Math.min(10000, Math.round(Number(timeoutMs))))
        : 3000;
      const timeoutResult = await new Promise((resolve) => {
        const timerId = global.setTimeout(() => {
          resolve({ timeout: true });
        }, timeout);
        Promise.allSettled(pending).then(() => {
          try {
            global.clearTimeout(timerId);
          } catch (_) {
            // best-effort
          }
          resolve({ timeout: false });
        }).catch(() => {
          try {
            global.clearTimeout(timerId);
          } catch (_) {
            // best-effort
          }
          resolve({ timeout: false });
        });
      });
      return {
        ok: timeoutResult && timeoutResult.timeout !== true,
        waited: true,
        pending: bucket.size
      };
    }

    _dropPendingMemoryUpserts(jobId) {
      if (!jobId) {
        return;
      }
      this.pendingMemoryUpsertsByJob.delete(jobId);
    }
  }

  NT.TranslationOrchestrator = TranslationOrchestrator;
})(globalThis);
