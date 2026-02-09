(function initPopup(global) {
  class PopupController {
    constructor({ doc, chromeApi }) {
      this.doc = doc;
      this.chromeApi = chromeApi;
      this.state = {
        apiKey: '',
        translationModelList: [],
        modelSelectionPolicy: 'fastest',
        translationVisible: true
      };
      this.activeTabId = null;
      this.saveTimer = null;
      this.pendingPatch = {};
    }

    async init() {
      this.cacheElements();
      this.bindEvents();

      const activeTab = await this.getActiveTab();
      this.activeTabId = activeTab ? activeTab.id : null;

      this.initPortClient();
      await this.loadSettings();
      this.renderModels();
      this.renderSettings();
      await this.renderStatus();
    }

    cacheElements() {
      this.debugButton = this.doc.querySelector('[data-action="open-debug"]');
      this.apiKeyInput = this.doc.querySelector('[data-field="api-key"]');
      this.apiKeyToggle = this.doc.querySelector('[data-action="toggle-api"]');
      this.modelsRoot = this.doc.querySelector('[data-section="models"]');
      this.policySelect = this.doc.querySelector('[data-field="selection-policy"]');
      this.statusText = this.doc.querySelector('[data-field="status-text"]');
      this.statusProgress = this.doc.querySelector('[data-field="status-progress"]');
      this.visibilityButton = this.doc.querySelector('[data-action="toggle-visibility"]');
      this.visibilityIcon = this.doc.querySelector('[data-field="visibility-icon"]');
    }

    bindEvents() {
      if (this.debugButton) {
        this.debugButton.addEventListener('click', () => this.openDebug());
      }

      if (this.apiKeyToggle) {
        this.apiKeyToggle.addEventListener('click', () => this.toggleApiKeyVisibility());
      }

      if (this.apiKeyInput) {
        this.apiKeyInput.addEventListener('input', (event) => {
          this.state.apiKey = event.target.value || '';
          this.scheduleSave({ apiKey: this.state.apiKey });
        });
      }

      if (this.policySelect) {
        this.policySelect.addEventListener('change', (event) => {
          const value = event.target.value;
          this.state.modelSelectionPolicy = value;
          this.scheduleSave({ modelSelectionPolicy: value });
        });
      }

      if (this.modelsRoot) {
        this.modelsRoot.addEventListener('change', (event) => {
          const target = event.target;
          if (!target || target.type !== 'checkbox') {
            return;
          }

          const spec = target.value;
          const list = new Set(this.state.translationModelList);
          if (target.checked) {
            list.add(spec);
          } else {
            list.delete(spec);
          }
          this.state.translationModelList = Array.from(list);
          this.scheduleSave({ translationModelList: this.state.translationModelList });
        });
      }

      if (this.visibilityButton) {
        this.visibilityButton.addEventListener('click', () => this.toggleVisibility());
      }
    }

    initPortClient() {
      const UiPortClient = global.NT && global.NT.UiPortClient ? global.NT.UiPortClient : null;
      if (!UiPortClient) {
        return;
      }

      this.portClient = new UiPortClient({
        portName: 'popup',
        onSnapshot: (payload) => this.applySnapshot(payload),
        onPatch: (payload) => this.applyPatch(payload)
      });
      this.portClient.connect();
    }

    async loadSettings() {
      const raw = await this.storageGet([
        'apiKey',
        'translationModelList',
        'modelSelectionPolicy',
        'translationVisibilityByTab'
      ]);
      const sanitize = global.NT_SETTINGS && typeof global.NT_SETTINGS.sanitizeSettings === 'function'
        ? global.NT_SETTINGS.sanitizeSettings
        : null;
      const sanitized = sanitize ? sanitize(raw) : raw;

      this.state.apiKey = sanitized.apiKey || '';
      this.state.translationModelList = Array.isArray(sanitized.translationModelList)
        ? sanitized.translationModelList
        : [];
      this.state.modelSelectionPolicy = sanitized.modelSelectionPolicy || 'fastest';
      if (sanitized.translationVisibilityByTab && this.activeTabId !== null) {
        const visibility = sanitized.translationVisibilityByTab[this.activeTabId];
        if (typeof visibility === 'boolean') {
          this.state.translationVisible = visibility;
        }
      }
    }

    applySnapshot(payload) {
      if (!payload) {
        return;
      }

      if (payload.tabId !== null && payload.tabId !== undefined) {
        this.activeTabId = payload.tabId;
      }

      if (payload.settings) {
        this.state.apiKey = payload.settings.apiKey || '';
        this.state.translationModelList = Array.isArray(payload.settings.translationModelList)
          ? payload.settings.translationModelList
          : [];
        this.state.modelSelectionPolicy = payload.settings.modelSelectionPolicy || 'fastest';
      }

      if (payload.translationVisibilityByTab && this.activeTabId !== null) {
        const visibility = payload.translationVisibilityByTab[this.activeTabId];
        if (typeof visibility === 'boolean') {
          this.state.translationVisible = visibility;
        }
      }

      this.renderModels();
      this.renderSettings();
      this.renderStatusFromSnapshot(payload.translationStatusByTab);

      if (this.portClient && typeof this.portClient.acknowledgeSnapshot === 'function') {
        this.portClient.acknowledgeSnapshot();
      }
    }

    applyPatch(payload) {
      if (!payload || !payload.patch) {
        return;
      }

      const patch = payload.patch;

      if (patch.apiKey !== undefined) {
        this.state.apiKey = patch.apiKey || '';
      }
      if (patch.translationModelList !== undefined) {
        this.state.translationModelList = Array.isArray(patch.translationModelList)
          ? patch.translationModelList
          : [];
      }
      if (patch.modelSelectionPolicy !== undefined) {
        this.state.modelSelectionPolicy = patch.modelSelectionPolicy || 'fastest';
      }
      if (patch.translationVisibilityByTab && this.activeTabId !== null) {
        const visibility = patch.translationVisibilityByTab[this.activeTabId];
        if (typeof visibility === 'boolean') {
          this.state.translationVisible = visibility;
        }
      }

      if (patch.translationStatusByTab) {
        this.renderStatusFromSnapshot(patch.translationStatusByTab);
      }

      this.renderSettings();
      this.syncModelSelections();
    }

    renderSettings() {
      if (this.apiKeyInput) {
        this.apiKeyInput.value = this.state.apiKey;
      }

      if (this.policySelect) {
        this.policySelect.value = this.state.modelSelectionPolicy;
      }

      this.updateVisibilityIcon();
      this.syncModelSelections();
    }

    renderModels() {
      if (!this.modelsRoot) {
        return;
      }

      const registry = this.getModelRegistry();
      const grouped = this.groupModels(registry.entries);

      this.modelsRoot.innerHTML = '';

      ['flex', 'standard', 'priority'].forEach((tier) => {
        const group = grouped[tier] || [];
        const groupEl = this.doc.createElement('div');
        groupEl.className = 'popup__model-group';

        const title = this.doc.createElement('div');
        title.className = 'popup__model-title';
        title.textContent = tier.toUpperCase();
        groupEl.appendChild(title);

        group.forEach((entry) => {
          const item = this.doc.createElement('label');
          item.className = 'popup__model-item';

          const info = this.doc.createElement('div');
          info.className = 'popup__model-info';

          const labelRow = this.doc.createElement('div');
          labelRow.className = 'popup__model-label';

          const checkbox = this.doc.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = this.formatModelSpec(entry.id, entry.tier);
          checkbox.checked = this.state.translationModelList.includes(checkbox.value);

          const name = this.doc.createElement('span');
          name.textContent = entry.id;

          labelRow.appendChild(checkbox);
          labelRow.appendChild(name);

          const meta = this.doc.createElement('div');
          meta.className = 'popup__model-meta';
          meta.textContent = this.formatMeta(entry);

          info.appendChild(labelRow);
          info.appendChild(meta);

          const badge = this.doc.createElement('span');
          badge.className = 'popup__badge';
          badge.textContent = this.formatPriceBadge(entry.sum_1M);

          item.appendChild(info);
          item.appendChild(badge);

          groupEl.appendChild(item);
        });

        this.modelsRoot.appendChild(groupEl);
      });
    }

    syncModelSelections() {
      if (!this.modelsRoot) {
        return;
      }

      const selected = new Set(this.state.translationModelList);
      this.modelsRoot.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.checked = selected.has(checkbox.value);
      });
    }

    groupModels(entries) {
      const grouped = { flex: [], standard: [], priority: [] };

      entries.forEach((entry) => {
        if (grouped[entry.tier]) {
          grouped[entry.tier].push(entry);
        }
      });

      Object.keys(grouped).forEach((tier) => {
        grouped[tier].sort((a, b) => this.sortByPrice(a, b));
      });

      return grouped;
    }

    sortByPrice(a, b) {
      const aValue = typeof a.sum_1M === 'number' ? a.sum_1M : Number.POSITIVE_INFINITY;
      const bValue = typeof b.sum_1M === 'number' ? b.sum_1M : Number.POSITIVE_INFINITY;

      if (aValue === bValue) {
        return a.id.localeCompare(b.id);
      }

      return aValue - bValue;
    }

    formatMeta(entry) {
      const input = this.formatPrice(entry.inputPrice);
      const cached = this.formatPrice(entry.cachedInputPrice);
      const output = this.formatPrice(entry.outputPrice);
      return `input ${input} · cached ${cached} · output ${output}`;
    }

    formatPrice(value) {
      if (typeof value !== 'number') {
        return '—';
      }
      return `$${value}`;
    }

    formatPriceBadge(sum) {
      if (typeof sum !== 'number') {
        return '— / 1M';
      }
      return `$${sum} / 1M`;
    }

    formatModelSpec(id, tier) {
      if (global.NT && global.NT.AiCommon && typeof global.NT.AiCommon.formatModelSpec === 'function') {
        return global.NT.AiCommon.formatModelSpec(id, tier);
      }
      return `${id}:${tier}`;
    }

    getModelRegistry() {
      if (global.NT && global.NT.AiCommon && typeof global.NT.AiCommon.createModelRegistry === 'function') {
        return global.NT.AiCommon.createModelRegistry();
      }

      return { entries: [] };
    }

    async renderStatus() {
      const statusData = await this.storageGet(['translationStatusByTab']);
      const byTab = statusData.translationStatusByTab || {};
      this.renderStatusFromSnapshot(byTab);
    }

    renderStatusFromSnapshot(byTab) {
      const entry = this.activeTabId !== null ? byTab[this.activeTabId] : null;
      const statusText = this.resolveStatusText(entry);
      const progressValue = this.resolveProgressValue(entry);

      if (this.statusText) {
        this.statusText.textContent = statusText;
      }

      if (this.statusProgress) {
        this.statusProgress.value = progressValue;
      }
    }

    resolveStatusText(entry) {
      if (!entry) {
        return '—';
      }

      if (typeof entry === 'string') {
        return entry;
      }

      if (typeof entry.status === 'string') {
        return entry.status;
      }

      return '—';
    }

    resolveProgressValue(entry) {
      if (!entry || typeof entry.progress !== 'number') {
        return 0;
      }

      return Math.max(0, Math.min(100, entry.progress));
    }

    updateVisibilityIcon() {
      if (!this.visibilityIcon) {
        return;
      }

      this.visibilityIcon.textContent = this.state.translationVisible ? '👁️' : '🙈';
    }

    async toggleVisibility() {
      this.state.translationVisible = !this.state.translationVisible;
      this.updateVisibilityIcon();

      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.sendMessage !== 'function') {
        return;
      }

      if (this.activeTabId === null) {
        return;
      }

      try {
        await new Promise((resolve, reject) => {
          this.chromeApi.tabs.sendMessage(
            this.activeTabId,
            { type: 'SET_TRANSLATION_VISIBILITY', visible: this.state.translationVisible },
            (response) => {
              const error = this.chromeApi.runtime && this.chromeApi.runtime.lastError;
              if (error) {
                reject(error);
                return;
              }
              resolve(response);
            }
          );
        });
      } catch (error) {
        // ignore tab errors
      }

      this.scheduleSave({ translationVisibilityByTab: { [this.activeTabId]: this.state.translationVisible } });
    }

    toggleApiKeyVisibility() {
      if (!this.apiKeyInput || !this.apiKeyToggle) {
        return;
      }

      const isPassword = this.apiKeyInput.type === 'password';
      this.apiKeyInput.type = isPassword ? 'text' : 'password';
      this.apiKeyToggle.textContent = isPassword ? 'Скрыть' : 'Показать';
    }

    async openDebug() {
      if (!this.chromeApi || !this.chromeApi.tabs || !this.chromeApi.runtime) {
        return;
      }

      const activeTab = await this.getActiveTab();
      const tabId = activeTab ? activeTab.id : '';
      const tabUrl = activeTab && activeTab.url ? activeTab.url : '';
      const debugUrl = `${this.chromeApi.runtime.getURL('debug.html')}?tabId=${tabId}&url=${encodeURIComponent(tabUrl)}`;

      this.chromeApi.tabs.create({ url: debugUrl });
    }

    scheduleSave(patch) {
      Object.assign(this.pendingPatch, patch);

      if (this.saveTimer) {
        clearTimeout(this.saveTimer);
      }

      this.saveTimer = setTimeout(() => {
        const payload = { ...this.pendingPatch };
        this.pendingPatch = {};

        if (payload.translationVisibilityByTab && this.activeTabId !== null) {
          const current = this.state.translationVisible;
          payload.translationVisibilityByTab = { [this.activeTabId]: current };
        }

        this.storageSet(payload);
      }, 400);
    }

    storageGet(keys) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve({});
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(keys, (result) => resolve(result || {}));
      });
    }

    storageSet(payload) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.set(payload, () => resolve());
      });
    }

    getActiveTab() {
      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.query !== 'function') {
        return Promise.resolve(null);
      }

      return new Promise((resolve) => {
        this.chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve(tabs && tabs.length ? tabs[0] : null);
        });
      });
    }
  }

  const controller = new PopupController({ doc: global.document, chromeApi: global.chrome });
  controller.init();
})(globalThis);
