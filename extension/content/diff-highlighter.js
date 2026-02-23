/**
 * Lightweight word-level diff highlighter with safe HTML output.
 */
(function initDiffHighlighter(global) {
  const NT = global.NT || (global.NT = {});

  class DiffHighlighter {
    constructor() {
      this.DEFAULT_MAX_TOKENS = 360;
      this.DEFAULT_MAX_MATRIX_CELLS = 220000;
    }

    buildDiff(originalText, translatedText, opts = {}) {
      const source = typeof originalText === 'string' ? originalText : '';
      const target = typeof translatedText === 'string' ? translatedText : '';
      const maxTokens = Number.isFinite(Number(opts.maxTokens))
        ? Math.max(40, Math.round(Number(opts.maxTokens)))
        : this.DEFAULT_MAX_TOKENS;
      const maxMatrixCells = Number.isFinite(Number(opts.maxMatrixCells))
        ? Math.max(6000, Math.round(Number(opts.maxMatrixCells)))
        : this.DEFAULT_MAX_MATRIX_CELLS;
      const sourceTokens = this._tokenize(source);
      const targetTokens = this._tokenize(target);

      if (
        sourceTokens.length > maxTokens
        || targetTokens.length > maxTokens
        || (sourceTokens.length * targetTokens.length) > maxMatrixCells
      ) {
        return {
          html: this._escapeHtml(target),
          stats: {
            compared: false,
            fallback: 'too_large',
            originalLength: source.length,
            translatedLength: target.length,
            tokenCount: { original: sourceTokens.length, translated: targetTokens.length },
            insertions: 0,
            replacements: 0,
            deletions: 0
          }
        };
      }

      const ops = this._diffTokens(sourceTokens, targetTokens);
      if (!ops) {
        return {
          html: this._escapeHtml(target),
          stats: {
            compared: false,
            fallback: 'diff_failed',
            originalLength: source.length,
            translatedLength: target.length,
            tokenCount: { original: sourceTokens.length, translated: targetTokens.length },
            insertions: 0,
            replacements: 0,
            deletions: 0
          }
        };
      }

      const { html, stats } = this._renderOps(ops, {
        originalLength: source.length,
        translatedLength: target.length,
        tokenCount: { original: sourceTokens.length, translated: targetTokens.length }
      });
      return { html, stats };
    }

    _tokenize(text) {
      const src = typeof text === 'string' ? text : '';
      if (!src) {
        return [];
      }
      const parts = src.split(/(\s+|[.,!?;:()[\]{}"'`<>\\/|+=*^%$#@~_-]+)/g);
      return parts.filter((item) => item !== '');
    }

    _diffTokens(a, b) {
      const n = a.length;
      const m = b.length;
      const width = m + 1;
      const lcs = new Uint16Array((n + 1) * (m + 1));
      const idx = (i, j) => (i * width) + j;

      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          if (a[i] === b[j]) {
            lcs[idx(i, j)] = lcs[idx(i + 1, j + 1)] + 1;
          } else {
            const down = lcs[idx(i + 1, j)];
            const right = lcs[idx(i, j + 1)];
            lcs[idx(i, j)] = down >= right ? down : right;
          }
        }
      }

      const ops = [];
      let i = 0;
      let j = 0;
      while (i < n && j < m) {
        if (a[i] === b[j]) {
          ops.push({ type: 'equal', token: a[i] });
          i += 1;
          j += 1;
          continue;
        }
        const down = lcs[idx(i + 1, j)];
        const right = lcs[idx(i, j + 1)];
        if (down >= right) {
          ops.push({ type: 'delete', token: a[i] });
          i += 1;
        } else {
          ops.push({ type: 'insert', token: b[j] });
          j += 1;
        }
      }
      while (i < n) {
        ops.push({ type: 'delete', token: a[i] });
        i += 1;
      }
      while (j < m) {
        ops.push({ type: 'insert', token: b[j] });
        j += 1;
      }
      return this._collapseOps(ops);
    }

    _collapseOps(ops) {
      const source = Array.isArray(ops) ? ops : [];
      const out = [];
      source.forEach((item) => {
        if (!item || !item.type) {
          return;
        }
        const token = typeof item.token === 'string' ? item.token : '';
        const prev = out.length ? out[out.length - 1] : null;
        if (prev && prev.type === item.type) {
          prev.tokens.push(token);
        } else {
          out.push({ type: item.type, tokens: [token] });
        }
      });
      return out;
    }

    _renderOps(ops, extraStats = {}) {
      const chunks = [];
      const stats = {
        compared: true,
        fallback: null,
        originalLength: Number(extraStats.originalLength || 0),
        translatedLength: Number(extraStats.translatedLength || 0),
        tokenCount: extraStats.tokenCount || { original: 0, translated: 0 },
        insertions: 0,
        replacements: 0,
        deletions: 0
      };

      for (let i = 0; i < ops.length; i += 1) {
        const current = ops[i];
        if (!current) {
          continue;
        }
        if (current.type === 'equal') {
          chunks.push(this._escapeHtml(current.tokens.join('')));
          continue;
        }
        if (current.type === 'delete') {
          const next = ops[i + 1];
          const removedText = current.tokens.join('');
          if (next && next.type === 'insert') {
            const insertedText = next.tokens.join('');
            chunks.push(this._wrapInsert(insertedText, removedText));
            stats.replacements += 1;
            i += 1;
          } else {
            stats.deletions += 1;
          }
          continue;
        }
        if (current.type === 'insert') {
          const insertedText = current.tokens.join('');
          chunks.push(this._wrapInsert(insertedText, ''));
          stats.insertions += 1;
        }
      }

      return {
        html: chunks.join(''),
        stats
      };
    }

    _wrapInsert(text, replacedOriginal) {
      const safeText = this._escapeHtml(text);
      const original = typeof replacedOriginal === 'string' ? replacedOriginal : '';
      const safeOriginal = this._escapeAttr(this._trimForTooltip(original));
      if (safeOriginal) {
        return `<mark class="nt-diff-ins" data-nt-orig="${safeOriginal}" title="Оригинал: ${safeOriginal}">${safeText}</mark>`;
      }
      return `<mark class="nt-diff-ins">${safeText}</mark>`;
    }

    _trimForTooltip(value) {
      const text = String(value || '').replace(/\s+/g, ' ').trim();
      if (text.length <= 220) {
        return text;
      }
      return `${text.slice(0, 220)}...`;
    }

    _escapeHtml(text) {
      return String(text || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    _escapeAttr(text) {
      return this._escapeHtml(text).replace(/`/g, '&#96;');
    }
  }

  NT.DiffHighlighter = DiffHighlighter;
})(globalThis);
