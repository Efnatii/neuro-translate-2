(function initDebug(global) {
  const NT = global.NT || {};
  const Ui = NT.Ui;
  const UiProtocol = NT.UiProtocol || {};
  const I18n = NT.UiI18nRu || null;

  if (!Ui || !I18n || !NT.UiProtocolClient) {
    return;
  }

  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function mergeDeep(target, patch) {
    const dst = target && typeof target === 'object' ? target : {};
    const src = patch && typeof patch === 'object' ? patch : {};
    Object.keys(src).forEach((key) => {
      const value = src[key];
      if (value === undefined) {
        return;
      }
      if (Array.isArray(value)) {
        dst[key] = value.slice();
        return;
      }
      if (value && typeof value === 'object') {
        const base = dst[key] && typeof dst[key] === 'object' && !Array.isArray(dst[key])
          ? dst[key]
          : {};
        dst[key] = mergeDeep(base, value);
        return;
      }
      dst[key] = value;
    });
    return dst;
  }

  function applyPatch(snapshot, patchPayload) {
    const dst = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const patch = patchPayload && typeof patchPayload === 'object' ? patchPayload : {};
    if (patch.patch && typeof patch.patch === 'object') {
      mergeDeep(dst, patch.patch);
    }
    Object.keys(patch).forEach((key) => {
      if (key === 'patch' || key === 'changedKeys' || key === 'eventLogAppend' || key === 'eventLogReset') {
        return;
      }
      const value = patch[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const base = dst[key] && typeof dst[key] === 'object' && !Array.isArray(dst[key])
          ? dst[key]
          : {};
        dst[key] = mergeDeep(base, value);
      } else if (Array.isArray(value)) {
        dst[key] = value.slice();
      } else {
        dst[key] = value;
      }
    });
    return dst;
  }

  function safeString(value, fallback = '') {
    if (value === null || value === undefined) {
      return fallback;
    }
    return String(value);
  }

  function shortText(value, limit = 220) {
    const text = safeString(value, '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return '';
    }
    return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}...`;
  }

  function formatTs(value) {
    const ts = Number(value);
    if (!Number.isFinite(ts) || ts <= 0) {
      return '-';
    }
    try {
      return new Date(ts).toLocaleString();
    } catch (_) {
      return '-';
    }
  }

  function normalizeRoute(route) {
    const key = safeString(route || '', '').replace(/^#/, '').trim().toLowerCase();
    const allowed = ['overview', 'plan', 'tools', 'diff-patches', 'categories', 'memory', 'ratelimits', 'perf', 'security', 'export'];
    return allowed.includes(key) ? key : 'overview';
  }

  function resolveInitialRoute(locationLike) {
    const hashRoute = normalizeRoute(locationLike && locationLike.hash ? locationLike.hash : '');
    if (hashRoute !== 'overview') {
      return hashRoute;
    }
    try {
      const params = new URLSearchParams(locationLike && locationLike.search ? locationLike.search : '');
      return normalizeRoute(params.get('section') || 'overview');
    } catch (_) {
      return hashRoute;
    }
  }

  class DebugApp {
    constructor(doc) {
      this.doc = doc;
      this.root = this.doc.getElementById('debugRoot');
      this.fields = {};

      this.client = null;
      this.scheduler = new Ui.RenderScheduler();
      this.toasts = null;
      this.exporter = NT.ReportExporter
        ? new NT.ReportExporter({ doc: this.doc, win: global, chromeApi: global.chrome })
        : null;

      this.snapshot = {};
      this.uiStatus = {
        state: 'connecting',
        message: I18n.t('common.loading', 'Загрузка...')
      };

      this.route = 'overview';
      this.selectedToolIndex = -1;
      this.selectedPatchIndex = -1;
      this.selectedDiffKey = '';
      this.categoryDraft = new Set();
      this.exportStatus = '-';
      this.lastSecurityAudit = null;

      this.filters = {
        toolsName: 'all',
        toolsStatus: 'all',
        toolsSearch: '',
        patchBlock: '',
        patchKind: 'all',
        patchPhase: '',
        diffCategory: '',
        diffStatus: ''
      };
    }

    init(initialTabId) {
      this._cacheElements();
      this._bind();
      this.toasts = new Ui.Toasts(this.fields.toastHost);

      this.client = new NT.UiProtocolClient({ channelName: 'debug' });
      this.client
        .onStatus((status) => {
          this.uiStatus = status || this.uiStatus;
          this._scheduleRender();
        })
        .onSnapshot((payload) => {
          this.snapshot = cloneJson(payload, {}) || {};
          this._scheduleRender();
        })
        .onPatch((patch) => {
          this.snapshot = applyPatch(this.snapshot, patch);
          this._scheduleRender();
        });

      this.client.setHelloContext({ tabId: initialTabId });
      this.client.connect();

      this.route = resolveInitialRoute(global.location);
      this._scheduleRender();
    }

    _cacheElements() {
      this.fields.headerJob = this.doc.querySelector('[data-field="header-job"]');
      this.fields.headerState = this.doc.querySelector('[data-field="header-state"]');
      this.fields.headerRuntime = this.doc.querySelector('[data-field="header-runtime"]');

      this.fields.overviewKv = this.doc.querySelector('[data-field="overview-kv"]');
      this.fields.planHint = this.doc.querySelector('[data-field="plan-hint"]');
      this.fields.planCategories = this.doc.querySelector('[data-field="plan-categories"]');
      this.fields.planMapping = this.doc.querySelector('[data-field="plan-mapping"]');

      this.fields.toolsFilterName = this.doc.querySelector('[data-field="tools-filter-name"]');
      this.fields.toolsFilterStatus = this.doc.querySelector('[data-field="tools-filter-status"]');
      this.fields.toolsFilterSearch = this.doc.querySelector('[data-field="tools-filter-search"]');
      this.fields.toolsTable = this.doc.querySelector('[data-field="tools-table"]');
      this.fields.toolsDetails = this.doc.querySelector('[data-field="tools-details"]');

      this.fields.diffFilterCategory = this.doc.querySelector('[data-field="diff-filter-category"]');
      this.fields.diffFilterStatus = this.doc.querySelector('[data-field="diff-filter-status"]');
      this.fields.diffBlocks = this.doc.querySelector('[data-field="diff-blocks"]');
      this.fields.diffOriginal = this.doc.querySelector('[data-field="diff-original"]');
      this.fields.diffTranslated = this.doc.querySelector('[data-field="diff-translated"]');
      this.fields.diffMeta = this.doc.querySelector('[data-field="diff-meta"]');

      this.fields.patchFilterBlock = this.doc.querySelector('[data-field="patch-filter-block"]');
      this.fields.patchFilterKind = this.doc.querySelector('[data-field="patch-filter-kind"]');
      this.fields.patchFilterPhase = this.doc.querySelector('[data-field="patch-filter-phase"]');
      this.fields.patchTable = this.doc.querySelector('[data-field="patch-table"]');
      this.fields.patchDetails = this.doc.querySelector('[data-field="patch-details"]');

      this.fields.categoriesHint = this.doc.querySelector('[data-field="categories-hint"]');
      this.fields.categoriesList = this.doc.querySelector('[data-field="categories-list"]');

      this.fields.memoryKv = this.doc.querySelector('[data-field="memory-kv"]');
      this.fields.ratelimitsKv = this.doc.querySelector('[data-field="ratelimits-kv"]');
      this.fields.ratelimitsList = this.doc.querySelector('[data-field="ratelimits-list"]');
      this.fields.perfKv = this.doc.querySelector('[data-field="perf-kv"]');
      this.fields.perfTop = this.doc.querySelector('[data-field="perf-top"]');

      this.fields.securitySummary = this.doc.querySelector('[data-field="security-summary"]');
      this.fields.securityJson = this.doc.querySelector('[data-field="security-json"]');

      this.fields.exportTextMode = this.doc.querySelector('[data-field="export-text-mode"]');
      this.fields.exportStatus = this.doc.querySelector('[data-field="export-status"]');

      this.fields.toastHost = this.doc.querySelector('[data-field="toast-host"]');
    }

    _bind() {
      global.addEventListener('hashchange', () => {
        this.route = normalizeRoute(global.location.hash);
        this._scheduleRender();
      });

      this.root.addEventListener('click', (event) => {
        const trigger = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-action]')
          : null;
        if (!trigger) {
          return;
        }
        const action = trigger.getAttribute('data-action');
        if (!action) {
          return;
        }
        this._handleAction(action).catch((error) => this._showError(error));
      });

      this.root.addEventListener('input', () => {
        this.filters.toolsSearch = safeString(this.fields.toolsFilterSearch && this.fields.toolsFilterSearch.value, '').trim().toLowerCase();
        this.filters.patchBlock = safeString(this.fields.patchFilterBlock && this.fields.patchFilterBlock.value, '').trim().toLowerCase();
        this.filters.patchPhase = safeString(this.fields.patchFilterPhase && this.fields.patchFilterPhase.value, '').trim().toLowerCase();
        this.filters.diffCategory = safeString(this.fields.diffFilterCategory && this.fields.diffFilterCategory.value, '').trim().toLowerCase();
        this.filters.diffStatus = safeString(this.fields.diffFilterStatus && this.fields.diffFilterStatus.value, '').trim().toLowerCase();
        this._scheduleRender();
      });

      this.root.addEventListener('change', () => {
        this.filters.toolsName = safeString(this.fields.toolsFilterName && this.fields.toolsFilterName.value, 'all');
        this.filters.toolsStatus = safeString(this.fields.toolsFilterStatus && this.fields.toolsFilterStatus.value, 'all');
        this.filters.patchKind = safeString(this.fields.patchFilterKind && this.fields.patchFilterKind.value, 'all');
        this._scheduleRender();
      });

      this.root.addEventListener('click', (event) => {
        const toolRow = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-tool-index]')
          : null;
        if (toolRow) {
          this.selectedToolIndex = Number(toolRow.getAttribute('data-tool-index'));
          this._scheduleRender();
          return;
        }

        const patchRow = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-patch-index]')
          : null;
        if (patchRow) {
          this.selectedPatchIndex = Number(patchRow.getAttribute('data-patch-index'));
          this._scheduleRender();
          return;
        }

        const diffItem = event && event.target && typeof event.target.closest === 'function'
          ? event.target.closest('[data-diff-key]')
          : null;
        if (diffItem) {
          this.selectedDiffKey = safeString(diffItem.getAttribute('data-diff-key'), '');
          this._scheduleRender();
          return;
        }
      });
    }

    async _handleAction(action) {
      if (action === 'kick-scheduler') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.KICK_SCHEDULER : 'KICK_SCHEDULER', {});
        this.toasts.show('Планировщик запрошен.', { tone: 'ok' });
        return;
      }
      if (action === 'cancel-job') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CANCEL_TRANSLATION : 'CANCEL_TRANSLATION', {
          tabId: this._tabId()
        });
        return;
      }
      if (action === 'erase-job') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CLEAR_TRANSLATION_DATA : 'CLEAR_TRANSLATION_DATA', {
          tabId: this._tabId(),
          includeCache: true
        });
        return;
      }
      if (action === 'reclassify') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.RECLASSIFY_BLOCKS : 'RECLASSIFY_BLOCKS', {
          tabId: this._tabId(),
          jobId: this._jobId(),
          force: true
        });
        return;
      }
      if (action === 'repair-all') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.BG_REPAIR_ALL : 'BG_REPAIR_ALL', {});
        return;
      }
      if (action === 'apply-categories') {
        await this._applyCategories();
        return;
      }
      if (action === 'erase-memory-page') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.ERASE_TRANSLATION_MEMORY : 'ERASE_TRANSLATION_MEMORY', {
          tabId: this._tabId(),
          scope: 'page'
        });
        return;
      }
      if (action === 'erase-memory-all') {
        const ok = global.confirm ? global.confirm('Стереть всю память перевода?') : true;
        if (!ok) {
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.ERASE_TRANSLATION_MEMORY : 'ERASE_TRANSLATION_MEMORY', {
          tabId: this._tabId(),
          scope: 'all'
        });
        return;
      }
      if (action === 'run-security-audit') {
        const result = await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.RUN_SECURITY_AUDIT : 'RUN_SECURITY_AUDIT', {});
        if (result && result.report) {
          this.lastSecurityAudit = result.report;
        }
        this._scheduleRender();
        return;
      }
      if (action === 'block-literal' || action === 'block-style' || action === 'block-proofread') {
        const actionMap = {
          'block-literal': 'literal',
          'block-style': 'style_improve',
          'block-proofread': 'proofread'
        };
        const blockId = this.selectedDiffKey || null;
        if (!blockId) {
          this.toasts.show('Сначала выберите блок.', { tone: 'warn' });
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.REQUEST_BLOCK_ACTION : 'REQUEST_BLOCK_ACTION', {
          tabId: this._tabId(),
          jobId: this._jobId(),
          blockId,
          action: actionMap[action]
        });
        return;
      }
      if (action === 'copy-tools-50') {
        const traces = this._toolTrace().slice(-50);
        await this._copyText(JSON.stringify(traces, null, 2));
        this.toasts.show(I18n.t('common.copyDone', 'Скопировано в буфер'), { tone: 'ok' });
        return;
      }
      if (action === 'copy-diagnostics') {
        await this._copyDiagnostics();
        return;
      }
      if (action === 'export-json') {
        await this._downloadReport('json');
        return;
      }
      if (action === 'export-html') {
        await this._downloadReport('html');
        return;
      }
    }

    async _sendCommand(type, payload = {}, options = {}) {
      if (!this.client) {
        throw new Error('UI client not initialized');
      }
      const result = await this.client.sendCommand(type, payload, options);
      if (!result || result.ok !== false) {
        return result;
      }
      throw new Error(result.error && result.error.message ? result.error.message : I18n.t('common.errorUnknown', 'Неизвестная ошибка'));
    }

    async _copyDiagnostics() {
      let diagnostics = null;
      try {
        diagnostics = await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.BG_BUILD_DIAGNOSTICS : 'BG_BUILD_DIAGNOSTICS', {
          tabId: this._tabId(),
          jobId: this._jobId(),
          includeTextMode: safeString(this.fields.exportTextMode && this.fields.exportTextMode.value, 'snippets')
        }, { timeoutMs: 6500, retries: 1 });
      } catch (_) {
        diagnostics = {
          ok: true,
          fallback: true,
          tabId: this._tabId(),
          job: this.snapshot.translationJob || null,
          settings: this.snapshot.settings || null,
          security: this.snapshot.security || null,
          toolTraceLast50: this._toolTrace().slice(-50),
          patchHistoryLast50: this._patchHistory().slice(-50),
          lastError: this.snapshot.lastError || null
        };
      }
      await this._copyText(JSON.stringify(diagnostics, null, 2));
      this.toasts.show(I18n.t('common.copyDone', 'Скопировано в буфер'), { tone: 'ok' });
    }

    async _downloadReport(kind) {
      const mode = safeString(this.fields.exportTextMode && this.fields.exportTextMode.value, 'snippets');
      const snapshot = this._buildExportSnapshot();
      const reportJson = this.exporter && typeof this.exporter.buildReportJson === 'function'
        ? this.exporter.buildReportJson({ snapshot, jobId: this._jobId(), includeTextMode: mode })
        : cloneJson(snapshot, {});

      if (kind === 'html') {
        const html = this.exporter && typeof this.exporter.buildReportHtml === 'function'
          ? this.exporter.buildReportHtml(reportJson)
          : `<pre>${Ui.escapeHtml(JSON.stringify(reportJson, null, 2))}</pre>`;
        this._downloadFile(`nt-report-${Date.now()}.html`, html, 'text/html;charset=utf-8');
      } else {
        this._downloadFile(`nt-report-${Date.now()}.json`, JSON.stringify(reportJson, null, 2), 'application/json;charset=utf-8');
      }

      this.exportStatus = `Экспорт готов: ${kind}`;
      this._scheduleRender();
    }

    _downloadFile(filename, content, mime) {
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const link = this.doc.createElement('a');
      link.href = url;
      link.download = filename;
      this.doc.body.appendChild(link);
      link.click();
      link.remove();
      global.setTimeout(() => URL.revokeObjectURL(url), 2500);
    }

    async _copyText(text) {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        try {
          await global.navigator.clipboard.writeText(text);
          return;
        } catch (_) {
          // fallback below
        }
      }
      const area = this.doc.createElement('textarea');
      area.value = text;
      this.doc.body.appendChild(area);
      area.select();
      this.doc.execCommand('copy');
      area.remove();
    }

    async _applyCategories() {
      const categories = Array.from(this.categoryDraft.values()).filter(Boolean);
      if (!categories.length) {
        this.toasts.show('Выберите минимум одну категорию.', { tone: 'warn' });
        return;
      }
      await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_TRANSLATION_CATEGORIES : 'SET_TRANSLATION_CATEGORIES', {
        tabId: this._tabId(),
        jobId: this._jobId(),
        categories,
        mode: 'replace'
      });
      this.toasts.show('Категории применены.', { tone: 'ok' });
    }

    _scheduleRender() {
      this.scheduler.queueRender(() => this._render());
    }

    _render() {
      this._syncRoute();
      this._renderNav();
      this._renderHeader();

      if (this.route === 'overview') {
        this._renderOverview();
      }
      if (this.route === 'plan') {
        this._renderPlan();
      }
      if (this.route === 'tools') {
        this._renderTools();
      }
      if (this.route === 'diff-patches') {
        this._renderDiffPatches();
      }
      if (this.route === 'categories') {
        this._renderCategories();
      }
      if (this.route === 'memory') {
        this._renderMemory();
      }
      if (this.route === 'ratelimits') {
        this._renderRateLimits();
      }
      if (this.route === 'perf') {
        this._renderPerf();
      }
      if (this.route === 'security') {
        this._renderSecurity();
      }
      if (this.route === 'export') {
        this._renderExport();
      }
    }

    _syncRoute() {
      const expected = normalizeRoute(global.location.hash);
      if (expected !== this.route) {
        this.route = expected;
      }
      const panels = this.root.querySelectorAll('[data-route]');
      panels.forEach((panel) => {
        const name = panel.getAttribute('data-route');
        panel.hidden = name !== this.route;
      });
    }

    _renderNav() {
      const links = this.root.querySelectorAll('[data-route-link]');
      links.forEach((link) => {
        const name = link.getAttribute('data-route-link');
        if (name === this.route) {
          link.classList.add('is-active');
        } else {
          link.classList.remove('is-active');
        }
      });
    }

    _renderHeader() {
      const job = this.snapshot.translationJob && typeof this.snapshot.translationJob === 'object'
        ? this.snapshot.translationJob
        : null;
      const scheduler = this.snapshot.serverCaps
        && this.snapshot.serverCaps.schedulerRuntime
        && typeof this.snapshot.serverCaps.schedulerRuntime === 'object'
        ? this.snapshot.serverCaps.schedulerRuntime
        : {};
      const offscreen = this.snapshot.serverCaps && this.snapshot.serverCaps.offscreen && typeof this.snapshot.serverCaps.offscreen === 'object'
        ? this.snapshot.serverCaps.offscreen
        : {};

      const tabId = this._tabId();
      const jobId = job && job.id ? job.id : '-';
      Ui.setText(this.fields.headerJob, `tab: ${tabId === null ? '-' : tabId} | job: ${jobId}`);
      Ui.setText(this.fields.headerState, `status: ${safeString(job && job.status, '-')} | stage: ${safeString(job && job.runtime && job.runtime.stage, '-')}`);
      Ui.setText(
        this.fields.headerRuntime,
        `lease: ${formatTs(job && job.runtime && job.runtime.leaseUntilTs)} | retry: ${formatTs(job && job.runtime && job.runtime.nextRetryAtTs)} | offscreen: ${safeString(offscreen.connected, '-')} | activeRequests: ${Array.isArray(scheduler.activeJobs) ? scheduler.activeJobs.length : 0}`
      );
    }

    _renderOverview() {
      const job = this.snapshot.translationJob && typeof this.snapshot.translationJob === 'object' ? this.snapshot.translationJob : {};
      const progress = this.snapshot && Number.isFinite(Number(this.snapshot.translationProgress))
        ? Number(this.snapshot.translationProgress)
        : 0;
      const failed = Number.isFinite(Number(this.snapshot.failedBlocksCount)) ? Number(this.snapshot.failedBlocksCount) : 0;
      const runtime = job.runtime && typeof job.runtime === 'object' ? job.runtime : {};

      const rows = [
        ['tabId', this._tabId()],
        ['jobId', safeString(job.id, '-')],
        ['url', safeString(this._url(), '-')],
        ['domHash', safeString(this.snapshot.domHash || job.domHash, '-')],
        ['stage', safeString(runtime.stage || job.status, '-')],
        ['status', safeString(job.status, '-')],
        ['leaseUntil', formatTs(runtime.leaseUntilTs)],
        ['nextRetryAt', formatTs(runtime.nextRetryAtTs)],
        ['attempt', Number.isFinite(Number(runtime.attempt)) ? Number(runtime.attempt) : 0],
        ['progress', `${progress}%`],
        ['failed', failed],
        ['activeRequests', this._activeRequestsCount()]
      ];
      this._renderKv(this.fields.overviewKv, rows);
    }

    _renderPlan() {
      const agent = this._agentState();
      const taxonomy = agent.taxonomy && typeof agent.taxonomy === 'object' ? agent.taxonomy : null;
      const pipeline = agent.pipeline && typeof agent.pipeline === 'object' ? agent.pipeline : null;
      const categories = taxonomy && Array.isArray(taxonomy.categories) ? taxonomy.categories : [];

      if (!taxonomy || !pipeline || !categories.length) {
        Ui.setText(this.fields.planHint, I18n.t('debug.planNotReady', 'План еще не построен для текущей задачи.'));
        Ui.clearNode(this.fields.planCategories);
        Ui.setText(this.fields.planMapping, '');
        return;
      }

      Ui.setText(this.fields.planHint, `taxonomy: ${categories.length} категорий`);
      Ui.clearNode(this.fields.planCategories);
      categories.slice(0, 200).forEach((row) => {
        const item = row && typeof row === 'object' ? row : {};
        const tr = this.doc.createElement('tr');
        [
          safeString(item.id, '-'),
          safeString(item.titleRu, '-'),
          String(item.defaultTranslate === true),
          Number.isFinite(Number(item.countUnits)) ? Number(item.countUnits) : '-',
          shortText(item.routingSummary || (pipeline.routing && pipeline.routing[item.id]) || '-', 42),
          shortText(item.batchingSummary || (pipeline.batching && pipeline.batching[item.id]) || '-', 42),
          shortText(item.contextSummary || (pipeline.context && pipeline.context[item.id]) || '-', 42),
          shortText(item.qcSummary || (pipeline.qc && pipeline.qc[item.id]) || '-', 42)
        ].forEach((text) => {
          const td = this.doc.createElement('td');
          td.textContent = String(text);
          tr.appendChild(td);
        });
        this.fields.planCategories.appendChild(tr);
      });

      const mapping = agent.mappingSummary && typeof agent.mappingSummary === 'object' ? agent.mappingSummary : null;
      if (mapping && Object.keys(mapping).length) {
        const pieces = Object.keys(mapping).slice(0, 30).map((key) => {
          const src = mapping[key] && typeof mapping[key] === 'object' ? mapping[key] : {};
          return `${key}: block=${Number(src.block || 0)} range=${Number(src.range || 0)}`;
        });
        Ui.setText(this.fields.planMapping, pieces.join(' | '));
      } else {
        Ui.setText(this.fields.planMapping, 'mapping summary: нет данных');
      }
    }

    _renderTools() {
      const traces = this._toolTrace();
      const names = ['all'].concat(Array.from(new Set(traces.map((row) => safeString(row.toolName || row.tool, '')).filter(Boolean))).sort());
      const currentName = this.filters.toolsName || 'all';
      if (this.fields.toolsFilterName) {
        Ui.clearNode(this.fields.toolsFilterName);
        names.forEach((name) => {
          const option = Ui.createElement('option', {
            text: name === 'all' ? 'tool: all' : name,
            attrs: { value: name }
          });
          if (name === currentName) {
            option.selected = true;
          }
          this.fields.toolsFilterName.appendChild(option);
        });
      }

      const filtered = traces.filter((row) => {
        const toolName = safeString(row.toolName || row.tool, '').toLowerCase();
        const status = safeString(row.status, '').toLowerCase();
        const args = shortText(JSON.stringify(row.args || row.meta && row.meta.args || ''), 200).toLowerCase();
        const result = shortText(JSON.stringify(row.result || row.output || row.meta && row.meta.output || ''), 200).toLowerCase();
        if (this.filters.toolsName && this.filters.toolsName !== 'all' && this.filters.toolsName !== toolName) {
          return false;
        }
        if (this.filters.toolsStatus && this.filters.toolsStatus !== 'all' && this.filters.toolsStatus !== status) {
          return false;
        }
        if (this.filters.toolsSearch) {
          const hay = `${toolName} ${status} ${args} ${result}`;
          if (hay.indexOf(this.filters.toolsSearch) < 0) {
            return false;
          }
        }
        return true;
      });

      Ui.clearNode(this.fields.toolsTable);
      filtered.slice(-1000).forEach((row, index) => {
        const tr = this.doc.createElement('tr');
        tr.className = 'debug__clickable-row';
        tr.setAttribute('data-tool-index', String(index));
        if (index === this.selectedToolIndex) {
          tr.classList.add('is-selected');
        }
        const argsPreview = shortText(JSON.stringify(row.args || row.meta && row.meta.args || ''), 80);
        const resultPreview = shortText(JSON.stringify(row.result || row.output || row.meta && row.meta.output || ''), 80);
        [
          formatTs(row.ts),
          safeString(row.toolName || row.tool, '-'),
          safeString(row.status, '-'),
          argsPreview || '-',
          resultPreview || '-'
        ].forEach((text) => {
          const td = this.doc.createElement('td');
          td.textContent = String(text);
          tr.appendChild(td);
        });
        this.fields.toolsTable.appendChild(tr);
      });

      const selected = filtered[this.selectedToolIndex] || null;
      if (!selected) {
        Ui.setText(this.fields.toolsDetails, 'Выберите строку для деталей');
      } else {
        Ui.setText(this.fields.toolsDetails, JSON.stringify(selected, null, 2));
      }
    }

    _renderDiffPatches() {
      const diffItems = this._diffItems();
      const filteredDiff = diffItems.filter((item) => {
        const category = safeString(item.category || item.categoryId, '').toLowerCase();
        const status = safeString(item.status || item.qualityTag, '').toLowerCase();
        if (this.filters.diffCategory && category.indexOf(this.filters.diffCategory) < 0) {
          return false;
        }
        if (this.filters.diffStatus && status.indexOf(this.filters.diffStatus) < 0) {
          return false;
        }
        return true;
      });

      Ui.clearNode(this.fields.diffBlocks);
      filteredDiff.slice(-800).forEach((item) => {
        const key = safeString(item.blockId || item.id, '');
        const row = Ui.createElement('div', {
          className: `debug__list-item${this.selectedDiffKey === key ? ' is-selected' : ''}`,
          attrs: { 'data-diff-key': key },
          text: `${key || '-'} | ${safeString(item.category || item.categoryId, '-')} | ${safeString(item.qualityTag || item.status, '-')} | len ${safeString((item.originalText || '').length, '0')}/${safeString((item.translatedText || '').length, '0')}`
        });
        this.fields.diffBlocks.appendChild(row);
      });

      const selected = filteredDiff.find((item) => safeString(item.blockId || item.id, '') === this.selectedDiffKey) || null;
      Ui.setText(this.fields.diffOriginal, selected ? safeString(selected.originalText, '-') : '-');
      Ui.setText(this.fields.diffTranslated, selected ? safeString(selected.translatedText, '-') : '-');
      Ui.setText(this.fields.diffMeta, selected
        ? `modelUsed: ${safeString(selected.modelUsed, '-')} | routeUsed: ${safeString(selected.routeUsed, '-')} | updatedAt: ${formatTs(selected.updatedAt || selected.ts)}`
        : 'modelUsed: - | routeUsed: - | updatedAt: -');

      const patches = this._patchHistory().filter((patch) => {
        const block = safeString(patch.blockId || patch.id, '').toLowerCase();
        const kind = safeString(patch.kind || patch.type, '').toLowerCase();
        const phase = safeString(patch.phase, '').toLowerCase();
        if (this.filters.patchBlock && block.indexOf(this.filters.patchBlock) < 0) {
          return false;
        }
        if (this.filters.patchKind && this.filters.patchKind !== 'all' && kind !== this.filters.patchKind) {
          return false;
        }
        if (this.filters.patchPhase && phase.indexOf(this.filters.patchPhase) < 0) {
          return false;
        }
        return true;
      });

      Ui.clearNode(this.fields.patchTable);
      patches.slice(-1500).forEach((patch, index) => {
        const tr = this.doc.createElement('tr');
        tr.className = 'debug__clickable-row';
        tr.setAttribute('data-patch-index', String(index));
        if (index === this.selectedPatchIndex) {
          tr.classList.add('is-selected');
        }
        [
          safeString(patch.seq, '-'),
          formatTs(patch.ts),
          safeString(patch.kind || patch.type, '-'),
          safeString(patch.blockId, '-'),
          `${safeString(patch.prevHash, '-')}` + ' -> ' + `${safeString(patch.nextHash, '-')}`,
          shortText(patch.preview || patch.text || '', 80)
        ].forEach((text) => {
          const td = this.doc.createElement('td');
          td.textContent = String(text);
          tr.appendChild(td);
        });
        this.fields.patchTable.appendChild(tr);
      });

      const selectedPatch = patches[this.selectedPatchIndex] || null;
      Ui.setText(this.fields.patchDetails, selectedPatch ? JSON.stringify(selectedPatch, null, 2) : 'Выберите патч для деталей');
    }

    _renderCategories() {
      const job = this.snapshot.translationJob && typeof this.snapshot.translationJob === 'object' ? this.snapshot.translationJob : {};
      const stage = safeString(job.status || job.runtime && job.runtime.stage, '').toLowerCase();
      if (stage !== 'awaiting_categories') {
        Ui.setText(this.fields.categoriesHint, I18n.t('debug.categoriesHidden', 'Категории показываются только при awaiting_categories.'));
        Ui.clearNode(this.fields.categoriesList);
        this.categoryDraft.clear();
        return;
      }

      const categories = this._categoriesFromJob(job);
      if (!this.categoryDraft.size) {
        categories.forEach((item) => {
          if (item.selected) {
            this.categoryDraft.add(item.id);
          }
        });
      }

      Ui.setText(this.fields.categoriesHint, categories.question || 'Выберите категории и примените выбор.');
      Ui.clearNode(this.fields.categoriesList);
      categories.items.forEach((item) => {
        const row = Ui.createElement('label', { className: 'debug__list-item' });
        const input = Ui.createElement('input', {
          attrs: {
            type: 'checkbox',
            'data-debug-category': item.id
          }
        });
        input.checked = this.categoryDraft.has(item.id);
        input.disabled = item.disabled === true;
        input.addEventListener('change', () => {
          if (input.checked) {
            this.categoryDraft.add(item.id);
          } else {
            this.categoryDraft.delete(item.id);
          }
        });
        row.appendChild(input);
        row.appendChild(this.doc.createTextNode(` ${item.title} (${item.mode}) [${item.count}]`));
        this.fields.categoriesList.appendChild(row);
      });
    }

    _renderMemory() {
      const settings = this.snapshot.settings && typeof this.snapshot.settings === 'object' ? this.snapshot.settings : {};
      const job = this.snapshot.translationJob && typeof this.snapshot.translationJob === 'object' ? this.snapshot.translationJob : {};
      const memoryRestore = job.memoryRestore && typeof job.memoryRestore === 'object' ? job.memoryRestore : {};
      this._renderKv(this.fields.memoryKv, [
        ['enabled', settings.translationMemoryEnabled === false ? 'false' : 'true'],
        ['pageKey', safeString(memoryRestore.pageKey, '-')],
        ['restoredAt', formatTs(memoryRestore.ts)],
        ['hits', Number(memoryRestore.hits || 0)]
      ]);
    }

    _renderRateLimits() {
      const limits = this.snapshot.modelLimitsBySpec && typeof this.snapshot.modelLimitsBySpec === 'object' ? this.snapshot.modelLimitsBySpec : {};
      const keys = Object.keys(limits).sort();
      this._renderKv(this.fields.ratelimitsKv, [
        ['models', keys.length],
        ['connection', safeString(this.uiStatus.state, '-')]
      ]);

      Ui.clearNode(this.fields.ratelimitsList);
      keys.slice(0, 80).forEach((spec) => {
        const row = limits[spec] && typeof limits[spec] === 'object' ? limits[spec] : {};
        const remainingReq = row.remainingRequests === null || row.remainingRequests === undefined ? '-' : String(row.remainingRequests);
        const remainingTok = row.remainingTokens === null || row.remainingTokens === undefined ? '-' : String(row.remainingTokens);
        const warn = Number.isFinite(Number(row.remainingRequests)) && Number(row.remainingRequests) <= 2;
        const item = Ui.createElement('div', {
          className: 'debug__list-item',
          text: `${spec} | req:${remainingReq} tok:${remainingTok} | cooldown:${formatTs(row.cooldownUntilTs)}`
        });
        if (warn) {
          item.style.color = 'var(--danger)';
        }
        this.fields.ratelimitsList.appendChild(item);
      });
    }

    _renderPerf() {
      const perf = this.snapshot.perfSnapshot && typeof this.snapshot.perfSnapshot === 'object' ? this.snapshot.perfSnapshot : {};
      const jobPerf = perf.jobs && Array.isArray(perf.jobs) ? perf.jobs : [];
      this._renderKv(this.fields.perfKv, [
        ['scanMs', Number(perf.scanMs || 0)],
        ['classifyMs', Number(perf.classifyMs || 0)],
        ['avgDeltaLatency', Number(perf.avgDeltaLatency || 0)],
        ['rebindAttempts', Number(perf.rebindAttempts || 0)],
        ['storageEstimate', Number(perf.storageEstimate || 0)]
      ]);
      Ui.clearNode(this.fields.perfTop);
      jobPerf.slice(0, 30).forEach((row) => {
        this.fields.perfTop.appendChild(Ui.createElement('div', {
          className: 'debug__list-item',
          text: `${safeString(row.jobId, '-')} | score:${Number(row.score || 0)} | scan:${Number(row.scanMs || 0)} | classify:${Number(row.classifyMs || 0)}`
        }));
      });
    }

    _renderSecurity() {
      const security = this.snapshot.security && typeof this.snapshot.security === 'object' ? this.snapshot.security : {};
      Ui.setText(this.fields.securitySummary, `credentials: ${shortText(JSON.stringify(security.credentials || {}), 220)}`);
      const payload = this.lastSecurityAudit || security.lastAudit || {};
      Ui.setText(this.fields.securityJson, JSON.stringify(payload, null, 2));
    }

    _renderExport() {
      Ui.setText(this.fields.exportStatus, this.exportStatus || '-');
    }

    _renderKv(root, rows) {
      Ui.clearNode(root);
      rows.forEach((row) => {
        const key = safeString(row[0], '-');
        const value = row[1] === null || row[1] === undefined ? '-' : String(row[1]);
        const line = Ui.createElement('div', { className: 'debug__kv-row' });
        line.appendChild(Ui.createElement('div', { className: 'debug__kv-key', text: key }));
        line.appendChild(Ui.createElement('div', { className: 'debug__kv-value', text: value }));
        root.appendChild(line);
      });
    }

    _tabId() {
      const direct = Number(this.snapshot && this.snapshot.tabId);
      return Number.isFinite(direct) ? direct : null;
    }

    _jobId() {
      const job = this.snapshot.translationJob && typeof this.snapshot.translationJob === 'object' ? this.snapshot.translationJob : null;
      return job && typeof job.id === 'string' ? job.id : null;
    }

    _url() {
      const map = this.snapshot.translationStatusByTab && typeof this.snapshot.translationStatusByTab === 'object'
        ? this.snapshot.translationStatusByTab
        : {};
      const tabId = this._tabId();
      const row = Number.isFinite(Number(tabId)) ? map[tabId] : null;
      return row && typeof row.url === 'string' ? row.url : '';
    }

    _agentState() {
      return this.snapshot.agentState && typeof this.snapshot.agentState === 'object' ? this.snapshot.agentState : {};
    }

    _toolTrace() {
      const agent = this._agentState();
      return Array.isArray(agent.toolExecutionTrace)
        ? agent.toolExecutionTrace.slice()
        : (Array.isArray(agent.toolHistory) ? agent.toolHistory.slice() : []);
    }

    _patchHistory() {
      const agent = this._agentState();
      return Array.isArray(agent.patchHistory) ? agent.patchHistory.slice() : [];
    }

    _diffItems() {
      const fromSnapshot = Array.isArray(this.snapshot.recentDiffItems) ? this.snapshot.recentDiffItems.slice() : [];
      if (fromSnapshot.length) {
        return fromSnapshot;
      }
      const patches = this._patchHistory();
      const out = [];
      patches.forEach((patch) => {
        if (!patch || !patch.blockId) {
          return;
        }
        if (out.some((row) => row && row.blockId === patch.blockId)) {
          return;
        }
        out.push({
          blockId: patch.blockId,
          originalText: patch.originalText || '',
          translatedText: patch.text || patch.translatedText || '',
          category: patch.category || '',
          qualityTag: patch.qualityTag || '',
          modelUsed: patch.modelUsed || '',
          routeUsed: patch.routeUsed || '',
          updatedAt: patch.ts || null,
          status: patch.kind || patch.type || ''
        });
      });
      return out;
    }

    _categoriesFromJob(job) {
      const safe = job && typeof job === 'object' ? job : {};
      const agent = this._agentState();
      const question = safe.categoryQuestion && typeof safe.categoryQuestion === 'object'
        ? safe.categoryQuestion
        : (agent.userQuestion && typeof agent.userQuestion === 'object' ? agent.userQuestion : null);
      const rec = safe.categoryRecommendations && typeof safe.categoryRecommendations === 'object'
        ? safe.categoryRecommendations
        : (agent.categoryRecommendations && typeof agent.categoryRecommendations === 'object' ? agent.categoryRecommendations : {});
      const selected = new Set((Array.isArray(safe.selectedCategories) ? safe.selectedCategories : []).map((id) => safeString(id, '').toLowerCase()));
      const recommended = new Set((Array.isArray(rec.recommended) ? rec.recommended : []).map((id) => safeString(id, '').toLowerCase()));
      const optional = new Set((Array.isArray(rec.optional) ? rec.optional : []).map((id) => safeString(id, '').toLowerCase()));
      const excluded = new Set((Array.isArray(rec.excluded) ? rec.excluded : []).map((id) => safeString(id, '').toLowerCase()));

      const items = [];
      if (question && Array.isArray(question.options)) {
        question.options.forEach((option) => {
          const id = safeString(option && option.id, '').toLowerCase();
          if (!id) {
            return;
          }
          const mode = excluded.has(id) ? 'excluded' : (recommended.has(id) ? 'recommended' : (optional.has(id) ? 'optional' : 'optional'));
          items.push({
            id,
            title: safeString(option && option.titleRu, id),
            mode,
            disabled: mode === 'excluded',
            selected: selected.size ? selected.has(id) : mode === 'recommended',
            count: Number(option && option.countUnits || 0)
          });
        });
      }
      return {
        question: question && question.questionRu ? question.questionRu : '',
        items
      };
    }

    _activeRequestsCount() {
      const scheduler = this.snapshot.serverCaps && this.snapshot.serverCaps.schedulerRuntime && typeof this.snapshot.serverCaps.schedulerRuntime === 'object'
        ? this.snapshot.serverCaps.schedulerRuntime
        : {};
      const jobs = Array.isArray(scheduler.activeJobs) ? scheduler.activeJobs : [];
      return jobs.length;
    }

    _buildExportSnapshot() {
      return {
        tabId: this._tabId(),
        settings: this.snapshot.settings || null,
        translationJob: this.snapshot.translationJob || null,
        translationProgress: this.snapshot.translationProgress || 0,
        failedBlocksCount: this.snapshot.failedBlocksCount || 0,
        lastError: this.snapshot.lastError || null,
        recentDiffItems: this._diffItems(),
        agentState: this._agentState(),
        modelLimitsBySpec: this.snapshot.modelLimitsBySpec || {},
        security: this.snapshot.security || null,
        perfSnapshot: this.snapshot.perfSnapshot || null
      };
    }

    _showError(error) {
      const message = error && error.message ? error.message : I18n.t('common.errorUnknown', 'Неизвестная ошибка');
      this.toasts.show(shortText(message, 200), { tone: 'danger' });
    }
  }

  function resolveInitialTabId() {
    try {
      const params = new URLSearchParams(global.location.search || '');
      const value = Number(params.get('tabId'));
      if (Number.isFinite(value)) {
        return value;
      }
    } catch (_) {
      // ignore
    }
    return null;
  }

  (() => {
    const app = new DebugApp(global.document);
    app.init(resolveInitialTabId());
  })();
})(globalThis);
