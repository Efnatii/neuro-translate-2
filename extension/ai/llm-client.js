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
    constructor({ chromeApi, fetchFn, baseUrl, time, offscreenExecutor, credentialsProvider, safeLogger } = {}) {
      super({ chromeApi });
      this.fetchFn = fetchFn || global.fetch;
      this.baseUrl = baseUrl || 'https://api.openai.com/v1/responses';
      this.time = time || (global.NT && global.NT.Time ? global.NT.Time : null);
      this.offscreen = offscreenExecutor || null;
      this.credentialsProvider = credentialsProvider || null;
      this.safeLogger = safeLogger
        || (global.NT && global.NT.SafeLogger
          ? new global.NT.SafeLogger({ prefix: 'NT/LLM' })
          : null);
      this.lastConnectionInfo = {
        mode: 'BYOK',
        endpointHost: 'api.openai.com',
        hasAuth: false
      };
    }

    now() {
      return this.time && typeof this.time.now === 'function' ? this.time.now() : Date.now();
    }

    async hasApiKey() {
      try {
        await this._resolveConnectionContext({ stage: 'has_credentials' });
        return true;
      } catch (_) {
        return false;
      }
    }

    async generateMinimalPing({ modelId, serviceTier, signal, meta } = {}) {
      const response = await this.generateMinimalPingRaw({ modelId, serviceTier, signal, meta });
      return response.json;
    }

    async generateMinimalPingRaw({ modelId, serviceTier, signal, meta } = {}) {
      const connection = await this._resolveConnectionContext({ stage: 'minimal_ping' });

      const payload = {
        model: modelId,
        input: "Respond with a single '.'",
        max_output_tokens: 4,
        temperature: 0,
        store: false,
        background: false,
        service_tier: serviceTier || 'default'
      };

      return this.postResponseRaw({ connection, payload, signal, meta });
    }

    async generateResponse({ modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal, meta, responsesOptions } = {}) {
      const response = await this.generateResponseRaw({
        modelId,
        serviceTier,
        input,
        maxOutputTokens,
        temperature,
        store,
        background,
        signal,
        meta,
        responsesOptions
      });
      return response.json;
    }

    async generateResponseRaw({ modelId, serviceTier, input, maxOutputTokens, temperature, store, background, signal, meta, responsesOptions } = {}) {
      const connection = await this._resolveConnectionContext({ stage: 'response' });

      const payload = this._buildResponsePayload({
        modelId,
        serviceTier,
        input,
        maxOutputTokens,
        temperature,
        store,
        background,
        meta,
        responsesOptions
      });

      return this.postResponseRaw({ connection, payload, signal, meta });
    }

    async generateResponseStreamRaw({
      modelId,
      serviceTier,
      input,
      maxOutputTokens,
      temperature,
      store,
      background,
      signal,
      meta,
      responsesOptions,
      onEvent
    } = {}) {
      const connection = await this._resolveConnectionContext({ stage: 'response_stream' });
      const payload = this._buildResponsePayload({
        modelId,
        serviceTier,
        input,
        maxOutputTokens,
        temperature,
        store,
        background,
        meta,
        responsesOptions: {
          ...(responsesOptions && typeof responsesOptions === 'object' ? responsesOptions : {}),
          stream: true
        }
      });
      const streamHandler = typeof onEvent === 'function'
        ? onEvent
        : (meta && typeof meta.streamHandler === 'function' ? meta.streamHandler : null);
      return this.postResponseRaw({
        connection,
        payload,
        signal,
        meta,
        forceStream: true,
        onStreamEvent: streamHandler
      });
    }

    async getApiKey() {
      // legacy compatibility path if CredentialsProvider is not wired.
      const data = await this.storageGet({ apiKey: '' });
      return data.apiKey || '';
    }

    getLastConnectionInfo() {
      return {
        mode: this.lastConnectionInfo && this.lastConnectionInfo.mode ? this.lastConnectionInfo.mode : null,
        endpointHost: this.lastConnectionInfo && this.lastConnectionInfo.endpointHost ? this.lastConnectionInfo.endpointHost : null,
        hasAuth: this.lastConnectionInfo ? this.lastConnectionInfo.hasAuth === true : false
      };
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

    _hostFromUrl(url) {
      try {
        return new URL(String(url || '')).host;
      } catch (_) {
        return null;
      }
    }

    async _resolveConnectionContext({ stage = 'request' } = {}) {
      let mode = 'BYOK';
      let responsesUrl = this.baseUrl;
      let authHeaders = {};

      if (this.credentialsProvider && typeof this.credentialsProvider.buildConnectionContext === 'function') {
        const context = await this.credentialsProvider.buildConnectionContext({ stage });
        mode = context && context.mode ? context.mode : mode;
        responsesUrl = context && context.responsesUrl ? context.responsesUrl : responsesUrl;
        authHeaders = context && context.authHeaders && typeof context.authHeaders === 'object'
          ? context.authHeaders
          : {};
      } else {
        const apiKey = await this.getApiKey();
        if (!apiKey) {
          const error = new Error('Missing API key');
          error.code = 'NO_API_KEY';
          error.stage = stage;
          throw error;
        }
        authHeaders = {
          Authorization: `Bearer ${apiKey}`
        };
      }

      const endpointHost = this._hostFromUrl(responsesUrl);
      const hasAuth = Object.keys(authHeaders).length > 0;
      this.lastConnectionInfo = {
        mode,
        endpointHost: endpointHost || null,
        hasAuth
      };

      return {
        mode,
        responsesUrl,
        endpointHost: endpointHost || null,
        hasAuth,
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        }
      };
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

    async executeOffscreenStreamRequest({ requestId, payload, timeoutMs, signal, onEvent } = {}) {
      if (!this.offscreen || (typeof this.offscreen.executeStream !== 'function' && typeof this.offscreen.execute !== 'function')) {
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

      const runExecute = typeof this.offscreen.executeStream === 'function'
        ? this.offscreen.executeStream.bind(this.offscreen)
        : this.offscreen.execute.bind(this.offscreen);
      const executePromise = runExecute({
        requestId,
        payload,
        timeoutMs,
        onEvent
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

    async postResponseRaw({ connection, payload, signal, meta, forceStream = false, onStreamEvent = null } = {}) {
      const requestId = this.createRequestId(meta || {});
      const timeoutMs = meta && Number.isFinite(Number(meta.timeoutMs)) ? Number(meta.timeoutMs) : 90000;
      const resolvedConnection = connection && typeof connection === 'object'
        ? connection
        : await this._resolveConnectionContext({ stage: 'post_response' });
      const headers = resolvedConnection.headers && typeof resolvedConnection.headers === 'object'
        ? resolvedConnection.headers
        : { 'Content-Type': 'application/json' };
      const endpointUrl = resolvedConnection.responsesUrl || this.baseUrl;
      const connectionInfo = {
        mode: resolvedConnection.mode || null,
        endpointHost: resolvedConnection.endpointHost || this._hostFromUrl(endpointUrl),
        hasAuth: resolvedConnection.hasAuth === true
      };
      const body = JSON.stringify(payload || {});

      if (this.offscreen) {
        try {
          const offscreenResult = forceStream
            ? await this.executeOffscreenStreamRequest({
              requestId,
              payload: {
                url: endpointUrl,
                method: 'POST',
                headers,
                body,
                timeoutMs
              },
              timeoutMs,
              signal,
              onEvent: onStreamEvent
            })
            : await this.executeOffscreenRequest({
              requestId,
              payload: {
                url: endpointUrl,
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
            error.connection = connectionInfo;
            if (offscreenResult && offscreenResult.error && typeof offscreenResult.error === 'object') {
              if (offscreenResult.error.debug && typeof offscreenResult.error.debug === 'object') {
                error.debug = offscreenResult.error.debug;
              }
              if (offscreenResult.error.error && typeof offscreenResult.error.error === 'object') {
                error.error = offscreenResult.error.error;
              }
            }
            throw error;
          }

          return {
            json: offscreenResult.json,
            headers: normalizedHeaders,
            status: offscreenResult.status,
            connection: connectionInfo
          };
        } catch (error) {
          if (!this.isOffscreenUnavailable(error)) {
            throw error;
          }
          if (this.safeLogger && typeof this.safeLogger.warn === 'function') {
            this.safeLogger.warn('offscreen_unavailable_fallback_to_fetch', {
              code: error && error.code ? error.code : null,
              message: error && error.message ? error.message : null,
              connection: connectionInfo
            });
          }
        }
      }

      const response = await this.fetchFn(endpointUrl, {
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
        error.connection = connectionInfo;
        throw error;
      }

      if (forceStream) {
        const finalJson = await this._readResponseSse(response, { onEvent: onStreamEvent });
        return {
          json: finalJson,
          headers: response.headers,
          status: response.status,
          connection: connectionInfo
        };
      }

      return {
        json: await response.json(),
        headers: response.headers,
        status: response.status,
        connection: connectionInfo
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
      if (!normalized || normalized === 'disabled') {
        return null;
      }
      if (normalized === 'in_memory') {
        return 'in-memory';
      }
      if (normalized === 'extended') {
        return '24h';
      }
      if (normalized === 'auto') {
        return null;
      }
      if (normalized === 'in-memory' || normalized === '24h') {
        return normalized;
      }
      return null;
    }

    _normalizeResponsesOptions(input) {
      const src = input && typeof input === 'object' ? input : {};
      const out = {};

      if (Array.isArray(src.tools)) {
        out.tools = src.tools.slice(0, 64).map((item) => this._cloneJson(item)).filter(Boolean);
      }
      if (typeof src.tool_choice === 'string' && src.tool_choice.trim()) {
        out.tool_choice = src.tool_choice.trim();
      } else if (src.tool_choice && typeof src.tool_choice === 'object') {
        out.tool_choice = this._cloneJson(src.tool_choice);
      }
      if (typeof src.parallel_tool_calls === 'boolean') {
        out.parallel_tool_calls = src.parallel_tool_calls;
      }
      if (typeof src.previous_response_id === 'string' && src.previous_response_id.trim()) {
        out.previous_response_id = src.previous_response_id.trim();
      }
      if (src.reasoning && typeof src.reasoning === 'object') {
        out.reasoning = this._cloneJson(src.reasoning);
      }
      if (src.text && typeof src.text === 'object') {
        out.text = this._cloneJson(src.text);
      }
      if (typeof src.prompt_cache_key === 'string' && src.prompt_cache_key.trim()) {
        out.prompt_cache_key = src.prompt_cache_key.trim().slice(0, 128);
      }
      const promptCacheRetention = this._normalizePromptCacheRetention(src.prompt_cache_retention);
      if (promptCacheRetention) {
        out.prompt_cache_retention = promptCacheRetention;
      }
      if (typeof src.truncation === 'string' && src.truncation.trim()) {
        out.truncation = src.truncation.trim();
      } else if (src.truncation && typeof src.truncation === 'object') {
        out.truncation = this._cloneJson(src.truncation);
      }
      if (Number.isFinite(Number(src.max_tool_calls))) {
        out.max_tool_calls = Math.max(1, Math.round(Number(src.max_tool_calls)));
      }
      if (typeof src.stream === 'boolean') {
        out.stream = src.stream;
      }
      return out;
    }

    _buildResponsePayload({
      modelId,
      serviceTier,
      input,
      maxOutputTokens,
      temperature,
      store,
      background,
      meta,
      responsesOptions
    } = {}) {
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
      const extra = this._normalizeResponsesOptions(responsesOptions);
      Object.keys(extra).forEach((key) => {
        payload[key] = extra[key];
      });
      return payload;
    }

    async _readResponseSse(response, { onEvent = null } = {}) {
      if (!response || !response.body || typeof response.body.getReader !== 'function') {
        return null;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let finalResponse = null;
      const handleEvent = (eventPayload) => {
        if (!eventPayload || typeof eventPayload !== 'object') {
          return;
        }
        if (typeof onEvent === 'function') {
          try {
            onEvent(eventPayload);
          } catch (_) {
            // best-effort
          }
        }
        if (eventPayload.type === 'response.completed') {
          if (eventPayload.response && typeof eventPayload.response === 'object') {
            finalResponse = eventPayload.response;
          } else {
            finalResponse = eventPayload;
          }
        }
      };
      const processFrame = (frameText) => {
        const lines = String(frameText || '').split('\n');
        const dataLines = [];
        lines.forEach((line) => {
          const trimmed = String(line || '').trim();
          if (!trimmed || !trimmed.startsWith('data:')) {
            return;
          }
          dataLines.push(trimmed.slice(5).trim());
        });
        if (!dataLines.length) {
          return;
        }
        const data = dataLines.join('\n');
        if (!data || data === '[DONE]') {
          return;
        }
        try {
          handleEvent(JSON.parse(data));
        } catch (_) {
          // ignore malformed chunk
        }
      };
      while (true) {
        const chunk = await reader.read();
        if (!chunk || chunk.done) {
          break;
        }
        buffer += decoder.decode(chunk.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        while (buffer.indexOf('\n\n') >= 0) {
          const idx = buffer.indexOf('\n\n');
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          processFrame(frame);
        }
      }
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.trim()) {
        processFrame(buffer);
      }
      return finalResponse;
    }

    _cloneJson(value) {
      if (value === null || value === undefined) {
        return value;
      }
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
        return value;
      }
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return null;
      }
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.LlmClient = LlmClient;
})(globalThis);
