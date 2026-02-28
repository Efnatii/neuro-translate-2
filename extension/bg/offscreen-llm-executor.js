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
    STREAM_EVENT: 'OFFSCREEN_STREAM_EVENT',
    STREAM_DONE: 'OFFSCREEN_STREAM_DONE',
    RESULT: 'OFFSCREEN_RESULT',
    ERROR: 'OFFSCREEN_ERROR',
    PING: 'OFFSCREEN_PING',
    PING_ACK: 'OFFSCREEN_PING_ACK',
    QUERY_STATUS: 'OFFSCREEN_QUERY_STATUS',
    QUERY_STATUS_ACK: 'OFFSCREEN_QUERY_STATUS_ACK',
    ATTACH: 'OFFSCREEN_ATTACH'
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
      this._offscreenCaps = null;
      this._offscreenInstanceId = null;
      this._activeRequests = [];
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

    _normalizeActiveRequests(input) {
      const source = Array.isArray(input) ? input : [];
      return source
        .map((item) => ({
          requestId: item && item.requestId ? String(item.requestId) : null,
          startedTs: Number.isFinite(Number(item && item.startedTs)) ? Number(item.startedTs) : null,
          lastEventTs: Number.isFinite(Number(item && item.lastEventTs)) ? Number(item.lastEventTs) : null,
          mode: item && item.mode === 'nonstream' ? 'nonstream' : 'stream'
        }))
        .filter((item) => Boolean(item.requestId));
    }

    _upsertActiveRequest(requestLike) {
      const normalized = this._normalizeActiveRequests([requestLike]);
      if (!normalized.length) {
        return;
      }
      const next = normalized[0];
      const prevList = this._normalizeActiveRequests(this._activeRequests);
      const byId = new Map(prevList.map((item) => [item.requestId, item]));
      byId.set(next.requestId, { ...(byId.get(next.requestId) || {}), ...next });
      this._activeRequests = Array.from(byId.values());
    }

    _dropActiveRequest(requestId) {
      if (!requestId) {
        return;
      }
      this._activeRequests = this._normalizeActiveRequests(this._activeRequests).filter((item) => item.requestId !== requestId);
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
      this._activeRequests = [];
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
      const type = parsed && parsed.type ? parsed.type : null;
      const payload = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      if (type === TYPES.HELLO_ACK) {
        this._offscreenInstanceId = payload.offscreenInstanceId || this._offscreenInstanceId;
        this._activeRequests = this._normalizeActiveRequests(payload.activeRequests);
      } else if (type === TYPES.STREAM_EVENT) {
        this._upsertActiveRequest({
          requestId: payload.requestId || null,
          startedTs: Number.isFinite(Number(payload.startedTs)) ? Number(payload.startedTs) : null,
          lastEventTs: Date.now(),
          mode: 'stream'
        });
      } else if (type === TYPES.RESULT || type === TYPES.ERROR || type === TYPES.STREAM_DONE) {
        this._dropActiveRequest(payload.requestId || null);
      }
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
          const hello = helloPayload && typeof helloPayload === 'object'
            ? { ...helloPayload }
            : {};
          if (!hello.instanceId) {
            hello.instanceId = `bg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
          }
          hello.wantActiveRequests = true;
          const ack = await this.request(TYPES.HELLO, hello, {
            timeoutMs: 2000,
            meta: {
              clientCaps: {
                bg: {
                  supportsStream: true,
                  supportsAbort: true
                }
              },
              toolsetWanted: {
                toolsetId: 'neuro-translate',
                minSemver: '1.0.0',
                toolsetHash: null
              }
            }
          });
          if (ack && ack.type === TYPES.HELLO_ACK) {
            this._helloDone = true;
            const payload = ack.payload && typeof ack.payload === 'object' ? ack.payload : {};
            this._offscreenCaps = payload.offscreenCaps && typeof payload.offscreenCaps === 'object'
              ? { ...payload.offscreenCaps }
              : this._offscreenCaps;
            this._offscreenInstanceId = payload.offscreenInstanceId || this._offscreenInstanceId;
            this._activeRequests = this._normalizeActiveRequests(payload.activeRequests);
            return true;
          }
        } catch (_) {
          this._handlePortDisconnect();
        }
      }
      return false;
    }

    getCapabilities() {
      return this._offscreenCaps && typeof this._offscreenCaps === 'object'
        ? { ...this._offscreenCaps }
        : null;
    }

    getConnectionState() {
      return {
        connected: Boolean(this._port && this._helloDone),
        offscreenInstanceId: this._offscreenInstanceId || null,
        activeRequestsCount: Array.isArray(this._activeRequests) ? this._activeRequests.length : 0
      };
    }

    getActiveRequests() {
      return this._normalizeActiveRequests(this._activeRequests);
    }

    async attach(requestId) {
      if (!requestId) {
        return false;
      }
      const ready = await this.ensureReady({
        helloPayload: {
          clientVersion: 'bg-offscreen-llm-executor',
          wantActiveRequests: true
        }
      }).catch(() => false);
      if (!ready) {
        return false;
      }
      const sent = await this.send(TYPES.ATTACH, {
        requestId
      }, {
        meta: { requestId }
      }).catch(() => false);
      return Boolean(sent);
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
          const statuses = out.payload.statuses;
          const active = [];
          Object.keys(statuses).forEach((requestId) => {
            const row = statuses[requestId];
            if (!row || row.status !== 'pending') {
              return;
            }
            active.push({
              requestId,
              startedTs: Number.isFinite(Number(row.startedTs)) ? Number(row.startedTs) : null,
              lastEventTs: Number.isFinite(Number(row.lastEventTs)) ? Number(row.lastEventTs) : null,
              mode: row.mode === 'nonstream' ? 'nonstream' : 'stream'
            });
          });
          this._activeRequests = active;
          return statuses;
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
      hashFn,
      maxConcurrentRequests = 1,
      maxQueuedRequests = 120,
      activeTabIdProvider = null
    } = {}) {
      this.chromeApi = chromeApi;
      this.eventFactory = eventFactory || null;
      this.log = typeof eventLogFn === 'function' ? eventLogFn : null;
      this.hashFn = typeof hashFn === 'function' ? hashFn : this._stableHash.bind(this);
      this.maxConcurrentRequests = Math.max(1, Math.min(2, Number(maxConcurrentRequests) || 1));
      this.maxQueuedRequests = Number.isFinite(Number(maxQueuedRequests))
        ? Math.max(20, Math.min(500, Number(maxQueuedRequests)))
        : 120;
      this.activeTabIdProvider = typeof activeTabIdProvider === 'function' ? activeTabIdProvider : null;
      this.inflightStore = inflightStore || (NT.InflightRequestStore ? new NT.InflightRequestStore({ chromeApi }) : null);
      this.offscreenManager = offscreenManager || new OffscreenManager({
        chromeApi,
        offscreenPath,
        eventFactory,
        eventLogFn
      });
      this._pending = new Map();
      this._pendingByKey = new Map();
      this._streamListeners = new Map();
      this._streamHeartbeatTimers = new Map();
      this._dispatchQueue = [];
      this._dispatchInFlight = 0;
      this._dispatchCursor = 0;
      this._dispatchDrainActive = false;
      this._lastDispatchedJobId = null;
      this._lastDispatchedTabId = null;
      this._unsubscribeManager = this.offscreenManager.onMessage((parsed) => this._handleOffscreenMessage(parsed));
    }

    async _resolveActiveTabId() {
      if (!this.activeTabIdProvider) {
        return null;
      }
      try {
        const out = await this.activeTabIdProvider();
        return Number.isFinite(Number(out)) ? Number(out) : null;
      } catch (_) {
        return null;
      }
    }

    _enqueueDispatch(task) {
      return new Promise((resolve, reject) => {
        if (this._dispatchQueue.length >= this.maxQueuedRequests) {
          const error = new Error('Offscreen queue is under technical backpressure');
          error.code = 'OFFSCREEN_BACKPRESSURE';
          error.waitMs = Math.max(500, Math.ceil((this._dispatchQueue.length / Math.max(1, this.maxConcurrentRequests)) * 250));
          reject(error);
          return;
        }
        this._dispatchQueue.push({
          task: task && typeof task === 'object' ? task : {},
          resolve,
          reject,
          enqueuedAt: Date.now()
        });
        this._drainDispatchQueue().catch(() => null);
      });
    }

    async _pickDispatchIndex() {
      if (!this._dispatchQueue.length) {
        return -1;
      }
      const queueLen = this._dispatchQueue.length;
      if (queueLen === 1) {
        this._dispatchCursor = 0;
        return 0;
      }
      const activeTabId = await this._resolveActiveTabId();
      if (Number.isFinite(Number(activeTabId))) {
        const hasNonActiveQueued = this._dispatchQueue.some((entry) => {
          const tabId = entry && entry.task && Number.isFinite(Number(entry.task.tabId))
            ? Number(entry.task.tabId)
            : null;
          return tabId === null || tabId !== Number(activeTabId);
        });
        for (let i = 0; i < queueLen; i += 1) {
          const idx = (this._dispatchCursor + i) % queueLen;
          const entry = this._dispatchQueue[idx];
          const tabId = entry && entry.task && Number.isFinite(Number(entry.task.tabId))
            ? Number(entry.task.tabId)
            : null;
          if (tabId !== null && tabId === Number(activeTabId)) {
            const jobId = entry && entry.task && entry.task.jobId
              ? String(entry.task.jobId)
              : null;
            const sameAsLast = Boolean(
              (jobId && this._lastDispatchedJobId && jobId === this._lastDispatchedJobId)
              || (this._lastDispatchedTabId !== null && tabId === this._lastDispatchedTabId)
            );
            if (hasNonActiveQueued && sameAsLast) {
              continue;
            }
            this._dispatchCursor = (idx + 1) % queueLen;
            return idx;
          }
        }
      }
      for (let i = 0; i < queueLen; i += 1) {
        const idx = (this._dispatchCursor + i) % queueLen;
        const entry = this._dispatchQueue[idx];
        const jobId = entry && entry.task && entry.task.jobId ? String(entry.task.jobId) : null;
        if (jobId && this._lastDispatchedJobId && jobId === this._lastDispatchedJobId) {
          continue;
        }
        this._dispatchCursor = (idx + 1) % queueLen;
        return idx;
      }
      const fallbackIdx = this._dispatchCursor % queueLen;
      this._dispatchCursor = (fallbackIdx + 1) % queueLen;
      return fallbackIdx;
    }

    async _drainDispatchQueue() {
      if (this._dispatchDrainActive) {
        return;
      }
      this._dispatchDrainActive = true;
      try {
        while (this._dispatchInFlight < this.maxConcurrentRequests && this._dispatchQueue.length) {
          const idx = await this._pickDispatchIndex();
          if (idx < 0 || idx >= this._dispatchQueue.length) {
            break;
          }
          const entry = this._dispatchQueue.splice(idx, 1)[0];
          if (!entry || !entry.task || typeof entry.task.run !== 'function') {
            if (entry && typeof entry.reject === 'function') {
              entry.reject({ code: 'OFFSCREEN_QUEUE_INVALID_TASK', message: 'invalid dispatch task' });
            }
            continue;
          }
          const jobId = entry.task.jobId ? String(entry.task.jobId) : null;
          if (jobId) {
            this._lastDispatchedJobId = jobId;
          }
          const tabId = Number.isFinite(Number(entry.task.tabId))
            ? Number(entry.task.tabId)
            : null;
          this._lastDispatchedTabId = tabId;
          this._dispatchInFlight += 1;
          Promise.resolve()
            .then(() => entry.task.run())
            .then((result) => entry.resolve(result))
            .catch((error) => entry.reject(error))
            .finally(() => {
              this._dispatchInFlight = Math.max(0, this._dispatchInFlight - 1);
              this._drainDispatchQueue().catch(() => null);
            });
        }
      } finally {
        this._dispatchDrainActive = false;
      }
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
        let bodyObj = {};
        if (source.body && typeof source.body === 'object') {
          bodyObj = source.body;
        } else if (typeof source.body === 'string' && source.body) {
          try {
            bodyObj = JSON.parse(source.body);
          } catch (_) {
            bodyObj = {};
          }
        }
        return {
          endpoint: source.endpoint || source.url || null,
          headers: source.headers && typeof source.headers === 'object' ? source.headers : {},
          body: bodyObj
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
      if (type === TYPES.STREAM_EVENT) {
        const streamPayload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
        const streamRequestId = streamPayload.requestId || null;
        if (!streamRequestId) {
          return;
        }
        this._touchStreamHeartbeat(streamRequestId, streamPayload.event);
        const listeners = this._streamListeners.get(streamRequestId);
        if (listeners && listeners.size) {
          listeners.forEach((handler) => {
            try {
              handler(streamPayload.event);
            } catch (_) {
              // best-effort
            }
          });
        }
        return;
      }
      if (type !== TYPES.RESULT && type !== TYPES.ERROR && type !== TYPES.STREAM_DONE) {
        return;
      }
      const payload = parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      const requestId = payload.requestId || null;
      if (!requestId) {
        return;
      }
      const waiter = this._pending.get(requestId);
      if (!waiter) {
        if (type === TYPES.ERROR || type === TYPES.RESULT || type === TYPES.STREAM_DONE) {
          this._streamListeners.delete(requestId);
          if (this.inflightStore) {
            if ((type === TYPES.RESULT || type === TYPES.STREAM_DONE) && typeof this.inflightStore.markDone === 'function') {
              this.inflightStore.markDone(requestId, {
                rawJson: payload && payload.json ? payload.json : null,
                rawResult: payload
              }).catch(() => null);
            } else if (type === TYPES.ERROR && typeof this.inflightStore.markFailed === 'function') {
              this.inflightStore.markFailed(requestId, {
                error: payload && payload.error
                  ? payload.error
                  : { code: 'OFFSCREEN_ERROR', message: 'offscreen error without waiter' }
              }).catch(() => null);
            }
          }
        }
        return;
      }
      this._clearWaiter(requestId);
      this._streamListeners.delete(requestId);
      try {
        waiter.resolve(payload);
      } catch (_) {
        // best-effort
      }
    }

    _addStreamListener(requestId, handler) {
      if (!requestId || typeof handler !== 'function') {
        return;
      }
      const current = this._streamListeners.get(requestId) || new Set();
      current.add(handler);
      this._streamListeners.set(requestId, current);
    }

    _removeStreamListener(requestId, handler) {
      if (!requestId || typeof handler !== 'function') {
        return;
      }
      const current = this._streamListeners.get(requestId);
      if (!current) {
        return;
      }
      current.delete(handler);
      if (!current.size) {
        this._streamListeners.delete(requestId);
      }
    }

    _touchStreamHeartbeat(requestId, eventPayload) {
      if (!requestId || !this.inflightStore || typeof this.inflightStore.upsert !== 'function') {
        return;
      }
      if (this._streamHeartbeatTimers.has(requestId)) {
        return;
      }
      const timerId = global.setTimeout(() => {
        this._streamHeartbeatTimers.delete(requestId);
        const now = Date.now();
        let deltaPreview = null;
        if (eventPayload && eventPayload.type === 'response.output_text.delta' && typeof eventPayload.delta === 'string') {
          deltaPreview = String(eventPayload.delta).slice(-160);
        }
        if (typeof this.inflightStore.touchStreamHeartbeat === 'function') {
          this.inflightStore.touchStreamHeartbeat(requestId, {
            preview: deltaPreview,
            leaseUntilTs: this.inflightStore && typeof this.inflightStore.nextLease === 'function'
              ? this.inflightStore.nextLease(now)
              : null
          }).catch(() => null);
        } else {
          this.inflightStore.upsert(requestId, {
            requestId,
            status: 'pending',
            updatedAt: now,
            lastEventTs: now,
            streamPreview: deltaPreview,
            leaseUntilTs: this.inflightStore && typeof this.inflightStore.nextLease === 'function'
              ? this.inflightStore.nextLease(now)
              : null
          }).catch(() => null);
        }
      }, 120);
      this._streamHeartbeatTimers.set(requestId, timerId);
    }

    async _tryAttachPendingRequest({ requestId, requestKey, timeoutMs }) {
      if (!requestId) {
        return null;
      }
      const ready = await this.offscreenManager.ensureReady({
        helloPayload: {
          clientVersion: 'bg-offscreen-llm-executor',
          wantActiveRequests: true
        }
      }).catch(() => false);
      if (!ready) {
        return null;
      }
      const statuses = await this.offscreenManager.queryStatus([requestId]).catch(() => ({}));
      const status = statuses && statuses[requestId] ? statuses[requestId] : null;
      if (!status) {
        return null;
      }
      if (status.result && status.result.requestId) {
        if (this.inflightStore && typeof this.inflightStore.markDone === 'function') {
          await this.inflightStore.markDone(requestId, {
            rawJson: status.result && status.result.json ? status.result.json : null,
            rawResult: status.result
          }).catch(() => null);
        }
        return status.result;
      }
      if (status.status !== 'pending') {
        return null;
      }
      const waiter = this._createWaiter({
        requestId,
        requestKey: requestKey || null,
        timeoutMs
      });
      const attached = await this.offscreenManager.attach(requestId).catch(() => false);
      if (!attached) {
        this._clearWaiter(requestId);
        return null;
      }
      return waiter.promise;
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

    async _writePending({ requestId, requestKey, payloadHash, taskType, attempt, requestMeta, timeoutMs, mode = 'nonstream' }) {
      if (!this.inflightStore || typeof this.inflightStore.upsert !== 'function') {
        return null;
      }
      const now = Date.now();
      const connection = this.offscreenManager && typeof this.offscreenManager.getConnectionState === 'function'
        ? this.offscreenManager.getConnectionState()
        : {};
      return this.inflightStore.upsert({
        requestId,
        requestKey,
        payloadHash,
        taskType: taskType || 'unknown',
        attempt: Number.isFinite(Number(attempt)) ? Number(attempt) : 1,
        status: 'pending',
        stage: requestMeta && requestMeta.stage ? requestMeta.stage : null,
        mode: mode === 'stream' ? 'stream' : 'nonstream',
        meta: {
          jobId: requestMeta && requestMeta.jobId ? requestMeta.jobId : null,
          blockId: requestMeta && requestMeta.blockId ? requestMeta.blockId : null
        },
        offscreenInstanceId: connection && connection.offscreenInstanceId ? connection.offscreenInstanceId : null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        attemptDeadlineTs: now + Math.max(3000, Math.min(Number(timeoutMs) || 120000, 180000)),
        leaseUntilTs: this.inflightStore && typeof this.inflightStore.nextLease === 'function'
          ? this.inflightStore.nextLease(now)
          : null
      });
    }

    async _dispatchOffscreenExecute({ requestId, requestKey, payloadHash, taskType, attempt, requestMeta, openaiRequest, timeoutMs, mode = 'nonstream' }) {
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
        mode: mode === 'stream' ? 'stream' : 'nonstream',
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
      if (this.offscreenManager && typeof this.offscreenManager._upsertActiveRequest === 'function') {
        this.offscreenManager._upsertActiveRequest({
          requestId,
          startedTs: Date.now(),
          lastEventTs: Date.now(),
          mode: mode === 'stream' ? 'stream' : 'nonstream'
        });
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

    async _executeCore({ requestId, requestKey, payloadHash, taskType, attempt, requestMeta, openaiRequest, timeoutMs, maxAttempts, mode = 'nonstream' }) {
      const existingDone = await this._readDoneFromStore(requestKey, payloadHash);
      if (existingDone) {
        return existingDone;
      }

      let usedRequestId = requestId;
      if (this.inflightStore && typeof this.inflightStore.findByKey === 'function') {
        const byKey = await this.inflightStore.findByKey(requestKey).catch(() => null);
        if (byKey && byKey.requestId) {
          const byKeyStatus = String(byKey.status || '').toLowerCase();
          if (byKeyStatus === 'failed' || byKeyStatus === 'cancelled') {
            // Failed/cancelled attempts may have a cached offscreen error payload.
            // Use a fresh requestId to force a real retry instead of replaying cache.
            usedRequestId = buildRequestId();
          } else {
            usedRequestId = byKey.requestId;
          }
          if (byKeyStatus === 'pending') {
            const waiter = this._waiterFor(usedRequestId);
            if (waiter && waiter.promise) {
              return waiter.promise;
            }
            const attachedResult = await this._tryAttachPendingRequest({
              requestId: usedRequestId,
              requestKey,
              timeoutMs
            });
            if (attachedResult) {
              return attachedResult;
            }
          }
          if (byKeyStatus === 'done' && (!payloadHash || !byKey.payloadHash || byKey.payloadHash === payloadHash)) {
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
          timeoutMs,
          mode
        });

        const result = await this._enqueueDispatch({
          jobId: requestMeta && requestMeta.jobId ? requestMeta.jobId : null,
          tabId: requestMeta && Number.isFinite(Number(requestMeta.tabId)) ? Number(requestMeta.tabId) : null,
          run: async () => {
            if (this.inflightStore && typeof this.inflightStore.get === 'function') {
              const row = await this.inflightStore.get(usedRequestId).catch(() => null);
              if (row && row.status === 'cancelled') {
                return {
                  requestId: usedRequestId,
                  requestKey,
                  ok: false,
                  error: { code: 'ABORTED', message: 'request cancelled before dispatch' },
                  ts: Date.now()
                };
              }
            }
            return this._dispatchOffscreenExecute({
              requestId: usedRequestId,
              requestKey,
              payloadHash,
              taskType,
              attempt,
              requestMeta,
              openaiRequest,
              timeoutMs,
              mode
            });
          }
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
          tabId: payload.meta && Number.isFinite(Number(payload.meta.tabId))
            ? Number(payload.meta.tabId)
            : (Number.isFinite(Number(payload.tabId)) ? Number(payload.tabId) : null),
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
          maxAttempts: Number.isFinite(Number(payload.maxAttempts)) ? Number(payload.maxAttempts) : 2,
          mode: openaiRequest && openaiRequest.body && openaiRequest.body.stream === true ? 'stream' : 'nonstream'
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
        requestMeta: {
          ...requestMeta,
          requestId,
          attempt,
          tabId: Number.isFinite(Number(requestMeta.tabId)) ? Number(requestMeta.tabId) : null
        },
        openaiRequest,
        timeoutMs: Number.isFinite(Number(args.timeoutMs)) ? Number(args.timeoutMs) : 120000,
        maxAttempts: Number.isFinite(Number(args.maxAttempts)) ? Number(args.maxAttempts) : 2,
        mode: openaiRequest && openaiRequest.body && openaiRequest.body.stream === true ? 'stream' : 'nonstream'
      });

      return result;
    }

    async executeStream(args = {}) {
      const safeArgs = args && typeof args === 'object' ? { ...args } : {};
      const requestMeta = safeArgs.requestMeta && typeof safeArgs.requestMeta === 'object'
        ? { ...safeArgs.requestMeta }
        : {};
      const requestId = requestMeta.requestId
        || safeArgs.requestId
        || buildRequestId();
      const onEvent = typeof safeArgs.onEvent === 'function' ? safeArgs.onEvent : null;
      const isLegacy = Object.prototype.hasOwnProperty.call(safeArgs, 'payload')
        && Object.prototype.hasOwnProperty.call(safeArgs, 'requestId')
        && !Object.prototype.hasOwnProperty.call(safeArgs, 'openaiRequest');
      const listener = onEvent
        ? (eventPayload) => {
          try {
            onEvent(eventPayload);
          } catch (_) {
            // best-effort
          }
        }
        : null;
      if (listener) {
        this._addStreamListener(requestId, listener);
      }
      try {
        if (isLegacy) {
          return await this.execute({
            ...safeArgs,
            requestId
          });
        }
        return await this.execute({
          ...safeArgs,
          requestMeta: {
            ...requestMeta,
            requestId
          }
        });
      } finally {
        if (listener) {
          this._removeStreamListener(requestId, listener);
        }
      }
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
      if (this.offscreenManager && typeof this.offscreenManager._dropActiveRequest === 'function') {
        this.offscreenManager._dropActiveRequest(requestId);
      }

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

    async recoverInflightRequests({ limit = 120 } = {}) {
      if (!this.inflightStore || typeof this.inflightStore.listPending !== 'function') {
        return { ok: false, skipped: true };
      }
      const ready = await this.offscreenManager.ensureReady({
        helloPayload: {
          clientVersion: 'bg-offscreen-recover',
          wantActiveRequests: true
        }
      }).catch(() => false);
      if (!ready) {
        return { ok: false, error: { code: 'OFFSCREEN_UNAVAILABLE', message: 'offscreen not ready' } };
      }
      const pendingRows = await this.inflightStore.listPending({
        limit: Math.max(20, Number(limit) || 120)
      }).catch(() => []);
      const activeRequests = this.offscreenManager.getActiveRequests();
      const activeSet = new Set(activeRequests.map((item) => item.requestId).filter(Boolean));
      const byId = new Map((pendingRows || []).map((row) => [row && row.requestId ? row.requestId : null, row]).filter((pair) => Boolean(pair[0])));
      const conn = this.offscreenManager.getConnectionState();

      let attached = 0;
      for (let i = 0; i < activeRequests.length; i += 1) {
        const active = activeRequests[i];
        if (!active || !active.requestId) {
          continue;
        }
        const row = byId.get(active.requestId) || null;
        await this.inflightStore.upsert(active.requestId, {
          requestId: active.requestId,
          status: 'pending',
          updatedAt: Date.now(),
          startedAt: Number.isFinite(Number(active.startedTs))
            ? Number(active.startedTs)
            : (row && Number.isFinite(Number(row.startedAt)) ? Number(row.startedAt) : Date.now()),
          leaseUntilTs: this.inflightStore && typeof this.inflightStore.nextLease === 'function'
            ? this.inflightStore.nextLease(Date.now())
            : null,
          mode: active.mode === 'nonstream' ? 'nonstream' : 'stream',
          lastEventTs: Number.isFinite(Number(active.lastEventTs)) ? Number(active.lastEventTs) : null,
          offscreenInstanceId: conn && conn.offscreenInstanceId ? conn.offscreenInstanceId : null
        }).catch(() => null);
        const didAttach = await this.offscreenManager.attach(active.requestId).catch(() => false);
        if (didAttach) {
          attached += 1;
        }
      }

      const missingIds = [];
      for (let i = 0; i < pendingRows.length; i += 1) {
        const row = pendingRows[i];
        if (!row || !row.requestId) {
          continue;
        }
        if (!activeSet.has(row.requestId)) {
          missingIds.push(row.requestId);
        }
      }

      let adoptedDone = 0;
      let markedLost = 0;
      if (missingIds.length) {
        const statuses = await this.offscreenManager.queryStatus(missingIds).catch(() => ({}));
        for (let i = 0; i < missingIds.length; i += 1) {
          const requestId = missingIds[i];
          const status = statuses && statuses[requestId] ? statuses[requestId] : null;
          if (status && status.result && this.inflightStore && typeof this.inflightStore.markDone === 'function') {
            await this.inflightStore.markDone(requestId, {
              rawJson: status.result && status.result.json ? status.result.json : null,
              rawResult: status.result
            }).catch(() => null);
            adoptedDone += 1;
            continue;
          }
          if (status && status.status === 'pending') {
            const didAttach = await this.offscreenManager.attach(requestId).catch(() => false);
            if (didAttach) {
              attached += 1;
              continue;
            }
          }
          if (this.inflightStore && typeof this.inflightStore.markFailed === 'function') {
            await this.inflightStore.markFailed(requestId, {
              error: {
                code: 'OFFSCREEN_REQUEST_LOST',
                message: 'Request missing in offscreen after SW restart'
              }
            }).catch(() => null);
            markedLost += 1;
          }
        }
      }

      return {
        ok: true,
        activeInOffscreen: activeRequests.length,
        attached,
        adoptedDone,
        markedLost
      };
    }

    getOffscreenState() {
      return this.offscreenManager && typeof this.offscreenManager.getConnectionState === 'function'
        ? this.offscreenManager.getConnectionState()
        : {
          connected: false,
          offscreenInstanceId: null,
          activeRequestsCount: 0
        };
    }

    getOffscreenCaps() {
      return this.offscreenManager && typeof this.offscreenManager.getCapabilities === 'function'
        ? this.offscreenManager.getCapabilities()
        : null;
    }
  }

  NT.OffscreenManager = OffscreenManager;
  NT.OffscreenLlmExecutor = OffscreenLlmExecutor;
})(globalThis);
