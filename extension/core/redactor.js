/**
 * Shared redaction service for snapshots, logs, and diagnostics payloads.
 *
 * Goal: prevent secret leakage (API keys, auth headers, prompts, raw input)
 * into UI snapshots and persistent event history.
 *
 * Contracts:
 * - methods never mutate source objects;
 * - settings redaction removes `apiKey` and exposes only safe indicators;
 * - event payload redaction masks sensitive keys and truncates huge strings.
 *
 * This module does not write storage and does not emit events by itself.
 */
(function initRedactor(global) {
  const NT = global.NT || (global.NT = {});

  class Redactor {
    constructor({ maxStringLength = 2000 } = {}) {
      this.maxStringLength = Number.isFinite(Number(maxStringLength))
        ? Math.max(128, Number(maxStringLength))
        : 2000;
      this.secretKeys = new Set(['apiKey', 'authorization', 'prompt', 'input']);
    }

    redactSettings(settingsObj) {
      const src = settingsObj && typeof settingsObj === 'object' ? { ...settingsObj } : {};
      const apiKey = typeof src.apiKey === 'string' ? src.apiKey : '';
      delete src.apiKey;
      src.hasApiKey = Boolean(apiKey);
      src.apiKeyLength = apiKey.length;
      return src;
    }

    redactEventPayload(payload) {
      if (!payload || typeof payload !== 'object') {
        return payload;
      }
      if (Array.isArray(payload)) {
        return payload.map((item) => this.redactEventPayload(item));
      }
      const output = {};
      Object.keys(payload).forEach((key) => {
        const value = payload[key];
        if (this.secretKeys.has(key)) {
          output[key] = '[REDACTED]';
          return;
        }
        output[key] = this._sanitizeValue(value);
      });
      return output;
    }

    redactSnapshot(snapshot) {
      const src = snapshot && typeof snapshot === 'object' ? { ...snapshot } : {};
      if (src.settings && typeof src.settings === 'object') {
        src.settings = this.redactSettings(src.settings);
      }
      if (src.eventLog && Array.isArray(src.eventLog.items)) {
        src.eventLog = {
          ...src.eventLog,
          items: src.eventLog.items.map((item) => {
            if (!item || typeof item !== 'object') {
              return item;
            }
            return this.redactEventPayload(item);
          })
        };
      }
      return src;
    }

    _sanitizeValue(value) {
      if (typeof value === 'string') {
        if (value.length > this.maxStringLength) {
          return '[TRUNCATED]';
        }
        return value;
      }
      if (Array.isArray(value)) {
        return value.map((item) => this._sanitizeValue(item));
      }
      if (value && typeof value === 'object') {
        return this.redactEventPayload(value);
      }
      return value;
    }
  }

  NT.Redactor = Redactor;
})(globalThis);
