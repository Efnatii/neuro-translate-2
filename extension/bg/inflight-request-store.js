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
      this.KEY = 'nt.inflight.v2';
      this.LEGACY_KEYS = ['ntInflightRequests', 'inflightRequests'];
      this.DEFAULTS = {
        [this.KEY]: {},
        ntInflightRequests: {},
        inflightRequests: {}
      };
      this.LEASE_MS = 2 * 60 * 1000;
      this.SWEEP_INTERVAL_MS = 30 * 1000;
    }

    async ensureCanonicalSnapshot({ force = false, pruneLegacy = false } = {}) {
      const all = await this.getAll();
      const raw = await this.storageGet(this.DEFAULTS);
      const hasCanonical = Boolean(raw && raw[this.KEY] && typeof raw[this.KEY] === 'object' && !Array.isArray(raw[this.KEY]));
      if (force || !hasCanonical) {
        await this._saveAll(all, { pruneLegacy });
      }
      return {
        ok: true,
        migrated: Boolean(force || !hasCanonical),
        size: Object.keys(all).length
      };
    }

    async getAll() {
      try {
        const data = await this.storageGet(this.DEFAULTS);
        const current = data && data[this.KEY] && typeof data[this.KEY] === 'object' && !Array.isArray(data[this.KEY])
          ? data[this.KEY]
          : {};
        const merged = { ...current };
        this.LEGACY_KEYS.forEach((legacyKey) => {
          const value = data && data[legacyKey] && typeof data[legacyKey] === 'object' && !Array.isArray(data[legacyKey])
            ? data[legacyKey]
            : {};
          Object.assign(merged, value);
        });
        if (!Object.keys(current).length && Object.keys(merged).length) {
          await this._saveAll(merged);
        }
        return merged;
      } catch (_) {
        return {};
      }
    }

    async get(requestId) {
      if (!requestId) {
        return null;
      }
      try {
        const all = await this.getAll();
        return all[requestId] || null;
      } catch (_) {
        return null;
      }
    }

    _normalizeStatus(status) {
      return status === 'done' || status === 'failed' || status === 'cancelled'
        ? status
        : 'pending';
    }

    _normalizeEntry(entry, prev) {
      const source = entry && typeof entry === 'object' ? entry : {};
      const base = prev && typeof prev === 'object' ? prev : {};
      const requestId = source.requestId || base.requestId || null;
      const now = Date.now();
      const createdAt = Number.isFinite(Number(base.createdAt))
        ? Number(base.createdAt)
        : (Number.isFinite(Number(source.createdAt)) ? Number(source.createdAt) : now);
      const updatedAt = Number.isFinite(Number(source.updatedAt))
        ? Number(source.updatedAt)
        : now;
      return {
        ...base,
        ...source,
        requestId,
        status: this._normalizeStatus(source.status || base.status),
        createdAt,
        updatedAt
      };
    }

    async _saveAll(all, { pruneLegacy = false } = {}) {
      try {
        await this.storageSet({ [this.KEY]: all });
        if (
          pruneLegacy
          && this.chromeApi
          && this.chromeApi.storage
          && this.chromeApi.storage.local
          && typeof this.chromeApi.storage.local.remove === 'function'
        ) {
          await new Promise((resolve) => {
            this.chromeApi.storage.local.remove(this.LEGACY_KEYS, () => resolve());
          });
        }
      } catch (_) {
        // best-effort
      }
    }

    async upsert(requestIdOrEntry, patch) {
      try {
        const source = requestIdOrEntry && typeof requestIdOrEntry === 'object' && !Array.isArray(requestIdOrEntry)
          ? { ...(requestIdOrEntry || {}) }
          : { ...(patch || {}), requestId: requestIdOrEntry || (patch && patch.requestId) || null };
        const requestId = source.requestId;
        if (!requestId) {
          return null;
        }
        const all = await this.getAll();
        const prev = all[requestId] || {};
        const next = this._normalizeEntry(source, prev);
        all[requestId] = next;
        await this._saveAll(all);
        return next;
      } catch (_) {
        return null;
      }
    }

    async remove(requestId) {
      if (!requestId) {
        return;
      }
      try {
        const all = await this.getAll();
        if (!all[requestId]) {
          return;
        }
        delete all[requestId];
        await this._saveAll(all);
      } catch (_) {
        // best-effort
      }
    }

    async findByKey(requestKey) {
      if (!requestKey) {
        return null;
      }
      try {
        const all = await this.getAll();
        const rows = Object.keys(all)
          .map((requestId) => all[requestId])
          .filter((row) => row && row.requestKey === requestKey)
          .sort((a, b) => {
            const aUpdated = Number.isFinite(Number(a && a.updatedAt)) ? Number(a.updatedAt) : 0;
            const bUpdated = Number.isFinite(Number(b && b.updatedAt)) ? Number(b.updatedAt) : 0;
            return bUpdated - aUpdated;
          });
        return rows.length ? rows[0] : null;
      } catch (_) {
        return null;
      }
    }

    async findByJobId(jobId, { statuses = null, limit = 50 } = {}) {
      if (!jobId) {
        return [];
      }
      try {
        const all = await this.getAll();
        const allowStatuses = Array.isArray(statuses) && statuses.length
          ? new Set(statuses)
          : null;
        const out = Object.keys(all)
          .map((requestId) => all[requestId])
          .filter((row) => row && row.meta && row.meta.jobId === jobId)
          .filter((row) => !allowStatuses || allowStatuses.has(row.status))
          .sort((a, b) => {
            const aUpdated = Number.isFinite(Number(a && a.updatedAt)) ? Number(a.updatedAt) : 0;
            const bUpdated = Number.isFinite(Number(b && b.updatedAt)) ? Number(b.updatedAt) : 0;
            return bUpdated - aUpdated;
          });
        return out.slice(0, Math.max(1, Number(limit) || 50));
      } catch (_) {
        return [];
      }
    }

    async markDone(requestId, { rawJson = null, rawResult = null, payloadHash = null, requestKey = null, decision = null, resultSummary = null } = {}) {
      if (!requestId) {
        return null;
      }
      return this.upsert({
        requestId,
        status: 'done',
        payloadHash: payloadHash || undefined,
        requestKey: requestKey || undefined,
        rawJson: rawJson || null,
        rawResult: rawResult || null,
        decision: decision || null,
        resultSummary: resultSummary || null,
        error: null,
        leaseUntilTs: null
      });
    }

    async markFailed(requestId, { error = null, payloadHash = null, requestKey = null } = {}) {
      if (!requestId) {
        return null;
      }
      return this.upsert({
        requestId,
        status: 'failed',
        payloadHash: payloadHash || undefined,
        requestKey: requestKey || undefined,
        error: error || { code: 'FAILED', message: 'request failed' },
        leaseUntilTs: null
      });
    }

    async markCancelled(requestId) {
      if (!requestId) {
        return null;
      }
      return this.upsert({
        requestId,
        status: 'cancelled',
        error: { code: 'ABORTED', message: 'request cancelled' },
        leaseUntilTs: null
      });
    }

    async touchStreamHeartbeat(requestId, { leaseUntilTs = null, preview = null } = {}) {
      if (!requestId) {
        return null;
      }
      const now = Date.now();
      return this.upsert({
        requestId,
        status: 'pending',
        updatedAt: now,
        lastEventTs: now,
        streamPreview: typeof preview === 'string' ? preview.slice(-200) : null,
        leaseUntilTs: Number.isFinite(Number(leaseUntilTs))
          ? Number(leaseUntilTs)
          : this.nextLease(now)
      });
    }

    async listByStatus(status, { limit = 200 } = {}) {
      try {
        const normalized = this._normalizeStatus(status);
        const all = await this.getAll();
        const out = Object.keys(all)
          .map((requestId) => all[requestId])
          .filter((row) => row && this._normalizeStatus(row.status) === normalized)
          .sort((a, b) => {
            const aUpdated = Number.isFinite(Number(a && a.updatedAt)) ? Number(a.updatedAt) : 0;
            const bUpdated = Number.isFinite(Number(b && b.updatedAt)) ? Number(b.updatedAt) : 0;
            return bUpdated - aUpdated;
          });
        return out.slice(0, Math.max(1, Number(limit) || 200));
      } catch (_) {
        return [];
      }
    }

    async listPending({ limit = 200 } = {}) {
      return this.listByStatus('pending', { limit });
    }

    async listExpired(nowTs) {
      const now = typeof nowTs === 'number' ? nowTs : Date.now();
      try {
        const all = await this.getAll();
        const expired = [];
        Object.keys(all).forEach((requestId) => {
          const row = all[requestId];
          const status = this._normalizeStatus(row && row.status);
          if (status !== 'pending') {
            return;
          }
          if (row && typeof row.leaseUntilTs === 'number' && row.leaseUntilTs <= now) {
            expired.push(row);
          }
        });
        return expired;
      } catch (_) {
        return [];
      }
    }

    async sweep({ maxAgeMs = 24 * 60 * 60 * 1000 } = {}) {
      try {
        const maxAge = Number.isFinite(Number(maxAgeMs)) ? Math.max(60 * 1000, Number(maxAgeMs)) : (24 * 60 * 60 * 1000);
        const now = Date.now();
        const all = await this.getAll();
        let removed = 0;
        Object.keys(all).forEach((requestId) => {
          const row = all[requestId];
          const updatedAt = Number.isFinite(Number(row && row.updatedAt))
            ? Number(row.updatedAt)
            : (Number.isFinite(Number(row && row.createdAt)) ? Number(row.createdAt) : 0);
          if (!updatedAt || (now - updatedAt) > maxAge) {
            delete all[requestId];
            removed += 1;
          }
        });
        if (removed > 0) {
          await this._saveAll(all);
        }
        return { ok: true, removed };
      } catch (_) {
        return { ok: false, removed: 0 };
      }
    }

    nextLease(nowTs) {
      const now = typeof nowTs === 'number' ? nowTs : Date.now();
      return now + this.LEASE_MS;
    }

    async removeByJobId(jobId, { statuses = null, limit = 200 } = {}) {
      if (!jobId) {
        return;
      }
      try {
        const all = await this.getAll();
        const allowStatuses = Array.isArray(statuses) && statuses.length
          ? new Set(statuses.map((item) => this._normalizeStatus(item)))
          : null;
        const keys = Object.keys(all)
          .filter((requestId) => {
            const row = all[requestId];
            if (!row || !row.meta || row.meta.jobId !== jobId) {
              return false;
            }
            const status = this._normalizeStatus(row.status);
            return !allowStatuses || allowStatuses.has(status);
          })
          .slice(0, Math.max(1, Number(limit) || 200));
        keys.forEach((requestId) => {
          delete all[requestId];
        });
        if (keys.length) {
          await this._saveAll(all);
        }
        return keys.length;
      } catch (_) {
        return 0;
      }
    }
  }

  NT.InflightRequestStore = InflightRequestStore;
})(globalThis);
