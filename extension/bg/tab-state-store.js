/**
 * Persistent per-tab state store for background orchestration.
 *
 * `TabStateStore` is the single write path for tab-scoped state blobs used by
 * popup/debug views (`translationStatusByTab`, `translationVisibilityByTab`,
 * `translationDisplayModeByTab`).
 * Keeping writes centralized prevents format drift and removes direct storage
 * access from AI orchestration code.
 *
 * MV3 note: service workers are ephemeral, therefore model decisions and
 * visibility flags must be merged and persisted in `chrome.storage.local`.
 *
 * Public methods: `getAllStatus`, `upsertModelDecision`, `upsertStatusPatch`,
 * `upsertVisibility`, plus `getLastModelSpec`/`setLastModelSpec` used as a
 * soft hint for anti-thrash model stickiness in speed mode.
 */
(function initTabStateStore(global) {
  const NT = global.NT || (global.NT = {});

  class TabStateStore extends NT.ChromeLocalStoreBase {
    constructor({ chromeApi } = {}) {
      super({ chromeApi });
      this.KEY = 'nt.tabs.v1';
      this.LEGACY_KEYS = {
        status: 'translationStatusByTab',
        visibility: 'translationVisibilityByTab',
        displayMode: 'translationDisplayModeByTab'
      };
      this.STATE_VERSION = 1;
    }

    async getAllStatus() {
      const state = await this._readState();
      return state.translationStatusByTab || {};
    }

    async ensureCanonicalSnapshot({ force = false, pruneLegacy = false } = {}) {
      const raw = await this.storageGet({
        [this.KEY]: null,
        [this.LEGACY_KEYS.status]: {},
        [this.LEGACY_KEYS.visibility]: {},
        [this.LEGACY_KEYS.displayMode]: {}
      });
      const hasCanonical = Boolean(raw && raw[this.KEY] && typeof raw[this.KEY] === 'object' && !Array.isArray(raw[this.KEY]));
      const state = hasCanonical
        ? this._normalizeState(raw[this.KEY])
        : this._normalizeState({
          translationStatusByTab: raw[this.LEGACY_KEYS.status],
          translationVisibilityByTab: raw[this.LEGACY_KEYS.visibility],
          translationDisplayModeByTab: raw[this.LEGACY_KEYS.displayMode]
        });
      if (force || !hasCanonical) {
        await this._writeState(state, { pruneLegacy });
      }
      return {
        ok: true,
        migrated: Boolean(force || !hasCanonical),
        state
      };
    }

    async getVisibilitySnapshot() {
      const state = await this._readState();
      return {
        translationVisibilityByTab: { ...(state.translationVisibilityByTab || {}) },
        translationDisplayModeByTab: { ...(state.translationDisplayModeByTab || {}) }
      };
    }

    async upsertModelDecision(tabId, payload) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const state = await this._readState();
      const statusByTab = state.translationStatusByTab || {};
      const current = statusByTab[tabId] || {};
      statusByTab[tabId] = {
        ...current,
        modelDecision: {
          chosenModelSpec: payload ? payload.chosenModelSpec || null : null,
          chosenModelId: payload ? payload.chosenModelId || null : null,
          serviceTier: payload ? payload.serviceTier || 'default' : 'default',
          decision: {
            policy: payload && payload.decision ? payload.decision.policy || null : null,
            reason: payload && payload.decision ? payload.decision.reason || null : null,
            candidates: payload && payload.decision && Array.isArray(payload.decision.candidates)
              ? payload.decision.candidates
              : []
          },
          taskType: payload && payload.taskType ? payload.taskType : 'unknown',
          updatedAt: payload && typeof payload.updatedAt === 'number' ? payload.updatedAt : Date.now()
        }
      };
      state.translationStatusByTab = statusByTab;
      await this._writeState(state);
    }

    async upsertStatusPatch(tabId, patch) {
      if (tabId === null || tabId === undefined || !patch || typeof patch !== 'object') {
        return;
      }
      const state = await this._readState();
      const statusByTab = state.translationStatusByTab || {};
      const current = statusByTab[tabId] || {};
      statusByTab[tabId] = { ...current, ...patch };
      state.translationStatusByTab = statusByTab;
      await this._writeState(state);
    }

    async upsertVisibility(tabId, visible) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const state = await this._readState();
      const map = { ...(state.translationVisibilityByTab || {}) };
      const modeMap = { ...(state.translationDisplayModeByTab || {}) };
      map[tabId] = Boolean(visible);
      modeMap[tabId] = visible ? 'translated' : 'original';
      state.translationVisibilityByTab = map;
      state.translationDisplayModeByTab = modeMap;
      await this._writeState(state);
    }

    async getVisibility(tabId) {
      if (tabId === null || tabId === undefined) {
        return true;
      }
      try {
        const state = await this._readState();
        const modeMap = state && state.translationDisplayModeByTab && typeof state.translationDisplayModeByTab === 'object'
          ? state.translationDisplayModeByTab
          : {};
        const modeKey = String(tabId);
        if (Object.prototype.hasOwnProperty.call(modeMap, modeKey)) {
          return modeMap[modeKey] !== 'original';
        }
        if (Object.prototype.hasOwnProperty.call(modeMap, tabId)) {
          return modeMap[tabId] !== 'original';
        }
        const map = state && state.translationVisibilityByTab && typeof state.translationVisibilityByTab === 'object'
          ? state.translationVisibilityByTab
          : {};
        const key = String(tabId);
        if (Object.prototype.hasOwnProperty.call(map, key)) {
          return map[key] !== false;
        }
        if (Object.prototype.hasOwnProperty.call(map, tabId)) {
          return map[tabId] !== false;
        }
      } catch (_) {
        // best-effort fallback
      }
      return true;
    }

    async upsertDisplayMode(tabId, mode) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const normalizedMode = mode === 'original' || mode === 'compare'
        ? mode
        : 'translated';
      const state = await this._readState();
      const modeMap = { ...(state.translationDisplayModeByTab || {}) };
      const visibilityMap = { ...(state.translationVisibilityByTab || {}) };
      modeMap[tabId] = normalizedMode;
      visibilityMap[tabId] = normalizedMode !== 'original';
      state.translationDisplayModeByTab = modeMap;
      state.translationVisibilityByTab = visibilityMap;
      await this._writeState(state);
    }

    async getDisplayMode(tabId) {
      if (tabId === null || tabId === undefined) {
        return 'translated';
      }
      try {
        const state = await this._readState();
        const modeMap = state && state.translationDisplayModeByTab && typeof state.translationDisplayModeByTab === 'object'
          ? state.translationDisplayModeByTab
          : {};
        const key = String(tabId);
        if (Object.prototype.hasOwnProperty.call(modeMap, key)) {
          const mode = modeMap[key];
          return mode === 'original' || mode === 'compare' ? mode : 'translated';
        }
        if (Object.prototype.hasOwnProperty.call(modeMap, tabId)) {
          const mode = modeMap[tabId];
          return mode === 'original' || mode === 'compare' ? mode : 'translated';
        }
        const visible = await this.getVisibility(tabId);
        return visible ? 'translated' : 'original';
      } catch (_) {
        return 'translated';
      }
    }

    async getLastModelSpec(tabId) {
      if (tabId === null || tabId === undefined) {
        return null;
      }
      const statusByTab = await this.getAllStatus();
      const current = statusByTab[tabId] || null;
      const fromDecision = current && current.modelDecision && current.modelDecision.chosenModelSpec
        ? current.modelDecision.chosenModelSpec
        : null;
      return fromDecision || (current && typeof current.lastModelSpec === 'string' ? current.lastModelSpec : null);
    }

    async setLastModelSpec(tabId, modelSpec) {
      if (tabId === null || tabId === undefined || !modelSpec) {
        return;
      }
      const statusByTab = await this.getAllStatus();
      const current = statusByTab[tabId] || {};
      statusByTab[tabId] = {
        ...current,
        lastModelSpec: modelSpec,
        lastModelSpecAt: Date.now()
      };
      const state = await this._readState();
      state.translationStatusByTab = statusByTab;
      await this._writeState(state);
    }

    async _readState() {
      const data = await this.storageGet({
        [this.KEY]: null,
        [this.LEGACY_KEYS.status]: {},
        [this.LEGACY_KEYS.visibility]: {},
        [this.LEGACY_KEYS.displayMode]: {}
      });
      const canonical = data && data[this.KEY] && typeof data[this.KEY] === 'object' && !Array.isArray(data[this.KEY])
        ? data[this.KEY]
        : null;
      if (canonical) {
        return this._normalizeState(canonical);
      }
      const legacy = this._normalizeState({
        translationStatusByTab: data ? data[this.LEGACY_KEYS.status] : {},
        translationVisibilityByTab: data ? data[this.LEGACY_KEYS.visibility] : {},
        translationDisplayModeByTab: data ? data[this.LEGACY_KEYS.displayMode] : {}
      });
      await this._writeState(legacy);
      return legacy;
    }

    async _writeState(state, { pruneLegacy = false } = {}) {
      const normalized = this._normalizeState(state);
      const payload = {
        [this.KEY]: normalized,
        [this.LEGACY_KEYS.status]: normalized.translationStatusByTab,
        [this.LEGACY_KEYS.visibility]: normalized.translationVisibilityByTab,
        [this.LEGACY_KEYS.displayMode]: normalized.translationDisplayModeByTab
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
            this.LEGACY_KEYS.status,
            this.LEGACY_KEYS.visibility,
            this.LEGACY_KEYS.displayMode
          ], () => resolve());
        });
      }
      return normalized;
    }

    _normalizeState(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      return {
        v: this.STATE_VERSION,
        translationStatusByTab: src.translationStatusByTab && typeof src.translationStatusByTab === 'object'
          ? { ...src.translationStatusByTab }
          : {},
        translationVisibilityByTab: src.translationVisibilityByTab && typeof src.translationVisibilityByTab === 'object'
          ? { ...src.translationVisibilityByTab }
          : {},
        translationDisplayModeByTab: src.translationDisplayModeByTab && typeof src.translationDisplayModeByTab === 'object'
          ? { ...src.translationDisplayModeByTab }
          : {}
      };
    }
  }

  NT.TabStateStore = TabStateStore;
})(globalThis);
