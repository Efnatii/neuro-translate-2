/**
 * Offscreen LLM host.
 *
 * Runs OpenAI fetch requests in offscreen context so request lifecycle is less
 * coupled to MV3 service-worker lifetime.
 */
(function initOffscreenLlmHost(global) {
  const NT = global.NT || (global.NT = {});

  const TYPES = Object.freeze({
    HELLO: 'OFFSCREEN_HELLO',
    HELLO_ACK: 'OFFSCREEN_HELLO_ACK',
    EXECUTE_REQUEST: 'OFFSCREEN_EXECUTE_REQUEST',
    CANCEL_REQUEST: 'OFFSCREEN_CANCEL_REQUEST',
    STREAM_EVENT: 'OFFSCREEN_STREAM_EVENT',
    STREAM_DONE: 'OFFSCREEN_STREAM_DONE',
    RESULT: 'OFFSCREEN_RESULT',
    ERROR: 'OFFSCREEN_ERROR',
    PING: 'OFFSCREEN_PING',
    PING_ACK: 'OFFSCREEN_PING_ACK',
    QUERY_STATUS: 'OFFSCREEN_QUERY_STATUS',
    QUERY_STATUS_ACK: 'OFFSCREEN_QUERY_STATUS_ACK',
    ATTACH: 'OFFSCREEN_ATTACH',

    // legacy compatibility
    EXECUTE_LEGACY: 'OFFSCREEN_EXECUTE',
    ABORT_LEGACY: 'OFFSCREEN_ABORT',
    GET_RESULT_LEGACY: 'OFFSCREEN_GET_RESULT',
    PURGE_LEGACY: 'OFFSCREEN_PURGE'
  });

  class OffscreenLlmHost {
    constructor() {
      this.inflight = new Map();
      this.ports = new Set();
      this.sessionConfig = {};
      this.offscreenInstanceId = `off-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      this.db = null;
      this.DB_NAME = 'nt_offscreen';
      this.DB_VERSION = 2;
      this.STORE = 'results';
      this.TTL_MS = 24 * 60 * 60 * 1000;
      this.CLEANUP_INTERVAL_MS = 20 * 60 * 1000;
      this.netProbe = NT.NetProbe ? new NT.NetProbe({ timeoutMs: 10000 }) : null;
    }

    async init() {
      try {
        this.db = await this._openDb();
      } catch (_) {
        this.db = null;
      }
      this._bindPort();
      this._bindRuntimeMessage();
      this._scheduleCleanup();
    }

    _bindPort() {
      if (!global.chrome || !global.chrome.runtime || !global.chrome.runtime.onConnect) {
        return;
      }
      global.chrome.runtime.onConnect.addListener((port) => {
        if (!port || (port.name && port.name !== 'nt-offscreen')) {
          return;
        }
        this.ports.add(port);
        try {
          port.onDisconnect.addListener(() => {
            this.ports.delete(port);
            this._detachPortFromInflight(port);
          });
        } catch (_) {
          // best-effort
        }
        try {
          port.onMessage.addListener((message) => {
            this._handleIncoming({ message, transport: 'port', port }).catch(() => {});
          });
        } catch (_) {
          // best-effort
        }
      });
    }

    _bindRuntimeMessage() {
      if (!global.chrome || !global.chrome.runtime || !global.chrome.runtime.onMessage) {
        return;
      }
      const respondOk = (sendResponse, out) => {
        try {
          sendResponse(out || { ok: true });
        } catch (_) {
          // best-effort
        }
      };
      const respondError = (sendResponse, error) => {
        try {
          sendResponse({
            ok: false,
            error: {
              code: 'OFFSCREEN_HOST_ERROR',
              message: error && error.message ? error.message : 'offscreen host failed'
            }
          });
        } catch (_) {
          // best-effort
        }
      };
      global.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        this._handleIncoming({ message, transport: 'runtime' })
          .then((out) => respondOk(sendResponse, out))
          .catch((error) => respondError(sendResponse, error));
        return true;
      });
    }

    _wrap(type, payload, meta) {
      const MessageEnvelope = NT.MessageEnvelope || null;
      const safePayload = payload && typeof payload === 'object' ? payload : {};
      const safeMeta = meta && typeof meta === 'object' ? meta : {};
      if (MessageEnvelope && typeof MessageEnvelope.wrap === 'function') {
        return MessageEnvelope.wrap(type, safePayload, safeMeta);
      }
      return { type, ...safePayload };
    }

    _unwrap(message) {
      const MessageEnvelope = NT.MessageEnvelope || null;
      if (MessageEnvelope && typeof MessageEnvelope.isEnvelope === 'function' && MessageEnvelope.isEnvelope(message)) {
        return {
          type: message.type || null,
          payload: message && message.payload && typeof message.payload === 'object' ? message.payload : {},
          meta: message && message.meta && typeof message.meta === 'object' ? message.meta : {},
          envelopeId: message && message.id ? message.id : null
        };
      }
      return {
        type: message && message.type ? message.type : null,
        payload: message && typeof message === 'object' ? message : {},
        meta: {},
        envelopeId: null
      };
    }

    _post(port, type, payload, meta) {
      if (!port || typeof port.postMessage !== 'function') {
        return;
      }
      try {
        port.postMessage(this._wrap(type, payload, meta));
      } catch (_) {
        // best-effort
      }
    }

    _detachPortFromInflight(port) {
      if (!port) {
        return;
      }
      this.inflight.forEach((entry) => {
        if (!entry || !entry.listeners || !(entry.listeners instanceof Set)) {
          return;
        }
        entry.listeners.delete(port);
      });
    }

    _attachPortToRequest(port, requestId) {
      if (!port || !requestId) {
        return false;
      }
      const entry = this.inflight.get(requestId);
      if (!entry) {
        return false;
      }
      if (!(entry.listeners instanceof Set)) {
        entry.listeners = new Set();
      }
      entry.listeners.add(port);
      entry.hasListener = entry.listeners.size > 0;
      return true;
    }

    _activeRequestsSnapshot() {
      const out = [];
      this.inflight.forEach((entry, requestId) => {
        if (!entry) {
          return;
        }
        out.push({
          requestId,
          startedTs: Number.isFinite(Number(entry.startedAt)) ? Number(entry.startedAt) : Date.now(),
          lastEventTs: Number.isFinite(Number(entry.lastEventTs))
            ? Number(entry.lastEventTs)
            : (Number.isFinite(Number(entry.startedAt)) ? Number(entry.startedAt) : Date.now()),
          mode: entry.mode === 'nonstream' ? 'nonstream' : 'stream'
        });
      });
      return out;
    }

    _emitStreamEvent(requestId, eventPayload) {
      if (!requestId) {
        return;
      }
      const entry = this.inflight.get(requestId);
      if (!entry) {
        return;
      }
      entry.lastEventTs = Date.now();
      if (eventPayload && eventPayload.delta && typeof eventPayload.delta === 'string') {
        entry.lastPartialText = String(eventPayload.delta).slice(-800);
      } else if (eventPayload && eventPayload.type === 'response.output_text.delta' && typeof eventPayload.delta === 'string') {
        entry.lastPartialText = String(eventPayload.delta).slice(-800);
      }
      const listeners = entry.listeners instanceof Set ? Array.from(entry.listeners.values()) : [];
      listeners.forEach((port) => {
        this._post(port, TYPES.STREAM_EVENT, {
          requestId,
          event: eventPayload && typeof eventPayload === 'object'
            ? eventPayload
            : null,
          ts: Date.now()
        }, {
          source: 'offscreen',
          stage: TYPES.STREAM_EVENT,
          requestId: null
        });
      });
    }

    async _handleIncoming({ message, transport, port } = {}) {
      const parsed = this._unwrap(message);
      const type = parsed && typeof parsed.type === 'string' ? parsed.type : null;
      const payload = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      const meta = parsed && parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      if (!type) {
        return { ok: false, error: { code: 'INVALID_TYPE', message: 'message type is required' } };
      }

      if (type === TYPES.HELLO) {
        this.sessionConfig = this._sanitizeSessionConfig(payload);
        const offscreenCaps = this._buildOffscreenCaps();
        const activeRequests = this._activeRequestsSnapshot();
        if (transport === 'port') {
          this._post(port, TYPES.HELLO_ACK, {
            ok: true,
            ts: Date.now(),
            offscreenCaps,
            offscreenInstanceId: this.offscreenInstanceId,
            activeRequests
          }, {
            source: 'offscreen',
            stage: TYPES.HELLO_ACK,
            requestId: meta.requestId || null
          });
          return { ok: true, accepted: true };
        }
        return {
          ok: true,
          ts: Date.now(),
          offscreenCaps,
          offscreenInstanceId: this.offscreenInstanceId,
          activeRequests
        };
      }

      if (type === TYPES.PING) {
        if (transport === 'port') {
          this._post(port, TYPES.PING_ACK, { ok: true, ts: Date.now() }, {
            source: 'offscreen',
            stage: TYPES.PING_ACK,
            requestId: meta.requestId || null
          });
          return { ok: true, accepted: true };
        }
        return { ok: true, ts: Date.now() };
      }

      if (type === TYPES.QUERY_STATUS) {
        const out = await this._queryStatus(Array.isArray(payload.requestIds) ? payload.requestIds : []);
        if (transport === 'port') {
          this._post(port, TYPES.QUERY_STATUS_ACK, { ok: true, statuses: out, ts: Date.now() }, {
            source: 'offscreen',
            stage: TYPES.QUERY_STATUS_ACK,
            requestId: meta.requestId || null
          });
          return { ok: true, accepted: true };
        }
        return { ok: true, statuses: out, ts: Date.now() };
      }

      if (type === TYPES.ATTACH) {
        const requestId = payload.requestId || null;
        const attached = this._attachPortToRequest(port, requestId);
        if (!attached && requestId) {
          const cached = await this._getCached(requestId).catch(() => null);
          if (cached && cached.result && transport === 'port') {
            this._post(port, TYPES.RESULT, cached.result, {
              source: 'offscreen',
              stage: TYPES.RESULT,
              requestId: null
            });
          }
        }
        if (transport === 'port') {
          return {
            ok: true,
            accepted: true,
            requestId,
            attached,
            pending: this.inflight.has(requestId)
          };
        }
        return {
          ok: true,
          requestId,
          attached,
          pending: this.inflight.has(requestId)
        };
      }

      if (type === TYPES.GET_RESULT_LEGACY) {
        const cached = await this._getCached(payload.requestId);
        return { ok: true, result: cached ? cached.result : null };
      }

      if (type === TYPES.PURGE_LEGACY) {
        await this._purgeExpired();
        return { ok: true };
      }

      if (type === TYPES.CANCEL_REQUEST || type === TYPES.ABORT_LEGACY) {
        const requestId = payload.requestId || null;
        const aborted = this._cancelInflight(requestId, payload.reason || 'ABORTED');
        if (transport === 'port') {
          this._post(port, TYPES.RESULT, {
            requestId,
            requestKey: null,
            ok: false,
            error: {
              code: aborted ? 'ABORTED' : 'NOT_FOUND',
              message: aborted ? 'request aborted' : 'request not found'
            },
            ts: Date.now()
          }, {
            source: 'offscreen',
            stage: TYPES.RESULT,
            requestId: meta.requestId || null
          });
          return { ok: true, accepted: true, aborted };
        }
        return { ok: true, aborted };
      }

      if (type === TYPES.EXECUTE_REQUEST || type === TYPES.EXECUTE_LEGACY) {
        const normalized = this._normalizeExecutePayload(payload);
        if (!normalized.requestId) {
          const out = { ok: false, error: { code: 'BAD_REQUEST_ID', message: 'requestId is required' } };
          if (transport === 'port') {
            this._post(port, TYPES.ERROR, {
              requestId: null,
              requestKey: normalized.requestKey || null,
              ok: false,
              error: out.error,
              ts: Date.now()
            }, {
              source: 'offscreen',
              stage: TYPES.ERROR,
              requestId: meta.requestId || null
            });
            return { ok: true, accepted: true };
          }
          return out;
        }

        if (transport === 'port') {
          this._execute(normalized, {
            listenerPort: port
          })
            .then((result) => {
              const isStream = Boolean(
                normalized
                && normalized.body
                && typeof normalized.body === 'object'
                && normalized.body.stream === true
              );
              const outType = result && result.ok === false
                ? TYPES.ERROR
                : (isStream ? TYPES.STREAM_DONE : TYPES.RESULT);
              this._post(port, outType, result, {
                source: 'offscreen',
                stage: outType,
                requestId: meta.requestId || null
              });
            })
            .catch((error) => {
              this._post(port, TYPES.ERROR, {
                requestId: normalized.requestId,
                requestKey: normalized.requestKey || null,
                ok: false,
                error: {
                  code: 'OFFSCREEN_EXECUTE_FAILED',
                  message: error && error.message ? error.message : 'offscreen execute failed'
                },
                ts: Date.now()
              }, {
                source: 'offscreen',
                stage: TYPES.ERROR,
                requestId: meta.requestId || null
              });
            });
          return { ok: true, accepted: true };
        }

        return this._execute(normalized);
      }

      return {
        ok: false,
        error: {
          code: 'UNKNOWN_TYPE',
          message: `unknown type: ${type}`
        }
      };
    }

    _sanitizeSessionConfig(payload) {
      const source = payload && typeof payload === 'object' ? payload : {};
      return {
        clientVersion: typeof source.clientVersion === 'string' ? source.clientVersion : null,
        instanceId: typeof source.instanceId === 'string' ? source.instanceId : null,
        wantActiveRequests: source.wantActiveRequests !== false,
        headersPreset: source.headersPreset && typeof source.headersPreset === 'object'
          ? { ...source.headersPreset }
          : {}
      };
    }

    _buildOffscreenCaps() {
      return {
        supportsStream: true,
        supportsAbort: true,
        sseParserVersion: 'v1',
        maxConcurrentFetch: 6
      };
    }

    _normalizeExecutePayload(payload) {
      const source = payload && typeof payload === 'object' ? payload : {};
      const requestId = source.requestId || null;
      const requestKey = source.requestKey || null;
      const timeoutMsRaw = Number(source.timeoutMs);
      const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(3000, Math.min(timeoutMsRaw, 180000)) : 120000;

      if (source.openai && typeof source.openai === 'object') {
        const openai = source.openai;
        return {
          requestId,
          requestKey,
          taskType: source.taskType || 'unknown',
          attempt: Number.isFinite(Number(source.attempt)) ? Number(source.attempt) : 1,
          meta: source.meta && typeof source.meta === 'object' ? source.meta : {},
          timeoutMs,
          endpoint: openai.endpoint || null,
          headers: openai.headers && typeof openai.headers === 'object' ? openai.headers : {},
          body: openai.body && typeof openai.body === 'object' ? openai.body : null
        };
      }

      // legacy payload from old executor
      let bodyObj = null;
      if (typeof source.body === 'string' && source.body) {
        try {
          bodyObj = JSON.parse(source.body);
        } catch (_) {
          bodyObj = null;
        }
      } else if (source.body && typeof source.body === 'object') {
        bodyObj = source.body;
      }
      return {
        requestId,
        requestKey,
        taskType: source.taskType || 'unknown',
        attempt: Number.isFinite(Number(source.attempt)) ? Number(source.attempt) : 1,
        meta: source.meta && typeof source.meta === 'object' ? source.meta : {},
        timeoutMs,
        endpoint: source.url || source.endpoint || null,
        headers: source.headers && typeof source.headers === 'object' ? source.headers : {},
        body: bodyObj
      };
    }

    _extractResponseHeaders(response) {
      if (!response || !response.headers || typeof response.headers.get !== 'function') {
        return {};
      }
      const out = {};
      [
        'x-request-id',
        'x-ratelimit-limit-requests',
        'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-remaining-tokens',
        'x-ratelimit-reset-requests',
        'x-ratelimit-reset-tokens',
        'retry-after',
        'retry-after-ms'
      ].forEach((key) => {
        const value = response.headers.get(key);
        if (value !== null && value !== undefined) {
          out[key] = value;
        }
      });
      return out;
    }

    async _execute(request, { listenerPort = null } = {}) {
      const requestId = request && request.requestId ? request.requestId : null;
      if (!requestId) {
        return {
          requestId: null,
          requestKey: request && request.requestKey ? request.requestKey : null,
          ok: false,
          error: { code: 'BAD_REQUEST_ID', message: 'requestId is required' },
          ts: Date.now()
        };
      }

      const cached = await this._getCached(requestId);
      if (cached && cached.result) {
        return cached.result;
      }

      if (this.inflight.has(requestId)) {
        const current = this.inflight.get(requestId);
        if (listenerPort) {
          this._attachPortToRequest(listenerPort, requestId);
        }
        return current && current.promise ? current.promise : null;
      }

      const controller = new AbortController();
      const promise = this._performFetch(request, controller)
        .finally(() => {
          this.inflight.delete(requestId);
        });

      const listeners = new Set();
      if (listenerPort) {
        listeners.add(listenerPort);
      }
      this.inflight.set(requestId, {
        controller,
        startedAt: Date.now(),
        lastEventTs: Date.now(),
        requestKey: request.requestKey || null,
        mode: request && request.body && request.body.stream === true ? 'stream' : 'nonstream',
        listeners,
        hasListener: listeners.size > 0,
        lastPartialText: null,
        meta: request.meta && typeof request.meta === 'object' ? request.meta : {},
        promise
      });
      return promise;
    }

    async _performFetch(request, controller) {
      const startedAt = Date.now();
      let transportTried = ['fetch'];
      const timeoutId = global.setTimeout(() => {
        try {
          controller.abort('timeout');
        } catch (_) {
          // best-effort
        }
      }, request.timeoutMs || 120000);

      try {
        let responsePayload = null;
        let networkError = null;
        transportTried = ['fetch'];
        try {
          responsePayload = await this._executeViaFetch(request, controller);
        } catch (error) {
          networkError = error;
        }

        const abortedNow = Boolean(controller && controller.signal && controller.signal.aborted);
        if (!responsePayload && !abortedNow && this._isFetchTransportFailure(networkError)) {
          transportTried.push('xhr');
          try {
            responsePayload = await this._executeViaXhr(request, controller);
            networkError = null;
          } catch (xhrError) {
            networkError = xhrError || networkError;
          }
        }

        if (responsePayload) {
          const result = {
            requestId: request.requestId,
            requestKey: request.requestKey || null,
            ok: Boolean(responsePayload.ok),
            json: responsePayload.json,
            text: responsePayload.json ? null : responsePayload.text,
            headers: responsePayload.headers && typeof responsePayload.headers === 'object' ? responsePayload.headers : {},
            status: Number.isFinite(Number(responsePayload.status)) ? Number(responsePayload.status) : 0,
            http: { status: Number.isFinite(Number(responsePayload.status)) ? Number(responsePayload.status) : 0 },
            ts: Date.now(),
            meta: {
              startedAt,
              elapsedMs: Date.now() - startedAt,
              taskType: request.taskType || 'unknown',
              attempt: Number.isFinite(Number(request.attempt)) ? Number(request.attempt) : 1,
              jobId: request.meta && request.meta.jobId ? request.meta.jobId : null,
              blockId: request.meta && request.meta.blockId ? request.meta.blockId : null,
              transport: responsePayload.transport === 'xhr' ? 'xhr' : 'fetch'
            }
          };
          await this._putCached(request.requestId, result);
          return result;
        }

        throw networkError || new Error('Failed to fetch');
      } catch (error) {
        const aborted = Boolean(controller && controller.signal && controller.signal.aborted);
        const reason = aborted ? controller.signal.reason : null;
        const code = aborted
          ? (reason === 'timeout' ? 'TIMEOUT' : 'ABORTED')
          : 'FETCH_FAILED';
        const baseUrl = this._resolveBaseUrlFromEndpoint(request && request.endpoint ? request.endpoint : null);
        const result = {
          requestId: request.requestId,
          requestKey: request.requestKey || null,
          ok: false,
          error: {
            code,
            message: error && error.message ? error.message : (code === 'TIMEOUT' ? 'request timeout' : (code === 'ABORTED' ? 'request aborted' : 'fetch failed'))
          },
          status: 0,
          http: { status: 0 },
          headers: {},
          json: null,
          text: null,
          ts: Date.now(),
          meta: {
            startedAt,
            elapsedMs: Date.now() - startedAt,
            taskType: request.taskType || 'unknown',
            attempt: Number.isFinite(Number(request.attempt)) ? Number(request.attempt) : 1,
            jobId: request.meta && request.meta.jobId ? request.meta.jobId : null,
            blockId: request.meta && request.meta.blockId ? request.meta.blockId : null,
            transport: transportTried[transportTried.length - 1] || 'fetch'
          }
        };
        if (code === 'FETCH_FAILED') {
          let endpointHost = null;
          try {
            endpointHost = baseUrl ? (new URL(baseUrl)).host : null;
          } catch (_) {
            endpointHost = null;
          }
          let probe = null;
          try {
            probe = await this._runOpenAiProbe({
              authHeader: request
                && request.headers
                && typeof request.headers === 'object'
                && typeof request.headers.Authorization === 'string'
                ? request.headers.Authorization
                : '',
              baseUrl
            });
          } catch (probeError) {
            probe = {
              ok: false,
              steps: [],
              online: global.navigator && typeof global.navigator.onLine === 'boolean'
                ? global.navigator.onLine
                : null,
              ua: global.navigator && typeof global.navigator.userAgent === 'string'
                ? global.navigator.userAgent
                : null,
              errorMessage: probeError && probeError.message ? String(probeError.message).slice(0, 220) : 'probe failed',
              name: probeError && probeError.name ? String(probeError.name).slice(0, 80) : 'ProbeError'
            };
          }
          result.error.debug = {
            transportTried,
            probe,
            baseUrl,
            endpointHost,
            online: global.navigator && typeof global.navigator.onLine === 'boolean'
              ? global.navigator.onLine
              : null
          };
        }
        await this._putCached(request.requestId, result);
        return result;
      } finally {
        global.clearTimeout(timeoutId);
      }
    }

    async _executeViaFetch(request, controller) {
      const response = await global.fetch(request.endpoint, {
        method: 'POST',
        headers: request.headers || {},
        body: JSON.stringify(request.body || {}),
        signal: controller && controller.signal ? controller.signal : undefined
      });
      const isStream = Boolean(
        request
        && request.body
        && typeof request.body === 'object'
        && request.body.stream === true
      );
      let json = null;
      let text = null;
      if (isStream) {
        const streamed = await this._readSseResponse(response, { requestId: request.requestId });
        json = streamed && streamed.finalResponse
          ? streamed.finalResponse
          : null;
      } else {
        text = await response.text();
        json = this._parseJsonSafe(text);
      }
      return {
        ok: response.ok,
        status: Number.isFinite(Number(response.status)) ? Number(response.status) : 0,
        headers: this._extractResponseHeaders(response),
        json,
        text: json ? null : (text || null),
        transport: 'fetch'
      };
    }

    _executeViaXhr(request, controller) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const bodyText = JSON.stringify(request.body || {});
        const timeoutMs = Number.isFinite(Number(request.timeoutMs))
          ? Math.max(1000, Math.min(Math.round(Number(request.timeoutMs)), 15000))
          : 15000;
        let settled = false;
        let abortListener = null;

        const cleanup = () => {
          if (controller && controller.signal && abortListener) {
            try {
              controller.signal.removeEventListener('abort', abortListener);
            } catch (_) {
              // no-op
            }
          }
        };
        const settleResolve = (value) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve(value);
        };
        const settleReject = (error) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(error);
        };

        try {
          xhr.open('POST', request.endpoint, true);
          xhr.timeout = timeoutMs;
          const headers = request.headers && typeof request.headers === 'object' ? request.headers : {};
          Object.keys(headers).forEach((key) => {
            const value = headers[key];
            if (typeof value === 'string') {
              try {
                xhr.setRequestHeader(key, value);
              } catch (_) {
                // best-effort
              }
            }
          });
        } catch (error) {
          settleReject(error);
          return;
        }

        const createNetworkError = (name, message) => {
          const err = new Error(message || 'Failed to fetch');
          err.name = name || 'NetworkError';
          return err;
        };

        xhr.onload = () => {
          const isStream = Boolean(
            request
            && request.body
            && typeof request.body === 'object'
            && request.body.stream === true
          );
          const responseText = typeof xhr.responseText === 'string' ? xhr.responseText : '';
          const headers = this._extractResponseHeadersFromXhr(xhr);
          let json = null;
          let text = null;
          if (isStream) {
            json = this._extractFinalResponseFromSseText(responseText);
          } else {
            json = this._parseJsonSafe(responseText);
          }
          if (!json && responseText) {
            text = responseText;
          }
          settleResolve({
            ok: xhr.status >= 200 && xhr.status < 300,
            status: Number.isFinite(Number(xhr.status)) ? Number(xhr.status) : 0,
            headers,
            json,
            text,
            transport: 'xhr'
          });
        };
        xhr.onerror = () => settleReject(createNetworkError('NetworkError', 'Failed to fetch'));
        xhr.ontimeout = () => settleReject(createNetworkError('TimeoutError', 'request timeout'));
        xhr.onabort = () => settleReject(createNetworkError('AbortError', 'request aborted'));

        if (controller && controller.signal) {
          if (controller.signal.aborted) {
            settleReject(createNetworkError('AbortError', 'request aborted'));
            return;
          }
          abortListener = () => {
            try {
              xhr.abort();
            } catch (_) {
              // best-effort
            }
          };
          controller.signal.addEventListener('abort', abortListener, { once: true });
        }

        try {
          xhr.send(bodyText);
        } catch (error) {
          settleReject(error);
        }
      });
    }

    _extractResponseHeadersFromXhr(xhr) {
      if (!xhr || typeof xhr.getAllResponseHeaders !== 'function') {
        return {};
      }
      const raw = xhr.getAllResponseHeaders();
      const map = {};
      String(raw || '')
        .split(/\r?\n/)
        .forEach((line) => {
          const idx = line.indexOf(':');
          if (idx <= 0) {
            return;
          }
          const key = line.slice(0, idx).trim().toLowerCase();
          const value = line.slice(idx + 1).trim();
          if (key && value) {
            map[key] = value;
          }
        });
      const out = {};
      [
        'x-request-id',
        'x-ratelimit-limit-requests',
        'x-ratelimit-limit-tokens',
        'x-ratelimit-remaining-requests',
        'x-ratelimit-remaining-tokens',
        'x-ratelimit-reset-requests',
        'x-ratelimit-reset-tokens',
        'retry-after',
        'retry-after-ms'
      ].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(map, key)) {
          out[key] = map[key];
        }
      });
      return out;
    }

    _parseJsonSafe(text) {
      if (typeof text !== 'string' || !text.trim()) {
        return null;
      }
      try {
        return JSON.parse(text);
      } catch (_) {
        return null;
      }
    }

    _extractFinalResponseFromSseText(sseText) {
      const source = String(sseText || '').replace(/\r\n/g, '\n');
      if (!source) {
        return null;
      }
      let finalResponse = null;
      source.split('\n\n').forEach((chunk) => {
        const lines = String(chunk || '').split('\n');
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
        const payload = dataLines.join('\n');
        if (!payload || payload === '[DONE]') {
          return;
        }
        let eventPayload = null;
        try {
          eventPayload = JSON.parse(payload);
        } catch (_) {
          eventPayload = null;
        }
        if (!eventPayload) {
          return;
        }
        const maybeFinal = this._extractFinalResponseFromEvent(eventPayload);
        if (maybeFinal) {
          finalResponse = maybeFinal;
        }
      });
      return finalResponse;
    }

    _isFetchTransportFailure(error) {
      if (!error) {
        return false;
      }
      const name = error && error.name ? String(error.name).toLowerCase() : '';
      const message = error && error.message ? String(error.message).toLowerCase() : '';
      if (name === 'typeerror') {
        return true;
      }
      if (message.indexOf('failed to fetch') >= 0) {
        return true;
      }
      if (message.indexOf('networkerror') >= 0) {
        return true;
      }
      return false;
    }

    _resolveBaseUrlFromEndpoint(endpoint) {
      const raw = typeof endpoint === 'string' ? endpoint.trim() : '';
      if (!raw) {
        return 'https://api.openai.com';
      }
      try {
        const parsed = new URL(raw);
        return parsed.origin || 'https://api.openai.com';
      } catch (_) {
        return 'https://api.openai.com';
      }
    }

    async _runOpenAiProbe({ authHeader, baseUrl } = {}) {
      if (!this.netProbe || typeof this.netProbe.runOpenAi !== 'function') {
        return {
          ok: false,
          steps: [],
          online: global.navigator && typeof global.navigator.onLine === 'boolean'
            ? global.navigator.onLine
            : null,
          ua: global.navigator && typeof global.navigator.userAgent === 'string'
            ? global.navigator.userAgent
            : null
        };
      }
      return this.netProbe.runOpenAi({
        authHeader: typeof authHeader === 'string' ? authHeader : '',
        baseUrl
      });
    }

    async _readSseResponse(response, { requestId = null } = {}) {
      if (!response || !response.body || typeof response.body.getReader !== 'function') {
        return { finalResponse: null };
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let finalResponse = null;

      const emit = (eventPayload) => {
        if (!requestId) {
          return;
        }
        this._emitStreamEvent(requestId, eventPayload);
      };

      const processChunk = (chunkText) => {
        const source = typeof chunkText === 'string' ? chunkText : '';
        if (!source) {
          return;
        }
        const lines = source.split('\n');
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
        const payload = dataLines.join('\n');
        if (!payload || payload === '[DONE]') {
          return;
        }
        let eventPayload = null;
        try {
          eventPayload = JSON.parse(payload);
        } catch (_) {
          return;
        }
        emit(eventPayload);
        const finalFromEvent = this._extractFinalResponseFromEvent(eventPayload);
        if (finalFromEvent) {
          finalResponse = finalFromEvent;
        }
      };

      while (true) {
        const read = await reader.read();
        if (!read || read.done) {
          break;
        }
        buffer += decoder.decode(read.value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        while (buffer.indexOf('\n\n') >= 0) {
          const idx = buffer.indexOf('\n\n');
          const chunkText = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          processChunk(chunkText);
        }
      }
      buffer += decoder.decode();
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.trim()) {
        processChunk(buffer);
      }
      return { finalResponse };
    }

    _extractFinalResponseFromEvent(eventPayload) {
      if (!eventPayload || typeof eventPayload !== 'object') {
        return null;
      }
      if (eventPayload.type !== 'response.completed') {
        return null;
      }
      if (eventPayload.response && typeof eventPayload.response === 'object') {
        return eventPayload.response;
      }
      return eventPayload;
    }

    _cancelInflight(requestId, reason) {
      if (!requestId) {
        return false;
      }
      const current = this.inflight.get(requestId);
      if (!current || !current.controller || !current.controller.signal || current.controller.signal.aborted) {
        return false;
      }
      try {
        current.controller.abort(reason || 'ABORTED');
        return true;
      } catch (_) {
        return false;
      }
    }

    async _queryStatus(requestIds) {
      const ids = Array.isArray(requestIds) ? requestIds.filter(Boolean).slice(0, 500) : [];
      const statuses = {};
      for (let i = 0; i < ids.length; i += 1) {
        const requestId = ids[i];
        if (this.inflight.has(requestId)) {
          const row = this.inflight.get(requestId);
          statuses[requestId] = {
            status: 'pending',
            result: null,
            startedTs: row && Number.isFinite(Number(row.startedAt)) ? Number(row.startedAt) : null,
            lastEventTs: row && Number.isFinite(Number(row.lastEventTs)) ? Number(row.lastEventTs) : null,
            mode: row && row.mode === 'nonstream' ? 'nonstream' : 'stream'
          };
          continue;
        }
        const cached = await this._getCached(requestId);
        if (cached && cached.result) {
          const result = cached.result;
          statuses[requestId] = {
            status: result.ok === false ? (result.error && result.error.code === 'ABORTED' ? 'cancelled' : 'failed') : 'done',
            result
          };
        } else {
          statuses[requestId] = { status: 'missing', result: null };
        }
      }
      return statuses;
    }

    _openDb() {
      return new Promise((resolve, reject) => {
        const request = global.indexedDB.open(this.DB_NAME, this.DB_VERSION);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(this.STORE)) {
            db.createObjectStore(this.STORE, { keyPath: 'requestId' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      });
    }

    async _getCached(requestId) {
      if (!requestId || !this.db) {
        return null;
      }
      try {
        const row = await new Promise((resolve, reject) => {
          const tx = this.db.transaction(this.STORE, 'readonly');
          const store = tx.objectStore(this.STORE);
          const req = store.get(requestId);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error || new Error('IndexedDB read failed'));
        });
        if (!row) {
          return null;
        }
        if ((Date.now() - Number(row.ts || 0)) > this.TTL_MS) {
          await this._deleteCached(requestId);
          return null;
        }
        return row;
      } catch (_) {
        return null;
      }
    }

    async _putCached(requestId, result) {
      if (!requestId || !this.db) {
        return;
      }
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction(this.STORE, 'readwrite');
          const store = tx.objectStore(this.STORE);
          const req = store.put({
            requestId,
            ts: Date.now(),
            status: result && result.ok === false
              ? ((result.error && result.error.code === 'ABORTED') ? 'cancelled' : 'failed')
              : 'done',
            result
          });
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error || new Error('IndexedDB write failed'));
        });
      } catch (_) {
        // best-effort
      }
    }

    async _deleteCached(requestId) {
      if (!requestId || !this.db) {
        return;
      }
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction(this.STORE, 'readwrite');
          const store = tx.objectStore(this.STORE);
          const req = store.delete(requestId);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error || new Error('IndexedDB delete failed'));
        });
      } catch (_) {
        // best-effort
      }
    }

    async _purgeExpired() {
      if (!this.db) {
        return;
      }
      const now = Date.now();
      try {
        await new Promise((resolve, reject) => {
          const tx = this.db.transaction(this.STORE, 'readwrite');
          const store = tx.objectStore(this.STORE);
          const req = store.openCursor();
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve();
              return;
            }
            const value = cursor.value;
            if (!value || !value.ts || (now - Number(value.ts)) > this.TTL_MS) {
              cursor.delete();
            }
            cursor.continue();
          };
          req.onerror = () => reject(req.error || new Error('IndexedDB purge failed'));
        });
      } catch (_) {
        // best-effort
      }
    }

    _scheduleCleanup() {
      global.setTimeout(async () => {
        try {
          await this._purgeExpired();
        } catch (_) {
          // best-effort
        }
        this._scheduleCleanup();
      }, this.CLEANUP_INTERVAL_MS);
    }
  }

  NT.OffscreenLlmHost = OffscreenLlmHost;
  new OffscreenLlmHost().init().catch(() => {});
})(globalThis);
