/**
 * Debounced settings persistence adapter for UI/state modules.
 *
 * `SettingsStore` provides a small public API:
 * - `get(keys)` reads settings with defaults and optional sanitize hook.
 * - `set(payload)` writes values immediately.
 * - `queuePatch(patch)` coalesces rapid updates with debounce.
 *
 * Storage writes go through `ChromeLocalStoreBase` so behavior remains consistent
 * when MV3 runtime contexts are restarted and state must be restored.
 */
(function initSettingsStore(global) {
  const NT = global.NT || (global.NT = {});

  class SettingsStore extends NT.ChromeLocalStoreBase {
    constructor({ chromeApi, defaults = {}, sanitize = null, debounceMs = 400 } = {}) {
      super({ chromeApi });
      this.defaults = defaults;
      this.sanitize = typeof sanitize === 'function' ? sanitize : null;
      this.debounceMs = debounceMs;
      this.pendingPatch = {};
      this.saveTimer = null;
    }

    async get(keys) {
      const fallback = this.applyDefaults({}, keys);
      const data = await this.storageGet(fallback);
      const merged = this.applyDefaults(data || {}, keys);
      return this.applySanitize(merged);
    }

    set(payload) {
      return this.storageSet(payload);
    }

    async getPublicSnapshot() {
      const data = await this.get([
        'apiKey',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationAgentModelPolicy',
        'translationPipelineEnabled',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationCategoryMode',
        'translationCategoryList',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationPopupActiveTab'
      ]);
      const apiKey = typeof data.apiKey === 'string' ? data.apiKey : '';
      return {
        hasApiKey: Boolean(apiKey),
        apiKeyLength: apiKey.length,
        translationModelList: Array.isArray(data.translationModelList) ? data.translationModelList : [],
        modelSelection: data.modelSelection || null,
        modelSelectionPolicy: data.modelSelectionPolicy || null,
        translationAgentModelPolicy: data.translationAgentModelPolicy || null,
        translationPipelineEnabled: Boolean(data.translationPipelineEnabled),
        translationAgentProfile: data.translationAgentProfile || 'auto',
        translationAgentTools: data.translationAgentTools && typeof data.translationAgentTools === 'object'
          ? data.translationAgentTools
          : {},
        translationAgentTuning: data.translationAgentTuning && typeof data.translationAgentTuning === 'object'
          ? data.translationAgentTuning
          : {},
        translationCategoryMode: data.translationCategoryMode || 'auto',
        translationCategoryList: Array.isArray(data.translationCategoryList) ? data.translationCategoryList : [],
        translationPageCacheEnabled: data.translationPageCacheEnabled !== false,
        translationApiCacheEnabled: data.translationApiCacheEnabled !== false,
        translationPopupActiveTab: data.translationPopupActiveTab || 'control'
      };
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
