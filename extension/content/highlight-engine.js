/**
 * CSS Custom Highlight API engine for compare mode.
 *
 * Uses word-level diff to map inserted/replaced translated ranges to DOM Ranges
 * without mutating node structure.
 */
(function initHighlightEngine(global) {
  const NT = global.NT || (global.NT = {});

  class HighlightEngine {
    constructor() {
      this.highlightName = 'nt-diff';
      this.mode = 'off';
      this.supported = HighlightEngine.isSupported();
      this.blockRanges = new Map();
      this.knownDocuments = new Set();
    }

    static isSupported() {
      return Boolean(
        global
        && global.CSS
        && global.CSS.highlights
        && typeof global.Highlight === 'function'
      );
    }

    isSupported() {
      return this.supported;
    }

    setMode(mode) {
      const next = mode === 'compare' ? 'compare' : 'off';
      if (next === this.mode) {
        return this.mode;
      }
      this.mode = next;
      if (this.mode !== 'compare') {
        this.clearHighlights();
      }
      return this.mode;
    }

    clearHighlights(blockId) {
      if (!this.supported) {
        return;
      }
      if (typeof blockId === 'string' && blockId) {
        this.blockRanges.delete(blockId);
      } else {
        this.blockRanges.clear();
      }
      this._flushHighlight();
    }

    applyDiffHighlights({ blockId, originalText, translatedText, node } = {}) {
      const key = typeof blockId === 'string' && blockId ? blockId : null;
      if (!this.supported || this.mode !== 'compare' || !key || !node) {
        return { applied: false, reason: 'unsupported_or_off' };
      }
      const source = typeof originalText === 'string' ? originalText : '';
      const target = typeof translatedText === 'string' ? translatedText : '';
      if (!target || source === target) {
        this.blockRanges.delete(key);
        this._flushHighlight();
        return { applied: false, reason: source === target ? 'equal' : 'empty' };
      }

      const charRanges = this._computeChangedCharRanges(source, target);
      if (!charRanges.length) {
        this.blockRanges.delete(key);
        this._flushHighlight();
        return { applied: false, reason: 'no_diff' };
      }

      const domRanges = this._mapCharRangesToDom(node, charRanges);
      if (!domRanges.length) {
        this.blockRanges.delete(key);
        this._flushHighlight();
        return { applied: false, reason: 'range_map_failed' };
      }

      const ownerDocument = node && node.ownerDocument ? node.ownerDocument : global.document;
      this.blockRanges.set(key, {
        ownerDocument,
        ranges: domRanges
      });
      this._flushHighlight();
      return {
        applied: true,
        changedRangeCount: charRanges.length,
        domRangeCount: domRanges.length
      };
    }

    _flushHighlight() {
      if (!this.supported) {
        return;
      }
      this.knownDocuments.forEach((doc) => this._clearHighlightForDocument(doc));
      const groupsByDoc = new Map();
      this.blockRanges.forEach((entry) => {
        const row = entry && typeof entry === 'object' ? entry : {};
        const ranges = Array.isArray(row.ranges) ? row.ranges : [];
        const ownerDocument = row.ownerDocument && typeof row.ownerDocument === 'object'
          ? row.ownerDocument
          : null;
        if (!ownerDocument || !ranges.length) {
          return;
        }
        if (!groupsByDoc.has(ownerDocument)) {
          groupsByDoc.set(ownerDocument, []);
        }
        const bucket = groupsByDoc.get(ownerDocument);
        ranges.forEach((range) => {
          if (!range) {
            return;
          }
          bucket.push(range);
        });
      });
      groupsByDoc.forEach((ranges, doc) => {
        const api = this._getHighlightApi(doc);
        if (!api) {
          return;
        }
        this.knownDocuments.add(doc);
        const highlight = new api.HighlightCtor();
        let count = 0;
        ranges.forEach((range) => {
          if (!range) {
            return;
          }
          try {
            highlight.add(range);
            count += 1;
          } catch (_) {
            // stale/invalid range is ignored
          }
        });
        if (count > 0) {
          api.store.set(this.highlightName, highlight);
        } else {
          api.store.delete(this.highlightName);
        }
      });
    }

    _clearHighlightForDocument(doc) {
      const api = this._getHighlightApi(doc);
      if (!api) {
        return;
      }
      try {
        api.store.delete(this.highlightName);
      } catch (_) {
        // best-effort
      }
    }

    _getHighlightApi(doc) {
      const ownerDocument = doc && typeof doc === 'object' ? doc : global.document;
      if (!ownerDocument) {
        return null;
      }
      const view = ownerDocument.defaultView || global;
      const hasApi = view
        && view.CSS
        && view.CSS.highlights
        && typeof view.Highlight === 'function';
      if (!hasApi) {
        return null;
      }
      return {
        store: view.CSS.highlights,
        HighlightCtor: view.Highlight
      };
    }

    _computeChangedCharRanges(originalText, translatedText) {
      const a = this._tokenize(originalText);
      const b = this._tokenize(translatedText);
      if (!b.length) {
        return [];
      }
      const ops = this._diffOps(a, b);
      if (!ops || !ops.length) {
        return [];
      }
      const ranges = [];
      let cursor = 0;
      for (let i = 0; i < ops.length; i += 1) {
        const op = ops[i];
        if (!op) {
          continue;
        }
        if (op.type === 'equal') {
          cursor += op.text.length;
          continue;
        }
        if (op.type === 'insert') {
          const length = op.text.length;
          if (length > 0) {
            ranges.push([cursor, cursor + length]);
            cursor += length;
          }
        }
      }
      return this._mergeRanges(ranges);
    }

    _tokenize(text) {
      const src = typeof text === 'string' ? text : '';
      if (!src) {
        return [];
      }
      return src
        .split(/(\s+|[.,!?;:()[\]{}"'`<>\\/|+=*^%$#@~_-]+)/g)
        .filter((item) => item !== '');
    }

    _diffOps(a, b) {
      const left = Array.isArray(a) ? a : [];
      const right = Array.isArray(b) ? b : [];
      const n = left.length;
      const m = right.length;
      const width = m + 1;
      const lcs = new Uint16Array((n + 1) * (m + 1));
      const idx = (i, j) => (i * width) + j;

      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          if (left[i] === right[j]) {
            lcs[idx(i, j)] = lcs[idx(i + 1, j + 1)] + 1;
          } else {
            const down = lcs[idx(i + 1, j)];
            const across = lcs[idx(i, j + 1)];
            lcs[idx(i, j)] = down >= across ? down : across;
          }
        }
      }

      const out = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (left[i] === right[j]) {
          out.push({ type: 'equal', text: right[j] });
          i += 1;
          j += 1;
          continue;
        }
        const down = lcs[idx(i + 1, j)];
        const across = lcs[idx(i, j + 1)];
        if (down >= across) {
          out.push({ type: 'delete', text: left[i] });
          i += 1;
        } else {
          out.push({ type: 'insert', text: right[j] });
          j += 1;
        }
      }
      while (i < n) {
        out.push({ type: 'delete', text: left[i] });
        i += 1;
      }
      while (j < m) {
        out.push({ type: 'insert', text: right[j] });
        j += 1;
      }
      return this._collapseOps(out);
    }

    _collapseOps(ops) {
      const source = Array.isArray(ops) ? ops : [];
      const out = [];
      source.forEach((item) => {
        if (!item || !item.type) {
          return;
        }
        const text = typeof item.text === 'string' ? item.text : '';
        if (!text) {
          return;
        }
        const prev = out.length ? out[out.length - 1] : null;
        if (prev && prev.type === item.type) {
          prev.text += text;
        } else {
          out.push({ type: item.type, text });
        }
      });
      return out;
    }

    _mergeRanges(input) {
      const source = Array.isArray(input) ? input.slice() : [];
      source.sort((a, b) => Number(a[0]) - Number(b[0]));
      const out = [];
      source.forEach((pair) => {
        const start = Number(pair && pair[0]);
        const end = Number(pair && pair[1]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
          return;
        }
        const prev = out.length ? out[out.length - 1] : null;
        if (!prev || start > prev[1]) {
          out.push([start, end]);
          return;
        }
        prev[1] = Math.max(prev[1], end);
      });
      return out;
    }

    _mapCharRangesToDom(node, ranges) {
      const textNodes = this._collectTextNodes(node);
      if (!textNodes.length) {
        return [];
      }
      const spans = [];
      let cursor = 0;
      textNodes.forEach((textNode) => {
        const value = typeof textNode.textContent === 'string' ? textNode.textContent : '';
        const length = value.length;
        spans.push({
          node: textNode,
          start: cursor,
          end: cursor + length
        });
        cursor += length;
      });
      if (!cursor) {
        return [];
      }
      const out = [];
      ranges.forEach((pair) => {
        const start = Math.max(0, Math.min(cursor, Number(pair[0])));
        const end = Math.max(0, Math.min(cursor, Number(pair[1])));
        if (end <= start) {
          return;
        }
        const startHit = this._findSpan(spans, start);
        const endHit = this._findSpan(spans, Math.max(start, end - 1));
        if (!startHit || !endHit) {
          return;
        }
        const ownerDocument = startHit.node && startHit.node.ownerDocument
          ? startHit.node.ownerDocument
          : global.document;
        const range = ownerDocument && typeof ownerDocument.createRange === 'function'
          ? ownerDocument.createRange()
          : null;
        if (!range) {
          return;
        }
        try {
          range.setStart(startHit.node, start - startHit.start);
          range.setEnd(endHit.node, end - endHit.start);
          out.push(range);
        } catch (_) {
          // invalid range mapping; skip
        }
      });
      return out;
    }

    _findSpan(spans, offset) {
      for (let i = 0; i < spans.length; i += 1) {
        const span = spans[i];
        if (offset >= span.start && offset < span.end) {
          return span;
        }
      }
      const last = spans.length ? spans[spans.length - 1] : null;
      return last && offset === last.end ? last : null;
    }

    _collectTextNodes(node) {
      if (!node) {
        return [];
      }
      if (node.nodeType === 3) {
        return [node];
      }
      const ownerDoc = node.ownerDocument || global.document;
      if (!ownerDoc || typeof ownerDoc.createTreeWalker !== 'function') {
        return [];
      }
      const out = [];
      const walker = ownerDoc.createTreeWalker(
        node,
        global.NodeFilter ? global.NodeFilter.SHOW_TEXT : 4
      );
      let current = walker.nextNode();
      while (current) {
        out.push(current);
        current = walker.nextNode();
      }
      return out;
    }
  }

  NT.HighlightEngine = HighlightEngine;
})(globalThis);
