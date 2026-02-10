/**
 * Popup UI controller for quick settings and status preview.
 *
 * This controller intentionally contains only view/state behavior. All external
 * interactions (tabs/runtime/port/settings persistence) are delegated to
 * `UiModule`, which acts as the UI narrow throat.
 *
 * Snapshot + patch synchronization comes from `UiPortClient` via `UiModule`.
 * Persistent settings writes are debounced by `SettingsStore` inside the module,
 * so popup logic stays deterministic across MV3 reconnects.
 */
(function initPopup(global) {
  class PopupController {
    constructor({ doc, ui }) {
      this.doc = doc;
      this.ui = ui;
      this.state = {
        apiKey: '',
        translationModelList: [],
        modelSelection: { speed: true, preference: null },
        translationVisible: true
      };
      this.activeTabId = null;
      this.modelRegistry = { entries: [], byKey: {} };
    }

    async init() {
      this.cacheElements();
      this.bindEvents();

      const activeTab = await this.ui.getActiveTab();
      this.activeTabId = activeTab ? activeTab.id : null;
      this.modelRegistry = this.ui.getModelRegistry();

      const settings = await this.ui.getSettings([
        'apiKey',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationVisibilityByTab'
      ]);

      this.state.apiKey = settings.apiKey || '';
      this.state.translationModelList = Array.isArray(settings.translationModelList) ? settings.translationModelList : [];
      this.state.modelSelection = this.ui.normalizeSelection(settings.modelSelection, settings.modelSelectionPolicy);
      const byTab = settings.translationVisibilityByTab || {};
      this.state.translationVisible = this.activeTabId !== null ? byTab[this.activeTabId] !== false : true;

      this.renderModels();
      this.renderSettings();
      this.renderStatus();
    }

    cacheElements() {
      this.debugButton = this.doc.querySelector('[data-action="open-debug"]');
      this.apiKeyInput = this.doc.querySelector('[data-field="api-key"]');
      this.apiKeyToggle = this.doc.querySelector('[data-action="toggle-api"]');
      this.modelsRoot = this.doc.querySelector('[data-section="models"]');
      this.speedCheckbox = this.doc.querySelector('[data-field="selection-speed"]');
      this.preferenceSelect = this.doc.querySelector('[data-field="selection-preference"]');
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

      if (this.speedCheckbox) {
        this.speedCheckbox.addEventListener('change', (event) => {
          this.state.modelSelection = {
            ...this.state.modelSelection,
            speed: Boolean(event.target.checked)
          };
          this.scheduleSave({ modelSelection: this.state.modelSelection });
          if (this.state.modelSelection.speed && this.state.translationModelList.length) {
            this.ui.sendUiCommand('BENCHMARK_SELECTED_MODELS', {});
          }
        });
      }

      if (this.preferenceSelect) {
        this.preferenceSelect.addEventListener('change', (event) => {
          const value = event.target.value;
          this.state.modelSelection = {
            ...this.state.modelSelection,
            preference: value === 'smartest' || value === 'cheapest' ? value : null
          };
          this.scheduleSave({ modelSelection: this.state.modelSelection });
        });
      }

      if (this.modelsRoot) {
        this.modelsRoot.addEventListener('change', (event) => {
          const target = event.target;
          if (!target || target.type !== 'checkbox') {
            return;
          }
          const list = new Set(this.state.translationModelList);
          if (target.checked) {
            list.add(target.value);
          } else {
            list.delete(target.value);
          }
          this.state.translationModelList = Array.from(list);
          this.scheduleSave({ translationModelList: this.state.translationModelList });
        });
      }

      if (this.visibilityButton) {
        this.visibilityButton.addEventListener('click', () => this.toggleVisibility());
      }
    }

    applySnapshot(payload) {
      if (!payload) {
        return;
      }

      const settings = payload.settings || {};
      if (Object.prototype.hasOwnProperty.call(settings, 'apiKey')) {
        this.state.apiKey = settings.apiKey || '';
      }
      if (Array.isArray(settings.translationModelList)) {
        this.state.translationModelList = settings.translationModelList;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'modelSelection') || Object.prototype.hasOwnProperty.call(settings, 'modelSelectionPolicy')) {
        this.state.modelSelection = this.ui.normalizeSelection(settings.modelSelection, settings.modelSelectionPolicy);
      }

      if (payload.tabId !== null && payload.tabId !== undefined) {
        this.activeTabId = payload.tabId;
      }

      const visibilityMap = payload.translationVisibilityByTab || {};
      if (this.activeTabId !== null && Object.prototype.hasOwnProperty.call(visibilityMap, this.activeTabId)) {
        this.state.translationVisible = visibilityMap[this.activeTabId] !== false;
      }

      this.renderSettings();
      this.renderModels();
      this.renderStatus(payload.translationStatusByTab || null);

      if (this.ui.portClient && typeof this.ui.portClient.acknowledgeSnapshot === 'function') {
        this.ui.portClient.acknowledgeSnapshot();
      }
    }

    applyPatch(payload) {
      if (!payload || !payload.patch) {
        return;
      }
      const patch = payload.patch;

      if (Object.prototype.hasOwnProperty.call(patch, 'apiKey')) {
        this.state.apiKey = patch.apiKey || '';
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationModelList') && Array.isArray(patch.translationModelList)) {
        this.state.translationModelList = patch.translationModelList;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'modelSelection')) {
        this.state.modelSelection = this.ui.normalizeSelection(patch.modelSelection, null);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationVisibilityByTab') && this.activeTabId !== null) {
        const map = patch.translationVisibilityByTab || {};
        if (Object.prototype.hasOwnProperty.call(map, this.activeTabId)) {
          this.state.translationVisible = map[this.activeTabId] !== false;
        }
      }

      this.renderSettings();
      this.renderModels();
      this.renderStatus(patch.translationStatusByTab || null);
    }

    scheduleSave(patch) {
      this.ui.queueSettingsPatch(patch, {
        finalize: (payload) => {
          if (payload.translationVisibilityByTab && this.activeTabId !== null) {
            payload.translationVisibilityByTab = { [this.activeTabId]: this.state.translationVisible };
          }
        }
      });
    }

    async toggleVisibility() {
      this.state.translationVisible = !this.state.translationVisible;
      this.updateVisibilityIcon();
      if (this.activeTabId === null) {
        return;
      }
      await this.ui.setVisibility(this.activeTabId, this.state.translationVisible);
    }

    async openDebug() {
      const tab = await this.ui.getActiveTab();
      this.ui.openDebug({
        tabId: tab ? tab.id : '',
        url: tab && tab.url ? tab.url : ''
      });
    }

    toggleApiKeyVisibility() {
      if (!this.apiKeyInput || !this.apiKeyToggle) {
        return;
      }
      const isPassword = this.apiKeyInput.type === 'password';
      this.apiKeyInput.type = isPassword ? 'text' : 'password';
      this.apiKeyToggle.textContent = isPassword ? 'Скрыть' : 'Показать';
    }

    renderModels() {
      if (!this.modelsRoot) {
        return;
      }

      const Html = global.NT && global.NT.Html ? global.NT.Html : null;
      this.modelsRoot.innerHTML = '';
      const options = this.modelRegistry.entries || [];
      options.forEach((entry) => {
        const modelSpec = `${entry.id}:${entry.tier}`;
        const label = this.doc.createElement('label');
        label.className = 'popup__checkbox';

        const input = this.doc.createElement('input');
        input.type = 'checkbox';
        input.value = modelSpec;
        input.checked = this.state.translationModelList.includes(modelSpec);

        const text = this.doc.createElement('span');
        const tier = entry.tier ? String(entry.tier).toUpperCase() : 'STANDARD';
        const safe = Html ? Html.safeText(`${entry.id} (${tier})`, '—') : `${entry.id} (${tier})`;
        text.textContent = safe;

        label.appendChild(input);
        label.appendChild(text);
        this.modelsRoot.appendChild(label);
      });
    }

    renderSettings() {
      if (this.apiKeyInput) {
        this.apiKeyInput.value = this.state.apiKey;
      }
      if (this.speedCheckbox) {
        this.speedCheckbox.checked = Boolean(this.state.modelSelection.speed);
      }
      if (this.preferenceSelect) {
        const value = this.state.modelSelection.preference;
        this.preferenceSelect.value = value === 'smartest' || value === 'cheapest' ? value : '';
      }
      this.updateVisibilityIcon();
    }

    renderStatus(statusByTab) {
      const Time = global.NT && global.NT.Time ? global.NT.Time : null;
      const entry = statusByTab && this.activeTabId !== null ? statusByTab[this.activeTabId] : null;
      if (!entry) {
        if (this.statusText) {
          this.statusText.textContent = '—';
        }
        if (this.statusProgress) {
          this.statusProgress.value = 0;
        }
        return;
      }

      const progress = typeof entry.progress === 'number'
        ? (Time && typeof Time.clamp === 'function' ? Time.clamp(entry.progress, 0, 100) : Math.max(0, Math.min(100, entry.progress)))
        : 0;

      if (this.statusText) {
        this.statusText.textContent = entry.message || entry.status || '—';
      }
      if (this.statusProgress) {
        this.statusProgress.value = progress;
      }
    }

    updateVisibilityIcon() {
      if (!this.visibilityIcon) {
        return;
      }
      this.visibilityIcon.textContent = this.state.translationVisible ? '👁️' : '🙈';
    }
  }

  const ui = new global.NT.UiModule({
    chromeApi: global.chrome,
    portName: 'popup'
  }).init();

  const controller = new PopupController({ doc: global.document, ui });
  ui.setHandlers({
    onSnapshot: (payload) => controller.applySnapshot(payload),
    onPatch: (payload) => controller.applyPatch(payload)
  });
  controller.init();
})(globalThis);
