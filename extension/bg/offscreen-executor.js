/**
 * Service-worker transport executor for MV3 OpenAI requests.
 *
 * `OffscreenExecutor` prefers offscreen document transport, but degrades to
 * direct service-worker fetch when offscreen API or document creation is not
 * available. This prevents silent deadlocks during misconfigured installs.
 *
 * Contracts:
 * - public `execute` returns a terminal result object for each request;
 * - `ensureDocument` never throws on capability issues, it switches mode;
 * - direct fallback uses bounded timeout via AbortController;
 * - secrets are never logged in diagnostic events.
 *
 * This module does not implement AI selection logic or persistent tab state.
 */
(function initOffscreenExecutor(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  class OffscreenExecutor {
    constructor({ chromeApi, offscreenPath, eventFactory, eventLogFn } = {}) {
      this.chromeApi = chromeApi;
      this.offscreenPath = offscreenPath || 'offscreen/offscreen.html';
      this.eventFactory = eventFactory || null;
      this.log = typeof eventLogFn === 'function' ? eventLogFn : null;
      this.creating = null;
      this.didLogReady = false;
      this.mode = 'offscreen';
      this.disabledReason = null;
      this._bindListener();
    }

    _bindListener() {
      if (!this.chromeApi || !this.chromeApi.runtime || !this.chromeApi.runtime.onMessage) {
        return;
      }
      this.chromeApi.runtime.onMessage.addListener(() => false);
    }

    _emit(level, tag, message, meta) {
      if (!this.log) {
        return;
      }
      if (this.eventFactory) {
        const event = level === 'warn'
          ? this.eventFactory.warn(tag, message, meta)
          : level === 'error'
            ? this.eventFactory.error(tag, message, meta)
            : this.eventFactory.info(tag, message, meta);
        this.log(event);
        return;
      }
      this.log({ level, tag, message, meta });
    }

    _switchToDirect(reason, errorLike) {
      if (this.mode !== 'direct') {
        this._emit('warn', 'OFFSCREEN_FALLBACK_DIRECT', 'Offscreen is unavailable, switched to direct SW fetch mode.', {
          reason,
          message: errorLike && errorLike.message ? errorLike.message : null
        });
      }
      this.mode = 'direct';
      this.disabledReason = reason || 'OFFSCREEN_DISABLED';
    }

    async ensureDocument() {
      const chromeApi = this.chromeApi;
      if (!chromeApi || !chromeApi.runtime || !chromeApi.offscreen) {
        this._switchToDirect('OFFSCREEN_UNAVAILABLE');
        return;
      }

      const url = chromeApi.runtime.getURL(this.offscreenPath);
      const exists = await this._hasDocument(url);
      if (exists) {
        this.mode = 'offscreen';
        this.disabledReason = null;
        if (!this.didLogReady) {
          this._emit('info', 'bg.offscreen', 'Offscreen executor ready', { stage: 'existing' });
          this.didLogReady = true;
        }
        return;
      }

      if (this.creating) {
        try {
          await this.creating;
          this.mode = 'offscreen';
          this.disabledReason = null;
        } catch (error) {
          this._switchToDirect('OFFSCREEN_CREATE_FAILED', error);
        }
        return;
      }

      this.creating = chromeApi.offscreen.createDocument({
        url: this.offscreenPath,
        reasons: ['LOCAL_STORAGE'],
        justification: 'Perform resilient OpenAI requests and cache requestId results in IndexedDB.'
      });

      try {
        await this.creating;
        this.mode = 'offscreen';
        this.disabledReason = null;
        this._emit('info', 'bg.offscreen', 'Offscreen document created', { stage: 'create' });
        this.didLogReady = true;
      } catch (error) {
        this._switchToDirect('OFFSCREEN_CREATE_FAILED', error);
      } finally {
        this.creating = null;
      }
    }

    async _hasDocument(url) {
      const chromeApi = this.chromeApi;
      if (chromeApi.runtime && typeof chromeApi.runtime.getContexts === 'function') {
        const contexts = await chromeApi.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [url]
        });
        return Array.isArray(contexts) && contexts.length > 0;
      }

      try {
        const clientsList = await global.clients.matchAll({ includeUncontrolled: true, type: 'window' });
        return clientsList.some((client) => typeof client.url === 'string' && client.url === url);
      } catch (error) {
        return false;
      }
    }

    async _sendWithTimeout(message, timeoutMs) {
      const bounded = Math.max(3000, Math.min(Number(timeoutMs) || 90000, 180000));
      const sendPromise = this.chromeApi.runtime.sendMessage(message);
      return Promise.race([
        sendPromise,
        new Promise((_, reject) => {
          global.setTimeout(() => reject(new Error('OFFSCREEN_TIMEOUT')), bounded);
        })
      ]);
    }

    async getCachedResult(requestId) {
      if (!requestId) {
        return null;
      }
      await this.ensureDocument();
      if (this.mode !== 'offscreen') {
        return null;
      }
      const cached = await this._sendWithTimeout({ type: 'OFFSCREEN_GET_RESULT', requestId }, 6000);
      if (!cached || cached.ok !== true) {
        return null;
      }
      return cached.result || null;
    }

    async execute({ requestId, payload, timeoutMs } = {}) {
      if (!requestId) {
        throw new Error('OFFSCREEN_REQUEST_ID_REQUIRED');
      }
      const attempts = 2;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          await this.ensureDocument();

          if (this.mode === 'offscreen') {
            const cached = await this._sendWithTimeout({ type: 'OFFSCREEN_GET_RESULT', requestId }, 6000);
            if (cached && cached.ok && cached.result) {
              return cached.result;
            }

            return await this._sendWithTimeout({
              type: 'OFFSCREEN_EXECUTE',
              requestId,
              payload: { ...(payload || {}), timeoutMs: timeoutMs || (payload && payload.timeoutMs) || 90000 }
            }, timeoutMs || 90000);
          }

          return await this._directFetchExecute({ requestId, payload, timeoutMs });
        } catch (error) {
          if (attempt >= attempts) {
            throw error;
          }
          await new Promise((resolve) => global.setTimeout(resolve, 200 * attempt));
        }
      }
      throw new Error('OFFSCREEN_EXECUTE_FAILED');
    }

    async _directFetchExecute({ requestId, payload, timeoutMs } = {}) {
      const safePayload = payload && typeof payload === 'object' ? payload : {};
      const url = typeof safePayload.url === 'string' ? safePayload.url : '';
      const method = typeof safePayload.method === 'string' ? safePayload.method : 'POST';
      const headers = safePayload.headers && typeof safePayload.headers === 'object' ? safePayload.headers : {};
      const body = safePayload.body === undefined ? undefined : safePayload.body;
      if (!url) {
        return {
          ok: false,
          requestId,
          error: { code: 'DIRECT_FETCH_FAILED', message: 'Missing url in payload' }
        };
      }

      const controller = new AbortController();
      const bounded = Math.max(3000, Math.min(Number(timeoutMs || safePayload.timeoutMs || 90000), 180000));
      const timer = global.setTimeout(() => controller.abort(), bounded);
      try {
        const response = await global.fetch(url, {
          method,
          headers,
          body,
          signal: controller.signal
        });
        const json = await response.json();
        const headersObj = {};
        response.headers.forEach((value, key) => {
          headersObj[key] = value;
        });
        return {
          ok: true,
          requestId,
          status: response.status,
          json,
          headers: headersObj
        };
      } catch (error) {
        return {
          ok: false,
          requestId,
          error: {
            code: 'DIRECT_FETCH_FAILED',
            message: String(error && error.message ? error.message : error)
          }
        };
      } finally {
        global.clearTimeout(timer);
      }
    }
  }

  BG.OffscreenExecutor = OffscreenExecutor;
})(globalThis);
