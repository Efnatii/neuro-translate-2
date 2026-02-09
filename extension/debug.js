(function initDebugPage(global) {
  class DebugPage {
    constructor({ doc, chromeApi }) {
      this.doc = doc;
      this.chromeApi = chromeApi;
      this.state = {
        tabId: null,
        url: '',
        origin: '',
        status: null,
        benchmarkStatus: null,
        benchmarks: {}
      };
      this.fields = {};
      this.portClient = null;
    }

    init() {
      this.cacheElements();
      this.state = { ...this.state, ...this.readQuery() };
      this.render();
      this.initPortClient();
      this.loadStatusFromStorage(this.state.tabId);
      this.loadBenchmarksFromStorage();
      this.bindStorageUpdates();
    }

    cacheElements() {
      this.fields.site = this.doc.querySelector('[data-field="site"]');
      this.fields.progress = this.doc.querySelector('[data-field="progress"]');
      this.fields.completed = this.doc.querySelector('[data-field="completed"]');
      this.fields.total = this.doc.querySelector('[data-field="total"]');
      this.fields.inProgress = this.doc.querySelector('[data-field="inProgress"]');
      this.fields.message = this.doc.querySelector('[data-field="message"]');
      this.fields.benchStatus = this.doc.querySelector('[data-field="bench-status"]');
      this.fields.benchCurrent = this.doc.querySelector('[data-field="bench-current"]');
      this.fields.benchMessage = this.doc.querySelector('[data-field="bench-message"]');
      this.fields.benchTable = this.doc.querySelector('[data-field="bench-table"]');
    }

    readQuery() {
      const params = new URLSearchParams(global.location.search);
      const tabId = params.get('tabId');
      const url = params.get('url') || '';
      let origin = '';

      if (url) {
        try {
          origin = new URL(url).origin;
        } catch (error) {
          origin = url;
        }
      }

      return {
        tabId: tabId ? Number(tabId) : null,
        url,
        origin
      };
    }

    loadStatusFromStorage(tabId) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        this.updateStatus(null);
        return;
      }

      this.chromeApi.storage.local.get({ translationStatusByTab: {} }, (result) => {
        const byTab = result.translationStatusByTab || {};
        const entry = tabId !== null ? byTab[tabId] : null;
        this.updateStatus(entry);
      });
    }

    loadBenchmarksFromStorage() {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        this.updateBenchmarks(null, {});
        return;
      }

      this.chromeApi.storage.local.get({ modelBenchmarkStatus: null, modelBenchmarks: {} }, (result) => {
        this.updateBenchmarks(result.modelBenchmarkStatus || null, result.modelBenchmarks || {});
      });
    }

    initPortClient() {
      const UiPortClient = global.NT && global.NT.UiPortClient ? global.NT.UiPortClient : null;
      if (!UiPortClient) {
        return;
      }

      this.portClient = new UiPortClient({
        portName: 'debug',
        onSnapshot: (payload) => this.applySnapshot(payload),
        onPatch: (payload) => this.applyPatch(payload)
      });
      this.portClient.connect();
    }

    applySnapshot(payload) {
      if (!payload) {
        return;
      }

      if (payload.tabId !== null && payload.tabId !== undefined) {
        this.state.tabId = payload.tabId;
      }

      if (payload.translationStatusByTab) {
        const entry = this.state.tabId !== null ? payload.translationStatusByTab[this.state.tabId] : null;
        this.updateStatus(entry);
      }

      if (payload.modelBenchmarkStatus || payload.modelBenchmarks) {
        this.updateBenchmarks(
          payload.modelBenchmarkStatus || this.state.benchmarkStatus,
          payload.modelBenchmarks || this.state.benchmarks
        );
      }

      if (this.portClient && typeof this.portClient.acknowledgeSnapshot === 'function') {
        this.portClient.acknowledgeSnapshot();
      }
    }

    applyPatch(payload) {
      if (!payload || !payload.patch) {
        return;
      }

      if (payload.patch.translationStatusByTab) {
        const entry = this.state.tabId !== null ? payload.patch.translationStatusByTab[this.state.tabId] : null;
        this.updateStatus(entry);
      }

      if (payload.patch.modelBenchmarkStatus || payload.patch.modelBenchmarks) {
        this.updateBenchmarks(
          payload.patch.modelBenchmarkStatus || this.state.benchmarkStatus,
          payload.patch.modelBenchmarks || this.state.benchmarks
        );
      }
    }

    bindStorageUpdates() {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.onChanged) {
        return;
      }

      this.chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') {
          return;
        }

        if (changes.translationStatusByTab) {
          const value = changes.translationStatusByTab.newValue || {};
          const entry = this.state.tabId !== null ? value[this.state.tabId] : null;
          this.updateStatus(entry);
        }

        if (changes.modelBenchmarkStatus || changes.modelBenchmarks) {
          const status = changes.modelBenchmarkStatus ? changes.modelBenchmarkStatus.newValue : this.state.benchmarkStatus;
          const benchmarks = changes.modelBenchmarks ? changes.modelBenchmarks.newValue : this.state.benchmarks;
          this.updateBenchmarks(status || null, benchmarks || {});
        }
      });
    }

    updateStatus(entry) {
      this.state.status = entry || null;
      this.renderStatus();
    }

    updateBenchmarks(status, benchmarks) {
      this.state.benchmarkStatus = status || null;
      this.state.benchmarks = benchmarks || {};
      this.renderBenchmarks();
    }

    render() {
      if (this.fields.site) {
        const site = this.state.origin || this.state.url || '—';
        this.fields.site.textContent = `Сайт: ${site}`;
      }

      this.renderStatus();
      this.renderBenchmarks();
    }

    renderStatus() {
      const status = this.state.status || {};
      const completed = this.normalizeNumber(status.completed);
      const total = this.normalizeNumber(status.total);
      const inProgress = this.normalizeNumber(status.inProgress);
      const message = this.normalizeMessage(status.message);
      const progressValue = this.normalizeNumber(status.progress, 0);

      if (this.fields.completed) {
        this.fields.completed.textContent = completed !== null ? completed : '—';
      }
      if (this.fields.total) {
        this.fields.total.textContent = total !== null ? total : '—';
      }
      if (this.fields.inProgress) {
        this.fields.inProgress.textContent = inProgress !== null ? inProgress : '—';
      }
      if (this.fields.message) {
        this.fields.message.textContent = message;
      }
      if (this.fields.progress) {
        this.fields.progress.value = Math.max(0, Math.min(100, progressValue));
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
        this.fields.benchMessage.textContent = status.message || status.errorCode || '—';
      }
      if (this.fields.benchTable) {
        this.fields.benchTable.innerHTML = '';
        const entries = this.sortedBenchmarks(this.state.benchmarks);
        if (!entries.length) {
          const row = this.doc.createElement('tr');
          const cell = this.doc.createElement('td');
          cell.colSpan = 3;
          cell.textContent = 'нет данных';
          row.appendChild(cell);
          this.fields.benchTable.appendChild(row);
          return;
        }
        entries.forEach((entry) => {
          const row = this.doc.createElement('tr');
          row.appendChild(this.renderBenchCell(entry.modelSpec));
          row.appendChild(this.renderBenchCell(this.formatNumber(entry.medianMs)));
          row.appendChild(this.renderBenchCell(this.formatTimestamp(entry.updatedAt)));
          this.fields.benchTable.appendChild(row);
        });
      }
    }

    renderBenchCell(value) {
      const cell = this.doc.createElement('td');
      cell.textContent = value;
      return cell;
    }

    sortedBenchmarks(benchmarks) {
      const entries = Object.keys(benchmarks || {}).map((modelSpec) => ({
        modelSpec,
        medianMs: benchmarks[modelSpec] ? benchmarks[modelSpec].medianMs : null,
        updatedAt: benchmarks[modelSpec] ? benchmarks[modelSpec].updatedAt : null
      }));
      entries.sort((a, b) => a.modelSpec.localeCompare(b.modelSpec));
      return entries;
    }

    normalizeNumber(value, fallback = null) {
      if (typeof value === 'number') {
        return value;
      }
      return fallback;
    }

    normalizeMessage(value) {
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
      return 'нет данных';
    }

    formatNumber(value) {
      if (typeof value === 'number') {
        return `${Math.round(value)}`;
      }
      return '—';
    }

    formatTimestamp(value) {
      if (typeof value !== 'number') {
        return '—';
      }
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return '—';
      }
      return `${date.toLocaleTimeString()}`;
    }
  }

  const page = new DebugPage({ doc: global.document, chromeApi: global.chrome });
  page.init();
})(globalThis);
