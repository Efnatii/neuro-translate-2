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
  const CATEGORY_OPTIONS = [
    { id: 'heading', label: 'Заголовки' },
    { id: 'paragraph', label: 'Абзацы' },
    { id: 'list', label: 'Списки' },
    { id: 'button', label: 'Кнопки' },
    { id: 'label', label: 'Подписи' },
    { id: 'navigation', label: 'Навигация' },
    { id: 'meta', label: 'Мета' },
    { id: 'code', label: 'Код' },
    { id: 'quote', label: 'Цитаты' },
    { id: 'table', label: 'Таблицы' },
    { id: 'other', label: 'Прочее' }
  ];

  const CATEGORY_MODE_GROUPS = {
    all: CATEGORY_OPTIONS.map((item) => item.id),
    content: ['heading', 'paragraph', 'list', 'quote', 'table', 'code'],
    interface: ['button', 'label', 'navigation'],
    meta: ['meta'],
    custom: []
  };

  const POPUP_TAB_IDS = ['control', 'agent', 'models'];
  const POPUP_DEFAULT_TAB = 'control';

  const AGENT_TOOLS = [
    {
      key: 'pageAnalyzer',
      label: 'Анализ страницы',
      hint: 'Собирает статистику по контенту страницы для принятия решений агентом'
    },
    {
      key: 'categorySelector',
      label: 'Выбор категорий',
      hint: 'Определяет, какие категории текста переводить на текущем шаге'
    },
    {
      key: 'glossaryBuilder',
      label: 'Построение глоссария',
      hint: 'Формирует локальный глоссарий терминов для единообразного перевода'
    },
    {
      key: 'batchPlanner',
      label: 'Планировщик батчей',
      hint: 'Разбивает перевод на батчи и задаёт порядок обработки'
    },
    {
      key: 'modelRouter',
      label: 'Маршрутизатор моделей',
      hint: 'Выбирает fast/strong маршрут модели по сложности батча'
    },
    {
      key: 'progressAuditor',
      label: 'Аудит прогресса',
      hint: 'Периодически проверяет выполнение плана и фиксирует отклонения'
    },
    {
      key: 'antiRepeatGuard',
      label: 'Антидубликаты',
      hint: 'Защищает от повторной обработки одних и тех же блоков'
    },
    {
      key: 'contextCompressor',
      label: 'Сжатие контекста',
      hint: 'Автоматически сжимает накопленный контекст при переполнении'
    },
    {
      key: 'reportWriter',
      label: 'Отчёты агента',
      hint: 'Ведёт структурированные отчёты по шагам перевода'
    },
    {
      key: 'workflowController',
      label: 'Контроллер действий',
      hint: 'Системный инструмент: через него проходят все state-действия агента'
    }
  ];

  const DEFAULT_AGENT_TOOLS = {
    pageAnalyzer: 'on',
    categorySelector: 'auto',
    glossaryBuilder: 'auto',
    batchPlanner: 'auto',
    modelRouter: 'auto',
    progressAuditor: 'on',
    antiRepeatGuard: 'on',
    contextCompressor: 'auto',
    reportWriter: 'on',
    workflowController: 'on'
  };

  const LOCAL_PROFILE_PRESETS = {
    auto: { style: 'auto', maxBatchSize: 'auto', proofreadingPasses: 'auto', parallelism: 'auto' },
    balanced: { style: 'balanced', maxBatchSize: 8, proofreadingPasses: 1, parallelism: 'mixed' },
    literal: { style: 'literal', maxBatchSize: 6, proofreadingPasses: 1, parallelism: 'low' },
    readable: { style: 'readable', maxBatchSize: 10, proofreadingPasses: 2, parallelism: 'high' },
    technical: { style: 'technical', maxBatchSize: 5, proofreadingPasses: 2, parallelism: 'low' }
  };

  const LOCAL_AGENT_TUNING_DEFAULTS = {
    styleOverride: 'auto',
    maxBatchSizeOverride: null,
    proofreadingPassesOverride: null,
    parallelismOverride: 'auto',
    plannerTemperature: 0.2,
    plannerMaxOutputTokens: 1300,
    auditIntervalMs: 2500,
    mandatoryAuditIntervalMs: 1000,
    compressionThreshold: 80,
    contextFootprintLimit: 9000,
    compressionCooldownMs: 1200
  };

  const DEFAULT_AGENT_MODEL_POLICY = {
    mode: 'auto',
    speed: true,
    preference: null,
    allowRouteOverride: true
  };

  class PopupController {
    constructor({ doc, ui }) {
      this.doc = doc;
      this.ui = ui;
      this.state = {
        apiKey: '',
        translationModelList: [],
        modelSelection: { speed: DEFAULT_AGENT_MODEL_POLICY.speed, preference: DEFAULT_AGENT_MODEL_POLICY.preference },
        translationAgentModelPolicy: { ...DEFAULT_AGENT_MODEL_POLICY },
        translationAgentProfile: 'auto',
        translationAgentTools: { ...DEFAULT_AGENT_TOOLS },
        translationAgentTuning: { ...LOCAL_AGENT_TUNING_DEFAULTS },
        translationCategoryMode: 'all',
        translationCategoryList: [],
        translationPageCacheEnabled: true,
        translationApiCacheEnabled: true,
        translationPopupActiveTab: POPUP_DEFAULT_TAB,
        translationVisible: true,
        translationPipelineEnabled: false,
        translationStatusByTab: {},
        translationJob: null,
        translationProgress: 0,
        failedBlocksCount: 0,
        lastError: null,
        agentState: null,
        selectedCategories: [],
        availableCategories: [],
        categorySelectionDraft: [],
        categorySelectionDraftJobId: null
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
        'translationAgentModelPolicy',
        'translationVisibilityByTab',
        'translationPipelineEnabled',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationCategoryMode',
        'translationCategoryList',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationPopupActiveTab'
      ]);

      this.state.apiKey = settings.apiKey || '';
      this.state.translationModelList = Array.isArray(settings.translationModelList) ? settings.translationModelList : [];
      this.state.modelSelection = this.ui.normalizeSelection(settings.modelSelection, settings.modelSelectionPolicy);
      this.state.translationAgentModelPolicy = this.normalizeAgentModelPolicy(
        settings.translationAgentModelPolicy,
        this.state.modelSelection
      );
      this.state.modelSelection = this.toLegacySelection(this.state.translationAgentModelPolicy);
      this.state.translationPipelineEnabled = Boolean(settings.translationPipelineEnabled);
      this.state.translationAgentProfile = this.normalizeAgentProfile(settings.translationAgentProfile);
      this.state.translationAgentTools = this.normalizeAgentTools(settings.translationAgentTools);
      this.state.translationAgentTuning = this.normalizeAgentTuning(settings.translationAgentTuning);
      this.state.translationCategoryMode = this.normalizeCategoryMode(settings.translationCategoryMode);
      this.state.translationCategoryList = this.normalizeCategoryList(settings.translationCategoryList);
      this.state.translationPageCacheEnabled = settings.translationPageCacheEnabled !== false;
      this.state.translationApiCacheEnabled = settings.translationApiCacheEnabled !== false;
      this.state.translationPopupActiveTab = this.normalizePopupTab(settings.translationPopupActiveTab);
      const byTab = settings.translationVisibilityByTab || {};
      this.state.translationVisible = this.activeTabId !== null ? byTab[this.activeTabId] !== false : true;

      this.renderModels();
      this.renderAgentControls();
      this.renderSettings();
      this.renderStatus();
      this.renderTabs();
    }

    cacheElements() {
      this.debugButton = this.doc.querySelector('[data-action="open-debug"]');
      this.apiKeyInput = this.doc.querySelector('[data-field="api-key"]');
      this.apiKeyToggle = this.doc.querySelector('[data-action="toggle-api"]');
      this.modelsRoot = this.doc.querySelector('[data-section="models"]');
      this.agentProfileSelect = this.doc.querySelector('[data-field="agent-profile"]');
      this.agentModelPolicyMode = this.doc.querySelector('[data-field="agent-model-policy-mode"]');
      this.agentModelSpeed = this.doc.querySelector('[data-field="agent-model-speed"]');
      this.agentModelPreference = this.doc.querySelector('[data-field="agent-model-preference"]');
      this.agentModelRouteOverride = this.doc.querySelector('[data-field="agent-model-route-override"]');
      this.agentStyleOverride = this.doc.querySelector('[data-field="agent-style-override"]');
      this.agentBatchSizeInput = this.doc.querySelector('[data-field="agent-batch-size"]');
      this.agentProofreadPassesInput = this.doc.querySelector('[data-field="agent-proofread-passes"]');
      this.agentParallelismSelect = this.doc.querySelector('[data-field="agent-parallelism"]');
      this.agentPlannerTemperatureInput = this.doc.querySelector('[data-field="agent-planner-temperature"]');
      this.agentPlannerTokensInput = this.doc.querySelector('[data-field="agent-planner-tokens"]');
      this.agentAuditIntervalInput = this.doc.querySelector('[data-field="agent-audit-interval"]');
      this.agentMandatoryAuditIntervalInput = this.doc.querySelector('[data-field="agent-mandatory-audit-interval"]');
      this.agentCompressionThresholdInput = this.doc.querySelector('[data-field="agent-compression-threshold"]');
      this.agentContextLimitInput = this.doc.querySelector('[data-field="agent-context-limit"]');
      this.agentCompressionCooldownInput = this.doc.querySelector('[data-field="agent-compression-cooldown"]');
      this.pipelineEnabledCheckbox = this.doc.querySelector('[data-field="pipeline-enabled"]');
      this.agentCategoryModeSelect = this.doc.querySelector('[data-field="agent-category-mode"]');
      this.agentCategoryModeHint = this.doc.querySelector('[data-field="agent-category-mode-hint"]');
      this.agentCategoryDefaultsRoot = this.doc.querySelector('[data-section="agent-category-defaults"]');
      this.agentProfileImpactRoot = this.doc.querySelector('[data-section="agent-profile-impact"]');
      this.cacheEnabledCheckbox = this.doc.querySelector('[data-field="cache-enabled"]');
      this.apiCacheEnabledCheckbox = this.doc.querySelector('[data-field="api-cache-enabled"]');
      this.agentToolsRoot = this.doc.querySelector('[data-section="agent-tools-grid"]');
      this.statusText = this.doc.querySelector('[data-field="status-text"]');
      this.agentStatusText = this.doc.querySelector('[data-field="agent-status"]');
      this.statusChipPipeline = this.doc.querySelector('[data-field="status-chip-pipeline"]');
      this.statusChipModel = this.doc.querySelector('[data-field="status-chip-model"]');
      this.statusChipCache = this.doc.querySelector('[data-field="status-chip-cache"]');
      this.statusMetricsRoot = this.doc.querySelector('[data-section="status-metrics"]');
      this.statusTrace = this.doc.querySelector('[data-field="status-trace"]');
      this.agentMiniStatuses = this.doc.querySelector('[data-section="agent-mini-statuses"]');
      this.statusProgress = this.doc.querySelector('[data-field="status-progress"]');
      this.categoryChooserSection = this.doc.querySelector('[data-section="category-chooser"]');
      this.categoryChooserHint = this.doc.querySelector('[data-field="category-chooser-hint"]');
      this.categoryChooserList = this.doc.querySelector('[data-section="category-chooser-list"]');
      this.startButton = this.doc.querySelector('[data-action="start-translation"]');
      this.startButtonLabel = this.startButton ? this.startButton.querySelector('.popup__action-label') : null;
      this.cancelButton = this.doc.querySelector('[data-action="cancel-translation"]');
      this.clearButton = this.doc.querySelector('[data-action="clear-translation-data"]');
      this.visibilityButton = this.doc.querySelector('[data-action="toggle-visibility"]');
      this.visibilityIconOn = this.doc.querySelector('[data-field="visibility-on"]');
      this.visibilityIconOff = this.doc.querySelector('[data-field="visibility-off"]');
      this.visibilityLabel = this.doc.querySelector('[data-field="visibility-label"]');
      this.popupTabButtons = Array.from(this.doc.querySelectorAll('[data-action="switch-tab"][data-tab]'));
      this.popupTabPanels = Array.from(this.doc.querySelectorAll('[data-tab-panel]'));
    }

    bindEvents() {
      if (this.debugButton) {
        this.debugButton.addEventListener('click', () => this.openDebug());
      }
      const openDebugFromStatus = (event) => {
        if (!event) {
          return;
        }
        if (event.type === 'keydown') {
          const key = event.key || '';
          if (key !== 'Enter' && key !== ' ') {
            return;
          }
          event.preventDefault();
        }
        this.openDebug();
      };
      if (this.statusText) {
        this.statusText.addEventListener('click', openDebugFromStatus);
        this.statusText.addEventListener('keydown', openDebugFromStatus);
      }
      if (this.agentStatusText) {
        this.agentStatusText.addEventListener('click', openDebugFromStatus);
        this.agentStatusText.addEventListener('keydown', openDebugFromStatus);
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

      const updateModelPolicy = (patch) => {
        this.state.translationAgentModelPolicy = this.normalizeAgentModelPolicy({
          ...this.state.translationAgentModelPolicy,
          ...(patch || {})
        }, this.state.modelSelection);
        this.state.modelSelection = this.toLegacySelection(this.state.translationAgentModelPolicy);
        this.scheduleSave({
          translationAgentModelPolicy: this.state.translationAgentModelPolicy,
          modelSelection: this.state.modelSelection
        });
        this.renderAgentControls();
      };

      if (this.agentModelPolicyMode) {
        this.agentModelPolicyMode.addEventListener('change', (event) => {
          const mode = event.target && event.target.value === 'fixed' ? 'fixed' : 'auto';
          updateModelPolicy({ mode });
        });
      }

      if (this.agentModelSpeed) {
        this.agentModelSpeed.addEventListener('change', (event) => {
          const speed = Boolean(event.target && event.target.checked);
          updateModelPolicy({ speed });
          if (speed && this.state.translationModelList.length) {
            const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
            const benchCommand = UiProtocol && UiProtocol.Commands
              ? UiProtocol.Commands.BENCHMARK_SELECTED_MODELS
              : 'BENCHMARK_SELECTED_MODELS';
            this.ui.sendUiCommand(benchCommand, {});
          }
        });
      }

      if (this.agentModelPreference) {
        this.agentModelPreference.addEventListener('change', (event) => {
          const value = event.target ? event.target.value : '';
          updateModelPolicy({
            preference: value === 'smartest' || value === 'cheapest' ? value : null
          });
        });
      }

      if (this.agentModelRouteOverride) {
        this.agentModelRouteOverride.addEventListener('change', (event) => {
          updateModelPolicy({
            allowRouteOverride: Boolean(event.target && event.target.checked)
          });
        });
      }

      if (this.agentProfileSelect) {
        this.agentProfileSelect.addEventListener('change', (event) => {
          this.state.translationAgentProfile = this.normalizeAgentProfile(event.target.value);
          this.scheduleSave({ translationAgentProfile: this.state.translationAgentProfile });
          this.renderAgentControls();
        });
      }

      const updateTuning = (patch) => {
        this.state.translationAgentTuning = this.normalizeAgentTuning({
          ...this.state.translationAgentTuning,
          ...(patch || {})
        });
        this.scheduleSave({ translationAgentTuning: this.state.translationAgentTuning });
        this.renderAgentControls();
      };

      if (this.agentStyleOverride) {
        this.agentStyleOverride.addEventListener('change', (event) => {
          updateTuning({ styleOverride: event.target.value || 'auto' });
        });
      }
      if (this.agentBatchSizeInput) {
        this.agentBatchSizeInput.addEventListener('input', (event) => {
          updateTuning({ maxBatchSizeOverride: event.target.value });
        });
      }
      if (this.agentProofreadPassesInput) {
        this.agentProofreadPassesInput.addEventListener('input', (event) => {
          updateTuning({ proofreadingPassesOverride: event.target.value });
        });
      }
      if (this.agentParallelismSelect) {
        this.agentParallelismSelect.addEventListener('change', (event) => {
          updateTuning({ parallelismOverride: event.target.value || 'auto' });
        });
      }
      if (this.agentPlannerTemperatureInput) {
        this.agentPlannerTemperatureInput.addEventListener('input', (event) => {
          updateTuning({ plannerTemperature: event.target.value });
        });
      }
      if (this.agentPlannerTokensInput) {
        this.agentPlannerTokensInput.addEventListener('input', (event) => {
          updateTuning({ plannerMaxOutputTokens: event.target.value });
        });
      }
      if (this.agentAuditIntervalInput) {
        this.agentAuditIntervalInput.addEventListener('input', (event) => {
          updateTuning({ auditIntervalMs: event.target.value });
        });
      }
      if (this.agentMandatoryAuditIntervalInput) {
        this.agentMandatoryAuditIntervalInput.addEventListener('input', (event) => {
          updateTuning({ mandatoryAuditIntervalMs: event.target.value });
        });
      }
      if (this.agentCompressionThresholdInput) {
        this.agentCompressionThresholdInput.addEventListener('input', (event) => {
          updateTuning({ compressionThreshold: event.target.value });
        });
      }
      if (this.agentContextLimitInput) {
        this.agentContextLimitInput.addEventListener('input', (event) => {
          updateTuning({ contextFootprintLimit: event.target.value });
        });
      }
      if (this.agentCompressionCooldownInput) {
        this.agentCompressionCooldownInput.addEventListener('input', (event) => {
          updateTuning({ compressionCooldownMs: event.target.value });
        });
      }

      if (this.pipelineEnabledCheckbox) {
        this.pipelineEnabledCheckbox.addEventListener('change', (event) => {
          this.state.translationPipelineEnabled = Boolean(event.target && event.target.checked);
          this.scheduleSave({ translationPipelineEnabled: this.state.translationPipelineEnabled });
          this.renderStatus();
        });
      }

      if (this.agentCategoryModeSelect) {
        this.agentCategoryModeSelect.addEventListener('change', (event) => {
          const mode = this.normalizeCategoryMode(event.target ? event.target.value : 'all');
          this.state.translationCategoryMode = mode;
          let nextCategoryList = this.state.translationCategoryList;
          if (mode === 'custom' && !this.normalizeCategoryList(nextCategoryList).length) {
            nextCategoryList = CATEGORY_OPTIONS.map((item) => item.id);
            this.state.translationCategoryList = nextCategoryList.slice();
          }
          this.scheduleSave({
            translationCategoryMode: mode,
            translationCategoryList: this.normalizeCategoryList(nextCategoryList)
          });
          this.renderAgentControls();
        });
      }

      if (this.agentCategoryDefaultsRoot) {
        this.agentCategoryDefaultsRoot.addEventListener('change', (event) => {
          const target = event.target;
          if (!target || target.type !== 'checkbox' || this.state.translationCategoryMode !== 'custom') {
            return;
          }
          const list = new Set(this.normalizeCategoryList(this.state.translationCategoryList));
          if (target.checked) {
            list.add(target.value);
          } else {
            list.delete(target.value);
          }
          this.state.translationCategoryList = this.normalizeCategoryList(Array.from(list));
          this.scheduleSave({ translationCategoryList: this.state.translationCategoryList });
          this.renderCategorySettingsControls();
          this.renderAgentMiniStatuses();
        });
      }

      if (this.cacheEnabledCheckbox) {
        this.cacheEnabledCheckbox.addEventListener('change', (event) => {
          this.state.translationPageCacheEnabled = Boolean(event.target.checked);
          this.scheduleSave({ translationPageCacheEnabled: this.state.translationPageCacheEnabled });
        });
      }
      if (this.apiCacheEnabledCheckbox) {
        this.apiCacheEnabledCheckbox.addEventListener('change', (event) => {
          this.state.translationApiCacheEnabled = Boolean(event.target.checked);
          this.scheduleSave({ translationApiCacheEnabled: this.state.translationApiCacheEnabled });
        });
      }

      if (this.agentToolsRoot) {
        this.agentToolsRoot.addEventListener('change', (event) => {
          const target = event.target;
          if (!target || target.tagName !== 'SELECT') {
            return;
          }
          const key = target.getAttribute('data-tool-key');
          if (!key || !Object.prototype.hasOwnProperty.call(DEFAULT_AGENT_TOOLS, key)) {
            return;
          }
          const mode = target.value === 'on' || target.value === 'off' || target.value === 'auto'
            ? target.value
            : DEFAULT_AGENT_TOOLS[key];
          this.state.translationAgentTools = {
            ...this.state.translationAgentTools,
            [key]: mode
          };
          this.scheduleSave({ translationAgentTools: this.state.translationAgentTools });
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

      if (this.categoryChooserList) {
        this.categoryChooserList.addEventListener('change', (event) => {
          const target = event.target;
          if (!target || target.type !== 'checkbox') {
            return;
          }
          const list = new Set(this.state.categorySelectionDraft || []);
          if (target.checked) {
            list.add(target.value);
          } else {
            list.delete(target.value);
          }
          this.state.categorySelectionDraft = this.normalizeCategoryList(Array.from(list));
          this.updateActionButtons();
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

      if (this.clearButton) {
        this.clearButton.addEventListener('click', () => this.clearTranslationData());
      }

      if (Array.isArray(this.popupTabButtons) && this.popupTabButtons.length) {
        this.popupTabButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const tabId = this.normalizePopupTab(button.getAttribute('data-tab'));
            this.state.translationPopupActiveTab = tabId;
            this.scheduleSave({ translationPopupActiveTab: tabId });
            this.renderTabs();
          });
        });
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
      if (Object.prototype.hasOwnProperty.call(settings, 'translationAgentModelPolicy')) {
        this.state.translationAgentModelPolicy = this.normalizeAgentModelPolicy(
          settings.translationAgentModelPolicy,
          this.state.modelSelection
        );
        this.state.modelSelection = this.toLegacySelection(this.state.translationAgentModelPolicy);
      } else {
        this.state.translationAgentModelPolicy = this.normalizeAgentModelPolicy(
          this.state.translationAgentModelPolicy,
          this.state.modelSelection
        );
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationPipelineEnabled')) {
        this.state.translationPipelineEnabled = Boolean(settings.translationPipelineEnabled);
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationAgentProfile')) {
        this.state.translationAgentProfile = this.normalizeAgentProfile(settings.translationAgentProfile);
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationAgentTools')) {
        this.state.translationAgentTools = this.normalizeAgentTools(settings.translationAgentTools);
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationAgentTuning')) {
        this.state.translationAgentTuning = this.normalizeAgentTuning(settings.translationAgentTuning);
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationCategoryMode')) {
        this.state.translationCategoryMode = this.normalizeCategoryMode(settings.translationCategoryMode);
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationCategoryList')) {
        this.state.translationCategoryList = this.normalizeCategoryList(settings.translationCategoryList);
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationPageCacheEnabled')) {
        this.state.translationPageCacheEnabled = settings.translationPageCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationApiCacheEnabled')) {
        this.state.translationApiCacheEnabled = settings.translationApiCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationPopupActiveTab')) {
        this.state.translationPopupActiveTab = this.normalizePopupTab(settings.translationPopupActiveTab);
      }

      if (payload.tabId !== null && payload.tabId !== undefined) {
        this.activeTabId = payload.tabId;
      }

      const visibilityMap = payload.translationVisibilityByTab || {};
      if (this.activeTabId !== null && Object.prototype.hasOwnProperty.call(visibilityMap, this.activeTabId)) {
        this.state.translationVisible = visibilityMap[this.activeTabId] !== false;
      }
      if (payload.translationStatusByTab && typeof payload.translationStatusByTab === 'object') {
        this.state.translationStatusByTab = payload.translationStatusByTab;
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
        this.state.selectedCategories = this.normalizeCategoryList(payload.selectedCategories);
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'availableCategories')) {
        this.state.availableCategories = this.normalizeCategoryList(payload.availableCategories);
      }
      this._syncCategoryDataFromJob();
      this._syncCategoryDataFromStatus(payload.translationStatusByTab || null);
      this._syncCategoryDraft();

      this.renderSettings();
      this.renderModels();
      this.renderAgentControls();
      this.renderStatus(payload.translationStatusByTab || null);
      this.renderTabs();

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
      if (Object.prototype.hasOwnProperty.call(patch, 'translationAgentModelPolicy')) {
        this.state.translationAgentModelPolicy = this.normalizeAgentModelPolicy(
          patch.translationAgentModelPolicy,
          this.state.modelSelection
        );
        this.state.modelSelection = this.toLegacySelection(this.state.translationAgentModelPolicy);
      } else {
        this.state.translationAgentModelPolicy = this.normalizeAgentModelPolicy(
          this.state.translationAgentModelPolicy,
          this.state.modelSelection
        );
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationAgentProfile')) {
        this.state.translationAgentProfile = this.normalizeAgentProfile(patch.translationAgentProfile);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationAgentTools')) {
        this.state.translationAgentTools = this.normalizeAgentTools(patch.translationAgentTools);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationAgentTuning')) {
        this.state.translationAgentTuning = this.normalizeAgentTuning(patch.translationAgentTuning);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationCategoryMode')) {
        this.state.translationCategoryMode = this.normalizeCategoryMode(patch.translationCategoryMode);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationCategoryList')) {
        this.state.translationCategoryList = this.normalizeCategoryList(patch.translationCategoryList);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationPageCacheEnabled')) {
        this.state.translationPageCacheEnabled = patch.translationPageCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationApiCacheEnabled')) {
        this.state.translationApiCacheEnabled = patch.translationApiCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationPopupActiveTab')) {
        this.state.translationPopupActiveTab = this.normalizePopupTab(patch.translationPopupActiveTab);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationVisibilityByTab') && this.activeTabId !== null) {
        const map = patch.translationVisibilityByTab || {};
        if (Object.prototype.hasOwnProperty.call(map, this.activeTabId)) {
          this.state.translationVisible = map[this.activeTabId] !== false;
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationStatusByTab') && patch.translationStatusByTab && typeof patch.translationStatusByTab === 'object') {
        this.state.translationStatusByTab = patch.translationStatusByTab;
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
        this.state.selectedCategories = this.normalizeCategoryList(patch.selectedCategories);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'availableCategories')) {
        this.state.availableCategories = this.normalizeCategoryList(patch.availableCategories);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationPipelineEnabled')) {
        this.state.translationPipelineEnabled = Boolean(patch.translationPipelineEnabled);
      }
      this._syncCategoryDataFromJob();
      this._syncCategoryDataFromStatus(patch.translationStatusByTab || null);
      this._syncCategoryDraft();

      this.renderSettings();
      this.renderModels();
      this.renderAgentControls();
      this.renderStatus(patch.translationStatusByTab || null);
      this.renderTabs();
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
      if (this.activeTabId === null) {
        return;
      }
      if (!this.state.translationPipelineEnabled) {
        this.state.translationPipelineEnabled = true;
        this.scheduleSave({ translationPipelineEnabled: true });
        this.renderAgentControls();
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const categorySelectionStep = this._isCategorySelectionStep();
      if (categorySelectionStep) {
        const categories = this._currentCategoryDraft();
        if (!categories.length) {
          return;
        }
        const command = UiProtocol && UiProtocol.Commands
          ? UiProtocol.Commands.SET_TRANSLATION_CATEGORIES
          : 'SET_TRANSLATION_CATEGORIES';
        const jobId = this.state.translationJob && this.state.translationJob.id
          ? this.state.translationJob.id
          : null;
        this.ui.sendUiCommand(command, {
          tabId: this.activeTabId,
          jobId,
          categories
        });
        return;
      }
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

    async clearTranslationData() {
      if (this.activeTabId === null) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.CLEAR_TRANSLATION_DATA
        : 'CLEAR_TRANSLATION_DATA';
      this.ui.sendUiCommand(command, {
        tabId: this.activeTabId,
        includeCache: true
      });
      this.state.translationJob = null;
      this.state.translationProgress = 0;
      this.state.failedBlocksCount = 0;
      this.state.lastError = null;
      this.state.agentState = null;
      this.state.selectedCategories = [];
      this.state.availableCategories = [];
      this.state.categorySelectionDraft = [];
      this.state.categorySelectionDraftJobId = null;
      this.renderStatus();
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

    normalizeAgentProfile(value) {
      if (value === 'balanced' || value === 'literal' || value === 'readable' || value === 'technical') {
        return value;
      }
      return 'auto';
    }

    _profileLabel(profile) {
      if (profile === 'balanced') {
        return 'сбаланс.';
      }
      if (profile === 'literal') {
        return 'дословный';
      }
      if (profile === 'readable') {
        return 'читабельный';
      }
      if (profile === 'technical') {
        return 'технический';
      }
      return 'авто';
    }

    _phaseLabel(phase) {
      const raw = String(phase || '').trim().toLowerCase();
      if (raw === 'planned') {
        return 'план готов';
      }
      if (raw === 'running' || raw === 'translating') {
        return 'в работе';
      }
      if (raw === 'awaiting_categories') {
        return 'ожидание категорий';
      }
      if (raw === 'proofreading') {
        return 'вычитка';
      }
      if (raw === 'done') {
        return 'завершено';
      }
      if (raw === 'failed') {
        return 'ошибка';
      }
      if (raw === 'cache_restore') {
        return 'восстановление из кэша';
      }
      if (raw === 'idle') {
        return 'ожидание';
      }
      return phase || '—';
    }

    _jobStatusLabel(status) {
      const raw = String(status || '').trim().toLowerCase();
      if (raw === 'idle') {
        return 'ожидание';
      }
      if (raw === 'preparing') {
        return 'подготовка';
      }
      if (raw === 'awaiting_categories') {
        return 'выбор категорий';
      }
      if (raw === 'running') {
        return 'выполняется';
      }
      if (raw === 'completing') {
        return 'завершение';
      }
      if (raw === 'done') {
        return 'готово';
      }
      if (raw === 'failed') {
        return 'ошибка';
      }
      if (raw === 'cancelled') {
        return 'отменено';
      }
      return status || '—';
    }

    normalizeAgentModelPolicy(input, fallbackSelection) {
      const fallback = this.ui.normalizeSelection(fallbackSelection, null);
      const source = input && typeof input === 'object' ? input : {};
      const hasSpeed = Object.prototype.hasOwnProperty.call(source, 'speed');
      return {
        mode: source.mode === 'fixed' ? 'fixed' : 'auto',
        speed: hasSpeed ? source.speed !== false : fallback.speed !== false,
        preference: source.preference === 'smartest' || source.preference === 'cheapest'
          ? source.preference
          : fallback.preference,
        allowRouteOverride: source.allowRouteOverride !== false
      };
    }

    toLegacySelection(modelPolicy) {
      const normalized = this.normalizeAgentModelPolicy(modelPolicy, this.state && this.state.modelSelection ? this.state.modelSelection : null);
      return {
        speed: normalized.speed !== false,
        preference: normalized.preference
      };
    }

    normalizeCategoryMode(value) {
      if (value === 'content' || value === 'interface' || value === 'meta' || value === 'custom') {
        return value;
      }
      return 'all';
    }

    normalizeCategoryList(input) {
      const allowed = new Set(CATEGORY_OPTIONS.map((item) => item.id));
      if (!Array.isArray(input)) {
        return [];
      }
      const seen = new Set();
      const out = [];
      input.forEach((item) => {
        const key = String(item || '').trim().toLowerCase();
        if (!key || !allowed.has(key) || seen.has(key)) {
          return;
        }
        seen.add(key);
        out.push(key);
      });
      return out;
    }

    normalizeAgentTools(input) {
      const source = input && typeof input === 'object' ? input : {};
      const out = {};
      AGENT_TOOLS.forEach((tool) => {
        const raw = source[tool.key];
        out[tool.key] = raw === 'on' || raw === 'off' || raw === 'auto'
          ? raw
          : DEFAULT_AGENT_TOOLS[tool.key];
      });
      return out;
    }

    normalizeAgentTuning(input) {
      const source = input && typeof input === 'object' ? input : {};
      const normalizeToken = (value, allowed, fallback) => {
        const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
        return allowed.includes(raw) ? raw : fallback;
      };
      const normalizeNullableInt = (value, min, max = null) => {
        if (value === null || value === undefined || value === '' || value === 'auto') {
          return null;
        }
        if (!Number.isFinite(Number(value))) {
          return null;
        }
        const numeric = Math.round(Number(value));
        const floorApplied = Math.max(min, numeric);
        const hasMax = max !== null && max !== undefined && Number.isFinite(Number(max));
        return hasMax
          ? Math.min(Number(max), floorApplied)
          : floorApplied;
      };
      const normalizeNumber = (value, min, max = null, fallback) => {
        if (!Number.isFinite(Number(value))) {
          return fallback;
        }
        const numeric = Number(value);
        const floorApplied = Math.max(min, numeric);
        const hasMax = max !== null && max !== undefined && Number.isFinite(Number(max));
        return hasMax
          ? Math.min(Number(max), floorApplied)
          : floorApplied;
      };

      return {
        styleOverride: normalizeToken(source.styleOverride, ['auto', 'balanced', 'literal', 'readable', 'technical'], LOCAL_AGENT_TUNING_DEFAULTS.styleOverride),
        maxBatchSizeOverride: normalizeNullableInt(source.maxBatchSizeOverride, 1),
        proofreadingPassesOverride: normalizeNullableInt(source.proofreadingPassesOverride, 0),
        parallelismOverride: normalizeToken(source.parallelismOverride, ['auto', 'low', 'mixed', 'high'], LOCAL_AGENT_TUNING_DEFAULTS.parallelismOverride),
        plannerTemperature: normalizeNumber(source.plannerTemperature, 0, null, LOCAL_AGENT_TUNING_DEFAULTS.plannerTemperature),
        plannerMaxOutputTokens: Math.round(normalizeNumber(source.plannerMaxOutputTokens, 1, null, LOCAL_AGENT_TUNING_DEFAULTS.plannerMaxOutputTokens)),
        auditIntervalMs: Math.round(normalizeNumber(source.auditIntervalMs, 0, null, LOCAL_AGENT_TUNING_DEFAULTS.auditIntervalMs)),
        mandatoryAuditIntervalMs: Math.round(normalizeNumber(source.mandatoryAuditIntervalMs, 0, null, LOCAL_AGENT_TUNING_DEFAULTS.mandatoryAuditIntervalMs)),
        compressionThreshold: Math.round(normalizeNumber(source.compressionThreshold, 0, null, LOCAL_AGENT_TUNING_DEFAULTS.compressionThreshold)),
        contextFootprintLimit: Math.round(normalizeNumber(source.contextFootprintLimit, 1, null, LOCAL_AGENT_TUNING_DEFAULTS.contextFootprintLimit)),
        compressionCooldownMs: Math.round(normalizeNumber(source.compressionCooldownMs, 0, null, LOCAL_AGENT_TUNING_DEFAULTS.compressionCooldownMs))
      };
    }

    normalizePopupTab(input) {
      const raw = typeof input === 'string' ? input.trim().toLowerCase() : '';
      return POPUP_TAB_IDS.includes(raw) ? raw : POPUP_DEFAULT_TAB;
    }

    renderAgentControls() {
      if (this.agentProfileSelect) {
        this.agentProfileSelect.value = this.normalizeAgentProfile(this.state.translationAgentProfile);
      }
      const modelPolicy = this.normalizeAgentModelPolicy(
        this.state.translationAgentModelPolicy,
        this.state.modelSelection
      );
      this.state.translationAgentModelPolicy = modelPolicy;
      this.state.modelSelection = this.toLegacySelection(modelPolicy);
      if (this.agentModelPolicyMode) {
        this.agentModelPolicyMode.value = modelPolicy.mode;
      }
      if (this.agentModelSpeed) {
        this.agentModelSpeed.checked = modelPolicy.speed !== false;
      }
      if (this.agentModelPreference) {
        this.agentModelPreference.value = modelPolicy.preference || 'none';
      }
      if (this.agentModelRouteOverride) {
        this.agentModelRouteOverride.checked = modelPolicy.allowRouteOverride !== false;
      }
      const tuning = this.normalizeAgentTuning(this.state.translationAgentTuning);
      this.state.translationAgentTuning = tuning;
      if (this.agentStyleOverride) {
        this.agentStyleOverride.value = tuning.styleOverride;
      }
      if (this.agentBatchSizeInput) {
        const hasBatchOverride = tuning.maxBatchSizeOverride !== null
          && tuning.maxBatchSizeOverride !== undefined
          && Number.isFinite(Number(tuning.maxBatchSizeOverride));
        this.agentBatchSizeInput.value = hasBatchOverride
          ? String(tuning.maxBatchSizeOverride)
          : '';
      }
      if (this.agentProofreadPassesInput) {
        const hasProofreadOverride = tuning.proofreadingPassesOverride !== null
          && tuning.proofreadingPassesOverride !== undefined
          && Number.isFinite(Number(tuning.proofreadingPassesOverride));
        this.agentProofreadPassesInput.value = hasProofreadOverride
          ? String(tuning.proofreadingPassesOverride)
          : '';
      }
      if (this.agentParallelismSelect) {
        this.agentParallelismSelect.value = tuning.parallelismOverride;
      }
      if (this.agentPlannerTemperatureInput) {
        this.agentPlannerTemperatureInput.value = String(tuning.plannerTemperature);
      }
      if (this.agentPlannerTokensInput) {
        this.agentPlannerTokensInput.value = String(tuning.plannerMaxOutputTokens);
      }
      if (this.agentAuditIntervalInput) {
        this.agentAuditIntervalInput.value = String(tuning.auditIntervalMs);
      }
      if (this.agentMandatoryAuditIntervalInput) {
        this.agentMandatoryAuditIntervalInput.value = String(tuning.mandatoryAuditIntervalMs);
      }
      if (this.agentCompressionThresholdInput) {
        this.agentCompressionThresholdInput.value = String(tuning.compressionThreshold);
      }
      if (this.agentContextLimitInput) {
        this.agentContextLimitInput.value = String(tuning.contextFootprintLimit);
      }
      if (this.agentCompressionCooldownInput) {
        this.agentCompressionCooldownInput.value = String(tuning.compressionCooldownMs);
      }
      if (this.pipelineEnabledCheckbox) {
        this.pipelineEnabledCheckbox.checked = this.state.translationPipelineEnabled === true;
      }
      if (this.cacheEnabledCheckbox) {
        this.cacheEnabledCheckbox.checked = this.state.translationPageCacheEnabled !== false;
      }
      if (this.apiCacheEnabledCheckbox) {
        this.apiCacheEnabledCheckbox.checked = this.state.translationApiCacheEnabled !== false;
      }
      this.renderToolControls();
      this.renderCategorySettingsControls();
      this.renderProfileImpactPreview();
      this.renderAgentMiniStatuses();
      this.renderRuntimeCategoryChooser();
    }

    renderRuntimeCategoryChooser() {
      if (!this.categoryChooserSection || !this.categoryChooserList || !this.categoryChooserHint) {
        return;
      }
      const visible = this._isCategorySelectionStep();
      this.categoryChooserSection.hidden = !visible;
      if (!visible) {
        this.categoryChooserList.innerHTML = '';
        return;
      }
      const available = this._currentAvailableCategories();
      const selected = new Set(this._currentCategoryDraft());
      this.categoryChooserHint.textContent = this._categoryChooserHintText();
      this.categoryChooserList.innerHTML = '';
      available.forEach((category) => {
        const option = CATEGORY_OPTIONS.find((item) => item.id === category) || { id: category, label: category };
        const label = this.doc.createElement('label');
        label.className = 'popup__checkbox';

        const input = this.doc.createElement('input');
        input.type = 'checkbox';
        input.value = option.id;
        input.checked = selected.has(option.id);

        const text = this.doc.createElement('span');
        text.textContent = option.label;

        label.appendChild(input);
        label.appendChild(text);
        this.categoryChooserList.appendChild(label);
      });
    }

    renderCategorySettingsControls() {
      if (!this.agentCategoryModeSelect || !this.agentCategoryDefaultsRoot || !this.agentCategoryModeHint) {
        return;
      }
      const mode = this.normalizeCategoryMode(this.state.translationCategoryMode);
      this.state.translationCategoryMode = mode;
      this.agentCategoryModeSelect.value = mode;
      this.agentCategoryModeHint.textContent = this._categoryModeHint(mode);
      const selectedCustom = new Set(this.normalizeCategoryList(this.state.translationCategoryList));
      const selectedByMode = new Set(this._categoriesForMode(mode, selectedCustom));
      const customMode = mode === 'custom';

      this.agentCategoryDefaultsRoot.innerHTML = '';
      CATEGORY_OPTIONS.forEach((option) => {
        const label = this.doc.createElement('label');
        label.className = `popup__checkbox${customMode ? '' : ' popup__checkbox--disabled'}`;

        const input = this.doc.createElement('input');
        input.type = 'checkbox';
        input.value = option.id;
        input.checked = selectedByMode.has(option.id);
        input.disabled = !customMode;

        const text = this.doc.createElement('span');
        text.textContent = option.label;

        label.appendChild(input);
        label.appendChild(text);
        this.agentCategoryDefaultsRoot.appendChild(label);
      });
    }

    _categoriesForMode(mode, customSet) {
      if (mode === 'custom') {
        const custom = customSet && customSet.size
          ? Array.from(customSet)
          : CATEGORY_OPTIONS.map((item) => item.id);
        return this.normalizeCategoryList(custom);
      }
      const fromGroup = CATEGORY_MODE_GROUPS[mode] || CATEGORY_MODE_GROUPS.all;
      return this.normalizeCategoryList(fromGroup);
    }

    _categoryModeLabel(mode) {
      if (mode === 'content') {
        return 'контент';
      }
      if (mode === 'interface') {
        return 'интерфейс';
      }
      if (mode === 'meta') {
        return 'мета';
      }
      if (mode === 'custom') {
        return 'кастом';
      }
      return 'всё';
    }

    _categoryModeHint(mode) {
      if (mode === 'content') {
        return 'Будут выбраны контентные категории: заголовки, абзацы, списки, таблицы, цитаты и код.';
      }
      if (mode === 'interface') {
        return 'Будут выбраны UI-категории: кнопки, подписи и навигация.';
      }
      if (mode === 'meta') {
        return 'Будет выбрана только meta-категория.';
      }
      if (mode === 'custom') {
        return 'Выберите собственный набор категорий (можно изменить в любой момент).';
      }
      return 'Будут выбраны все категории, обнаруженные на странице.';
    }

    renderToolControls() {
      if (!this.agentToolsRoot) {
        return;
      }
      this.agentToolsRoot.innerHTML = '';
      AGENT_TOOLS.forEach((tool) => {
        const row = this.doc.createElement('div');
        row.className = 'popup__tool-row';

        const label = this.doc.createElement('label');
        label.textContent = tool.label;
        if (tool.hint) {
          label.setAttribute('title', tool.hint);
        }

        const select = this.doc.createElement('select');
        select.setAttribute('data-tool-key', tool.key);
        if (tool.hint) {
          select.setAttribute('title', tool.hint);
        }
        ['auto', 'on', 'off'].forEach((mode) => {
          const opt = this.doc.createElement('option');
          opt.value = mode;
          opt.textContent = mode === 'on'
            ? 'ВКЛ'
            : mode === 'off'
              ? 'ВЫКЛ'
              : 'АВТО';
          select.appendChild(opt);
        });
        select.value = this.state.translationAgentTools[tool.key] || DEFAULT_AGENT_TOOLS[tool.key];

        row.appendChild(label);
        row.appendChild(select);
        this.agentToolsRoot.appendChild(row);
      });
    }

    renderAgentMiniStatuses() {
      if (!this.agentMiniStatuses) {
        return;
      }
      const profile = this.normalizeAgentProfile(this.state.translationAgentProfile);
      const policy = this.normalizeAgentModelPolicy(this.state.translationAgentModelPolicy, this.state.modelSelection);
      const tuning = this.normalizeAgentTuning(this.state.translationAgentTuning);
      const preferenceLabel = policy.preference === 'smartest'
        ? 'умные'
        : policy.preference === 'cheapest'
          ? 'дешёвые'
          : 'без';
      const toolValues = Object.values(this.state.translationAgentTools || {});
      const autoTools = toolValues.filter((value) => value === 'auto').length;
      const onTools = toolValues.filter((value) => value === 'on').length;
      const offTools = toolValues.filter((value) => value === 'off').length;
      const categoryMode = this.normalizeCategoryMode(this.state.translationCategoryMode);
      const customCount = this.normalizeCategoryList(this.state.translationCategoryList).length;
      const entries = [
        {
          text: `Профиль: ${this._profileLabel(profile)}`,
          title: 'Текущий профиль поведения переводчика-агента'
        },
        {
          text: `Пайплайн: ${this.state.translationPipelineEnabled ? 'вкл' : 'выкл'}`,
          title: 'Глобальное состояние запуска переводческого пайплайна'
        },
        {
          text: `Категории: ${this._categoryModeLabel(categoryMode)}${categoryMode === 'custom' ? ` (${customCount})` : ''}`,
          title: 'Базовая стратегия выбора категорий до первого планирования'
        },
        {
          text: `Модели: ${policy.mode === 'fixed' ? 'фикс.' : 'авто'}/${preferenceLabel}`,
          title: 'Активная модельная политика агента'
        },
        {
          text: `Маршрут: ${policy.allowRouteOverride ? 'вкл' : 'выкл'}`,
          title: 'Разрешено ли агенту форсировать fast/strong маршрут'
        },
        {
          text: `Инстр.: auto=${autoTools} on=${onTools} off=${offTools}`,
          title: 'Распределение режимов инструментов агента'
        },
        {
          text: `Планер: t=${tuning.plannerTemperature} tok=${tuning.plannerMaxOutputTokens}`,
          title: 'Текущие параметры шага планирования'
        },
        {
          text: `Аудит: ${tuning.auditIntervalMs}/${tuning.mandatoryAuditIntervalMs}мс`,
          title: 'Обычный и обязательный интервалы аудита'
        },
        {
          text: `Контекст: ${tuning.compressionThreshold}@${tuning.contextFootprintLimit}`,
          title: 'Порог автосжатия и лимит размера контекста'
        }
      ];
      this.agentMiniStatuses.innerHTML = '';
      entries.forEach((item) => {
        const chip = this.doc.createElement('span');
        chip.className = 'popup__mini-status';
        chip.textContent = item.text;
        chip.setAttribute('title', item.title);
        this.agentMiniStatuses.appendChild(chip);
      });
    }

    renderProfileImpactPreview() {
      if (!this.agentProfileImpactRoot) {
        return;
      }
      const preview = this.buildAgentProfilePreview();
      const lines = [
        { label: 'Стиль', value: this._previewValue(preview, 'style') },
        { label: 'Размер батча', value: this._previewValue(preview, 'maxBatchSize') },
        { label: 'Проходы вычитки', value: this._previewValue(preview, 'proofreadingPasses') },
        { label: 'Параллелизм', value: this._previewValue(preview, 'parallelism') },
        { label: 'Температура планировщика', value: `${preview.tuning.plannerTemperature}` },
        { label: 'Лимит токенов планировщика', value: `${preview.tuning.plannerMaxOutputTokens}` },
        { label: 'Интервал аудита', value: `${preview.runtime.auditIntervalMs}мс` },
        { label: 'Обязательный аудит', value: `${preview.runtime.mandatoryAuditIntervalMs}мс` },
        { label: 'Порог сжатия', value: `${preview.runtime.compressionThreshold}` },
        { label: 'Лимит контекста', value: `${preview.runtime.contextFootprintLimit}` },
        { label: 'Пауза между сжатиями', value: `${preview.runtime.compressionCooldownMs}мс` }
      ];

      this.agentProfileImpactRoot.innerHTML = '';
      lines.forEach((item) => {
        const row = this.doc.createElement('div');
        row.className = 'popup__impact-row';

        const label = this.doc.createElement('strong');
        label.textContent = item.label;

        const value = this.doc.createElement('code');
        value.textContent = item.value;

        row.appendChild(label);
        row.appendChild(value);
        this.agentProfileImpactRoot.appendChild(row);
      });
    }

    buildAgentProfilePreview() {
      const profile = this.normalizeAgentProfile(this.state.translationAgentProfile);
      const tuning = this.normalizeAgentTuning(this.state.translationAgentTuning);
      const TranslationAgent = global.NT && global.NT.TranslationAgent ? global.NT.TranslationAgent : null;
      if (TranslationAgent && typeof TranslationAgent.previewResolvedSettings === 'function') {
        const resolved = TranslationAgent.previewResolvedSettings({
          settings: {
            translationAgentProfile: profile,
            translationAgentTuning: tuning
          },
          pageStats: null
        });
        return {
          base: resolved && resolved.baseProfile ? resolved.baseProfile : (LOCAL_PROFILE_PRESETS[profile] || LOCAL_PROFILE_PRESETS.auto),
          effective: resolved && resolved.effectiveProfile ? resolved.effectiveProfile : (LOCAL_PROFILE_PRESETS[profile] || LOCAL_PROFILE_PRESETS.auto),
          tuning,
          runtime: resolved && resolved.runtimeTuning ? resolved.runtimeTuning : {
            auditIntervalMs: tuning.auditIntervalMs,
            mandatoryAuditIntervalMs: tuning.mandatoryAuditIntervalMs,
            compressionThreshold: tuning.compressionThreshold,
            contextFootprintLimit: tuning.contextFootprintLimit,
            compressionCooldownMs: tuning.compressionCooldownMs
          }
        };
      }

      const base = LOCAL_PROFILE_PRESETS[profile] || LOCAL_PROFILE_PRESETS.auto;
      const effective = {
        ...base,
        style: tuning.styleOverride === 'auto' ? base.style : tuning.styleOverride,
        maxBatchSize: Number.isFinite(Number(tuning.maxBatchSizeOverride)) ? tuning.maxBatchSizeOverride : base.maxBatchSize,
        proofreadingPasses: Number.isFinite(Number(tuning.proofreadingPassesOverride)) ? tuning.proofreadingPassesOverride : base.proofreadingPasses,
        parallelism: tuning.parallelismOverride === 'auto' ? base.parallelism : tuning.parallelismOverride
      };
      return {
        base,
        effective,
        tuning,
        runtime: {
          auditIntervalMs: tuning.auditIntervalMs,
          mandatoryAuditIntervalMs: tuning.mandatoryAuditIntervalMs,
          compressionThreshold: tuning.compressionThreshold,
          contextFootprintLimit: tuning.contextFootprintLimit,
          compressionCooldownMs: tuning.compressionCooldownMs
        }
      };
    }

    _previewValue(preview, key) {
      const base = preview && preview.base && Object.prototype.hasOwnProperty.call(preview.base, key)
        ? preview.base[key]
        : 'auto';
      const effective = preview && preview.effective && Object.prototype.hasOwnProperty.call(preview.effective, key)
        ? preview.effective[key]
        : base;
      const baseText = this._humanizePreviewToken(base);
      const effectiveText = this._humanizePreviewToken(effective);
      const tuning = preview && preview.tuning ? preview.tuning : {};
      const isAutoProfile = this.normalizeAgentProfile(this.state.translationAgentProfile) === 'auto';
      const hasOverride = (
        (key === 'style' && tuning.styleOverride && tuning.styleOverride !== 'auto')
        || (key === 'maxBatchSize' && Number.isFinite(Number(tuning.maxBatchSizeOverride)))
        || (key === 'proofreadingPasses' && Number.isFinite(Number(tuning.proofreadingPassesOverride)))
        || (key === 'parallelism' && tuning.parallelismOverride && tuning.parallelismOverride !== 'auto')
      );
      if (isAutoProfile && !hasOverride) {
        return `адаптивно (база: ${effectiveText})`;
      }
      return baseText === effectiveText
        ? effectiveText
        : `${effectiveText} (профиль: ${baseText})`;
    }

    _humanizePreviewToken(value) {
      if (value === null || value === undefined) {
        return 'авто';
      }
      const raw = String(value);
      const lower = raw.toLowerCase();
      if (lower === 'auto') {
        return 'авто';
      }
      if (lower === 'balanced') {
        return 'сбалансированный';
      }
      if (lower === 'literal') {
        return 'дословный';
      }
      if (lower === 'readable') {
        return 'читабельный';
      }
      if (lower === 'technical') {
        return 'технический';
      }
      if (lower === 'low') {
        return 'низкий';
      }
      if (lower === 'mixed') {
        return 'смешанный';
      }
      if (lower === 'high') {
        return 'высокий';
      }
      return raw;
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
        empty.textContent = 'Нет доступных моделей в реестре';
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
          rawTier,
          sum_1M: Number.isFinite(Number(entry.sum_1M)) ? Number(entry.sum_1M) : null,
          inputPrice: Number.isFinite(Number(entry.inputPrice)) ? Number(entry.inputPrice) : null,
          outputPrice: Number.isFinite(Number(entry.outputPrice)) ? Number(entry.outputPrice) : null,
          cachedInputPrice: Number.isFinite(Number(entry.cachedInputPrice)) ? Number(entry.cachedInputPrice) : null
        });
      });

      const pricingStats = this._buildSelectedPricingStats(options);
      const pricingSummary = this.doc.createElement('div');
      pricingSummary.className = 'popup__models-price-summary';
      if (pricingStats.selectedCount > 0) {
        const totalText = pricingStats.knownCount > 0
          ? this._formatUsdPrice(pricingStats.sum)
          : 'н/д';
        pricingSummary.textContent = `Выбрано моделей: ${pricingStats.selectedCount} | Σ цена за 1M токенов: ${totalText}`;
      } else {
        pricingSummary.textContent = 'Выберите модели, чтобы видеть суммарную цену за 1M токенов.';
      }
      pricingSummary.setAttribute('title', 'Σ цена = input + output за 1M токенов для выбранных моделей');
      this.modelsRoot.appendChild(pricingSummary);

      const sections = [
        { key: 'flex', title: 'ГИБКИЕ' },
        { key: 'standard', title: 'СТАНДАРТНЫЕ' },
        { key: 'priority', title: 'ПРИОРИТЕТНЫЕ' },
        { key: 'other', title: 'ПРОЧИЕ' }
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
          text.className = 'popup__model-text';
          const name = this.doc.createElement('span');
          name.className = 'popup__model-name';
          const safe = Html ? Html.safeText(entry.id, '—') : entry.id;
          name.textContent = safe;
          const price = this.doc.createElement('span');
          price.className = 'popup__model-price';
          price.textContent = this._formatModelTotalPriceText(entry);
          price.setAttribute('title', this._formatModelPriceTooltip(entry));
          text.appendChild(name);
          text.appendChild(price);

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
        empty.textContent = 'Нет доступных моделей в реестре';
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

    _buildSelectedPricingStats(options) {
      const selected = new Set(Array.isArray(this.state.translationModelList) ? this.state.translationModelList : []);
      let selectedCount = 0;
      let knownCount = 0;
      let sum = 0;
      (Array.isArray(options) ? options : []).forEach((entry) => {
        if (!entry || !entry.id) {
          return;
        }
        const tier = entry.tier || 'standard';
        const spec = `${entry.id}:${tier}`;
        if (!selected.has(spec)) {
          return;
        }
        selectedCount += 1;
        const price = Number.isFinite(Number(entry.sum_1M)) ? Number(entry.sum_1M) : null;
        if (price === null) {
          return;
        }
        knownCount += 1;
        sum += price;
      });
      return { selectedCount, knownCount, sum };
    }

    _formatUsdPrice(value) {
      if (!Number.isFinite(Number(value))) {
        return 'н/д';
      }
      const numeric = Number(value);
      const abs = Math.abs(numeric);
      const precision = abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
      return `$${numeric.toFixed(precision)}`;
    }

    _formatModelTotalPriceText(entry) {
      const total = entry && Number.isFinite(Number(entry.sum_1M)) ? Number(entry.sum_1M) : null;
      if (total === null) {
        return 'Σ 1M: н/д';
      }
      return `Σ 1M: ${this._formatUsdPrice(total)}`;
    }

    _formatModelPriceTooltip(entry) {
      const input = entry && Number.isFinite(Number(entry.inputPrice))
        ? this._formatUsdPrice(Number(entry.inputPrice))
        : 'н/д';
      const output = entry && Number.isFinite(Number(entry.outputPrice))
        ? this._formatUsdPrice(Number(entry.outputPrice))
        : 'н/д';
      const cached = entry && Number.isFinite(Number(entry.cachedInputPrice))
        ? this._formatUsdPrice(Number(entry.cachedInputPrice))
        : 'н/д';
      return `Вход: ${input} / 1M | Выход: ${output} / 1M | Cached input: ${cached} / 1M`;
    }

    renderSettings() {
      if (this.apiKeyInput) {
        this.apiKeyInput.value = this.state.apiKey;
      }
      this.renderAgentControls();
      this.updateActionButtons();
      this.updateVisibilityIcon();
    }

    renderStatus(statusByTab) {
      const Time = global.NT && global.NT.Time ? global.NT.Time : null;
      if (statusByTab && typeof statusByTab === 'object') {
        this.state.translationStatusByTab = statusByTab;
      }
      const entry = statusByTab && this.activeTabId !== null ? statusByTab[this.activeTabId] : null;
      this._syncCategoryDataFromStatus(statusByTab || null);
      this._syncCategoryDraft();
      const job = this.state.translationJob || null;
      const agentState = this.state.agentState || (entry && entry.agentState ? entry.agentState : null);
      let message = '—';
      let progress = 0;
      if (job) {
        message = job.message || job.status || '—';
        progress = Number.isFinite(Number(this.state.translationProgress)) ? Number(this.state.translationProgress) : 0;
        if (this.state.failedBlocksCount > 0) {
          message = `${message} (ошибок: ${this.state.failedBlocksCount})`;
        }
      } else if (entry) {
        progress = typeof entry.progress === 'number'
          ? (Time && typeof Time.clamp === 'function' ? Time.clamp(entry.progress, 0, 100) : Math.max(0, Math.min(100, entry.progress)))
          : 0;
        message = entry.message || entry.status || '—';
      } else if (!this.state.translationPipelineEnabled) {
        message = 'Готов к запуску перевода';
      }
      if (this.state.lastError && this.state.lastError.message) {
        message = `${message} | ${this.state.lastError.message}`;
      }
      if (this.statusText) {
        this.statusText.textContent = message;
        this.statusText.setAttribute('role', 'button');
        this.statusText.setAttribute('tabindex', '0');
        this.statusText.setAttribute('title', 'Нажмите, чтобы открыть страницу отладки');
      }
      if (this.statusProgress) {
        this.statusProgress.value = progress;
      }
      if (this.agentStatusText) {
        const phaseRaw = agentState && agentState.phase ? agentState.phase : '—';
        const profileRaw = agentState && agentState.profile ? agentState.profile : this.state.translationAgentProfile;
        const phase = this._phaseLabel(phaseRaw);
        const profile = this._profileLabel(this.normalizeAgentProfile(profileRaw));
        const categories = Array.isArray(this.state.selectedCategories) && this.state.selectedCategories.length
          ? this.state.selectedCategories.join(', ')
          : (agentState && Array.isArray(agentState.selectedCategories) && agentState.selectedCategories.length
            ? agentState.selectedCategories.join(', ')
            : '—');
        const digest = this._buildAgentDigest(agentState);
        const categoriesText = this._truncateStatusText(categories, 48);
        this.agentStatusText.textContent = `Агент: ${phase} | профиль=${profile} | кат=${categoriesText}${digest ? ` | ${digest}` : ''}`;
        this.agentStatusText.setAttribute('role', 'button');
        this.agentStatusText.setAttribute('tabindex', '0');
        this.agentStatusText.setAttribute('title', 'Нажмите, чтобы открыть страницу отладки');
      }
      this.renderStatusChips({ job, agentState, entry });
      this.renderRuntimeDiagnostics({
        job,
        agentState,
        entry,
        progress,
        message
      });
      this.renderRuntimeCategoryChooser();
      this.updateActionButtons();
      this.renderTabs();
    }

    _forcedPopupTab() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      if (job && job.status === 'awaiting_categories') {
        return 'control';
      }
      const statusMap = this.state.translationStatusByTab && typeof this.state.translationStatusByTab === 'object'
        ? this.state.translationStatusByTab
        : null;
      const entry = statusMap && this.activeTabId !== null ? statusMap[this.activeTabId] : null;
      if (entry && entry.status === 'awaiting_categories') {
        return 'control';
      }
      return null;
    }

    renderTabs() {
      const preferredTab = this.normalizePopupTab(this.state.translationPopupActiveTab);
      this.state.translationPopupActiveTab = preferredTab;
      const forcedTab = this._forcedPopupTab();
      const activeTab = forcedTab || preferredTab;

      if (Array.isArray(this.popupTabButtons)) {
        this.popupTabButtons.forEach((button) => {
          const tabId = this.normalizePopupTab(button.getAttribute('data-tab'));
          const isActive = tabId === activeTab;
          button.classList.toggle('is-active', isActive);
          button.setAttribute('aria-selected', isActive ? 'true' : 'false');
          button.setAttribute('tabindex', isActive ? '0' : '-1');
        });
      }

      if (Array.isArray(this.popupTabPanels)) {
        this.popupTabPanels.forEach((panel) => {
          const panelId = this.normalizePopupTab(panel.getAttribute('data-tab-panel'));
          const isActive = panelId === activeTab;
          panel.hidden = !isActive;
          panel.classList.toggle('is-active', isActive);
          panel.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        });
      }
    }

    renderStatusChips({ job, agentState, entry } = {}) {
      const pipelineText = (() => {
        if (!this.state.translationPipelineEnabled && !job && !entry) {
          return 'Пайплайн: готов';
        }
        if (job && job.status) {
          return `Пайплайн: ${this._jobStatusLabel(job.status)}`;
        }
        if (entry && entry.status) {
          return `Пайплайн: ${this._jobStatusLabel(entry.status)}`;
        }
        return 'Пайплайн: готов';
      })();

      const modelPolicy = this.normalizeAgentModelPolicy(this.state.translationAgentModelPolicy, this.state.modelSelection);
      const preferenceText = modelPolicy.preference === 'smartest'
        ? 'умные'
        : modelPolicy.preference === 'cheapest'
          ? 'дешёвые'
          : 'без приоритета';
      const modelText = `Модели: ${modelPolicy.mode === 'fixed' ? 'фикс.' : 'авто'} / ${preferenceText} / ${modelPolicy.speed ? 'скорость' : 'качество'}`;
      const cacheText = `Кэш: стр=${this.state.translationPageCacheEnabled ? 'вкл' : 'выкл'} · api=${this.state.translationApiCacheEnabled ? 'вкл' : 'выкл'}`;

      if (this.statusChipPipeline) {
        this.statusChipPipeline.textContent = pipelineText;
        this.statusChipPipeline.setAttribute('title', 'Состояние пайплайна перевода на текущей вкладке');
      }
      if (this.statusChipModel) {
        this.statusChipModel.textContent = modelText;
        this.statusChipModel.setAttribute('title', 'Эффективная политика выбора модели для переводчика-агента');
      }
      if (this.statusChipCache) {
        this.statusChipCache.textContent = cacheText;
        this.statusChipCache.setAttribute('title', 'Состояние кэширования перевода страницы и ответов API');
      }

      if (agentState && agentState.modelPolicy && this.statusChipModel) {
        const runtimePolicy = this.normalizeAgentModelPolicy(agentState.modelPolicy, modelPolicy);
        const runtimePreferenceText = runtimePolicy.preference === 'smartest'
          ? 'умные'
          : runtimePolicy.preference === 'cheapest'
            ? 'дешёвые'
            : 'без приоритета';
        this.statusChipModel.textContent = `Модели: факт ${runtimePolicy.mode === 'fixed' ? 'фикс.' : 'авто'} / ${runtimePreferenceText} / ${runtimePolicy.speed ? 'скорость' : 'качество'}`;
      }
    }

    renderRuntimeDiagnostics({ job, agentState, entry, progress, message } = {}) {
      if (!this.statusMetricsRoot && !this.statusTrace) {
        return;
      }
      const safeEntry = entry && typeof entry === 'object' ? entry : {};
      const total = Number.isFinite(Number(job && job.totalBlocks))
        ? Number(job.totalBlocks)
        : (Number.isFinite(Number(safeEntry.total)) ? Number(safeEntry.total) : 0);
      const completed = Number.isFinite(Number(job && job.completedBlocks))
        ? Number(job.completedBlocks)
        : (Number.isFinite(Number(safeEntry.completed)) ? Number(safeEntry.completed) : 0);
      const failed = Number.isFinite(Number(job && job.failedBlocksCount))
        ? Number(job.failedBlocksCount)
        : (Number.isFinite(Number(safeEntry.failedBlocksCount))
          ? Number(safeEntry.failedBlocksCount)
          : (Number.isFinite(Number(this.state.failedBlocksCount)) ? Number(this.state.failedBlocksCount) : 0));
      const inProgress = Number.isFinite(Number(safeEntry.inProgress))
        ? Number(safeEntry.inProgress)
        : Math.max(0, total - completed - failed);

      const selected = this._currentSelectedCategories();
      const available = this._currentAvailableCategories();
      const selectedCount = selected.length;
      const availableCount = available.length || selectedCount;

      const checklist = agentState && Array.isArray(agentState.checklist) ? agentState.checklist : [];
      const checklistDone = checklist.filter((item) => item && item.status === 'done').length;
      const checklistRunning = checklist.filter((item) => item && item.status === 'running').length;
      const checklistFailed = checklist.filter((item) => {
        const status = item && item.status ? String(item.status).toLowerCase() : '';
        return status === 'failed' || status === 'error';
      }).length;
      const checklistPending = Math.max(0, checklist.length - checklistDone - checklistRunning - checklistFailed);

      const audits = agentState && Array.isArray(agentState.audits) ? agentState.audits : [];
      const latestAudit = audits.length ? audits[audits.length - 1] : null;
      const auditCoverage = latestAudit && Number.isFinite(Number(latestAudit.coverage))
        ? `${Math.round(Number(latestAudit.coverage))}%`
        : '—';
      const auditStatus = latestAudit && latestAudit.status ? String(latestAudit.status) : '—';

      const toolHistory = agentState && Array.isArray(agentState.toolHistory) ? agentState.toolHistory : [];
      const toolTrace = agentState && Array.isArray(agentState.toolExecutionTrace) ? agentState.toolExecutionTrace : [];
      const reports = agentState && Array.isArray(agentState.reports) ? agentState.reports : [];
      const diffItems = agentState && Array.isArray(agentState.recentDiffItems)
        ? agentState.recentDiffItems
        : (Array.isArray(safeEntry.recentDiffItems) ? safeEntry.recentDiffItems : []);
      const plan = agentState && agentState.plan && typeof agentState.plan === 'object' ? agentState.plan : null;
      const updatedAt = Number.isFinite(Number(job && job.updatedAt))
        ? Number(job.updatedAt)
        : (Number.isFinite(Number(safeEntry.updatedAt)) ? Number(safeEntry.updatedAt) : null);

      const pipelineStatus = job && job.status
        ? this._jobStatusLabel(job.status)
        : (safeEntry.status ? this._jobStatusLabel(safeEntry.status) : '—');
      const phase = agentState && agentState.phase ? this._phaseLabel(agentState.phase) : '—';
      const profile = agentState && agentState.profile
        ? this._profileLabel(this.normalizeAgentProfile(agentState.profile))
        : this._profileLabel(this.normalizeAgentProfile(this.state.translationAgentProfile));

      const planStyle = plan && plan.style ? String(plan.style) : '—';
      const planBatch = plan && Number.isFinite(Number(plan.batchSize)) ? String(Math.round(Number(plan.batchSize))) : '—';
      const planProof = plan && Number.isFinite(Number(plan.proofreadingPasses)) ? String(Math.round(Number(plan.proofreadingPasses))) : '—';
      const planParallel = plan && plan.parallelism ? String(plan.parallelism) : '—';

      const metrics = [
        {
          label: 'Job ID',
          value: this._shortId(job && job.id ? job.id : ''),
          title: job && job.id ? job.id : 'Идентификатор активной задачи'
        },
        {
          label: 'Пайплайн',
          value: pipelineStatus,
          title: 'Текущее состояние пайплайна перевода'
        },
        {
          label: 'Прогресс',
          value: `${Math.max(0, Math.min(100, Math.round(Number(progress) || 0)))}%`,
          title: 'Текущий процент выполнения'
        },
        {
          label: 'Блоки',
          value: `${completed}/${total} | run=${inProgress} | err=${failed}`,
          title: 'Сводка обработки блоков страницы'
        },
        {
          label: 'Текущий батч',
          value: this._shortId(job && job.currentBatchId ? job.currentBatchId : ''),
          title: job && job.currentBatchId ? job.currentBatchId : 'Идентификатор текущего батча'
        },
        {
          label: 'Агент',
          value: `${phase} | ${profile}`,
          title: 'Текущая фаза и профиль агента'
        },
        {
          label: 'План',
          value: `${planStyle} | b=${planBatch} | p=${planProof} | par=${planParallel}`,
          title: 'Сжатая сводка плана, выбранного агентом'
        },
        {
          label: 'Категории',
          value: `${selectedCount}/${availableCount} | ${this._categoryModeLabel(this.state.translationCategoryMode)}`,
          title: 'Число выбранных категорий к доступным и базовый режим категорий'
        },
        {
          label: 'Аудиты',
          value: `${audits.length} | ${auditStatus} ${auditCoverage}`,
          title: 'Количество аудитов и статус последнего аудита'
        },
        {
          label: 'Чеклист',
          value: `ok=${checklistDone} run=${checklistRunning} wait=${checklistPending}${checklistFailed ? ` err=${checklistFailed}` : ''}`,
          title: 'Состояние задач в чеклисте агента'
        },
        {
          label: 'Инструменты',
          value: `trace=${toolTrace.length} log=${toolHistory.length}`,
          title: 'Трассировка и история вызовов инструментов'
        },
        {
          label: 'Отчёты/DIFF',
          value: `rep=${reports.length} diff=${diffItems.length}`,
          title: 'Количество отчётов агента и последних diff-изменений'
        },
        {
          label: 'Контекст',
          value: `cmp=${Number(agentState && agentState.compressedContextCount || 0)} gls=${Number(agentState && agentState.glossarySize || 0)}`,
          title: 'Сжатия контекста и размер глоссария'
        },
        {
          label: 'Обновлено',
          value: this._formatTimestamp(updatedAt),
          title: 'Время последнего обновления состояния'
        }
      ];

      if (this.statusMetricsRoot) {
        this.statusMetricsRoot.innerHTML = '';
        metrics.forEach((item) => {
          const row = this.doc.createElement('div');
          row.className = 'popup__status-metric';
          if (item.title) {
            row.setAttribute('title', item.title);
          }

          const labelNode = this.doc.createElement('span');
          labelNode.className = 'popup__status-metric-label';
          labelNode.textContent = item.label;

          const valueNode = this.doc.createElement('span');
          valueNode.className = 'popup__status-metric-value';
          valueNode.textContent = item.value && String(item.value).trim() ? String(item.value) : '—';

          row.appendChild(labelNode);
          row.appendChild(valueNode);
          this.statusMetricsRoot.appendChild(row);
        });
      }

      if (this.statusTrace) {
        this.statusTrace.textContent = this._buildRuntimeTrace({
          job,
          agentState,
          message
        });
      }
    }

    _buildRuntimeTrace({ job, agentState, message } = {}) {
      const parts = [];
      if (message) {
        parts.push(`msg: ${this._truncateStatusText(String(message), 64)}`);
      }

      const reports = agentState && Array.isArray(agentState.reports) ? agentState.reports : [];
      const latestReport = reports.length ? reports[reports.length - 1] : null;
      if (latestReport) {
        const reportText = latestReport.body || latestReport.title || latestReport.type || '';
        parts.push(`report: ${this._truncateStatusText(String(reportText || ''), 80)}`);
      }

      const trace = agentState && Array.isArray(agentState.toolExecutionTrace) ? agentState.toolExecutionTrace : [];
      const latestTrace = trace.length ? trace[trace.length - 1] : null;
      if (latestTrace) {
        const tool = latestTrace.tool || 'tool';
        const status = latestTrace.status || 'ok';
        const mode = latestTrace.mode || 'auto';
        const msg = latestTrace.message || '';
        parts.push(`tool: ${tool}[${mode}] ${status}${msg ? ` (${this._truncateStatusText(String(msg), 44)})` : ''}`);
      }

      const audits = agentState && Array.isArray(agentState.audits) ? agentState.audits : [];
      const latestAudit = audits.length ? audits[audits.length - 1] : null;
      if (latestAudit) {
        const coverage = Number.isFinite(Number(latestAudit.coverage)) ? `${Math.round(Number(latestAudit.coverage))}%` : '—';
        parts.push(`audit: ${latestAudit.status || 'unknown'} ${coverage}`);
      }

      const checklist = agentState && Array.isArray(agentState.checklist) ? agentState.checklist : [];
      const runningItem = checklist.find((item) => item && item.status === 'running');
      if (runningItem) {
        parts.push(`step: ${this._truncateStatusText(runningItem.title || runningItem.id || 'running', 52)}`);
      }

      if (job && job.currentBatchId) {
        parts.push(`batch: ${this._shortId(job.currentBatchId, 18)}`);
      }

      return parts.length
        ? parts.join(' | ')
        : 'Подробных live-событий пока нет. После запуска здесь появятся последние отчёты и вызовы инструментов.';
    }

    _shortId(value, limit = 14) {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!raw) {
        return '—';
      }
      const max = Number.isFinite(Number(limit)) ? Number(limit) : 14;
      if (raw.length <= max) {
        return raw;
      }
      return `${raw.slice(0, Math.max(1, max - 1))}…`;
    }

    _formatTimestamp(value) {
      const timestamp = Number(value);
      if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return '—';
      }
      const Time = global.NT && global.NT.Time ? global.NT.Time : null;
      if (Time && typeof Time.formatTime === 'function') {
        return Time.formatTime(timestamp, { fallback: '—' });
      }
      const date = new Date(timestamp);
      if (Number.isNaN(date.getTime())) {
        return '—';
      }
      return date.toLocaleTimeString();
    }

    _buildAgentDigest(agentState) {
      const agent = agentState && typeof agentState === 'object' ? agentState : null;
      if (!agent) {
        return '';
      }
      const reports = Array.isArray(agent.reports) ? agent.reports : [];
      const toolHistory = Array.isArray(agent.toolHistory) ? agent.toolHistory : [];
      const checklist = Array.isArray(agent.checklist) ? agent.checklist : [];

      const latestReport = reports.length ? reports[reports.length - 1] : null;
      if (latestReport) {
        const source = latestReport.body || latestReport.title || '';
        const text = this._truncateStatusText(source, 56);
        if (text) {
          return `заметка=${text}`;
        }
      }

      const latestTool = toolHistory.length ? toolHistory[toolHistory.length - 1] : null;
      if (latestTool) {
        const tool = latestTool.tool || 'tool';
        const msg = latestTool.message || latestTool.status || '';
        const text = this._truncateStatusText(`${tool}:${msg}`, 56);
        if (text) {
          return `инстр=${text}`;
        }
      }

      const running = checklist.find((item) => item && item.status === 'running');
      if (running) {
        const text = this._truncateStatusText(running.title || running.id || 'выполняется', 56);
        if (text) {
          return `шаг=${text}`;
        }
      }
      return '';
    }

    _truncateStatusText(input, limit = 56) {
      const raw = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : '';
      if (!raw) {
        return '';
      }
      const max = Number.isFinite(Number(limit)) ? Number(limit) : 56;
      if (raw.length <= max) {
        return raw;
      }
      return `${raw.slice(0, Math.max(1, max - 1))}…`;
    }

    _syncCategoryDataFromJob() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      if (!job) {
        return;
      }
      if (Array.isArray(job.selectedCategories)) {
        this.state.selectedCategories = this.normalizeCategoryList(job.selectedCategories);
      }
      if (Array.isArray(job.availableCategories)) {
        this.state.availableCategories = this.normalizeCategoryList(job.availableCategories);
      }
    }

    _syncCategoryDataFromStatus(statusByTab) {
      const entry = statusByTab && this.activeTabId !== null ? statusByTab[this.activeTabId] : null;
      if (!entry || typeof entry !== 'object') {
        return;
      }
      if (Array.isArray(entry.selectedCategories)) {
        this.state.selectedCategories = this.normalizeCategoryList(entry.selectedCategories);
      }
      if (Array.isArray(entry.availableCategories)) {
        this.state.availableCategories = this.normalizeCategoryList(entry.availableCategories);
      }
    }

    _syncCategoryDraft() {
      const job = this.state.translationJob || null;
      const jobId = job && job.id ? job.id : null;
      const shouldDraft = this._isCategorySelectionStep();
      if (!shouldDraft) {
        this.state.categorySelectionDraft = [];
        this.state.categorySelectionDraftJobId = null;
        return;
      }
      const available = this._currentAvailableCategories();
      if (!available.length) {
        this.state.categorySelectionDraft = [];
        this.state.categorySelectionDraftJobId = jobId;
        return;
      }
      const currentDraft = this.normalizeCategoryList(this.state.categorySelectionDraft);
      const filteredDraft = currentDraft.filter((category) => available.includes(category));
      if (this.state.categorySelectionDraftJobId !== jobId || !filteredDraft.length) {
        const selected = this._currentSelectedCategories().filter((category) => available.includes(category));
        this.state.categorySelectionDraft = selected.length ? selected : available.slice();
        this.state.categorySelectionDraftJobId = jobId;
        return;
      }
      this.state.categorySelectionDraft = filteredDraft;
      this.state.categorySelectionDraftJobId = jobId;
    }

    _currentSelectedCategories() {
      const selected = this.normalizeCategoryList(this.state.selectedCategories);
      if (selected.length) {
        return selected;
      }
      const job = this.state.translationJob || null;
      if (job && Array.isArray(job.selectedCategories)) {
        return this.normalizeCategoryList(job.selectedCategories);
      }
      const agentState = this.state.agentState || null;
      if (agentState && Array.isArray(agentState.selectedCategories)) {
        return this.normalizeCategoryList(agentState.selectedCategories);
      }
      return [];
    }

    _currentAvailableCategories() {
      const available = this.normalizeCategoryList(this.state.availableCategories);
      if (available.length) {
        return available;
      }
      const job = this.state.translationJob || null;
      if (job && Array.isArray(job.availableCategories)) {
        return this.normalizeCategoryList(job.availableCategories);
      }
      return [];
    }

    _currentCategoryDraft() {
      const available = this._currentAvailableCategories();
      const selected = this.normalizeCategoryList(this.state.categorySelectionDraft);
      const filtered = selected.filter((category) => available.includes(category));
      return filtered;
    }

    _hasUnselectedCategories() {
      const available = this._currentAvailableCategories();
      if (!available.length) {
        return false;
      }
      const selectedSet = new Set(this._currentSelectedCategories());
      return available.some((category) => !selectedSet.has(category));
    }

    _isCategorySelectionStep() {
      const job = this.state.translationJob || null;
      if (!job || !job.status) {
        return false;
      }
      if (job.status === 'awaiting_categories') {
        return this._currentAvailableCategories().length > 0;
      }
      if (job.status === 'done' && this._hasUnselectedCategories()) {
        return this._currentAvailableCategories().length > 0;
      }
      return false;
    }

    _categoryChooserHintText() {
      const job = this.state.translationJob || null;
      if (!job) {
        return '';
      }
      if (job.status === 'awaiting_categories') {
        return 'План готов. Выберите категории и нажмите кнопку перевода.';
      }
      if (job.status === 'done') {
        return 'Можно добавить дополнительные категории и продолжить перевод.';
      }
      return '';
    }

    updateVisibilityIcon() {
      if (!this.visibilityButton) {
        return;
      }
      const visible = this.state.translationVisible !== false;
      const label = visible ? 'Показать оригинал' : 'Показать перевод';
      this.visibilityButton.setAttribute('aria-label', label);
      this.visibilityButton.setAttribute('title', label);
      this.visibilityButton.setAttribute('data-state', visible ? 'visible' : 'hidden');

      if (this.visibilityIconOn) {
        this.visibilityIconOn.hidden = !visible;
      }
      if (this.visibilityIconOff) {
        this.visibilityIconOff.hidden = visible;
      }
      if (this.visibilityLabel) {
        this.visibilityLabel.textContent = label;
      }
    }

    updateActionButtons() {
      const job = this.state.translationJob || null;
      const running = job && (job.status === 'running' || job.status === 'preparing' || job.status === 'completing');
      const cancellable = job && (job.status === 'running' || job.status === 'preparing' || job.status === 'completing' || job.status === 'awaiting_categories');
      const categoryStep = this._isCategorySelectionStep();
      const canSubmitCategories = !categoryStep || this._currentCategoryDraft().length > 0;
      if (this.startButton) {
        this.startButton.disabled = this.activeTabId === null || Boolean(running) || !canSubmitCategories;
        const startTitle = !this.state.translationPipelineEnabled
          ? 'Перевести (пайплайн включится автоматически)'
          : (categoryStep ? 'Применить категории' : 'Перевести');
        this.startButton.setAttribute('title', startTitle);
        this.startButton.setAttribute('aria-label', startTitle);
        if (this.startButtonLabel) {
          this.startButtonLabel.textContent = categoryStep ? 'Применить категории' : 'Перевести';
        }
      }
      if (this.cancelButton) {
        this.cancelButton.disabled = this.activeTabId === null || !cancellable;
      }
      if (this.clearButton) {
        this.clearButton.disabled = this.activeTabId === null;
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
