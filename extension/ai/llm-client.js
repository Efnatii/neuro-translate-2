/**
 * Single transport client for OpenAI `/v1/responses` requests.
 *
 * `LlmClient` remains the only AI transport module and supports two execution
 * modes: direct `fetch` fallback and MV3 offscreen delegation through
 * `OffscreenExecutor`. Offscreen mode is preferred for long-running calls so
 * request execution is less coupled to service-worker lifetime.
 *
 * Public methods return normalized raw envelopes (`json`, `headers`, `status`)
 * and throw structured errors with optional retry hints.
 *
 * Security note: authorization headers are created only for network transport
 * and are never emitted into event logs or error diagnostics.
 */
(function initLlmClient(global) {
  class LlmClient extends global.NT.ChromeLocalStoreBase {
    constructor({ chromeApi, fetchFn, baseUrl, time, offscreenExecutor } = {}) {
      super({ chromeApi });
      this.fetchFn = fetchFn || global.fetch;
      this.baseUrl = baseUrl || 'https://api.openai.com/v1/responses';
      this.time = time || (global.NT && global.NT.Time ? global.NT.Time : null);
      this.offscreen = offscreenExecutor || null;
    }

    now() {
      return this.time && typeof this.time.now === 'function' ? this.time.now() : Date.now();
    }

    async hasApiKey() {
      const apiKey = await this.getApiKey();
      return Boolean(apiKey);
    }

    async generateMinimalPing({ modelId, serviceTier, signal, meta } = {}) {
      const response = await this.generateMinimalPingRaw({ modelId, serviceTier, signal, meta });
      return response.json;
    }

    async generateMinimalPingRaw({ modelId, serviceTier, signal, meta } = {}) {
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

      return this.postResponseRaw({ apiKey, payload, signal, meta });
    }

    async generateResponse({ modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal, meta } = {}) {
      const response = await this.generateResponseRaw({
        modelId,
        serviceTier,
        input,
        maxOutputTokens,
        temperature,
        store,
        background,
        signal,
        meta
      });
      return response.json;
    }

    async generateResponseRaw({ modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal, meta } = {}) {
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
      const promptCacheKey = this._normalizePromptCacheKey(meta && meta.promptCacheKey);
      if (promptCacheKey) {
        payload.prompt_cache_key = promptCacheKey;
      }
      const promptCacheRetention = this._normalizePromptCacheRetention(meta && meta.promptCacheRetention);
      if (promptCacheKey && promptCacheRetention) {
        payload.prompt_cache_retention = promptCacheRetention;
      }

      return this.postResponseRaw({ apiKey, payload, signal, meta });
    }

    async getApiKey() {
      const data = await this.storageGet({ apiKey: '' });
      return data.apiKey || '';
    }

    normalizeHeaders(headersLike) {
      const map = headersLike && typeof headersLike === 'object' ? { ...headersLike } : {};
      return {
        get(name) {
          if (!name) {
            return null;
          }
          const direct = map[name];
          if (direct !== undefined) {
            return direct;
          }
          const lower = map[String(name).toLowerCase()];
          return lower !== undefined ? lower : null;
        }
      };
    }

    createRequestId(meta) {
      if (meta && typeof meta.requestId === 'string' && meta.requestId) {
        return meta.requestId;
      }
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (MessageEnvelope && typeof MessageEnvelope.newId === 'function') {
        return MessageEnvelope.newId();
      }
      return `llm-${this.now()}-${Math.random().toString(16).slice(2)}`;
    }

    createAbortError(reason) {
      const message = reason ? `Request aborted: ${String(reason)}` : 'Request aborted';
      const error = new Error(message);
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      error.status = null;
      error.retryAfterMs = null;
      return error;
    }

    isOffscreenUnavailable(error) {
      if (!error) {
        return false;
      }
      if (error.code === 'OFFSCREEN_UNAVAILABLE') {
        return true;
      }
      const message = typeof error.message === 'string' ? error.message : String(error);
      return message.includes('OFFSCREEN_UNAVAILABLE');
    }

    async executeOffscreenRequest({ requestId, payload, timeoutMs, signal } = {}) {
      if (!this.offscreen || typeof this.offscreen.execute !== 'function') {
        throw new Error('OFFSCREEN_UNAVAILABLE');
      }
      const resolveAbortReasonText = () => {
        const raw = signal && signal.reason !== undefined ? signal.reason : 'ABORTED_BY_SIGNAL';
        return typeof raw === 'string' && raw ? raw : 'ABORTED_BY_SIGNAL';
      };

      if (signal && signal.aborted) {
        const abortReasonText = resolveAbortReasonText();
        if (typeof this.offscreen.abort === 'function') {
          await this.offscreen.abort({ requestId, reason: abortReasonText }).catch(() => false);
        }
        throw this.createAbortError(abortReasonText);
      }

      const executePromise = this.offscreen.execute({
        requestId,
        payload,
        timeoutMs
      });
      let abortHandler = null;
      const abortPromise = signal
        ? new Promise((_, reject) => {
          abortHandler = () => {
            const abortReasonText = resolveAbortReasonText();
            if (typeof this.offscreen.abort === 'function') {
              this.offscreen.abort({ requestId, reason: abortReasonText }).catch(() => false);
            }
            reject(this.createAbortError(abortReasonText));
          };
          signal.addEventListener('abort', abortHandler, { once: true });
        })
        : null;

      try {
        return await (abortPromise ? Promise.race([executePromise, abortPromise]) : executePromise);
      } finally {
        if (signal && abortHandler) {
          try {
            signal.removeEventListener('abort', abortHandler);
          } catch (_) {
            // no-op
          }
        }
      }
    }

    async postResponseRaw({ apiKey, payload, signal, meta } = {}) {
      const requestId = this.createRequestId(meta || {});
      const timeoutMs = meta && Number.isFinite(Number(meta.timeoutMs)) ? Number(meta.timeoutMs) : 90000;
      const headers = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      };
      const body = JSON.stringify(payload || {});

      if (this.offscreen) {
        try {
          const offscreenResult = await this.executeOffscreenRequest({
            requestId,
            payload: {
              url: this.baseUrl,
              method: 'POST',
              headers,
              body,
              timeoutMs
            },
            timeoutMs,
            signal
          });

          const normalizedHeaders = this.normalizeHeaders(offscreenResult && offscreenResult.headers ? offscreenResult.headers : {});
          if (!offscreenResult || !offscreenResult.ok) {
            const errorCode = offscreenResult && offscreenResult.error && offscreenResult.error.code
              ? offscreenResult.error.code
              : 'RESPONSES_API_ERROR';
            if (errorCode === 'ABORTED' || errorCode === 'ABORT_ERR') {
              throw this.createAbortError(offscreenResult && offscreenResult.error ? offscreenResult.error.message : null);
            }
            const error = new Error(
              offscreenResult && offscreenResult.error && offscreenResult.error.message
                ? offscreenResult.error.message
                : 'Responses API request failed'
            );
            error.code = errorCode;
            error.status = offscreenResult && typeof offscreenResult.status === 'number' ? offscreenResult.status : null;
            error.headers = normalizedHeaders;
            error.retryAfterMs = this.resolveRetryAfterMs(normalizedHeaders);
            throw error;
          }

          return {
            json: offscreenResult.json,
            headers: normalizedHeaders,
            status: offscreenResult.status
          };
        } catch (error) {
          if (!this.isOffscreenUnavailable(error)) {
            throw error;
          }
        }
      }

      const response = await this.fetchFn(this.baseUrl, {
        method: 'POST',
        headers,
        body,
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

      const Duration = global.NT.Duration;
      const resetRequests = Duration.parseMs(headers.get('x-ratelimit-reset-requests'));
      const resetTokens = Duration.parseMs(headers.get('x-ratelimit-reset-tokens'));
      const fallback = Duration.maxDefined(resetRequests, resetTokens);
      return fallback && fallback > 0 ? fallback : null;
    }

    _normalizePromptCacheKey(value) {
      if (typeof value !== 'string') {
        return '';
      }
      const trimmed = value.trim();
      if (!trimmed) {
        return '';
      }
      return trimmed.slice(0, 128);
    }

    _normalizePromptCacheRetention(value) {
      if (typeof value !== 'string') {
        return null;
      }
      const normalized = value.trim().toLowerCase();
      if (normalized === 'in-memory' || normalized === '24h') {
        return normalized;
      }
      return null;
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.LlmClient = LlmClient;
})(globalThis);
