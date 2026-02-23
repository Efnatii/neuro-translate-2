/**
 * Offscreen LLM executor (background side).
 *
 * Uses offscreen document + runtime Port transport for resilient, long-running
 * LLM calls in MV3 and persists request state in storage via Inflight store.
 */
(function initOffscreenLlmExecutor(global) {
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
    QUERY_STATUS_ACK: 'OFFSCREEN_QUERY_STATUS_ACK'
  });

  function buildRequestId() {
    const MessageEnvelope = NT.MessageEnvelope || null;
    if (MessageEnvelope && typeof MessageEnvelope.newId === 'function') {
      return MessageEnvelope.newId();
    }
    return `off-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class OffscreenManager {
    constructor({ chromeApi, offscreenPath, eventFactory, eventLogFn } = {}) {
      this.chromeApi = chromeApi;
      this.offscreenPath = offscreenPath || 'offscreen/offscreen.html';
      this.eventFactory = eventFactory || null;
      this.log = typeof eventLogFn === 'function' ? eventLogFn : null;
      this._creating = null;
      this._connecting = null;
      this._port = null;
      this._helloDone = false;
      this._requestWaiters = new Map();
      this._listeners = new Set();
    }

    _emit(level, tag, message, meta) {
      if (!this.log) {
        return;
      }
      if (this.eventFactory) {
        const event = level === 'error'
          ? this.eventFactory.error(tag, message, meta)
          : level === 'warn'
            ? this.eventFactory.warn(tag, message, meta)
            : this.eventFactory.info(tag, message, meta);
        this.log(event);
        return;
      }
      this.log({ level, tag, message, meta });
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

    onMessage(handler) {
      if (typeof handler !== 'function') {
        return () => {};
      }
      this._listeners.add(handler);
      return () => this._listeners.delete(handler);
    }

    async _hasDocument(url) {
      try {
        if (this.chromeApi && this.chromeApi.runtime && typeof this.chromeApi.runtime.getContexts === 'function') {
          const contexts = await this.chromeApi.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [url]
          });
          return Array.isArray(contexts) && contexts.length > 0;
        }
      } catch (_) {
        // fallback below
      }
      try {
        const clientsList = await global.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        return clientsList.some((client) => client && typeof client.url === 'string' && client.url === url);
      } catch (_) {
        return false;
      }
    }

    async ensureOffscreen() {
      const chromeApi = this.chromeApi;
      if (!chromeApi || !chromeApi.runtime || !chromeApi.offscreen || typeof chromeApi.runtime.getURL !== 'function') {
        const error = new Error('OFFSCREEN_UNAVAILABLE');
        error.code = 'OFFSCREEN_UNAVAILABLE';
        throw error;
      }
      const url = chromeApi.runtime.getURL(this.offscreenPath);
      const exists = await this._hasDocument(url);
      if (exists) {
        return true;
      }
      if (this._creating) {
        await this._creating;
        return true;
      }
      this._creating = chromeApi.offscreen.createDocument({
        url: this.offscreenPath,
        reasons: ['LOCAL_STORAGE'],
        justification: 'LLM request executor'
      });
      try {
        await this._creating;
        return true;
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        if (message && message.toLowerCase().includes('already')) {
          return true;
        }
        throw error;
      } finally {
        this._creating = null;
      }
    }

    _handlePortDisconnect() {
      this._port = null;
      this._helloDone = false;
      this._connecting = null;
      const waiters = Array.from(this._requestWaiters.values());
      this._requestWaiters.clear();
      waiters.forEach((waiter) => {
        try {
          global.clearTimeout(waiter.timeoutId);
        } catch (_) {
          // best-effort
        }
        try {
          waiter.reject(new Error('OFFSCREEN_PORT_DISCONNECTED'));
        } catch (_) {
          // best-effort
        }
      });
    }

    _handlePortMessage(message) {
      const parsed = this._unwrap(message);
      const meta = parsed && parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      const reqId = meta && meta.requestId ? meta.requestId : null;
      if (reqId && this._requestWaiters.has(reqId)) {
        const waiter = this._requestWaiters.get(reqId);
        this._requestWaiters.delete(reqId);
        try {
          global.clearTimeout(waiter.timeoutId);
        } catch (_) {
          // best-effort
        }
        try {
          waiter.resolve(parsed);
        } catch (_) {
          // best-effort
        }
      }
      this._listeners.forEach((handler) => {
        try {
          handler(parsed);
        } catch (_) {
          // best-effort
        }
      });
    }

    async connect() {
      if (this._port) {
        return this._port;
      }
      if (this._connecting) {
        return this._connecting;
      }
      this._connecting = (async () => {
        await this.ensureOffscreen();
        const chromeApi = this.chromeApi;
        if (!chromeApi || !chromeApi.runtime || typeof chromeApi.runtime.connect !== 'function') {
          const error = new Error('OFFSCREEN_CONNECT_UNAVAILABLE');
          error.code = 'OFFSCREEN_CONNECT_UNAVAILABLE';
          throw error;
        }
        const port = chromeApi.runtime.connect({ name: 'nt-offscreen' });
        this._port = port;
        this._helloDone = false;
        try {
          port.onDisconnect.addListener(() => this._handlePortDisconnect());
          port.onMessage.addListener((msg) => this._handlePortMessage(msg));
        } catch (_) {
          // best-effort
        }
        return port;
      })();
      try {
        return await this._connecting;
      } finally {
        this._connecting = null;
      }
    }

    async request(type, payload, { timeoutMs = 6000, meta = null } = {}) {
      const port = await this.connect();
      if (!port || typeof port.postMessage !== 'function') {
        const error = new Error('OFFSCREEN_PORT_UNAVAILABLE');
        error.code = 'OFFSCREEN_PORT_UNAVAILABLE';
        throw error;
      }
      const requestId = buildRequestId();
      const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 6000, 180000));
      const parsed = await new Promise((resolve, reject) => {
        const timeoutId = global.setTimeout(() => {
          this._requestWaiters.delete(requestId);
          const err = new Error('OFFSCREEN_REQUEST_TIMEOUT');
          err.code = 'OFFSCREEN_REQUEST_TIMEOUT';
          reject(err);
        }, timeout);
        this._requestWaiters.set(requestId, { resolve, reject, timeoutId });
        try {
          port.postMessage(this._wrap(type, payload, {
            source: 'background',
            stage: type,
            requestId,
            ...(meta && typeof meta === 'object' ? meta : {})
          }));
        } catch (error) {
          this._requestWaiters.delete(requestId);
          global.clearTimeout(timeoutId);
          reject(error);
        }
      });
      return parsed;
    }

    async send(type, payload, { meta = null } = {}) {
      const port = await this.connect();
      if (!port || typeof port.postMessage !== 'function') {
        return false;
      }
      try {
        port.postMessage(this._wrap(type, payload, {
          source: 'background',
          stage: type,
          requestId: meta && meta.requestId ? meta.requestId : null,
          ...(meta && typeof meta === 'object' ? meta : {})
        }));
        return true;
      } catch (_) {
        return false;
      }
    }

    async ensureReady({ helloPayload = null } = {}) {
      let attempts = 0;
      while (attempts < 2) {
        attempts += 1;
        try {
          await this.connect();
          if (this._helloDone) {
            return true;
          }
          const ack = await this.request(TYPES.HELLO, helloPayload || {}, { timeoutMs: 2000 });
          if (ack && ack.type === TYPES.HELLO_ACK) {
            this._helloDone = true;
            return true;
          }
        } catch (_) {
          this._handlePortDisconnect();
        }
      }
      return false;
    }

    async ping() {
      try {
        const out = await this.request(TYPES.PING, {}, { timeoutMs: 2000 });
        return Boolean(out && out.type === TYPES.PING_ACK && out.payload && out.payload.ok);
      } catch (_) {
        return false;
      }
    }

    async queryStatus(requestIds) {
      try {
        const out = await this.request(TYPES.QUERY_STATUS, {
          requestIds: Array.isArray(requestIds) ? requestIds.slice(0, 500) : []
        }, { timeoutMs: 4000 });
        if (out && out.type === TYPES.QUERY_STATUS_ACK && out.payload && out.payload.statuses && typeof out.payload.statuses === 'object') {
          return out.payload.statuses;
        }
      } catch (_) {
        // best-effort
      }
      return {};
    }
  }

  class OffscreenLlmExecutor {
    constructor({
      chromeApi,
      offscreenPath,
      inflightStore,
      offscreenManager,
      eventFactory,
      eventLogFn,
      hashFn
    } = {}) {
      this.chromeApi = chromeApi;
      this.eventFactory = eventFactory || null;
      this.log = typeof eventLogFn === 'function' ? eventLogFn : null;
      this.hashFn = typeof hashFn === 'function' ? hashFn : this._stableHash.bind(this);
      this.inflightStore = inflightStore || (NT.InflightRequestStore ? new NT.InflightRequestStore({ chromeApi }) : null);
      this.offscreenManager = offscreenManager || new OffscreenManager({
        chromeApi,
        offscreenPath,
        eventFactory,
        eventLogFn
      });
      this._pending = new Map();
      this._pendingByKey = new Map();
      this._unsubscribeManager = this.offscreenManager.onMessage((parsed) => this._handleOffscreenMessage(parsed));
    }

    _stableHash(input) {
      const source = typeof input === 'string' ? input : JSON.stringify(input || {});
      let hash = 2166136261;
      for (let i = 0; i < source.length; i += 1) {
        hash ^= source.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
      return (hash >>> 0).toString(16);
    }

    _requestKey({ jobId, blockId, attempt, taskType } = {}) {
      return `${jobId || 'nojob'}:${blockId || 'noblock'}:${Number.isFinite(Number(attempt)) ? Number(attempt) : 1}:${taskType || 'unknown'}`;
    }

    _payloadHash({ openaiRequest, taskType, requestMeta } = {}) {
      const source = {
        endpoint: openaiRequest && openaiRequest.endpoint ? openaiRequest.endpoint : null,
        body: openaiRequest && openaiRequest.body ? openaiRequest.body : null,
        taskType: taskType || 'unknown',
        jobId: requestMeta && requestMeta.jobId ? requestMeta.jobId : null,
        blockId: requestMeta && requestMeta.blockId ? requestMeta.blockId : null,
        attempt: requestMeta && Number.isFinite(Number(requestMeta.attempt)) ? Number(requestMeta.attempt) : 1
      };
      return this.hashFn(source);
    }

    _normalizeOpenaiRequest(openaiRequestOrPayload) {
      const source = openaiRequestOrPayload && typeof openaiRequestOrPayload === 'object'
        ? openaiRequestOrPayload
        : {};
      if (source.openai && typeof source.openai === 'object') {
        return this._normalizeOpenaiRequest(source.openai);
      }
      if (source.endpoint || source.headers || source.body) {
        return {
          endpoint: source.endpoint || null,
          headers: source.headers && typeof source.headers === 'object' ? source.headers : {},
          body: source.body && typeof source.body === 'object' ? source.body : {}
        };
      }
      return {
        endpoint: source.url || null,
        headers: source.headers && typeof source.headers === 'object' ? source.headers : {},
        body: (() => {
          if (source.body && typeof source.body === 'object') {
            return source.body;
          }
          if (typeof source.body === 'string' && source.body) {
            try {
              return JSON.parse(source.body);
            } catch (_) {
              return {};
            }
          }
          return {};
        })()
      };
    }

    _waiterFor(requestId) {
      return requestId ? (this._pending.get(requestId) || null) : null;
    }

    _createWaiter({ requestId, requestKey, timeoutMs }) {
      const existing = this._waiterFor(requestId);
      if (existing && existing.promise) {
        return existing;
      }
      const timeout = Math.max(3000, Math.min(Number(timeoutMs) || 120000, 180000));
      let resolveRef = null;
      let rejectRef = null;
      const promise = new Promise((resolve, reject) => {
        resolveRef = resolve;
        rejectRef = reject;
      });
      const waiter = {
        requestId,
        requestKey: requestKey || null,
        promise,
        resolve: (value) => resolveRef(value),
        reject: (error) => rejectRef(error),
        timeoutId: global.setTimeout(() => {
          this._clearWaiter(requestId);
          rejectRef({
            code: 'TIMEOUT',
            message: 'offscreen wait timeout'
          });
        }, timeout)
      };
      this._pending.set(requestId, waiter);
      if (requestKey) {
        this._pendingByKey.set(requestKey, requestId);
      }
      return waiter;
    }

    _clearWaiter(requestId) {
      if (!requestId) {
        return;
      }
      const waiter = this._pending.get(requestId);
      if (!waiter) {
        return;
      }
      this._pending.delete(requestId);
      if (waiter.requestKey) {
        const mapped = this._pendingByKey.get(waiter.requestKey);
        if (mapped === requestId) {
          this._pendingByKey.delete(waiter.requestKey);
        }
      }
      try {
        global.clearTimeout(waiter.timeoutId);
      } catch (_) {
        // best-effort
      }
    }

    _handleOffscreenMessage(parsed) {
      if (!parsed || typeof parsed !== 'object') {
        return;
      }
      const type = parsed.type || null;
      if (type !== TYPES.RESULT && type !== TYPES.ERROR) {
        return;
      }
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      const requestId = payload.requestId || null;
      if (!requestId) {
        return;
      }
      const waiter = this._pending.get(requestId);
      if (!waiter) {
        return;
      }
      this._clearWaiter(requestId);
      try {
        waiter.resolve(payload);
      } catch (_) {
        // best-effort
      }
    }

    async _readDoneFromStore(requestKey, payloadHash) {
      if (!this.inflightStore || typeof this.inflightStore.findByKey !== 'function') {
        return null;
      }
      try {
        const row = await this.inflightStore.findByKey(requestKey);
        if (!row || row.status !== 'done') {
          return null;
        }
        if (payloadHash && row.payloadHash && row.payloadHash !== payloadHash) {
          return null;
        }
        if (row.rawResult && typeof row.rawResult === 'object') {
          return row.rawResult;
        }
        if (row.rawJson && typeof row.rawJson === 'object') {
          return {
            ok: true,
            status: 200,
            headers: {},
            json: row.rawJson
          };
        }
      } catch (_) {
        return null;
      }
      return null;
    }

    async _writePending({ requestId, requestKey, payloadHash, taskType, attempt, requestMeta, timeoutMs }) {
      if (!this.inflightStore || typeof this.inflightStore.upsert !== 'function') {
        return null;
      }
      const now = Date.now();
      return this.inflightStore.upsert({
        requestId,
        requestKey,
        payloadHash,
        taskType: taskType || 'unknown',
        attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 1,
        status: 'pending',
        meta: {
          jobId: requestMeta && requestMeta.jobId ? requestMeta.jobId : null,
          blockId: requestMeta && requestMeta.blockId ? requestMeta.blockId : null
        },
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attemptDeadlineTs: now + Math.max(3000, Math.min(Number(timeoutMs) || 120000, 180000)),
        leaseUntilTs: this.inflightStore && typeof this.inflightStore.nextLease === 'function'
          ? this.inflightStore.nextLease(now)
          : null
      });
    }

    async _dispatchOffscreenExecute({ requestId, requestKey, payloadHash, taskType, attempt, requestMeta, openaiRequest, timeoutMs }) {
      const ready = await this.offscreenManager.ensureReady({
        helloPayload: {
          clientVersion: 'bg-offscreen-llm-executor'
        }
      });
      if (!ready) {
        const error = {
          code: 'OFFSCREEN_UNAVAILABLE',
          message: 'offscreen handshake failed'
        };
        return {
          requestId,
          requestKey,
          ok: false,
          error,
          ts: Date.now()
        };
      }
      const waiter = this._createWaiter({
        requestId,
        requestKey,
        timeoutMs
      });
      const sent = await this.offscreenManager.send(TYPES.EXECUTE_REQUEST, {
        requestId,
        requestKey,
        taskType: taskType || 'unknown',
        attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 1,
        input: null,
        openai: {
          endpoint: openaiRequest.endpoint || null,
          headers: openaiRequest.headers || {},
          body: openaiRequest.body || {}
        },
        meta: {
          jobId: requestMeta && requestMeta.jobId ? requestMeta.jobId : null,
          blockId: requestMeta && requestMeta.blockId ? requestMeta.blockId : null
        },
        timeoutMs: Math.max(3000, Math.min(Number(timeoutMs) || 120000, 180000)),
        payloadHash
      }, {
        meta: {
          requestId
        }
      });
      if (!sent) {
        this._clearWaiter(requestId);
        return {
          requestId,
          requestKey,
          ok: false,
          error: {
            code: 'OFFSCREEN_SEND_FAILED',
            message: 'failed to send execute request'
          },
          ts: Date.now()
        };
      }
      try {
        const out = await waiter.promise;
        return out && typeof out === 'object'
          ? out
          : {
            requestId,
            requestKey,
            ok: false,
            error: {
              code: 'OFFSCREEN_EMPTY_RESULT',
              message: 'empty offscreen result'
            },
            ts: Date.now()
          };
      } catch (error) {
        return {
          requestId,
          requestKey,
          ok: false,
          error: {
            code: error && error.code ? error.code : 'OFFSCREEN_WAIT_FAILED',
            message: error && error.message ? error.message : 'offscreen wait failed'
          },
          ts: Date.now()
        };
      }
    }

    async _executeCore({ requestId, requestKey, payloadHash, taskType, attempt, requestMeta, openaiRequest, timeoutMs, maxAttempts }) {
      const existingDone = await this._readDoneFromStore(requestKey, payloadHash);
      if (existingDone) {
        return existingDone;
      }

      let usedRequestId = requestId;
      if (this.inflightStore && typeof this.inflightStore.findByKey === 'function') {
        const byKey = await this.inflightStore.findByKey(requestKey).catch(() => null);
        if (byKey && byKey.requestId) {
          usedRequestId = byKey.requestId;
          if (byKey.status === 'pending') {
            const waiter = this._waiterFor(usedRequestId);
            if (waiter && waiter.promise) {
              return waiter.promise;
            }
          }
          if (byKey.status === 'done' && (!payloadHash || !byKey.payloadHash || byKey.payloadHash === payloadHash)) {
            if (byKey.rawResult) {
              return byKey.rawResult;
            }
          }
        }
      }

      const attempts = Number.isFinite(Number(maxAttempts)) ? Math.max(1, Math.min(Number(maxAttempts), 4)) : 2;
      let lastResult = null;
      for (let idx = 1; idx <= attempts; idx += 1) {
        await this._writePending({
          requestId: usedRequestId,
          requestKey,
          payloadHash,
          taskType,
          attempt,
          requestMeta,
          timeoutMs
        });

        const result = await this._dispatchOffscreenExecute({
          requestId: usedRequestId,
          requestKey,
          payloadHash,
          taskType,
          attempt,
          requestMeta,
          openaiRequest,
          timeoutMs
        });
        lastResult = result;
        const ok = Boolean(result && result.ok);
        const errorCode = result && result.error && result.error.code ? result.error.code : null;

        if (ok) {
          if (this.inflightStore && typeof this.inflightStore.markDone === 'function') {
            await this.inflightStore.markDone(usedRequestId, {
              rawJson: result && result.json ? result.json : null,
              rawResult: result,
              payloadHash,
              requestKey,
              resultSummary: {
                ok: true,
                status: result && (result.status || (result.http && result.http.status)) ? (result.status || result.http.status) : null
              }
            });
          }
          return result;
        }

        if (errorCode === 'ABORTED' || errorCode === 'ABORT_ERR') {
          if (this.inflightStore && typeof this.inflightStore.markCancelled === 'function') {
            await this.inflightStore.markCancelled(usedRequestId);
          }
          return result;
        }

        if (idx < attempts) {
          const backoffMs = Math.min(250 * (2 ** (idx - 1)), 2000);
          await new Promise((resolve) => global.setTimeout(resolve, backoffMs));
          continue;
        }

        if (this.inflightStore && typeof this.inflightStore.markFailed === 'function') {
          await this.inflightStore.markFailed(usedRequestId, {
            requestKey,
            payloadHash,
            error: result && result.error
              ? result.error
              : { code: 'OFFSCREEN_EXECUTE_FAILED', message: 'offscreen execution failed' }
          });
        }
      }
      return lastResult || {
        requestId: usedRequestId,
        requestKey,
        ok: false,
        error: { code: 'OFFSCREEN_EXECUTE_FAILED', message: 'offscreen execution failed' },
        ts: Date.now()
      };
    }

    async execute(args = {}) {
      // legacy API used by LlmClient: execute({requestId, payload, timeoutMs})
      const isLegacy = Object.prototype.hasOwnProperty.call(args || {}, 'payload')
        && Object.prototype.hasOwnProperty.call(args || {}, 'requestId')
        && !Object.prototype.hasOwnProperty.call(args || {}, 'openaiRequest');
      if (isLegacy) {
        const requestId = args.requestId || buildRequestId();
        const payload = args.payload && typeof args.payload === 'object' ? args.payload : {};
        const openaiRequest = this._normalizeOpenaiRequest(payload);
        const requestMeta = {
          requestId,
          jobId: payload.meta && payload.meta.jobId ? payload.meta.jobId : requestId,
          blockId: payload.meta && payload.meta.blockId ? payload.meta.blockId : null,
          attempt: Number.isFinite(Number(payload.attempt)) ? Number(payload.attempt) : 1
        };
        const taskType = payload.taskType || 'unknown';
        const requestKey = this._requestKey({
          jobId: requestMeta.jobId,
          blockId: requestMeta.blockId,
          attempt: requestMeta.attempt,
          taskType
        });
        const payloadHash = this._payloadHash({ openaiRequest, taskType, requestMeta });
        return this._executeCore({
          requestId,
          requestKey,
          payloadHash,
          taskType,
          attempt: requestMeta.attempt,
          requestMeta,
          openaiRequest,
          timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 120000,
          maxAttempts: Number.isFinite(Number(payload.maxAttempts)) ? Number(payload.maxAttempts) : 2
        });
      }

      // modern API
      const requestMeta = args.requestMeta && typeof args.requestMeta === 'object' ? args.requestMeta : {};
      const requestId = requestMeta.requestId || buildRequestId();
      const taskType = args.taskType || 'unknown';
      const attempt = Number.isFinite(Number(requestMeta.attempt)) ? Number(requestMeta.attempt) : 1;
      const requestKey = this._requestKey({
        jobId: requestMeta.jobId,
        blockId: requestMeta.blockId,
        attempt,
        taskType
      });
      const openaiRequest = this._normalizeOpenaiRequest(args.openaiRequest || {});
      const payloadHash = this._payloadHash({ openaiRequest, taskType, requestMeta });

      const result = await this._executeCore({
        requestId,
        requestKey,
        payloadHash,
        taskType,
        attempt,
        requestMeta: { ...requestMeta, requestId, attempt },
        openaiRequest,
        timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 120000,
        maxAttempts: Number.isFinite(Number(args.maxAttempts)) ? Number(args.maxAttempts) : 2
      });

      return result;
    }

    async cancel(requestId) {
      if (!requestId) {
        return { ok: false, error: { code: 'BAD_REQUEST_ID', message: 'requestId is required' } };
      }
      if (this.inflightStore && typeof this.inflightStore.markCancelled === 'function') {
        await this.inflightStore.markCancelled(requestId);
      }
      await this.offscreenManager.send(TYPES.CANCEL_REQUEST, {
        requestId,
        reason: 'ABORTED_BY_CALLER'
      }, {
        meta: { requestId }
      }).catch(() => false);

      const waiter = this._waiterFor(requestId);
      if (waiter) {
        this._clearWaiter(requestId);
        try {
          waiter.reject({ code: 'ABORTED', message: 'request cancelled' });
        } catch (_) {
          // best-effort
        }
      }
      return { ok: true };
    }

    async abort({ requestId } = {}) {
      const out = await this.cancel(requestId);
      return Boolean(out && out.ok);
    }

    async cancelByJobId(jobId, { maxRequests = 20 } = {}) {
      if (!jobId || !this.inflightStore || typeof this.inflightStore.findByJobId !== 'function') {
        return { ok: true, cancelled: 0 };
      }
      const rows = await this.inflightStore.findByJobId(jobId, { statuses: ['pending'], limit: maxRequests }).catch(() => []);
      let cancelled = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (!row || !row.requestId) {
          continue;
        }
        const out = await this.cancel(row.requestId).catch(() => ({ ok: false }));
        if (out && out.ok) {
          cancelled += 1;
        }
      }
      return { ok: true, cancelled };
    }

    async getCachedResult(requestId) {
      if (!requestId) {
        return null;
      }
      if (this.inflightStore && typeof this.inflightStore.get === 'function') {
        const row = await this.inflightStore.get(requestId).catch(() => null);
        if (row && row.status === 'done' && row.rawResult) {
          return row.rawResult;
        }
      }
      const statuses = await this.offscreenManager.queryStatus([requestId]).catch(() => ({}));
      const status = statuses && statuses[requestId] ? statuses[requestId] : null;
      if (status && status.result) {
        if (this.inflightStore && typeof this.inflightStore.markDone === 'function') {
          await this.inflightStore.markDone(requestId, {
            rawJson: status.result && status.result.json ? status.result.json : null,
            rawResult: status.result
          }).catch(() => null);
        }
        return status.result;
      }
      return null;
    }

    async adoptPending({ limit = 60 } = {}) {
      if (!this.inflightStore || typeof this.inflightStore.listPending !== 'function') {
        return { ok: true, adopted: 0 };
      }
      const rows = await this.inflightStore.listPending({ limit }).catch(() => []);
      if (!rows.length) {
        return { ok: true, adopted: 0 };
      }
      const ready = await this.offscreenManager.ensureReady({
        helloPayload: {
          clientVersion: 'bg-offscreen-llm-executor'
        }
      }).catch(() => false);
      if (!ready) {
        return { ok: false, adopted: 0 };
      }
      const pingOk = await this.offscreenManager.ping().catch(() => false);
      if (!pingOk) {
        return { ok: false, adopted: 0 };
      }
      const requestIds = rows.map((row) => row.requestId).filter(Boolean);
      const statuses = await this.offscreenManager.queryStatus(requestIds).catch(() => ({}));
      let adopted = 0;
      for (let i = 0; i < requestIds.length; i += 1) {
        const requestId = requestIds[i];
        const status = statuses && statuses[requestId] ? statuses[requestId] : null;
        if (!status || !status.result) {
          continue;
        }
        if (this.inflightStore && typeof this.inflightStore.markDone === 'function') {
          await this.inflightStore.markDone(requestId, {
            rawJson: status.result && status.result.json ? status.result.json : null,
            rawResult: status.result
          }).catch(() => null);
          adopted += 1;
        }
      }
      return { ok: true, adopted };
    }
  }

  NT.OffscreenManager = OffscreenManager;
  NT.OffscreenLlmExecutor = OffscreenLlmExecutor;
})(globalThis);
