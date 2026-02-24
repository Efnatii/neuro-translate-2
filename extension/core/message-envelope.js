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
        frameId: Number.isFinite(Number(safeMeta.frameId)) ? Number(safeMeta.frameId) : null,
        documentId: typeof safeMeta.documentId === 'string' && safeMeta.documentId
          ? safeMeta.documentId
          : null,
        frameUrl: typeof safeMeta.frameUrl === 'string' && safeMeta.frameUrl
          ? safeMeta.frameUrl
          : null,
        stage: safeMeta.stage || 'unknown',
        requestId: safeMeta.requestId || null
      };
      Object.keys(safeMeta).forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(baseMeta, key)) {
          return;
        }
        baseMeta[key] = safeMeta[key];
      });

      return {
        v: MessageEnvelope.v,
        id: MessageEnvelope.newId(),
        type,
        ts: MessageEnvelope.now(),
        meta: baseMeta,
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
