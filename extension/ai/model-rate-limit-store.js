/**
 * Persistent per-model rate-limit, fairness, and reservation snapshots.
 *
 * Besides provider header fields (`x-ratelimit-*`), this store tracks cooldown
 * windows, short usage history for fairness penalties, and active request
 * reservations with leases. Reservations let availability checks subtract
 * in-flight budget pressure to avoid over-committing RPM/TPM under concurrency.
 *
 * MV3 note: service-worker restarts are expected. All fields are persisted and
 * reservation leases self-heal automatically via expiration cleanup.
 */
(function initModelRateLimitStore(global) {
  const STORAGE_KEY = 'modelRateLimits';
  const FAIRNESS_WINDOW_MS = 60000;

  class ModelRateLimitStore extends global.NT.ChromeLocalStoreBase {
    constructor({ chromeApi } = {}) {
      super({ chromeApi });
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

    normalizeSnapshot(current) {
      const src = current || {};
      return {
        ...src,
        cooldownUntilTs: typeof src.cooldownUntilTs === 'number' ? src.cooldownUntilTs : null,
        lastChosenAt: typeof src.lastChosenAt === 'number' ? src.lastChosenAt : null,
        chosenCountWindow: src.chosenCountWindow || null,
        reservations: Array.isArray(src.reservations) ? src.reservations.filter((item) => item && item.id) : []
      };
    }

    async upsertFromHeaders(modelSpec, headers, { receivedAt } = {}) {
      if (!modelSpec || !headers || typeof headers.get !== 'function') {
        return;
      }

      const now = typeof receivedAt === 'number' ? receivedAt : Date.now();
      const all = await this.getAll();
      const current = this.normalizeSnapshot(all[modelSpec] || {});

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

      all[modelSpec] = this._cleanupReservations(next, now);
      await this.storageSet({ [STORAGE_KEY]: all });
      this.cachedAll = all;
    }

    async markChosen(modelSpec, { now } = {}) {
      if (!modelSpec) {
        return;
      }
      const ts = typeof now === 'number' ? now : Date.now();
      const all = await this.getAll();
      const current = this.normalizeSnapshot(all[modelSpec] || {});
      const window = current.chosenCountWindow || null;
      let nextWindow;
      if (!window || typeof window.startTs !== 'number' || ts - window.startTs > FAIRNESS_WINDOW_MS) {
        nextWindow = { startTs: ts, count: 1 };
      } else {
        nextWindow = { startTs: window.startTs, count: (window.count || 0) + 1 };
      }

      all[modelSpec] = {
        ...current,
        lastChosenAt: ts,
        chosenCountWindow: nextWindow,
        reservations: this._cleanupReservations(current, ts).reservations
      };
      await this.storageSet({ [STORAGE_KEY]: all });
      this.cachedAll = all;
    }

    async applyCooldown(modelSpec, { now, retryAfterMs } = {}) {
      if (!modelSpec) {
        return null;
      }
      const ts = typeof now === 'number' ? now : Date.now();
      const base = Number(retryAfterMs);
      const bounded = Number.isFinite(base) ? Math.max(250, Math.min(15 * 60 * 1000, base)) : 30000;
      const jitter = Math.floor(Math.random() * 251);
      const cooldownUntilTs = ts + bounded + jitter;

      const all = await this.getAll();
      const current = this.normalizeSnapshot(all[modelSpec] || {});
      all[modelSpec] = {
        ...current,
        cooldownUntilTs,
        reservations: this._cleanupReservations(current, ts).reservations
      };
      await this.storageSet({ [STORAGE_KEY]: all });
      this.cachedAll = all;
      return cooldownUntilTs;
    }

    _cleanupReservations(snapshot, now) {
      const ts = typeof now === 'number' ? now : Date.now();
      const current = this.normalizeSnapshot(snapshot || {});
      current.reservations = current.reservations.filter((item) => {
        if (!item || !item.id) {
          return false;
        }
        if (typeof item.leaseUntilTs !== 'number') {
          return false;
        }
        return item.leaseUntilTs > ts;
      });
      return current;
    }

    _sumReservations(snapshot, now) {
      const cleaned = this._cleanupReservations(snapshot, now);
      return cleaned.reservations.reduce((acc, item) => {
        const tokens = Number.isFinite(Number(item.tokens)) ? Math.max(0, Number(item.tokens)) : 0;
        const requests = Number.isFinite(Number(item.requests)) ? Math.max(0, Number(item.requests)) : 0;
        return {
          tokens: acc.tokens + tokens,
          requests: acc.requests + requests
        };
      }, { tokens: 0, requests: 0 });
    }

    async reserve(modelSpec, { id, tokens, requests, leaseMs, now } = {}) {
      if (!modelSpec || !id) {
        return;
      }
      const ts = typeof now === 'number' ? now : Date.now();
      const safeTokens = Number.isFinite(Number(tokens)) ? Math.max(0, Number(tokens) | 0) : 0;
      const safeRequestsRaw = Number.isFinite(Number(requests)) ? Number(requests) | 0 : 1;
      const safeRequests = Math.max(1, safeRequestsRaw);
      const lease = Number.isFinite(Number(leaseMs)) ? Math.max(10000, Math.min(180000, Number(leaseMs))) : 120000;

      const all = await this.getAll();
      const current = this._cleanupReservations(all[modelSpec] || {}, ts);
      const reservations = current.reservations.filter((item) => item.id !== id);
      reservations.push({ id, tokens: safeTokens, requests: safeRequests, leaseUntilTs: ts + lease });
      all[modelSpec] = { ...current, reservations };
      await this.storageSet({ [STORAGE_KEY]: all });
      this.cachedAll = all;
    }

    async release(modelSpec, id) {
      if (!modelSpec || !id) {
        return;
      }
      const all = await this.getAll();
      const current = this.normalizeSnapshot(all[modelSpec] || {});
      const reservations = current.reservations.filter((item) => item.id !== id);
      all[modelSpec] = { ...current, reservations };
      await this.storageSet({ [STORAGE_KEY]: all });
      this.cachedAll = all;
    }

    isInCooldown(snapshot, now) {
      const ts = typeof now === 'number' ? now : Date.now();
      return Boolean(snapshot && typeof snapshot.cooldownUntilTs === 'number' && snapshot.cooldownUntilTs > ts);
    }

    usagePenalty(snapshot, now) {
      if (!snapshot) {
        return 0;
      }
      const ts = typeof now === 'number' ? now : Date.now();
      let penalty = 0;
      const window = snapshot.chosenCountWindow || null;
      if (window && typeof window.startTs === 'number' && ts - window.startTs <= FAIRNESS_WINDOW_MS) {
        penalty += (window.count || 0) * 0.15;
      }
      if (typeof snapshot.lastChosenAt === 'number' && ts - snapshot.lastChosenAt < 1500) {
        penalty += 1.0;
      }
      return penalty;
    }

    computeAvailability(modelSpec, { estTokens = 0, now } = {}) {
      const all = this.cachedAll || null;
      const modelMap = all && typeof all === 'object' ? all : null;
      const snapshot = modelMap && modelSpec ? modelMap[modelSpec] || null : null;
      const nowTs = typeof now === 'number' ? now : Date.now();

      if (!snapshot) {
        return { ok: true, waitMs: 0, reason: 'unknown_limits' };
      }

      const current = this._cleanupReservations(snapshot, nowTs);
      const reserved = this._sumReservations(current, nowTs);

      if (this.isInCooldown(current, nowTs)) {
        return { ok: false, waitMs: Math.max(0, current.cooldownUntilTs - nowTs), reason: 'cooldown' };
      }

      const effectiveRequests = typeof current.remainingRequests === 'number'
        ? current.remainingRequests - reserved.requests
        : null;
      if (effectiveRequests !== null && effectiveRequests < 1) {
        const baseWait = current.resetRequestsAt ? Math.max(0, current.resetRequestsAt - nowTs) : 60000;
        return { ok: false, waitMs: baseWait + Math.floor(Math.random() * 201), reason: 'reserved_or_limit' };
      }

      const tokenNeed = typeof estTokens === 'number' && estTokens > 0 ? estTokens : 0;
      const effectiveTokens = typeof current.remainingTokens === 'number'
        ? current.remainingTokens - reserved.tokens
        : null;
      if (effectiveTokens !== null && tokenNeed > 0 && effectiveTokens < tokenNeed) {
        const waitReq = current.resetRequestsAt ? Math.max(0, current.resetRequestsAt - nowTs) : null;
        const waitTok = current.resetTokensAt ? Math.max(0, current.resetTokensAt - nowTs) : null;
        const baseWait = waitReq === null && waitTok === null ? 60000 : Math.min(...[waitReq, waitTok].filter((v) => typeof v === 'number'));
        return { ok: false, waitMs: baseWait + Math.floor(Math.random() * 201), reason: 'reserved_or_limit' };
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

    computeResetAt(resetRaw, receivedAt) {
      const Duration = global.NT.Duration;
      const durationMs = Duration.parseMs(resetRaw);
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
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.ModelRateLimitStore = ModelRateLimitStore;
})(globalThis);
