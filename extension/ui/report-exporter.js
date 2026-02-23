/**
 * Report exporter for debug snapshot (JSON + static HTML).
 */
(function initReportExporter(global) {
  const NT = global.NT || (global.NT = {});

  class ReportExporter {
    constructor({ doc, win, chromeApi } = {}) {
      this.doc = doc || global.document || null;
      this.win = win || global;
      this.chromeApi = chromeApi || global.chrome || null;
      this.DEFAULT_TOTAL_CHARS = 3 * 1024 * 1024;
    }

    buildReportJson({ snapshot, jobId = null, includeTextMode = 'snippets', limits = {} } = {}) {
      const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
      const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
      const translationJob = src.translationJob && typeof src.translationJob === 'object' ? src.translationJob : null;
      const status = src.status && typeof src.status === 'object' ? src.status : null;
      const agent = src.agentState && typeof src.agentState === 'object' ? src.agentState : null;
      const eventLog = src.eventLog && typeof src.eventLog === 'object'
        ? src.eventLog
        : { seq: 0, items: [] };
      const includeMode = includeTextMode === 'none' || includeTextMode === 'full'
        ? includeTextMode
        : 'snippets';
      const report = {
        meta: this._buildMeta({ src, translationJob, jobId }),
        settings: {
          userSettings: settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : {},
          effectiveSettings: settings.effectiveSettings && typeof settings.effectiveSettings === 'object' ? settings.effectiveSettings : {},
          overrides: settings.overrides && typeof settings.overrides === 'object' ? settings.overrides : {}
        },
        pipeline: {
          stage: agent && agent.phase ? agent.phase : (translationJob && translationJob.agentPhase ? translationJob.agentPhase : 'unknown'),
          status: translationJob && translationJob.status ? translationJob.status : (status && status.status ? status.status : 'idle'),
          progress: Number.isFinite(Number(src.translationProgress)) ? Number(src.translationProgress) : 0,
          counts: {
            totalBlocks: translationJob && Number.isFinite(Number(translationJob.totalBlocks)) ? Number(translationJob.totalBlocks) : 0,
            completedBlocks: translationJob && Number.isFinite(Number(translationJob.completedBlocks)) ? Number(translationJob.completedBlocks) : 0,
            failedBlocks: Number.isFinite(Number(src.failedBlocksCount)) ? Number(src.failedBlocksCount) : 0
          },
          selectedCategories: Array.isArray(src.selectedCategories) ? src.selectedCategories.slice(0, 40) : [],
          availableCategories: Array.isArray(src.availableCategories) ? src.availableCategories.slice(0, 40) : [],
          plan: agent && agent.plan && typeof agent.plan === 'object' ? agent.plan : null,
          blockSummaries: this._applyTextModeToBlockSummaries(
            translationJob && Array.isArray(translationJob.blockSummaries) ? translationJob.blockSummaries : [],
            includeMode
          )
        },
        agent: {
          reports: Array.isArray(agent && agent.reports) ? agent.reports.slice(-200) : [],
          toolExecutionTrace: Array.isArray(agent && agent.toolExecutionTrace) ? agent.toolExecutionTrace.slice(-400) : [],
          patchHistory: this._applyTextModeToPatchHistory(
            Array.isArray(agent && agent.patchHistory) ? agent.patchHistory.slice(-800) : [],
            includeMode
          ),
          patchSummaryByBlock: this._buildPatchSummaryByBlock(agent && Array.isArray(agent.patchHistory) ? agent.patchHistory : []),
          rateLimitHistory: Array.isArray(agent && agent.rateLimitHistory) ? agent.rateLimitHistory.slice(-160) : []
        },
        diffs: {
          recentDiffItems: this._applyTextModeToDiffItems(
            Array.isArray(src.recentDiffItems) ? src.recentDiffItems.slice(-200) : [],
            includeMode
          )
        },
        errors: {
          lastError: src.lastError || (status ? status.lastError || null : null),
          recentErrors: this._extractRecentErrors(eventLog.items || [])
        },
        memory: {
          context: translationJob && translationJob.memoryContext ? translationJob.memoryContext : null,
          restore: translationJob && translationJob.memoryRestore ? translationJob.memoryRestore : null,
          cache: {
            pageEnabled: this._readBoolean(settings, ['effectiveSettings', 'memory', 'pageCacheEnabled'], null),
            apiEnabled: this._readBoolean(settings, ['effectiveSettings', 'memory', 'apiCacheEnabled'], null)
          }
        },
        security: {
          credentials: src.security && src.security.credentials && typeof src.security.credentials === 'object'
            ? src.security.credentials
            : null,
          lastConnectionTest: src.security && src.security.lastConnectionTest && typeof src.security.lastConnectionTest === 'object'
            ? src.security.lastConnectionTest
            : null,
          lastAudit: src.security && src.security.lastAudit && typeof src.security.lastAudit === 'object'
            ? {
              ts: src.security.lastAudit.ts || null,
              dangerousFlags: src.security.lastAudit.dangerousFlags || null,
              recommendations: Array.isArray(src.security.lastAudit.recommendations)
                ? src.security.lastAudit.recommendations.slice(0, 12)
                : []
            }
            : null
        },
        eventLog: {
          seq: Number.isFinite(Number(eventLog.seq)) ? Number(eventLog.seq) : 0,
          items: Array.isArray(eventLog.items) ? eventLog.items.slice(-400) : []
        }
      };

      const redaction = NT.Redaction && typeof NT.Redaction.redactDeep === 'function'
        ? NT.Redaction.redactDeep.bind(NT.Redaction)
        : (NT.redactDeep || ((value) => value));
      let redacted = redaction(report, {});
      redacted = this._compactBySize(redacted, {
        totalChars: Number.isFinite(Number(limits.totalChars))
          ? Math.max(100000, Math.round(Number(limits.totalChars)))
          : this.DEFAULT_TOTAL_CHARS
      });
      return redacted;
    }

    buildReportHtml(reportJson) {
      const report = reportJson && typeof reportJson === 'object' ? reportJson : {};
      const title = `Neuro Translate Debug Report`;
      const esc = (value) => this._escapeHtml(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      const metaRows = this._objectRows(report.meta || {});
      const pipelineRows = this._objectRows(report.pipeline || {});
      const errorsRows = this._objectRows(report.errors || {});
      const memoryRows = this._objectRows(report.memory || {});
      const securityRows = this._objectRows(report.security || {});
      const prettyJson = esc(JSON.stringify(report, null, 2));
      return [
        '<!doctype html>',
        '<html lang="ru">',
        '<head>',
        '<meta charset="utf-8">',
        `<title>${this._escapeHtml(title)}</title>`,
        '<style>',
        'body{font-family:Segoe UI,system-ui,sans-serif;margin:0;padding:20px;background:#fff;color:#000;}',
        'h1,h2{margin:0 0 10px;}',
        '.section{border:1px solid #000;padding:10px;margin-bottom:12px;}',
        'table{width:100%;border-collapse:collapse;font-size:12px;}',
        'th,td{border:1px solid #000;padding:6px;vertical-align:top;word-break:break-word;}',
        'pre{border:1px solid #000;padding:10px;background:#fafafa;white-space:pre-wrap;word-break:break-word;}',
        '</style>',
        '</head>',
        '<body>',
        `<h1>${this._escapeHtml(title)}</h1>`,
        this._tableSection('Meta', metaRows),
        this._tableSection('Pipeline', pipelineRows),
        this._tableSection('Errors', errorsRows),
        this._tableSection('Memory', memoryRows),
        this._tableSection('Security', securityRows),
        '<div class="section"><h2>JSON</h2><pre>',
        prettyJson,
        '</pre></div>',
        '</body>',
        '</html>'
      ].join('');
    }

    download({ filename, mime, contentString } = {}) {
      const name = typeof filename === 'string' && filename ? filename : 'nt-report.txt';
      const type = typeof mime === 'string' && mime ? mime : 'text/plain;charset=utf-8';
      const body = typeof contentString === 'string' ? contentString : '';
      const blob = new Blob([body], { type });
      const objectUrl = URL.createObjectURL(blob);
      try {
        const link = this.doc.createElement('a');
        link.href = objectUrl;
        link.download = name;
        link.style.display = 'none';
        this.doc.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        global.setTimeout(() => {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch (_) {
            // best-effort cleanup
          }
        }, 3000);
      }
    }

    async copyToClipboard(text) {
      const value = typeof text === 'string' ? text : '';
      if (this.win.navigator && this.win.navigator.clipboard && this.win.navigator.clipboard.writeText) {
        try {
          await this.win.navigator.clipboard.writeText(value);
          return true;
        } catch (_) {
          // fallback below
        }
      }
      const textarea = this.doc.createElement('textarea');
      textarea.value = value;
      this.doc.body.appendChild(textarea);
      textarea.select();
      this.doc.execCommand('copy');
      textarea.remove();
      return true;
    }

    _buildMeta({ src, translationJob, jobId }) {
      const manifest = this.chromeApi && this.chromeApi.runtime && typeof this.chromeApi.runtime.getManifest === 'function'
        ? this.chromeApi.runtime.getManifest()
        : null;
      const selectedJobId = jobId || (translationJob && translationJob.id ? translationJob.id : null);
      return {
        extensionVersion: manifest && manifest.version ? manifest.version : null,
        extensionName: manifest && manifest.name ? manifest.name : null,
        build: manifest && manifest.version_name ? manifest.version_name : null,
        generatedAt: Date.now(),
        userAgent: this.win.navigator && this.win.navigator.userAgent ? this.win.navigator.userAgent : null,
        jobId: selectedJobId,
        tabId: translationJob && Number.isFinite(Number(translationJob.tabId)) ? Number(translationJob.tabId) : null,
        normalizedUrl: translationJob && translationJob.memoryContext ? translationJob.memoryContext.normalizedUrl || null : null,
        domHash: translationJob && translationJob.memoryContext ? translationJob.memoryContext.domHash || null : null,
        pageKey: translationJob && translationJob.memoryContext ? translationJob.memoryContext.pageKey || null : null,
        toolsetHash: src.toolset && src.toolset.toolsetHash ? src.toolset.toolsetHash : null
      };
    }

    _buildPatchSummaryByBlock(list) {
      const items = Array.isArray(list) ? list : [];
      const byBlock = {};
      items.forEach((item) => {
        if (!item || !item.blockId) {
          return;
        }
        const key = String(item.blockId);
        if (!byBlock[key]) {
          byBlock[key] = {
            blockId: key,
            count: 0,
            delta: 0,
            final: 0,
            restore: 0,
            toggle: 0,
            lastTs: 0
          };
        }
        const row = byBlock[key];
        row.count += 1;
        if (item.kind === 'final') row.final += 1;
        else if (item.kind === 'restore') row.restore += 1;
        else if (item.kind === 'toggle') row.toggle += 1;
        else row.delta += 1;
        row.lastTs = Math.max(Number(row.lastTs || 0), Number(item.ts || 0));
      });
      return Object.keys(byBlock).map((key) => byBlock[key]).sort((a, b) => b.count - a.count).slice(0, 300);
    }

    _applyTextModeToBlockSummaries(items, includeTextMode) {
      const list = Array.isArray(items) ? items : [];
      return list.map((item) => {
        const row = item && typeof item === 'object' ? { ...item } : {};
        if (includeTextMode === 'none') {
          row.originalSnippet = '';
          row.translatedSnippet = '';
        } else if (includeTextMode === 'snippets') {
          row.originalSnippet = this._clipText(row.originalSnippet, 600);
          row.translatedSnippet = this._clipText(row.translatedSnippet, 600);
        } else {
          row.originalSnippet = this._clipText(row.originalSnippet, 4000);
          row.translatedSnippet = this._clipText(row.translatedSnippet, 4000);
        }
        return row;
      });
    }

    _applyTextModeToPatchHistory(items, includeTextMode) {
      const list = Array.isArray(items) ? items : [];
      return list.map((item) => {
        const row = item && typeof item === 'object' ? { ...item } : {};
        row.prev = row.prev && typeof row.prev === 'object' ? { ...row.prev } : { textHash: null, textPreview: '' };
        row.next = row.next && typeof row.next === 'object' ? { ...row.next } : { textHash: null, textPreview: '' };
        if (includeTextMode === 'none') {
          row.prev.textPreview = '';
          row.next.textPreview = '';
        } else if (includeTextMode === 'snippets') {
          row.prev.textPreview = this._clipText(row.prev.textPreview, 700);
          row.next.textPreview = this._clipText(row.next.textPreview, 700);
        } else {
          row.prev.textPreview = this._clipText(row.prev.textPreview, 5000);
          row.next.textPreview = this._clipText(row.next.textPreview, 5000);
        }
        return row;
      });
    }

    _applyTextModeToDiffItems(items, includeTextMode) {
      const list = Array.isArray(items) ? items : [];
      return list.map((item) => {
        const row = item && typeof item === 'object' ? { ...item } : {};
        if (includeTextMode === 'none') {
          row.before = '';
          row.after = '';
        } else if (includeTextMode === 'snippets') {
          row.before = this._clipText(row.before, 700);
          row.after = this._clipText(row.after, 700);
        } else {
          row.before = this._clipText(row.before, 5000);
          row.after = this._clipText(row.after, 5000);
        }
        return row;
      });
    }

    _extractRecentErrors(items) {
      const list = Array.isArray(items) ? items : [];
      return list
        .filter((item) => item && String(item.level || '').toLowerCase() === 'error')
        .slice(-120)
        .map((item) => ({
          seq: item.seq || null,
          ts: item.ts || null,
          tag: item.tag || null,
          message: item.message || '',
          meta: item.meta && typeof item.meta === 'object' ? item.meta : {}
        }));
    }

    _compactBySize(report, { totalChars }) {
      const limit = Number.isFinite(Number(totalChars))
        ? Math.max(200000, Math.round(Number(totalChars)))
        : this.DEFAULT_TOTAL_CHARS;
      const clone = report && typeof report === 'object'
        ? JSON.parse(JSON.stringify(report))
        : {};
      const note = [];
      const measure = () => JSON.stringify(clone).length;
      const shrink = (path, minKeep = 20) => {
        const arr = this._readPath(clone, path);
        if (!Array.isArray(arr) || arr.length <= minKeep) {
          return false;
        }
        const next = arr.slice(-Math.max(minKeep, Math.floor(arr.length * 0.65)));
        this._writePath(clone, path, next);
        return true;
      };
      const targets = [
        ['agent', 'patchHistory'],
        ['agent', 'toolExecutionTrace'],
        ['agent', 'reports'],
        ['eventLog', 'items'],
        ['pipeline', 'blockSummaries'],
        ['diffs', 'recentDiffItems'],
        ['errors', 'recentErrors']
      ];

      let safety = 0;
      while (measure() > limit && safety < 30) {
        safety += 1;
        let changed = false;
        targets.forEach((path) => {
          changed = shrink(path, 80) || changed;
        });
        if (!changed) {
          break;
        }
      }

      let aggressive = 0;
      while (measure() > limit && aggressive < 20) {
        aggressive += 1;
        let changed = false;
        targets.forEach((path) => {
          changed = shrink(path, 5) || changed;
        });
        if (!changed) {
          break;
        }
      }

      if (measure() > limit) {
        [1500, 900, 500, 260].forEach((maxLen) => {
          if (measure() > limit) {
            this._clipAllStrings(clone, maxLen);
          }
        });
      }

      if (measure() > limit) {
        this._writePath(clone, ['eventLog', 'items'], []);
        this._writePath(clone, ['agent', 'patchHistory'], (this._readPath(clone, ['agent', 'patchHistory']) || []).slice(-40));
        this._writePath(clone, ['pipeline', 'blockSummaries'], (this._readPath(clone, ['pipeline', 'blockSummaries']) || []).slice(-40));
      }

      if (safety > 0 || aggressive > 0) {
        note.push(`compacted_for_limit:${limit}`);
      }
      clone.meta = clone.meta && typeof clone.meta === 'object' ? clone.meta : {};
      clone.meta.compacted = note.length > 0;
      clone.meta.compactionNote = note.join(',') || null;
      clone.meta.totalChars = measure();
      return clone;
    }

    _readPath(obj, path) {
      let cursor = obj;
      for (let i = 0; i < path.length; i += 1) {
        if (!cursor || typeof cursor !== 'object') {
          return null;
        }
        cursor = cursor[path[i]];
      }
      return cursor;
    }

    _writePath(obj, path, value) {
      let cursor = obj;
      for (let i = 0; i < path.length - 1; i += 1) {
        const key = path[i];
        if (!cursor[key] || typeof cursor[key] !== 'object') {
          cursor[key] = {};
        }
        cursor = cursor[key];
      }
      cursor[path[path.length - 1]] = value;
    }

    _clipAllStrings(value, maxLen, depth = 0) {
      if (depth > 24 || value === null || value === undefined) {
        return value;
      }
      if (typeof value === 'string') {
        return value.length <= maxLen ? value : `${value.slice(0, maxLen)}...`;
      }
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i += 1) {
          value[i] = this._clipAllStrings(value[i], maxLen, depth + 1);
        }
        return value;
      }
      if (typeof value === 'object') {
        Object.keys(value).forEach((key) => {
          value[key] = this._clipAllStrings(value[key], maxLen, depth + 1);
        });
      }
      return value;
    }

    _readBoolean(obj, path, fallback) {
      const value = this._readPath(obj, path);
      if (typeof value === 'boolean') {
        return value;
      }
      return fallback;
    }

    _clipText(value, limit) {
      const text = typeof value === 'string' ? value : '';
      const max = Number.isFinite(Number(limit)) ? Math.max(80, Math.round(Number(limit))) : 800;
      if (text.length <= max) {
        return text;
      }
      return `${text.slice(0, max)}...`;
    }

    _objectRows(obj) {
      return Object.keys(obj || {}).map((key) => [key, this._stringifyCell(obj[key])]);
    }

    _stringifyCell(value) {
      if (value === null || value === undefined) {
        return 'null';
      }
      if (typeof value === 'string') {
        return value;
      }
      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }
    }

    _tableSection(title, rows) {
      const body = (Array.isArray(rows) ? rows : [])
        .map(([key, value]) => `<tr><th>${this._escapeHtml(String(key || ''))}</th><td>${this._escapeHtml(String(value || ''))}</td></tr>`)
        .join('');
      return [
        `<div class="section"><h2>${this._escapeHtml(title)}</h2>`,
        '<table><tbody>',
        body || '<tr><th>empty</th><td>—</td></tr>',
        '</tbody></table></div>'
      ].join('');
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

  NT.ReportExporter = ReportExporter;
})(globalThis);
