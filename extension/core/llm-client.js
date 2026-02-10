(function initLlmClient(global) {
  class LlmClient {
    constructor({ chromeApi, fetchFn, baseUrl }) {
      this.chromeApi = chromeApi;
      this.fetchFn = fetchFn || global.fetch;
      this.baseUrl = baseUrl || 'https://api.openai.com/v1/responses';
    }

    async hasApiKey() {
      const apiKey = await this.getApiKey();
      return Boolean(apiKey);
    }

    async generateMinimalPing({ modelId, serviceTier, signal }) {
      const response = await this.generateMinimalPingRaw({ modelId, serviceTier, signal });
      return response.json;
    }

    async generateMinimalPingRaw({ modelId, serviceTier, signal }) {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        const error = new Error('Missing API key');
        error.code = 'NO_API_KEY';
        throw error;
      }

      const payload = {
        model: modelId,
        input: "Respond with a single '.'",
        max_output_tokens: 4,
        temperature: 0,
        store: false,
        background: false,
        service_tier: serviceTier || 'default'
      };

      return this.postResponseRaw({ apiKey, payload, signal });
    }

    async generateResponse({ modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal }) {
      const response = await this.generateResponseRaw({
        modelId,
        serviceTier,
        input,
        maxOutputTokens,
        temperature,
        store,
        background,
        signal
      });
      return response.json;
    }

    async generateResponseRaw({ modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal }) {
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        const error = new Error('Missing API key');
        error.code = 'NO_API_KEY';
        throw error;
      }

      const payload = {
        model: modelId,
        input: input || '',
        max_output_tokens: maxOutputTokens,
        temperature,
        store,
        background,
        service_tier: serviceTier || 'default'
      };

      return this.postResponseRaw({ apiKey, payload, signal });
    }

    async getApiKey() {
      const data = await this.storageGet({ apiKey: '' });
      return data.apiKey || '';
    }

    storageGet(defaults) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve(defaults || {});
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(defaults, (result) => resolve(result || defaults || {}));
      });
    }

    async postResponseRaw({ apiKey, payload, signal }) {
      const response = await this.fetchFn(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal
      });

      if (!response || !response.ok) {
        const error = new Error('Responses API request failed');
        error.code = 'RESPONSES_API_ERROR';
        error.status = response ? response.status : null;
        error.headers = response && response.headers ? response.headers : null;
        error.retryAfterMs = this.resolveRetryAfterMs(response && response.headers ? response.headers : null);
        throw error;
      }

      return {
        json: await response.json(),
        headers: response.headers,
        status: response.status
      };
    }

    resolveRetryAfterMs(headers) {
      if (!headers || typeof headers.get !== 'function') {
        return null;
      }

      const retryAfterMs = headers.get('retry-after-ms');
      if (retryAfterMs !== null && retryAfterMs !== undefined) {
        const parsedMs = Number(retryAfterMs);
        if (Number.isFinite(parsedMs)) {
          return Math.max(0, parsedMs);
        }
      }

      const retryAfter = headers.get('retry-after');
      if (retryAfter !== null && retryAfter !== undefined) {
        const parsedSeconds = Number(retryAfter);
        if (Number.isFinite(parsedSeconds)) {
          return Math.max(0, parsedSeconds * 1000);
        }
      }

      const resetRequests = this.parseDurationMs(headers.get('x-ratelimit-reset-requests'));
      const resetTokens = this.parseDurationMs(headers.get('x-ratelimit-reset-tokens'));
      const fallback = Math.max(resetRequests || 0, resetTokens || 0);
      return fallback > 0 ? fallback : null;
    }

    parseDurationMs(rawValue) {
      if (typeof rawValue !== 'string' || !rawValue.trim()) {
        return null;
      }

      const value = rawValue.trim();
      const pattern = /(\d+)(ms|s|m|h)/g;
      let consumed = '';
      let total = 0;
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
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.LlmClient = LlmClient;
})(globalThis);
