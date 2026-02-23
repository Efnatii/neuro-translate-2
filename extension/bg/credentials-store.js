/**
 * Credentials persistence for BYOK/PROXY modes.
 *
 * Default secret storage is chrome.storage.session (non-persistent).
 * Optional persistent storage is chrome.storage.local with explicit opt-in.
 */
(function initCredentialsStore(global) {
  const NT = global.NT || (global.NT = {});

  class CredentialsStore {
    constructor({ chromeApi } = {}) {
      this.chromeApi = chromeApi || global.chrome || null;
      this.localKey = 'nt.credentials.local.v1';
      this.sessionKey = 'nt.credentials.session.v1';
      this.legacyApiKeyKey = 'apiKey';
    }

    _normalizeMode(mode) {
      const raw = typeof mode === 'string' ? mode.trim().toUpperCase() : '';
      return raw === 'BYOK' ? 'BYOK' : 'PROXY';
    }

    _normalizeHeaderName(name) {
      const raw = typeof name === 'string' ? name.trim() : '';
      if (!raw) {
        return 'X-NT-Token';
      }
      return raw.replace(/[^A-Za-z0-9-]/g, '').slice(0, 80) || 'X-NT-Token';
    }

    _normalizeBaseUrl(url) {
      const value = typeof url === 'string' ? url.trim() : '';
      if (!value) {
        return '';
      }
      let parsed = null;
      try {
        parsed = new URL(value);
      } catch (_) {
        return '';
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return '';
      }
      parsed.hash = '';
      parsed.search = '';
      let pathname = parsed.pathname || '/';
      if (pathname.length > 1 && pathname.endsWith('/')) {
        pathname = pathname.slice(0, -1);
      }
      parsed.pathname = pathname;
      return parsed.toString().replace(/\/$/, '');
    }

    _safeLocalState(value) {
      const src = value && typeof value === 'object' ? value : {};
      return {
        mode: this._normalizeMode(src.mode || 'PROXY'),
        byokKey: typeof src.byokKey === 'string' ? src.byokKey : '',
        byokPersist: src.byokPersist === true,
        proxy: {
          baseUrl: this._normalizeBaseUrl(src.proxy && src.proxy.baseUrl),
          authHeaderName: this._normalizeHeaderName(src.proxy && src.proxy.authHeaderName),
          projectId: typeof src.proxy?.projectId === 'string' ? src.proxy.projectId.slice(0, 128) : '',
          authTokenPersist: src.proxy && src.proxy.authTokenPersist === true
        },
        proxyAuthToken: typeof src.proxyAuthToken === 'string' ? src.proxyAuthToken : '',
        migratedLegacyApiKey: src.migratedLegacyApiKey === true
      };
    }

    _safeSessionState(value) {
      const src = value && typeof value === 'object' ? value : {};
      return {
        byokKey: typeof src.byokKey === 'string' ? src.byokKey : '',
        proxyAuthToken: typeof src.proxyAuthToken === 'string' ? src.proxyAuthToken : ''
      };
    }

    _localArea() {
      return this.chromeApi && this.chromeApi.storage && this.chromeApi.storage.local
        ? this.chromeApi.storage.local
        : null;
    }

    _sessionArea() {
      const area = this.chromeApi && this.chromeApi.storage && this.chromeApi.storage.session
        ? this.chromeApi.storage.session
        : null;
      return area || this._localArea();
    }

    _storageGet(area, defaults) {
      if (!area || typeof area.get !== 'function') {
        return Promise.resolve(defaults || {});
      }
      return new Promise((resolve) => {
        area.get(defaults, (result) => {
          resolve(result || defaults || {});
        });
      });
    }

    _storageSet(area, payload) {
      if (!area || typeof area.set !== 'function') {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        area.set(payload || {}, () => resolve());
      });
    }

    _storageRemove(area, keys) {
      if (!area || typeof area.remove !== 'function') {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        area.remove(keys, () => resolve());
      });
    }

    async _readState() {
      const localArea = this._localArea();
      const sessionArea = this._sessionArea();
      const localRaw = await this._storageGet(localArea, { [this.localKey]: null, [this.legacyApiKeyKey]: '' });
      let local = this._safeLocalState(localRaw ? localRaw[this.localKey] : null);
      const legacyApiKey = typeof (localRaw && localRaw[this.legacyApiKeyKey]) === 'string'
        ? localRaw[this.legacyApiKeyKey]
        : '';
      if (!local.migratedLegacyApiKey && legacyApiKey && !local.byokKey) {
        local.mode = 'BYOK';
        local.byokKey = legacyApiKey;
        local.byokPersist = true;
        local.migratedLegacyApiKey = true;
        await this._storageSet(localArea, { [this.localKey]: local, [this.legacyApiKeyKey]: '' });
      }
      const sessionRaw = await this._storageGet(sessionArea, { [this.sessionKey]: null });
      const session = this._safeSessionState(sessionRaw ? sessionRaw[this.sessionKey] : null);
      return { local, session };
    }

    async _writeLocal(local) {
      const area = this._localArea();
      await this._storageSet(area, { [this.localKey]: this._safeLocalState(local) });
    }

    async _writeSession(session) {
      const area = this._sessionArea();
      await this._storageSet(area, { [this.sessionKey]: this._safeSessionState(session) });
    }

    async getMode() {
      const state = await this._readState();
      return this._normalizeMode(state.local.mode || 'PROXY');
    }

    async setMode(mode) {
      const state = await this._readState();
      state.local.mode = this._normalizeMode(mode);
      await this._writeLocal(state.local);
      return state.local.mode;
    }

    async setByokKey(key, { persist = false } = {}) {
      const safeKey = typeof key === 'string' ? key.trim() : '';
      const state = await this._readState();
      if (persist) {
        state.local.byokKey = safeKey;
        state.local.byokPersist = true;
        state.session.byokKey = '';
      } else {
        state.session.byokKey = safeKey;
        state.local.byokKey = '';
        state.local.byokPersist = false;
      }
      if (safeKey) {
        state.local.mode = 'BYOK';
      }
      await this._writeLocal(state.local);
      await this._writeSession(state.session);
      return { ok: true, persist: Boolean(persist), hasKey: Boolean(safeKey) };
    }

    async clearByokKey() {
      const state = await this._readState();
      state.local.byokKey = '';
      state.local.byokPersist = false;
      state.session.byokKey = '';
      await this._writeLocal(state.local);
      await this._writeSession(state.session);
      return { ok: true };
    }

    async getByokKey() {
      const state = await this._readState();
      return state.session.byokKey || state.local.byokKey || null;
    }

    async setProxyConfig({ baseUrl, authHeaderName, authToken, projectId, persistToken = false } = {}) {
      const normalizedBaseUrl = this._normalizeBaseUrl(baseUrl);
      if (!normalizedBaseUrl) {
        const error = new Error('Proxy baseUrl is required and must be a valid URL');
        error.code = 'PROXY_URL_INVALID';
        throw error;
      }
      const state = await this._readState();
      state.local.proxy = {
        baseUrl: normalizedBaseUrl,
        authHeaderName: this._normalizeHeaderName(authHeaderName),
        projectId: typeof projectId === 'string' ? projectId.trim().slice(0, 128) : '',
        authTokenPersist: Boolean(persistToken)
      };
      const token = typeof authToken === 'string' ? authToken.trim() : '';
      if (persistToken) {
        state.local.proxyAuthToken = token;
        state.session.proxyAuthToken = '';
      } else {
        state.session.proxyAuthToken = token;
        state.local.proxyAuthToken = '';
      }
      state.local.mode = 'PROXY';
      await this._writeLocal(state.local);
      await this._writeSession(state.session);
      return {
        ok: true,
        mode: 'PROXY',
        proxy: {
          baseUrl: normalizedBaseUrl,
          authHeaderName: state.local.proxy.authHeaderName,
          projectId: state.local.proxy.projectId || null,
          hasAuthToken: Boolean(token),
          authTokenPersisted: Boolean(persistToken)
        }
      };
    }

    async getProxyConfig() {
      const state = await this._readState();
      const proxy = state.local.proxy || {};
      return {
        baseUrl: proxy.baseUrl || '',
        authHeaderName: this._normalizeHeaderName(proxy.authHeaderName),
        authToken: state.session.proxyAuthToken || state.local.proxyAuthToken || '',
        projectId: proxy.projectId || '',
        authTokenPersisted: Boolean(proxy.authTokenPersist && state.local.proxyAuthToken)
      };
    }

    async clearProxyConfig() {
      const state = await this._readState();
      state.local.proxy = {
        baseUrl: '',
        authHeaderName: 'X-NT-Token',
        projectId: '',
        authTokenPersist: false
      };
      state.local.proxyAuthToken = '';
      state.session.proxyAuthToken = '';
      await this._writeLocal(state.local);
      await this._writeSession(state.session);
      return { ok: true };
    }

    async getPublicSnapshot() {
      const state = await this._readState();
      const mode = this._normalizeMode(state.local.mode || 'PROXY');
      const byokSession = Boolean(state.session.byokKey);
      const byokPersisted = Boolean(state.local.byokKey && state.local.byokPersist === true);
      const hasByokKey = byokSession || byokPersisted;
      const proxyTokenSession = Boolean(state.session.proxyAuthToken);
      const proxyTokenPersisted = Boolean(state.local.proxyAuthToken && state.local.proxy && state.local.proxy.authTokenPersist);
      const hasProxyToken = proxyTokenSession || proxyTokenPersisted;
      const proxy = state.local.proxy && typeof state.local.proxy === 'object' ? state.local.proxy : {};
      const sessionAreaExists = Boolean(this.chromeApi && this.chromeApi.storage && this.chromeApi.storage.session);
      return {
        mode,
        recommendedMode: 'PROXY',
        hasByokKey,
        byokPersisted,
        byokSession,
        proxy: {
          baseUrl: proxy.baseUrl || '',
          authHeaderName: this._normalizeHeaderName(proxy.authHeaderName),
          projectId: proxy.projectId || '',
          hasAuthToken: hasProxyToken,
          authTokenPersisted: proxyTokenPersisted,
          authTokenSession: proxyTokenSession
        },
        storage: {
          sessionAvailable: sessionAreaExists,
          sessionFallbackToLocal: !sessionAreaExists
        }
      };
    }

    getStorageKeys() {
      return {
        localKey: this.localKey,
        sessionKey: this.sessionKey,
        legacyApiKeyKey: this.legacyApiKeyKey
      };
    }
  }

  NT.CredentialsStore = CredentialsStore;
})(globalThis);
