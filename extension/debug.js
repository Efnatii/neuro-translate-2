(function initDebugPage(global) {
  class DebugPage {
    constructor({ doc, chromeApi }) {
      this.doc = doc;
      this.chromeApi = chromeApi;
      this.state = {
        tabId: null,
        url: '',
        origin: '',
        status: null
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
      this.bindStorageUpdates();
    }

    cacheElements() {
      this.fields.site = this.doc.querySelector('[data-field="site"]');
      this.fields.progress = this.doc.querySelector('[data-field="progress"]');
      this.fields.completed = this.doc.querySelector('[data-field="completed"]');
      this.fields.total = this.doc.querySelector('[data-field="total"]');
      this.fields.inProgress = this.doc.querySelector('[data-field="inProgress"]');
      this.fields.message = this.doc.querySelector('[data-field="message"]');
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
    }

    bindStorageUpdates() {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.onChanged) {
        return;
      }

      this.chromeApi.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local' || !changes.translationStatusByTab) {
          return;
        }

        const value = changes.translationStatusByTab.newValue || {};
        const entry = this.state.tabId !== null ? value[this.state.tabId] : null;
        this.updateStatus(entry);
      });
    }

    updateStatus(entry) {
      this.state.status = entry || null;
      this.renderStatus();
    }

    render() {
      if (this.fields.site) {
        const site = this.state.origin || this.state.url || '—';
        this.fields.site.textContent = `Сайт: ${site}`;
      }

      this.renderStatus();
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
  }

  const page = new DebugPage({ doc: global.document, chromeApi: global.chrome });
  page.init();
})(globalThis);
