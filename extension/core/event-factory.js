/**
 * Event factory that enforces compact, consistent log entry shape.
 *
 * This class centralizes event creation so every module emits predictable
 * `{ts, level, tag, message, meta}` objects. It validates taxonomy against
 * `EventTypes` and compacts meta payloads to avoid oversized persistent logs.
 *
 * Security/size guardrails:
 * - truncate long strings,
 * - drop sensitive/heavy keys,
 * - flatten deep objects into bounded text representation.
 */
(function initEventFactory(global) {
  const NT = global.NT || (global.NT = {});

  class EventFactory {
    constructor({ time, source } = {}) {
      this.time = time || (NT.Time || null);
      this.source = source || 'unknown';
      this.EventTypes = NT.EventTypes || null;
    }

    _now() {
      return this.time && typeof this.time.now === 'function' ? this.time.now() : Date.now();
    }

    _truncate(text, max = 180) {
      if (typeof text !== 'string') {
        return text;
      }
      return text.length > max ? `${text.slice(0, max)}…` : text;
    }

    _compactMeta(meta, depth = 0) {
      if (!meta || typeof meta !== 'object') {
        return {};
      }

      const blocked = new Set(['prompt', 'input', 'outputText', 'fullResponse', 'apiKey']);
      const out = {};
      Object.keys(meta).forEach((key) => {
        if (blocked.has(key)) {
          return;
        }

        const value = meta[key];
        if (typeof value === 'string') {
          out[key] = this._truncate(value);
          return;
        }

        if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
          out[key] = value;
          return;
        }

        if (Array.isArray(value)) {
          const json = this._truncate(JSON.stringify(value).slice(0, 360), 360);
          out[key] = json;
          return;
        }

        if (typeof value === 'object') {
          if (depth >= 1) {
            out[key] = this._truncate(JSON.stringify(value).slice(0, 360), 360);
            return;
          }
          out[key] = this._compactMeta(value, depth + 1);
        }
      });

      if (!Object.prototype.hasOwnProperty.call(out, 'source')) {
        out.source = this.source;
      }

      return out;
    }

    make({ level, tag, message, meta } = {}) {
      const fallbackTag = this.EventTypes ? this.EventTypes.Tags.BG_ERROR : 'bg.error';
      const safeLevel = this.EventTypes && this.EventTypes.isValidLevel(level) ? level : 'warn';
      const safeTag = this.EventTypes && this.EventTypes.isValidTag(tag) ? tag : fallbackTag;
      return {
        ts: this._now(),
        level: safeLevel,
        tag: safeTag,
        message: typeof message === 'string' ? this._truncate(message, 240) : String(message || ''),
        meta: this._compactMeta(meta || {})
      };
    }

    info(tag, message, meta) {
      return this.make({ level: 'info', tag, message, meta });
    }

    warn(tag, message, meta) {
      return this.make({ level: 'warn', tag, message, meta });
    }

    error(tag, message, meta) {
      return this.make({ level: 'error', tag, message, meta });
    }
  }

  NT.EventFactory = EventFactory;
})(globalThis);
