(function initModelRateLimitStore(global) {
  const STORAGE_KEY = 'modelRateLimits';

  class ModelRateLimitStore {
    constructor({ chromeApi } = {}) {
      this.chromeApi = chromeApi;
    }

    async get(modelSpec) {
      if (!modelSpec) {
        return null;
      }
      const all = await this.getAll();
      return all[modelSpec] || null;
    }

    async getAll() {
      const data = await this.storageGet({ [STORAGE_KEY]: {} });
      return data[STORAGE_KEY] || {};
    }

    async upsertFromHeaders(modelSpec, headers, { receivedAt } = {}) {
      if (!modelSpec || !headers || typeof headers.get !== 'function') {
        return;
      }

      const now = typeof receivedAt === 'number' ? receivedAt : Date.now();
      const all = await this.getAll();
      const current = all[modelSpec] || {};

      const next = {
        ...current,
        updatedAt: now,
        limitRequests: this.parseNumber(headers.get('x-ratelimit-limit-requests')),
        limitTokens: this.parseNumber(headers.get('x-ratelimit-limit-tokens')),
        remainingRequests: this.parseNumber(headers.get('x-ratelimit-remaining-requests')),
        remainingTokens: this.parseNumber(headers.get('x-ratelimit-remaining-tokens')),
        resetRequestsAt: this.computeResetAt(headers.get('x-ratelimit-reset-requests'), now),
        resetTokensAt: this.computeResetAt(headers.get('x-ratelimit-reset-tokens'), now)
      };

      all[modelSpec] = next;
      await this.storageSet({ [STORAGE_KEY]: all });
    }

    computeAvailability(modelSpec, { estTokens = 0, now } = {}) {
      const all = this.cachedAll || null;
      const modelMap = all && typeof all === 'object' ? all : null;
      const snapshot = modelMap && modelSpec ? modelMap[modelSpec] || null : null;
      const current = snapshot || null;
      const nowTs = typeof now === 'number' ? now : Date.now();

      if (!current) {
        return { ok: true, waitMs: 0, reason: 'unknown_limits' };
      }

      if (current.remainingRequests !== null && current.remainingRequests !== undefined && current.remainingRequests < 1) {
        const waitMs = current.resetRequestsAt ? Math.max(0, current.resetRequestsAt - nowTs) : 60000;
        return { ok: false, waitMs, reason: 'blockedByRequests' };
      }

      const tokenNeed = typeof estTokens === 'number' && estTokens > 0 ? estTokens : 0;
      if (current.remainingTokens !== null && current.remainingTokens !== undefined && tokenNeed > 0 && current.remainingTokens < tokenNeed) {
        const waitMs = current.resetTokensAt ? Math.max(0, current.resetTokensAt - nowTs) : 60000;
        return { ok: false, waitMs, reason: 'blockedByTokens' };
      }

      const noLimits = current.remainingRequests === null && current.remainingTokens === null;
      return noLimits
        ? { ok: true, waitMs: 0, reason: 'unknown_limits' }
        : { ok: true, waitMs: 0, reason: 'ok' };
    }

    withCached(all) {
      this.cachedAll = all || {};
      return this;
    }

    parseDurationMs(rawValue) {
      if (typeof rawValue !== 'string' || !rawValue.trim()) {
        return null;
      }
      const value = rawValue.trim();
      const pattern = /(\d+)(ms|s|m|h)/g;
      let total = 0;
      let consumed = '';
      let match = pattern.exec(value);

      while (match) {
        const amount = Number(match[1]);
        const unit = match[2];
        if (!Number.isFinite(amount)) {
          return null;
        }
        if (unit === 'ms') {
          total += amount;
        } else if (unit === 's') {
          total += amount * 1000;
        } else if (unit === 'm') {
          total += amount * 60 * 1000;
        } else if (unit === 'h') {
          total += amount * 60 * 60 * 1000;
        }
        consumed += match[0];
        match = pattern.exec(value);
      }

      return consumed === value ? total : null;
    }

    computeResetAt(resetRaw, receivedAt) {
      const durationMs = this.parseDurationMs(resetRaw);
      if (durationMs === null) {
        return null;
      }
      return receivedAt + durationMs;
    }

    parseNumber(rawValue) {
      if (rawValue === null || rawValue === undefined || rawValue === '') {
        return null;
      }
      const value = Number(rawValue);
      return Number.isFinite(value) ? value : null;
    }

    storageGet(defaults) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve(defaults || {});
      }
      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(defaults, (result) => resolve(result || defaults || {}));
      });
    }

    storageSet(payload) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        this.chromeApi.storage.local.set(payload, () => resolve());
      });
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.ModelRateLimitStore = ModelRateLimitStore;
})(globalThis);
