/**
 * Background orchestration for DOM translation jobs.
 *
 * The orchestrator owns job lifecycle, BG<->CS messaging, and per-tab status
 * synchronization for popup/debug pages.
 */
(function initTranslationOrchestrator(global) {
  const NT = global.NT || (global.NT = {});
  const KNOWN_CATEGORIES = Object.freeze([
    'heading',
    'paragraph',
    'list',
    'button',
    'label',
    'navigation',
    'meta',
    'code',
    'quote',
    'table',
    'other'
  ]);

  class TranslationOrchestrator {
    constructor({
      chromeApi,
      settingsStore,
      tabStateStore,
      jobStore,
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
    }

    isContentMessageType(type) {
      const protocol = NT.TranslationProtocol || null;
      return Boolean(protocol && protocol.isContentToBackground && protocol.isContentToBackground(type));
    }

    async startJob({ tabId, url, targetLang = 'ru', force = false } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Требуется tabId' } };
      }

      if (!(await this._isPipelineEnabled())) {
        return { ok: false, error: { code: 'PIPELINE_DISABLED', message: 'Пайплайн перевода отключён (translationPipelineEnabled=false)' } };
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
        failedBlockIds: [],
        blocksById: {},
        currentBatchId: null,
        lastError: null,
        message: 'Сканирую содержимое страницы',
        attempts: 0,
        scanReceived: false,
        forceTranslate: Boolean(force),
        pageSignature: null,
        cacheKey: null,
        availableCategories: [],
        selectedCategories: [],
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
        proofreadingState: {
          totalPasses: 0,
          completedPasses: 0,
          updatedAt: now
        }
      };

      const settings = await this._readAgentSettings().catch(() => null);
      this._ensureJobRunSettings(job, { settings });
      await this._saveJob(job, { setActive: true });
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_START : 'translation.start', 'Задача перевода запущена', {
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
        compareDiffThreshold: this._normalizeCompareDiffThreshold(job.compareDiffThreshold)
      });

      if (!sent.ok) {
        await this._markFailed(job, {
          code: 'CONTENT_RUNTIME_UNREACHABLE',
          message: sent.error && sent.error.message ? sent.error.message : 'Не удалось запустить контент-рантайм'
        });
        return { ok: false, error: { code: 'CONTENT_RUNTIME_UNREACHABLE', message: 'Не удалось запустить контент-рантайм' } };
      }

      return { ok: true, job: this._toJobSummary(job) };
    }

    async cancelJob({ tabId, reason = 'USER_CANCELLED' } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Требуется tabId' } };
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
        job.message = 'Отменено: заменено новой задачей';
      } else if (reason === 'TAB_CLOSED') {
        job.message = 'Отменено: вкладка закрыта';
      } else if (reason === 'USER_CLEAR') {
        job.message = 'Отменено: очистка данных перевода';
      } else {
        job.message = 'Отменено пользователем';
      }
      job.lastError = (reason === 'REPLACED_BY_NEW_JOB' || reason === 'TAB_CLOSED')
        ? null
        : { code: reason, message: 'Перевод отменён' };
      job.currentBatchId = null;

      await this._saveJob(job, { clearActive: true });

      const protocol = NT.TranslationProtocol || {};
      await this._sendToTab(numericTabId, { type: protocol.BG_CANCEL_JOB, jobId: job.id });
      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Задача перевода отменена', {
        tabId: numericTabId,
        jobId: job.id,
        reason
      });

      return { ok: true, cancelled: true, job: this._toJobSummary(job) };
    }

    async applyCategorySelection({ tabId, categories, jobId = null } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Требуется tabId' } };
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
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Нет задачи для применения категорий' } };
      }
      if (jobId && job.id !== jobId) {
        return { ok: false, error: { code: 'JOB_MISMATCH', message: 'Несовпадение jobId при выборе категорий' } };
      }
      const canExtendFromDone = job.status === 'done' && this._shouldKeepJobActiveForCategoryExtensions(job);
      if (job.status !== 'awaiting_categories' && !canExtendFromDone) {
        return {
          ok: false,
          error: {
            code: 'INVALID_JOB_STATE',
            message: `Выбор категорий доступен только в awaiting_categories или расширяемом done (текущий=${job.status || 'unknown'})`
          }
        };
      }

      const availableCategories = this._collectAvailableCategories(job.blocksById);
      let selectedCategories = this._normalizeSelectedCategories(categories, availableCategories, job.selectedCategories);
      if (canExtendFromDone) {
        selectedCategories = this._mergeCategorySelection({
          base: job.selectedCategories,
          requested: selectedCategories,
          available: availableCategories
        });
      }
      if (!selectedCategories.length) {
        return { ok: false, error: { code: 'NO_CATEGORIES_SELECTED', message: 'Выберите хотя бы одну категорию' } };
      }

      const selectedBlockIds = this._filterBlockIdsByCategories(job.blocksById, selectedCategories);
      if (!selectedBlockIds.length) {
        return { ok: false, error: { code: 'NO_BLOCKS_FOR_SELECTED_CATEGORIES', message: 'Нет блоков для выбранных категорий' } };
      }

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

      job.availableCategories = availableCategories;
      job.selectedCategories = selectedCategories;
      job.categorySelectionConfirmed = true;
      job.totalBlocks = selectedBlockIds.length;
      job.completedBlocks = completedBlocks;
      job.pendingBlockIds = pendingBlockIds;
      job.failedBlockIds = Array.isArray(job.failedBlockIds)
        ? job.failedBlockIds.filter((id) => selectedBlockIds.includes(id))
        : [];
      job.lastError = null;
      job.currentBatchId = null;
      job.proofreadingState = {
        totalPasses: this._resolvePlannedProofreadingPasses(job),
        completedPasses: 0,
        updatedAt: Date.now()
      };
      if (job.agentState && typeof job.agentState === 'object') {
        job.agentState.selectedCategories = selectedCategories.slice();
      }
      const fullCategorySelection = this._isFullCategorySelection(selectedCategories, availableCategories);
      const keepActiveAfterDone = !fullCategorySelection;

      if (!pendingBlockIds.length) {
        job.status = 'done';
        job.message = keepActiveAfterDone
          ? 'Запрошенные категории уже переведены. Можно выбрать дополнительные категории.'
          : 'Выбранные категории уже переведены';
        if (this.translationAgent && job.agentState && typeof this.translationAgent.finalizeJob === 'function') {
          this.translationAgent.finalizeJob(job);
        }
        await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
        return { ok: true, job: this._toJobSummary(job), reused: true, canSelectMore: keepActiveAfterDone };
      }

      job.status = 'running';
      job.message = `Выбор категорий применён: ${selectedCategories.join(', ')}`;
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(job, 'translating', job.message);
      }

      const settings = await this._readAgentSettings();
      let cacheRes = { ok: false, fromCache: false };
      if (settings.translationPageCacheEnabled !== false && !job.forceTranslate) {
        cacheRes = await this._tryApplyCachedJob({ job, settings });
        if (cacheRes && cacheRes.ok && cacheRes.fromCache) {
          const refreshedSelectedBlockIds = this._filterBlockIdsByCategories(job.blocksById, job.selectedCategories);
          const refreshedPending = [];
          let refreshedCompleted = 0;
          refreshedSelectedBlockIds.forEach((blockId) => {
            const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
            const translatedText = block && typeof block.translatedText === 'string' ? block.translatedText : '';
            if (translatedText) {
              refreshedCompleted += 1;
            } else {
              refreshedPending.push(blockId);
            }
          });
          job.totalBlocks = refreshedSelectedBlockIds.length;
          job.completedBlocks = refreshedCompleted;
          job.pendingBlockIds = refreshedPending;
          job.failedBlockIds = Array.isArray(job.failedBlockIds)
            ? job.failedBlockIds.filter((id) => refreshedSelectedBlockIds.includes(id))
            : [];
          if (!refreshedPending.length) {
            const nowFullSelection = this._isFullCategorySelection(job.selectedCategories, job.availableCategories);
            const nowKeepActive = !nowFullSelection;
            job.status = 'done';
            job.message = nowFullSelection
              ? 'Выбранные категории восстановлены из кэша'
              : 'Восстановлено из кэша для выбранных категорий. Можно добавить ещё категории.';
            if (this.translationAgent && job.agentState && typeof this.translationAgent.finalizeJob === 'function') {
              this.translationAgent.finalizeJob(job);
            }
            await this._saveJob(job, nowKeepActive ? { setActive: true } : { clearActive: true });
            return { ok: true, job: this._toJobSummary(job), fromCache: true, canSelectMore: nowKeepActive };
          }
          job.message = 'Частично восстановлено из кэша; продолжаю перевод';
          if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
            this.translationAgent.markPhase(job, 'cache_restore', job.message);
          }
        }
      }

      await this._saveJob(job, { setActive: true });
      this._processJob(job.id).catch(() => {});
      return { ok: true, job: this._toJobSummary(job), fromCache: Boolean(cacheRes && cacheRes.fromCache) };
    }

    async clearJobData({ tabId, includeCache = true } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Требуется tabId' } };
      }

      const activeJob = await this.jobStore.getActiveJob(numericTabId);
      if (activeJob && (activeJob.status === 'preparing' || activeJob.status === 'awaiting_categories' || activeJob.status === 'running' || activeJob.status === 'completing')) {
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
          message: 'Данные перевода очищены',
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

      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Данные перевода очищены', {
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
        return { ok: false, error: { code: 'MEMORY_STORE_UNAVAILABLE', message: 'Хранилище памяти перевода недоступно' } };
      }
      const mode = scope === 'all' ? 'all' : 'page';
      if (mode === 'all') {
        await this.translationMemoryStore.clearAll().catch(() => ({ ok: false }));
        this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Память перевода полностью очищена', {
          scope: 'all'
        });
        return { ok: true, scope: 'all', removed: true };
      }
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Требуется tabId для очистки памяти страницы' } };
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
        return { ok: false, error: { code: 'INVALID_PROPOSAL_ID', message: 'Требуется proposalId' } };
      }
      const job = await this._resolveJobForAutoTuneAction({ tabId, jobId });
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Задача для применения авто-настройки не найдена' } };
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
        return { ok: false, error: { code: 'INVALID_PROPOSAL_ID', message: 'Требуется proposalId' } };
      }
      const job = await this._resolveJobForAutoTuneAction({ tabId, jobId });
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Задача для отклонения авто-настройки не найдена' } };
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
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Задача для сброса авто-настроек не найдена' } };
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
        title: 'Авто-настройки для задачи сброшены',
        body: diff.changedKeys.length ? `Сброшено параметров: ${diff.changedKeys.length}` : 'Изменений не было',
        meta: { changedKeys: diff.changedKeys.slice(0, 24) }
      });
      job.agentState.reports = job.agentState.reports.slice(-120);
      await this._saveJob(job, this._isTerminalStatus(job.status) ? { clearActive: true } : { setActive: true });
      return { ok: true, job: this._toJobSummary(job), changedKeys: diff.changedKeys || [] };
    }

    async setVisibility({ tabId, visible, mode } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Требуется tabId' } };
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
      await this._sendToTab(numericTabId, {
        type: protocol.BG_SET_VISIBILITY,
        visible: displayMode !== 'original',
        mode: displayMode,
        compareDiffThreshold,
        ...(contentSessionId ? { contentSessionId } : {})
      });
      if (this.tabStateStore && typeof this.tabStateStore.upsertDisplayMode === 'function') {
        await this.tabStateStore.upsertDisplayMode(numericTabId, displayMode);
      } else if (this.tabStateStore && typeof this.tabStateStore.upsertVisibility === 'function') {
        await this.tabStateStore.upsertVisibility(numericTabId, displayMode !== 'original');
      }
      if (activeJob && activeJob.id) {
        activeJob.displayMode = displayMode;
        activeJob.compareDiffThreshold = compareDiffThreshold;
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
      return { ok: true, mode: displayMode, visible: displayMode !== 'original', compareDiffThreshold };
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
      try {
        await this._sendToTab(tabId, {
          type: protocol.BG_SET_VISIBILITY,
          visible,
          mode,
          compareDiffThreshold,
          ...(contentSessionId ? { contentSessionId } : {})
        });
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
        }
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
        return { ok: true };
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
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'Требуется tabId' } };
      }

      const sourceJob = jobId
        ? await this.jobStore.getJob(jobId)
        : await this._getLastJobForTab(numericTabId);
      if (!sourceJob) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Задача для повтора не найдена' } };
      }
      if (!Array.isArray(sourceJob.failedBlockIds) || !sourceJob.failedBlockIds.length) {
        return { ok: false, error: { code: 'NO_FAILED_BLOCKS', message: 'Нет ошибочных блоков для повторной попытки' } };
      }

      const pendingBlockIds = sourceJob.failedBlockIds.slice();
      sourceJob.failedBlockIds = [];
      sourceJob.pendingBlockIds = pendingBlockIds;
      sourceJob.status = 'running';
      sourceJob.message = 'Повторяю ошибочные блоки';
      sourceJob.lastError = null;
      sourceJob.currentBatchId = null;

      await this._saveJob(sourceJob, { setActive: true });
      await this._ensureContentRuntime(numericTabId);
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Повторно запускаю перевод ошибочных блоков', {
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
              message: 'Задача слишком старая для восстановления после перезапуска'
            });
            continue;
          }
          job.status = 'preparing';
          job.message = 'Восстановление после перезапуска; пересканирую страницу';
          job.scanReceived = false;
          job.currentBatchId = null;
          await this._saveJob(job, { setActive: true });
        }
        const tabReady = await this._ensureJobTabReady(job);
        if (!tabReady.ok) {
          await this._markFailed(job, tabReady.error || {
            code: 'TAB_UNAVAILABLE_AFTER_RESTART',
            message: 'Вкладка недоступна после перезапуска; продолжить задачу перевода нельзя'
          });
          continue;
        }
        if (job.status === 'preparing' || job.status === 'awaiting_categories') {
          const injected = await this._ensureContentRuntime(job.tabId);
          if (!injected.ok) {
            await this._markFailed(job, {
              code: injected.error && injected.error.code ? injected.error.code : 'INJECT_FAILED',
              message: injected.error && injected.error.message ? injected.error.message : 'Не удалось повторно внедрить контент-рантайм после перезапуска'
            });
            continue;
          }
          await this._syncVisibilityToContent(job.tabId, {
            contentSessionId: job.contentSessionId || null,
            job
          }).catch(() => {});
          job.compareDiffThreshold = await this._getCompareDiffThreshold({ job });
          const protocol = NT.TranslationProtocol || {};
          const sent = await this._sendToTab(job.tabId, {
            type: protocol.BG_START_JOB,
            jobId: job.id,
            targetLang: job.targetLang || 'ru',
            mode: this._normalizeDisplayMode(job.displayMode, true),
            compareDiffThreshold: this._normalizeCompareDiffThreshold(job.compareDiffThreshold)
          });
          if (!sent.ok) {
            await this._markFailed(job, {
              code: 'CONTENT_RUNTIME_UNREACHABLE',
              message: sent.error && sent.error.message ? sent.error.message : 'Не удалось возобновить подготовку задачи после перезапуска'
            });
            continue;
          }
          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Задача перевода восстановлена после перезапуска', {
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
              message: injected.error && injected.error.message ? injected.error.message : 'Не удалось восстановить контент-рантайм для выполняемой задачи'
            });
            continue;
          }
          await this._syncVisibilityToContent(job.tabId, {
            contentSessionId: job.contentSessionId || null,
            job
          }).catch(() => {});
          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Возобновляю выполнявшуюся задачу перевода после перезапуска', {
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
        return { ok: false, error: { code: 'INVALID_CONTENT_MESSAGE', message: 'Отсутствует тип сообщения' } };
      }

      if (type === protocol.CS_READY) {
        if (tabId !== null) {
          this._updateContentCapabilities(tabId, contentCaps);
        }
        if (tabId !== null) {
          const active = await this.jobStore.getActiveJob(tabId);
          if (active && (active.status === 'preparing' || active.status === 'running' || active.status === 'completing' || active.status === 'awaiting_categories')) {
            if (msg && typeof msg.contentSessionId === 'string' && msg.contentSessionId) {
              active.contentSessionId = msg.contentSessionId;
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
            active.message = 'Контент-скрипт переподключён; пересканирую страницу';
            active.scanReceived = false;
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
                reconnectCount: active.reconnectCount
              }
            });
            await this._saveJob(active, { setActive: true });
            const sessionId = (msg && typeof msg.contentSessionId === 'string' && msg.contentSessionId)
              ? msg.contentSessionId
              : (active.contentSessionId || null);
            active.compareDiffThreshold = await this._getCompareDiffThreshold({ job: active });
            await this._syncVisibilityToContent(tabId, { contentSessionId: sessionId, job: active }).catch(() => {});
            await this._sendToTab(tabId, {
              type: protocol.BG_START_JOB,
              jobId: active.id,
              targetLang: active.targetLang || 'ru',
              mode: this._normalizeDisplayMode(active.displayMode, true),
              compareDiffThreshold: this._normalizeCompareDiffThreshold(active.compareDiffThreshold),
              ...(sessionId ? { contentSessionId: sessionId } : {})
            });
            this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Контент-скрипт переподключён, задача возобновлена', {
              tabId,
              jobId: active.id
            });
          }
        }
        return { ok: true };
      }
      if (type === protocol.CS_HELLO_CAPS) {
        if (tabId !== null) {
          this._updateContentCapabilities(tabId, contentCaps);
        }
        const runtimeCaps = this._buildRuntimeCapabilities(tabId);
        return {
          ok: true,
          tabId,
          contentCaps: tabId !== null ? (this.contentCapsByTab[String(tabId)] || null) : null,
          serverCaps: runtimeCaps && typeof runtimeCaps === 'object' ? runtimeCaps : {},
          toolsetWanted: meta && meta.toolsetWanted && typeof meta.toolsetWanted === 'object'
            ? meta.toolsetWanted
            : null
        };
      }
      if (type === protocol.CS_SCAN_RESULT) {
        return this._handleScanResult({ message: msg, tabId });
      }
      if (type === protocol.CS_APPLY_ACK) {
        return this._handleApplyAck({ message: msg, tabId });
      }
      if (type === protocol.CS_APPLY_DELTA_ACK) {
        return this._handleApplyDeltaAck({ message: msg, tabId });
      }
      return { ok: false, error: { code: 'UNKNOWN_CONTENT_MESSAGE', message: `Неподдерживаемый тип сообщения: ${type}` } };
    }

    _updateContentCapabilities(tabId, caps) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return;
      }
      const source = caps && typeof caps === 'object' ? caps : {};
      const normalized = {
        domIndexerVersion: typeof source.domIndexerVersion === 'string' ? source.domIndexerVersion : 'v1',
        supportsApplyDelta: source.supportsApplyDelta !== false,
        supportsRestoreOriginal: source.supportsRestoreOriginal !== false,
        maxDomWritesPerSecondHint: Number.isFinite(Number(source.maxDomWritesPerSecondHint))
          ? Math.max(1, Math.round(Number(source.maxDomWritesPerSecondHint)))
          : 24,
        selectorStability: source.selectorStability === 'high' || source.selectorStability === 'low'
          ? source.selectorStability
          : 'medium',
        updatedAt: Date.now()
      };
      this.contentCapsByTab[String(numericTabId)] = normalized;
      if (this.onCapabilitiesChanged) {
        this.onCapabilitiesChanged({
          source: 'content',
          tabId: numericTabId,
          contentCaps: normalized
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

    async _handleScanResult({ message, tabId }) {
      const jobId = message && message.jobId ? message.jobId : null;
      if (!jobId) {
        return { ok: false, error: { code: 'INVALID_SCAN_RESULT', message: 'Требуется jobId' } };
      }
      const job = await this.jobStore.getJob(jobId);
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: `Задача не найдена: ${jobId}` } };
      }
      if (tabId !== null && job.tabId !== tabId) {
        return { ok: false, error: { code: 'TAB_MISMATCH', message: 'Несовпадение вкладки в результате сканирования' } };
      }
      if (message && typeof message.contentSessionId === 'string' && message.contentSessionId) {
        job.contentSessionId = message.contentSessionId;
      }
      if (this._isTerminalStatus(job.status)) {
        return { ok: true, ignored: true };
      }

      const normalized = this._normalizeBlocks(message.blocks);
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
      if (
        memoryRestore
        && memoryRestore.ok
        && memoryRestore.coverage === 'full_page'
        && memoryRestore.matchType === 'exact_page_key'
        && !resumeCandidate
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
        latest.failedBlockIds = [];
        latest.completedBlocks = 0;
        latest.status = 'awaiting_categories';
        latest.message = `Восстановлено из памяти: ${memoryRestore.restoredCount} блоков. Выберите категории.`;
        latest.pageSignature = this._buildPageSignature(normalized);
        latest.cacheKey = this.pageCacheStore
          ? this.pageCacheStore.buildKey({ url: latest.url || '', targetLang: latest.targetLang || 'ru' })
          : null;
        latest.availableCategories = availableCategories;
        latest.selectedCategories = recommendedCategories;
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
      if (prepared && prepared.fatalPlanningError) {
        await this._markFailed(job, {
          code: prepared.fatalPlanningError.code || 'AGENT_LOOP_GUARD_STOP',
          message: prepared.fatalPlanningError.message || 'Планирование остановлено safety-guard'
        });
        return {
          ok: false,
          error: {
            code: prepared.fatalPlanningError.code || 'AGENT_LOOP_GUARD_STOP',
            message: prepared.fatalPlanningError.message || 'Планирование остановлено safety-guard'
          }
        };
      }
      let latest = null;
      try {
        latest = await this.jobStore.getJob(job.id);
      } catch (_) {
        latest = null;
      }
      if (!latest) {
        return { ok: true, ignored: true };
      }
      if (this._isTerminalStatus(latest.status)) {
        return { ok: true, ignored: true };
      }
      if (latest.tabId !== job.tabId) {
        return { ok: true, ignored: true };
      }
      if (message && typeof message.contentSessionId === 'string' && message.contentSessionId) {
        latest.contentSessionId = message.contentSessionId;
      }
      const effectiveBlocks = normalized.slice();
      const blocksById = {};
      effectiveBlocks.forEach((item) => {
        blocksById[item.blockId] = item;
      });
      const availableCategories = this._collectAvailableCategories(blocksById);
      const recommendedCategories = this._normalizeSelectedCategories(
        prepared && Array.isArray(prepared.selectedCategories) ? prepared.selectedCategories : [],
        availableCategories,
        availableCategories
      );

      latest.scanReceived = true;
      latest.blocksById = blocksById;
      latest.totalBlocks = 0;
      latest.pendingBlockIds = [];
      latest.failedBlockIds = [];
      latest.completedBlocks = 0;
      latest.status = effectiveBlocks.length ? 'awaiting_categories' : 'done';
      latest.message = effectiveBlocks.length
        ? `Планирование завершено (${effectiveBlocks.length} блоков). Выберите категории для перевода.`
        : 'Переводимых блоков не найдено';
      latest.pageSignature = this._buildPageSignature(effectiveBlocks);
      latest.cacheKey = this.pageCacheStore
        ? this.pageCacheStore.buildKey({ url: latest.url || '', targetLang: latest.targetLang || 'ru' })
        : null;
      latest.availableCategories = availableCategories;
      latest.selectedCategories = recommendedCategories;
      latest.agentState = prepared && prepared.agentState ? prepared.agentState : null;
      latest.apiCacheEnabled = settings.translationApiCacheEnabled !== false;
      latest.proofreadingState = {
        totalPasses: this._resolvePlannedProofreadingPasses(latest),
        completedPasses: 0,
        updatedAt: Date.now()
      };
      if (this.translationAgent && latest.agentState && typeof this.translationAgent.markPhase === 'function' && effectiveBlocks.length) {
        this.translationAgent.markPhase(latest, 'awaiting_categories', `Ожидаю выбор категорий пользователем: ${recommendedCategories.join(', ') || 'нет'}`);
      }

      if (!effectiveBlocks.length) {
        await this._saveJob(latest, { clearActive: true });
        return { ok: true, blockCount: 0 };
      }

      await this._saveJob(latest, { setActive: true });
      return {
        ok: true,
        blockCount: effectiveBlocks.length,
        awaitingCategorySelection: true,
        availableCategories,
        selectedCategories: recommendedCategories
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
      const availableCategories = this._collectAvailableCategories(blocksById);
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
        const category = this._normalizeCategory(block && block.category ? block.category : (block && block.pathHint ? block.pathHint : 'other'));
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
          'Не удалось повторно применить восстановленные переведённые блоки после перезагрузки',
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

      const selectedBlockIds = this._filterBlockIdsByCategories(job.blocksById, effectiveSelectedCategories);
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
      if (job.agentState && typeof job.agentState === 'object') {
        job.agentState.selectedCategories = effectiveSelectedCategories.slice();
      }

      if (!job.totalBlocks) {
        job.status = 'done';
        job.message = 'Переводимых блоков не найдено';
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
        job.message = 'Перевод восстановлен после перезагрузки страницы';
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
      job.message = 'Восстановлено после перезагрузки страницы; продолжаю перевод';
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
        this.translationAgent.markPhase(job, 'resumed', `Возобновлено; осталось блоков: ${pendingBlockIds.length}`);
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

    async _handleApplyAck({ message, tabId }) {
      const jobId = message && message.jobId ? message.jobId : null;
      const batchId = message && message.batchId ? message.batchId : null;
      if (!jobId || !batchId) {
        return { ok: false, error: { code: 'INVALID_APPLY_ACK', message: 'Требуются jobId и batchId' } };
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
        tabId
      });
      return { ok: true };
    }

    async _handleApplyDeltaAck({ message, tabId }) {
      const jobId = message && message.jobId ? message.jobId : null;
      const blockId = message && message.blockId ? message.blockId : null;
      const deltaId = message && typeof message.deltaId === 'string' && message.deltaId
        ? message.deltaId
        : null;
      if (!jobId || !blockId) {
        return { ok: false, error: { code: 'INVALID_APPLY_DELTA_ACK', message: 'Требуются jobId и blockId' } };
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
        tabId
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
            job.message = job.failedBlockIds.length ? 'Завершено с ошибками в блоках' : 'Перевод завершён';
            if (this.translationAgent && job.agentState) {
              if (job.status === 'done' && typeof this.translationAgent.finalizeJob === 'function') {
                this.translationAgent.finalizeJob(job);
              }
              if (job.status === 'failed' && typeof this.translationAgent.markFailed === 'function') {
                this.translationAgent.markFailed(job, {
                  code: 'FAILED_BLOCKS_PRESENT',
                  message: 'Перевод завершён с ошибками в блоках'
                });
              }
            }
            if (job.status === 'done') {
              await this._persistJobCache(job).catch(() => {});
            }
            const keepActiveAfterDone = job.status === 'done' && this._shouldKeepJobActiveForCategoryExtensions(job);
            if (keepActiveAfterDone) {
              job.message = 'Перевод завершён для выбранных категорий. Можно добавить ещё категории.';
            }
            await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
            if (job.failedBlockIds.length) {
              this._emitEvent('error', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Перевод завершён с ошибками', {
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
          job.message = `Агент переводит батч ${batch.index + 1}`;
          if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
            this.translationAgent.markPhase(job, 'translating', `Батч ${batch.index + 1}`);
          }
          await this._saveJob(job, { setActive: true });

          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_SENT : 'translation.batch.sent', 'Запрошен батч перевода', {
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
              contentSessionId: job.contentSessionId || null
            });
            if (!sent.ok) {
              throw new Error(sent.error && sent.error.message ? sent.error.message : 'Не удалось отправить батч в контент-рантайм');
            }

            const ack = await this._waitForApplyAck(job.id, batch.batchId, this.APPLY_ACK_TIMEOUT_MS);
            if (!ack.ok) {
              throw new Error('Не получено подтверждение применения от контент-скрипта');
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
            refreshed.message = 'Батч применён';
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
            this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_APPLIED : 'translation.batch.applied', 'Батч перевода применён', {
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
              fallbackMessage: 'Ошибка перевода батча'
            });
            refreshed.message = `Ошибка батча: ${refreshed.lastError.message}`;
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
        }
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

      let result = null;
      try {
        result = await runner.runExecution({
          job,
          blocks: Object.keys(job.blocksById || {}).map((id) => job.blocksById[id]).filter(Boolean),
          settings,
          runLlmRequest
        });
      } catch (error) {
        const normalizedError = (error && typeof error === 'object')
          ? error
          : {
            code: 'AGENT_EXECUTION_FAILED',
            message: 'Ошибка агент-исполнения'
          };
        const requeued = await this._requeueJobForBackpressure(job, normalizedError);
        if (requeued) {
          return { continueLoop: false };
        }
        await this._markFailed(
          job,
          normalizedError
        );
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
            code: 'AGENT_EXECUTION_FAILED',
            message: 'Исполнение агентом завершилось ошибкой'
          };
        const requeued = await this._requeueJobForBackpressure(refreshed, normalizedError);
        if (requeued) {
          return { continueLoop: false };
        }
        await this._markFailed(
          refreshed,
          normalizedError
        );
        return { continueLoop: false };
      }
      if (refreshed.status !== 'running') {
        return { continueLoop: false };
      }

      const pendingCount = Array.isArray(refreshed.pendingBlockIds) ? refreshed.pendingBlockIds.length : 0;
      if (pendingCount > 0) {
        refreshed.message = `Агент выполняет перевод; осталось блоков: ${pendingCount}`;
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

      const proofreadRan = await this._runProofreadingPassIfNeeded(refreshed);
      if (proofreadRan) {
        return { continueLoop: true };
      }
      refreshed.status = refreshed.failedBlockIds.length ? 'failed' : 'done';
      refreshed.message = refreshed.failedBlockIds.length ? 'Завершено с ошибками в блоках' : 'Перевод завершён';
      if (this.translationAgent && refreshed.agentState) {
        if (refreshed.status === 'done' && typeof this.translationAgent.finalizeJob === 'function') {
          this.translationAgent.finalizeJob(refreshed);
        }
        if (refreshed.status === 'failed' && typeof this.translationAgent.markFailed === 'function') {
          this.translationAgent.markFailed(refreshed, {
            code: 'FAILED_BLOCKS_PRESENT',
            message: 'Перевод завершён с ошибками в блоках'
          });
        }
      }
      if (refreshed.status === 'done') {
        await this._persistJobCache(refreshed).catch(() => {});
      }
      const keepActiveAfterDone = refreshed.status === 'done' && this._shouldKeepJobActiveForCategoryExtensions(refreshed);
      if (keepActiveAfterDone) {
        refreshed.message = 'Перевод завершён для выбранных категорий. Можно добавить ещё категории.';
      }
      await this._saveJob(refreshed, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
      if (refreshed.failedBlockIds.length) {
        this._emitEvent('error', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Перевод завершён с ошибками', {
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
      const deltaId = `${job.id}:${blockId}:delta:${Date.now()}:${Math.random().toString(16).slice(2)}`;
      const startedAt = Date.now();
      const block = job.blocksById && job.blocksById[blockId] ? job.blocksById[blockId] : null;
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
        deltaId,
        text,
        isFinal: Boolean(isFinal),
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
      if (ack.applied !== false && block) {
        block.translatedText = text;
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
            latencyMs: Math.max(0, Date.now() - startedAt),
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

      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_SENT : 'translation.batch.sent', 'Запущен проход вычитки', {
        tabId: job.tabId,
        jobId: job.id,
        passIndex,
        totalPasses,
        blockCount: blocks.length
      });
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(job, 'proofreading', `Проход ${passIndex}/${totalPasses}`);
      }
      job.currentBatchId = `${job.id}:proofread:${passIndex}`;
      job.message = `Вычитка: проход ${passIndex}/${totalPasses}`;
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
          const sent = await this._sendToTab(refreshedBefore.tabId, {
            type: protocol.BG_APPLY_BATCH,
            jobId: refreshedBefore.id,
            batchId: chunk.batchId,
            items: normalizedItems,
            contentSessionId: refreshedBefore.contentSessionId || null
          });
          if (!sent.ok) {
            throw new Error(sent.error && sent.error.message ? sent.error.message : 'Не удалось отправить батч вычитки в контент-рантайм');
          }

          const ack = await this._waitForApplyAck(refreshedBefore.id, chunk.batchId, this.APPLY_ACK_TIMEOUT_MS);
          if (!ack.ok) {
            throw new Error('Не получено подтверждение применения для батча вычитки');
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
          refreshed.message = `Вычитка: проход ${passIndex}/${totalPasses}, батч ${i + 1}/${chunks.length}`;
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
            fallbackMessage: 'Ошибка батча вычитки'
          });
          refreshed.message = `Предупреждение вычитки: ${refreshed.lastError.message}`;
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
          this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Проход вычитки завершился ошибкой, продолжаю с текущим переводом', {
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
      afterPass.message = `Вычитка: проход ${passIndex}/${totalPasses} завершён`;
      await this._saveJob(afterPass, { setActive: true });
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_APPLIED : 'translation.batch.applied', 'Проход вычитки завершён', {
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

    async _saveJob(job, { setActive = false, clearActive = false } = {}) {
      if (!job || !job.id) {
        return;
      }
      let prev = null;
      try {
        prev = await this.jobStore.getJob(job.id);
      } catch (_) {
        prev = null;
      }
      if (prev && this._isTerminalStatus(prev.status) && !this._isTerminalStatus(job.status)) {
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
      if ((!job.runSettings || typeof job.runSettings !== 'object') && prev && prev.runSettings && typeof prev.runSettings === 'object') {
        job.runSettings = prev.runSettings;
      }
      this._ensureJobRunSettings(job, { settings: null });
      job.displayMode = this._normalizeDisplayMode(job.displayMode, true);
      if (
        (!Number.isFinite(Number(job.compareDiffThreshold)) || Number(job.compareDiffThreshold) <= 0)
        && prev
        && Number.isFinite(Number(prev.compareDiffThreshold))
      ) {
        job.compareDiffThreshold = prev.compareDiffThreshold;
      }
      job.compareDiffThreshold = this._normalizeCompareDiffThreshold(job.compareDiffThreshold);
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
      await this.jobStore.upsertJob(job);
      if (setActive) {
        await this.jobStore.setActiveJob(job.tabId, job.id);
      }
      if (clearActive) {
        await this.jobStore.clearActiveJob(job.tabId, job.id);
      }
      await this._syncTabStatus(job);
      this._emitUiPatch(job);
    }

    _runtimeStatusFromJobStatus(status) {
      const value = String(status || '').toLowerCase();
      if (value === 'done') return 'DONE';
      if (value === 'failed') return 'FAILED';
      if (value === 'cancelled') return 'CANCELLED';
      if (value === 'awaiting_categories') return 'IDLE';
      if (value === 'preparing') return 'QUEUED';
      if (value === 'running' || value === 'completing') return 'RUNNING';
      return 'IDLE';
    }

    _runtimeStageFromJob(job) {
      const status = String(job && job.status ? job.status : '').toLowerCase();
      if (status === 'preparing') {
        return 'scanning';
      }
      if (status === 'awaiting_categories') {
        return 'awaiting_categories';
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
      if (status === 'preparing' || status === 'running' || status === 'completing') {
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
            category: this._normalizeCategory(block && (block.category || block.pathHint) || 'other'),
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
          const status = failed.has(blockId)
            ? 'FAILED'
            : pending.has(blockId)
              ? 'PENDING'
              : (translatedText ? 'DONE' : 'PENDING');
          return {
            blockId,
            category: this._normalizeCategory(block.category || block.pathHint || 'other'),
            status,
            originalLength: originalText.length,
            translatedLength: translatedText.length,
            originalHash: block.originalHash || this._hashTextStable(originalText),
            translatedHash: translatedText ? this._hashTextStable(translatedText) : null,
            originalSnippet: this._buildPatchPreview(originalText),
            translatedSnippet: translatedText ? this._buildPatchPreview(translatedText) : ''
          };
        });
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

    _toJobSummary(job) {
      if (!job) {
        return null;
      }
      const runtime = this._ensureJobRuntime(job, { now: Date.now() });
      const runSettings = this._ensureJobRunSettings(job, { settings: null });
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
        currentBatchId: job.currentBatchId || null,
        selectedCategories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
        availableCategories: Array.isArray(job.availableCategories) ? job.availableCategories.slice(0, 24) : [],
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
        return 'Похоже, домен api.openai.com недоступен из сети/блокируется (DNS/фаервол/AdGuard/uBlock/сертификат).';
      }
      return 'Сеть до api.openai.com есть, ищи CSP/permissions или блок POST.';
    }

    _normalizeJobError(errorLike, { fallbackCode = 'TRANSLATION_FAILED', fallbackMessage = 'Перевод завершился ошибкой' } = {}) {
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
      const separator = rawMessage && /[.!?…]$/.test(rawMessage.trim()) ? ' ' : '. ';
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
          ? `Ожидаю слот offscreen ${Math.ceil(waitMs / 1000)}с`
          : `Ожидаю лимит API ${Math.ceil(waitMs / 1000)}с`
      };
      runtime.lease = runtime.lease && typeof runtime.lease === 'object' ? runtime.lease : {};
      runtime.lease.leaseUntilTs = null;
      runtime.lease.heartbeatTs = now;
      runtime.lease.op = isOffscreenBackpressure ? 'offscreen_wait' : 'rate_limit_wait';
      runtime.lease.opId = latest.id;
      latest.status = 'preparing';
      latest.message = isOffscreenBackpressure
        ? `Ожидаю слот offscreen ${Math.ceil(waitMs / 1000)}с`
        : `Ожидаю лимит API ${Math.ceil(waitMs / 1000)}с`;
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
        fallbackMessage: 'Перевод завершился ошибкой'
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
        return { ok: false, error: { code: 'SCRIPTING_UNAVAILABLE', message: 'chrome.scripting недоступен' } };
      }
      const RuntimePaths = NT.RuntimePaths || null;
      const resolvePath = (relativePath) => (
        RuntimePaths && typeof RuntimePaths.withPrefix === 'function'
          ? RuntimePaths.withPrefix(this.chromeApi, relativePath)
          : relativePath
      );
      try {
        await this.chromeApi.scripting.executeScript({
          target: { tabId },
          files: [
            resolvePath('core/nt-namespace.js'),
            resolvePath('core/message-envelope.js'),
            resolvePath('core/translation-protocol.js'),
            resolvePath('content/dom-indexer.js'),
            resolvePath('content/diff-highlighter.js'),
            resolvePath('content/dom-applier.js'),
            resolvePath('content/content-runtime.js')
          ]
        });
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'INJECT_FAILED',
            message: error && error.message ? error.message : 'Не удалось внедрить контент-рантайм'
          }
        };
      }
    }

    async _sendToTab(tabId, message) {
      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.sendMessage !== 'function') {
        return { ok: false, error: { code: 'TABS_API_UNAVAILABLE', message: 'chrome.tabs.sendMessage недоступен' } };
      }
      try {
        const protocol = NT.TranslationProtocol || {};
        let outgoingMessage = message;
        if (message && typeof message === 'object' && typeof message.type === 'string' && typeof protocol.wrap === 'function') {
          try {
            const payload = { ...message };
            delete payload.type;
            outgoingMessage = protocol.wrap(message.type, payload, {
              source: 'background',
              tabId,
              stage: message.type,
              requestId: payload.batchId || payload.jobId || null
            });
          } catch (_) {
            outgoingMessage = message;
          }
        }
        return await new Promise((resolve) => {
          this.chromeApi.tabs.sendMessage(tabId, outgoingMessage, (response) => {
            const runtimeError = this.chromeApi.runtime && this.chromeApi.runtime.lastError
              ? this.chromeApi.runtime.lastError
              : null;
            if (runtimeError) {
              resolve({
                ok: false,
                error: {
                  code: 'TAB_SEND_FAILED',
                  message: runtimeError.message || 'Сбой tabs.sendMessage'
                }
              });
              return;
            }
            resolve(response && response.ok === false ? { ok: false, error: response.error || { code: 'UNKNOWN', message: 'Неизвестная ошибка вкладки' } } : { ok: true, response });
          });
        });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'TAB_SEND_FAILED', message: error && error.message ? error.message : 'Сбой tabs.sendMessage' }
        };
      }
    }

    _normalizeBlocks(input) {
      const list = Array.isArray(input) ? input : [];
      const out = [];
      const seen = new Set();
      list.forEach((item, index) => {
        if (!item || typeof item !== 'object') {
          return;
        }
        const originalText = typeof item.originalText === 'string' ? item.originalText.trim() : '';
        if (!originalText) {
          return;
        }
        const blockId = item.blockId || `b${index}`;
        if (seen.has(blockId)) {
          return;
        }
        seen.add(blockId);
        out.push({
          blockId,
          originalText,
          originalHash: this._hashTextStable(originalText),
          charCount: originalText.length,
          stableNodeKey: typeof item.stableNodeKey === 'string' && item.stableNodeKey ? item.stableNodeKey : null,
          pathHint: item.pathHint || null,
          category: item.category || null
        });
      });
      return out;
    }

    _normalizeCategory(category) {
      if (typeof category !== 'string') {
        return 'other';
      }
      const raw = category.trim().toLowerCase();
      if (!raw) {
        return 'other';
      }
      if (KNOWN_CATEGORIES.includes(raw)) {
        return raw;
      }
      if (raw.includes('h1') || raw.includes('h2') || raw.includes('h3') || raw.includes('h4') || raw.includes('h5') || raw.includes('h6') || raw.includes('title')) {
        return 'heading';
      }
      if (raw.includes('nav') || raw.includes('menu')) {
        return 'navigation';
      }
      if (raw.includes('btn') || raw.includes('button')) {
        return 'button';
      }
      if (raw.includes('label')) {
        return 'label';
      }
      if (raw.includes('code') || raw.includes('pre')) {
        return 'code';
      }
      if (raw.includes('quote') || raw.includes('blockquote')) {
        return 'quote';
      }
      if (raw.includes('table') || raw.includes('th') || raw.includes('td')) {
        return 'table';
      }
      if (raw.includes('meta') || raw.includes('header') || raw.includes('footer')) {
        return 'meta';
      }
      if (raw.includes('li') || raw.includes('ul') || raw.includes('ol') || raw.includes('list')) {
        return 'list';
      }
      if (raw.includes('p') || raw.includes('paragraph') || raw.includes('text')) {
        return 'paragraph';
      }
      return 'other';
    }

    _collectAvailableCategories(blocksById) {
      const map = blocksById && typeof blocksById === 'object' ? blocksById : {};
      const seen = new Set();
      const out = [];
      Object.keys(map).forEach((blockId) => {
        const block = map[blockId];
        const category = this._normalizeCategory(block && block.category ? block.category : (block && block.pathHint ? block.pathHint : 'other'));
        if (seen.has(category)) {
          return;
        }
        seen.add(category);
        out.push(category);
      });
      const order = KNOWN_CATEGORIES.slice();
      return out.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    }

    _normalizeSelectedCategories(input, availableCategories, fallback) {
      const available = Array.isArray(availableCategories) ? availableCategories : [];
      const availableSet = new Set(available);
      const source = Array.isArray(input) ? input : [];
      const selected = [];
      source.forEach((item) => {
        const category = this._normalizeCategory(String(item || ''));
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
        const category = this._normalizeCategory(String(item || ''));
        if (!availableSet.has(category) || selected.includes(category)) {
          return;
        }
        selected.push(category);
      });
      if (selected.length) {
        return selected;
      }
      return available.slice();
    }

    _filterBlockIdsByCategories(blocksById, categories) {
      const map = blocksById && typeof blocksById === 'object' ? blocksById : {};
      const selectedSet = new Set(Array.isArray(categories) ? categories : []);
      if (!selectedSet.size) {
        return [];
      }
      return Object.keys(map).filter((blockId) => {
        const block = map[blockId];
        const category = this._normalizeCategory(block && block.category ? block.category : (block && block.pathHint ? block.pathHint : 'other'));
        return selectedSet.has(category);
      });
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
      return ordered.length ? ordered : availableList.slice();
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
        this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Планирование агентом не удалось; использован базовый батчинг', {
          tabId: job && job.tabId !== undefined ? job.tabId : null,
          jobId: job && job.id ? job.id : null,
          message: error && error.message ? error.message : 'неизвестно'
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
          translationCompareDiffThreshold: this.COMPARE_DIFF_THRESHOLD_DEFAULT,
          schemaVersion: 1,
          userSettings: null,
          effectiveSettings: null,
          reasoning: null,
          caching: null,
          models: null,
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
        'translationCompareDiffThreshold',
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
        translationCompareDiffThreshold: this._normalizeCompareDiffThreshold(settings.translationCompareDiffThreshold),
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
        title: 'Восстановление из памяти',
        body: `Восстановлено блоков: ${restoredCount}`,
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
        checklistItem.details = restoredCount > 0 ? `восстановлено=${restoredCount}` : checklistItem.details;
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
        if (page && page.blocks && page.blocks[block.blockId] && typeof page.blocks[block.blockId] === 'object') {
          const record = page.blocks[block.blockId];
          if (record.originalHash && record.originalHash === originalHash && typeof record.translatedText === 'string' && record.translatedText) {
            translatedText = record.translatedText;
          }
        }
        if (!translatedText) {
          const blockKey = this._buildBlockMemoryKey(job.targetLang || 'ru', originalHash);
          const blockRecord = await this.translationMemoryStore.getBlock(blockKey).catch(() => null);
          if (blockRecord && typeof blockRecord.translatedText === 'string' && blockRecord.translatedText) {
            translatedText = blockRecord.translatedText;
            await this.translationMemoryStore.touchBlock(blockKey).catch(() => ({ ok: false }));
          }
        }
        if (!translatedText) {
          continue;
        }
        block.translatedText = translatedText;
        restoredItems.push({
          blockId: block.blockId,
          text: translatedText
        });
      }

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

      const selectedBlockIds = this._filterBlockIdsByCategories(job.blocksById, job.selectedCategories);
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

      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Перевод восстановлен из кэша', {
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
            error: error && error.message ? error.message : 'ошибка сохранения кэша'
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
      this._upsertPersistentMemoryEntries({ job, blocks, items }).catch(() => {});
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
        await this.translationMemoryStore.upsertBlock({
          blockKey,
          originalHash,
          targetLang: job.targetLang || 'ru',
          translatedText: item.text,
          qualityTag: 'raw',
          modelUsed: block.modelUsed || null,
          routeUsed: block.routeUsed || null,
          sourcePageKeys: [context.pageKey]
        }).catch(() => ({ ok: false }));

        pageRecord.blocks[item.blockId] = {
          originalHash,
          translatedText: item.text,
          modelUsed: block.modelUsed || null,
          routeUsed: block.routeUsed || null,
          updatedAt: now
        };
        const category = this._normalizeCategory(block.category || block.pathHint || 'other');
        if (!pageRecord.categories[category] || typeof pageRecord.categories[category] !== 'object') {
          pageRecord.categories[category] = {
            translatedBlockIds: [],
            stats: {
              count: 0,
              passCount: 1
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
          : { count: 0, passCount: 1 };
        categoryEntry.stats.count = categoryEntry.translatedBlockIds.length;
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
      const src = `${String(lang || 'ru').toLowerCase()}::${String(category || 'other').toLowerCase()}::${String(sourceText || '').trim()}`;
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
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Задача отсутствует' } };
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
            message: 'Исходная вкладка недоступна, и не найдена замещающая вкладка с совпадающим URL'
          }
        };
      }

      await this._rebindJobToTab(job, recoveredTabId);
      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Задача перевода восстановлена в замещающей вкладке после перезапуска', {
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
      job.message = 'Восстановлено после перезапуска; переподключаю runtime перевода';
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
    }
  }

  NT.TranslationOrchestrator = TranslationOrchestrator;
})(globalThis);
