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
  const indexer = new NT.DomIndexer({ doc: global.document });
  const applier = new NT.DomApplier();

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

  function onStartJob(message, sendResponse) {
    activeJobId = message.jobId || null;
    const snapshot = indexer.scan();
    applier.setBlocks(activeJobId, snapshot.blocks, snapshot.blockNodes);
    sendToBackground({
      type: protocol.CS_SCAN_RESULT,
      jobId: activeJobId,
      blocks: snapshot.blocks
    }, () => {});
    sendResponse({ ok: true, blocks: snapshot.blocks.length });
  }

  function onApplyBatch(message, sendResponse) {
    if (!activeJobId || message.jobId !== activeJobId) {
      sendResponse({ ok: false, error: { code: 'JOB_MISMATCH', message: 'No active job for batch' } });
      return;
    }
    const result = applier.applyBatch({ jobId: message.jobId, items: message.items || [] });
    sendToBackground({
      type: protocol.CS_APPLY_ACK,
      jobId: message.jobId,
      batchId: message.batchId || null,
      appliedCount: result.appliedCount,
      ok: true
    }, () => {});
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
      if (!message || !message.type) {
        return false;
      }
      if (message.type === protocol.BG_START_JOB) {
        onStartJob(message, sendResponse);
        return true;
      }
      if (message.type === protocol.BG_APPLY_BATCH) {
        onApplyBatch(message, sendResponse);
        return true;
      }
      if (message.type === protocol.BG_CANCEL_JOB) {
        onCancelJob(message, sendResponse);
        return true;
      }
      if (message.type === protocol.BG_SET_VISIBILITY) {
        onSetVisibility(message, sendResponse);
        return true;
      }
      if (message.type === protocol.BG_RESTORE_ORIGINALS) {
        onRestoreOriginals(message, sendResponse);
        return true;
      }
      return false;
    });
  }

  sendToBackground({ type: protocol.CS_READY }, () => {});
})(globalThis);

