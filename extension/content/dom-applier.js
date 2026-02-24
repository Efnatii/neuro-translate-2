/**
 * Idempotent DOM translation applier.
 *
 * Supports:
 * - top-frame apply for document/iframe/shadow scanned records
 * - anchor-based rebind on SPA rerender
 * - compare rendering via CSS Highlights API with wrappers fallback
 */
(function initDomApplier(global) {
  const NT = global.NT || (global.NT = {});

  class DomApplier {
    constructor() {
      this.currentJobId = null;
      this.records = {};
      this.displayMode = 'translated';
      this.diffHighlighter = NT.DiffHighlighter ? new NT.DiffHighlighter() : null;
      this.highlightEngine = NT.HighlightEngine ? new NT.HighlightEngine() : null;
      this.compareRendering = 'auto';
      this.compareDiffThresholdChars = 8000;
      this.compareRebuildMinIntervalMs = 1000;
      this.compareHighlightDebounceMs = 900;
      this.maxRebindAttempts = 2;
      this.skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT']);
      this.pendingHighlightTimers = {};
      this.styledDocuments = typeof global.WeakSet === 'function' ? new global.WeakSet() : null;
      this.metrics = {
        highlights: {
          supported: this.highlightEngine ? this.highlightEngine.isSupported() : false,
          mode: 'auto',
          appliedCount: 0,
          fallbackCount: 0
        }
      };
    }

    setBlocks(jobId, blocks, blockNodes) {
      if (!jobId) {
        return;
      }
      this._clearAllHighlightTimers();
      if (this.highlightEngine) {
        this.highlightEngine.clearHighlights();
      }
      this.currentJobId = jobId;
      this.records = {};
      const list = Array.isArray(blocks) ? blocks : [];
      list.forEach((block) => {
        if (!block || !block.blockId) {
          return;
        }
        const node = blockNodes && blockNodes[block.blockId] ? blockNodes[block.blockId] : null;
        if (!node) {
          return;
        }
        const ownerDocument = node.ownerDocument || global.document;
        const originalText = block.originalText || '';
        const hostElement = node && node.parentElement ? node.parentElement : null;
        this._ensureCompareStyles(ownerDocument);
        this.records[block.blockId] = {
          blockId: block.blockId,
          node,
          hostElement,
          ownerDocument,
          originalText,
          translatedText: null,
          currentRenderedText: originalText,
          compareInlineApplied: false,
          compareHtmlCache: null,
          compareCacheKey: null,
          compareStats: null,
          compareBuiltAt: 0,
          highlightBuiltAt: 0,
          rebindAttempts: 0,
          anchor: {
            pathHint: typeof block.pathHint === 'string' ? block.pathHint : null,
            rootHint: typeof block.rootHint === 'string' ? block.rootHint : null,
            nodePath: typeof block.nodePath === 'string' ? block.nodePath : null,
            stableNodeKey: typeof block.stableNodeKey === 'string' ? block.stableNodeKey : null,
            frameId: Number.isFinite(Number(block.frameId)) ? Number(block.frameId) : 0
          }
        };
      });
      this.metrics.highlights.supported = this.highlightEngine ? this.highlightEngine.isSupported() : false;
      this.metrics.highlights.mode = this.compareRendering;
      this._ensureCompareStyles(global.document);
      this._syncHighlightMode();
    }

    applyBatch({ jobId, items }) {
      if (!jobId || !Array.isArray(items) || this.currentJobId !== jobId) {
        return { appliedCount: 0 };
      }
      let appliedCount = 0;
      let nodeCountTouched = 0;
      items.forEach((item) => {
        if (!item || !item.blockId || typeof item.text !== 'string') {
          return;
        }
        const record = this.records[item.blockId];
        if (!record) {
          return;
        }
        const live = this._ensureLiveRecord(record);
        if (!live.ok) {
          return;
        }
        if (record.translatedText === item.text) {
          return;
        }
        record.translatedText = item.text;
        const rendered = this._renderRecord(record, { isFinal: true });
        if (rendered.applied) {
          appliedCount += 1;
        }
        nodeCountTouched += Number(rendered.nodeCountTouched || 0);
      });
      return { appliedCount, nodeCountTouched, displayMode: this.displayMode };
    }

    applyDelta({ jobId, blockId, text, isFinal = false } = {}) {
      if (!jobId || this.currentJobId !== jobId || !blockId || typeof text !== 'string') {
        return { applied: false, ignored: true };
      }
      const record = this.records[blockId];
      if (!record) {
        return { applied: false, ignored: true };
      }
      const live = this._ensureLiveRecord(record);
      if (!live.ok) {
        return {
          applied: false,
          ignored: false,
          errorCode: 'NEEDS_RESCAN_OR_REBIND',
          rebindAttempts: Number.isFinite(Number(live.rebindAttemptsDelta))
            ? Math.max(0, Number(live.rebindAttemptsDelta))
            : 0,
          displayMode: this.displayMode,
          compare: {
            compared: false,
            reason: 'rebind_failed',
            supported: this.highlightEngine ? this.highlightEngine.isSupported() : false,
            mode: this._resolveCompareRenderingMode(),
            fallback: true
          }
        };
      }
      if (record.translatedText === text && !isFinal) {
        return {
          applied: false,
          unchanged: true,
          displayMode: this.displayMode,
          rebindAttempts: Number.isFinite(Number(live.rebindAttemptsDelta))
            ? Math.max(0, Number(live.rebindAttemptsDelta))
            : 0,
          prevTextHash: this._hashTextStable(record.currentRenderedText || ''),
          nextTextHash: this._hashTextStable(record.currentRenderedText || ''),
          nodeCountTouched: 0
        };
      }
      const prevRendered = record.currentRenderedText || this._readCurrentText(record);
      record.translatedText = text;
      const rendered = this._renderRecord(record, { isFinal: Boolean(isFinal) });
      return {
        applied: Boolean(rendered.applied),
        isFinal: Boolean(isFinal),
        displayMode: this.displayMode,
        rebindAttempts: Number.isFinite(Number(live.rebindAttemptsDelta))
          ? Math.max(0, Number(live.rebindAttemptsDelta))
          : 0,
        prevTextHash: this._hashTextStable(prevRendered),
        nextTextHash: this._hashTextStable(record.currentRenderedText || ''),
        nodeCountTouched: Number(rendered.nodeCountTouched || 0),
        compare: rendered.compare || null
      };
    }

    restoreOriginals({ jobId } = {}) {
      if (jobId && this.currentJobId && jobId !== this.currentJobId) {
        return { restored: 0 };
      }
      let restored = 0;
      let nodeCountTouched = 0;
      Object.keys(this.records).forEach((blockId) => {
        const record = this.records[blockId];
        if (!record) {
          return;
        }
        const live = this._ensureLiveRecord(record);
        if (!live.ok) {
          return;
        }
        const before = record.currentRenderedText || this._readCurrentText(record);
        if (before !== record.originalText) {
          this._writePlainText(record, record.originalText);
          record.currentRenderedText = record.originalText;
          this._clearCompareDecorations(record);
          restored += 1;
          nodeCountTouched += 1;
        }
      });
      return { restored, nodeCountTouched, displayMode: this.displayMode };
    }

    setVisibility(visible) {
      return this.setDisplayMode(Boolean(visible) ? 'translated' : 'original');
    }

    setCompareDiffThreshold(value, { rerender = true } = {}) {
      const next = this._normalizeCompareDiffThreshold(value);
      const changed = next !== this.compareDiffThresholdChars;
      this.compareDiffThresholdChars = next;
      if (!changed || !rerender || this.displayMode !== 'compare') {
        return this.compareDiffThresholdChars;
      }
      this._rerenderAllRecords({ forceCompareRebuild: true });
      return this.compareDiffThresholdChars;
    }

    setCompareRendering(value, { rerender = true } = {}) {
      const next = this._normalizeCompareRendering(value);
      const changed = next !== this.compareRendering;
      this.compareRendering = next;
      this.metrics.highlights.mode = next;
      this._syncHighlightMode();
      if (!changed || !rerender || this.displayMode !== 'compare') {
        return this.compareRendering;
      }
      this._rerenderAllRecords({ forceCompareRebuild: true });
      return this.compareRendering;
    }

    setDisplayMode(mode) {
      const nextMode = this._normalizeMode(mode);
      this.displayMode = nextMode;
      this._syncHighlightMode();
      this._rerenderAllRecords({ forceCompareRebuild: true });
      return {
        visible: this.displayMode !== 'original',
        mode: this.displayMode
      };
    }

    _rerenderAllRecords({ forceCompareRebuild = false } = {}) {
      Object.keys(this.records).forEach((blockId) => {
        const record = this.records[blockId];
        if (!record) {
          return;
        }
        const live = this._ensureLiveRecord(record);
        if (!live.ok) {
          return;
        }
        this._renderRecord(record, {
          isFinal: true,
          forceCompareRebuild
        });
      });
    }

    _syncHighlightMode() {
      if (!this.highlightEngine || !this.highlightEngine.isSupported()) {
        return;
      }
      if (this.displayMode !== 'compare') {
        this.highlightEngine.setMode('off');
        return;
      }
      const mode = this._resolveCompareRenderingMode();
      if (mode === 'highlights') {
        this.highlightEngine.setMode('compare');
      } else {
        this.highlightEngine.setMode('off');
      }
    }

    _ensureLiveRecord(record) {
      if (!record) {
        return { ok: false, rebindAttemptsDelta: 0, totalRebindAttempts: 0 };
      }
      if (record.node && record.node.isConnected) {
        return {
          ok: true,
          rebindAttemptsDelta: 0,
          totalRebindAttempts: Number.isFinite(Number(record.rebindAttempts))
            ? Math.max(0, Number(record.rebindAttempts))
            : 0
        };
      }
      if ((record.rebindAttempts || 0) >= this.maxRebindAttempts) {
        return {
          ok: false,
          rebindAttemptsDelta: 0,
          totalRebindAttempts: Number.isFinite(Number(record.rebindAttempts))
            ? Math.max(0, Number(record.rebindAttempts))
            : 0
        };
      }
      record.rebindAttempts = Number(record.rebindAttempts || 0) + 1;
      const rebindAttemptsDelta = 1;
      const rebound = this._rebindNode(record);
      if (!rebound) {
        return {
          ok: false,
          rebindAttemptsDelta,
          totalRebindAttempts: Number.isFinite(Number(record.rebindAttempts))
            ? Math.max(0, Number(record.rebindAttempts))
            : rebindAttemptsDelta
        };
      }
      record.node = rebound.node;
      record.hostElement = rebound.hostElement;
      record.ownerDocument = rebound.ownerDocument || record.ownerDocument;
      return {
        ok: true,
        rebindAttemptsDelta,
        totalRebindAttempts: Number.isFinite(Number(record.rebindAttempts))
          ? Math.max(0, Number(record.rebindAttempts))
          : rebindAttemptsDelta
      };
    }

    _rebindNode(record) {
      if (!record || !record.anchor) {
        return null;
      }
      const anchor = record.anchor;
      const ownerDoc = record.ownerDocument || global.document;
      if (!ownerDoc) {
        return null;
      }
      const root = this._resolveAnchorRoot(ownerDoc, anchor);
      if (!root) {
        return null;
      }
      const byPath = this._nodeFromPath(root, anchor.nodePath);
      if (byPath && byPath.nodeType === 3) {
        return {
          node: byPath,
          hostElement: byPath.parentElement || null,
          ownerDocument: byPath.ownerDocument || ownerDoc
        };
      }
      const pathHint = typeof anchor.pathHint === 'string' ? anchor.pathHint : '';
      if (!pathHint || !ownerDoc.querySelector) {
        return null;
      }
      let host = null;
      try {
        host = ownerDoc.querySelector(pathHint);
      } catch (_) {
        host = null;
      }
      if (!host) {
        return null;
      }
      const fallbackNode = this._firstTextNode(host);
      if (!fallbackNode) {
        return null;
      }
      return {
        node: fallbackNode,
        hostElement: fallbackNode.parentElement || host,
        ownerDocument: fallbackNode.ownerDocument || ownerDoc
      };
    }

    _resolveAnchorRoot(ownerDoc, anchor) {
      const rootHint = typeof anchor.rootHint === 'string' ? anchor.rootHint : '';
      if (rootHint.startsWith('shadow:')) {
        const match = /^shadow:(.+?)@f\d+$/i.exec(rootHint);
        const hostPath = match && match[1] ? match[1] : null;
        if (hostPath && ownerDoc.querySelector) {
          try {
            const host = ownerDoc.querySelector(hostPath);
            if (host && host.shadowRoot) {
              return host.shadowRoot;
            }
          } catch (_) {
            // fallback below
          }
        }
      }
      return ownerDoc.body || ownerDoc.documentElement || null;
    }

    _nodeFromPath(root, nodePath) {
      if (!root || typeof nodePath !== 'string' || !nodePath) {
        return null;
      }
      const parts = nodePath.split('/').map((item) => Number(item));
      let current = root;
      for (let i = 0; i < parts.length; i += 1) {
        const idx = parts[i];
        if (!Number.isFinite(idx) || idx < 0 || !current || !current.childNodes || idx >= current.childNodes.length) {
          return null;
        }
        current = current.childNodes[idx];
      }
      return current || null;
    }

    _firstTextNode(root) {
      if (!root) {
        return null;
      }
      if (root.nodeType === 3) {
        return root;
      }
      const ownerDocument = root.ownerDocument || global.document;
      if (!ownerDocument || typeof ownerDocument.createTreeWalker !== 'function') {
        return null;
      }
      const walker = ownerDocument.createTreeWalker(
        root,
        global.NodeFilter ? global.NodeFilter.SHOW_TEXT : 4
      );
      return walker.nextNode();
    }

    _renderRecord(record, { isFinal = false, forceCompareRebuild = false } = {}) {
      if (!record) {
        return { applied: false, nodeCountTouched: 0 };
      }
      this._ensureCompareStyles(record.ownerDocument || global.document);
      const before = record.currentRenderedText || this._readCurrentText(record);
      if (this.displayMode === 'original') {
        this._writePlainText(record, record.originalText);
        record.currentRenderedText = record.originalText;
        this._clearCompareDecorations(record);
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0
        };
      }

      const translated = typeof record.translatedText === 'string' && record.translatedText
        ? record.translatedText
        : record.originalText;
      if (this.displayMode === 'translated') {
        this._writePlainText(record, translated);
        record.currentRenderedText = translated;
        this._clearCompareDecorations(record);
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0
        };
      }

      const compareMode = this._resolveCompareRenderingMode();
      const isDifferent = translated !== record.originalText;
      const canCompareInline = this.diffHighlighter
        && isDifferent
        && translated.length <= this.compareDiffThresholdChars
        && record.originalText.length <= this.compareDiffThresholdChars;

      if (!canCompareInline) {
        this._writePlainText(record, translated);
        record.currentRenderedText = translated;
        if (isDifferent) {
          this._applyLargeDiffFallback(record, 'diff too large; see debug');
        } else {
          this._clearCompareDecorations(record);
        }
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0,
          compare: {
            compared: false,
            reason: isDifferent ? 'too_large' : 'equal',
            supported: this.highlightEngine ? this.highlightEngine.isSupported() : false,
            mode: compareMode,
            fallback: isDifferent
          }
        };
      }

      if (compareMode === 'highlights' && this.highlightEngine && this.highlightEngine.isSupported()) {
        this._writePlainText(record, translated);
        record.currentRenderedText = translated;
        this._clearWrapperDecorations(record);
        this._setCompareTooltip(record, record.originalText);
        let highlightApplied = false;
        if (isFinal || forceCompareRebuild) {
          highlightApplied = this._applyHighlightsNow(record);
        } else {
          this._scheduleHighlight(record);
        }
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0,
          compare: {
            compared: true,
            reason: highlightApplied ? 'highlights_applied' : 'highlights_debounced',
            supported: true,
            mode: 'highlights',
            highlightApplied,
            fallback: false
          }
        };
      }

      const now = Date.now();
      const compareKey = `${record.originalText}\u0000${translated}`;
      const shouldRebuild = forceCompareRebuild
        || isFinal
        || !record.compareHtmlCache
        || record.compareCacheKey !== compareKey
        || (now - Number(record.compareBuiltAt || 0)) >= this.compareRebuildMinIntervalMs;
      if (shouldRebuild) {
        const built = this.diffHighlighter.buildDiff(record.originalText, translated, {
          maxTokens: 360,
          maxMatrixCells: 220000
        });
        record.compareHtmlCache = built && typeof built.html === 'string' ? built.html : this._escapeHtml(translated);
        record.compareStats = built && built.stats && typeof built.stats === 'object' ? built.stats : null;
        record.compareCacheKey = compareKey;
        record.compareBuiltAt = now;
      }

      if (!this._canUseInnerDiff(record)) {
        this._writePlainText(record, translated);
        record.currentRenderedText = translated;
        this._clearCompareDecorations(record);
        this._setCompareTooltip(record, record.originalText);
        this._applyLargeDiffFallback(record, 'diff for this block is available only in debug');
        this.metrics.highlights.fallbackCount += 1;
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0,
          compare: {
            compared: false,
            reason: 'unsafe_node',
            supported: this.highlightEngine ? this.highlightEngine.isSupported() : false,
            mode: 'wrappers',
            fallback: true,
            stats: record.compareStats
          }
        };
      }

      const host = record.hostElement;
      if (!host) {
        this._writePlainText(record, translated);
        record.currentRenderedText = translated;
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0
        };
      }
      host.classList.add('nt-diff-active');
      host.classList.remove('nt-diff-outline');
      host.removeAttribute('data-nt-diff-note');
      host.innerHTML = record.compareHtmlCache || this._escapeHtml(translated);
      record.node = host.firstChild || record.node;
      record.compareInlineApplied = true;
      record.currentRenderedText = translated;
      this._setCompareTooltip(record, '');
      if (this.highlightEngine) {
        this.highlightEngine.clearHighlights(record.blockId);
      }
      this.metrics.highlights.fallbackCount += 1;
      return {
        applied: true,
        nodeCountTouched: 1,
        compare: {
          compared: true,
          supported: this.highlightEngine ? this.highlightEngine.isSupported() : false,
          mode: 'wrappers',
          highlightApplied: false,
          fallback: true,
          stats: record.compareStats || null
        }
      };
    }

    _applyHighlightsNow(record) {
      if (!record || !this.highlightEngine || !this.highlightEngine.isSupported()) {
        return false;
      }
      this._clearHighlightTimer(record.blockId);
      const result = this.highlightEngine.applyDiffHighlights({
        blockId: record.blockId,
        originalText: record.originalText,
        translatedText: record.currentRenderedText,
        node: record.node
      });
      record.highlightBuiltAt = Date.now();
      if (result && result.applied) {
        this.metrics.highlights.appliedCount += 1;
        return true;
      }
      return false;
    }

    _scheduleHighlight(record) {
      if (!record || !record.blockId) {
        return;
      }
      this._clearHighlightTimer(record.blockId);
      this.pendingHighlightTimers[record.blockId] = global.setTimeout(() => {
        delete this.pendingHighlightTimers[record.blockId];
        if (this.displayMode !== 'compare') {
          return;
        }
        this._applyHighlightsNow(record);
      }, this.compareHighlightDebounceMs);
    }

    _clearHighlightTimer(blockId) {
      if (!blockId || !Object.prototype.hasOwnProperty.call(this.pendingHighlightTimers, blockId)) {
        return;
      }
      global.clearTimeout(this.pendingHighlightTimers[blockId]);
      delete this.pendingHighlightTimers[blockId];
    }

    _clearAllHighlightTimers() {
      Object.keys(this.pendingHighlightTimers).forEach((blockId) => this._clearHighlightTimer(blockId));
    }

    _clearWrapperDecorations(record) {
      const host = record && record.hostElement ? record.hostElement : null;
      if (!host) {
        return;
      }
      host.classList.remove('nt-diff-active');
      host.classList.remove('nt-diff-outline');
      host.removeAttribute('data-nt-diff-note');
      record.compareInlineApplied = false;
    }

    _clearCompareDecorations(record) {
      this._clearHighlightTimer(record && record.blockId ? record.blockId : null);
      if (this.highlightEngine && record && record.blockId) {
        this.highlightEngine.clearHighlights(record.blockId);
      }
      const host = record && record.hostElement ? record.hostElement : null;
      if (!host) {
        return;
      }
      host.classList.remove('nt-diff-active');
      host.classList.remove('nt-diff-outline');
      host.removeAttribute('data-nt-diff-note');
      host.removeAttribute('title');
      record.compareInlineApplied = false;
    }

    _canUseInnerDiff(record) {
      if (!record || !record.hostElement || !record.node) {
        return false;
      }
      const host = record.hostElement;
      if (!host.tagName || this.skipTags.has(String(host.tagName).toUpperCase())) {
        return false;
      }
      if (record.compareInlineApplied === true) {
        return true;
      }
      if (host.childNodes.length !== 1 || !host.firstChild) {
        return false;
      }
      if (host.firstChild.nodeType === 3 && record.node !== host.firstChild) {
        record.node = host.firstChild;
      }
      return host.firstChild === record.node;
    }

    _writePlainText(record, text) {
      if (!record || !record.node) {
        return;
      }
      const host = record.hostElement;
      const value = typeof text === 'string' ? text : '';
      if (
        host
        && (
          host.childNodes.length !== 1
          || host.firstChild !== record.node
          || !record.node
          || record.node.nodeType !== 3
        )
      ) {
        host.textContent = value;
        record.node = host.firstChild || record.node;
      } else if (record.node && typeof record.node.textContent === 'string' && record.node.nodeType !== 3) {
        record.node.textContent = value;
      } else if (record.node && record.node.nodeType === 3) {
        record.node.textContent = value;
      } else if (host) {
        host.textContent = value;
        record.node = host.firstChild || record.node;
      }
    }

    _readCurrentText(record) {
      if (!record || !record.node) {
        return '';
      }
      if (record.node && typeof record.node.textContent === 'string') {
        return record.node.textContent;
      }
      return '';
    }

    _applyLargeDiffFallback(record, note) {
      const host = record && record.hostElement ? record.hostElement : null;
      if (!host) {
        return;
      }
      host.classList.add('nt-diff-active');
      host.classList.add('nt-diff-outline');
      host.setAttribute('data-nt-diff-note', String(note || 'diff'));
    }

    _setCompareTooltip(record, originalText) {
      const host = record && record.hostElement ? record.hostElement : null;
      if (!host) {
        return;
      }
      const source = String(originalText || '').replace(/\s+/g, ' ').trim();
      if (!source) {
        host.removeAttribute('title');
        return;
      }
      const text = source.length > 220 ? `${source.slice(0, 220)}...` : source;
      host.setAttribute('title', `Original: ${text}`);
    }

    _ensureCompareStyles(ownerDocument) {
      const doc = ownerDocument && ownerDocument.head
        ? ownerDocument
        : (global.document && global.document.head ? global.document : null);
      if (!doc || !doc.head) {
        return;
      }
      if (this.styledDocuments && this.styledDocuments.has(doc)) {
        return;
      }
      if (doc.querySelector && doc.querySelector('style[data-nt-style="diff-highlighter"]')) {
        if (this.styledDocuments) {
          this.styledDocuments.add(doc);
        }
        return;
      }
      const style = doc.createElement('style');
      style.setAttribute('data-nt-style', 'diff-highlighter');
      style.textContent = [
        '::highlight(nt-diff) {',
        '  background: rgba(255, 230, 146, 0.58);',
        '  text-decoration: underline;',
        '  text-decoration-color: rgba(160, 85, 0, 0.9);',
        '}',
        '.nt-diff-ins {',
        '  background: #ffe58f;',
        '  color: inherit;',
        '  padding: 0 1px;',
        '  border-radius: 2px;',
        '}',
        '.nt-diff-active.nt-diff-outline {',
        '  outline: 2px solid #f5b041;',
        '  outline-offset: 2px;',
        '}',
        '.nt-diff-active.nt-diff-outline::after {',
        '  content: attr(data-nt-diff-note);',
        '  display: inline-block;',
        '  margin-left: 6px;',
        '  font-size: 11px;',
        '  color: #8a5a00;',
        '}'
      ].join('\n');
      doc.head.appendChild(style);
      if (this.styledDocuments) {
        this.styledDocuments.add(doc);
      }
    }

    _resolveCompareRenderingMode() {
      const pref = this._normalizeCompareRendering(this.compareRendering);
      const supported = this.highlightEngine && this.highlightEngine.isSupported();
      if (pref === 'wrappers') {
        return 'wrappers';
      }
      if (pref === 'highlights') {
        return supported ? 'highlights' : 'wrappers';
      }
      return supported ? 'highlights' : 'wrappers';
    }

    _normalizeMode(mode) {
      if (mode === 'original' || mode === 'translated' || mode === 'compare') {
        return mode;
      }
      return mode === false ? 'original' : 'translated';
    }

    _normalizeCompareDiffThreshold(value) {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return 8000;
      }
      return Math.max(500, Math.min(50000, Math.round(numeric)));
    }

    _normalizeCompareRendering(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'highlights' || raw === 'wrappers' || raw === 'auto') {
        return raw;
      }
      return 'auto';
    }

    _hashTextStable(text) {
      const src = typeof text === 'string' ? text : String(text || '');
      let hash = 2166136261;
      for (let i = 0; i < src.length; i += 1) {
        hash ^= src.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
      }
      return `h${(hash >>> 0).toString(16).padStart(8, '0')}`;
    }

    _escapeHtml(text) {
      return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  }

  NT.DomApplier = DomApplier;
})(globalThis);
