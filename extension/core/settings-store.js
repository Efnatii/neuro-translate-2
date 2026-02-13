/**
 * Versioned settings store for extension configuration state.
 *
 * Responsibilities:
 * - persist only whitelisted settings keys in `chrome.storage.local`;
 * - provide redacted public snapshot without leaking API key value;
 * - coalesce rapid UI updates through internal debounce queue;
 * - execute explicit schema migration from legacy policy fields.
 *
 * Non-goals:
 * - no UI rendering, no event-log storage, no AI network operations.
 */
(function initSettingsStore(global) {
  const NT = global.NT || (global.NT = {});

  class SettingsStore extends NT.VersionedStore {
    constructor({ chromeApi, time, eventSink, debounceMs = 400 } = {}) {
      super({ chromeApi, time, eventSink, storeName: 'SettingsStore' });
      this.DEFAULTS = {
        apiKey: '',
        translationModelList: [],
        modelSelection: { speed: true, preference: null },
        modelSelectionPolicy: null,
        translationVisibilityByTab: {},
        activeTabId: null
      };
      this.debounceMs = Number.isFinite(Number(debounceMs))
        ? Math.max(200, Math.min(1000, Number(debounceMs)))
        : 400;
      this.pendingPatch = {};
      this.saveTimer = null;
      this.CURRENT_SCHEMA = 2;
    }

    async get(keys) {
      const defaults = this._selectDefaults(keys);
      const data = await this.storageGet(defaults);
      return { ...defaults, ...(data || {}) };
    }

    async set(payload) {
      await this.storageSet(payload || {});
    }

    async getPublicSnapshot(redactor) {
      const raw = await this.storageGet(this.DEFAULTS);
      const safeRedactor = redactor || new NT.Redactor();
      return safeRedactor.redactSettings(raw);
    }

    async applyPatch(patchObj) {
      const patch = this._sanitizePatch(patchObj);
      if (!Object.keys(patch).length) {
        const error = new Error('Settings patch is empty');
        error.code = 'EMPTY_SETTINGS_PATCH';
        throw error;
      }
      await this.storageSet(patch);
      return patch;
    }

    queuePatch(patchObj, { finalize } = {}) {
      const patch = this._sanitizePatch(patchObj);
      if (!Object.keys(patch).length) {
        return;
      }
      this.pendingPatch = { ...this.pendingPatch, ...patch };

      if (this.saveTimer) {
        global.clearTimeout(this.saveTimer);
      }

      this.saveTimer = global.setTimeout(async () => {
        const payload = { ...this.pendingPatch };
        this.pendingPatch = {};
        this.saveTimer = null;

        if (typeof finalize === 'function') {
          finalize(payload);
        }

        await this.applyPatch(payload);
      }, this.debounceMs);
    }

    async ensureMigrated() {
      return super.ensureMigrated({
        2: async () => {
          const data = await this.storageGet({});
          const hasModern = data.modelSelection && typeof data.modelSelection === 'object';
          const legacy = typeof data.modelSelectionPolicy === 'string' ? data.modelSelectionPolicy : null;
          const nextSelection = hasModern
            ? this._normalizeSelection(data.modelSelection)
            : this._legacyPolicyToSelection(legacy);

          await this.storageSet({
            modelSelection: nextSelection,
            modelSelectionPolicy: null
          });
          this._emit('info', 'SETTINGS_MIGRATED_V2', 'Settings schema migrated to v2', {
            hadLegacyPolicy: Boolean(legacy)
          });
        }
      });
    }

    _selectDefaults(keys) {
      if (!Array.isArray(keys)) {
        return { ...this.DEFAULTS };
      }
      return keys.reduce((acc, key) => {
        if (Object.prototype.hasOwnProperty.call(this.DEFAULTS, key)) {
          acc[key] = this.DEFAULTS[key];
        }
        return acc;
      }, {});
    }

    _sanitizePatch(patchObj) {
      const patch = patchObj && typeof patchObj === 'object' ? patchObj : {};
      const out = {};
      if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
        out.apiKey = typeof patch.apiKey === 'string' ? patch.apiKey : '';
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationModelList')) {
        out.translationModelList = Array.isArray(patch.translationModelList) ? patch.translationModelList : [];
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'modelSelection')) {
        out.modelSelection = this._normalizeSelection(patch.modelSelection);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'modelSelectionPolicy')) {
        out.modelSelectionPolicy = patch.modelSelectionPolicy || null;
      }
      return out;
    }

    _normalizeSelection(source) {
      const input = source && typeof source === 'object' ? source : {};
      const preference = input.preference === 'smartest' || input.preference === 'cheapest'
        ? input.preference
        : null;
      return {
        speed: input.speed !== false,
        preference
      };
    }

    _legacyPolicyToSelection(policy) {
      if (policy === 'smartest') {
        return { speed: false, preference: 'smartest' };
      }
      if (policy === 'cheapest') {
        return { speed: false, preference: 'cheapest' };
      }
      if (policy === 'fastest') {
        return { speed: true, preference: null };
      }
      return { speed: true, preference: null };
    }
  }

  NT.SettingsStore = SettingsStore;
})(globalThis);
