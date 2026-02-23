/**
 * Content runtime bridge for translation protocol.
 */
(function initContentRuntime(global) {
  if (global.__NT_CONTENT_RUNTIME_ACTIVE) {
    return;
  }
  global.__NT_CONTENT_RUNTIME_ACTIVE = true;

  const NT = global.NT || (global.NT = {});
  const protocol = NT.TranslationProtocol || {};
  const MessageEnvelope = NT.MessageEnvelope || null;
  const indexer = new NT.DomIndexer({ doc: global.document });
  const applier = new NT.DomApplier();
  const contentSessionId = (MessageEnvelope && typeof MessageEnvelope.newId === 'function')
    ? MessageEnvelope.newId()
    : `cs-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  let activeJobId = null;

  function sendToBackground(payload, callback) {
    if (!global.chrome || !global.chrome.runtime || typeof global.chrome.runtime.sendMessage !== 'function') {
      if (typeof callback === 'function') {
        callback({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'chrome.runtime unavailable' } });
      }
      return;
    }
    try {
      global.chrome.runtime.sendMessage(payload, (response) => {
        if (typeof callback === 'function') {
          callback(response || { ok: true });
        }
      });
    } catch (_) {
      if (typeof callback === 'function') {
        callback({ ok: false, error: { code: 'SEND_FAILED', message: 'sendMessage failed' } });
      }
    }
  }

  function wrapOutgoing(type, payload, meta) {
    if (typeof protocol.wrap === 'function') {
      try {
        return protocol.wrap(type, payload, meta);
      } catch (_) {
        // best-effort fallback below
      }
    }
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    return { type, ...safePayload };
  }

  function unwrapIncoming(message) {
    if (typeof protocol.unwrap === 'function') {
      try {
        return protocol.unwrap(message);
      } catch (_) {
        // best-effort fallback below
      }
    }
    return {
      type: message && message.type ? message.type : null,
      payload: message && typeof message === 'object' ? message : {},
      meta: {},
      envelopeId: null
    };
  }

  function onStartJob(message, sendResponse) {
    activeJobId = message.jobId || null;
    const snapshot = indexer.scan();
    applier.setBlocks(activeJobId, snapshot.blocks, snapshot.blockNodes);
    sendToBackground(wrapOutgoing(protocol.CS_SCAN_RESULT, {
      jobId: activeJobId,
      blocks: snapshot.blocks,
      contentSessionId
    }, {
      source: 'content',
      stage: 'scan_result',
      requestId: activeJobId || null
    }), () => {});
    sendResponse({ ok: true, blocks: snapshot.blocks.length });
  }

  function onApplyBatch(message, sendResponse) {
    if (!activeJobId || message.jobId !== activeJobId) {
      sendResponse({ ok: false, error: { code: 'JOB_MISMATCH', message: 'No active job for batch' } });
      return;
    }
    const result = applier.applyBatch({ jobId: message.jobId, items: message.items || [] });
    sendToBackground(wrapOutgoing(protocol.CS_APPLY_ACK, {
      jobId: message.jobId,
      batchId: message.batchId || null,
      appliedCount: result.appliedCount,
      ok: true,
      contentSessionId
    }, {
      source: 'content',
      stage: 'apply_ack',
      requestId: message.batchId || null
    }), () => {});
    sendResponse({ ok: true, appliedCount: result.appliedCount });
  }

  function onCancelJob(message, sendResponse) {
    if (message && message.jobId && activeJobId && message.jobId !== activeJobId) {
      sendResponse({ ok: true, ignored: true });
      return;
    }
    applier.restoreOriginals({ jobId: activeJobId });
    activeJobId = null;
    sendResponse({ ok: true });
  }

  function onSetVisibility(message, sendResponse) {
    const result = applier.setVisibility(Boolean(message.visible));
    sendResponse({ ok: true, visible: result.visible });
  }

  function onRestoreOriginals(message, sendResponse) {
    const result = applier.restoreOriginals({ jobId: message && message.jobId ? message.jobId : activeJobId });
    sendResponse({ ok: true, restored: result.restored });
  }

  if (global.chrome && global.chrome.runtime && global.chrome.runtime.onMessage) {
    global.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const parsed = unwrapIncoming(message);
      const type = parsed && typeof parsed.type === 'string' ? parsed.type : null;
      const msg = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      if (!type) {
        return false;
      }
      if (msg && msg.contentSessionId && msg.contentSessionId !== contentSessionId) {
        sendResponse({ ok: true, ignored: true });
        return true;
      }
      if (type === protocol.BG_START_JOB) {
        onStartJob(msg, sendResponse);
        return true;
      }
      if (type === protocol.BG_APPLY_BATCH) {
        onApplyBatch(msg, sendResponse);
        return true;
      }
      if (type === protocol.BG_CANCEL_JOB) {
        onCancelJob(msg, sendResponse);
        return true;
      }
      if (type === protocol.BG_SET_VISIBILITY) {
        onSetVisibility(msg, sendResponse);
        return true;
      }
      if (type === protocol.BG_RESTORE_ORIGINALS) {
        onRestoreOriginals(msg, sendResponse);
        return true;
      }
      return false;
    });
  }

  sendToBackground(wrapOutgoing(protocol.CS_READY, {
    contentSessionId,
    url: global.location && global.location.href ? global.location.href : ''
  }, {
    source: 'content',
    stage: 'cs_ready'
  }), () => {});
})(globalThis);
