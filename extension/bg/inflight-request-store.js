/**
 * Persistent lease-backed registry of in-flight AI requests.
 *
 * Responsibilities:
 * - persist each request attempt so recovery is possible after MV3 restarts;
 * - track lease deadlines and expose expired rows for sweeper processing;
 * - provide deterministic request-id keyed CRUD helpers.
 *
 * Contracts:
 * - no network execution, no tab rendering, no retry policy decisions;
 * - all storage reads/writes are routed via LocalStore helpers.
 */
(function initInflightRequestStore(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  class InflightRequestStore extends NT.LocalStore {
    constructor({ chromeApi, time, eventSink } = {}) {
      super({ chromeApi, time, eventSink, storeName: 'InflightRequestStore' });
      this.KEY = 'inflightRequests';
      this.DEFAULTS = { inflightRequests: {} };
      this.LEASE_MS = 2 * 60 * 1000;
      this.SWEEP_INTERVAL_MS = 30 * 1000;
    }

    async getAll() {
      const data = await this.storageGet(this.DEFAULTS);
      return data[this.KEY] || {};
    }

    async get(requestId) {
      if (!requestId) {
        return null;
      }
      const all = await this.getAll();
      return all[requestId] || null;
    }

    async upsert(requestId, patch) {
      if (!requestId) {
        return null;
      }
      const data = await this.storageGet(this.DEFAULTS);
      const all = data[this.KEY] || {};
      const prev = all[requestId] || {};
      all[requestId] = { ...prev, ...(patch || {}), requestId };
      await this.storageSet({ [this.KEY]: all });
      return all[requestId];
    }

    async remove(requestId) {
      if (!requestId) {
        return;
      }
      const data = await this.storageGet(this.DEFAULTS);
      const all = data[this.KEY] || {};
      if (!all[requestId]) {
        return;
      }
      delete all[requestId];
      await this.storageSet({ [this.KEY]: all });
    }

    async listExpired(nowTs) {
      const now = typeof nowTs === 'number' ? nowTs : Date.now();
      const all = await this.getAll();
      const expired = [];
      Object.keys(all).forEach((requestId) => {
        const row = all[requestId];
        if (row && typeof row.leaseUntilTs === 'number' && row.leaseUntilTs <= now) {
          expired.push(row);
        }
      });
      return expired;
    }

    nextLease(nowTs) {
      const now = typeof nowTs === 'number' ? nowTs : Date.now();
      return now + this.LEASE_MS;
    }
  }

  BG.InflightRequestStore = InflightRequestStore;
})(globalThis);
