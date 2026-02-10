/**
 * Persistent lease-backed registry of in-flight LLM requests.
 *
 * `InflightRequestStore` lets background recover after MV3 service-worker
 * restarts: each request attempt is written before network dispatch and removed
 * on terminal completion.
 *
 * Leases (`leaseUntilTs`) ensure no entry can remain RUNNING forever. A sweeper
 * can list expired entries, attempt offscreen cached-result adoption, and then
 * requeue/fail safely.
 *
 * The `requestId` key is deterministic per attempt, so offscreen cache lookup
 * can adopt already-finished results idempotently without a second API call.
 */
(function initInflightRequestStore(global) {
  const NT = global.NT || (global.NT = {});

  class InflightRequestStore extends NT.ChromeLocalStoreBase {
    constructor({ chromeApi } = {}) {
      super({ chromeApi });
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

  NT.InflightRequestStore = InflightRequestStore;
})(globalThis);
