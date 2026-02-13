/**
 * Reliable request bus over `chrome.runtime.Port` envelopes.
 *
 * `MessageBus` provides strict request flow for unstable MV3 channels:
 * REQUEST -> ACK -> RESPONSE with bounded timers.
 *
 * Contracts:
 * - every `request(...)` has mandatory ACK and RESPONSE timeouts;
 * - port disconnect rejects all pending requests with terminal errors;
 * - handlers are class-level callbacks keyed by envelope type;
 * - no infinite waits or silent command drops are allowed.
 *
 * This module does not open ports itself and does not persist state.
 */
(function initMessageBus(global) {
  const NT = global.NT || (global.NT = {});

  class MessageBus {
    constructor({ time, eventSink, source } = {}) {
      this.time = time || null;
      this.eventSink = typeof eventSink === 'function' ? eventSink : null;
      this.source = source || 'unknown';
      this.port = null;
      this.pending = new Map();
      this.handlers = new Map();
    }

    attachPort(port) {
      this.port = port;
      if (!this.port) {
        return;
      }
      this.port.onMessage.addListener((msg) => {
        this._onMessage(msg).catch(() => {});
      });
      this.port.onDisconnect.addListener(() => this._onDisconnect());
    }

    on(type, handlerFn) {
      if (!type || typeof handlerFn !== 'function') {
        return;
      }
      this.handlers.set(type, handlerFn);
    }

    send(type, payload, meta) {
      const MessageEnvelope = NT.MessageEnvelope;
      const env = MessageEnvelope.wrap(type, payload, { ...(meta || {}), source: this.source });
      this._post(env);
      return env;
    }

    async request(type, payload, meta, { ackTimeoutMs = 1500, timeoutMs = 15000 } = {}) {
      const MessageEnvelope = NT.MessageEnvelope;
      const env = MessageEnvelope.wrap(type, payload, {
        ...(meta || {}),
        source: this.source,
        expectResponse: true
      });
      const id = env.id;

      const promise = new Promise((resolve, reject) => {
        const ackTimer = global.setTimeout(() => {
          this._fail(id, { code: 'ACK_TIMEOUT', message: `ACK timeout for ${type}` });
        }, ackTimeoutMs);

        const resTimer = global.setTimeout(() => {
          this._fail(id, { code: 'RESPONSE_TIMEOUT', message: `Response timeout for ${type}` });
        }, timeoutMs);

        this.pending.set(id, { resolve, reject, ackTimer, resTimer, acked: false, type });
      });

      this._post(env);
      return promise;
    }

    _post(env) {
      if (!this.port) {
        throw Object.assign(new Error('MessageBus: port not attached'), { code: 'PORT_NOT_ATTACHED' });
      }
      this.port.postMessage(env);
    }

    async _onMessage(msg) {
      const MessageEnvelope = NT.MessageEnvelope;
      if (!MessageEnvelope || !MessageEnvelope.isEnvelope(msg)) {
        return;
      }

      const { id, type, meta, payload } = msg;

      if (type === 'bus:ack') {
        const row = this.pending.get(payload && payload.id ? payload.id : null);
        if (row && !row.acked) {
          row.acked = true;
          global.clearTimeout(row.ackTimer);
        }
        return;
      }

      if (type === 'bus:response') {
        const requestId = payload && payload.id ? payload.id : null;
        const row = this.pending.get(requestId);
        if (!row) {
          return;
        }
        global.clearTimeout(row.ackTimer);
        global.clearTimeout(row.resTimer);
        this.pending.delete(requestId);
        if (payload.ok) {
          row.resolve(payload.data);
          return;
        }
        row.reject(Object.assign(
          new Error(payload.error && payload.error.message ? payload.error.message : 'Request failed'),
          { code: payload.error && payload.error.code ? payload.error.code : 'REQ_FAILED' }
        ));
        return;
      }

      const wantsResponse = Boolean(meta && meta.expectResponse);
      if (wantsResponse) {
        this._post(MessageEnvelope.wrap('bus:ack', { id }, {
          source: this.source,
          stage: 'ack',
          requestId: meta && meta.requestId ? meta.requestId : null
        }));
      }

      const handler = this.handlers.get(type);
      if (!handler) {
        if (wantsResponse) {
          this._post(MessageEnvelope.wrap('bus:response', {
            id,
            ok: false,
            error: { code: 'NO_HANDLER', message: `No handler for ${type}` }
          }, { source: this.source, stage: 'resp' }));
        }
        return;
      }

      try {
        const data = await handler(msg);
        if (wantsResponse) {
          this._post(MessageEnvelope.wrap('bus:response', {
            id,
            ok: true,
            data
          }, { source: this.source, stage: 'resp' }));
        }
      } catch (error) {
        if (wantsResponse) {
          this._post(MessageEnvelope.wrap('bus:response', {
            id,
            ok: false,
            error: {
              code: error && error.code ? error.code : 'HANDLER_ERROR',
              message: String(error && error.message ? error.message : error)
            }
          }, { source: this.source, stage: 'resp' }));
        }
      }
    }

    _fail(id, error) {
      const row = this.pending.get(id);
      if (!row) {
        return;
      }
      global.clearTimeout(row.ackTimer);
      global.clearTimeout(row.resTimer);
      this.pending.delete(id);
      row.reject(Object.assign(new Error(error.message), { code: error.code }));
    }

    _onDisconnect() {
      const ids = Array.from(this.pending.keys());
      ids.forEach((id) => {
        const row = this.pending.get(id);
        const type = row && row.type ? row.type : 'unknown';
        this._fail(id, { code: 'PORT_DISCONNECTED', message: `Port disconnected during ${type}` });
      });
      this.port = null;
    }
  }

  NT.MessageBus = MessageBus;
})(globalThis);
