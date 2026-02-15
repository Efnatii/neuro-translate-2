/**
 * Translation protocol shared by background and content runtime.
 *
 * Message types are plain runtime messages (not envelopes) because content
 * scripts do not participate in UI port transport.
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

