/**
 * Persistent fair queue for multi-tab translation jobs.
 *
 * Implements weighted round-robin by tab with optional active-tab boost and
 * pause-other-tabs mode.
 */
(function initJobQueue(global) {
  const NT = global.NT || (global.NT = {});

  class JobQueue extends NT.ChromeLocalStoreBase {
    constructor({
      chromeApi,
      storageKey = 'ntJobQueueV1'
    } = {}) {
      super({ chromeApi });
      this.storageKey = typeof storageKey === 'string' && storageKey ? storageKey : 'ntJobQueueV1';
    }

    _normalizePriority(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return 0;
      }
      return Math.max(-100, Math.min(100, numeric));
    }

    _normalizeEntry(jobId, src) {
      const source = src && typeof src === 'object' ? src : {};
      const now = Date.now();
      return {
        jobId,
        tabId: Number.isFinite(Number(source.tabId)) ? Number(source.tabId) : null,
        priority: this._normalizePriority(source.priority),
        status: source.status === 'running'
          ? 'running'
          : (source.status === 'waiting' ? 'waiting' : 'queued'),
        nextAtTs: Number.isFinite(Number(source.nextAtTs)) ? Number(source.nextAtTs) : 0,
        reason: typeof source.reason === 'string' ? source.reason : '',
        leaseUntilTs: Number.isFinite(Number(source.leaseUntilTs)) ? Number(source.leaseUntilTs) : null,
        enqueuedTs: Number.isFinite(Number(source.enqueuedTs)) ? Number(source.enqueuedTs) : now,
        updatedAt: Number.isFinite(Number(source.updatedAt)) ? Number(source.updatedAt) : now,
        dequeuedCount: Number.isFinite(Number(source.dequeuedCount)) ? Number(source.dequeuedCount) : 0,
        lastDequeuedTs: Number.isFinite(Number(source.lastDequeuedTs)) ? Number(source.lastDequeuedTs) : 0
      };
    }

    _normalizeState(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const entriesByJobId = src.entriesByJobId && typeof src.entriesByJobId === 'object'
        ? src.entriesByJobId
        : {};
      const normalized = {
        v: 1,
        activeTabId: Number.isFinite(Number(src.activeTabId)) ? Number(src.activeTabId) : null,
        pauseOtherTabs: src.pauseOtherTabs === true,
        entriesByJobId: {},
        tabOrder: Array.isArray(src.tabOrder)
          ? src.tabOrder.map((item) => Number(item)).filter((item) => Number.isFinite(item))
          : [],
        tabCursor: Number.isFinite(Number(src.tabCursor)) ? Math.max(0, Number(src.tabCursor)) : 0,
        updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : Date.now()
      };
      Object.keys(entriesByJobId).forEach((jobId) => {
        if (!jobId) {
          return;
        }
        normalized.entriesByJobId[jobId] = this._normalizeEntry(jobId, entriesByJobId[jobId]);
      });
      normalized.tabOrder = this._rebuildTabOrder(normalized);
      return normalized;
    }

    _rebuildTabOrder(state) {
      const src = state && state.entriesByJobId && typeof state.entriesByJobId === 'object'
        ? state.entriesByJobId
        : {};
      const existing = Array.isArray(state && state.tabOrder)
        ? state.tabOrder.filter((tabId) => Number.isFinite(Number(tabId))).map((tabId) => Number(tabId))
        : [];
      const presentSet = new Set();
      Object.keys(src).forEach((jobId) => {
        const row = src[jobId];
        if (!row || !Number.isFinite(Number(row.tabId))) {
          return;
        }
        presentSet.add(Number(row.tabId));
      });
      const out = [];
      existing.forEach((tabId) => {
        if (presentSet.has(tabId) && !out.includes(tabId)) {
          out.push(tabId);
        }
      });
      Array.from(presentSet.values()).forEach((tabId) => {
        if (!out.includes(tabId)) {
          out.push(tabId);
        }
      });
      return out;
    }

    async _loadState() {
      const data = await this.storageGet({
        [this.storageKey]: {
          v: 1,
          activeTabId: null,
          pauseOtherTabs: false,
          entriesByJobId: {},
          tabOrder: [],
          tabCursor: 0,
          updatedAt: Date.now()
        }
      });
      return this._normalizeState(data && data[this.storageKey]);
    }

    async _saveState(stateLike) {
      const normalized = this._normalizeState(stateLike);
      normalized.updatedAt = Date.now();
      await this.storageSet({ [this.storageKey]: normalized });
      return normalized;
    }

    _tabWeight(tabId, activeTabId) {
      if (!Number.isFinite(Number(tabId))) {
        return 1;
      }
      if (Number.isFinite(Number(activeTabId)) && Number(tabId) === Number(activeTabId)) {
        return 2;
      }
      return 1;
    }

    _chooseEntryForTab(state, tabId, nowTs) {
      const entries = state && state.entriesByJobId && typeof state.entriesByJobId === 'object'
        ? state.entriesByJobId
        : {};
      const candidates = Object.keys(entries)
        .map((jobId) => entries[jobId])
        .filter((row) => row && Number(row.tabId) === Number(tabId))
        .filter((row) => row.status === 'queued' || row.status === 'waiting')
        .filter((row) => Number(row.nextAtTs || 0) <= nowTs);
      if (!candidates.length) {
        return null;
      }
      candidates.sort((a, b) => {
        const byPriority = Number(b.priority || 0) - Number(a.priority || 0);
        if (byPriority !== 0) {
          return byPriority;
        }
        const aUpdated = Number.isFinite(Number(a.updatedAt)) ? Number(a.updatedAt) : 0;
        const bUpdated = Number.isFinite(Number(b.updatedAt)) ? Number(b.updatedAt) : 0;
        if (aUpdated !== bUpdated) {
          return aUpdated - bUpdated;
        }
        return String(a.jobId || '').localeCompare(String(b.jobId || ''));
      });
      return candidates[0];
    }

    _nextReadyAt(state) {
      const entries = state && state.entriesByJobId && typeof state.entriesByJobId === 'object'
        ? state.entriesByJobId
        : {};
      let nextAt = null;
      Object.keys(entries).forEach((jobId) => {
        const row = entries[jobId];
        if (!row || row.status !== 'waiting') {
          return;
        }
        if (!Number.isFinite(Number(row.nextAtTs))) {
          return;
        }
        const ts = Number(row.nextAtTs);
        if (nextAt === null || ts < nextAt) {
          nextAt = ts;
        }
      });
      return nextAt;
    }

    async setActiveTab(tabId) {
      const state = await this._loadState();
      state.activeTabId = Number.isFinite(Number(tabId)) ? Number(tabId) : null;
      await this._saveState(state);
      return state.activeTabId;
    }

    async setPauseOtherTabs({ enabled, activeTabId = null } = {}) {
      const state = await this._loadState();
      state.pauseOtherTabs = enabled === true;
      if (Number.isFinite(Number(activeTabId))) {
        state.activeTabId = Number(activeTabId);
      }
      await this._saveState(state);
      return {
        pauseOtherTabs: state.pauseOtherTabs,
        activeTabId: state.activeTabId
      };
    }

    async enqueue(jobId, priority = 0, reason = '', meta = null) {
      const safeJobId = typeof jobId === 'string' ? jobId.trim() : '';
      if (!safeJobId) {
        return null;
      }
      const state = await this._loadState();
      const prev = state.entriesByJobId[safeJobId];
      const tabId = meta && Number.isFinite(Number(meta.tabId))
        ? Number(meta.tabId)
        : (prev && Number.isFinite(Number(prev.tabId)) ? Number(prev.tabId) : null);
      state.entriesByJobId[safeJobId] = this._normalizeEntry(safeJobId, {
        ...(prev || {}),
        tabId,
        priority: this._normalizePriority(priority),
        status: 'queued',
        nextAtTs: 0,
        reason: typeof reason === 'string' ? reason : '',
        leaseUntilTs: null,
        updatedAt: Date.now()
      });
      state.tabOrder = this._rebuildTabOrder(state);
      await this._saveState(state);
      return state.entriesByJobId[safeJobId];
    }

    async dequeueNext({ now = Date.now(), activeTabId = null } = {}) {
      const state = await this._loadState();
      if (Number.isFinite(Number(activeTabId))) {
        state.activeTabId = Number(activeTabId);
      }
      state.tabOrder = this._rebuildTabOrder(state);
      if (!state.tabOrder.length) {
        await this._saveState(state);
        return { jobId: null, nextAtTs: this._nextReadyAt(state) };
      }
      const startIdx = state.tabCursor % state.tabOrder.length;
      const rotated = [];
      for (let i = 0; i < state.tabOrder.length; i += 1) {
        rotated.push(state.tabOrder[(startIdx + i) % state.tabOrder.length]);
      }
      const prioritized = rotated.slice();
      if (Number.isFinite(Number(state.activeTabId))) {
        const activeIdx = prioritized.indexOf(Number(state.activeTabId));
        if (activeIdx > 0) {
          prioritized.splice(activeIdx, 1);
          prioritized.unshift(Number(state.activeTabId));
        }
      }
      const weightedTabs = [];
      prioritized.forEach((tabId) => {
        if (state.pauseOtherTabs === true && Number.isFinite(Number(state.activeTabId)) && Number(tabId) !== Number(state.activeTabId)) {
          return;
        }
        const weight = this._tabWeight(tabId, state.activeTabId);
        for (let i = 0; i < weight; i += 1) {
          weightedTabs.push(tabId);
        }
      });

      let picked = null;
      for (let i = 0; i < weightedTabs.length; i += 1) {
        const tabId = weightedTabs[i];
        const row = this._chooseEntryForTab(state, tabId, Number(now));
        if (row) {
          picked = row;
          break;
        }
      }

      if (!picked) {
        await this._saveState(state);
        return { jobId: null, nextAtTs: this._nextReadyAt(state) };
      }

      const tabIdx = state.tabOrder.indexOf(Number(picked.tabId));
      state.tabCursor = tabIdx < 0
        ? ((state.tabCursor + 1) % Math.max(1, state.tabOrder.length))
        : ((tabIdx + 1) % Math.max(1, state.tabOrder.length));
      state.entriesByJobId[picked.jobId] = this._normalizeEntry(picked.jobId, {
        ...picked,
        status: 'queued',
        dequeuedCount: Number(picked.dequeuedCount || 0) + 1,
        lastDequeuedTs: Date.now(),
        updatedAt: Date.now()
      });
      await this._saveState(state);
      return {
        jobId: picked.jobId,
        tabId: picked.tabId,
        priority: picked.priority,
        reason: picked.reason,
        nextAtTs: 0
      };
    }

    async markRunning(jobId, leaseUntilTs) {
      const safeJobId = typeof jobId === 'string' ? jobId.trim() : '';
      if (!safeJobId) {
        return null;
      }
      const state = await this._loadState();
      const prev = state.entriesByJobId[safeJobId];
      if (!prev) {
        return null;
      }
      state.entriesByJobId[safeJobId] = this._normalizeEntry(safeJobId, {
        ...prev,
        status: 'running',
        leaseUntilTs: Number.isFinite(Number(leaseUntilTs)) ? Number(leaseUntilTs) : null,
        updatedAt: Date.now()
      });
      await this._saveState(state);
      return state.entriesByJobId[safeJobId];
    }

    async markWaiting(jobId, nextAtTs, reason = '') {
      const safeJobId = typeof jobId === 'string' ? jobId.trim() : '';
      if (!safeJobId) {
        return null;
      }
      const state = await this._loadState();
      const prev = state.entriesByJobId[safeJobId];
      if (!prev) {
        return null;
      }
      state.entriesByJobId[safeJobId] = this._normalizeEntry(safeJobId, {
        ...prev,
        status: 'waiting',
        nextAtTs: Number.isFinite(Number(nextAtTs))
          ? Number(nextAtTs)
          : 0,
        reason: typeof reason === 'string' ? reason : prev.reason,
        leaseUntilTs: null,
        updatedAt: Date.now()
      });
      await this._saveState(state);
      return state.entriesByJobId[safeJobId];
    }

    async markDone(jobId) {
      const safeJobId = typeof jobId === 'string' ? jobId.trim() : '';
      if (!safeJobId) {
        return false;
      }
      const state = await this._loadState();
      if (!state.entriesByJobId[safeJobId]) {
        return false;
      }
      delete state.entriesByJobId[safeJobId];
      state.tabOrder = this._rebuildTabOrder(state);
      if (!state.tabOrder.length) {
        state.tabCursor = 0;
      } else if (state.tabCursor >= state.tabOrder.length) {
        state.tabCursor = state.tabCursor % state.tabOrder.length;
      }
      await this._saveState(state);
      return true;
    }

    _derivePriority(job, activeTabId) {
      const status = String(job && job.status ? job.status : '').toLowerCase();
      let score = 0;
      if (status === 'running' || status === 'completing') {
        score += 1;
      }
      if (status === 'preparing') {
        score += 0.5;
      }
      if (Number.isFinite(Number(activeTabId)) && Number(job && job.tabId) === Number(activeTabId)) {
        score += 1;
      }
      const retry = job && job.runtime && job.runtime.retry && typeof job.runtime.retry === 'object'
        ? job.runtime.retry
        : null;
      if (retry && Number.isFinite(Number(retry.attempt)) && Number(retry.attempt) > 0) {
        score -= 0.4;
      }
      return this._normalizePriority(score);
    }

    async syncFromJobs(activeJobs, { activeTabId = null } = {}) {
      const state = await this._loadState();
      if (Number.isFinite(Number(activeTabId))) {
        state.activeTabId = Number(activeTabId);
      }
      const now = Date.now();
      const jobs = Array.isArray(activeJobs) ? activeJobs : [];
      const activeSet = new Set();

      for (let i = 0; i < jobs.length; i += 1) {
        const job = jobs[i];
        if (!job || !job.id) {
          continue;
        }
        activeSet.add(job.id);
        const status = String(job.status || '').toLowerCase();
        if (status === 'done' || status === 'failed' || status === 'cancelled') {
          delete state.entriesByJobId[job.id];
          continue;
        }
        const retry = job.runtime && job.runtime.retry && typeof job.runtime.retry === 'object'
          ? job.runtime.retry
          : null;
        const nextRetryAtTs = retry && Number.isFinite(Number(retry.nextRetryAtTs))
          ? Number(retry.nextRetryAtTs)
          : 0;
        const prev = state.entriesByJobId[job.id] || {};
        if (status === 'awaiting_categories') {
          state.entriesByJobId[job.id] = this._normalizeEntry(job.id, {
            ...prev,
            tabId: Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : prev.tabId,
            priority: this._derivePriority(job, state.activeTabId),
            status: 'waiting',
            nextAtTs: Number.MAX_SAFE_INTEGER,
            reason: 'AWAITING_CATEGORIES',
            leaseUntilTs: null,
            updatedAt: now
          });
          continue;
        }
        if (nextRetryAtTs > now) {
          state.entriesByJobId[job.id] = this._normalizeEntry(job.id, {
            ...prev,
            tabId: Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : prev.tabId,
            priority: this._derivePriority(job, state.activeTabId),
            status: 'waiting',
            nextAtTs: nextRetryAtTs,
            reason: retry && retry.lastError && retry.lastError.code
              ? String(retry.lastError.code)
              : 'RETRY_BACKOFF',
            leaseUntilTs: null,
            updatedAt: now
          });
          continue;
        }
        state.entriesByJobId[job.id] = this._normalizeEntry(job.id, {
          ...prev,
          tabId: Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : prev.tabId,
          priority: this._derivePriority(job, state.activeTabId),
          status: 'queued',
          nextAtTs: 0,
          reason: 'READY',
          leaseUntilTs: null,
          updatedAt: now
        });
      }

      Object.keys(state.entriesByJobId).forEach((jobId) => {
        if (!activeSet.has(jobId)) {
          delete state.entriesByJobId[jobId];
        }
      });
      state.tabOrder = this._rebuildTabOrder(state);
      await this._saveState(state);
      return this.stats();
    }

    async peek() {
      const out = await this.dequeueNext({ now: Date.now() });
      if (!out || !out.jobId) {
        return null;
      }
      const state = await this._loadState();
      const row = state.entriesByJobId[out.jobId];
      if (row) {
        row.dequeuedCount = Math.max(0, Number(row.dequeuedCount || 1) - 1);
        row.lastDequeuedTs = 0;
        await this._saveState(state);
      }
      return out;
    }

    async stats() {
      const state = await this._loadState();
      const entries = Object.keys(state.entriesByJobId).map((jobId) => state.entriesByJobId[jobId]).filter(Boolean);
      const queuedCount = entries.filter((row) => row.status === 'queued').length;
      const runningCount = entries.filter((row) => row.status === 'running').length;
      const waitingCount = entries.filter((row) => row.status === 'waiting').length;
      const nextAtTs = this._nextReadyAt(state);
      return {
        total: entries.length,
        queuedCount,
        runningCount,
        waitingCount,
        activeTabId: state.activeTabId,
        pauseOtherTabs: state.pauseOtherTabs === true,
        tabCount: state.tabOrder.length,
        tabOrder: state.tabOrder.slice(),
        nextAtTs: Number.isFinite(Number(nextAtTs)) ? Number(nextAtTs) : null
      };
    }
  }

  NT.JobQueue = JobQueue;
})(globalThis);
