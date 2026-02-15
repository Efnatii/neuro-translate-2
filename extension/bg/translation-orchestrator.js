/**
 * Background orchestration for DOM translation jobs.
 *
 * The orchestrator owns job lifecycle, BG<->CS messaging, and per-tab status
 * synchronization for popup/debug pages.
 */
(function initTranslationOrchestrator(global) {
  const NT = global.NT || (global.NT = {});

  class TranslationOrchestrator {
    constructor({
      chromeApi,
      settingsStore,
      tabStateStore,
      jobStore,
      translationCall,
      eventFactory,
      eventLogFn,
      onUiPatch
    } = {}) {
      this.chromeApi = chromeApi;
      this.settingsStore = settingsStore || null;
      this.tabStateStore = tabStateStore || null;
      this.jobStore = jobStore || null;
      this.translationCall = translationCall || null;
      this.eventFactory = eventFactory || null;
      this.eventLogFn = typeof eventLogFn === 'function' ? eventLogFn : null;
      this.onUiPatch = typeof onUiPatch === 'function' ? onUiPatch : null;

      this.BATCH_SIZE = 8;
      this.JOB_LEASE_MS = 2 * 60 * 1000;
      this.APPLY_ACK_TIMEOUT_MS = 8000;
      this.processingJobs = new Set();
      this.pendingApplyAcks = new Map();
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

      const injected = await this._ensureContentRuntime(numericTabId);
      if (!injected.ok) {
        return injected;
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
        scanReceived: false
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

      job.status = 'cancelled';
      job.message = reason === 'REPLACED_BY_NEW_JOB' ? 'Cancelled: replaced by a new job' : 'Cancelled by user';
      job.lastError = reason === 'REPLACED_BY_NEW_JOB'
        ? null
        : { code: reason, message: 'Translation cancelled' };

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
        if (job.status === 'preparing') {
          await this._ensureContentRuntime(job.tabId);
          const protocol = NT.TranslationProtocol || {};
          await this._sendToTab(job.tabId, {
            type: protocol.BG_START_JOB,
            jobId: job.id,
            targetLang: job.targetLang || 'ru'
          });
          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_RESUME : 'translation.resume', 'Resumed translation job after restart', {
            tabId: job.tabId,
            jobId: job.id,
            status: job.status
          });
          continue;
        }
        if (job.status === 'running' || job.status === 'completing') {
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
      const blockIds = normalized.map((item) => item.blockId);
      const blocksById = {};
      normalized.forEach((item) => {
        blocksById[item.blockId] = item;
      });

      job.scanReceived = true;
      job.blocksById = blocksById;
      job.totalBlocks = normalized.length;
      job.pendingBlockIds = blockIds;
      job.failedBlockIds = [];
      job.completedBlocks = 0;
      job.status = normalized.length ? 'running' : 'done';
      job.message = normalized.length ? 'Translating text blocks' : 'No translatable blocks found';

      await this._saveJob(job, { setActive: job.status !== 'done', clearActive: job.status === 'done' });
      if (normalized.length) {
        this._processJob(job.id).catch(() => {});
      }
      return { ok: true, blockCount: normalized.length };
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
          const nextBatch = this._buildNextBatch(job);
          if (!nextBatch) {
            job.status = job.failedBlockIds.length ? 'failed' : 'done';
            job.message = job.failedBlockIds.length ? 'Completed with failed blocks' : 'Translation completed';
            await this._saveJob(job, { clearActive: true });
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
          job.message = `Translating batch ${batch.index + 1}`;
          await this._saveJob(job, { setActive: true });

          this._emitEvent('info', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_BATCH_SENT : 'translation.batch.sent', 'Translation batch requested', {
            tabId: job.tabId,
            jobId: job.id,
            batchId: batch.batchId,
            blockCount: batch.blocks.length,
            attempt: job.attempts + 1
          });

          try {
            const translated = await this.translationCall.translateBatch(batch.blocks, {
              tabId: job.tabId,
              jobId: job.id,
              batchId: batch.batchId,
              targetLang: job.targetLang || 'ru',
              attempt: (job.attempts || 0) + 1
            });

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
            refreshed.attempts = (refreshed.attempts || 0) + 1;
            refreshed.pendingBlockIds = refreshed.pendingBlockIds.filter((id) => !batch.blockIds.includes(id));
            refreshed.completedBlocks = Math.min(
              refreshed.totalBlocks,
              (refreshed.completedBlocks || 0) + (ack.appliedCount || batch.blockIds.length)
            );
            refreshed.currentBatchId = null;
            refreshed.message = 'Batch applied';
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
            refreshed.pendingBlockIds = refreshed.pendingBlockIds.filter((id) => !batch.blockIds.includes(id));
            refreshed.failedBlockIds = this._mergeUnique(refreshed.failedBlockIds, batch.blockIds);
            refreshed.currentBatchId = null;
            refreshed.lastError = {
              code: error && error.code ? error.code : 'BATCH_FAILED',
              message: error && error.message ? error.message : 'Batch translation failed'
            };
            refreshed.message = `Batch failed: ${refreshed.lastError.message}`;
            await this._saveJob(refreshed, { setActive: true });
          }
        }
      } finally {
        this.processingJobs.delete(jobId);
      }
    }

    _buildNextBatch(job) {
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

      this.onUiPatch({
        translationJob: this._toJobSummary(job),
        translationProgress,
        failedBlocksCount,
        lastError: job.lastError || null
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
        updatedAt: job.updatedAt || null
      };
    }

    async _markFailed(job, error) {
      if (!job) {
        return;
      }
      job.status = 'failed';
      job.lastError = {
        code: error && error.code ? error.code : 'TRANSLATION_FAILED',
        message: error && error.message ? error.message : 'Translation failed'
      };
      job.message = job.lastError.message;
      await this._saveJob(job, { clearActive: true });
      this._emitEvent('error', NT.EventTypes && NT.EventTypes.Tags ? NT.EventTypes.Tags.TRANSLATION_FAIL : 'translation.fail', job.lastError.message, {
        tabId: job.tabId,
        jobId: job.id,
        failedBlocksCount: Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0
      });
    }

    async _ensureContentRuntime(tabId) {
      if (!this.chromeApi || !this.chromeApi.scripting || typeof this.chromeApi.scripting.executeScript !== 'function') {
        return { ok: false, error: { code: 'SCRIPTING_UNAVAILABLE', message: 'chrome.scripting is unavailable' } };
      }
      try {
        await this.chromeApi.scripting.executeScript({
          target: { tabId },
          files: [
            'extension/core/nt-namespace.js',
            'extension/core/translation-protocol.js',
            'extension/content/dom-indexer.js',
            'extension/content/dom-applier.js',
            'extension/content/content-runtime.js'
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
          pathHint: item.pathHint || null
        });
      });
      return out;
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
  }

  NT.TranslationOrchestrator = TranslationOrchestrator;
})(globalThis);
