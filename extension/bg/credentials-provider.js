/**
 * CredentialsProvider resolves endpoint/auth headers for BYOK vs PROXY modes.
 */
(function initCredentialsProvider(global) {
  const NT = global.NT || (global.NT = {});

  class CredentialsProvider {
    constructor({ credentialsStore } = {}) {
      this.credentialsStore = credentialsStore || null;
      this.openAiBase = 'https://api.openai.com/v1';
    }

    _stripTrailingSlash(url) {
      const value = typeof url === 'string' ? url.trim() : '';
      return value ? value.replace(/\/+$/, '') : '';
    }

    _join(base, suffix) {
      const left = this._stripTrailingSlash(base);
      const right = typeof suffix === 'string' ? suffix : '';
      if (!left) {
        return right || '';
      }
      if (!right) {
        return left;
      }
      if (right.startsWith('/')) {
        return `${left}${right}`;
      }
      return `${left}/${right}`;
    }

    _parseHost(url) {
      try {
        return new URL(url).host;
      } catch (_) {
        return null;
      }
    }

    async _readMode() {
      if (!this.credentialsStore || typeof this.credentialsStore.getMode !== 'function') {
        return 'BYOK';
      }
      return this.credentialsStore.getMode();
    }

    async buildBaseUrl() {
      const mode = await this._readMode();
      if (mode === 'PROXY') {
        const proxy = this.credentialsStore && typeof this.credentialsStore.getProxyConfig === 'function'
          ? await this.credentialsStore.getProxyConfig()
          : null;
        return this._stripTrailingSlash(proxy && proxy.baseUrl ? proxy.baseUrl : '');
      }
      return this.openAiBase;
    }

    async buildEndpointUrl(path = '/responses') {
      const mode = await this._readMode();
      if (mode === 'PROXY') {
        const base = await this.buildBaseUrl();
        const normalizedPath = String(path || '').replace(/^\/+/, '');
        if (!base) {
          return '';
        }
        const prefix = normalizedPath.startsWith('v1/') ? '' : 'v1/';
        return this._join(base, `${prefix}${normalizedPath}`);
      }
      const openAiBase = this.openAiBase;
      const normalizedPath = String(path || '').replace(/^\/+/, '');
      return this._join(openAiBase, normalizedPath);
    }

    async buildRequestAuthHeaders({ target = 'openai' } = {}) {
      const mode = await this._readMode();
      if (mode === 'PROXY') {
        const proxy = this.credentialsStore && typeof this.credentialsStore.getProxyConfig === 'function'
          ? await this.credentialsStore.getProxyConfig()
          : null;
        const headers = {};
        if (target === 'proxy') {
          const token = proxy && typeof proxy.authToken === 'string' ? proxy.authToken.trim() : '';
          const headerName = proxy && typeof proxy.authHeaderName === 'string' && proxy.authHeaderName.trim()
            ? proxy.authHeaderName.trim()
            : 'X-NT-Token';
          if (token) {
            headers[headerName] = token;
          }
          if (proxy && typeof proxy.projectId === 'string' && proxy.projectId.trim()) {
            headers['X-NT-Project-ID'] = proxy.projectId.trim().slice(0, 128);
          }
        }
        return headers;
      }

      const key = this.credentialsStore && typeof this.credentialsStore.getByokKey === 'function'
        ? await this.credentialsStore.getByokKey()
        : null;
      if (!key) {
        return {};
      }
      return {
        Authorization: `Bearer ${String(key).trim()}`
      };
    }

    async validateConfiguredOrThrow(stage = 'request') {
      const mode = await this._readMode();
      if (mode === 'PROXY') {
        const baseUrl = await this.buildBaseUrl();
        if (!baseUrl) {
          const error = new Error('Proxy URL is not configured');
          error.code = 'PROXY_NOT_CONFIGURED';
          error.stage = stage;
          throw error;
        }
        const endpointUrl = await this.buildEndpointUrl('/responses');
        return {
          mode,
          target: 'proxy',
          baseUrl,
          endpointUrl,
          endpointHost: this._parseHost(endpointUrl),
          hasAuth: Object.keys(await this.buildRequestAuthHeaders({ target: 'proxy' })).length > 0
        };
      }

      const byokKey = this.credentialsStore && typeof this.credentialsStore.getByokKey === 'function'
        ? await this.credentialsStore.getByokKey()
        : null;
      if (!byokKey) {
        const error = new Error('Missing OpenAI API key');
        error.code = 'NO_API_KEY';
        error.stage = stage;
        throw error;
      }
      const endpointUrl = await this.buildEndpointUrl('/responses');
      return {
        mode,
        target: 'openai',
        baseUrl: this.openAiBase,
        endpointUrl,
        endpointHost: this._parseHost(endpointUrl),
        hasAuth: true
      };
    }

    async buildConnectionContext({ stage = 'request' } = {}) {
      const validated = await this.validateConfiguredOrThrow(stage);
      const target = validated.target === 'proxy' ? 'proxy' : 'openai';
      const authHeaders = await this.buildRequestAuthHeaders({ target });
      return {
        mode: validated.mode,
        target,
        baseUrl: validated.baseUrl,
        responsesUrl: await this.buildEndpointUrl('/responses'),
        modelsUrl: await this.buildEndpointUrl('/models'),
        endpointHost: validated.endpointHost || this._parseHost(validated.endpointUrl),
        authHeaders,
        hasAuth: Object.keys(authHeaders || {}).length > 0
      };
    }
  }

  NT.CredentialsProvider = CredentialsProvider;
})(globalThis);
