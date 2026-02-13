/**
 * Canonical envelope builder/validator for cross-context messaging.
 *
 * `MessageEnvelope` standardizes message identity and metadata so Port and
 * runtime transport layers can share one shape across UI, BG, and offscreen.
 *
 * Contracts:
 * - every envelope has version, unique id, type, timestamp, meta, payload;
 * - `wrap` preserves extra meta fields (for request/response hints);
 * - `isEnvelope` performs minimal structural validation only.
 *
 * This module does not send messages and does not contain transport logic.
 */
(function initMessageEnvelope(global) {
  class MessageEnvelope {
    static v = 1;

    static newId() {
      if (global.crypto && global.crypto.getRandomValues) {
        const bytes = new Uint8Array(16);
        global.crypto.getRandomValues(bytes);
        return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      }

      const randomPart = Math.random().toString(16).slice(2);
      return `${Date.now().toString(16)}-${randomPart}`;
    }

    static now() {
      return Date.now();
    }

    static wrap(type, payload, meta) {
      const safeMeta = meta && typeof meta === 'object' ? { ...meta } : {};
      const baseMeta = {
        source: safeMeta.source || 'unknown',
        tabId: safeMeta.tabId ?? null,
        stage: safeMeta.stage || 'unknown',
        requestId: safeMeta.requestId || null
      };
      delete safeMeta.source;
      delete safeMeta.tabId;
      delete safeMeta.stage;
      delete safeMeta.requestId;

      return {
        v: MessageEnvelope.v,
        id: MessageEnvelope.newId(),
        type,
        ts: MessageEnvelope.now(),
        meta: {
          ...baseMeta,
          ...safeMeta
        },
        payload
      };
    }

    static isEnvelope(obj) {
      if (!obj || typeof obj !== 'object') {
        return false;
      }

      return (
        typeof obj.v === 'number' &&
        typeof obj.id === 'string' &&
        typeof obj.type === 'string' &&
        typeof obj.ts === 'number' &&
        obj.meta &&
        typeof obj.meta === 'object' &&
        typeof obj.meta.source === 'string' &&
        'payload' in obj
      );
    }
  }

  global.NT.MessageEnvelope = MessageEnvelope;
})(globalThis);
