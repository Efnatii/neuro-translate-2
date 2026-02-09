(function initModelBenchmarkStore(global) {
  const STORAGE_KEY_BENCHMARKS = 'modelBenchmarks';
  const STORAGE_KEY_STATUS = 'modelBenchmarkStatus';
  const TTL_MS = 24 * 60 * 60 * 1000;

  class ModelBenchmarkStore {
    constructor({ chromeApi }) {
      this.chromeApi = chromeApi;
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

    async get(modelSpec) {
      if (!modelSpec) {
        return null;
      }

      const data = await this.storageGet({ [STORAGE_KEY_BENCHMARKS]: {} });
      const entry = (data[STORAGE_KEY_BENCHMARKS] || {})[modelSpec] || null;
      return this.isFresh(entry, Date.now()) ? entry : null;
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

    isFresh(entry, now) {
      if (!entry || typeof entry.updatedAt !== 'number') {
        return false;
      }
      return now - entry.updatedAt <= TTL_MS;
    }

    storageGet(defaults) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve(defaults || {});
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(defaults, (result) => resolve(result || defaults || {}));
      });
    }

    storageSet(payload) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.set(payload, () => resolve());
      });
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.ModelBenchmarkStore = ModelBenchmarkStore;
})(globalThis);
