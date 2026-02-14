/**
 * Persistent benchmark snapshot store for model performance metadata.
 *
 * Role:
 * - Own all benchmark persistence in `chrome.storage.local`.
 *
 * Public contract:
 * - Bench entries API: `getAll`, `getAllEntries`, `get`, `getEntry`, `upsert`.
 * - Status API: `getStatus`, `setStatus`.
 * - Combined snapshot API: `getSnapshot`.
 * - Policy helpers: `isFresh`, `canAttempt`.
 *
 * Dependencies:
 * - `ChromeLocalStoreBase` storage wrappers.
 *
 * Side effects:
 * - Reads and writes `modelBenchmarks` and `modelBenchmarkStatus`.
 */
(function initModelBenchmarkStore(global) {
  const STORAGE_KEY_BENCHMARKS = 'modelBenchmarks';
  const STORAGE_KEY_STATUS = 'modelBenchmarkStatus';
  const TTL_MS = 24 * 60 * 60 * 1000;
  const MIN_INTERVAL_MS = 45 * 60 * 1000;

  class ModelBenchmarkStore extends global.NT.ChromeLocalStoreBase {
    constructor({ chromeApi }) {
      super({ chromeApi });
    }

    async getAll() {
      const data = await this.storageGet({ [STORAGE_KEY_BENCHMARKS]: {} });
      const all = data[STORAGE_KEY_BENCHMARKS] || {};
      const now = Date.now();
      const fresh = {};

      Object.keys(all).forEach((spec) => {
        const entry = all[spec];
        if (this.isFresh(entry, now)) {
          fresh[spec] = entry;
        }
      });

      return fresh;
    }

    async getAllEntries() {
      const data = await this.storageGet({ [STORAGE_KEY_BENCHMARKS]: {} });
      return data[STORAGE_KEY_BENCHMARKS] || {};
    }

    async get(modelSpec) {
      if (!modelSpec) {
        return null;
      }

      const data = await this.storageGet({ [STORAGE_KEY_BENCHMARKS]: {} });
      const entry = (data[STORAGE_KEY_BENCHMARKS] || {})[modelSpec] || null;
      return this.isFresh(entry, Date.now()) ? entry : null;
    }

    async getEntry(modelSpec) {
      if (!modelSpec) {
        return null;
      }

      const data = await this.storageGet({ [STORAGE_KEY_BENCHMARKS]: {} });
      return (data[STORAGE_KEY_BENCHMARKS] || {})[modelSpec] || null;
    }

    async upsert(modelSpec, patch) {
      if (!modelSpec) {
        return;
      }

      const data = await this.storageGet({ [STORAGE_KEY_BENCHMARKS]: {} });
      const all = { ...(data[STORAGE_KEY_BENCHMARKS] || {}) };
      const current = all[modelSpec] || {};
      const updated = {
        ...current,
        ...patch,
        updatedAt: patch.updatedAt || Date.now()
      };
      all[modelSpec] = updated;

      await this.storageSet({ [STORAGE_KEY_BENCHMARKS]: all });
    }

    async setStatus(statusObj) {
      await this.storageSet({ [STORAGE_KEY_STATUS]: statusObj || null });
    }

    async getStatus() {
      const data = await this.storageGet({ [STORAGE_KEY_STATUS]: null });
      return data[STORAGE_KEY_STATUS] || null;
    }

    async getSnapshot() {
      return {
        modelBenchmarkStatus: await this.getStatus(),
        modelBenchmarks: await this.getAllEntries()
      };
    }

    isFresh(entry, now) {
      if (!entry || typeof entry.updatedAt !== 'number') {
        return false;
      }
      return now - entry.updatedAt <= TTL_MS;
    }

    canAttempt(entry, now) {
      if (!entry || typeof entry.lastAttemptAt !== 'number') {
        return true;
      }
      return now - entry.lastAttemptAt >= MIN_INTERVAL_MS;
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.ModelBenchmarkStore = ModelBenchmarkStore;
})(globalThis);
