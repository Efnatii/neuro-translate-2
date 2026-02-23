/**
 * Persistent multi-tab session registry.
 *
 * Keeps lightweight tab/session metadata in storage.local and links tabs to
 * active translation jobs without duplicating full job payload.
 */
(function initTabSessionManager(global) {
  const NT = global.NT || (global.NT = {});

  class TabSessionManager extends NT.ChromeLocalStoreBase {
    constructor({
      chromeApi,
      jobStore,
      tabStateStore,
      normalizeUrlFn,
      storageKey = 'tabSessionsIndex'
    } = {}) {
      super({ chromeApi });
      this.jobStore = jobStore || null;
      this.tabStateStore = tabStateStore || null;
      this.storageKey = typeof storageKey === 'string' && storageKey ? storageKey : 'tabSessionsIndex';
      this.normalizeUrlFn = typeof normalizeUrlFn === 'function'
        ? normalizeUrlFn
        : ((value) => String(value || '').trim());
      this.activeTabId = null;
    }

    async _loadIndex() {
      const data = await this.storageGet({
        [this.storageKey]: {
          v: 1,
          activeTabId: null,
          sessionsByTab: {},
          updatedAt: Date.now()
        }
      });
      const raw = data && data[this.storageKey] && typeof data[this.storageKey] === 'object'
        ? data[this.storageKey]
        : {};
      const sessionsByTab = raw.sessionsByTab && typeof raw.sessionsByTab === 'object'
        ? { ...raw.sessionsByTab }
        : {};
      const normalized = {
        v: 1,
        activeTabId: Number.isFinite(Number(raw.activeTabId)) ? Number(raw.activeTabId) : null,
        sessionsByTab: {},
        updatedAt: Number.isFinite(Number(raw.updatedAt)) ? Number(raw.updatedAt) : Date.now()
      };
      Object.keys(sessionsByTab).forEach((tabKey) => {
        const tabId = Number(tabKey);
        if (!Number.isFinite(tabId)) {
          return;
        }
        normalized.sessionsByTab[String(tabId)] = this._normalizeSession(tabId, sessionsByTab[tabKey]);
      });
      this.activeTabId = normalized.activeTabId;
      return normalized;
    }

    async _saveIndex(indexLike) {
      const src = indexLike && typeof indexLike === 'object' ? indexLike : {};
      const sessionsByTab = src.sessionsByTab && typeof src.sessionsByTab === 'object'
        ? src.sessionsByTab
        : {};
      const out = {
        v: 1,
        activeTabId: Number.isFinite(Number(src.activeTabId))
          ? Number(src.activeTabId)
          : (Number.isFinite(Number(this.activeTabId)) ? Number(this.activeTabId) : null),
        sessionsByTab: {},
        updatedAt: Date.now()
      };
      Object.keys(sessionsByTab).forEach((tabKey) => {
        const tabId = Number(tabKey);
        if (!Number.isFinite(tabId)) {
          return;
        }
        out.sessionsByTab[String(tabId)] = this._normalizeSession(tabId, sessionsByTab[tabKey]);
      });
      this.activeTabId = out.activeTabId;
      await this.storageSet({ [this.storageKey]: out });
      return out;
    }

    _statusToState(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'preparing') return 'scanned';
      if (raw === 'awaiting_categories') return 'awaiting_categories';
      if (raw === 'running' || raw === 'completing') return 'executing';
      if (raw === 'done') return 'done';
      if (raw === 'failed' || raw === 'cancelled') return 'failed';
      return 'idle';
    }

    _normalizeSession(tabId, source) {
      const src = source && typeof source === 'object' ? source : {};
      const normalizedUrl = src.normalizedUrl || this.normalizeUrlFn(src.url || '');
      return {
        tabId: Number(tabId),
        url: typeof src.url === 'string' ? src.url : '',
        normalizedUrl: typeof normalizedUrl === 'string' ? normalizedUrl : '',
        activeJobId: src.activeJobId || null,
        lastSeenTs: Number.isFinite(Number(src.lastSeenTs)) ? Number(src.lastSeenTs) : Date.now(),
        contentCaps: src.contentCaps && typeof src.contentCaps === 'object' ? src.contentCaps : null,
        pageKey: typeof src.pageKey === 'string' ? src.pageKey : null,
        domHash: typeof src.domHash === 'string' ? src.domHash : null,
        state: typeof src.state === 'string' ? src.state : 'idle',
        needsRescan: src.needsRescan === true
      };
    }

    async hydrateFromStores() {
      const index = await this._loadIndex();
      const snapshot = this.jobStore && typeof this.jobStore.getSnapshot === 'function'
        ? await this.jobStore.getSnapshot().catch(() => null)
        : null;
      const statusByTab = this.tabStateStore && typeof this.tabStateStore.getAllStatus === 'function'
        ? await this.tabStateStore.getAllStatus().catch(() => ({}))
        : {};

      const jobsByTab = snapshot && snapshot.translationJobsByTab && typeof snapshot.translationJobsByTab === 'object'
        ? snapshot.translationJobsByTab
        : {};
      const jobsById = snapshot && snapshot.translationJobsById && typeof snapshot.translationJobsById === 'object'
        ? snapshot.translationJobsById
        : {};
      const tabs = new Set([
        ...Object.keys(index.sessionsByTab || {}),
        ...Object.keys(jobsByTab || {}),
        ...Object.keys(statusByTab || {})
      ]);

      tabs.forEach((tabKey) => {
        const tabId = Number(tabKey);
        if (!Number.isFinite(tabId)) {
          return;
        }
        const prev = this._normalizeSession(tabId, index.sessionsByTab[String(tabId)] || null);
        const activeJobId = jobsByTab[String(tabId)] || prev.activeJobId || null;
        const job = activeJobId && jobsById[activeJobId] ? jobsById[activeJobId] : null;
        const status = statusByTab[String(tabId)] || statusByTab[tabId] || null;
        const url = (job && typeof job.url === 'string' && job.url)
          ? job.url
          : (status && typeof status.url === 'string' ? status.url : prev.url);
        const normalizedUrl = this.normalizeUrlFn(url || prev.normalizedUrl || '');
        const state = job && job.status
          ? this._statusToState(job.status)
          : prev.state;
        index.sessionsByTab[String(tabId)] = this._normalizeSession(tabId, {
          ...prev,
          url: url || '',
          normalizedUrl,
          activeJobId,
          pageKey: job && job.pageKey ? job.pageKey : (prev.pageKey || null),
          domHash: job && job.domHash ? job.domHash : (prev.domHash || null),
          state,
          lastSeenTs: Date.now(),
          needsRescan: prev.needsRescan === true
        });
      });

      await this._saveIndex(index);
      return this.listSessions();
    }

    async getOrCreate(tabId, seed = null) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return null;
      }
      const index = await this._loadIndex();
      const prev = index.sessionsByTab[String(numericTabId)] || null;
      const normalized = this._normalizeSession(numericTabId, {
        ...(prev || {}),
        ...(seed && typeof seed === 'object' ? seed : {}),
        tabId: numericTabId,
        lastSeenTs: Date.now()
      });
      index.sessionsByTab[String(numericTabId)] = normalized;
      await this._saveIndex(index);
      return normalized;
    }

    async attachJob(tabId, jobId, extras = null) {
      const session = await this.getOrCreate(tabId, {
        activeJobId: jobId || null,
        state: extras && extras.state ? extras.state : 'planning',
        pageKey: extras && extras.pageKey ? extras.pageKey : null,
        domHash: extras && extras.domHash ? extras.domHash : null,
        needsRescan: false
      });
      return session;
    }

    async detachJob(tabId, jobId) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return null;
      }
      const index = await this._loadIndex();
      const current = index.sessionsByTab[String(numericTabId)] || null;
      if (!current) {
        return null;
      }
      if (jobId && current.activeJobId && current.activeJobId !== jobId) {
        return this._normalizeSession(numericTabId, current);
      }
      index.sessionsByTab[String(numericTabId)] = this._normalizeSession(numericTabId, {
        ...current,
        activeJobId: null,
        state: 'idle',
        needsRescan: false,
        lastSeenTs: Date.now()
      });
      await this._saveIndex(index);
      return index.sessionsByTab[String(numericTabId)];
    }

    async setContentCaps(tabId, contentCaps) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return null;
      }
      const session = await this.getOrCreate(numericTabId, {
        contentCaps: contentCaps && typeof contentCaps === 'object'
          ? { ...contentCaps }
          : null
      });
      return session;
    }

    async onTabRemoved(tabId) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return null;
      }
      const index = await this._loadIndex();
      const existing = index.sessionsByTab[String(numericTabId)] || null;
      delete index.sessionsByTab[String(numericTabId)];
      if (index.activeTabId === numericTabId) {
        index.activeTabId = null;
        this.activeTabId = null;
      }
      await this._saveIndex(index);
      return existing ? this._normalizeSession(numericTabId, existing) : null;
    }

    async onTabUpdated(tabId, changeInfo) {
      const numericTabId = Number(tabId);
      if (!Number.isFinite(numericTabId)) {
        return null;
      }
      const current = await this.getOrCreate(numericTabId);
      const nextUrl = changeInfo && typeof changeInfo.url === 'string' ? changeInfo.url : current.url;
      const normalizedUrl = this.normalizeUrlFn(nextUrl || '');
      const urlChanged = Boolean(nextUrl && current.normalizedUrl && normalizedUrl && current.normalizedUrl !== normalizedUrl);
      const status = changeInfo && typeof changeInfo.status === 'string' ? changeInfo.status : '';
      const session = await this.getOrCreate(numericTabId, {
        url: nextUrl || current.url,
        normalizedUrl: normalizedUrl || current.normalizedUrl,
        needsRescan: current.activeJobId && urlChanged && status === 'loading'
          ? true
          : current.needsRescan === true,
        state: current.activeJobId && urlChanged && status === 'loading'
          ? 'scanned'
          : current.state
      });
      return session;
    }

    async setActiveTab(tabId) {
      const numericTabId = Number(tabId);
      const index = await this._loadIndex();
      index.activeTabId = Number.isFinite(numericTabId) ? numericTabId : null;
      await this._saveIndex(index);
      return index.activeTabId;
    }

    getActiveTabId() {
      return Number.isFinite(Number(this.activeTabId)) ? Number(this.activeTabId) : null;
    }

    async listSessions({ onlyActive = false } = {}) {
      const index = await this._loadIndex();
      const sessions = Object.keys(index.sessionsByTab || {})
        .map((tabKey) => index.sessionsByTab[tabKey])
        .filter((item) => item && (!onlyActive || Boolean(item.activeJobId)))
        .sort((a, b) => Number(b.lastSeenTs || 0) - Number(a.lastSeenTs || 0));
      return sessions.map((item) => this._normalizeSession(item.tabId, item));
    }
  }

  NT.TabSessionManager = TabSessionManager;
})(globalThis);
