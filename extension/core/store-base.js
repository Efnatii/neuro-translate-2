/**
 * Shared storage hierarchy for MV3 persistent stores.
 *
 * These classes centralize safe `chrome.storage.local` access so domain stores
 * no longer duplicate wrappers or error handling.
 *
 * Contracts:
 * - `StoreBase` emits best-effort diagnostics without exposing secrets;
 * - `LocalStore` provides get/set/remove and bounded read-modify-write updates;
 * - `VersionedStore` executes explicit schema migrations with version marker.
 *
 * This module contains no domain rules for settings, event log, AI, or tabs.
 */
(function initStoreBase(global) {
  const NT = global.NT || (global.NT = {});

  class StoreBase {
    constructor({ chromeApi, time, eventSink, storeName } = {}) {
      this.chromeApi = chromeApi || global.chrome || null;
      this.time = time || NT.Time || null;
      this.eventSink = typeof eventSink === 'function' ? eventSink : null;
      this.storeName = storeName || 'Store';
    }

    _emit(level, tag, message, data) {
      if (!this.eventSink) {
        return;
      }
      const payload = data && typeof data === 'object' ? { ...data } : {};
      try {
        this.eventSink({
          ts: Date.now(),
          level: level || 'info',
          tag: tag || 'STORE_EVENT',
          message: message || 'Store event',
          meta: {
            source: this.storeName,
            ...payload
          }
        });
      } catch (_) {
        // Diagnostics must never crash store operations.
      }
    }
  }

  class LocalStore extends StoreBase {
    async storageGet(defaultsObj) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return defaultsObj || {};
      }
      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(defaultsObj || {}, (result) => {
          if (this.chromeApi.runtime && this.chromeApi.runtime.lastError) {
            this._emit('warn', 'STORE_GET_FAILED', this.chromeApi.runtime.lastError.message || 'storage.get failed');
            resolve(defaultsObj || {});
            return;
          }
          resolve(result || defaultsObj || {});
        });
      });
    }

    async storageSet(obj) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return;
      }
      return new Promise((resolve) => {
        this.chromeApi.storage.local.set(obj || {}, () => {
          if (this.chromeApi.runtime && this.chromeApi.runtime.lastError) {
            this._emit('warn', 'STORE_SET_FAILED', this.chromeApi.runtime.lastError.message || 'storage.set failed');
          }
          resolve();
        });
      });
    }

    async storageRemove(keys) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return;
      }
      return new Promise((resolve) => {
        this.chromeApi.storage.local.remove(keys, () => {
          if (this.chromeApi.runtime && this.chromeApi.runtime.lastError) {
            this._emit('warn', 'STORE_REMOVE_FAILED', this.chromeApi.runtime.lastError.message || 'storage.remove failed');
          }
          resolve();
        });
      });
    }

    async update(keyDefaults, mutateFn) {
      const defaults = keyDefaults && typeof keyDefaults === 'object' ? keyDefaults : {};
      const mutator = typeof mutateFn === 'function' ? mutateFn : (value) => value;

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const current = await this.storageGet(defaults);
        const currentClone = { ...current };
        const next = await mutator(currentClone, { attempt });
        const payload = next && typeof next === 'object' ? next : currentClone;
        try {
          await this.storageSet(payload);
          return payload;
        } catch (error) {
          if (attempt >= 2) {
            throw error;
          }
          this._emit('warn', 'STORE_UPDATE_RETRY', 'Retrying storage update', { attempt });
        }
      }
      return defaults;
    }
  }

  class VersionedStore extends LocalStore {
    constructor(options = {}) {
      super(options);
      this.SCHEMA_KEY = '__schemaVersion';
      this.CURRENT_SCHEMA = 2;
    }

    async ensureMigrated(migrations) {
      const map = migrations && typeof migrations === 'object' ? migrations : {};
      const versionRaw = await this.storageGet({ [this.SCHEMA_KEY]: 1 });
      let current = Number(versionRaw[this.SCHEMA_KEY]);
      if (!Number.isFinite(current) || current < 1) {
        current = 1;
      }

      for (let target = current + 1; target <= this.CURRENT_SCHEMA; target += 1) {
        const migration = map[target];
        if (typeof migration === 'function') {
          await migration();
        }
        await this.storageSet({ [this.SCHEMA_KEY]: target });
        this._emit('info', 'MIGRATION_APPLIED', `Schema migration applied: v${target}`, {
          schemaVersion: target,
          storeName: this.storeName
        });
      }

      return {
        schemaVersion: Math.max(current, this.CURRENT_SCHEMA)
      };
    }
  }

  NT.StoreBase = StoreBase;
  NT.LocalStore = LocalStore;
  NT.VersionedStore = VersionedStore;
})(globalThis);
