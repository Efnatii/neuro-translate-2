/**
 * Idempotent DOM translation applier.
 */
(function initDomApplier(global) {
  const NT = global.NT || (global.NT = {});

  class DomApplier {
    constructor() {
      this.currentJobId = null;
      this.records = {};
      this.displayMode = 'translated';
      this.diffHighlighter = NT.DiffHighlighter ? new NT.DiffHighlighter() : null;
      this.compareDiffThresholdChars = 8000;
      this.compareRebuildMinIntervalMs = 1000;
      this.skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT']);
      this._styleInjected = false;
    }

    setBlocks(jobId, blocks, blockNodes) {
      if (!jobId) {
        return;
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
        const originalText = block.originalText || '';
        const hostElement = node && node.parentElement ? node.parentElement : null;
        this.records[block.blockId] = {
          node,
          hostElement,
          originalText,
          translatedText: null,
          currentRenderedText: originalText,
          compareInlineApplied: false,
          compareHtmlCache: null,
          compareCacheKey: null,
          compareStats: null,
          compareBuiltAt: 0
        };
      });
      this._ensureCompareStyles();
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
        if (!record || !record.node) {
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
      if (!record || !record.node) {
        return { applied: false, ignored: true };
      }
      if (record.translatedText === text && !isFinal) {
        return {
          applied: false,
          unchanged: true,
          displayMode: this.displayMode,
          prevTextHash: this._hashTextStable(record.currentRenderedText || ''),
          nextTextHash: this._hashTextStable(record.currentRenderedText || ''),
          nodeCountTouched: 0
        };
      }
      const prevRendered = record.currentRenderedText || '';
      record.translatedText = text;
      const rendered = this._renderRecord(record, { isFinal: Boolean(isFinal) });
      return {
        applied: Boolean(rendered.applied),
        isFinal: Boolean(isFinal),
        displayMode: this.displayMode,
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
        if (!record || !record.node) {
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
      Object.keys(this.records).forEach((blockId) => {
        const record = this.records[blockId];
        if (!record || !record.node) {
          return;
        }
        this._renderRecord(record, {
          isFinal: true,
          forceCompareRebuild: true
        });
      });
      return this.compareDiffThresholdChars;
    }

    setDisplayMode(mode) {
      const nextMode = this._normalizeMode(mode);
      this.displayMode = nextMode;
      Object.keys(this.records).forEach((blockId) => {
        const record = this.records[blockId];
        if (!record || !record.node) {
          return;
        }
        this._renderRecord(record, {
          isFinal: true,
          forceCompareRebuild: true
        });
      });
      return {
        visible: this.displayMode !== 'original',
        mode: this.displayMode
      };
    }

    _renderRecord(record, { isFinal = false, forceCompareRebuild = false } = {}) {
      if (!record || !record.node) {
        return { applied: false, nodeCountTouched: 0 };
      }
      const before = record.currentRenderedText || this._readCurrentText(record);
      if (this.displayMode === 'original') {
        this._writePlainText(record, record.originalText);
        record.currentRenderedText = record.originalText;
        record.compareInlineApplied = false;
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
        record.compareInlineApplied = false;
        this._clearCompareDecorations(record);
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0
        };
      }

      const canCompare = this.diffHighlighter
        && translated !== record.originalText
        && translated.length <= this.compareDiffThresholdChars
        && record.originalText.length <= this.compareDiffThresholdChars;
      if (!canCompare) {
        this._writePlainText(record, translated);
        record.currentRenderedText = translated;
        record.compareInlineApplied = false;
        if (translated !== record.originalText) {
          this._applyLargeDiffFallback(record, 'diff слишком большой, смотри debug');
        } else {
          this._clearCompareDecorations(record);
        }
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0,
          compare: {
            compared: false,
            reason: translated === record.originalText ? 'equal' : 'too_large'
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
        record.compareInlineApplied = false;
        this._setCompareTooltip(record, record.originalText);
        this._applyLargeDiffFallback(record, 'diff для этого блока доступен только в debug');
        return {
          applied: before !== record.currentRenderedText,
          nodeCountTouched: before !== record.currentRenderedText ? 1 : 0,
          compare: {
            compared: false,
            reason: 'unsafe_node',
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
      return {
        applied: true,
        nodeCountTouched: 1,
        compare: {
          compared: true,
          stats: record.compareStats || null
        }
      };
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
      host.setAttribute('title', `Оригинал: ${text}`);
    }

    _clearCompareDecorations(record) {
      const host = record && record.hostElement ? record.hostElement : null;
      if (!host) {
        return;
      }
      host.classList.remove('nt-diff-active');
      host.classList.remove('nt-diff-outline');
      host.removeAttribute('data-nt-diff-note');
      host.removeAttribute('title');
    }

    _ensureCompareStyles() {
      if (this._styleInjected || !global.document || !global.document.head) {
        return;
      }
      const style = global.document.createElement('style');
      style.setAttribute('data-nt-style', 'diff-highlighter');
      style.textContent = [
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
      global.document.head.appendChild(style);
      this._styleInjected = true;
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
