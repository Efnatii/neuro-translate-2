/**
 * Unified migration and integrity manager for persistent stores.
 *
 * Guarantees idempotent migrations across storage.local + IndexedDB and
 * provides recovery hooks for corrupted job/runtime states.
 */
(function initMigrationManager(global) {
  const NT = global.NT || (global.NT = {});

  class MigrationManager {
    constructor({
      chromeApi,
      settingsStore,
      translationJobStore,
      inflightStore,
      tabStateStore,
      translationMemoryStore,
      eventLogFn = null
    } = {}) {
      this.chromeApi = chromeApi || null;
      this.settingsStore = settingsStore || null;
      this.translationJobStore = translationJobStore || null;
      this.inflightStore = inflightStore || null;
      this.tabStateStore = tabStateStore || null;
      this.translationMemoryStore = translationMemoryStore || null;
      this.eventLogFn = typeof eventLogFn === 'function' ? eventLogFn : null;

      this.currentSchema = Object.freeze({
        storage: 3,
        idbMemory: 2,
        idbTools: 1
      });

      this.STATE_KEY = 'nt.migrations.state.v1';
      this.LAST_RUN_KEY = 'nt.migrations.lastRun';
      this.LAST_OK_KEY = 'nt.migrations.lastOk';
      this.LAST_ERROR_KEY = 'nt.migrations.lastError';
      this._cachedStatus = null;
    }

    async migrateAll({ reason = 'startup' } = {}) {
      const startedAt = Date.now();
      await this._setLocal({
        [this.LAST_RUN_KEY]: {
          ts: startedAt,
          reason: String(reason || 'startup'),
          schema: this.currentSchema
        }
      });
      try {
        const prevState = await this._readState();
        const storageFrom = Number(prevState.storage || 0);
        const idbMemoryFrom = Number(prevState.idbMemory || 0);
        const idbToolsFrom = Number(prevState.idbTools || 0);

        const storageResult = storageFrom < this.currentSchema.storage
          ? await this.migrateStorageLocal(storageFrom, this.currentSchema.storage)
          : { ok: true, changed: false };
        await this._yieldControl();

        const idbMemoryResult = idbMemoryFrom < this.currentSchema.idbMemory
          ? await this.migrateIndexedDbMemory(idbMemoryFrom, this.currentSchema.idbMemory)
          : { ok: true, changed: false };
        await this._yieldControl();

        const integrity = await this.verifyIntegrity();
        const finishedAt = Date.now();
        const state = {
          storage: this.currentSchema.storage,
          idbMemory: this.currentSchema.idbMemory,
          idbTools: this.currentSchema.idbTools,
          updatedAt: finishedAt
        };
        await this._setLocal({
          [this.STATE_KEY]: state,
          [this.LAST_OK_KEY]: {
            ts: finishedAt,
            reason: String(reason || 'startup'),
            elapsedMs: Math.max(0, finishedAt - startedAt),
            storageResult,
            idbMemoryResult,
            integrity
          },
          [this.LAST_ERROR_KEY]: null
        });
        const result = {
          ok: true,
          ts: finishedAt,
          elapsedMs: Math.max(0, finishedAt - startedAt),
          from: {
            storage: storageFrom,
            idbMemory: idbMemoryFrom,
            idbTools: idbToolsFrom
          },
          to: state,
          storageResult,
          idbMemoryResult,
          integrity
        };
        this._cachedStatus = result;
        return result;
      } catch (error) {
        const ts = Date.now();
        const lastError = {
          ts,
          reason: String(reason || 'startup'),
          message: error && error.message ? String(error.message) : 'migration failed',
          code: error && error.code ? String(error.code) : 'MIGRATION_FAILED'
        };
        await this._setLocal({ [this.LAST_ERROR_KEY]: lastError });
        this._cachedStatus = {
          ok: false,
          ts,
          error: lastError
        };
        this._emitEvent('warn', 'migration.error', 'Migration failed', lastError);
        throw error;
      }
    }

    async migrateStorageLocal(fromV, toV) {
      const fromVersion = Number.isFinite(Number(fromV)) ? Number(fromV) : 0;
      const toVersion = Number.isFinite(Number(toV)) ? Number(toV) : this.currentSchema.storage;
      const summary = {
        ok: true,
        from: fromVersion,
        to: toVersion,
        steps: []
      };

      if (this.settingsStore) {
        if (typeof this.settingsStore.ensureMigrated === 'function') {
          const out = await this.settingsStore.ensureMigrated().catch(() => ({ migrated: false }));
          summary.steps.push({ key: 'settings.ensureMigrated', ok: true, migrated: Boolean(out && out.migrated) });
        }
        if (typeof this.settingsStore.storageGet === 'function') {
          await this.settingsStore.storageGet(null).catch(() => ({}));
          summary.steps.push({ key: 'settings.canonical', ok: true });
        }
      }
      await this._yieldControl();

      if (this.translationJobStore && typeof this.translationJobStore.ensureCanonicalSnapshot === 'function') {
        const out = await this.translationJobStore.ensureCanonicalSnapshot({ pruneLegacy: true }).catch(() => ({ migrated: false }));
        summary.steps.push({ key: 'jobs.canonical', ok: true, migrated: Boolean(out && out.migrated) });
      }
      await this._yieldControl();

      if (this.inflightStore && typeof this.inflightStore.ensureCanonicalSnapshot === 'function') {
        const out = await this.inflightStore.ensureCanonicalSnapshot({ pruneLegacy: true }).catch(() => ({ migrated: false }));
        summary.steps.push({ key: 'inflight.canonical', ok: true, migrated: Boolean(out && out.migrated) });
      }
      await this._yieldControl();

      if (this.tabStateStore && typeof this.tabStateStore.ensureCanonicalSnapshot === 'function') {
        const out = await this.tabStateStore.ensureCanonicalSnapshot({ pruneLegacy: false }).catch(() => ({ migrated: false }));
        summary.steps.push({ key: 'tabs.canonical', ok: true, migrated: Boolean(out && out.migrated) });
      }
      await this._yieldControl();

      if (this.translationMemoryStore && typeof this.translationMemoryStore.ensureCanonicalIndex === 'function') {
        const out = await this.translationMemoryStore.ensureCanonicalIndex({ pruneLegacy: true }).catch(() => ({ migrated: false }));
        summary.steps.push({ key: 'memoryIndex.canonical', ok: true, migrated: Boolean(out && out.migrated) });
      }

      return summary;
    }

    async migrateIndexedDbMemory(fromV, toV) {
      const fromVersion = Number.isFinite(Number(fromV)) ? Number(fromV) : 0;
      const toVersion = Number.isFinite(Number(toV)) ? Number(toV) : this.currentSchema.idbMemory;
      if (!this.translationMemoryStore || typeof this.translationMemoryStore.init !== 'function') {
        return { ok: true, from: fromVersion, to: toVersion, skipped: true };
      }
      const initOut = await this.translationMemoryStore.init().catch((error) => ({
        ok: false,
        code: error && error.code ? error.code : 'IDB_INIT_FAILED',
        message: error && error.message ? error.message : 'indexeddb init failed'
      }));
      if (!initOut || initOut.ok === false) {
        const err = new Error(initOut && initOut.message ? initOut.message : 'indexeddb migration failed');
        err.code = initOut && initOut.code ? initOut.code : 'IDB_MIGRATION_FAILED';
        throw err;
      }
      return {
        ok: true,
        from: fromVersion,
        to: toVersion,
        changed: toVersion > fromVersion
      };
    }

    async verifyIntegrity({ yieldEvery = 30 } = {}) {
      const summary = {
        ok: true,
        jobs: {
          total: 0,
          repaired: 0,
          failedCorrupt: 0,
          inflightLostRequeued: 0
        },
        indices: {
          repaired: false
        },
        memory: null
      };
      const safeYield = Number.isFinite(Number(yieldEvery)) ? Math.max(5, Math.round(Number(yieldEvery))) : 30;

      if (this.translationJobStore && typeof this.translationJobStore.getSnapshot === 'function') {
        const snapshot = await this.translationJobStore.getSnapshot().catch(() => null);
        if (snapshot && snapshot.translationJobsById && typeof snapshot.translationJobsById === 'object') {
          const jobsById = snapshot.translationJobsById;
          const jobIds = Object.keys(jobsById);
          summary.jobs.total = jobIds.length;
          let changed = false;

          for (let i = 0; i < jobIds.length; i += 1) {
            const jobId = jobIds[i];
            const job = jobsById[jobId];
            if (!job || typeof job !== 'object') {
              delete jobsById[jobId];
              changed = true;
              summary.jobs.repaired += 1;
              continue;
            }
            const repaired = this._repairJobShape(job);
            if (repaired.changed) {
              changed = true;
              summary.jobs.repaired += 1;
            }
            if (repaired.failCorrupt) {
              this._markJobFailedCorrupt(job, repaired.issues);
              changed = true;
              summary.jobs.failedCorrupt += 1;
            } else if (await this._maybeRecoverInflightLost(job)) {
              changed = true;
              summary.jobs.inflightLostRequeued += 1;
            }
            if ((i + 1) % safeYield === 0) {
              await this._yieldControl();
            }
          }

          if (changed && typeof this.translationJobStore.replaceSnapshot === 'function') {
            await this.translationJobStore.replaceSnapshot(snapshot).catch(() => null);
          }

          if (typeof this.translationJobStore.repairIndices === 'function') {
            const indexResult = await this.translationJobStore.repairIndices().catch(() => ({ repaired: false }));
            summary.indices.repaired = Boolean(indexResult && indexResult.repaired);
          }
        }
      }

      if (this.translationMemoryStore && typeof this.translationMemoryStore.verifyIntegrity === 'function') {
        summary.memory = await this.translationMemoryStore.verifyIntegrity({
          quarantineCorrupt: true,
          deleteCorrupt: true
        }).catch((error) => ({
          ok: false,
          code: error && error.code ? error.code : 'MEMORY_VERIFY_FAILED',
          message: error && error.message ? error.message : 'memory integrity check failed'
        }));
      }

      return summary;
    }

    async repairIndexes({ compactJobs = true } = {}) {
      const out = {
        ok: true,
        repaired: {
          jobs: null,
          memory: null,
          compactedJobs: null
        }
      };
      if (this.translationJobStore && typeof this.translationJobStore.repairIndices === 'function') {
        out.repaired.jobs = await this.translationJobStore.repairIndices().catch(() => ({ ok: false, repaired: false }));
      }
      if (this.translationMemoryStore && typeof this.translationMemoryStore.repairIndex === 'function') {
        out.repaired.memory = await this.translationMemoryStore.repairIndex().catch(() => ({ ok: false }));
      }
      if (compactJobs && this.translationJobStore && typeof this.translationJobStore.compactAllJobs === 'function') {
        out.repaired.compactedJobs = await this.translationJobStore.compactAllJobs().catch(() => ({ ok: false }));
      }
      return out;
    }

    async exportStatus() {
      const local = await this._getLocal({
        [this.STATE_KEY]: null,
        [this.LAST_RUN_KEY]: null,
        [this.LAST_OK_KEY]: null,
        [this.LAST_ERROR_KEY]: null
      });
      return {
        ok: true,
        currentSchema: this.currentSchema,
        state: this._normalizeState(local && local[this.STATE_KEY]),
        lastRun: local ? local[this.LAST_RUN_KEY] || null : null,
        lastOk: local ? local[this.LAST_OK_KEY] || null : null,
        lastError: local ? local[this.LAST_ERROR_KEY] || null : null,
        cached: this._cachedStatus
      };
    }

    getCachedStatus() {
      return this._cachedStatus;
    }

    _repairJobShape(job) {
      const allowedStatuses = new Set(['preparing', 'planning', 'awaiting_categories', 'running', 'completing', 'done', 'failed', 'cancelled', 'idle']);
      const issues = [];
      let changed = false;

      if (!job.id || typeof job.id !== 'string') {
        issues.push('JOB_ID_MISSING');
      }
      if (!allowedStatuses.has(String(job.status || '').toLowerCase())) {
        issues.push('JOB_STATUS_INVALID');
      }
      if (!job.blocksById || typeof job.blocksById !== 'object' || Array.isArray(job.blocksById)) {
        job.blocksById = {};
        changed = true;
        issues.push('BLOCKS_INVALID');
      }
      if (!Array.isArray(job.pendingBlockIds)) {
        job.pendingBlockIds = [];
        changed = true;
        issues.push('PENDING_INVALID');
      }
      if (!Array.isArray(job.failedBlockIds)) {
        job.failedBlockIds = [];
        changed = true;
        issues.push('FAILED_INVALID');
      }
      if (!Number.isFinite(Number(job.totalBlocks)) || Number(job.totalBlocks) < 0) {
        job.totalBlocks = Math.max(0, Number(job.totalBlocks) || 0);
        changed = true;
        issues.push('TOTAL_INVALID');
      }
      if (!Number.isFinite(Number(job.completedBlocks)) || Number(job.completedBlocks) < 0) {
        job.completedBlocks = Math.max(0, Number(job.completedBlocks) || 0);
        changed = true;
        issues.push('COMPLETED_INVALID');
      }
      if (Number(job.completedBlocks) > Number(job.totalBlocks)) {
        issues.push('COUNTERS_NON_MONOTONIC');
        job.totalBlocks = Math.max(Number(job.totalBlocks) || 0, Number(job.completedBlocks) || 0);
        changed = true;
      }

      const status = String(job.status || '').toLowerCase();
      const runtime = job.runtime && typeof job.runtime === 'object' ? job.runtime : null;
      const stage = runtime && typeof runtime.stage === 'string' ? runtime.stage.toLowerCase() : '';
      const lease = runtime && runtime.lease && typeof runtime.lease === 'object' ? runtime.lease : null;
      const hasLease = Boolean(
        (lease && Number.isFinite(Number(lease.leaseUntilTs)) && Number(lease.leaseUntilTs) > 0)
        || (Number.isFinite(Number(job.leaseUntilTs)) && Number(job.leaseUntilTs) > 0)
      );
      const hasOpId = Boolean(lease && lease.opId);
      const pendingCount = Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0;
      const runningExecution = status === 'running' && (stage === 'execution' || !stage);
      const missingRuntimeForRunning = runningExecution && (!hasLease || !hasOpId || pendingCount <= 0);

      return {
        changed,
        issues,
        failCorrupt: Boolean(
          issues.includes('JOB_ID_MISSING')
          || issues.includes('JOB_STATUS_INVALID')
          || (issues.includes('COUNTERS_NON_MONOTONIC') && (status === 'running' || status === 'preparing' || status === 'completing'))
          || missingRuntimeForRunning
        )
      };
    }

    _markJobFailedCorrupt(job, issues) {
      const now = Date.now();
      const list = Array.isArray(issues) ? issues.slice(0, 12) : [];
      job.status = 'failed';
      job.message = 'Job state is corrupted and was safely stopped';
      job.lastError = {
        code: 'STATE_CORRUPT',
        message: 'Corrupted job state detected',
        details: { issues: list }
      };
      if (!job.runtime || typeof job.runtime !== 'object') {
        job.runtime = {};
      }
      job.runtime.status = 'FAILED';
      job.runtime.stage = 'execution';
      job.runtime.lease = job.runtime.lease && typeof job.runtime.lease === 'object'
        ? job.runtime.lease
        : {};
      job.runtime.lease.leaseUntilTs = null;
      job.runtime.lease.op = 'corrupt_state';
      job.runtime.lease.opId = null;
      job.leaseUntilTs = null;
      job.updatedAt = now;
      this._appendJobReport(job, {
        ts: now,
        status: 'error',
        code: 'STATE_CORRUPT',
        message: 'Job moved to FAILED due to integrity violation',
        details: { issues: list }
      });
    }

    async _maybeRecoverInflightLost(job) {
      if (!job || !this.inflightStore || typeof this.inflightStore.findByJobId !== 'function') {
        return false;
      }
      const status = String(job.status || '').toLowerCase();
      if (status !== 'running') {
        return false;
      }
      const pendingCount = Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0;
      if (pendingCount <= 0) {
        return false;
      }
      const pendingInflight = await this.inflightStore.findByJobId(job.id, { statuses: ['pending'], limit: 2 }).catch(() => []);
      if (Array.isArray(pendingInflight) && pendingInflight.length) {
        return false;
      }
      const now = Date.now();
      job.status = 'preparing';
      job.message = 'Recovered from lost in-flight request; requeued';
      job.lastError = {
        code: 'INFLIGHT_LOST',
        message: 'In-flight request record was lost; job requeued'
      };
      job.runtime = job.runtime && typeof job.runtime === 'object' ? job.runtime : {};
      job.runtime.status = 'QUEUED';
      job.runtime.stage = 'execution';
      job.runtime.lease = job.runtime.lease && typeof job.runtime.lease === 'object' ? job.runtime.lease : {};
      job.runtime.lease.leaseUntilTs = null;
      job.runtime.lease.op = 'inflight_lost';
      job.runtime.lease.opId = null;
      job.leaseUntilTs = null;
      job.updatedAt = now;
      this._appendJobReport(job, {
        ts: now,
        status: 'warn',
        code: 'INFLIGHT_LOST',
        message: 'Inflight request lost; job moved back to queue'
      });
      return true;
    }

    _appendJobReport(job, report) {
      if (!job || typeof job !== 'object') {
        return;
      }
      job.agentState = job.agentState && typeof job.agentState === 'object' ? job.agentState : {};
      job.agentState.reports = Array.isArray(job.agentState.reports) ? job.agentState.reports : [];
      job.agentState.reports.push(report);
      if (job.agentState.reports.length > 160) {
        job.agentState.reports = job.agentState.reports.slice(-160);
      }
    }

    async _readState() {
      const data = await this._getLocal({ [this.STATE_KEY]: null });
      return this._normalizeState(data && data[this.STATE_KEY]);
    }

    _normalizeState(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      return {
        storage: Number.isFinite(Number(src.storage)) ? Number(src.storage) : 0,
        idbMemory: Number.isFinite(Number(src.idbMemory)) ? Number(src.idbMemory) : 0,
        idbTools: Number.isFinite(Number(src.idbTools)) ? Number(src.idbTools) : 0,
        updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : 0
      };
    }

    async _yieldControl() {
      await new Promise((resolve) => global.setTimeout(resolve, 0));
    }

    async _getLocal(defaults) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return defaults || {};
      }
      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(defaults, (result) => {
          resolve(result || defaults || {});
        });
      });
    }

    async _setLocal(payload) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return;
      }
      await new Promise((resolve) => {
        this.chromeApi.storage.local.set(payload || {}, () => resolve());
      });
    }

    _emitEvent(level, tag, message, meta) {
      if (!this.eventLogFn) {
        return;
      }
      try {
        this.eventLogFn({
          level: level || 'info',
          tag: tag || 'migration',
          message: message || '',
          meta: meta && typeof meta === 'object' ? meta : {}
        });
      } catch (_) {
        // best-effort diagnostics only
      }
    }
  }

  NT.MigrationManager = MigrationManager;
})(globalThis);
