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
      translationCall,
      translationAgent,
      eventFactory,
      eventLogFn,
      onUiPatch
    } = {}) {
      this.chromeApi = chromeApi;
      this.settingsStore = settingsStore || null;
      this.tabStateStore = tabStateStore || null;
      this.jobStore = jobStore || null;
      this.pageCacheStore = pageCacheStore || null;
      this.translationCall = translationCall || null;
      this.translationAgent = translationAgent || null;
      this.eventFactory = eventFactory || null;
      this.eventLogFn = typeof eventLogFn === 'function' ? eventLogFn : null;
      this.onUiPatch = typeof onUiPatch === 'function' ? onUiPatch : null;

      this.BATCH_SIZE = 8;
      this.JOB_LEASE_MS = 2 * 60 * 1000;
      this.APPLY_ACK_TIMEOUT_MS = 8000;
      this.processingJobs = new Set();
      this.pendingApplyAcks = new Map();
      this.jobAbortControllers = new Map();
    }

    isContentMessageType(type) {
      const protocol = NT.TranslationProtocol || null;
      return Boolean(protocol && protocol.isContentToBackground && protocol.isContentToBackground(type));
    }

    async startJob({ tabId, url, targetLang = 'ru', force = false } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'tabId is required' } };
      }

      if (!(await this._isPipelineEnabled())) {
        return { ok: false, error: { code: 'PIPELINE_DISABLED', message: 'translationPipelineEnabled=false' } };
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
        leaseUntilTs: now + this.JOB_LEASE_MS,
        totalBlocks: 0,
        completedBlocks: 0,
        pendingBlockIds: [],
        failedBlockIds: [],
        blocksById: {},
        currentBatchId: null,
        lastError: null,
        message: 'Scanning page content',
        attempts: 0,
        scanReceived: false,
        forceTranslate: Boolean(force),
        pageSignature: null,
        cacheKey: null,
        availableCategories: [],
        selectedCategories: [],
        agentState: null,
        recentDiffItems: [],
        translationMemoryBySource: {},
        apiCacheEnabled: true,
        proofreadingState: {
          totalPasses: 0,
          completedPasses: 0,
          updatedAt: now
        }
      };

      await this._saveJob(job, { setActive: true });
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_START : 'translation.start', 'Translation job started', {
        tabId: numericTabId,
        jobId: job.id,
        status: job.status
      });

      const protocol = NT.TranslationProtocol || {};
      const sent = await this._sendToTab(numericTabId, {
        type: protocol.BG_START_JOB,
        jobId: job.id,
        targetLang: job.targetLang
      });

      if (!sent.ok) {
        await this._markFailed(job, {
          code: 'CONTENT_RUNTIME_UNREACHABLE',
          message: sent.error && sent.error.message ? sent.error.message : 'Failed to start content runtime'
        });
        return { ok: false, error: { code: 'CONTENT_RUNTIME_UNREACHABLE', message: 'Failed to start content runtime' } };
      }

      return { ok: true, job: this._toJobSummary(job) };
    }

    async cancelJob({ tabId, reason = 'USER_CANCELLED' } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'tabId is required' } };
      }
      const job = await this.jobStore.getActiveJob(numericTabId);
      if (!job) {
        return { ok: true, cancelled: false };
      }
      this._abortJobRequests(job.id, reason);

      job.status = 'cancelled';
      if (reason === 'REPLACED_BY_NEW_JOB') {
        job.message = 'Cancelled: replaced by a new job';
      } else if (reason === 'TAB_CLOSED') {
        job.message = 'Cancelled: tab closed';
      } else if (reason === 'USER_CLEAR') {
        job.message = 'Cancelled: clearing translation data';
      } else {
        job.message = 'Cancelled by user';
      }
      job.lastError = (reason === 'REPLACED_BY_NEW_JOB' || reason === 'TAB_CLOSED')
        ? null
        : { code: reason, message: 'Translation cancelled' };
      job.currentBatchId = null;

      await this._saveJob(job, { clearActive: true });

      const protocol = NT.TranslationProtocol || {};
      await this._sendToTab(numericTabId, { type: protocol.BG_CANCEL_JOB, jobId: job.id });
      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Translation job cancelled', {
        tabId: numericTabId,
        jobId: job.id,
        reason
      });

      return { ok: true, cancelled: true, job: this._toJobSummary(job) };
    }

    async applyCategorySelection({ tabId, categories, jobId = null } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'tabId is required' } };
      }
      const job = await this.jobStore.getActiveJob(numericTabId);
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'No active job to apply categories' } };
      }
      if (jobId && job.id !== jobId) {
        return { ok: false, error: { code: 'JOB_MISMATCH', message: 'Job id mismatch for category selection' } };
      }
      const canExtendFromDone = job.status === 'done' && this._shouldKeepJobActiveForCategoryExtensions(job);
      if (job.status !== 'awaiting_categories' && !canExtendFromDone) {
        return {
          ok: false,
          error: {
            code: 'INVALID_JOB_STATE',
            message: `Category selection is accepted only in awaiting_categories or extendable done state (current=${job.status || 'unknown'})`
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
        return { ok: false, error: { code: 'NO_CATEGORIES_SELECTED', message: 'Select at least one category to continue' } };
      }

      const selectedBlockIds = this._filterBlockIdsByCategories(job.blocksById, selectedCategories);
      if (!selectedBlockIds.length) {
        return { ok: false, error: { code: 'NO_BLOCKS_FOR_SELECTED_CATEGORIES', message: 'No blocks match selected categories' } };
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
          ? 'Requested categories are already translated. You can select additional categories.'
          : 'Selected categories are already translated';
        if (this.translationAgent && job.agentState && typeof this.translationAgent.finalizeJob === 'function') {
          this.translationAgent.finalizeJob(job);
        }
        await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
        return { ok: true, job: this._toJobSummary(job), reused: true, canSelectMore: keepActiveAfterDone };
      }

      job.status = 'running';
      job.message = `Category selection applied: ${selectedCategories.join(', ')}`;
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(job, 'translating', job.message);
      }

      const settings = await this._readAgentSettings();
      if (fullCategorySelection) {
        const cachedApplied = await this._tryApplyCachedJob({ job, settings });
        if (cachedApplied) {
          await this._saveJob(job, { clearActive: true });
          return { ok: true, job: this._toJobSummary(job), fromCache: true };
        }
      }

      await this._saveJob(job, { setActive: true });
      this._processJob(job.id).catch(() => {});
      return { ok: true, job: this._toJobSummary(job), fromCache: false };
    }

    async clearJobData({ tabId, includeCache = true } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'tabId is required' } };
      }

      const activeJob = await this.jobStore.getActiveJob(numericTabId);
      if (activeJob && (activeJob.status === 'preparing' || activeJob.status === 'awaiting_categories' || activeJob.status === 'running' || activeJob.status === 'completing')) {
        await this.cancelJob({ tabId: numericTabId, reason: 'USER_CLEAR' });
      }

      const lastJob = await this._getLastJobForTab(numericTabId);
      const protocol = NT.TranslationProtocol || {};
      await this._ensureContentRuntime(numericTabId);
      await this._sendToTab(numericTabId, {
        type: protocol.BG_RESTORE_ORIGINALS,
        jobId: lastJob && lastJob.id ? lastJob.id : null
      });

      let cacheCleared = false;
      if (includeCache && this.pageCacheStore && lastJob && lastJob.url) {
        const removed = await this.pageCacheStore.removeEntry({
          url: lastJob.url,
          targetLang: lastJob.targetLang || 'ru'
        });
        cacheCleared = Boolean(removed);
      }

      if (this.tabStateStore && typeof this.tabStateStore.upsertStatusPatch === 'function') {
        await this.tabStateStore.upsertStatusPatch(numericTabId, {
          status: 'idle',
          progress: 0,
          total: 0,
          completed: 0,
          inProgress: 0,
          message: 'Translation data cleared',
          failedBlocksCount: 0,
          translationJobId: null,
          lastError: null,
          selectedCategories: [],
          availableCategories: [],
          modelDecision: null,
          updatedAt: Date.now()
        });
      }
      if (this.jobStore && typeof this.jobStore.clearTabHistory === 'function') {
        await this.jobStore.clearTabHistory(numericTabId);
      }

      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_CANCEL : 'translation.cancel', 'Translation data cleared', {
        tabId: numericTabId,
        cacheCleared
      });
      if (this.onUiPatch) {
        this.onUiPatch({
          translationJob: null,
          translationProgress: 0,
          failedBlocksCount: 0,
          lastError: null,
          agentState: null,
          selectedCategories: [],
          availableCategories: []
        });
      }
      return { ok: true, cleared: true, cacheCleared };
    }

    async setVisibility({ tabId, visible } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'tabId is required' } };
      }

      const protocol = NT.TranslationProtocol || {};
      await this._ensureContentRuntime(numericTabId);
      await this._sendToTab(numericTabId, {
        type: protocol.BG_SET_VISIBILITY,
        visible: Boolean(visible)
      });
      if (this.tabStateStore && typeof this.tabStateStore.upsertVisibility === 'function') {
        await this.tabStateStore.upsertVisibility(numericTabId, Boolean(visible));
      }
      return { ok: true };
    }

    async retryFailed({ tabId, jobId } = {}) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return { ok: false, error: { code: 'INVALID_TAB_ID', message: 'tabId is required' } };
      }

      const sourceJob = jobId
        ? await this.jobStore.getJob(jobId)
        : await this._getLastJobForTab(numericTabId);
      if (!sourceJob) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'No job found for retry' } };
      }
      if (!Array.isArray(sourceJob.failedBlockIds) || !sourceJob.failedBlockIds.length) {
        return { ok: false, error: { code: 'NO_FAILED_BLOCKS', message: 'No failed blocks to retry' } };
      }

      const pendingBlockIds = sourceJob.failedBlockIds.slice();
      sourceJob.failedBlockIds = [];
      sourceJob.pendingBlockIds = pendingBlockIds;
      sourceJob.status = 'running';
      sourceJob.message = 'Retrying failed blocks';
      sourceJob.lastError = null;
      sourceJob.currentBatchId = null;

      await this._saveJob(sourceJob, { setActive: true });
      await this._ensureContentRuntime(numericTabId);
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Retrying failed translation blocks', {
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
      for (const job of activeJobs) {
        if (!job) {
          continue;
        }
        if (typeof job.leaseUntilTs === 'number' && job.leaseUntilTs < now) {
          await this._markFailed(job, {
            code: 'LEASE_EXPIRED',
            message: 'Job lease expired after service-worker restart'
          });
          continue;
        }
        const tabReady = await this._ensureJobTabReady(job);
        if (!tabReady.ok) {
          await this._markFailed(job, tabReady.error || {
            code: 'TAB_UNAVAILABLE_AFTER_RESTART',
            message: 'Tab is unavailable after restart; cannot resume translation job'
          });
          continue;
        }
        if (job.status === 'preparing' || job.status === 'awaiting_categories') {
          const injected = await this._ensureContentRuntime(job.tabId);
          if (!injected.ok) {
            await this._markFailed(job, {
              code: injected.error && injected.error.code ? injected.error.code : 'INJECT_FAILED',
              message: injected.error && injected.error.message ? injected.error.message : 'Failed to re-inject content runtime after restart'
            });
            continue;
          }
          const protocol = NT.TranslationProtocol || {};
          const sent = await this._sendToTab(job.tabId, {
            type: protocol.BG_START_JOB,
            jobId: job.id,
            targetLang: job.targetLang || 'ru'
          });
          if (!sent.ok) {
            await this._markFailed(job, {
              code: 'CONTENT_RUNTIME_UNREACHABLE',
              message: sent.error && sent.error.message ? sent.error.message : 'Failed to resume preparing job after restart'
            });
            continue;
          }
          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Resumed translation job after restart', {
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
              message: injected.error && injected.error.message ? injected.error.message : 'Failed to restore content runtime for running job'
            });
            continue;
          }
          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Resuming running translation job after restart', {
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
      if (!message || !message.type || !protocol) {
        return { ok: false, error: { code: 'INVALID_CONTENT_MESSAGE', message: 'Missing type' } };
      }

      if (message.type === protocol.CS_READY) {
        if (tabId !== null) {
          const active = await this.jobStore.getActiveJob(tabId);
          if (active && (active.status === 'preparing' || active.status === 'running' || active.status === 'completing' || active.status === 'awaiting_categories')) {
            active.status = 'preparing';
            active.message = 'Content runtime reconnected; rescanning page';
            active.scanReceived = false;
            active.currentBatchId = null;
            await this._saveJob(active, { setActive: true });
            await this._sendToTab(tabId, {
              type: protocol.BG_START_JOB,
              jobId: active.id,
              targetLang: active.targetLang || 'ru'
            });
            this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Content runtime reconnected and job resumed', {
              tabId,
              jobId: active.id
            });
          }
        }
        return { ok: true };
      }
      if (message.type === protocol.CS_SCAN_RESULT) {
        return this._handleScanResult({ message, tabId });
      }
      if (message.type === protocol.CS_APPLY_ACK) {
        return this._handleApplyAck({ message, tabId });
      }
      return { ok: false, error: { code: 'UNKNOWN_CONTENT_MESSAGE', message: `Unsupported type: ${message.type}` } };
    }

    async _handleScanResult({ message, tabId }) {
      const jobId = message && message.jobId ? message.jobId : null;
      if (!jobId) {
        return { ok: false, error: { code: 'INVALID_SCAN_RESULT', message: 'jobId is required' } };
      }
      const job = await this.jobStore.getJob(jobId);
      if (!job) {
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: `Job not found: ${jobId}` } };
      }
      if (tabId !== null && job.tabId !== tabId) {
        return { ok: false, error: { code: 'TAB_MISMATCH', message: 'Scan result tab mismatch' } };
      }
      if (job.status === 'cancelled' || job.status === 'failed' || job.status === 'done') {
        return { ok: true, ignored: true };
      }

      const normalized = this._normalizeBlocks(message.blocks);
      const settings = await this._readAgentSettings();
      const planningSettings = {
        ...settings,
        translationCategoryMode: 'all',
        translationCategoryList: []
      };
      const prepared = await this._prepareAgentJob({
        job,
        blocks: normalized,
        settings: planningSettings
      });
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

      job.scanReceived = true;
      job.blocksById = blocksById;
      job.totalBlocks = 0;
      job.pendingBlockIds = [];
      job.failedBlockIds = [];
      job.completedBlocks = 0;
      job.status = effectiveBlocks.length ? 'awaiting_categories' : 'done';
      job.message = effectiveBlocks.length
        ? `Planning complete (${effectiveBlocks.length} blocks). Select categories to translate.`
        : 'No translatable blocks found';
      job.pageSignature = this._buildPageSignature(effectiveBlocks);
      job.cacheKey = this.pageCacheStore
        ? this.pageCacheStore.buildKey({ url: job.url || '', targetLang: job.targetLang || 'ru' })
        : null;
      job.availableCategories = availableCategories;
      job.selectedCategories = recommendedCategories;
      job.agentState = prepared && prepared.agentState ? prepared.agentState : null;
      job.apiCacheEnabled = settings.translationApiCacheEnabled !== false;
      job.proofreadingState = {
        totalPasses: this._resolvePlannedProofreadingPasses(job),
        completedPasses: 0,
        updatedAt: Date.now()
      };
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function' && effectiveBlocks.length) {
        this.translationAgent.markPhase(job, 'awaiting_categories', `Waiting for user category selection: ${recommendedCategories.join(', ') || 'none'}`);
      }

      if (!effectiveBlocks.length) {
        await this._saveJob(job, { clearActive: true });
        return { ok: true, blockCount: 0 };
      }

      await this._saveJob(job, { setActive: true });
      return {
        ok: true,
        blockCount: effectiveBlocks.length,
        awaitingCategorySelection: true,
        availableCategories,
        selectedCategories: recommendedCategories
      };
    }

    async _handleApplyAck({ message, tabId }) {
      const jobId = message && message.jobId ? message.jobId : null;
      const batchId = message && message.batchId ? message.batchId : null;
      if (!jobId || !batchId) {
        return { ok: false, error: { code: 'INVALID_APPLY_ACK', message: 'jobId and batchId are required' } };
      }
      const key = this._ackKey(jobId, batchId);
      const waiter = this.pendingApplyAcks.get(key);
      if (!waiter) {
        return { ok: true, ignored: true };
      }
      this.pendingApplyAcks.delete(key);
      waiter.resolve({
        ok: message.ok !== false,
        appliedCount: Number.isFinite(Number(message.appliedCount)) ? Number(message.appliedCount) : null,
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
          const nextBatch = this._buildNextBatch(job);
          if (!nextBatch) {
            const proofreadRan = await this._runProofreadingPassIfNeeded(job);
            if (proofreadRan) {
              continue;
            }
            job.status = job.failedBlockIds.length ? 'failed' : 'done';
            job.message = job.failedBlockIds.length ? 'Completed with failed blocks' : 'Translation completed';
            if (this.translationAgent && job.agentState) {
              if (job.status === 'done' && typeof this.translationAgent.finalizeJob === 'function') {
                this.translationAgent.finalizeJob(job);
              }
              if (job.status === 'failed' && typeof this.translationAgent.markFailed === 'function') {
                this.translationAgent.markFailed(job, {
                  code: 'FAILED_BLOCKS_PRESENT',
                  message: 'Translation completed with failed blocks'
                });
              }
            }
            if (job.status === 'done') {
              await this._persistJobCache(job).catch(() => {});
            }
            const keepActiveAfterDone = job.status === 'done' && this._shouldKeepJobActiveForCategoryExtensions(job);
            if (keepActiveAfterDone) {
              job.message = 'Translation completed for selected categories. You can add more categories.';
            }
            await this._saveJob(job, keepActiveAfterDone ? { setActive: true } : { clearActive: true });
            if (job.failedBlockIds.length) {
              this._emitEvent('error', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Translation completed with failures', {
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
          job.message = `Agent translating batch ${batch.index + 1}`;
          if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
            this.translationAgent.markPhase(job, 'translating', `Batch ${batch.index + 1}`);
          }
          await this._saveJob(job, { setActive: true });

          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_SENT : 'translation.batch.sent', 'Translation batch requested', {
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
            const sent = await this._sendToTab(job.tabId, {
              type: protocol.BG_APPLY_BATCH,
              jobId: job.id,
              batchId: batch.batchId,
              items: translated.items || []
            });
            if (!sent.ok) {
              throw new Error(sent.error && sent.error.message ? sent.error.message : 'Failed to deliver batch to content runtime');
            }

            const ack = await this._waitForApplyAck(job.id, batch.batchId, this.APPLY_ACK_TIMEOUT_MS);
            if (!ack.ok) {
              throw new Error('Content apply acknowledgement failed');
            }

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
            refreshed.message = 'Batch applied';
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
            this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_APPLIED : 'translation.batch.applied', 'Translation batch applied', {
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
            refreshed.lastError = {
              code: error && error.code ? error.code : 'BATCH_FAILED',
              message: error && error.message ? error.message : 'Batch translation failed'
            };
            refreshed.message = `Batch failed: ${refreshed.lastError.message}`;
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

      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_SENT : 'translation.batch.sent', 'Proofreading pass started', {
        tabId: job.tabId,
        jobId: job.id,
        passIndex,
        totalPasses,
        blockCount: blocks.length
      });
      if (this.translationAgent && job.agentState && typeof this.translationAgent.markPhase === 'function') {
        this.translationAgent.markPhase(job, 'proofreading', `Pass ${passIndex}/${totalPasses}`);
      }
      job.currentBatchId = `${job.id}:proofread:${passIndex}`;
      job.message = `Proofreading pass ${passIndex}/${totalPasses}`;
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

          const sent = await this._sendToTab(refreshedBefore.tabId, {
            type: protocol.BG_APPLY_BATCH,
            jobId: refreshedBefore.id,
            batchId: chunk.batchId,
            items: normalizedItems
          });
          if (!sent.ok) {
            throw new Error(sent.error && sent.error.message ? sent.error.message : 'Failed to deliver proofread batch to content runtime');
          }

          const ack = await this._waitForApplyAck(refreshedBefore.id, chunk.batchId, this.APPLY_ACK_TIMEOUT_MS);
          if (!ack.ok) {
            throw new Error('Content apply acknowledgement failed for proofread batch');
          }

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
          refreshed.message = `Proofreading pass ${passIndex}/${totalPasses}: ${i + 1}/${chunks.length}`;
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
          refreshed.lastError = {
            code: error && error.code ? error.code : 'PROOFREAD_BATCH_FAILED',
            message: error && error.message ? error.message : 'Proofreading batch failed'
          };
          refreshed.message = `Proofreading warning: ${refreshed.lastError.message}`;
          refreshed.proofreadingState = {
            totalPasses,
            completedPasses: passIndex - 1,
            updatedAt: Date.now()
          };
          await this._saveJob(refreshed, { setActive: true });
          this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Proofreading pass failed, continuing with current translation', {
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
      afterPass.message = `Proofreading pass ${passIndex}/${totalPasses} completed`;
      await this._saveJob(afterPass, { setActive: true });
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_APPLIED : 'translation.batch.applied', 'Proofreading pass completed', {
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

    _ackKey(jobId, batchId) {
      return `${jobId}:${batchId}`;
    }

    _waitForApplyAck(jobId, batchId, timeoutMs) {
      const key = this._ackKey(jobId, batchId);
      return new Promise((resolve) => {
        const timer = global.setTimeout(() => {
          this.pendingApplyAcks.delete(key);
          resolve({ ok: false, timeout: true });
        }, timeoutMs);
        this.pendingApplyAcks.set(key, {
          resolve: (value) => {
            global.clearTimeout(timer);
            resolve(value || { ok: true });
          }
        });
      });
    }

    async _saveJob(job, { setActive = false, clearActive = false } = {}) {
      if (!job || !job.id) {
        return;
      }
      const now = Date.now();
      const runningLike = job.status === 'preparing' || job.status === 'running' || job.status === 'completing';
      job.updatedAt = now;
      job.leaseUntilTs = runningLike ? now + this.JOB_LEASE_MS : null;
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

    async _syncTabStatus(job) {
      if (!this.tabStateStore || !job || job.tabId === null || job.tabId === undefined) {
        return;
      }
      const total = Number.isFinite(Number(job.totalBlocks)) ? Number(job.totalBlocks) : 0;
      const completed = Number.isFinite(Number(job.completedBlocks)) ? Number(job.completedBlocks) : 0;
      const failed = Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0;
      const progress = total > 0
        ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
        : (job.status === 'done' ? 100 : 0);
      const agentState = this.translationAgent && typeof this.translationAgent.toUiSnapshot === 'function'
        ? this.translationAgent.toUiSnapshot(job.agentState || null)
        : (job.agentState || null);

      await this.tabStateStore.upsertStatusPatch(job.tabId, {
        status: job.status,
        progress,
        total,
        completed,
        inProgress: Math.max(0, total - completed - failed),
        message: job.message || job.status,
        failedBlocksCount: failed,
        translationJobId: job.id,
        lastError: job.lastError || null,
        selectedCategories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
        availableCategories: Array.isArray(job.availableCategories) ? job.availableCategories.slice(0, 24) : [],
        pageSignature: job.pageSignature || null,
        agentState,
        recentDiffItems: Array.isArray(job.recentDiffItems) ? job.recentDiffItems.slice(-20) : [],
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

      this.onUiPatch({
        translationJob: this._toJobSummary(job),
        translationProgress,
        failedBlocksCount,
        lastError: job.lastError || null,
        agentState,
        selectedCategories: Array.isArray(job.selectedCategories) ? job.selectedCategories.slice(0, 24) : [],
        availableCategories: Array.isArray(job.availableCategories) ? job.availableCategories.slice(0, 24) : [],
        recentDiffItems: Array.isArray(job.recentDiffItems) ? job.recentDiffItems.slice(-20) : []
      });
    }

    _toJobSummary(job) {
      if (!job) {
        return null;
      }
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
        agentPhase: job.agentState && job.agentState.phase ? job.agentState.phase : null,
        agentProfile: job.agentState && job.agentState.profile ? job.agentState.profile : null,
        updatedAt: job.updatedAt || null
      };
    }

    async _markFailed(job, error) {
      if (!job) {
        return;
      }
      this._abortJobRequests(job.id, 'FAILED');
      job.status = 'failed';
      job.lastError = {
        code: error && error.code ? error.code : 'TRANSLATION_FAILED',
        message: error && error.message ? error.message : 'Translation failed'
      };
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
        return { ok: false, error: { code: 'SCRIPTING_UNAVAILABLE', message: 'chrome.scripting is unavailable' } };
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
            resolvePath('core/translation-protocol.js'),
            resolvePath('content/dom-indexer.js'),
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
            message: error && error.message ? error.message : 'Failed to inject content runtime'
          }
        };
      }
    }

    async _sendToTab(tabId, message) {
      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.sendMessage !== 'function') {
        return { ok: false, error: { code: 'TABS_API_UNAVAILABLE', message: 'chrome.tabs.sendMessage unavailable' } };
      }
      try {
        return await new Promise((resolve) => {
          this.chromeApi.tabs.sendMessage(tabId, message, (response) => {
            const runtimeError = this.chromeApi.runtime && this.chromeApi.runtime.lastError
              ? this.chromeApi.runtime.lastError
              : null;
            if (runtimeError) {
              resolve({
                ok: false,
                error: {
                  code: 'TAB_SEND_FAILED',
                  message: runtimeError.message || 'tabs.sendMessage failed'
                }
              });
              return;
            }
            resolve(response && response.ok === false ? { ok: false, error: response.error || { code: 'UNKNOWN', message: 'Unknown tab error' } } : { ok: true, response });
          });
        });
      } catch (error) {
        return {
          ok: false,
          error: { code: 'TAB_SEND_FAILED', message: error && error.message ? error.message : 'tabs.sendMessage failed' }
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
        if (!prepared || !Array.isArray(prepared.blocks)) {
          return {
            blocks: safeBlocks,
            selectedCategories: [],
            agentState: null
          };
        }
        return prepared;
      } catch (error) {
        this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', 'Agent planning failed; fallback to default batching', {
          tabId: job && job.tabId !== undefined ? job.tabId : null,
          jobId: job && job.id ? job.id : null,
          message: error && error.message ? error.message : 'unknown'
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
          translationAgentTuning: {},
          translationCategoryMode: 'all',
          translationCategoryList: [],
          translationPageCacheEnabled: true,
          translationApiCacheEnabled: true
        };
      }
      const settings = await this.settingsStore.get([
        'translationAgentModelPolicy',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationCategoryMode',
        'translationCategoryList',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationModelList'
      ]);
      return {
        translationAgentModelPolicy: settings.translationAgentModelPolicy && typeof settings.translationAgentModelPolicy === 'object'
          ? settings.translationAgentModelPolicy
          : null,
        translationAgentProfile: settings.translationAgentProfile || 'auto',
        translationAgentTools: settings.translationAgentTools && typeof settings.translationAgentTools === 'object'
          ? settings.translationAgentTools
          : {},
        translationAgentTuning: settings.translationAgentTuning && typeof settings.translationAgentTuning === 'object'
          ? settings.translationAgentTuning
          : {},
        translationCategoryMode: settings.translationCategoryMode || 'all',
        translationCategoryList: Array.isArray(settings.translationCategoryList)
          ? settings.translationCategoryList
          : [],
        translationPageCacheEnabled: settings.translationPageCacheEnabled !== false,
        translationApiCacheEnabled: settings.translationApiCacheEnabled !== false,
        translationModelList: Array.isArray(settings.translationModelList) ? settings.translationModelList : []
      };
    }

    _buildPageSignature(blocks) {
      const list = Array.isArray(blocks) ? blocks : [];
      const src = list
        .map((item) => `${item.blockId}::${item.originalText || ''}::${item.category || ''}`)
        .join('|');
      let hash = 0;
      for (let i = 0; i < src.length; i += 1) {
        hash = ((hash << 5) - hash) + src.charCodeAt(i);
        hash |= 0;
      }
      return `p${list.length}:${Math.abs(hash)}`;
    }

    async _tryApplyCachedJob({ job, settings } = {}) {
      if (!this.pageCacheStore || !job || !job.url || !job.pageSignature) {
        return false;
      }
      const useCache = settings && settings.translationPageCacheEnabled !== false;
      if (!useCache || job.forceTranslate) {
        return false;
      }
      const cacheEntry = await this.pageCacheStore.getEntry({
        url: job.url,
        targetLang: job.targetLang || 'ru'
      });
      const cacheBlockCount = cacheEntry && Number.isFinite(Number(cacheEntry.blockCount))
        ? Number(cacheEntry.blockCount)
        : 0;
      if (!cacheEntry || cacheEntry.signature !== job.pageSignature || cacheBlockCount !== Number(job.totalBlocks || 0) || !Array.isArray(cacheEntry.items) || !cacheEntry.items.length) {
        return false;
      }

      const cacheItems = cacheEntry.items
        .filter((item) => item && item.blockId && typeof item.text === 'string')
        .map((item) => ({ blockId: item.blockId, text: item.text }));
      if (!cacheItems.length) {
        return false;
      }
      cacheItems.forEach((item) => {
        if (job.blocksById && job.blocksById[item.blockId]) {
          job.blocksById[item.blockId].translatedText = item.text;
        }
      });

      const protocol = NT.TranslationProtocol || {};
      const chunkSize = 40;
      let appliedTotal = 0;
      for (let offset = 0; offset < cacheItems.length; offset += chunkSize) {
        const items = cacheItems.slice(offset, offset + chunkSize);
        const batchId = `${job.id}:cache:${Math.floor(offset / chunkSize)}`;
        const sent = await this._sendToTab(job.tabId, {
          type: protocol.BG_APPLY_BATCH,
          jobId: job.id,
          batchId,
          items
        });
        if (!sent.ok) {
          return false;
        }
        const ack = await this._waitForApplyAck(job.id, batchId, this.APPLY_ACK_TIMEOUT_MS);
        if (!ack.ok) {
          return false;
        }
        appliedTotal += ack.appliedCount || items.length;
      }

      job.completedBlocks = Number(job.totalBlocks || 0);
      job.pendingBlockIds = [];
      job.failedBlockIds = [];
      job.status = 'done';
      job.message = 'Restored from translated page cache';
      job.recentDiffItems = [];
      if (this.translationAgent && job.agentState && typeof this.translationAgent.finalizeJob === 'function') {
        this.translationAgent.markPhase(job, 'cache_restore', 'Cache hit; applying stored translation');
        this.translationAgent.finalizeJob(job);
      }
      this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Translation restored from cache', {
        tabId: job.tabId,
        jobId: job.id,
        blockCount: appliedTotal
      });
      return true;
    }

    async _persistJobCache(job) {
      if (!this.pageCacheStore || !job || !job.pageSignature || !job.url) {
        return null;
      }
      if (job.status !== 'done') {
        return null;
      }
      if (!this._isFullCategorySelection(job.selectedCategories, job.availableCategories)) {
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
      return this.pageCacheStore.putEntry({
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
        contextSummary: job.agentState && typeof job.agentState.contextSummary === 'string' ? job.agentState.contextSummary : ''
      });
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
        return { ok: false, error: { code: 'JOB_NOT_FOUND', message: 'Job is missing' } };
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
            message: 'Original tab is unavailable and no replacement tab with matching URL was found'
          }
        };
      }

      await this._rebindJobToTab(job, recoveredTabId);
      this._emitEvent('warn', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Recovered translation job with replacement tab after restart', {
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
      job.message = 'Recovered after restart; reconnecting translation runtime';
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
  }

  NT.TranslationOrchestrator = TranslationOrchestrator;
})(globalThis);
