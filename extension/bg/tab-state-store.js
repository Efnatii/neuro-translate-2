/**
 * Persistent per-tab state store for background orchestration.
 *
 * `TabStateStore` is the single write path for tab-scoped state blobs used by
 * popup/debug views (`translationStatusByTab`, `translationVisibilityByTab`).
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
    }

    async getAllStatus() {
      const data = await this.storageGet({ translationStatusByTab: {} });
      return data.translationStatusByTab || {};
    }

    async upsertModelDecision(tabId, payload) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const statusByTab = await this.getAllStatus();
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
      await this.storageSet({ translationStatusByTab: statusByTab });
    }

    async upsertStatusPatch(tabId, patch) {
      if (tabId === null || tabId === undefined || !patch || typeof patch !== 'object') {
        return;
      }
      const statusByTab = await this.getAllStatus();
      const current = statusByTab[tabId] || {};
      statusByTab[tabId] = { ...current, ...patch };
      await this.storageSet({ translationStatusByTab: statusByTab });
    }

    async upsertVisibility(tabId, visible) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const data = await this.storageGet({ translationVisibilityByTab: {} });
      const map = { ...(data.translationVisibilityByTab || {}) };
      map[tabId] = Boolean(visible);
      await this.storageSet({ translationVisibilityByTab: map });
    }

    async getVisibility(tabId) {
      if (tabId === null || tabId === undefined) {
        return true;
      }
      try {
        const data = await this.storageGet({ translationVisibilityByTab: {} });
        const map = data && data.translationVisibilityByTab && typeof data.translationVisibilityByTab === 'object'
          ? data.translationVisibilityByTab
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
      await this.storageSet({ translationStatusByTab: statusByTab });
    }
  }

  NT.TabStateStore = TabStateStore;
})(globalThis);
