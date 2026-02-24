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

  function normalizeCompareDiffThreshold(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return 8000;
    }
    return Math.max(500, Math.min(50000, Math.round(numeric)));
  }

  function applyCompareDiffThreshold(message, { rerender = true } = {}) {
    const payload = message && typeof message === 'object' ? message : {};
    if (!Object.prototype.hasOwnProperty.call(payload, 'compareDiffThreshold')) {
      return applier.compareDiffThresholdChars;
    }
    const next = normalizeCompareDiffThreshold(payload.compareDiffThreshold);
    return applier.setCompareDiffThreshold(next, { rerender });
  }

  function buildContentCaps() {
    return {
      domIndexerVersion: 'v1',
      supportsApplyDelta: true,
      supportsRestoreOriginal: true,
      supportsCompareMode: true,
      maxDomWritesPerSecondHint: 24,
      selectorStability: 'medium'
    };
  }

  function buildToolsetWanted() {
    return {
      toolsetId: 'neuro-translate',
      minSemver: '1.0.0',
      toolsetHash: null
    };
  }

  function sendToBackground(payload, callback) {
    if (!global.chrome || !global.chrome.runtime || typeof global.chrome.runtime.sendMessage !== 'function') {
      if (typeof callback === 'function') {
        callback({ ok: false, error: { code: 'RUNTIME_UNAVAILABLE', message: 'chrome.runtime unavailable' } });
      }
      return;
    }
    try {
      global.chrome.runtime.sendMessage(payload, (response) => {
        const lastError = global.chrome
          && global.chrome.runtime
          && global.chrome.runtime.lastError
          ? global.chrome.runtime.lastError
          : null;
        if (lastError) {
          if (typeof callback === 'function') {
            callback({
              ok: false,
              error: {
                code: 'BG_UNREACHABLE',
                message: lastError.message || 'Background service unreachable'
              }
            });
          }
          return;
        }
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
    const compareDiffThreshold = applyCompareDiffThreshold(message, { rerender: false });
    const snapshot = indexer.scan();
    applier.setBlocks(activeJobId, snapshot.blocks, snapshot.blockNodes);
    if (message && typeof message.mode === 'string') {
      applier.setDisplayMode(message.mode);
    } else if (Object.prototype.hasOwnProperty.call(message || {}, 'visible')) {
      applier.setVisibility(Boolean(message.visible));
    }
    sendToBackground(wrapOutgoing(protocol.CS_SCAN_RESULT, {
      jobId: activeJobId,
      blocks: snapshot.blocks,
      contentSessionId
    }, {
      source: 'content',
      stage: 'scan_result',
      requestId: activeJobId || null
    }), () => {});
    sendResponse({ ok: true, blocks: snapshot.blocks.length, compareDiffThreshold });
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

  function onApplyDelta(message, sendResponse) {
    if (!activeJobId || message.jobId !== activeJobId) {
      sendResponse({ ok: false, error: { code: 'JOB_MISMATCH', message: 'No active job for delta' } });
      return;
    }
    const requestedMode = message && typeof message.mode === 'string' ? message.mode : null;
    const thresholdRerender = !requestedMode && applier.displayMode === 'compare';
    const compareDiffThreshold = applyCompareDiffThreshold(message, { rerender: thresholdRerender });
    if (requestedMode && requestedMode !== applier.displayMode) {
      applier.setDisplayMode(requestedMode);
    }
    const result = applier.applyDelta({
      jobId: message.jobId,
      blockId: message.blockId || null,
      text: typeof message.text === 'string' ? message.text : '',
      isFinal: message.isFinal === true
    });
    sendToBackground(wrapOutgoing(protocol.CS_APPLY_DELTA_ACK, {
      jobId: message.jobId,
      blockId: message.blockId || null,
      deltaId: message.deltaId || null,
      applied: Boolean(result && result.applied),
      isFinal: message.isFinal === true,
      prevTextHash: result && result.prevTextHash ? result.prevTextHash : null,
      nextTextHash: result && result.nextTextHash ? result.nextTextHash : null,
      nodeCountTouched: Number.isFinite(Number(result && result.nodeCountTouched))
        ? Number(result.nodeCountTouched)
        : 0,
      displayMode: result && result.displayMode ? result.displayMode : null,
      compareDiffThreshold,
      ok: true,
      contentSessionId
    }, {
      source: 'content',
      stage: 'apply_delta_ack',
      requestId: message.blockId || null
    }), () => {});
    sendResponse({
      ok: true,
      applied: Boolean(result && result.applied),
      prevTextHash: result && result.prevTextHash ? result.prevTextHash : null,
      nextTextHash: result && result.nextTextHash ? result.nextTextHash : null,
      nodeCountTouched: Number.isFinite(Number(result && result.nodeCountTouched))
        ? Number(result.nodeCountTouched)
        : 0,
      displayMode: result && result.displayMode ? result.displayMode : null,
      compareDiffThreshold
    });
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
    const compareDiffThreshold = applyCompareDiffThreshold(message, { rerender: true });
    const result = typeof message.mode === 'string'
      ? applier.setDisplayMode(message.mode)
      : applier.setVisibility(Boolean(message.visible));
    sendResponse({
      ok: true,
      visible: result.visible,
      mode: result.mode || (result.visible ? 'translated' : 'original'),
      compareDiffThreshold
    });
  }

  function onRestoreOriginals(message, sendResponse) {
    const result = applier.restoreOriginals({ jobId: message && message.jobId ? message.jobId : activeJobId });
    sendResponse({ ok: true, restored: result.restored });
  }

  function onEraseJobData(message, sendResponse) {
    const targetJobId = message && message.jobId ? message.jobId : activeJobId;
    applier.restoreOriginals({ jobId: targetJobId });
    if (!message || !message.jobId || message.jobId === activeJobId) {
      activeJobId = null;
    }
    sendResponse({ ok: true, erased: true });
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
      if (type === protocol.BG_APPLY_DELTA) {
        onApplyDelta(msg, sendResponse);
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
      if (type === protocol.BG_ERASE_JOB_DATA) {
        onEraseJobData(msg, sendResponse);
        return true;
      }
      return false;
    });
  }

  const contentCaps = buildContentCaps();
  const toolsetWanted = buildToolsetWanted();
  sendToBackground(wrapOutgoing(protocol.CS_READY, {
    tabId: null,
    contentSessionId,
    url: global.location && global.location.href ? global.location.href : '',
    contentCaps
  }, {
    source: 'content',
    stage: 'cs_ready',
    clientCaps: { content: contentCaps },
    toolsetWanted
  }), () => {});
  sendToBackground(wrapOutgoing(protocol.CS_HELLO_CAPS, {
    tabId: null,
    contentSessionId,
    url: global.location && global.location.href ? global.location.href : '',
    contentCaps
  }, {
    source: 'content',
    stage: 'cs_hello_caps',
    clientCaps: { content: contentCaps },
    toolsetWanted
  }), () => {});
})(globalThis);
