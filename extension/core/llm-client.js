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
      const apiKey = await this.getApiKey();
      if (!apiKey) {
        const error = new Error('Missing API key');
        error.code = 'NO_API_KEY';
        throw error;
      }

      const payload = {
        model: modelId,
        input: "Respond with a single '.' character.",
        max_output_tokens: 4,
        temperature: 0,
        store: false,
        background: false,
        service_tier: serviceTier || 'default'
      };

      return this.postResponse({ apiKey, payload, signal });
    }

    async generateResponse({ modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal }) {
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

      return this.postResponse({ apiKey, payload, signal });
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

    async postResponse({ apiKey, payload, signal }) {
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
        throw error;
      }

      return response.json();
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.LlmClient = LlmClient;
})(globalThis);
