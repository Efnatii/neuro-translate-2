/**
 * Popup UI controller for quick settings and status preview.
 *
 * Role:
 * - Keep popup rendering/state logic local while delegating all browser/runtime
 *   interaction to `UiModule`.
 *
 * Public contract:
 * - Controller owns DOM updates and user interaction handlers only.
 * - Model list/options are read from `UiModule` snapshot cache (`modelRegistry`)
 *   instead of direct AI utility imports.
 *
 * Dependencies:
 * - `UiModule`, `Html`, and optional `Time` helper.
 *
 * Side effects:
 * - Writes settings patches through `UiModule` and dispatches UI commands.
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
        translationVisible: true,
        translationPipelineEnabled: false,
        translationJob: null,
        translationProgress: 0,
        failedBlocksCount: 0,
        lastError: null
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
        'translationVisibilityByTab',
        'translationPipelineEnabled'
      ]);

      this.state.apiKey = settings.apiKey || '';
      this.state.translationModelList = Array.isArray(settings.translationModelList) ? settings.translationModelList : [];
      this.state.modelSelection = this.ui.normalizeSelection(settings.modelSelection, settings.modelSelectionPolicy);
      this.state.translationPipelineEnabled = Boolean(settings.translationPipelineEnabled);
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
      this.startButton = this.doc.querySelector('[data-action="start-translation"]');
      this.cancelButton = this.doc.querySelector('[data-action="cancel-translation"]');
      this.visibilityButton = this.doc.querySelector('[data-action="toggle-visibility"]');
      this.visibilityIconOn = this.doc.querySelector('[data-field="visibility-on"]');
      this.visibilityIconOff = this.doc.querySelector('[data-field="visibility-off"]');
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
            const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
            const benchCommand = UiProtocol && UiProtocol.Commands
              ? UiProtocol.Commands.BENCHMARK_SELECTED_MODELS
              : 'BENCHMARK_SELECTED_MODELS';
            this.ui.sendUiCommand(benchCommand, {});
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

      if (this.startButton) {
        this.startButton.addEventListener('click', () => this.startTranslation());
      }

      if (this.cancelButton) {
        this.cancelButton.addEventListener('click', () => this.cancelTranslation());
      }
    }

    applySnapshot(payload) {
      if (!payload) {
        return;
      }
      this.modelRegistry = this.ui.getModelRegistry();

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
      if (Object.prototype.hasOwnProperty.call(settings, 'translationPipelineEnabled')) {
        this.state.translationPipelineEnabled = Boolean(settings.translationPipelineEnabled);
      }

      if (payload.tabId !== null && payload.tabId !== undefined) {
        this.activeTabId = payload.tabId;
      }

      const visibilityMap = payload.translationVisibilityByTab || {};
      if (this.activeTabId !== null && Object.prototype.hasOwnProperty.call(visibilityMap, this.activeTabId)) {
        this.state.translationVisible = visibilityMap[this.activeTabId] !== false;
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

      this.renderSettings();
      this.renderModels();
      this.renderStatus(payload.translationStatusByTab || null);

      if (this.ui.portClient && typeof this.ui.portClient.acknowledgeSnapshot === 'function') {
        this.ui.portClient.acknowledgeSnapshot();
      }
    }

    applyPatch(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      this.modelRegistry = this.ui.getModelRegistry();
      const patch = payload.patch && typeof payload.patch === 'object'
        ? payload.patch
        : payload;

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
      if (Object.prototype.hasOwnProperty.call(patch, 'translationPipelineEnabled')) {
        this.state.translationPipelineEnabled = Boolean(patch.translationPipelineEnabled);
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

    async startTranslation() {
      if (this.activeTabId === null || !this.state.translationPipelineEnabled) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.START_TRANSLATION
        : 'START_TRANSLATION';
      this.ui.sendUiCommand(command, {
        tabId: this.activeTabId
      });
    }

    async cancelTranslation() {
      if (this.activeTabId === null) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.CANCEL_TRANSLATION
        : 'CANCEL_TRANSLATION';
      this.ui.sendUiCommand(command, {
        tabId: this.activeTabId
      });
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
      const options = this.resolveModelEntries();
      if (!options.length) {
        const empty = this.doc.createElement('div');
        empty.className = 'popup__models-empty';
        empty.textContent = 'Нет доступных моделей';
        this.modelsRoot.appendChild(empty);
        return;
      }
      const grouped = {
        flex: [],
        standard: [],
        priority: [],
        other: []
      };

      options.forEach((entry) => {
        if (!entry || typeof entry.id !== 'string' || !entry.id) {
          return;
        }
        const rawTier = entry && typeof entry.tier === 'string' ? entry.tier.toLowerCase() : 'standard';
        const targetTier = rawTier === 'flex' || rawTier === 'priority' || rawTier === 'standard'
          ? rawTier
          : 'other';
        grouped[targetTier].push({
          id: entry.id,
          rawTier
        });
      });

      const sections = [
        { key: 'flex', title: 'FLEX' },
        { key: 'standard', title: 'STANDARD' },
        { key: 'priority', title: 'PRIORITY' },
        { key: 'other', title: 'OTHER' }
      ];

      let renderedGroupCount = 0;
      sections.forEach((section) => {
        const items = grouped[section.key];
        if (!items.length) {
          return;
        }
        renderedGroupCount += 1;

        const group = this.doc.createElement('section');
        group.className = 'popup__models-group';

        const header = this.doc.createElement('h3');
        header.className = 'popup__models-group-title';
        header.textContent = section.title;
        group.appendChild(header);

        const list = this.doc.createElement('div');
        list.className = 'popup__models-group-list';

        items.forEach((entry) => {
          const modelSpec = `${entry.id}:${entry.rawTier || 'standard'}`;
          const label = this.doc.createElement('label');
          label.className = 'popup__checkbox';

          const input = this.doc.createElement('input');
          input.type = 'checkbox';
          input.value = modelSpec;
          input.checked = this.state.translationModelList.includes(modelSpec);

          const text = this.doc.createElement('span');
          const safe = Html ? Html.safeText(entry.id, '—') : entry.id;
          text.textContent = safe;

          label.appendChild(input);
          label.appendChild(text);
          list.appendChild(label);
        });

        group.appendChild(list);
        this.modelsRoot.appendChild(group);
      });

      if (!renderedGroupCount) {
        const empty = this.doc.createElement('div');
        empty.className = 'popup__models-empty';
        empty.textContent = 'Нет доступных моделей';
        this.modelsRoot.appendChild(empty);
      }
    }

    resolveModelEntries() {
      const fromRegistry = this.modelRegistry && Array.isArray(this.modelRegistry.entries)
        ? this.modelRegistry.entries
        : [];
      if (fromRegistry.length) {
        return fromRegistry;
      }

      const AiCommon = global.NT && global.NT.AiCommon ? global.NT.AiCommon : null;
      if (AiCommon && typeof AiCommon.createModelRegistry === 'function') {
        const fallback = AiCommon.createModelRegistry();
        if (fallback && Array.isArray(fallback.entries) && fallback.entries.length) {
          return fallback.entries;
        }
      }

      const bySelected = (this.state.translationModelList || [])
        .map((modelSpec) => {
          if (typeof modelSpec !== 'string' || !modelSpec.includes(':')) {
            return null;
          }
          const parts = modelSpec.split(':');
          const id = parts[0] || '';
          const tier = parts[1] || 'standard';
          if (!id) {
            return null;
          }
          return { id, tier };
        })
        .filter(Boolean);
      return bySelected;
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
      this.updateActionButtons();
      this.updateVisibilityIcon();
    }

    renderStatus(statusByTab) {
      const Time = global.NT && global.NT.Time ? global.NT.Time : null;
      const entry = statusByTab && this.activeTabId !== null ? statusByTab[this.activeTabId] : null;
      const job = this.state.translationJob || null;
      let message = '—';
      let progress = 0;
      if (job) {
        message = job.message || job.status || '—';
        progress = Number.isFinite(Number(this.state.translationProgress)) ? Number(this.state.translationProgress) : 0;
        if (this.state.failedBlocksCount > 0) {
          message = `${message} (failed: ${this.state.failedBlocksCount})`;
        }
      } else if (entry) {
        progress = typeof entry.progress === 'number'
          ? (Time && typeof Time.clamp === 'function' ? Time.clamp(entry.progress, 0, 100) : Math.max(0, Math.min(100, entry.progress)))
          : 0;
        message = entry.message || entry.status || '—';
      } else if (!this.state.translationPipelineEnabled) {
        message = 'Translation pipeline is disabled';
      }
      if (this.state.lastError && this.state.lastError.message) {
        message = `${message} | ${this.state.lastError.message}`;
      }
      if (this.statusText) {
        this.statusText.textContent = message;
      }
      if (this.statusProgress) {
        this.statusProgress.value = progress;
      }
      this.updateActionButtons();
    }

    updateVisibilityIcon() {
      if (!this.visibilityButton) {
        return;
      }
      const visible = this.state.translationVisible !== false;
      this.visibilityButton.setAttribute('aria-label', visible ? 'Скрыть перевод' : 'Показать перевод');
      this.visibilityButton.setAttribute('title', visible ? 'Скрыть перевод' : 'Показать перевод');
      this.visibilityButton.setAttribute('data-state', visible ? 'visible' : 'hidden');

      if (this.visibilityIconOn) {
        this.visibilityIconOn.hidden = !visible;
      }
      if (this.visibilityIconOff) {
        this.visibilityIconOff.hidden = visible;
      }
    }

    updateActionButtons() {
      const running = this.state.translationJob && (this.state.translationJob.status === 'running' || this.state.translationJob.status === 'preparing' || this.state.translationJob.status === 'completing');
      if (this.startButton) {
        this.startButton.disabled = !this.state.translationPipelineEnabled || this.activeTabId === null || Boolean(running);
      }
      if (this.cancelButton) {
        this.cancelButton.disabled = this.activeTabId === null || !running;
      }
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
