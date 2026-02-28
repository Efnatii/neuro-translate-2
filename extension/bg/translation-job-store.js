/**
 * Persistent translation-job registry.
 *
 * The store keeps both by-id and by-tab indexes to support fast reads from UI
 * snapshots and deterministic restart recovery.
 */
(function initTranslationJobStore(global) {
  const NT = global.NT || (global.NT = {});

  class TranslationJobStore extends NT.ChromeLocalStoreBase {
    constructor({ chromeApi } = {}) {
      super({ chromeApi });
      this.SCHEMA_VERSION = 3;
      this.KEY = 'nt.jobs.v3';
      this.LEGACY_KEYS = {
        schemaVersion: 'translationSchemaVersion',
        byTab: 'translationJobsByTab',
        byId: 'translationJobsById',
        indexByTab: 'translationJobIndexByTab'
      };
      this.DEFAULT_SNAPSHOT = {
        translationSchemaVersion: this.SCHEMA_VERSION,
        translationJobsByTab: {},
        translationJobsById: {},
        translationJobIndexByTab: {}
      };
      this.COMPACTION_DEFAULTS = Object.freeze({
        traceLimit: 160,
        patchLimit: 220,
        rateLimitLimit: 180,
        reportsLimit: 140,
        diffLimit: 24,
        sizeThresholdBytes: 260 * 1024,
        hardSizeThresholdBytes: 420 * 1024
      });
      this._mutationChain = Promise.resolve();
    }

    async getSnapshot() {
      return this._readSnapshot();
    }

    async ensureCanonicalSnapshot({ force = false, pruneLegacy = false } = {}) {
      const payload = await this.storageGet({
        [this.KEY]: null,
        [this.LEGACY_KEYS.schemaVersion]: this.SCHEMA_VERSION,
        [this.LEGACY_KEYS.byTab]: {},
        [this.LEGACY_KEYS.byId]: {},
        [this.LEGACY_KEYS.indexByTab]: {}
      });
      const hasCanonical = Boolean(payload && payload[this.KEY] && typeof payload[this.KEY] === 'object' && !Array.isArray(payload[this.KEY]));
      const snapshot = hasCanonical
        ? this._normalizeData(payload[this.KEY])
        : this._normalizeData({
          translationSchemaVersion: payload && payload[this.LEGACY_KEYS.schemaVersion],
          translationJobsByTab: payload && payload[this.LEGACY_KEYS.byTab],
          translationJobsById: payload && payload[this.LEGACY_KEYS.byId],
          translationJobIndexByTab: payload && payload[this.LEGACY_KEYS.indexByTab]
        });
      if (force || !hasCanonical) {
        await this._writeSnapshot(snapshot, { pruneLegacy });
      }
      return {
        ok: true,
        migrated: Boolean(force || !hasCanonical),
        snapshot
      };
    }

    async _withMutationLock(fn) {
      if (typeof fn !== 'function') {
        return null;
      }
      const current = this._mutationChain || Promise.resolve();
      let result = null;
      const next = current
        .catch(() => null)
        .then(async () => {
          result = await fn();
          return result;
        });
      this._mutationChain = next;
      try {
        await next;
        return result;
      } finally {
        if (this._mutationChain === next) {
          this._mutationChain = Promise.resolve();
        }
      }
    }

    async getJob(jobId) {
      if (!jobId) {
        return null;
      }
      const data = await this.getSnapshot();
      return data.translationJobsById[jobId] || null;
    }

    async getActiveJobId(tabId) {
      if (tabId === null || tabId === undefined) {
        return null;
      }
      const data = await this.getSnapshot();
      return data.translationJobsByTab[String(tabId)] || null;
    }

    async getActiveJob(tabId) {
      const jobId = await this.getActiveJobId(tabId);
      if (!jobId) {
        return null;
      }
      return this.getJob(jobId);
    }

    async getLastJobId(tabId) {
      if (tabId === null || tabId === undefined) {
        return null;
      }
      const data = await this.getSnapshot();
      const index = data.translationJobIndexByTab[String(tabId)] || null;
      return index && index.lastJobId ? index.lastJobId : null;
    }

    async upsertJob(job) {
      if (!job || !job.id) {
        return null;
      }
      return this._withMutationLock(async () => {
        const data = await this._readSnapshot();
        const mergedJob = {
          ...(data.translationJobsById[job.id] || {}),
          ...(job || {})
        };
        this.compactJobState(mergedJob);
        data.translationJobsById[job.id] = mergedJob;
        await this._writeSnapshot(data);
        return mergedJob;
      });
    }

    async saveJob(job, { setActive = false, clearActive = false } = {}) {
      if (!job || !job.id) {
        return null;
      }
      return this._withMutationLock(async () => {
        const data = await this._readSnapshot();
        const mergedJob = {
          ...(data.translationJobsById[job.id] || {}),
          ...(job || {})
        };
        this.compactJobState(mergedJob);
        data.translationJobsById[job.id] = mergedJob;

        const key = String(mergedJob.tabId);
        const now = Date.now();
        if (setActive) {
          data.translationJobsByTab[key] = mergedJob.id || null;
          const prev = data.translationJobIndexByTab[key] || {};
          data.translationJobIndexByTab[key] = {
            ...prev,
            activeJobId: mergedJob.id || null,
            lastJobId: mergedJob.id || prev.lastJobId || null,
            updatedAt: now
          };
        } else if (clearActive) {
          const current = data.translationJobsByTab[key] || null;
          if (!mergedJob.id || !current || current === mergedJob.id) {
            data.translationJobsByTab[key] = null;
            const prev = data.translationJobIndexByTab[key] || {};
            data.translationJobIndexByTab[key] = {
              ...prev,
              activeJobId: null,
              lastJobId: mergedJob.id || prev.lastJobId || null,
              updatedAt: now
            };
          }
        }

        await this._writeSnapshot(data);
        return mergedJob;
      });
    }

    async setActiveJob(tabId, jobId) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      await this._withMutationLock(async () => {
        const key = String(tabId);
        const now = Date.now();
        const data = await this._readSnapshot();
        data.translationJobsByTab[key] = jobId || null;
        const prev = data.translationJobIndexByTab[key] || {};
        data.translationJobIndexByTab[key] = {
          ...prev,
          activeJobId: jobId || null,
          lastJobId: jobId || prev.lastJobId || null,
          updatedAt: now
        };
        await this._writeSnapshot(data);
      });
    }

    async clearActiveJob(tabId, jobId) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      await this._withMutationLock(async () => {
        const key = String(tabId);
        const now = Date.now();
        const data = await this._readSnapshot();
        const current = data.translationJobsByTab[key] || null;
        if (jobId && current && current !== jobId) {
          return;
        }
        data.translationJobsByTab[key] = null;
        const prev = data.translationJobIndexByTab[key] || {};
        data.translationJobIndexByTab[key] = {
          ...prev,
          activeJobId: null,
          lastJobId: jobId || prev.lastJobId || null,
          updatedAt: now
        };
        await this._writeSnapshot(data);
      });
    }

    async listActiveJobs() {
      const data = await this.getSnapshot();
      const jobs = [];
      Object.keys(data.translationJobsByTab).forEach((tabKey) => {
        const jobId = data.translationJobsByTab[tabKey];
        if (!jobId) {
          return;
        }
        const job = data.translationJobsById[jobId];
        if (job) {
          jobs.push(job);
        }
      });
      return jobs;
    }

    async compactInactiveJobs({ traceLimit = 140, patchLimit = 220, diffLimit = 20 } = {}) {
      return this._withMutationLock(async () => {
        const data = await this._readSnapshot();
        const activeJobIds = new Set(
          Object.keys(data.translationJobsByTab || {})
            .map((tabKey) => data.translationJobsByTab[tabKey])
            .filter(Boolean)
        );
        const safeTraceLimit = Number.isFinite(Number(traceLimit)) ? Math.max(20, Number(traceLimit)) : 140;
        const safePatchLimit = Number.isFinite(Number(patchLimit)) ? Math.max(40, Number(patchLimit)) : 220;
        const safeDiffLimit = Number.isFinite(Number(diffLimit)) ? Math.max(10, Number(diffLimit)) : 20;
        let compactedJobs = 0;
        let changed = false;

        Object.keys(data.translationJobsById || {}).forEach((jobId) => {
          if (!jobId || activeJobIds.has(jobId)) {
            return;
          }
          const job = data.translationJobsById[jobId];
          if (!job || typeof job !== 'object') {
            return;
          }
          const nextJob = { ...job };
          const compacted = this.compactJobState(nextJob, {
            traceLimit: safeTraceLimit,
            patchLimit: safePatchLimit,
            reportsLimit: safeTraceLimit,
            diffLimit: safeDiffLimit
          });
          if (compacted.changed) {
            data.translationJobsById[jobId] = nextJob;
            compactedJobs += 1;
            changed = true;
          }
        });

        if (!changed) {
          return { ok: true, compactedJobs: 0 };
        }

        await this._writeSnapshot(data);
        return { ok: true, compactedJobs };
      });
    }

    async compactAllJobs({
      traceLimit,
      patchLimit,
      rateLimitLimit,
      reportsLimit,
      diffLimit,
      sizeThresholdBytes,
      hardSizeThresholdBytes,
      chunkSize = 25
    } = {}) {
      return this._withMutationLock(async () => {
        const data = await this._readSnapshot();
        const jobIds = Object.keys(data.translationJobsById || {});
        const safeChunk = Number.isFinite(Number(chunkSize)) ? Math.max(1, Math.round(Number(chunkSize))) : 25;
        let compactedJobs = 0;
        let scannedJobs = 0;
        let changed = false;
        for (let i = 0; i < jobIds.length; i += 1) {
          const jobId = jobIds[i];
          const job = data.translationJobsById[jobId];
          if (!job || typeof job !== 'object') {
            continue;
          }
          scannedJobs += 1;
          const nextJob = { ...job };
          const compacted = this.compactJobState(nextJob, {
            traceLimit,
            patchLimit,
            rateLimitLimit,
            reportsLimit,
            diffLimit,
            sizeThresholdBytes,
            hardSizeThresholdBytes
          });
          if (compacted.changed) {
            data.translationJobsById[jobId] = nextJob;
            compactedJobs += 1;
            changed = true;
          }
          if ((i + 1) % safeChunk === 0) {
            await new Promise((resolve) => global.setTimeout(resolve, 0));
          }
        }
        if (changed) {
          await this._writeSnapshot(data);
        }
        return {
          ok: true,
          changed,
          scannedJobs,
          compactedJobs
        };
      });
    }

    compactJobState(job, options = {}) {
      if (!job || typeof job !== 'object') {
        return { changed: false, sizeBefore: 0, sizeAfter: 0, compactedFields: [] };
      }
      const cfg = this._resolveCompactionConfig(options);
      const compactedFields = [];
      const droppedCounters = {};
      const sizeBefore = this._estimateJsonSize(job);
      let changed = false;
      const state = job.agentState && typeof job.agentState === 'object'
        ? { ...job.agentState }
        : null;

      const trimArrayField = (target, key, limit, fieldName = key) => {
        if (!target || typeof target !== 'object') {
          return;
        }
        const value = target[key];
        if (!Array.isArray(value)) {
          return;
        }
        const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Math.round(Number(limit))) : 0;
        if (!safeLimit || value.length <= safeLimit) {
          return;
        }
        const before = value.length;
        target[key] = value.slice(-safeLimit);
        changed = true;
        compactedFields.push(fieldName);
        droppedCounters[fieldName] = (droppedCounters[fieldName] || 0) + Math.max(0, before - target[key].length);
      };

      if (state) {
        trimArrayField(state, 'toolExecutionTrace', cfg.traceLimit);
        trimArrayField(state, 'toolHistory', cfg.traceLimit);
        trimArrayField(state, 'patchHistory', cfg.patchLimit);
        trimArrayField(state, 'rateLimitHistory', cfg.rateLimitLimit);

        if (Array.isArray(state.reports) && state.reports.length > cfg.reportsLimit) {
          const before = state.reports.length;
          state.reports = state.reports.slice(-cfg.reportsLimit);
          state.reportsSummary = state.reportsSummary && typeof state.reportsSummary === 'object'
            ? { ...state.reportsSummary }
            : {};
          state.reportsSummary.droppedTotal = Number.isFinite(Number(state.reportsSummary.droppedTotal))
            ? Number(state.reportsSummary.droppedTotal) + (before - state.reports.length)
            : (before - state.reports.length);
          state.reportsSummary.lastCompactedAt = Date.now();
          changed = true;
          compactedFields.push('reports');
          droppedCounters.reports = (droppedCounters.reports || 0) + (before - state.reports.length);
        }
      }

      if (Array.isArray(job.recentDiffItems) && job.recentDiffItems.length > cfg.diffLimit) {
        const before = job.recentDiffItems.length;
        job.recentDiffItems = job.recentDiffItems.slice(-cfg.diffLimit);
        changed = true;
        compactedFields.push('recentDiffItems');
        droppedCounters.recentDiffItems = (droppedCounters.recentDiffItems || 0) + (before - job.recentDiffItems.length);
      }

      if (sizeBefore > cfg.sizeThresholdBytes) {
        if (state) {
          trimArrayField(state, 'toolExecutionTrace', Math.min(cfg.traceLimit, 80), 'toolExecutionTrace.tight');
          trimArrayField(state, 'toolHistory', Math.min(cfg.traceLimit, 80), 'toolHistory.tight');
          trimArrayField(state, 'patchHistory', Math.min(cfg.patchLimit, 90), 'patchHistory.tight');
          trimArrayField(state, 'rateLimitHistory', Math.min(cfg.rateLimitLimit, 90), 'rateLimitHistory.tight');
          trimArrayField(state, 'reports', Math.min(cfg.reportsLimit, 80), 'reports.tight');
        }
        if (Array.isArray(job.recentDiffItems)) {
          const tightLimit = Math.min(cfg.diffLimit, 12);
          if (job.recentDiffItems.length > tightLimit) {
            const before = job.recentDiffItems.length;
            job.recentDiffItems = job.recentDiffItems.slice(-tightLimit);
            changed = true;
            compactedFields.push('recentDiffItems.tight');
            droppedCounters['recentDiffItems.tight'] = (droppedCounters['recentDiffItems.tight'] || 0) + (before - job.recentDiffItems.length);
          }
        }
      }

      if (state) {
        job.agentState = state;
      }

      let sizeAfter = this._estimateJsonSize(job);
      if (sizeAfter > cfg.hardSizeThresholdBytes && state && Array.isArray(state.patchHistory) && state.patchHistory.length) {
        let patched = false;
        state.patchHistory = state.patchHistory.map((row) => {
          if (!row || typeof row !== 'object') {
            return row;
          }
          const nextRow = { ...row };
          const compactPreview = (branch) => {
            if (!branch || typeof branch !== 'object') {
              return branch;
            }
            const out = { ...branch };
            if (typeof out.textPreview === 'string' && out.textPreview.length > 240) {
              out.textPreview = out.textPreview.slice(0, 240);
              patched = true;
            }
            return out;
          };
          nextRow.prev = compactPreview(nextRow.prev);
          nextRow.next = compactPreview(nextRow.next);
          return nextRow;
        });
        if (patched) {
          changed = true;
          compactedFields.push('patchHistory.preview');
          sizeAfter = this._estimateJsonSize(job);
        }
      }

      if (changed && state) {
        state.compactionMeta = state.compactionMeta && typeof state.compactionMeta === 'object'
          ? { ...state.compactionMeta }
          : {};
        state.compactionMeta.count = Number.isFinite(Number(state.compactionMeta.count))
          ? Number(state.compactionMeta.count) + 1
          : 1;
        state.compactionMeta.lastCompactedAt = Date.now();
        state.compactionMeta.lastSizeBefore = sizeBefore;
        state.compactionMeta.lastSizeAfter = sizeAfter;

        if (!Number.isFinite(Number(state.compactionMeta.reportedAt))) {
          state.reports = Array.isArray(state.reports) ? state.reports : [];
          state.reports.push({
            ts: Date.now(),
            status: 'warn',
            code: 'STATE_COMPACTED',
            message: 'Job state compacted to keep storage size bounded',
            details: {
              sizeBefore,
              sizeAfter,
              compactedFields: compactedFields.slice(0, 12)
            }
          });
          if (state.reports.length > cfg.reportsLimit) {
            state.reports = state.reports.slice(-cfg.reportsLimit);
          }
          state.compactionMeta.reportedAt = Date.now();
        }
        job.agentState = state;
      }

      if (changed) {
        job.updatedAt = Date.now();
      }
      return {
        changed,
        sizeBefore,
        sizeAfter,
        compactedFields: compactedFields.filter((field, idx, arr) => arr.indexOf(field) === idx),
        droppedCounters
      };
    }

    async repairIndices() {
      return this._withMutationLock(async () => {
        const snapshot = await this._readSnapshot();
        const jobsById = snapshot.translationJobsById && typeof snapshot.translationJobsById === 'object'
          ? snapshot.translationJobsById
          : {};
        const nextJobsByTab = {};
        const nextIndexByTab = {};
        const byTabBuckets = {};

        Object.keys(jobsById).forEach((jobId) => {
          const job = jobsById[jobId];
          if (!job || !Number.isFinite(Number(job.tabId))) {
            return;
          }
          const tabKey = String(Number(job.tabId));
          byTabBuckets[tabKey] = Array.isArray(byTabBuckets[tabKey]) ? byTabBuckets[tabKey] : [];
          byTabBuckets[tabKey].push({
            jobId,
            status: String(job.status || '').toLowerCase(),
            updatedAt: Number.isFinite(Number(job.updatedAt)) ? Number(job.updatedAt) : 0
          });
        });

        Object.keys(byTabBuckets).forEach((tabKey) => {
          const rows = byTabBuckets[tabKey].slice().sort((a, b) => {
            if (a.updatedAt !== b.updatedAt) {
              return b.updatedAt - a.updatedAt;
            }
            return String(b.jobId).localeCompare(String(a.jobId));
          });
          const latest = rows[0] || null;
          const active = rows.find((row) => row.status !== 'done' && row.status !== 'failed' && row.status !== 'cancelled') || null;
          nextJobsByTab[tabKey] = active ? active.jobId : null;
          nextIndexByTab[tabKey] = {
            activeJobId: active ? active.jobId : null,
            lastJobId: latest ? latest.jobId : null,
            updatedAt: Date.now()
          };
        });

        let changed = false;
        const prevByTab = snapshot.translationJobsByTab && typeof snapshot.translationJobsByTab === 'object'
          ? snapshot.translationJobsByTab
          : {};
        const prevIndex = snapshot.translationJobIndexByTab && typeof snapshot.translationJobIndexByTab === 'object'
          ? snapshot.translationJobIndexByTab
          : {};
        const serialize = (value) => {
          try {
            return JSON.stringify(value);
          } catch (_) {
            return '';
          }
        };
        if (serialize(prevByTab) !== serialize(nextJobsByTab) || serialize(prevIndex) !== serialize(nextIndexByTab)) {
          changed = true;
          snapshot.translationJobsByTab = nextJobsByTab;
          snapshot.translationJobIndexByTab = nextIndexByTab;
        }
        if (changed) {
          await this._writeSnapshot(snapshot);
        }
        return {
          ok: true,
          repaired: changed,
          tabCount: Object.keys(nextIndexByTab).length
        };
      });
    }

    async removeJob(jobId) {
      if (!jobId) {
        return false;
      }
      return this._withMutationLock(async () => {
        const data = await this._readSnapshot();
        if (!Object.prototype.hasOwnProperty.call(data.translationJobsById, jobId)) {
          return false;
        }
        delete data.translationJobsById[jobId];
        Object.keys(data.translationJobsByTab).forEach((tabKey) => {
          if (data.translationJobsByTab[tabKey] === jobId) {
            data.translationJobsByTab[tabKey] = null;
          }
        });
        Object.keys(data.translationJobIndexByTab).forEach((tabKey) => {
          const row = data.translationJobIndexByTab[tabKey] || {};
          if (row.activeJobId === jobId) {
            row.activeJobId = null;
          }
          if (row.lastJobId === jobId) {
            row.lastJobId = null;
          }
          data.translationJobIndexByTab[tabKey] = row;
        });
        await this._writeSnapshot(data);
        return true;
      });
    }

    async clearTabHistory(tabId) {
      if (tabId === null || tabId === undefined) {
        return false;
      }
      return this._withMutationLock(async () => {
        const key = String(tabId);
        const data = await this._readSnapshot();
        const index = data.translationJobIndexByTab[key] || {};
        const activeJobId = data.translationJobsByTab[key] || null;
        const lastJobId = index.lastJobId || null;
        data.translationJobsByTab[key] = null;
        data.translationJobIndexByTab[key] = {
          ...index,
          activeJobId: null,
          lastJobId: null,
          updatedAt: Date.now()
        };
        if (activeJobId && data.translationJobsById[activeJobId]) {
          delete data.translationJobsById[activeJobId];
        }
        if (lastJobId && data.translationJobsById[lastJobId]) {
          delete data.translationJobsById[lastJobId];
        }
        await this._writeSnapshot(data);
        return true;
      });
    }

    async replaceSnapshot(snapshot, { pruneLegacy = false } = {}) {
      return this._withMutationLock(async () => {
        const normalized = this._normalizeData(snapshot);
        await this._writeSnapshot(normalized, { pruneLegacy });
        return normalized;
      });
    }

    _resolveCompactionConfig(options = {}) {
      const source = options && typeof options === 'object' ? options : {};
      const defaults = this.COMPACTION_DEFAULTS;
      const getNumber = (value, fallback, min, max) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return fallback;
        }
        return Math.max(min, Math.min(max, Math.round(numeric)));
      };
      return {
        traceLimit: getNumber(source.traceLimit, defaults.traceLimit, 20, 1000),
        patchLimit: getNumber(source.patchLimit, defaults.patchLimit, 40, 2000),
        rateLimitLimit: getNumber(source.rateLimitLimit, defaults.rateLimitLimit, 20, 2000),
        reportsLimit: getNumber(source.reportsLimit, defaults.reportsLimit, 20, 1500),
        diffLimit: getNumber(source.diffLimit, defaults.diffLimit, 8, 200),
        sizeThresholdBytes: getNumber(source.sizeThresholdBytes, defaults.sizeThresholdBytes, 64 * 1024, 4 * 1024 * 1024),
        hardSizeThresholdBytes: getNumber(source.hardSizeThresholdBytes, defaults.hardSizeThresholdBytes, 96 * 1024, 6 * 1024 * 1024)
      };
    }

    _estimateJsonSize(value) {
      try {
        const raw = JSON.stringify(value);
        return typeof raw === 'string' ? raw.length : 0;
      } catch (_) {
        return 0;
      }
    }

    async _readSnapshot() {
      const data = await this.storageGet({
        [this.KEY]: null,
        [this.LEGACY_KEYS.schemaVersion]: this.SCHEMA_VERSION,
        [this.LEGACY_KEYS.byTab]: {},
        [this.LEGACY_KEYS.byId]: {},
        [this.LEGACY_KEYS.indexByTab]: {}
      });
      const current = data && data[this.KEY] && typeof data[this.KEY] === 'object'
        ? data[this.KEY]
        : null;
      if (current && !Array.isArray(current)) {
        return this._normalizeData(current);
      }
      const legacy = {
        translationSchemaVersion: data ? data[this.LEGACY_KEYS.schemaVersion] : this.SCHEMA_VERSION,
        translationJobsByTab: data ? data[this.LEGACY_KEYS.byTab] : {},
        translationJobsById: data ? data[this.LEGACY_KEYS.byId] : {},
        translationJobIndexByTab: data ? data[this.LEGACY_KEYS.indexByTab] : {}
      };
      const snapshot = this._normalizeData(legacy);
      await this._writeSnapshot(snapshot);
      return snapshot;
    }

    async _writeSnapshot(data, { pruneLegacy = false } = {}) {
      const snapshot = this._normalizeData(data);
      snapshot.translationSchemaVersion = this.SCHEMA_VERSION;
      const payload = {
        [this.KEY]: snapshot,
        [this.LEGACY_KEYS.schemaVersion]: this.SCHEMA_VERSION
      };
      await this.storageSet(payload);
      if (
        pruneLegacy
        && this.chromeApi
        && this.chromeApi.storage
        && this.chromeApi.storage.local
        && typeof this.chromeApi.storage.local.remove === 'function'
      ) {
        await new Promise((resolve) => {
          this.chromeApi.storage.local.remove([
            this.LEGACY_KEYS.byTab,
            this.LEGACY_KEYS.byId,
            this.LEGACY_KEYS.indexByTab
          ], () => resolve());
        });
      }
      return snapshot;
    }

    _normalizeData(data) {
      const src = data && typeof data === 'object' ? data : {};
      return {
        translationSchemaVersion: Number.isFinite(Number(src.translationSchemaVersion))
          ? Number(src.translationSchemaVersion)
          : this.SCHEMA_VERSION,
        translationJobsByTab: src.translationJobsByTab && typeof src.translationJobsByTab === 'object'
          ? { ...src.translationJobsByTab }
          : {},
        translationJobsById: src.translationJobsById && typeof src.translationJobsById === 'object'
          ? { ...src.translationJobsById }
          : {},
        translationJobIndexByTab: src.translationJobIndexByTab && typeof src.translationJobIndexByTab === 'object'
          ? { ...src.translationJobIndexByTab }
          : {}
      };
    }
  }

  NT.TranslationJobStore = TranslationJobStore;
})(globalThis);
