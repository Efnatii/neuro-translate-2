/**
 * Persistent per-tab state store for translation progress and visibility.
 *
 * Responsibilities:
 * - centralize all writes to tab status/visibility maps in local storage;
 * - preserve model-decision hints across MV3 service-worker restarts;
 * - provide small helpers used by BackgroundApp orchestration.
 *
 * Contracts:
 * - no direct UI logic, no network calls, no AI benchmarking logic;
 * - data is merged per-tab and persisted through LocalStore helpers.
 */
(function initTabStateStore(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  class TabStateStore extends NT.LocalStore {
    constructor({ chromeApi, time, eventSink } = {}) {
      super({ chromeApi, time, eventSink, storeName: 'TabStateStore' });
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

  BG.TabStateStore = TabStateStore;
})(globalThis);
