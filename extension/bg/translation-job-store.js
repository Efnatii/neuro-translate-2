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
      this.SCHEMA_VERSION = 1;
      this.DEFAULTS = {
        translationSchemaVersion: this.SCHEMA_VERSION,
        translationJobsByTab: {},
        translationJobsById: {},
        translationJobIndexByTab: {}
      };
    }

    async getSnapshot() {
      const data = await this.storageGet(this.DEFAULTS);
      return this._normalizeData(data);
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
      const data = await this.getSnapshot();
      data.translationJobsById[job.id] = {
        ...(data.translationJobsById[job.id] || {}),
        ...(job || {})
      };
      await this.storageSet({
        translationSchemaVersion: this.SCHEMA_VERSION,
        translationJobsById: data.translationJobsById
      });
      return data.translationJobsById[job.id];
    }

    async setActiveJob(tabId, jobId) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const key = String(tabId);
      const now = Date.now();
      const data = await this.getSnapshot();
      data.translationJobsByTab[key] = jobId || null;
      const prev = data.translationJobIndexByTab[key] || {};
      data.translationJobIndexByTab[key] = {
        ...prev,
        activeJobId: jobId || null,
        lastJobId: jobId || prev.lastJobId || null,
        updatedAt: now
      };
      await this.storageSet({
        translationSchemaVersion: this.SCHEMA_VERSION,
        translationJobsByTab: data.translationJobsByTab,
        translationJobIndexByTab: data.translationJobIndexByTab
      });
    }

    async clearActiveJob(tabId, jobId) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const key = String(tabId);
      const now = Date.now();
      const data = await this.getSnapshot();
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
      await this.storageSet({
        translationSchemaVersion: this.SCHEMA_VERSION,
        translationJobsByTab: data.translationJobsByTab,
        translationJobIndexByTab: data.translationJobIndexByTab
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

    _normalizeData(data) {
      const src = data && typeof data === 'object' ? data : {};
      return {
        translationSchemaVersion: src.translationSchemaVersion || this.SCHEMA_VERSION,
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

