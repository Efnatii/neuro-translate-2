/**
 * Network probe utilities for offscreen transport diagnostics.
 *
 * Provides deterministic reachability checks without exposing auth headers.
 */
(function initNetProbe(global) {
  const NT = global.NT || (global.NT = {});

  class NetProbe {
    constructor({ nowFn, timeoutMs } = {}) {
      this.nowFn = typeof nowFn === 'function' ? nowFn : (() => Date.now());
      this.timeoutMs = Number.isFinite(Number(timeoutMs))
        ? Math.max(1000, Math.min(30000, Math.round(Number(timeoutMs))))
        : 10000;
    }

    async runOpenAi({ authHeader, baseUrl } = {}) {
      const root = this._normalizeBaseUrl(baseUrl);
      const modelsUrl = `${root}/v1/models`;
      const safeAuthHeader = typeof authHeader === 'string' && authHeader.trim()
        ? authHeader.trim()
        : '';
      const steps = [];

      steps.push(await this._runStep({
        name: 'head.base',
        method: 'HEAD',
        url: root
      }));
      steps.push(await this._runStep({
        name: 'get.models.no_auth',
        method: 'GET',
        url: modelsUrl
      }));
      steps.push(await this._runStep({
        name: 'get.models.with_auth',
        method: 'GET',
        url: modelsUrl,
        headers: safeAuthHeader ? { Authorization: safeAuthHeader } : {}
      }));

      const ok = steps.some((step) => (
        step
        && step.ok === true
        && Number.isFinite(Number(step.status))
      ));
      return {
        ok,
        steps,
        online: global.navigator && typeof global.navigator.onLine === 'boolean'
          ? global.navigator.onLine
          : null,
        ua: global.navigator && typeof global.navigator.userAgent === 'string'
          ? global.navigator.userAgent
          : null
      };
    }

    async _runStep({ name, method, url, headers } = {}) {
      const startedAt = this.nowFn();
      const controller = new AbortController();
      const timeoutId = global.setTimeout(() => {
        try {
          controller.abort('timeout');
        } catch (_) {
          // best-effort
        }
      }, this.timeoutMs);

      try {
        const response = await global.fetch(url, {
          method: method || 'GET',
          headers: headers && typeof headers === 'object' ? headers : {},
          signal: controller.signal,
          cache: 'no-store'
        });
        return {
          name: name || 'step',
          ok: true,
          status: Number.isFinite(Number(response && response.status)) ? Number(response.status) : null,
          errName: null,
          errMessage: null,
          ms: this._elapsedSince(startedAt)
        };
      } catch (error) {
        return {
          name: name || 'step',
          ok: false,
          status: null,
          errName: error && error.name ? String(error.name).slice(0, 80) : 'Error',
          errMessage: this._sanitizeErrorMessage(error && error.message ? error.message : 'Failed to fetch'),
          ms: this._elapsedSince(startedAt)
        };
      } finally {
        global.clearTimeout(timeoutId);
      }
    }

    _normalizeBaseUrl(value) {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw) {
        return 'https://api.openai.com';
      }
      try {
        const parsed = new URL(raw);
        const origin = parsed.origin || 'https://api.openai.com';
        return String(origin).replace(/\/+$/, '');
      } catch (_) {
        return 'https://api.openai.com';
      }
    }

    _elapsedSince(startedAt) {
      const now = this.nowFn();
      const diff = Number(now) - Number(startedAt);
      if (!Number.isFinite(diff)) {
        return 0;
      }
      return Math.max(0, Math.round(diff));
    }

    _sanitizeErrorMessage(message) {
      const raw = typeof message === 'string' ? message.trim() : '';
      if (!raw) {
        return 'Failed to fetch';
      }
      return raw.slice(0, 220);
    }
  }

  NT.NetProbe = NetProbe;
})(globalThis);
