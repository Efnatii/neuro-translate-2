/**
 * Safe logger that always redacts objects before console output.
 */
(function initSafeLogger(global) {
  const NT = global.NT || (global.NT = {});

  class SafeLogger {
    constructor({ redaction, consoleLike, prefix = 'NT' } = {}) {
      this.redaction = redaction || (NT.Redaction && typeof NT.Redaction.redactDeep === 'function'
        ? NT.Redaction
        : null);
      this.consoleLike = consoleLike || global.console || null;
      this.prefix = typeof prefix === 'string' ? prefix : 'NT';
    }

    _sanitize(value) {
      const redactor = this.redaction && typeof this.redaction.redactDeep === 'function'
        ? this.redaction.redactDeep.bind(this.redaction)
        : (NT.redactDeep || null);
      if (!redactor) {
        return value;
      }
      try {
        return redactor(value, {});
      } catch (_) {
        return { note: 'redaction_failed' };
      }
    }

    _emit(level, event, payload) {
      if (!this.consoleLike) {
        return;
      }
      const logFn = typeof this.consoleLike[level] === 'function'
        ? this.consoleLike[level].bind(this.consoleLike)
        : (typeof this.consoleLike.log === 'function' ? this.consoleLike.log.bind(this.consoleLike) : null);
      if (!logFn) {
        return;
      }
      const safeEvent = typeof event === 'string' ? event : 'event';
      const safePayload = this._sanitize(payload && typeof payload === 'object' ? payload : { value: payload });
      try {
        logFn(`[${this.prefix}] ${safeEvent}`, safePayload);
      } catch (_) {
        // no-op
      }
    }

    info(event, payload) {
      this._emit('info', event, payload);
    }

    warn(event, payload) {
      this._emit('warn', event, payload);
    }

    error(event, payload) {
      this._emit('error', event, payload);
    }
  }

  NT.SafeLogger = SafeLogger;
})(globalThis);
