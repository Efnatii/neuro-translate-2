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
    RESULT: 'OFFSCREEN_RESULT',
    ERROR: 'OFFSCREEN_ERROR',
    PING: 'OFFSCREEN_PING',
    PING_ACK: 'OFFSCREEN_PING_ACK',
    QUERY_STATUS: 'OFFSCREEN_QUERY_STATUS',
    QUERY_STATUS_ACK: 'OFFSCREEN_QUERY_STATUS_ACK',

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
      this.db = null;
      this.DB_NAME = 'nt_offscreen';
      this.DB_VERSION = 2;
      this.STORE = 'results';
      this.TTL_MS = 24 * 60 * 60 * 1000;
      this.CLEANUP_INTERVAL_MS = 20 * 60 * 1000;
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
      global.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        this._handleIncoming({ message, transport: 'runtime' })
          .then((out) => {
            try {
              sendResponse(out || { ok: true });
            } catch (_) {
              // best-effort
            }
          })
          .catch((error) => {
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
          });
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
        if (transport === 'port') {
          this._post(port, TYPES.HELLO_ACK, { ok: true, ts: Date.now() }, {
            source: 'offscreen',
            stage: TYPES.HELLO_ACK,
            requestId: meta.requestId || null
          });
          return { ok: true, accepted: true };
        }
        return { ok: true, ts: Date.now() };
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
          this._execute(normalized)
            .then((result) => {
              const outType = result && result.ok === false ? TYPES.ERROR : TYPES.RESULT;
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
        headersPreset: source.headersPreset && typeof source.headersPreset === 'object'
          ? { ...source.headersPreset }
          : {}
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

    async _execute(request) {
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
        return current && current.promise ? current.promise : null;
      }

      const controller = new AbortController();
      const promise = this._performFetch(request, controller)
        .finally(() => {
          this.inflight.delete(requestId);
        });

      this.inflight.set(requestId, {
        controller,
        startedAt: Date.now(),
        requestKey: request.requestKey || null,
        meta: request.meta && typeof request.meta === 'object' ? request.meta : {},
        promise
      });
      return promise;
    }

    async _performFetch(request, controller) {
      const startedAt = Date.now();
      const timeoutId = global.setTimeout(() => {
        try {
          controller.abort('timeout');
        } catch (_) {
          // best-effort
        }
      }, request.timeoutMs || 120000);

      try {
        const response = await global.fetch(request.endpoint, {
          method: 'POST',
          headers: request.headers || {},
          body: JSON.stringify(request.body || {}),
          signal: controller.signal
        });
        const text = await response.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (_) {
          json = null;
        }
        const result = {
          requestId: request.requestId,
          requestKey: request.requestKey || null,
          ok: response.ok,
          json,
          text: json ? null : text,
          headers: this._extractResponseHeaders(response),
          status: response.status,
          http: { status: response.status },
          ts: Date.now(),
          meta: {
            startedAt,
            elapsedMs: Date.now() - startedAt,
            taskType: request.taskType || 'unknown',
            attempt: Number.isFinite(Number(request.attempt)) ? Number(request.attempt) : 1,
            jobId: request.meta && request.meta.jobId ? request.meta.jobId : null,
            blockId: request.meta && request.meta.blockId ? request.meta.blockId : null
          }
        };
        await this._putCached(request.requestId, result);
        return result;
      } catch (error) {
        const aborted = Boolean(controller && controller.signal && controller.signal.aborted);
        const reason = aborted ? controller.signal.reason : null;
        const code = aborted
          ? (reason === 'timeout' ? 'TIMEOUT' : 'ABORTED')
          : 'FETCH_FAILED';
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
            blockId: request.meta && request.meta.blockId ? request.meta.blockId : null
          }
        };
        await this._putCached(request.requestId, result);
        return result;
      } finally {
        global.clearTimeout(timeoutId);
      }
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
          statuses[requestId] = { status: 'pending', result: null };
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
