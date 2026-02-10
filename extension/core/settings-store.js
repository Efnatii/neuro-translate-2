(function initSettingsStore(global) {
  const NT = global.NT || (global.NT = {});

  class SettingsStore {
    constructor({ chromeApi, defaults = {}, sanitize = null, debounceMs = 400 } = {}) {
      this.chromeApi = chromeApi;
      this.defaults = defaults;
      this.sanitize = typeof sanitize === 'function' ? sanitize : null;
      this.debounceMs = debounceMs;
      this.pendingPatch = {};
      this.saveTimer = null;
    }

    get(keys) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        const fallback = this.applyDefaults({}, keys);
        return Promise.resolve(this.applySanitize(fallback));
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(keys, (result) => {
          const merged = this.applyDefaults(result || {}, keys);
          resolve(this.applySanitize(merged));
        });
      });
    }

    set(payload) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.set(payload, () => resolve());
      });
    }

    queuePatch(patch, { finalize } = {}) {
      Object.assign(this.pendingPatch, patch);

      if (this.saveTimer) {
        global.clearTimeout(this.saveTimer);
      }

      this.saveTimer = global.setTimeout(() => {
        const payload = { ...this.pendingPatch };
        this.pendingPatch = {};

        if (typeof finalize === 'function') {
          finalize(payload);
        }

        this.set(payload);
      }, this.debounceMs);
    }

    applyDefaults(payload, keys) {
      const defaults = {};
      const keyList = Array.isArray(keys) ? keys : Object.keys(this.defaults || {});
      keyList.forEach((key) => {
        if (this.defaults && Object.prototype.hasOwnProperty.call(this.defaults, key)) {
          defaults[key] = this.defaults[key];
        }
      });
      return { ...defaults, ...(payload || {}) };
    }

    applySanitize(payload) {
      return this.sanitize ? this.sanitize(payload) : payload;
    }
  }

  NT.SettingsStore = SettingsStore;
})(globalThis);
