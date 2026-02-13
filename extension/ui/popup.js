/**
 * Popup controller for settings and lightweight status visualization.
 *
 * Data flow is snapshot/patch driven; user actions are sent as strict
 * request/response commands through `UiModule`.
 *
 * Contracts:
 * - model list/options come from cached snapshot only;
 * - settings updates are debounced in `UiModule` and acknowledged by BG;
 * - command errors are displayed as non-fatal inline diagnostics.
 *
 * This file does not read chrome.storage directly and does not contain AI logic.
 */
(function initPopup(global) {
  class PopupController {
    constructor({ doc, ui }) {
      this.doc = doc;
      this.ui = ui;
      this.state = {
        apiKey: '',
        hasApiKey: false,
        apiKeyLength: 0,
        translationModelList: [],
        modelSelection: { speed: true, preference: null },
        translationVisible: true,
        modelOptions: []
      };
      this.activeTabId = null;
      this.apiKeyRequested = false;
    }

    async init() {
      this.cacheElements();
      this.bindEvents();

      const activeTab = await this.ui.getActiveTab();
      this.activeTabId = activeTab ? activeTab.id : null;

      await this.ui.waitForFirstSnapshot();
      this.hydrateFromUiCache();

      this.renderModels();
      this.renderSettings();
      this.renderStatus();
      this.renderUiError();
    }

    hydrateFromUiCache() {
      const settings = this.ui.getCachedSettings();
      this.state.hasApiKey = Boolean(settings.hasApiKey);
      this.state.apiKeyLength = Number(settings.apiKeyLength || 0);
      this.state.translationModelList = Array.isArray(settings.translationModelList) ? settings.translationModelList : [];
      this.state.modelSelection = this.normalizeSelection(settings.modelSelection);
      this.state.modelOptions = this.ui.getCachedModelOptions();
    }

    normalizeSelection(modelSelection) {
      const source = modelSelection && typeof modelSelection === 'object' ? modelSelection : {};
      const preference = source.preference === 'smartest' || source.preference === 'cheapest'
        ? source.preference
        : null;
      return {
        speed: Boolean(source.speed),
        preference
      };
    }

    cacheElements() {
      this.debugButton = this.doc.querySelector('[data-action="open-debug"]');
      this.uiErrorText = this.doc.querySelector('[data-field="ui-error"]');
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
          this.ui.queueSettingsPatch({ apiKey: this.state.apiKey });
          this.renderUiError();
        });
      }

      if (this.speedCheckbox) {
        this.speedCheckbox.addEventListener('change', async (event) => {
          this.state.modelSelection = {
            ...this.state.modelSelection,
            speed: Boolean(event.target.checked)
          };
          this.ui.queueSettingsPatch({ modelSelection: this.state.modelSelection });
          if (this.state.modelSelection.speed && this.state.translationModelList.length) {
            try {
              await this.ui.sendUiCommand('BENCHMARK_SELECTED_MODELS', {});
            } catch (_) {
              // non-fatal, rendered below
            }
            this.renderUiError();
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
          this.ui.queueSettingsPatch({ modelSelection: this.state.modelSelection });
          this.renderUiError();
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
          this.ui.queueSettingsPatch({ translationModelList: this.state.translationModelList });
          this.renderUiError();
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

      this.hydrateFromUiCache();
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
      this.renderUiError();

      if (this.ui.portClient && typeof this.ui.portClient.acknowledgeSnapshot === 'function') {
        this.ui.portClient.acknowledgeSnapshot();
      }
    }

    applyPatch(payload) {
      if (!payload) {
        return;
      }

      this.hydrateFromUiCache();

      const patch = payload.patch || {};
      if (Object.prototype.hasOwnProperty.call(patch, 'translationVisibilityByTab') && this.activeTabId !== null) {
        const map = patch.translationVisibilityByTab || {};
        if (Object.prototype.hasOwnProperty.call(map, this.activeTabId)) {
          this.state.translationVisible = map[this.activeTabId] !== false;
        }
      }

      this.renderSettings();
      this.renderModels();
      this.renderStatus(patch.translationStatusByTab || payload.translationStatusByTab || null);
      this.renderUiError();
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

    async toggleApiKeyVisibility() {
      if (!this.apiKeyInput || !this.apiKeyToggle) {
        return;
      }

      const isPassword = this.apiKeyInput.type === 'password';
      if (isPassword && !this.state.apiKey && !this.apiKeyRequested) {
        this.apiKeyRequested = true;
        try {
          const response = await this.ui.requestApiKey();
          this.state.apiKey = response && typeof response.apiKey === 'string' ? response.apiKey : '';
          this.apiKeyInput.value = this.state.apiKey;
        } catch (_) {
          // non-fatal, shown in ui error line
        }
      }
      this.apiKeyInput.type = isPassword ? 'text' : 'password';
      this.apiKeyToggle.textContent = isPassword ? 'Скрыть' : 'Показать';
      this.renderUiError();
    }

    renderModels() {
      if (!this.modelsRoot) {
        return;
      }

      const Html = global.NT && global.NT.Html ? global.NT.Html : null;
      this.modelsRoot.innerHTML = '';
      const options = Array.isArray(this.state.modelOptions) ? this.state.modelOptions : [];
      options.forEach((option) => {
        const modelSpec = typeof option.value === 'string' ? option.value : '';
        if (!modelSpec) {
          return;
        }
        const label = this.doc.createElement('label');
        label.className = 'popup__checkbox';

        const input = this.doc.createElement('input');
        input.type = 'checkbox';
        input.value = modelSpec;
        input.checked = this.state.translationModelList.includes(modelSpec);

        const text = this.doc.createElement('span');
        const baseLabel = option.label || modelSpec;
        const price = this.formatPrice(option.sum_1M);
        const safe = Html ? Html.safeText(`${baseLabel} — ${price}`, '—') : `${baseLabel} — ${price}`;
        text.textContent = safe;

        label.appendChild(input);
        label.appendChild(text);
        this.modelsRoot.appendChild(label);
      });
    }

    formatPrice(sum1M) {
      if (typeof sum1M !== 'number' || !Number.isFinite(sum1M)) {
        return '— / 1M';
      }
      return `$${sum1M.toFixed(3)} / 1M`;
    }

    renderSettings() {
      if (this.apiKeyInput) {
        if (this.state.apiKey) {
          this.apiKeyInput.value = this.state.apiKey;
          this.apiKeyInput.placeholder = 'sk-...';
        } else if (this.state.hasApiKey) {
          this.apiKeyInput.value = '';
          this.apiKeyInput.placeholder = `Saved (len=${this.state.apiKeyLength || 0})`;
        } else {
          this.apiKeyInput.value = '';
          this.apiKeyInput.placeholder = 'sk-...';
        }
      }
      if (this.speedCheckbox) {
        this.speedCheckbox.checked = Boolean(this.state.modelSelection.speed);
      }
      if (this.preferenceSelect) {
        const value = this.state.modelSelection.preference;
        this.preferenceSelect.value = value === 'smartest' || value === 'cheapest' ? value : 'none';
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

    renderUiError() {
      if (!this.uiErrorText) {
        return;
      }
      const error = this.ui.getLastUiError();
      this.uiErrorText.textContent = error ? `Command failed: ${error.code} — ${error.message}` : '';
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
    onPatch: (payload) => controller.applyPatch(payload),
    onUiError: () => controller.renderUiError()
  });
  controller.init();
})(globalThis);
