/**
 * Service-worker side executor for MV3 offscreen transport orchestration.
 *
 * `OffscreenExecutor` owns lifecycle of the offscreen document and provides a
 * single `execute` method for AI transport requests. It keeps offscreen creation
 * idempotent, applies bounded retries for startup races, and enforces timeout
 * wrappers so background orchestration never waits forever.
 *
 * MV3 note: service workers may terminate at any point. Offscreen messaging can
 * revive SW, while offscreen-side request-id caching ensures idempotent resend
 * after restart.
 */
(function initOffscreenExecutor(global) {
  const NT = global.NT || (global.NT = {});

  class OffscreenExecutor {
    constructor({ chromeApi, offscreenPath, eventFactory, eventLogFn } = {}) {
      this.chromeApi = chromeApi;
      this.offscreenPath = offscreenPath || 'offscreen/offscreen.html';
      this.eventFactory = eventFactory || null;
      this.log = typeof eventLogFn === 'function' ? eventLogFn : null;
      this.creating = null;
      this.didLogReady = false;
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

    async ensureDocument() {
      const chromeApi = this.chromeApi;
      if (!chromeApi || !chromeApi.runtime || !chromeApi.offscreen) {
        const error = new Error('OFFSCREEN_UNAVAILABLE');
        error.code = 'OFFSCREEN_UNAVAILABLE';
        throw error;
      }

      const url = chromeApi.runtime.getURL(this.offscreenPath);
      const exists = await this._hasDocument(url);
      if (exists) {
        if (!this.didLogReady) {
          this._emit('info', 'bg.offscreen', 'Offscreen executor ready', { stage: 'existing' });
          this.didLogReady = true;
        }
        return;
      }

      if (this.creating) {
        await this.creating;
        return;
      }

      this.creating = chromeApi.offscreen.createDocument({
        url: this.offscreenPath,
        reasons: ['LOCAL_STORAGE'],
        justification: 'Perform resilient OpenAI requests and cache requestId results in IndexedDB.'
      });

      try {
        await this.creating;
        this._emit('info', 'bg.offscreen', 'Offscreen document created', { stage: 'create' });
        this.didLogReady = true;
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
          const cached = await this._sendWithTimeout({ type: 'OFFSCREEN_GET_RESULT', requestId }, 6000);
          if (cached && cached.ok && cached.result) {
            return cached.result;
          }

          return await this._sendWithTimeout({
            type: 'OFFSCREEN_EXECUTE',
            requestId,
            payload: { ...(payload || {}), timeoutMs: timeoutMs || (payload && payload.timeoutMs) || 90000 }
          }, timeoutMs || 90000);
        } catch (error) {
          if (attempt >= attempts) {
            throw error;
          }
          await new Promise((resolve) => global.setTimeout(resolve, 200 * attempt));
        }
      }
      throw new Error('OFFSCREEN_EXECUTE_FAILED');
    }

    async abort({ requestId, reason = 'ABORTED_BY_CALLER', timeoutMs = 4000 } = {}) {
      if (!requestId) {
        return false;
      }
      try {
        await this.ensureDocument();
        const response = await this._sendWithTimeout({
          type: 'OFFSCREEN_ABORT',
          requestId,
          reason
        }, timeoutMs);
        return Boolean(response && response.ok && response.aborted);
      } catch (_) {
        return false;
      }
    }
  }

  NT.OffscreenExecutor = OffscreenExecutor;
})(globalThis);
