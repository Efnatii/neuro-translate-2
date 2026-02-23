/**
 * Debug page controller for live diagnostics stream.
 *
 * State is hydrated from snapshot/patch messages via `UiModule`; no direct
 * storage access is used in this controller. Event log updates are incremental:
 * append deltas, reset notifications, and explicit older-page requests.
 *
 * Rendering keeps rows compact and wrapped to avoid horizontal scrolling while
 * preserving full message/meta visibility.
 *
 * The page also renders compact per-model rate-limit state from snapshot/patch
 * (`modelLimitsBySpec`) to explain cooldown/reservation waits in real time.
 */
(function initDebugPage(global) {
  class DetailsStateManager {
    constructor({ doc, storageKeyPrefix }) {
      this.doc = doc;
      this.storageKeyPrefix = typeof storageKeyPrefix === 'string' && storageKeyPrefix
        ? storageKeyPrefix
        : 'nt.ui.details';
    }

    init() {
      if (!this.doc || typeof this.doc.querySelectorAll !== 'function') {
        return;
      }
      const detailsList = Array.from(this.doc.querySelectorAll('details[data-section]'));
      detailsList.forEach((details) => {
        if (!details) {
          return;
        }
        const sectionId = details.getAttribute('data-section');
        if (!sectionId) {
          return;
        }
        const key = `${this.storageKeyPrefix}.${sectionId}`;
        try {
          const saved = global.localStorage ? global.localStorage.getItem(key) : null;
          if (saved === '0') {
            details.open = false;
          } else if (saved === '1') {
            details.open = true;
          }
        } catch (_) {
          // best-effort only
        }
        details.addEventListener('toggle', () => {
          try {
            if (global.localStorage) {
              global.localStorage.setItem(key, details.open ? '1' : '0');
            }
          } catch (_) {
            // best-effort only
          }
        });
      });
    }
  }

  class DebugPage {
    constructor({ doc, ui }) {
      this.doc = doc;
      this.ui = ui;
      this.state = {
        tabId: null,
        url: '',
        origin: '',
        status: null,
        benchmarkStatus: null,
        benchmarks: {},
        modelLimitsBySpec: {},
        translationJob: null,
        translationProgress: 0,
        failedBlocksCount: 0,
        lastError: null,
        agentState: null,
        selectedCategories: [],
        recentDiffItems: [],
        eventLog: { seq: 0, items: [] },
        filters: { level: 'all', q: '', tag: 'all' },
        oldestSeq: null
      };
      this.fields = {};
      this.pendingLoadOlderRequestId = null;
      this.renderTimer = null;
    }

    init() {
      this.cacheElements();
      this.bindEventControls();
      new DetailsStateManager({ doc: this.doc, storageKeyPrefix: 'nt.ui.debug.details' }).init();
      this.state = { ...this.state, ...this.readQuery() };
      this.render();
    }

    cacheElements() {
      this.fields.site = this.doc.querySelector('[data-field="site"]');
      this.fields.progress = this.doc.querySelector('[data-field="progress"]');
      this.fields.completed = this.doc.querySelector('[data-field="completed"]');
      this.fields.total = this.doc.querySelector('[data-field="total"]');
      this.fields.inProgress = this.doc.querySelector('[data-field="inProgress"]');
      this.fields.message = this.doc.querySelector('[data-field="message"]');
      this.fields.decisionPolicy = this.doc.querySelector('[data-field="decision-policy"]');
      this.fields.decisionModel = this.doc.querySelector('[data-field="decision-model"]');
      this.fields.decisionReason = this.doc.querySelector('[data-field="decision-reason"]');
      this.fields.translationJobId = this.doc.querySelector('[data-field="translation-job-id"]');
      this.fields.translationJobStatus = this.doc.querySelector('[data-field="translation-job-status"]');
      this.fields.translationProgress = this.doc.querySelector('[data-field="translation-progress"]');
      this.fields.translationFailedCount = this.doc.querySelector('[data-field="translation-failed-count"]');
      this.fields.translationLastError = this.doc.querySelector('[data-field="translation-last-error"]');
      this.fields.agentPhase = this.doc.querySelector('[data-field="agent-phase"]');
      this.fields.agentProfile = this.doc.querySelector('[data-field="agent-profile"]');
      this.fields.agentCategories = this.doc.querySelector('[data-field="agent-categories"]');
      this.fields.agentGlossarySize = this.doc.querySelector('[data-field="agent-glossary-size"]');
      this.fields.agentCompressions = this.doc.querySelector('[data-field="agent-compressions"]');
      this.fields.agentContextSummary = this.doc.querySelector('[data-field="agent-context-summary"]');
      this.fields.agentChecklist = this.doc.querySelector('[data-field="agent-checklist"]');
      this.fields.agentTools = this.doc.querySelector('[data-field="agent-tools"]');
      this.fields.agentToolTrace = this.doc.querySelector('[data-field="agent-tool-trace"]');
      this.fields.agentReports = this.doc.querySelector('[data-field="agent-reports"]');
      this.fields.diffList = this.doc.querySelector('[data-field="diff-list"]');
      this.fields.benchStatus = this.doc.querySelector('[data-field="bench-status"]');
      this.fields.benchCurrent = this.doc.querySelector('[data-field="bench-current"]');
      this.fields.benchMessage = this.doc.querySelector('[data-field="bench-message"]');
      this.fields.benchTable = this.doc.querySelector('[data-field="bench-table"]');
      this.fields.rateCurrentModel = this.doc.querySelector('[data-field="rate-current-model"]');
      this.fields.rateTable = this.doc.querySelector('[data-field="rate-table"]');
      this.fields.eventLevel = this.doc.querySelector('[data-field="event-level"]');
      this.fields.eventTag = this.doc.querySelector('[data-field="event-tag"]');
      this.fields.eventSearch = this.doc.querySelector('[data-field="event-search"]');
      this.fields.eventLog = this.doc.querySelector('[data-field="event-log"]');
      this.fields.eventCopy = this.doc.querySelector('[data-action="event-copy"]');
      this.fields.eventClear = this.doc.querySelector('[data-action="event-clear"]');
      this.fields.eventOlder = this.doc.querySelector('[data-action="event-older"]');
    }

    readQuery() {
      const params = new URLSearchParams(global.location.search);
      const tabId = Number(params.get('tabId'));
      const url = params.get('url') || '';
      let origin = '';
      if (url) {
        try {
          origin = new URL(url).origin;
        } catch (error) {
          origin = url;
        }
      }
      return { tabId: Number.isFinite(tabId) ? tabId : null, url, origin };
    }

    applySnapshot(payload) {
      if (!payload) {
        return;
      }
      if (payload.tabId !== null && payload.tabId !== undefined) {
        this.state.tabId = payload.tabId;
      }
      if (payload.translationStatusByTab) {
        this.state.status = this.state.tabId !== null ? payload.translationStatusByTab[this.state.tabId] || null : null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'modelBenchmarkStatus')) {
        this.state.benchmarkStatus = payload.modelBenchmarkStatus || null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'modelBenchmarks')) {
        this.state.benchmarks = payload.modelBenchmarks || {};
      }
      if (payload.modelLimitsBySpec) {
        this.state.modelLimitsBySpec = payload.modelLimitsBySpec || {};
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'translationJob')) {
        this.state.translationJob = payload.translationJob || null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'translationProgress')) {
        this.state.translationProgress = Number(payload.translationProgress || 0);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'failedBlocksCount')) {
        this.state.failedBlocksCount = Number(payload.failedBlocksCount || 0);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'lastError')) {
        this.state.lastError = payload.lastError || null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'agentState')) {
        this.state.agentState = payload.agentState || null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'selectedCategories')) {
        this.state.selectedCategories = Array.isArray(payload.selectedCategories) ? payload.selectedCategories : [];
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'recentDiffItems')) {
        this.state.recentDiffItems = Array.isArray(payload.recentDiffItems) ? payload.recentDiffItems : [];
      }
      if (payload.eventLog) {
        this._mergeEventLogSnapshot(payload.eventLog.items || []);
        this.state.eventLog.seq = typeof payload.eventLog.seq === 'number' ? payload.eventLog.seq : this.state.eventLog.seq;
      }

      if (this.state.status) {
        if (this.state.status.agentState) {
          this.state.agentState = this.state.status.agentState;
        }
        if (Array.isArray(this.state.status.selectedCategories) && this.state.status.selectedCategories.length) {
          this.state.selectedCategories = this.state.status.selectedCategories;
        }
        if (Array.isArray(this.state.status.recentDiffItems) && this.state.status.recentDiffItems.length) {
          this.state.recentDiffItems = this.state.status.recentDiffItems;
        }
      }

      if (this.ui.portClient && typeof this.ui.portClient.acknowledgeSnapshot === 'function') {
        this.ui.portClient.acknowledgeSnapshot();
      }
      this.render();
    }

    applyPatch(payload) {
      if (!payload) {
        return;
      }
      const patch = payload.patch && typeof payload.patch === 'object'
        ? payload.patch
        : payload;

      if (patch.translationStatusByTab) {
        this.state.status = this.state.tabId !== null ? patch.translationStatusByTab[this.state.tabId] || null : null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'modelBenchmarkStatus')) {
        this.state.benchmarkStatus = patch.modelBenchmarkStatus || null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'modelBenchmarks')) {
        this.state.benchmarks = patch.modelBenchmarks || {};
      }

      if (patch.modelLimitsBySpec) {
        this.state.modelLimitsBySpec = patch.modelLimitsBySpec || {};
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationJob')) {
        this.state.translationJob = patch.translationJob || null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationProgress')) {
        this.state.translationProgress = Number(patch.translationProgress || 0);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'failedBlocksCount')) {
        this.state.failedBlocksCount = Number(patch.failedBlocksCount || 0);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'lastError')) {
        this.state.lastError = patch.lastError || null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'agentState')) {
        this.state.agentState = patch.agentState || null;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'selectedCategories')) {
        this.state.selectedCategories = Array.isArray(patch.selectedCategories) ? patch.selectedCategories : [];
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'recentDiffItems')) {
        this.state.recentDiffItems = Array.isArray(patch.recentDiffItems) ? patch.recentDiffItems : [];
      }

      if (this.state.status) {
        if (this.state.status.agentState) {
          this.state.agentState = this.state.status.agentState;
        }
        if (Array.isArray(this.state.status.selectedCategories) && this.state.status.selectedCategories.length) {
          this.state.selectedCategories = this.state.status.selectedCategories;
        }
        if (Array.isArray(this.state.status.recentDiffItems) && this.state.status.recentDiffItems.length) {
          this.state.recentDiffItems = this.state.status.recentDiffItems;
        }
      }

      if (patch.eventLogAppend && patch.eventLogAppend.item) {
        const entry = patch.eventLogAppend.item;
        const exists = this.state.eventLog.items.some((item) => item && item.seq === entry.seq);
        if (!exists) {
          this.state.eventLog.items.push(entry);
          this.state.eventLog.items.sort((a, b) => (a.seq || 0) - (b.seq || 0));
          if (this.state.eventLog.items.length > 800) {
            this.state.eventLog.items = this.state.eventLog.items.slice(-800);
          }
          this.state.oldestSeq = this.state.eventLog.items.length ? this.state.eventLog.items[0].seq : null;
        }
        this.state.eventLog.seq = Math.max(this.state.eventLog.seq || 0, patch.eventLogAppend.seq || 0);
        this.scheduleEventRender();
      }

      if (patch.eventLogReset) {
        this.state.eventLog = { seq: this.state.eventLog.seq || 0, items: [] };
        this.state.oldestSeq = null;
        this.scheduleEventRender();
      }

      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      if (payload.type === UiProtocol.UI_EVENT_LOG_PAGE_RESULT) {
        if (!this.pendingLoadOlderRequestId || payload.requestId !== this.pendingLoadOlderRequestId) {
          return;
        }
        this.pendingLoadOlderRequestId = null;
        const incoming = Array.isArray(payload.items) ? payload.items : [];
        const existing = new Set(this.state.eventLog.items.map((item) => item.seq));
        const merged = incoming.filter((item) => item && !existing.has(item.seq)).concat(this.state.eventLog.items);
        merged.sort((a, b) => (a.seq || 0) - (b.seq || 0));
        this.state.eventLog.items = merged;
        this.state.oldestSeq = merged.length ? merged[0].seq : null;
        this.scheduleEventRender();
      }

      this.renderStatus();
      this.renderTranslationJob();
      this.renderAgent();
      this.renderDiff();
      this.renderBenchmarks();
      this.renderRateLimits();
    }

    _mergeEventLogSnapshot(items) {
      const incoming = Array.isArray(items) ? items : [];
      const map = new Map();
      this.state.eventLog.items.forEach((item) => {
        if (item && typeof item.seq === 'number') {
          map.set(item.seq, item);
        }
      });
      incoming.forEach((item) => {
        if (item && typeof item.seq === 'number') {
          map.set(item.seq, item);
        }
      });
      this.state.eventLog.items = Array.from(map.values()).sort((a, b) => a.seq - b.seq);
      this.state.oldestSeq = this.state.eventLog.items.length ? this.state.eventLog.items[0].seq : null;
    }

    bindEventControls() {
      if (this.fields.eventLevel) {
        this.fields.eventLevel.addEventListener('change', () => {
          this.state.filters.level = this.fields.eventLevel.value || 'all';
          this.renderEventLog();
        });
      }
      if (this.fields.eventTag) {
        this.fields.eventTag.addEventListener('change', () => {
          this.state.filters.tag = this.fields.eventTag.value || 'all';
          this.renderEventLog();
        });
      }
      if (this.fields.eventSearch) {
        this.fields.eventSearch.addEventListener('input', () => {
          this.state.filters.q = this.fields.eventSearch.value || '';
          this.renderEventLog();
        });
      }
      if (this.fields.eventCopy) {
        this.fields.eventCopy.addEventListener('click', () => this.copyEventJson());
      }
      if (this.fields.eventClear) {
        this.fields.eventClear.addEventListener('click', () => {
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.CLEAR_EVENT_LOG
            : 'CLEAR_EVENT_LOG';
          this.ui.sendUiCommand(command, {});
        });
      }
      if (this.fields.eventOlder) {
        this.fields.eventOlder.addEventListener('click', () => this.loadOlderEvents());
      }
    }

    loadOlderEvents() {
      const oldest = this.state.oldestSeq || (this.state.eventLog.items.length ? this.state.eventLog.items[0].seq : null);
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.EVENT_LOG_PAGE
        : 'EVENT_LOG_PAGE';
      const requestId = this.ui.sendUiCommand(command, { beforeSeq: oldest, limit: 200 }, {});
      this.pendingLoadOlderRequestId = requestId;
    }

    render() {
      if (this.fields.site) {
        this.fields.site.textContent = `Сайт: ${this.state.origin || '—'}`;
      }
      this.renderStatus();
      this.renderTranslationJob();
      this.renderAgent();
      this.renderDiff();
      this.renderBenchmarks();
      this.renderRateLimits();
      this.renderEventLog();
    }

    renderStatus() {
      const status = this.state.status || {};
      if (this.fields.progress) {
        this.fields.progress.value = Math.max(0, Math.min(100, Number(status.progress || 0)));
      }
      if (this.fields.completed) {
        this.fields.completed.textContent = String(status.completed || 0);
      }
      if (this.fields.total) {
        this.fields.total.textContent = String(status.total || 0);
      }
      if (this.fields.inProgress) {
        this.fields.inProgress.textContent = String(status.inProgress || 0);
      }
      if (this.fields.message) {
        this.fields.message.textContent = status.message || status.status || 'нет данных';
      }
      const md = status.modelDecision || {};
      if (this.fields.decisionPolicy) {
        this.fields.decisionPolicy.textContent = md.decision && md.decision.policy ? md.decision.policy : '—';
      }
      if (this.fields.decisionModel) {
        this.fields.decisionModel.textContent = md.chosenModelSpec || '—';
      }
      if (this.fields.decisionReason) {
        this.fields.decisionReason.textContent = md.decision && md.decision.reason ? md.decision.reason : '—';
      }
    }

    renderTranslationJob() {
      const job = this.state.translationJob || null;
      if (this.fields.translationJobId) {
        this.fields.translationJobId.textContent = job && job.id ? job.id : '—';
      }
      if (this.fields.translationJobStatus) {
        this.fields.translationJobStatus.textContent = job && job.status ? this._jobStatusLabel(job.status) : '—';
      }
      if (this.fields.translationProgress) {
        const progress = Number.isFinite(Number(this.state.translationProgress)) ? Number(this.state.translationProgress) : 0;
        this.fields.translationProgress.textContent = `${Math.max(0, Math.min(100, Math.round(progress)))}%`;
      }
      if (this.fields.translationFailedCount) {
        this.fields.translationFailedCount.textContent = String(this.state.failedBlocksCount || 0);
      }
      if (this.fields.translationLastError) {
        this.fields.translationLastError.textContent = this.state.lastError && this.state.lastError.message
          ? this.state.lastError.message
          : '—';
      }
    }

    renderAgent() {
      const fallback = this.state.status && this.state.status.agentState ? this.state.status.agentState : null;
      const agent = this.state.agentState || fallback || null;
      if (this.fields.agentPhase) {
        this.fields.agentPhase.textContent = agent && agent.phase ? this._phaseLabel(agent.phase) : '—';
      }
      if (this.fields.agentProfile) {
        this.fields.agentProfile.textContent = agent && agent.profile ? this._profileLabel(agent.profile) : '—';
      }
      if (this.fields.agentCategories) {
        const categories = Array.isArray(this.state.selectedCategories) && this.state.selectedCategories.length
          ? this.state.selectedCategories
          : (agent && Array.isArray(agent.selectedCategories) ? agent.selectedCategories : []);
        this.fields.agentCategories.textContent = categories.length ? categories.join(', ') : '—';
      }
      if (this.fields.agentGlossarySize) {
        this.fields.agentGlossarySize.textContent = String(agent && Number.isFinite(Number(agent.glossarySize)) ? Number(agent.glossarySize) : 0);
      }
      if (this.fields.agentCompressions) {
        this.fields.agentCompressions.textContent = String(agent && Number.isFinite(Number(agent.compressedContextCount)) ? Number(agent.compressedContextCount) : 0);
      }
      if (this.fields.agentContextSummary) {
        this.fields.agentContextSummary.textContent = agent && agent.contextSummary ? agent.contextSummary : '—';
      }

      this.renderList(this.fields.agentChecklist, agent && Array.isArray(agent.checklist) ? agent.checklist : [], (item) => {
        const status = item && item.status ? this._checklistStatusLabel(item.status) : 'ожидание';
        const title = item && item.title ? item.title : item && item.id ? item.id : 'пункт';
        const details = item && item.details ? ` | ${item.details}` : '';
        return `${status} | ${title}${details}`;
      });

      this.renderList(this.fields.agentTools, agent && Array.isArray(agent.toolHistory) ? agent.toolHistory : [], (item) => {
        const ts = item && item.ts ? this.formatTs(item.ts) : '—';
        const tool = item && item.tool ? item.tool : 'инструмент';
        const status = this._toolStatusLabel(item && item.status ? item.status : 'ok');
        const msg = item && item.message ? item.message : '';
        return `${ts} | ${tool} | ${status}${msg ? ` | ${msg}` : ''}`;
      });

      this.renderList(this.fields.agentToolTrace, agent && Array.isArray(agent.toolExecutionTrace) ? agent.toolExecutionTrace : [], (item) => {
        const ts = item && item.ts ? this.formatTs(item.ts) : '—';
        const tool = item && item.tool ? item.tool : 'инструмент';
        const status = this._toolStatusLabel(item && item.status ? item.status : 'ok');
        const mode = item && item.mode ? item.mode : 'auto';
        const forced = item && item.forced ? 'forced' : 'normal';
        const msg = item && item.message ? item.message : '';
        return `${ts} | ${tool} | mode=${mode} | ${forced} | ${status}${msg ? ` | ${msg}` : ''}`;
      });

      this.renderList(this.fields.agentReports, agent && Array.isArray(agent.reports) ? agent.reports : [], (item) => {
        const ts = item && item.ts ? this.formatTs(item.ts) : '—';
        const type = item && item.type ? item.type : 'заметка';
        const title = item && item.title ? item.title : 'отчёт';
        const body = item && item.body ? item.body : '';
        const meta = item && item.meta && typeof item.meta === 'object' ? item.meta : null;
        const usage = meta && meta.usage && typeof meta.usage === 'object' ? meta.usage : null;
        const rate = meta && meta.rate && typeof meta.rate === 'object' ? meta.rate : null;
        const compactMeta = meta
          ? ` | model=${meta.chosenModelSpec || '—'} | tok=${usage && usage.totalTokens !== undefined && usage.totalTokens !== null ? usage.totalTokens : '—'} | rpm=${rate && rate.remainingRequests !== undefined && rate.remainingRequests !== null ? rate.remainingRequests : '—'} | tpm=${rate && rate.remainingTokens !== undefined && rate.remainingTokens !== null ? rate.remainingTokens : '—'}${meta.cached ? ' | cached' : ''}`
          : '';
        return `${ts} | ${type} | ${title}${body ? ` | ${body}` : ''}${compactMeta}`;
      });
    }

    renderDiff() {
      const fromStatus = this.state.status && Array.isArray(this.state.status.recentDiffItems)
        ? this.state.status.recentDiffItems
        : [];
      const list = Array.isArray(this.state.recentDiffItems) && this.state.recentDiffItems.length
        ? this.state.recentDiffItems
        : fromStatus;
      this.renderList(this.fields.diffList, list, (item) => {
        const id = item && item.blockId ? item.blockId : 'блок';
        const cat = item && item.category ? item.category : 'прочее';
        const before = item && item.before ? item.before : '';
        const after = item && item.after ? item.after : '';
        return `${id} [${cat}] | "${before}" -> "${after}"`;
      });
    }

    renderList(root, items, mapFn) {
      if (!root) {
        return;
      }
      const source = Array.isArray(items) ? items : [];
      root.innerHTML = '';
      const visible = source.slice(-40);
      visible.forEach((item) => {
        const row = this.doc.createElement('div');
        row.className = 'debug__list-item';
        row.textContent = mapFn(item);
        root.appendChild(row);
      });
      if (!visible.length) {
        const empty = this.doc.createElement('div');
        empty.className = 'debug__list-item';
        empty.textContent = '—';
        root.appendChild(empty);
      }
    }

    renderBenchmarks() {
      const status = this.state.benchmarkStatus || {};
      if (this.fields.benchStatus) {
        this.fields.benchStatus.textContent = status.status || '—';
      }
      if (this.fields.benchCurrent) {
        this.fields.benchCurrent.textContent = status.currentModelSpec || '—';
      }
      if (this.fields.benchMessage) {
        this.fields.benchMessage.textContent = status.message || status.reason || '—';
      }
      if (!this.fields.benchTable) {
        return;
      }
      this.fields.benchTable.innerHTML = '';
      const entries = Object.keys(this.state.benchmarks || {}).sort();
      entries.forEach((spec) => {
        const row = this.doc.createElement('tr');
        row.appendChild(this.cell(spec));
        row.appendChild(this.cell(String(Math.round((this.state.benchmarks[spec] || {}).medianMs || 0) || '—')));
        row.appendChild(this.cell(this.formatTs((this.state.benchmarks[spec] || {}).updatedAt)));
        this.fields.benchTable.appendChild(row);
      });
      if (!entries.length) {
        const row = this.doc.createElement('tr');
        row.appendChild(this.cell('—')); row.appendChild(this.cell('—')); row.appendChild(this.cell('—'));
        this.fields.benchTable.appendChild(row);
      }
    }


    renderRateLimits() {
      if (!this.fields.rateTable) {
        return;
      }
      const limits = this.state.modelLimitsBySpec || {};
      const rows = Object.keys(limits).sort();
      const currentModel = this.state.status && this.state.status.modelDecision
        ? this.state.status.modelDecision.chosenModelSpec || null
        : null;
      if (this.fields.rateCurrentModel) {
        this.fields.rateCurrentModel.textContent = currentModel || '—';
      }

      this.fields.rateTable.innerHTML = '';
      rows.forEach((spec) => {
        const item = limits[spec] || {};
        const remReq = item.remainingRequests === null || item.remainingRequests === undefined ? '—' : String(item.remainingRequests);
        const remTok = item.remainingTokens === null || item.remainingTokens === undefined ? '—' : String(item.remainingTokens);
        const reserved = `${item.reservedRequests || 0}/${item.reservedTokens || 0}`;
        const cooldown = this.formatCooldown(item.cooldownUntilTs);
        const reset = this.formatReset(item.resetRequestsAt, item.resetTokensAt);

        const row = this.doc.createElement('div');
        row.className = 'rate-row';
        if (spec === currentModel) {
          row.classList.add('rate-row--current');
        }
        row.appendChild(this.rateCell('rate-cell-model', spec));
        row.appendChild(this.rateCell('', remReq));
        row.appendChild(this.rateCell('', remTok));
        row.appendChild(this.rateCell('', reserved));
        row.appendChild(this.rateCell('', cooldown));
        row.appendChild(this.rateCell('', reset));
        this.fields.rateTable.appendChild(row);
      });

      if (!rows.length) {
        const row = this.doc.createElement('div');
        row.className = 'rate-row';
        row.textContent = 'данные лимитов пока отсутствуют';
        this.fields.rateTable.appendChild(row);
      }
    }

    rateCell(className, text) {
      const el = this.doc.createElement('div');
      el.className = `rate-cell ${className || ''}`.trim();
      el.textContent = text;
      return el;
    }

    formatCooldown(cooldownUntilTs) {
      if (typeof cooldownUntilTs !== 'number') {
        return '—';
      }
      const remain = Math.max(0, cooldownUntilTs - Date.now());
      if (remain <= 0) {
        return 'готово';
      }
      return `пауза ${Math.ceil(remain / 1000)}с`;
    }

    formatReset(reqTs, tokTs) {
      const req = typeof reqTs === 'number' ? Math.max(0, reqTs - Date.now()) : null;
      const tok = typeof tokTs === 'number' ? Math.max(0, tokTs - Date.now()) : null;
      const vals = [req, tok].filter((v) => typeof v === 'number');
      if (!vals.length) {
        return '—';
      }
      return `${Math.ceil(Math.min(...vals) / 1000)}s`;
    }

    scheduleEventRender() {
      if (this.renderTimer) {
        return;
      }
      this.renderTimer = global.setTimeout(() => {
        this.renderTimer = null;
        this.renderEventLog();
      }, 120);
    }

    renderEventLog() {
      if (!this.fields.eventLog) {
        return;
      }
      const filtered = this.getFilteredEvents();
      const visible = filtered.slice(-400);
      this.fields.eventLog.innerHTML = '';
      this.refreshTagOptions();

      visible.forEach((event) => {
        const row = this.doc.createElement('div');
        row.className = 'event-row';

        const time = this.doc.createElement('div');
        time.className = 'event-time';
        time.textContent = this.formatTs(event.ts);

        const level = this.doc.createElement('div');
        level.className = 'event-level';
        level.textContent = String(event.level || 'info');

        const content = this.doc.createElement('div');
        content.className = 'event-content';
        const tag = this.doc.createElement('div');
        tag.className = 'event-tag';
        tag.textContent = String(event.tag || 'general');
        const msg = this.doc.createElement('div');
        msg.className = 'event-msg';
        msg.textContent = String(event.message || '');
        const copyBtn = this.doc.createElement('button');
        copyBtn.type = 'button';
        copyBtn.className = 'event-copy-btn';
        copyBtn.textContent = 'Копировать';
        copyBtn.addEventListener('click', () => this.copySingleEvent(event));
        content.appendChild(tag);
        content.appendChild(msg);
        content.appendChild(copyBtn);

        const meta = this.doc.createElement('div');
        meta.className = 'event-meta';
        meta.textContent = this.formatMeta(event.meta || {});

        row.appendChild(time);
        row.appendChild(level);
        row.appendChild(content);
        row.appendChild(meta);
        this.fields.eventLog.appendChild(row);
      });

      if (!visible.length) {
        const empty = this.doc.createElement('div');
        empty.className = 'event-row';
        empty.textContent = 'нет событий';
        this.fields.eventLog.appendChild(empty);
      }
    }

    refreshTagOptions() {
      if (!this.fields.eventTag) {
        return;
      }
      const tags = ['all', ...Array.from(new Set(this.state.eventLog.items.map((item) => item.tag).filter(Boolean))).sort()];
      const current = this.state.filters.tag || 'all';
      this.fields.eventTag.innerHTML = '';
      tags.forEach((value) => {
        const opt = this.doc.createElement('option');
        opt.value = value;
        opt.textContent = value === 'all' ? 'Тег: все' : `Тег: ${value}`;
        this.fields.eventTag.appendChild(opt);
      });
      this.fields.eventTag.value = tags.includes(current) ? current : 'all';
      this.state.filters.tag = this.fields.eventTag.value;
    }

    getFilteredEvents() {
      const level = this.state.filters.level || 'all';
      const tag = this.state.filters.tag || 'all';
      const q = (this.state.filters.q || '').trim().toLowerCase();
      return this.state.eventLog.items.filter((item) => {
        if (!item) {
          return false;
        }
        if (level !== 'all' && item.level !== level) {
          return false;
        }
        if (tag !== 'all' && item.tag !== tag) {
          return false;
        }
        if (!q) {
          return true;
        }
        const haystack = `${item.tag || ''} ${item.message || ''} ${JSON.stringify(item.meta || {})}`.toLowerCase();
        return haystack.includes(q);
      });
    }

    _jobStatusLabel(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'idle') return 'ожидание';
      if (raw === 'preparing') return 'подготовка';
      if (raw === 'awaiting_categories') return 'ожидание категорий';
      if (raw === 'running') return 'выполняется';
      if (raw === 'completing') return 'завершение';
      if (raw === 'done') return 'готово';
      if (raw === 'failed') return 'ошибка';
      if (raw === 'cancelled') return 'отменено';
      return status || '—';
    }

    _phaseLabel(phase) {
      const raw = String(phase || '').trim().toLowerCase();
      if (raw === 'planned') return 'план готов';
      if (raw === 'running' || raw === 'translating') return 'перевод';
      if (raw === 'awaiting_categories') return 'ожидание категорий';
      if (raw === 'proofreading') return 'вычитка';
      if (raw === 'done') return 'завершено';
      if (raw === 'failed') return 'ошибка';
      if (raw === 'cache_restore') return 'восстановление из кэша';
      if (raw === 'idle') return 'ожидание';
      return phase || '—';
    }

    _profileLabel(profile) {
      const raw = String(profile || '').trim().toLowerCase();
      if (raw === 'balanced') return 'сбалансированный';
      if (raw === 'literal') return 'дословный';
      if (raw === 'readable') return 'читабельный';
      if (raw === 'technical') return 'технический';
      if (raw === 'auto') return 'авто';
      return profile || '—';
    }

    _checklistStatusLabel(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'done') return 'готово';
      if (raw === 'running') return 'в работе';
      if (raw === 'failed') return 'ошибка';
      if (raw === 'skipped') return 'пропуск';
      return 'ожидание';
    }

    _toolStatusLabel(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'ok') return 'ok';
      if (raw === 'warn') return 'предупреждение';
      if (raw === 'error') return 'ошибка';
      if (raw === 'skip' || raw === 'skipped') return 'пропуск';
      return status || '—';
    }

    formatMeta(meta) {
      const parts = [];
      if (meta.source) parts.push(`src=${meta.source}`);
      if (meta.tabId !== null && meta.tabId !== undefined) parts.push(`tab=${meta.tabId}`);
      if (meta.modelSpec) parts.push(`model=${meta.modelSpec}`);
      if (meta.status) parts.push(`status=${meta.status}`);
      if (meta.stage) parts.push(`stage=${meta.stage}`);
      if (meta.requestId) parts.push(`req=${meta.requestId}`);
      if (typeof meta.retryAfterMs === 'number') parts.push(`retry=${meta.retryAfterMs}ms`);
      if (typeof meta.latencyMs === 'number') parts.push(`latency=${Math.round(meta.latencyMs)}ms`);
      return parts.join(' · ') || '—';
    }

    formatTs(value) {
      const Time = global.NT && global.NT.Time ? global.NT.Time : null;
      if (Time && typeof Time.formatTime === 'function') {
        return Time.formatTime(value);
      }
      if (typeof value !== 'number') {
        return '—';
      }
      return new Date(value).toLocaleTimeString();
    }

    cell(text) {
      const td = this.doc.createElement('td');
      td.textContent = text;
      return td;
    }

    async copyEventJson() {
      const json = JSON.stringify(this.state.eventLog.items, null, 2);
      await this.copyText(json);
    }

    async copySingleEvent(event) {
      await this.copyText(JSON.stringify(event || {}, null, 2));
    }

    async copyText(text) {
      if (global.navigator && global.navigator.clipboard && global.navigator.clipboard.writeText) {
        try {
          await global.navigator.clipboard.writeText(text);
          return;
        } catch (error) {
          // fallback
        }
      }
      const textarea = this.doc.createElement('textarea');
      textarea.value = text;
      this.doc.body.appendChild(textarea);
      textarea.select();
      this.doc.execCommand('copy');
      textarea.remove();
    }
  }

  const ui = new global.NT.UiModule({
    chromeApi: global.chrome,
    portName: 'debug'
  }).init();

  const page = new DebugPage({ doc: global.document, ui });
  ui.setHandlers({
    onSnapshot: (payload) => page.applySnapshot(payload),
    onPatch: (payload) => page.applyPatch(payload)
  });
  page.init();
})(globalThis);
