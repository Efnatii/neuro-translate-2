/**
 * Shared provider-level rate-limit budget store.
 *
 * Coordinates request/token reservations across jobs/tabs to avoid burst storms.
 */
(function initRateLimitBudgetStore(global) {
  const NT = global.NT || (global.NT = {});

  class RateLimitBudgetStore extends NT.ChromeLocalStoreBase {
    constructor({
      chromeApi,
      storageKey = 'ntRateLimitBudgetV1',
      defaultLeaseMs = 120000
    } = {}) {
      super({ chromeApi });
      this.storageKey = typeof storageKey === 'string' && storageKey ? storageKey : 'ntRateLimitBudgetV1';
      this.defaultLeaseMs = Number.isFinite(Number(defaultLeaseMs))
        ? Math.max(30000, Number(defaultLeaseMs))
        : 120000;
    }

    _now() {
      return Date.now();
    }

    _parseNumber(value) {
      if (value === null || value === undefined || value === '') {
        return null;
      }
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }

    _hasFiniteNumber(value) {
      if (value === null || value === undefined || value === '') {
        return false;
      }
      return Number.isFinite(Number(value));
    }

    _parseResetMs(value) {
      if (value === null || value === undefined || value === '') {
        return null;
      }
      const Duration = NT.Duration || null;
      if (Duration && typeof Duration.parseMs === 'function') {
        const parsed = Duration.parseMs(value);
        if (parsed !== null && parsed !== undefined) {
          return Number(parsed);
        }
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return null;
      }
      if (numeric > 1000) {
        return Math.max(0, Math.round(numeric));
      }
      return Math.max(0, Math.round(numeric * 1000));
    }

    _normalizeState(raw) {
      const src = raw && typeof raw === 'object' ? raw : {};
      const byProviderSrc = src.byProvider && typeof src.byProvider === 'object'
        ? src.byProvider
        : {};
      const out = {
        v: 1,
        byProvider: {},
        updatedAt: Number.isFinite(Number(src.updatedAt)) ? Number(src.updatedAt) : this._now()
      };
      Object.keys(byProviderSrc).forEach((providerKey) => {
        const provider = String(providerKey || '').trim().toLowerCase();
        if (!provider) {
          return;
        }
        const row = byProviderSrc[providerKey] && typeof byProviderSrc[providerKey] === 'object'
          ? byProviderSrc[providerKey]
          : {};
        const grantsSrc = row.grants && typeof row.grants === 'object' ? row.grants : {};
        const grants = {};
        Object.keys(grantsSrc).forEach((grantId) => {
          const grant = grantsSrc[grantId] && typeof grantsSrc[grantId] === 'object' ? grantsSrc[grantId] : null;
          if (!grant || !grant.grantId) {
            return;
          }
          grants[grantId] = {
            grantId,
            provider,
            jobId: grant.jobId || null,
            model: grant.model || null,
            estTokens: Number.isFinite(Number(grant.estTokens)) ? Math.max(0, Number(grant.estTokens)) : 0,
            estRequests: Number.isFinite(Number(grant.estRequests)) ? Math.max(1, Number(grant.estRequests)) : 1,
            createdTs: Number.isFinite(Number(grant.createdTs)) ? Number(grant.createdTs) : this._now(),
            leaseUntilTs: Number.isFinite(Number(grant.leaseUntilTs))
              ? Number(grant.leaseUntilTs)
              : (this._now() + this.defaultLeaseMs)
          };
        });
        out.byProvider[provider] = {
          provider,
          updatedAt: Number.isFinite(Number(row.updatedAt)) ? Number(row.updatedAt) : this._now(),
          cooldownUntilTs: this._hasFiniteNumber(row.cooldownUntilTs) ? Number(row.cooldownUntilTs) : null,
          global: {
            requestsRemaining: this._parseNumber(row.global && row.global.requestsRemaining),
            tokensRemaining: this._parseNumber(row.global && row.global.tokensRemaining),
            resetAt: this._hasFiniteNumber(row.global && row.global.resetAt) ? Number(row.global.resetAt) : null
          },
          perModel: row.perModel && typeof row.perModel === 'object' ? row.perModel : {},
          grants
        };
      });
      return out;
    }

    _normalizeProvider(provider) {
      const raw = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
      if (!raw) {
        return 'openai';
      }
      return raw;
    }

    async _loadState() {
      const data = await this.storageGet({
        [this.storageKey]: {
          v: 1,
          byProvider: {},
          updatedAt: this._now()
        }
      });
      return this._normalizeState(data && data[this.storageKey]);
    }

    async _saveState(stateLike) {
      const normalized = this._normalizeState(stateLike);
      normalized.updatedAt = this._now();
      await this.storageSet({ [this.storageKey]: normalized });
      return normalized;
    }

    _cleanupGrants(providerState, nowTs) {
      const now = Number.isFinite(Number(nowTs)) ? Number(nowTs) : this._now();
      const src = providerState && providerState.grants && typeof providerState.grants === 'object'
        ? providerState.grants
        : {};
      const grants = {};
      Object.keys(src).forEach((grantId) => {
        const row = src[grantId];
        if (!row) {
          return;
        }
        const leaseUntilTs = Number.isFinite(Number(row.leaseUntilTs))
          ? Number(row.leaseUntilTs)
          : (now + this.defaultLeaseMs);
        if (leaseUntilTs <= now) {
          return;
        }
        grants[grantId] = {
          ...row,
          leaseUntilTs
        };
      });
      return {
        ...(providerState || {}),
        grants
      };
    }

    _sumGrants(grants, { model = null } = {}) {
      const src = grants && typeof grants === 'object' ? grants : {};
      const targetModel = model && typeof model === 'string' ? model : null;
      return Object.keys(src).reduce((acc, grantId) => {
        const row = src[grantId];
        if (!row) {
          return acc;
        }
        if (targetModel && row.model && row.model !== targetModel) {
          return acc;
        }
        acc.requests += Number.isFinite(Number(row.estRequests)) ? Math.max(0, Number(row.estRequests)) : 0;
        acc.tokens += Number.isFinite(Number(row.estTokens)) ? Math.max(0, Number(row.estTokens)) : 0;
        return acc;
      }, { requests: 0, tokens: 0 });
    }

    _headerValue(headers, key) {
      if (!headers) {
        return null;
      }
      if (typeof headers.get === 'function') {
        try {
          return headers.get(key);
        } catch (_) {
          return null;
        }
      }
      if (headers && typeof headers === 'object') {
        const exact = headers[key];
        if (exact !== undefined) {
          return exact;
        }
        const keys = Object.keys(headers);
        for (let i = 0; i < keys.length; i += 1) {
          if (String(keys[i]).toLowerCase() === String(key).toLowerCase()) {
            return headers[keys[i]];
          }
        }
      }
      return null;
    }

    async updateFromHeaders({ provider = 'openai', model = null, headersSubset, ts = null } = {}) {
      const providerKey = this._normalizeProvider(provider);
      const now = Number.isFinite(Number(ts)) ? Number(ts) : this._now();
      const remainingRequests = this._parseNumber(this._headerValue(headersSubset, 'x-ratelimit-remaining-requests'));
      const remainingTokens = this._parseNumber(this._headerValue(headersSubset, 'x-ratelimit-remaining-tokens'));
      const resetReqMs = this._parseResetMs(this._headerValue(headersSubset, 'x-ratelimit-reset-requests'));
      const resetTokMs = this._parseResetMs(this._headerValue(headersSubset, 'x-ratelimit-reset-tokens'));
      const resetAt = [resetReqMs, resetTokMs]
        .filter((item) => Number.isFinite(Number(item)))
        .map((item) => now + Number(item))
        .sort((a, b) => a - b)[0] || null;

      const state = await this._loadState();
      const current = this._cleanupGrants(state.byProvider[providerKey] || {
        provider: providerKey,
        updatedAt: now,
        cooldownUntilTs: null,
        global: { requestsRemaining: null, tokensRemaining: null, resetAt: null },
        perModel: {},
        grants: {}
      }, now);

      current.updatedAt = now;
      current.global = {
        requestsRemaining: remainingRequests !== null ? remainingRequests : current.global.requestsRemaining,
        tokensRemaining: remainingTokens !== null ? remainingTokens : current.global.tokensRemaining,
        resetAt: resetAt !== null ? resetAt : current.global.resetAt
      };
      if (model && typeof model === 'string') {
        const perModel = current.perModel && typeof current.perModel === 'object' ? current.perModel : {};
        perModel[model] = {
          requestsRemaining: remainingRequests,
          tokensRemaining: remainingTokens,
          resetAt,
          updatedAt: now
        };
        current.perModel = perModel;
      }
      state.byProvider[providerKey] = current;
      await this._saveState(state);
      return this.getBudgetSnapshot({ provider: providerKey });
    }

    async getBudgetSnapshot({ provider = 'openai' } = {}) {
      const providerKey = this._normalizeProvider(provider);
      const state = await this._loadState();
      const now = this._now();
      const current = this._cleanupGrants(state.byProvider[providerKey] || {
        provider: providerKey,
        updatedAt: now,
        cooldownUntilTs: null,
        global: { requestsRemaining: null, tokensRemaining: null, resetAt: null },
        perModel: {},
        grants: {}
      }, now);
      state.byProvider[providerKey] = current;
      await this._saveState(state);

      const reserved = this._sumGrants(current.grants);
      const requestsRemaining = current.global && this._hasFiniteNumber(current.global.requestsRemaining)
        ? Number(current.global.requestsRemaining) - reserved.requests
        : null;
      const tokensRemaining = current.global && this._hasFiniteNumber(current.global.tokensRemaining)
        ? Number(current.global.tokensRemaining) - reserved.tokens
        : null;
      return {
        provider: providerKey,
        requestsRemaining: requestsRemaining !== null ? requestsRemaining : null,
        tokensRemaining: tokensRemaining !== null ? tokensRemaining : null,
        resetAt: current.global && this._hasFiniteNumber(current.global.resetAt)
          ? Number(current.global.resetAt)
          : null,
        cooldownUntilTs: this._hasFiniteNumber(current.cooldownUntilTs)
          ? Number(current.cooldownUntilTs)
          : null,
        reservedRequests: reserved.requests,
        reservedTokens: reserved.tokens,
        perModel: current.perModel && typeof current.perModel === 'object'
          ? { ...current.perModel }
          : {},
        grantsCount: Object.keys(current.grants || {}).length,
        updatedAt: current.updatedAt || now
      };
    }

    async reserve({
      provider = 'openai',
      jobId = null,
      model = null,
      estTokens = 0,
      estRequests = 1,
      leaseMs = null
    } = {}) {
      const providerKey = this._normalizeProvider(provider);
      const now = this._now();
      const state = await this._loadState();
      const current = this._cleanupGrants(state.byProvider[providerKey] || {
        provider: providerKey,
        updatedAt: now,
        cooldownUntilTs: null,
        global: { requestsRemaining: null, tokensRemaining: null, resetAt: null },
        perModel: {},
        grants: {}
      }, now);
      const estReq = Number.isFinite(Number(estRequests)) ? Math.max(1, Number(estRequests)) : 1;
      const estTok = Number.isFinite(Number(estTokens)) ? Math.max(0, Number(estTokens)) : 0;

      if (this._hasFiniteNumber(current.cooldownUntilTs) && Number(current.cooldownUntilTs) > now) {
        return {
          ok: false,
          waitMs: Math.max(0, Number(current.cooldownUntilTs) - now),
          reason: 'cooldown'
        };
      }

      const reserved = this._sumGrants(current.grants);
      const globalReq = this._hasFiniteNumber(current.global && current.global.requestsRemaining)
        ? Number(current.global.requestsRemaining) - reserved.requests
        : null;
      const globalTok = this._hasFiniteNumber(current.global && current.global.tokensRemaining)
        ? Number(current.global.tokensRemaining) - reserved.tokens
        : null;
      const modelRow = model && current.perModel && typeof current.perModel === 'object'
        ? current.perModel[model] || null
        : null;
      const modelReserved = model ? this._sumGrants(current.grants, { model }) : { requests: 0, tokens: 0 };
      const modelReq = modelRow && this._hasFiniteNumber(modelRow.requestsRemaining)
        ? Number(modelRow.requestsRemaining) - modelReserved.requests
        : null;
      const modelTok = modelRow && this._hasFiniteNumber(modelRow.tokensRemaining)
        ? Number(modelRow.tokensRemaining) - modelReserved.tokens
        : null;

      const resetCandidates = [
        current.global && this._hasFiniteNumber(current.global.resetAt) ? Number(current.global.resetAt) : null,
        modelRow && this._hasFiniteNumber(modelRow.resetAt) ? Number(modelRow.resetAt) : null
      ].filter((item) => this._hasFiniteNumber(item));
      const resetAt = resetCandidates.length ? Math.min(...resetCandidates) : null;
      if ((globalReq !== null && globalReq < estReq) || (modelReq !== null && modelReq < estReq)) {
        return {
          ok: false,
          waitMs: resetAt ? Math.max(0, resetAt - now) : 60000,
          reason: 'requests_limit'
        };
      }
      if ((globalTok !== null && globalTok < estTok) || (modelTok !== null && modelTok < estTok)) {
        return {
          ok: false,
          waitMs: resetAt ? Math.max(0, resetAt - now) : 60000,
          reason: 'tokens_limit'
        };
      }

      const grantId = `grant:${providerKey}:${now}:${Math.random().toString(16).slice(2, 9)}`;
      current.grants[grantId] = {
        grantId,
        provider: providerKey,
        jobId: jobId || null,
        model: model || null,
        estTokens: estTok,
        estRequests: estReq,
        createdTs: now,
        leaseUntilTs: now + (Number.isFinite(Number(leaseMs)) ? Math.max(10000, Number(leaseMs)) : this.defaultLeaseMs)
      };
      current.updatedAt = now;
      state.byProvider[providerKey] = current;
      await this._saveState(state);
      return {
        ok: true,
        grantId,
        waitMs: 0
      };
    }

    async release({ grantId, usedTokens = null, usedRequests = null } = {}) {
      const safeGrantId = typeof grantId === 'string' ? grantId.trim() : '';
      if (!safeGrantId) {
        return { ok: false };
      }
      const state = await this._loadState();
      let released = false;
      Object.keys(state.byProvider || {}).forEach((provider) => {
        const row = state.byProvider[provider];
        if (!row || !row.grants || typeof row.grants !== 'object') {
          return;
        }
        if (!row.grants[safeGrantId]) {
          return;
        }
        delete row.grants[safeGrantId];
        row.updatedAt = this._now();
        released = true;
      });
      if (!released) {
        return { ok: false };
      }
      await this._saveState(state);
      return {
        ok: true,
        usedTokens: Number.isFinite(Number(usedTokens)) ? Number(usedTokens) : null,
        usedRequests: Number.isFinite(Number(usedRequests)) ? Number(usedRequests) : null
      };
    }

    async on429({
      provider = 'openai',
      jobId = null,
      model = null,
      retryAfterMs = null,
      headersSubset = null
    } = {}) {
      const providerKey = this._normalizeProvider(provider);
      await this.updateFromHeaders({
        provider: providerKey,
        model,
        headersSubset,
        ts: this._now()
      }).catch(() => null);

      const state = await this._loadState();
      const now = this._now();
      const current = this._cleanupGrants(state.byProvider[providerKey] || {
        provider: providerKey,
        updatedAt: now,
        cooldownUntilTs: null,
        global: { requestsRemaining: null, tokensRemaining: null, resetAt: null },
        perModel: {},
        grants: {}
      }, now);
      const retryMs = Number.isFinite(Number(retryAfterMs))
        ? Math.max(250, Math.min(15 * 60 * 1000, Number(retryAfterMs)))
        : 30000;
      const nextCooldown = now + retryMs;
      current.cooldownUntilTs = this._hasFiniteNumber(current.cooldownUntilTs)
        ? Math.max(Number(current.cooldownUntilTs), nextCooldown)
        : nextCooldown;
      current.updatedAt = now;
      state.byProvider[providerKey] = current;
      await this._saveState(state);
      return {
        ok: true,
        provider: providerKey,
        jobId: jobId || null,
        model: model || null,
        cooldownUntilTs: current.cooldownUntilTs
      };
    }
  }

  NT.RateLimitBudgetStore = RateLimitBudgetStore;
})(globalThis);
