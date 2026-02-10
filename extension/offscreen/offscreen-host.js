/**
 * Offscreen runtime host for resilient OpenAI transport execution.
 *
 * This document is the only place where outbound network fetch requests are
 * executed for LLM responses when service-worker orchestration delegates work.
 * Communication uses runtime messaging only; no tabs/storage/offscreen APIs are
 * required inside this context.
 *
 * To support idempotent resend after MV3 worker restarts, each request result
 * is cached in IndexedDB by `requestId`. Repeated executions with the same id
 * return cached payloads instead of triggering another upstream fetch.
 *
 * Security note: no authorization headers or API keys are logged or persisted
 * in diagnostic structures emitted by this module.
 */
(function initOffscreenHost(global) {
  class OffscreenHost {
    constructor() {
      this.inFlight = new Map();
      this.db = null;
      this.DB_NAME = 'nt_offscreen';
      this.DB_VERSION = 1;
      this.STORE = 'results';
      this.TTL_MS = 6 * 60 * 60 * 1000;
      this.CLEANUP_INTERVAL_MS = 20 * 60 * 1000;
    }

    async init() {
      this.db = await this._openDb();
      global.chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg.type !== 'string') {
          return false;
        }
        this._onMessage(msg)
          .then((res) => sendResponse(res))
          .catch((error) => sendResponse({ ok: false, error: { code: 'OFFSCREEN_HOST_ERROR', message: String(error && error.message ? error.message : error) } }));
        return true;
      });
      this._scheduleCleanup();
    }

    async _onMessage(msg) {
      switch (msg.type) {
        case 'OFFSCREEN_HELLO':
          return { ok: true, ts: Date.now() };
        case 'OFFSCREEN_GET_RESULT': {
          const result = await this._getCached(msg.requestId);
          return result || { ok: true, result: null };
        }
        case 'OFFSCREEN_EXECUTE':
          return this._executeOnce(msg.requestId, msg.payload || {});
        case 'OFFSCREEN_PURGE':
          await this._purgeExpired();
          return { ok: true };
        default:
          return {
            ok: false,
            error: {
              code: 'UNKNOWN_TYPE',
              message: `Unknown type: ${msg.type}`
            }
          };
      }
    }

    async _executeOnce(requestId, payload) {
      if (!requestId) {
        return { ok: false, error: { code: 'BAD_REQUEST_ID', message: 'requestId is required' } };
      }
      const cached = await this._getCached(requestId);
      if (cached && cached.ok && cached.result) {
        return cached.result;
      }
      if (this.inFlight.has(requestId)) {
        return this.inFlight.get(requestId);
      }
      const promise = this._doFetchAndCache(requestId, payload)
        .finally(() => {
          this.inFlight.delete(requestId);
        });
      this.inFlight.set(requestId, promise);
      return promise;
    }

    async _doFetchAndCache(requestId, payload) {
      const startedAt = Date.now();
      const timeoutMsRaw = Number(payload && payload.timeoutMs);
      const timeoutMs = Number.isFinite(timeoutMsRaw)
        ? Math.max(3000, Math.min(timeoutMsRaw, 180000))
        : 90000;
      const controller = new AbortController();
      const timeoutId = global.setTimeout(() => controller.abort('timeout'), timeoutMs);

      try {
        const response = await global.fetch(payload.url, {
          method: payload.method || 'POST',
          headers: payload.headers || {},
          body: payload.body || null,
          signal: controller.signal
        });

        const text = await response.text();
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (error) {
          json = null;
        }

        const headers = {};
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
            headers[key] = value;
          }
        });

        const result = {
          ok: response.ok,
          status: response.status,
          headers,
          json,
          text: json ? null : text,
          meta: {
            startedAt,
            elapsedMs: Date.now() - startedAt
          }
        };
        await this._putCached(requestId, result);
        return result;
      } catch (error) {
        const result = {
          ok: false,
          status: 0,
          headers: {},
          json: null,
          text: null,
          error: {
            code: 'FETCH_FAILED',
            message: String(error && error.message ? error.message : error)
          },
          meta: {
            startedAt,
            elapsedMs: Date.now() - startedAt
          }
        };
        await this._putCached(requestId, result);
        return result;
      } finally {
        global.clearTimeout(timeoutId);
      }
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
      if ((Date.now() - row.ts) > this.TTL_MS) {
        await this._deleteCached(requestId);
        return null;
      }
      return { ok: true, result: row.result };
    }

    async _putCached(requestId, result) {
      if (!requestId || !this.db) {
        return;
      }
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(this.STORE, 'readwrite');
        const store = tx.objectStore(this.STORE);
        const req = store.put({ requestId, ts: Date.now(), result });
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error || new Error('IndexedDB write failed'));
      });
    }

    async _deleteCached(requestId) {
      if (!requestId || !this.db) {
        return;
      }
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(this.STORE, 'readwrite');
        const store = tx.objectStore(this.STORE);
        const req = store.delete(requestId);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error || new Error('IndexedDB delete failed'));
      });
    }

    async _purgeExpired() {
      if (!this.db) {
        return;
      }
      const now = Date.now();
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
          if (!value || !value.ts || (now - value.ts) > this.TTL_MS) {
            cursor.delete();
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error || new Error('IndexedDB purge failed'));
      });
    }

    _scheduleCleanup() {
      global.setTimeout(async () => {
        try {
          await this._purgeExpired();
        } catch (error) {
          // ignore cleanup errors; next schedule will retry
        }
        this._scheduleCleanup();
      }, this.CLEANUP_INTERVAL_MS);
    }
  }

  new OffscreenHost().init().catch(() => {});
})(globalThis);
