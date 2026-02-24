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
  const classifier = NT.DomClassifier ? new NT.DomClassifier() : null;
  const contentSessionId = (MessageEnvelope && typeof MessageEnvelope.newId === 'function')
    ? MessageEnvelope.newId()
    : `cs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const isTopFrame = (() => {
    try {
      return global.top === global;
    } catch (_) {
      return false;
    }
  })();

  let activeJobId = null;
  let lastScanSnapshot = null;
  let classificationStale = false;
  let domObserver = null;
  let domObserverDebounce = null;
  let observeDomChangesEnabled = false;
  let runtimeFrameId = isTopFrame ? 0 : null;
  let runtimeDocumentId = null;
  let runtimeFrameUrl = global.location && typeof global.location.href === 'string'
    ? global.location.href
    : null;
  let routeHooksInstalled = false;
  let lastKnownLocationHref = runtimeFrameUrl || '';

  function buildFrameMeta(extra = {}) {
    const meta = {
      frameId: Number.isFinite(Number(runtimeFrameId)) ? Number(runtimeFrameId) : null,
      documentId: typeof runtimeDocumentId === 'string' && runtimeDocumentId ? runtimeDocumentId : null,
      frameUrl: runtimeFrameUrl || null
    };
    return { ...meta, ...(extra && typeof extra === 'object' ? extra : {}) };
  }

  function stopDomObserver() {
    if (domObserverDebounce) {
      global.clearTimeout(domObserverDebounce);
      domObserverDebounce = null;
    }
    if (domObserver && typeof domObserver.disconnect === 'function') {
      domObserver.disconnect();
    }
    domObserver = null;
  }

  function markClassificationStale({ reason = 'dom_mutation', resetScanSnapshot = false } = {}) {
    classificationStale = true;
    if (resetScanSnapshot) {
      lastScanSnapshot = null;
    }
  }

  function markRouteChangeIfNeeded(source) {
    const currentHref = global.location && typeof global.location.href === 'string'
      ? global.location.href
      : '';
    if (!currentHref || currentHref === lastKnownLocationHref) {
      return false;
    }
    lastKnownLocationHref = currentHref;
    runtimeFrameUrl = currentHref;
    markClassificationStale({
      reason: 'route_change',
      resetScanSnapshot: true
    });
    if (activeJobId) {
      sendToBackground(wrapOutgoing(protocol.CS_SCAN_PROGRESS, {
        jobId: activeJobId,
        frameId: runtimeFrameId,
        frameUrl: runtimeFrameUrl,
        progress: {
          routeChanged: true,
          source: String(source || 'route_change'),
          href: runtimeFrameUrl
        },
        contentSessionId
      }, buildFrameMeta({
        source: 'content',
        stage: 'route_change',
        requestId: activeJobId || null
      })), () => {});
    }
    return true;
  }

  function installRouteChangeHooks() {
    if (!isTopFrame || routeHooksInstalled) {
      return;
    }
    routeHooksInstalled = true;
    const historyObj = global.history;
    if (historyObj && typeof historyObj === 'object') {
      ['pushState', 'replaceState'].forEach((methodName) => {
        const original = historyObj[methodName];
        if (typeof original !== 'function') {
          return;
        }
        try {
          historyObj[methodName] = function wrappedHistoryMethod(...args) {
            const out = original.apply(this, args);
            markRouteChangeIfNeeded(`history.${methodName}`);
            return out;
          };
        } catch (_) {
          // best-effort
        }
      });
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('popstate', () => markRouteChangeIfNeeded('popstate'), true);
      global.addEventListener('hashchange', () => markRouteChangeIfNeeded('hashchange'), true);
    }
  }

  function normalizeScanBudgetNumber(value, fallback, { min, max } = {}) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return fallback;
    }
    const floor = Number.isFinite(Number(min)) ? Number(min) : Number.NEGATIVE_INFINITY;
    const ceiling = Number.isFinite(Number(max)) ? Number(max) : Number.POSITIVE_INFINITY;
    return Math.max(floor, Math.min(ceiling, Math.round(numeric)));
  }

  function buildScanOptions(message, extras = {}) {
    const payload = message && typeof message === 'object' ? message : {};
    const options = {
      maxTextNodesPerScan: normalizeScanBudgetNumber(payload.maxTextNodesPerScan, 5000, { min: 200, max: 30000 }),
      yieldEveryNNodes: normalizeScanBudgetNumber(payload.yieldEveryNNodes, 260, { min: 40, max: 2500 }),
      abortScanIfOverMs: normalizeScanBudgetNumber(payload.abortScanIfOverMs, 0, { min: 0, max: 120000 }),
      degradeOnHeavy: payload.degradeOnHeavy !== false,
      progressEveryNodes: 120
    };
    if (extras && typeof extras === 'object') {
      Object.assign(options, extras);
    }
    return options;
  }

  function buildScanPerf(snapshot, startedAt) {
    const fromSnapshot = snapshot && snapshot.scanPerf && typeof snapshot.scanPerf === 'object'
      ? snapshot.scanPerf
      : {};
    return {
      scanTimeMs: Number.isFinite(Number(fromSnapshot.scanTimeMs))
        ? Math.max(0, Number(fromSnapshot.scanTimeMs))
        : Math.max(0, Date.now() - startedAt),
      visitedNodes: Number.isFinite(Number(fromSnapshot.visitedNodes))
        ? Math.max(0, Number(fromSnapshot.visitedNodes))
        : (snapshot && snapshot.stats && Number.isFinite(Number(snapshot.stats.visitedNodes))
          ? Math.max(0, Number(snapshot.stats.visitedNodes))
          : 0),
      truncated: fromSnapshot.truncated === true
        || (snapshot && snapshot.stats && snapshot.stats.truncated === true),
      abortedByBudget: fromSnapshot.abortedByBudget === true
        || (snapshot && snapshot.stats && snapshot.stats.abortedByBudget === true)
    };
  }

  function buildScanError(error) {
    const err = error && typeof error === 'object' ? error : {};
    if (err.code === 'SCAN_TOO_HEAVY') {
      return {
        code: 'SCAN_TOO_HEAVY',
        message: typeof err.message === 'string' && err.message
          ? err.message
          : 'DOM scan exceeded performance budget',
        elapsedMs: Number.isFinite(Number(err.elapsedMs)) ? Math.max(0, Number(err.elapsedMs)) : null,
        budgetMs: Number.isFinite(Number(err.budgetMs)) ? Math.max(0, Number(err.budgetMs)) : null,
        visitedNodes: Number.isFinite(Number(err.visitedNodes)) ? Math.max(0, Number(err.visitedNodes)) : null,
        blockCount: Number.isFinite(Number(err.blockCount)) ? Math.max(0, Number(err.blockCount)) : null
      };
    }
    return {
      code: 'SCAN_FAILED',
      message: typeof err.message === 'string' && err.message ? err.message : 'DOM scan failed'
    };
  }

  async function performScan(message, { onProgress = null } = {}) {
    const startedAt = Date.now();
    const scanOptions = buildScanOptions(message, { onProgress });
    const scanFn = indexer && typeof indexer.scanAsync === 'function'
      ? indexer.scanAsync.bind(indexer)
      : async (opts) => indexer.scan(opts);
    try {
      const snapshot = await scanFn(scanOptions);
      return {
        ok: true,
        snapshot,
        scanPerf: buildScanPerf(snapshot, startedAt),
        scanError: null
      };
    } catch (error) {
      return {
        ok: false,
        snapshot: null,
        scanPerf: {
          scanTimeMs: Math.max(0, Date.now() - startedAt),
          visitedNodes: 0,
          truncated: false,
          abortedByBudget: false
        },
        scanError: buildScanError(error)
      };
    }
  }

  function startDomObserver() {
    stopDomObserver();
    if (!observeDomChangesEnabled || !global.MutationObserver || !global.document || !global.document.body) {
      return;
    }
    const debounceMs = 750;
    domObserver = new global.MutationObserver(() => {
      if (domObserverDebounce) {
        global.clearTimeout(domObserverDebounce);
      }
      domObserverDebounce = global.setTimeout(() => {
        domObserverDebounce = null;
        markClassificationStale();
        markRouteChangeIfNeeded('mutation_observer');
      }, debounceMs);
    });
    domObserver.observe(global.document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-label', 'role', 'lang']
    });
  }

  function configureDomObserver(enabled) {
    observeDomChangesEnabled = Boolean(enabled);
    if (!observeDomChangesEnabled) {
      stopDomObserver();
      return;
    }
    startDomObserver();
  }

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

  function normalizeCompareRendering(value) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (raw === 'highlights' || raw === 'wrappers' || raw === 'auto') {
      return raw;
    }
    return 'auto';
  }

  function applyCompareRendering(message, { rerender = true } = {}) {
    if (!applier || typeof applier.setCompareRendering !== 'function') {
      return 'auto';
    }
    const payload = message && typeof message === 'object' ? message : {};
    if (!Object.prototype.hasOwnProperty.call(payload, 'compareRendering')) {
      return applier.compareRendering || 'auto';
    }
    const next = normalizeCompareRendering(payload.compareRendering);
    return applier.setCompareRendering(next, { rerender });
  }

  function buildContentCaps() {
    const highlightSupported = NT.HighlightEngine && typeof NT.HighlightEngine.isSupported === 'function'
      ? NT.HighlightEngine.isSupported()
      : Boolean(global.CSS && global.CSS.highlights && typeof global.Highlight === 'function');
    return {
      domIndexerVersion: 'v1',
      supportsApplyDelta: true,
      supportsRestoreOriginal: true,
      supportsCompareMode: true,
      supportsHighlights: highlightSupported,
      shadowDomScan: true,
      isTopFrame,
      supportsClassifier: Boolean(classifier),
      classifierVersion: classifier && classifier.constructor && classifier.constructor.VERSION
        ? classifier.constructor.VERSION
        : null,
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

  function updateFrameContextFromResponse(responseLike) {
    const response = responseLike && typeof responseLike === 'object' ? responseLike : {};
    if (Number.isFinite(Number(response.frameId))) {
      runtimeFrameId = Number(response.frameId);
    }
    if (typeof response.documentId === 'string' && response.documentId) {
      runtimeDocumentId = response.documentId;
    }
    if (typeof response.frameUrl === 'string' && response.frameUrl) {
      runtimeFrameUrl = response.frameUrl;
    } else if (!runtimeFrameUrl && global.location && typeof global.location.href === 'string') {
      runtimeFrameUrl = global.location.href;
    }
  }

  function onStartJob(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({
        ok: true,
        ignored: true,
        reason: 'non_top_frame_runtime',
        frameId: runtimeFrameId
      });
      return;
    }
    activeJobId = message.jobId || null;
    const compareDiffThreshold = applyCompareDiffThreshold(message, { rerender: false });
    const compareRendering = applyCompareRendering(message, { rerender: false });
    let lastScanProgressSentAt = 0;
    performScan(message, {
      onProgress: (progress) => {
        if (!protocol.CS_SCAN_PROGRESS) {
          return;
        }
        const now = Date.now();
        if ((now - lastScanProgressSentAt) < 350) {
          return;
        }
        lastScanProgressSentAt = now;
        sendToBackground(wrapOutgoing(protocol.CS_SCAN_PROGRESS, {
          jobId: activeJobId,
          frameId: runtimeFrameId,
          frameUrl: runtimeFrameUrl,
          progress: progress && typeof progress === 'object' ? progress : null,
          contentSessionId
        }, buildFrameMeta({
          source: 'content',
          stage: 'scan_progress',
          requestId: activeJobId || null
        })), () => {});
      }
    }).then((scanResult) => {
      const snapshot = scanResult && scanResult.snapshot ? scanResult.snapshot : null;
      const scanPerf = scanResult && scanResult.scanPerf ? scanResult.scanPerf : null;
      const scanError = scanResult && scanResult.scanError ? scanResult.scanError : null;
      if (scanResult && scanResult.ok && snapshot) {
        lastScanSnapshot = snapshot;
        classificationStale = false;
        applier.setBlocks(activeJobId, snapshot.blocks, snapshot.blockNodes);
      }
      configureDomObserver(Boolean(message && message.classifierObserveDomChanges === true));
      if (message && typeof message.mode === 'string') {
        applier.setDisplayMode(message.mode);
      } else if (Object.prototype.hasOwnProperty.call(message || {}, 'visible')) {
        applier.setVisibility(Boolean(message.visible));
      }
      sendToBackground(wrapOutgoing(protocol.CS_SCAN_RESULT, {
        jobId: activeJobId,
        frameId: runtimeFrameId,
        frameUrl: runtimeFrameUrl,
        blocks: snapshot && Array.isArray(snapshot.blocks) ? snapshot.blocks : [],
        preRanges: snapshot && Array.isArray(snapshot.preRanges) ? snapshot.preRanges : [],
        scanStats: snapshot && snapshot.stats ? snapshot.stats : null,
        scanPerf: scanPerf || null,
        scanError: scanError || null,
        contentSessionId
      }, buildFrameMeta({
        source: 'content',
        stage: 'scan_result',
        requestId: activeJobId || null
      })), () => {});
      sendResponse({
        ok: scanResult && scanResult.ok === true,
        blocks: snapshot && Array.isArray(snapshot.blocks) ? snapshot.blocks.length : 0,
        preRanges: snapshot && Array.isArray(snapshot.preRanges) ? snapshot.preRanges.length : 0,
        compareDiffThreshold,
        compareRendering,
        scanStats: snapshot && snapshot.stats ? snapshot.stats : null,
        scanPerf: scanPerf || null,
        error: scanError || null
      });
    }).catch((error) => {
      const scanError = buildScanError(error);
      sendResponse({
        ok: false,
        compareDiffThreshold,
        compareRendering,
        error: scanError
      });
    });
  }

  function onClassifyBlocks(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({
        ok: true,
        ignored: true,
        reason: 'non_top_frame_runtime',
        frameId: runtimeFrameId
      });
      return;
    }
    configureDomObserver(Boolean(message && message.classifierObserveDomChanges === true));
    if (!classifier) {
      sendResponse({
        ok: false,
        error: {
          code: 'CLASSIFIER_UNAVAILABLE',
          message: 'DomClassifier is unavailable in content runtime'
        }
      });
      return;
    }
    if (!activeJobId || (message && message.jobId && message.jobId !== activeJobId)) {
      sendResponse({
        ok: false,
        error: {
          code: 'JOB_MISMATCH',
          message: 'No active job for classification'
        }
      });
      return;
    }
    const shouldRescan = !lastScanSnapshot
      || !Array.isArray(lastScanSnapshot.blocks)
      || (message && message.force === true)
      || classificationStale === true;
    const continueWithClassify = (snapshot, scanPerf, scanError) => {
      if (!snapshot || !Array.isArray(snapshot.blocks)) {
        sendResponse({
          ok: false,
          error: scanError || {
            code: 'SCAN_REQUIRED',
            message: 'No scan snapshot available for classification'
          }
        });
        return;
      }
      const blocks = Array.isArray(snapshot.blocks) ? snapshot.blocks : [];
      const env = {
        documentLang: global.document && global.document.documentElement
          ? (global.document.documentElement.lang || '')
          : '',
        urlHints: {
          host: global.location && global.location.host ? global.location.host : '',
          pathname: global.location && global.location.pathname ? global.location.pathname : ''
        },
        contentCaps: buildContentCaps()
      };
      const classifyStartedAt = Date.now();
      const classified = classifier.classifyBlocks(blocks, env);
      const classifyPerf = {
        scanTimeMs: scanPerf && Number.isFinite(Number(scanPerf.scanTimeMs))
          ? Math.max(0, Number(scanPerf.scanTimeMs))
          : 0,
        classifyTimeMs: Math.max(0, Date.now() - classifyStartedAt)
      };
      const DomClassifierCtor = NT.DomClassifier || null;
      const domHash = DomClassifierCtor && typeof DomClassifierCtor.computeDomHash === 'function'
        ? DomClassifierCtor.computeDomHash(blocks)
        : `dom:${blocks.length}`;
      sendResponse({
        ok: true,
        blocks,
        byBlockId: classified && classified.byBlockId ? classified.byBlockId : {},
        summary: classified && classified.summary ? classified.summary : {},
        scanStats: snapshot && snapshot.stats ? snapshot.stats : null,
        classifyPerf,
        classifierVersion: DomClassifierCtor && DomClassifierCtor.VERSION
          ? DomClassifierCtor.VERSION
          : 'dom-classifier/unknown',
        domHash,
        classificationStale: Boolean(classificationStale)
      });
    };
    if (!shouldRescan) {
      continueWithClassify(lastScanSnapshot, lastScanSnapshot.scanPerf || null, null);
      return;
    }
    performScan(message, {}).then((scanResult) => {
      if (scanResult && scanResult.ok && scanResult.snapshot) {
        lastScanSnapshot = scanResult.snapshot;
        applier.setBlocks(activeJobId, lastScanSnapshot.blocks, lastScanSnapshot.blockNodes);
        classificationStale = false;
        continueWithClassify(lastScanSnapshot, scanResult.scanPerf || null, null);
        return;
      }
      const scanError = scanResult && scanResult.scanError ? scanResult.scanError : {
        code: 'SCAN_FAILED',
        message: 'Classification scan failed'
      };
      sendResponse({
        ok: false,
        error: scanError,
        scanPerf: scanResult && scanResult.scanPerf ? scanResult.scanPerf : null
      });
    }).catch((error) => {
      sendResponse({
        ok: false,
        error: buildScanError(error)
      });
    });
  }

  function onApplyBatch(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({ ok: true, ignored: true, reason: 'non_top_frame_runtime' });
      return;
    }
    if (!activeJobId || message.jobId !== activeJobId) {
      sendResponse({ ok: false, error: { code: 'JOB_MISMATCH', message: 'No active job for batch' } });
      return;
    }
    const thresholdRerender = applier.displayMode === 'compare';
    const compareDiffThreshold = applyCompareDiffThreshold(message, { rerender: thresholdRerender });
    const compareRendering = applyCompareRendering(message, { rerender: thresholdRerender });
    const result = applier.applyBatch({ jobId: message.jobId, items: message.items || [] });
    sendToBackground(wrapOutgoing(protocol.CS_APPLY_ACK, {
      jobId: message.jobId,
      batchId: message.batchId || null,
      frameId: runtimeFrameId,
      appliedCount: result.appliedCount,
      compareDiffThreshold,
      compareRendering,
      ok: true,
      contentSessionId
    }, buildFrameMeta({
      source: 'content',
      stage: 'apply_ack',
      requestId: message.batchId || null
    })), () => {});
    sendResponse({
      ok: true,
      appliedCount: result.appliedCount,
      compareDiffThreshold,
      compareRendering
    });
  }

  function onApplyDelta(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({ ok: true, ignored: true, reason: 'non_top_frame_runtime' });
      return;
    }
    if (!activeJobId || message.jobId !== activeJobId) {
      sendResponse({ ok: false, error: { code: 'JOB_MISMATCH', message: 'No active job for delta' } });
      return;
    }
    const requestedMode = message && typeof message.mode === 'string' ? message.mode : null;
    const thresholdRerender = !requestedMode && applier.displayMode === 'compare';
    const compareDiffThreshold = applyCompareDiffThreshold(message, { rerender: thresholdRerender });
    const compareRendering = applyCompareRendering(message, { rerender: thresholdRerender });
    if (requestedMode && requestedMode !== applier.displayMode) {
      applier.setDisplayMode(requestedMode);
    }
    const result = applier.applyDelta({
      jobId: message.jobId,
      blockId: message.blockId || message.localBlockId || null,
      text: typeof message.text === 'string' ? message.text : '',
      isFinal: message.isFinal === true
    });
    if (result && result.ignored === true) {
      sendToBackground(wrapOutgoing(protocol.CS_APPLY_DELTA_ACK, {
        jobId: message.jobId,
        blockId: message.blockId || null,
        localBlockId: message.localBlockId || null,
        frameId: runtimeFrameId,
        deltaId: message.deltaId || null,
        applied: false,
        ignored: true,
        isFinal: message.isFinal === true,
        prevTextHash: null,
        nextTextHash: null,
        nodeCountTouched: 0,
        rebindAttempts: Number.isFinite(Number(result && result.rebindAttempts))
          ? Math.max(0, Number(result.rebindAttempts))
          : 0,
        displayMode: applier.displayMode || null,
        compare: null,
        compareDiffThreshold,
        ok: true,
        contentSessionId
      }, buildFrameMeta({
        source: 'content',
        stage: 'apply_delta_ack',
        requestId: message.blockId || null
      })), () => {});
      sendResponse({
        ok: true,
        ignored: true,
        compareDiffThreshold,
        compareRendering,
        rebindAttempts: Number.isFinite(Number(result && result.rebindAttempts))
          ? Math.max(0, Number(result.rebindAttempts))
          : 0
      });
      return;
    }
    sendToBackground(wrapOutgoing(protocol.CS_APPLY_DELTA_ACK, {
      jobId: message.jobId,
      blockId: message.blockId || null,
      localBlockId: message.localBlockId || null,
      frameId: runtimeFrameId,
      deltaId: message.deltaId || null,
      applied: Boolean(result && result.applied),
      isFinal: message.isFinal === true,
      prevTextHash: result && result.prevTextHash ? result.prevTextHash : null,
      nextTextHash: result && result.nextTextHash ? result.nextTextHash : null,
      nodeCountTouched: Number.isFinite(Number(result && result.nodeCountTouched))
        ? Number(result.nodeCountTouched)
        : 0,
      rebindAttempts: Number.isFinite(Number(result && result.rebindAttempts))
        ? Math.max(0, Number(result.rebindAttempts))
        : 0,
      displayMode: result && result.displayMode ? result.displayMode : null,
      compare: result && result.compare ? result.compare : null,
      compareDiffThreshold,
      ok: true,
      contentSessionId
    }, buildFrameMeta({
      source: 'content',
      stage: 'apply_delta_ack',
      requestId: message.blockId || null
    })), () => {});
    sendResponse({
      ok: true,
      applied: Boolean(result && result.applied),
      prevTextHash: result && result.prevTextHash ? result.prevTextHash : null,
      nextTextHash: result && result.nextTextHash ? result.nextTextHash : null,
      nodeCountTouched: Number.isFinite(Number(result && result.nodeCountTouched))
        ? Number(result.nodeCountTouched)
        : 0,
      rebindAttempts: Number.isFinite(Number(result && result.rebindAttempts))
        ? Math.max(0, Number(result.rebindAttempts))
        : 0,
      displayMode: result && result.displayMode ? result.displayMode : null,
      compareDiffThreshold,
      compareRendering,
      compare: result && result.compare ? result.compare : null
    });
  }

  function onCancelJob(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({ ok: true, ignored: true, reason: 'non_top_frame_runtime' });
      return;
    }
    if (message && message.jobId && activeJobId && message.jobId !== activeJobId) {
      sendResponse({ ok: true, ignored: true });
      return;
    }
    applier.restoreOriginals({ jobId: activeJobId });
    activeJobId = null;
    stopDomObserver();
    lastScanSnapshot = null;
    classificationStale = false;
    sendResponse({ ok: true });
  }

  function onSetVisibility(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({ ok: true, ignored: true, reason: 'non_top_frame_runtime' });
      return;
    }
    const compareDiffThreshold = applyCompareDiffThreshold(message, { rerender: true });
    const compareRendering = applyCompareRendering(message, { rerender: true });
    const result = typeof message.mode === 'string'
      ? applier.setDisplayMode(message.mode)
      : applier.setVisibility(Boolean(message.visible));
    sendResponse({
      ok: true,
      visible: result.visible,
      mode: result.mode || (result.visible ? 'translated' : 'original'),
      compareDiffThreshold,
      compareRendering
    });
  }

  function onRestoreOriginals(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({ ok: true, ignored: true, reason: 'non_top_frame_runtime' });
      return;
    }
    const result = applier.restoreOriginals({ jobId: message && message.jobId ? message.jobId : activeJobId });
    sendResponse({ ok: true, restored: result.restored });
  }

  function onEraseJobData(message, sendResponse) {
    if (!isTopFrame) {
      sendResponse({ ok: true, ignored: true, reason: 'non_top_frame_runtime' });
      return;
    }
    const targetJobId = message && message.jobId ? message.jobId : activeJobId;
    applier.restoreOriginals({ jobId: targetJobId });
    if (!message || !message.jobId || message.jobId === activeJobId) {
      activeJobId = null;
    }
    stopDomObserver();
    lastScanSnapshot = null;
    classificationStale = false;
    sendResponse({ ok: true, erased: true });
  }

  if (global.chrome && global.chrome.runtime && global.chrome.runtime.onMessage) {
    global.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const parsed = unwrapIncoming(message);
      const type = parsed && typeof parsed.type === 'string' ? parsed.type : null;
      const msg = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
      const meta = parsed && parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      if (Number.isFinite(Number(meta.frameId))) {
        runtimeFrameId = Number(meta.frameId);
      }
      if (typeof meta.documentId === 'string' && meta.documentId) {
        runtimeDocumentId = meta.documentId;
      }
      if (typeof meta.frameUrl === 'string' && meta.frameUrl) {
        runtimeFrameUrl = meta.frameUrl;
      }
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
      if (type === protocol.BG_CLASSIFY_BLOCKS) {
        onClassifyBlocks(msg, sendResponse);
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

  installRouteChangeHooks();

  const contentCaps = buildContentCaps();
  const toolsetWanted = buildToolsetWanted();
  sendToBackground(wrapOutgoing(protocol.CS_READY, {
    tabId: null,
    contentSessionId,
    url: global.location && global.location.href ? global.location.href : '',
    contentCaps
  }, buildFrameMeta({
    source: 'content',
    stage: 'cs_ready',
    clientCaps: { content: contentCaps },
    toolsetWanted
  })), (response) => {
    updateFrameContextFromResponse(response);
  });
  sendToBackground(wrapOutgoing(protocol.CS_HELLO_CAPS, {
    tabId: null,
    contentSessionId,
    url: global.location && global.location.href ? global.location.href : '',
    contentCaps
  }, buildFrameMeta({
    source: 'content',
    stage: 'cs_hello_caps',
    clientCaps: { content: contentCaps },
    toolsetWanted
  })), (response) => {
    updateFrameContextFromResponse(response);
  });
})(globalThis);
