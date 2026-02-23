/**
 * Translation protocol shared by background and content runtime.
 *
 * Message types support MessageEnvelope transport for BG<->CS, while keeping
 * backward compatibility with plain runtime messages.
 */
(function initTranslationProtocol(global) {
  const NT = global.NT || (global.NT = {});

  const TranslationProtocol = Object.freeze({
    CS_READY: 'translation:cs:ready',
    CS_SCAN_RESULT: 'translation:cs:scan-result',
    CS_APPLY_ACK: 'translation:cs:apply-ack',

    BG_START_JOB: 'translation:bg:start-job',
    BG_APPLY_BATCH: 'translation:bg:apply-batch',
    BG_CANCEL_JOB: 'translation:bg:cancel-job',
    BG_SET_VISIBILITY: 'translation:bg:set-visibility',
    BG_RESTORE_ORIGINALS: 'translation:bg:restore-originals',

    wrap(type, payload, meta) {
      const MessageEnvelope = NT.MessageEnvelope || null;
      const safePayload = payload && typeof payload === 'object' ? payload : {};
      const safeMeta = meta && typeof meta === 'object' ? meta : {};
      if (MessageEnvelope && typeof MessageEnvelope.wrap === 'function') {
        return MessageEnvelope.wrap(type, safePayload, safeMeta);
      }
      return { type, ...safePayload };
    },

    unwrap(message) {
      const MessageEnvelope = NT.MessageEnvelope || null;
      if (MessageEnvelope && typeof MessageEnvelope.isEnvelope === 'function' && MessageEnvelope.isEnvelope(message)) {
        return {
          type: message.type || null,
          payload: message && message.payload && typeof message.payload === 'object' ? message.payload : {},
          meta: message && message.meta && typeof message.meta === 'object' ? message.meta : {},
          envelopeId: message && message.id ? message.id : null
        };
      }
      return {
        type: message && message.type ? message.type : null,
        payload: message,
        meta: {},
        envelopeId: null
      };
    },

    isContentToBackground(type) {
      return type === TranslationProtocol.CS_READY
        || type === TranslationProtocol.CS_SCAN_RESULT
        || type === TranslationProtocol.CS_APPLY_ACK;
    },

    isBackgroundToContent(type) {
      return type === TranslationProtocol.BG_START_JOB
        || type === TranslationProtocol.BG_APPLY_BATCH
        || type === TranslationProtocol.BG_CANCEL_JOB
        || type === TranslationProtocol.BG_SET_VISIBILITY
        || type === TranslationProtocol.BG_RESTORE_ORIGINALS;
    }
  });

  NT.TranslationProtocol = TranslationProtocol;
})(globalThis);
