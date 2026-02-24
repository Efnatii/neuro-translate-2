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
      key: 'page.get_stats',
      label: 'page.get_stats',
      hint: 'Статистика страницы и категорий перед планированием.'
    },
    {
      key: 'page.get_blocks',
      label: 'page.get_blocks',
      hint: 'Выборка блоков страницы для анализа и/или исполнения.'
    },
    {
      key: 'agent.set_tool_config',
      label: 'agent.set_tool_config',
      hint: 'Установка режимов инструментов on/off/auto.'
    },
    {
      key: 'agent.propose_tool_policy',
      label: 'agent.propose_tool_policy',
      hint: 'Предложение агентом конфигурации инструментов с пересчётом effective policy.'
    },
    {
      key: 'agent.get_tool_context',
      label: 'agent.get_tool_context',
      hint: 'Чтение toolset hash, effective policy и capability summary.'
    },
    {
      key: 'agent.get_autotune_context',
      label: 'agent.get_autotune_context',
      hint: 'Контекст для AutoTune в planning/execution.'
    },
    {
      key: 'agent.propose_run_settings_patch',
      label: 'agent.propose_run_settings_patch',
      hint: 'Предложение патча job-scoped run settings.'
    },
    {
      key: 'agent.apply_run_settings_proposal',
      label: 'agent.apply_run_settings_proposal',
      hint: 'Применение proposal AutoTune.'
    },
    {
      key: 'agent.reject_run_settings_proposal',
      label: 'agent.reject_run_settings_proposal',
      hint: 'Отклонение proposal AutoTune.'
    },
    {
      key: 'agent.explain_current_run_settings',
      label: 'agent.explain_current_run_settings',
      hint: 'Объяснение текущего effective run settings.'
    },
    {
      key: 'agent.set_plan',
      label: 'agent.set_plan',
      hint: 'Фиксация плана выполнения перевода.'
    },
    {
      key: 'agent.set_recommended_categories',
      label: 'agent.set_recommended_categories',
      hint: 'Рекомендация категорий для подтверждения пользователем.'
    },
    {
      key: 'agent.append_report',
      label: 'agent.append_report',
      hint: 'Короткие отчёты о ходе планирования/исполнения.'
    },
    {
      key: 'agent.update_checklist',
      label: 'agent.update_checklist',
      hint: 'Обновление статусов чеклиста агента.'
    },
    {
      key: 'agent.compress_context',
      label: 'agent.compress_context',
      hint: 'Сжатие контекста, чтобы избежать переполнения.'
    },
    {
      key: 'job.get_next_blocks',
      label: 'job.get_next_blocks',
      hint: 'Выбор следующей порции pending-блоков.'
    },
    {
      key: 'translator.translate_block_stream',
      label: 'translator.translate_block_stream',
      hint: 'Потоковый перевод одного блока.'
    },
    {
      key: 'page.apply_delta',
      label: 'page.apply_delta',
      hint: 'Промежуточное применение дельты текста на страницу.'
    },
    {
      key: 'job.mark_block_done',
      label: 'job.mark_block_done',
      hint: 'Финализация успешно переведённого блока.'
    },
    {
      key: 'job.mark_block_failed',
      label: 'job.mark_block_failed',
      hint: 'Фиксация ошибки по блоку без остановки всего пайплайна.'
    },
    {
      key: 'agent.audit_progress',
      label: 'agent.audit_progress',
      hint: 'Проверка прогресса и anti-repeat guard.'
    },
    {
      key: 'memory.build_glossary',
      label: 'memory.build_glossary',
      hint: 'Построение терминологического глоссария по уже переведённым блокам.'
    },
    {
      key: 'memory.update_context_summary',
      label: 'memory.update_context_summary',
      hint: 'Обновление краткого контекстного summary для следующих шагов.'
    },
    {
      key: 'proof.plan_proofreading',
      label: 'proof.plan_proofreading',
      hint: 'Планирование блока(ов) для стадии вычитки.'
    },
    {
      key: 'proof.get_next_blocks',
      label: 'proof.get_next_blocks',
      hint: 'Получение очередных блоков на вычитку.'
    },
    {
      key: 'proof.proofread_block_stream',
      label: 'proof.proofread_block_stream',
      hint: 'Потоковая вычитка одного блока с page.apply_delta.'
    },
    {
      key: 'proof.mark_block_done',
      label: 'proof.mark_block_done',
      hint: 'Фиксация результата вычитки и quality-tag.'
    },
    {
      key: 'proof.mark_block_failed',
      label: 'proof.mark_block_failed',
      hint: 'Фиксация ошибки вычитки по блоку.'
    },
    {
      key: 'proof.finish',
      label: 'proof.finish',
      hint: 'Завершение стадии вычитки при пустом pending.'
    }
  ];

  const DEFAULT_AGENT_TOOLS = {
    'page.get_stats': 'on',
    'page.get_blocks': 'auto',
    'agent.set_tool_config': 'on',
    'agent.propose_tool_policy': 'on',
    'agent.get_tool_context': 'on',
    'agent.get_autotune_context': 'on',
    'agent.propose_run_settings_patch': 'on',
    'agent.apply_run_settings_proposal': 'on',
    'agent.reject_run_settings_proposal': 'on',
    'agent.explain_current_run_settings': 'on',
    'agent.set_plan': 'on',
    'agent.set_recommended_categories': 'on',
    'agent.append_report': 'on',
    'agent.update_checklist': 'on',
    'agent.compress_context': 'auto',
    'job.get_next_blocks': 'on',
    'translator.translate_block_stream': 'on',
    'page.apply_delta': 'on',
    'job.mark_block_done': 'on',
    'job.mark_block_failed': 'on',
    'agent.audit_progress': 'auto',
    'memory.build_glossary': 'auto',
    'memory.update_context_summary': 'auto',
    'proof.plan_proofreading': 'on',
    'proof.get_next_blocks': 'on',
    'proof.proofread_block_stream': 'on',
    'proof.mark_block_done': 'on',
    'proof.mark_block_failed': 'on',
    'proof.finish': 'on'
  };

  const LOCAL_AGENT_TUNING_DEFAULTS = {
    styleOverride: 'auto',
    maxBatchSizeOverride: null,
    proofreadingPassesOverride: null,
    parallelismOverride: 'auto',
    autoTuneEnabled: true,
    autoTuneMode: 'auto_apply',
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

  class DetailsStateManager {
    constructor({ doc, storageKeyPrefix, ui }) {
      this.doc = doc;
      this.storageKeyPrefix = typeof storageKeyPrefix === 'string' && storageKeyPrefix
        ? storageKeyPrefix
        : 'nt.ui.details';
      this.ui = ui || null;
    }

    async init() {
      if (!this.doc || typeof this.doc.querySelectorAll !== 'function') {
        return;
      }
      let collapseState = {};
      if (this.ui && typeof this.ui.getSettingsSnapshot === 'function') {
        const settings = await this.ui.getSettingsSnapshot().catch(() => null);
        const userSettings = settings && settings.userSettings && typeof settings.userSettings === 'object'
          ? settings.userSettings
          : {};
        const uiSettings = userSettings.ui && typeof userSettings.ui === 'object'
          ? userSettings.ui
          : {};
        collapseState = uiSettings.collapseState && typeof uiSettings.collapseState === 'object'
          ? uiSettings.collapseState
          : {};
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
        if (Object.prototype.hasOwnProperty.call(collapseState, sectionId)) {
          details.open = Boolean(collapseState[sectionId]);
        }
        details.addEventListener('toggle', () => {
          if (this.ui && typeof this.ui.queueSettingsPatch === 'function') {
            this.ui.queueSettingsPatch({
              userSettings: {
                ui: {
                  collapseState: {
                    [sectionId]: details.open
                  }
                }
              }
            });
          }
        });
      });
    }
  }

  class PopupController {
    constructor({ doc, ui }) {
      this.doc = doc;
      this.ui = ui;
      this.state = {
        apiKey: '',
        security: {
          credentials: null,
          lastConnectionTest: null,
          lastAudit: null
        },
        connectionModeDraft: 'PROXY',
        proxyDraft: {
          baseUrl: '',
          authToken: '',
          authHeaderName: 'X-NT-Token',
          projectId: '',
          persistToken: false
        },
        byokDraft: {
          key: '',
          persist: false,
          persistConfirmed: false
        },
        translationModelList: [],
        modelSelection: { speed: DEFAULT_AGENT_MODEL_POLICY.speed, preference: DEFAULT_AGENT_MODEL_POLICY.preference },
        translationAgentModelPolicy: { ...DEFAULT_AGENT_MODEL_POLICY },
        translationAgentProfile: 'auto',
        translationAgentTools: { ...DEFAULT_AGENT_TOOLS },
        translationAgentTuning: { ...LOCAL_AGENT_TUNING_DEFAULTS },
        translationCategoryMode: 'auto',
        translationCategoryList: [],
        translationDisplayMode: 'translated',
        translationCompareDiffThreshold: 8000,
        translationMemoryEnabled: true,
        translationMemoryMaxPages: 200,
        translationMemoryMaxBlocks: 5000,
        translationMemoryMaxAgeDays: 30,
        translationMemoryGcOnStartup: true,
        translationMemoryIgnoredQueryParams: ['utm_*', 'fbclid', 'gclid'],
        translationPageCacheEnabled: true,
        translationApiCacheEnabled: true,
        translationPopupActiveTab: POPUP_DEFAULT_TAB,
        translationVisible: true,
        translationPipelineEnabled: false,
        translationStatusByTab: {},
        schedulerRuntime: null,
        modelLimitsBySpec: {},
        translationJob: null,
        translationProgress: 0,
        failedBlocksCount: 0,
        lastError: null,
        agentState: null,
        settingsSchemaVersion: 1,
        settingsUser: null,
        settingsEffective: null,
        settingsOverrides: { changed: [], values: {} },
        selectedCategories: [],
        availableCategories: [],
        categorySelectionDraft: [],
        categorySelectionDraftJobId: null,
        lastMemoryRestore: null
      };
      this.activeTabId = null;
      this.modelRegistry = { entries: [], byKey: {} };
    }

    async init() {
      this.cacheElements();
      this.bindEvents();
      new DetailsStateManager({ doc: this.doc, storageKeyPrefix: 'nt.ui.popup.details', ui: this.ui }).init();
      await this._migrateLegacyUiState();

      const presetTabId = this.ui
        && this.ui.helloContext
        && Number.isFinite(Number(this.ui.helloContext.tabId))
        ? Number(this.ui.helloContext.tabId)
        : null;
      if (presetTabId !== null) {
        this.activeTabId = presetTabId;
      } else {
        const activeTab = await this.ui.getActiveTab();
        this.activeTabId = activeTab ? activeTab.id : null;
      }
      if (this.ui && typeof this.ui.setHelloContext === 'function') {
        this.ui.setHelloContext({ tabId: this.activeTabId });
      }
      this.modelRegistry = this.ui.getModelRegistry();

      const settings = await this.ui.getSettings([
        'schemaVersion',
        'userSettings',
        'effectiveSettings',
        'overrides',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationAgentModelPolicy',
        'translationDisplayModeByTab',
        'translationVisibilityByTab',
        'translationCompareDiffThreshold',
        'translationPipelineEnabled',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationCategoryMode',
        'translationCategoryList',
        'translationMemoryEnabled',
        'translationMemoryMaxPages',
        'translationMemoryMaxBlocks',
        'translationMemoryMaxAgeDays',
        'translationMemoryGcOnStartup',
        'translationMemoryIgnoredQueryParams',
        'translationPageCacheEnabled',
        'translationApiCacheEnabled',
        'translationPopupActiveTab'
      ]);

      this.state.settingsSchemaVersion = Number.isFinite(Number(settings.schemaVersion))
        ? Number(settings.schemaVersion)
        : this.state.settingsSchemaVersion;
      this.state.settingsUser = settings.userSettings && typeof settings.userSettings === 'object'
        ? settings.userSettings
        : this.state.settingsUser;
      this.state.settingsEffective = settings.effectiveSettings && typeof settings.effectiveSettings === 'object'
        ? settings.effectiveSettings
        : this.state.settingsEffective;
      this.state.settingsOverrides = settings.overrides && typeof settings.overrides === 'object'
        ? settings.overrides
        : this.state.settingsOverrides;
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
      this.state.translationMemoryEnabled = settings.translationMemoryEnabled !== false;
      this.state.translationMemoryMaxPages = Number.isFinite(Number(settings.translationMemoryMaxPages))
        ? Number(settings.translationMemoryMaxPages)
        : 200;
      this.state.translationMemoryMaxBlocks = Number.isFinite(Number(settings.translationMemoryMaxBlocks))
        ? Number(settings.translationMemoryMaxBlocks)
        : 5000;
      this.state.translationMemoryMaxAgeDays = Number.isFinite(Number(settings.translationMemoryMaxAgeDays))
        ? Number(settings.translationMemoryMaxAgeDays)
        : 30;
      this.state.translationMemoryGcOnStartup = settings.translationMemoryGcOnStartup !== false;
      this.state.translationMemoryIgnoredQueryParams = Array.isArray(settings.translationMemoryIgnoredQueryParams)
        ? settings.translationMemoryIgnoredQueryParams
        : ['utm_*', 'fbclid', 'gclid'];
      this.state.translationPageCacheEnabled = settings.translationPageCacheEnabled !== false;
      this.state.translationApiCacheEnabled = settings.translationApiCacheEnabled !== false;
      this.state.translationCompareDiffThreshold = Number.isFinite(Number(settings.translationCompareDiffThreshold))
        ? Math.max(500, Math.min(50000, Math.round(Number(settings.translationCompareDiffThreshold))))
        : 8000;
      this.state.translationPopupActiveTab = this.normalizePopupTab(settings.translationPopupActiveTab);
      this._syncLegacyStateFromV2();
      const byTab = settings.translationVisibilityByTab || {};
      const modeByTab = settings.translationDisplayModeByTab || {};
      const modeFromSettings = this.activeTabId !== null && Object.prototype.hasOwnProperty.call(modeByTab, this.activeTabId)
        ? modeByTab[this.activeTabId]
        : null;
      this.state.translationDisplayMode = this.normalizeDisplayMode(modeFromSettings, this.activeTabId !== null ? byTab[this.activeTabId] !== false : true);
      this.state.translationVisible = this.state.translationDisplayMode !== 'original';

      this.renderModels();
      this.renderAgentControls();
      this.renderSettings();
      this.renderStatus();
      this.renderTabs();
    }

    async _migrateLegacyUiState() {
      try {
        if (!global.localStorage) {
          return;
        }
        const markerKey = 'nt.ui.settings.v2.popup.migrated';
        if (global.localStorage.getItem(markerKey) === '1') {
          return;
        }
        const collapseState = {};
        const detailsList = Array.from(this.doc.querySelectorAll('details[data-section]'));
        detailsList.forEach((details) => {
          const sectionId = details && typeof details.getAttribute === 'function'
            ? details.getAttribute('data-section')
            : null;
          if (!sectionId) {
            return;
          }
          const key = `nt.ui.popup.details.${sectionId}`;
          const value = global.localStorage.getItem(key);
          if (value === '1') {
            collapseState[sectionId] = true;
          } else if (value === '0') {
            collapseState[sectionId] = false;
          }
        });
        if (Object.keys(collapseState).length) {
          this.ui.queueSettingsPatch({
            userSettings: {
              ui: {
                collapseState
              }
            }
          });
        }
        global.localStorage.setItem(markerKey, '1');
      } catch (_) {
        // best-effort migration only
      }
    }

    _mergeObjects(base, patch) {
      const left = base && typeof base === 'object' ? JSON.parse(JSON.stringify(base)) : {};
      const right = patch && typeof patch === 'object' ? patch : {};
      const mergeInto = (target, source) => {
        Object.keys(source).forEach((key) => {
          const value = source[key];
          if (Array.isArray(value)) {
            target[key] = value.slice();
            return;
          }
          if (value && typeof value === 'object') {
            const current = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
              ? target[key]
              : {};
            target[key] = mergeInto(current, value);
            return;
          }
          target[key] = value;
        });
        return target;
      };
      return mergeInto(left, right);
    }

    _patchUserSettings(partial) {
      const patch = partial && typeof partial === 'object' ? partial : {};
      this.state.settingsUser = this._mergeObjects(this.state.settingsUser || {}, patch);
      this.ui.queueSettingsPatch({
        userSettings: patch
      });
    }

    _cloneJson(value, fallback = null) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }

    _defaultUserSettings() {
      const Policy = global.NT && global.NT.AgentSettingsPolicy ? global.NT.AgentSettingsPolicy : null;
      const defaults = Policy && Policy.DEFAULT_USER_SETTINGS && typeof Policy.DEFAULT_USER_SETTINGS === 'object'
        ? Policy.DEFAULT_USER_SETTINGS
        : null;
      return this._cloneJson(defaults, {
        profile: 'auto',
        agent: { agentMode: 'agent', toolConfigUser: {} },
        reasoning: { reasoningMode: 'auto', reasoningEffort: 'medium', reasoningSummary: 'auto' },
        caching: { promptCacheRetention: 'auto', promptCacheKey: null, compatCache: true },
        models: { agentAllowedModels: [], modelRoutingMode: 'auto', modelUserPriority: [] },
        memory: {
          enabled: true,
          maxPages: 200,
          maxBlocks: 5000,
          maxAgeDays: 30,
          gcOnStartup: true,
          ignoredQueryParams: ['utm_*', 'fbclid', 'gclid']
        },
        ui: { uiLanguage: 'ru', showAdvanced: false, collapseState: {} }
      });
    }

    _userSettings() {
      const base = this._defaultUserSettings();
      const merged = this._mergeObjects(base, this.state.settingsUser || {});
      this.state.settingsUser = merged;
      return merged;
    }

    _effectiveSettings() {
      const settings = this.state.settingsEffective && typeof this.state.settingsEffective === 'object'
        ? this.state.settingsEffective
        : null;
      if (settings) {
        return settings;
      }
      const user = this._userSettings();
      return {
        profile: user.profile || 'auto',
        effectiveProfile: user.profile || 'auto',
        agent: {
          agentMode: user.agent && user.agent.agentMode ? user.agent.agentMode : 'agent',
          toolConfigEffective: this.normalizeAgentTools(
            user.agent && user.agent.toolConfigUser && typeof user.agent.toolConfigUser === 'object'
              ? user.agent.toolConfigUser
              : {}
          )
        },
        reasoning: {
          reasoningMode: user.reasoning && user.reasoning.reasoningMode ? user.reasoning.reasoningMode : 'auto',
          reasoningEffort: user.reasoning && user.reasoning.reasoningEffort ? user.reasoning.reasoningEffort : 'medium',
          reasoningSummary: user.reasoning && user.reasoning.reasoningSummary ? user.reasoning.reasoningSummary : 'auto'
        },
        caching: {
          promptCacheRetention: user.caching && user.caching.promptCacheRetention ? user.caching.promptCacheRetention : 'auto',
          promptCacheKey: user.caching ? user.caching.promptCacheKey || null : null,
          compatCache: user.caching ? user.caching.compatCache !== false : true
        },
        models: {
          agentAllowedModels: user.models && Array.isArray(user.models.agentAllowedModels)
            ? user.models.agentAllowedModels.slice()
            : [],
          modelRoutingMode: user.models && user.models.modelRoutingMode ? user.models.modelRoutingMode : 'auto',
          modelUserPriority: user.models && Array.isArray(user.models.modelUserPriority)
            ? user.models.modelUserPriority.slice()
            : []
        },
        memory: {
          enabled: user.memory ? user.memory.enabled !== false : true,
          maxPages: user.memory && Number.isFinite(Number(user.memory.maxPages)) ? Number(user.memory.maxPages) : 200,
          maxBlocks: user.memory && Number.isFinite(Number(user.memory.maxBlocks)) ? Number(user.memory.maxBlocks) : 5000,
          maxAgeDays: user.memory && Number.isFinite(Number(user.memory.maxAgeDays)) ? Number(user.memory.maxAgeDays) : 30,
          gcOnStartup: user.memory ? user.memory.gcOnStartup !== false : true,
          ignoredQueryParams: user.memory && Array.isArray(user.memory.ignoredQueryParams)
            ? user.memory.ignoredQueryParams.slice()
            : ['utm_*', 'fbclid', 'gclid']
        }
      };
    }

    _resolveAllowlistForUi() {
      const user = this._userSettings();
      const effective = this._effectiveSettings();
      const fromUser = user.models && Array.isArray(user.models.agentAllowedModels)
        ? user.models.agentAllowedModels
        : [];
      const overrides = this.state.settingsOverrides && Array.isArray(this.state.settingsOverrides.changed)
        ? this.state.settingsOverrides.changed
        : [];
      const userAllowlistOverridden = overrides.includes('models.agentAllowedModels');
      if (userAllowlistOverridden) {
        return fromUser.slice();
      }
      if (fromUser.length) {
        return fromUser.slice();
      }
      const fromEffective = effective.models && Array.isArray(effective.models.agentAllowedModels)
        ? effective.models.agentAllowedModels
        : [];
      if (fromEffective.length) {
        return fromEffective.slice();
      }
      return Array.isArray(this.state.translationModelList) ? this.state.translationModelList.slice() : [];
    }

    _syncLegacyStateFromV2() {
      const user = this._userSettings();
      const effective = this._effectiveSettings();
      this.state.translationAgentProfile = this.normalizeAgentProfile(user.profile || this.state.translationAgentProfile);
      this.state.translationAgentTools = this.normalizeAgentTools(
        user.agent && user.agent.toolConfigUser && typeof user.agent.toolConfigUser === 'object'
          ? user.agent.toolConfigUser
          : this.state.translationAgentTools
      );
      this.state.translationModelList = this._resolveAllowlistForUi();
      if (user.caching && Object.prototype.hasOwnProperty.call(user.caching, 'compatCache')) {
        this.state.translationApiCacheEnabled = user.caching.compatCache !== false;
      }
      if (user.memory && Object.prototype.hasOwnProperty.call(user.memory, 'enabled')) {
        this.state.translationMemoryEnabled = user.memory.enabled !== false;
      }
    }

    normalizeReasoningMode(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      return raw === 'custom' ? 'custom' : 'auto';
    }

    normalizeReasoningEffort(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high' || raw === 'max') {
        return raw;
      }
      return 'medium';
    }

    normalizeReasoningSummary(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'auto' || raw === 'none' || raw === 'short' || raw === 'detailed') {
        return raw;
      }
      return 'auto';
    }

    normalizePromptCacheRetention(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'auto' || raw === 'in_memory' || raw === 'extended' || raw === 'disabled') {
        return raw;
      }
      return 'auto';
    }

    normalizeModelRoutingMode(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'auto' || raw === 'user_priority' || raw === 'profile_priority') {
        return raw;
      }
      return 'auto';
    }

    cacheElements() {
      this.debugButton = this.doc.querySelector('[data-action="open-debug"]');
      this.exportButton = this.doc.querySelector('[data-action="open-export"]');
      this.connectionModeProxy = this.doc.querySelector('[data-field="connection-mode-proxy"]');
      this.connectionModeByok = this.doc.querySelector('[data-field="connection-mode-byok"]');
      this.proxyUrlInput = this.doc.querySelector('[data-field="proxy-url"]');
      this.proxyTokenInput = this.doc.querySelector('[data-field="proxy-token"]');
      this.proxyProjectIdInput = this.doc.querySelector('[data-field="proxy-project-id"]');
      this.proxyHeaderNameInput = this.doc.querySelector('[data-field="proxy-header-name"]');
      this.proxyTokenPersistCheckbox = this.doc.querySelector('[data-field="proxy-token-persist"]');
      this.proxySaveButton = this.doc.querySelector('[data-action="save-proxy-config"]');
      this.proxyClearButton = this.doc.querySelector('[data-action="clear-proxy-config"]');
      this.testConnectionButton = this.doc.querySelector('[data-action="test-connection"]');
      this.byokKeyInput = this.doc.querySelector('[data-field="byok-key"]');
      this.byokPersistCheckbox = this.doc.querySelector('[data-field="byok-persist"]');
      this.byokPersistConfirmCheckbox = this.doc.querySelector('[data-field="byok-persist-confirm"]');
      this.byokSaveSessionButton = this.doc.querySelector('[data-action="save-byok-session"]');
      this.byokSaveButton = this.doc.querySelector('[data-action="save-byok"]');
      this.byokClearButton = this.doc.querySelector('[data-action="clear-byok"]');
      this.credentialsWarning = this.doc.querySelector('[data-field="credentials-warning"]');
      this.credentialsStatus = this.doc.querySelector('[data-field="credentials-status"]');
      this.connectionTestStatus = this.doc.querySelector('[data-field="connection-test-status"]');
      this.modelsRoot = this.doc.querySelector('[data-section="models"]');
      this.agentProfileSelect = this.doc.querySelector('[data-field="agent-profile"]');
      this.modelRoutingModeSelect = this.doc.querySelector('[data-field="model-routing-mode"]');
      this.agentModelPolicyMode = this.doc.querySelector('[data-field="agent-model-policy-mode"]');
      this.agentModelSpeed = this.doc.querySelector('[data-field="agent-model-speed"]');
      this.agentModelPreference = this.doc.querySelector('[data-field="agent-model-preference"]');
      this.agentModelRouteOverride = this.doc.querySelector('[data-field="agent-model-route-override"]');
      this.reasoningModeSelect = this.doc.querySelector('[data-field="reasoning-mode"]');
      this.reasoningEffortSelect = this.doc.querySelector('[data-field="reasoning-effort"]');
      this.reasoningSummarySelect = this.doc.querySelector('[data-field="reasoning-summary"]');
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
      this.compareDiffThresholdInput = this.doc.querySelector('[data-field="compare-diff-threshold"]');
      this.agentCompressionCooldownInput = this.doc.querySelector('[data-field="agent-compression-cooldown"]');
      this.autoTuneEnabledCheckbox = this.doc.querySelector('[data-field="autotune-enabled"]');
      this.autoTuneModeSelect = this.doc.querySelector('[data-field="autotune-mode"]');
      this.autoTuneLastDecision = this.doc.querySelector('[data-field="autotune-last-decision"]');
      this.autoTunePendingDiff = this.doc.querySelector('[data-field="autotune-pending-diff"]');
      this.autoTunePendingReason = this.doc.querySelector('[data-field="autotune-pending-reason"]');
      this.autoTuneApplyButton = this.doc.querySelector('[data-action="autotune-apply"]');
      this.autoTuneRejectButton = this.doc.querySelector('[data-action="autotune-reject"]');
      this.autoTuneResetButton = this.doc.querySelector('[data-action="autotune-reset"]');
      this.pipelineEnabledCheckbox = this.doc.querySelector('[data-field="pipeline-enabled"]');
      this.agentCategoryModeSelect = this.doc.querySelector('[data-field="agent-category-mode"]');
      this.agentCategoryModeHint = this.doc.querySelector('[data-field="agent-category-mode-hint"]');
      this.agentCategoryDefaultsRoot = this.doc.querySelector('[data-section="agent-category-defaults"]');
      this.agentProfileImpactRoot = this.doc.querySelector('[data-section="agent-profile-impact"]');
      this.cacheEnabledCheckbox = this.doc.querySelector('[data-field="cache-enabled"]');
      this.apiCacheEnabledCheckbox = this.doc.querySelector('[data-field="api-cache-enabled"]');
      this.memoryEnabledCheckbox = this.doc.querySelector('[data-field="memory-enabled"]');
      this.memoryRestoreStats = this.doc.querySelector('[data-field="memory-restore-stats"]');
      this.promptCacheRetentionSelect = this.doc.querySelector('[data-field="prompt-cache-retention"]');
      this.promptCacheKeyInput = this.doc.querySelector('[data-field="prompt-cache-key"]');
      this.agentToolsRoot = this.doc.querySelector('[data-section="agent-tools-grid"]');
      this.statusText = this.doc.querySelector('[data-field="status-text"]');
      this.agentStatusText = this.doc.querySelector('[data-field="agent-status"]');
      this.statusChipPipeline = this.doc.querySelector('[data-field="status-chip-pipeline"]');
      this.statusChipModel = this.doc.querySelector('[data-field="status-chip-model"]');
      this.statusChipCache = this.doc.querySelector('[data-field="status-chip-cache"]');
      this.activeJobsSummary = this.doc.querySelector('[data-field="active-jobs-summary"]');
      this.activeJobsSelect = this.doc.querySelector('[data-field="active-jobs-select"]');
      this.gotoJobTabButton = this.doc.querySelector('[data-action="goto-job-tab"]');
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
      this.proofreadAutoButton = this.doc.querySelector('[data-action="proofread-auto"]');
      this.proofreadAllButton = this.doc.querySelector('[data-action="proofread-all"]');
      this.proofreadCurrentCategoryButton = this.doc.querySelector('[data-action="proofread-current-category"]');
      this.erasePageMemoryButton = this.doc.querySelector('[data-action="erase-page-memory"]');
      this.eraseAllMemoryButton = this.doc.querySelector('[data-action="erase-all-memory"]');
      this.displayModeSelect = this.doc.querySelector('[data-field="display-mode-select"]');
      this.popupTabButtons = Array.from(this.doc.querySelectorAll('[data-action="switch-tab"][data-tab]'));
      this.popupTabPanels = Array.from(this.doc.querySelectorAll('[data-tab-panel]'));
    }

    bindEvents() {
      if (this.debugButton) {
        this.debugButton.addEventListener('click', () => this.openDebug());
      }
      if (this.exportButton) {
        this.exportButton.addEventListener('click', () => this.openDebugExport());
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
      if (this.gotoJobTabButton) {
        this.gotoJobTabButton.addEventListener('click', () => {
          const rawValue = this.activeJobsSelect ? this.activeJobsSelect.value : '';
          const tabId = Number(rawValue);
          if (!Number.isFinite(tabId) || !this.ui || !this.ui.chromeApi || !this.ui.chromeApi.tabs || typeof this.ui.chromeApi.tabs.update !== 'function') {
            return;
          }
          this.ui.chromeApi.tabs.update(tabId, { active: true }, () => {});
        });
      }

      const onModeChanged = (mode) => {
        this.state.connectionModeDraft = mode === 'BYOK' ? 'BYOK' : 'PROXY';
        this.ui.setConnectionMode(this.state.connectionModeDraft);
        this.renderCredentials();
      };
      if (this.connectionModeProxy) {
        this.connectionModeProxy.addEventListener('change', (event) => {
          if (event.target && event.target.checked) {
            onModeChanged('PROXY');
          }
        });
      }
      if (this.connectionModeByok) {
        this.connectionModeByok.addEventListener('change', (event) => {
          if (event.target && event.target.checked) {
            onModeChanged('BYOK');
          }
        });
      }

      if (this.proxySaveButton) {
        this.proxySaveButton.addEventListener('click', () => {
          const baseUrl = this.proxyUrlInput ? this.proxyUrlInput.value || '' : '';
          const authToken = this.proxyTokenInput ? this.proxyTokenInput.value || '' : '';
          const projectId = this.proxyProjectIdInput ? this.proxyProjectIdInput.value || '' : '';
          const authHeaderName = this.proxyHeaderNameInput ? this.proxyHeaderNameInput.value || 'X-NT-Token' : 'X-NT-Token';
          const persistToken = this.proxyTokenPersistCheckbox ? this.proxyTokenPersistCheckbox.checked === true : false;
          this.ui.saveProxyConfig({ baseUrl, authToken, projectId, authHeaderName, persistToken });
          this._setConnectionStatus('Proxy конфиг отправлен в BG');
        });
      }
      if (this.proxyClearButton) {
        this.proxyClearButton.addEventListener('click', () => {
          this.ui.clearProxyConfig();
          this._setConnectionStatus('Proxy конфиг очищается...');
        });
      }
      if (this.testConnectionButton) {
        this.testConnectionButton.addEventListener('click', () => {
          this.ui.testConnection();
          this._setConnectionTestStatus('Проверка подключения...');
        });
      }

      if (this.byokSaveSessionButton) {
        this.byokSaveSessionButton.addEventListener('click', () => {
          const key = this.byokKeyInput ? this.byokKeyInput.value || '' : '';
          this.ui.saveByokKey({ key, persist: false });
          this._setConnectionStatus('BYOK ключ сохранён в сессию');
        });
      }
      if (this.byokSaveButton) {
        this.byokSaveButton.addEventListener('click', () => {
          const key = this.byokKeyInput ? this.byokKeyInput.value || '' : '';
          const persist = this.byokPersistCheckbox ? this.byokPersistCheckbox.checked === true : false;
          const confirmed = this.byokPersistConfirmCheckbox ? this.byokPersistConfirmCheckbox.checked === true : false;
          if (persist && !confirmed) {
            this._setConnectionStatus('Подтвердите риск постоянного хранения ключа');
            return;
          }
          this.ui.saveByokKey({ key, persist });
          this._setConnectionStatus(persist ? 'BYOK ключ сохранён постоянно' : 'BYOK ключ сохранён в сессию');
        });
      }
      if (this.byokClearButton) {
        this.byokClearButton.addEventListener('click', () => {
          this.ui.clearByokKey();
          if (this.byokKeyInput) {
            this.byokKeyInput.value = '';
          }
          this._setConnectionStatus('BYOK ключ очищается...');
        });
      }
      if (this.byokPersistCheckbox) {
        this.byokPersistCheckbox.addEventListener('change', (event) => {
          this.state.byokDraft.persist = Boolean(event.target && event.target.checked);
        });
      }
      if (this.byokPersistConfirmCheckbox) {
        this.byokPersistConfirmCheckbox.addEventListener('change', (event) => {
          this.state.byokDraft.persistConfirmed = Boolean(event.target && event.target.checked);
        });
      }
      if (this.proxyTokenPersistCheckbox) {
        this.proxyTokenPersistCheckbox.addEventListener('change', (event) => {
          this.state.proxyDraft.persistToken = Boolean(event.target && event.target.checked);
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

      if (this.modelRoutingModeSelect) {
        this.modelRoutingModeSelect.addEventListener('change', (event) => {
          const mode = this.normalizeModelRoutingMode(event.target ? event.target.value : 'auto');
          this._patchUserSettings({
            models: {
              modelRoutingMode: mode
            }
          });
          this.renderAgentControls();
        });
      }

      if (this.agentProfileSelect) {
        this.agentProfileSelect.addEventListener('change', (event) => {
          this.state.translationAgentProfile = this.normalizeAgentProfile(event.target.value);
          this._patchUserSettings({ profile: this.state.translationAgentProfile });
          this.scheduleSave({ translationAgentProfile: this.state.translationAgentProfile });
          this.renderAgentControls();
        });
      }

      if (this.reasoningModeSelect) {
        this.reasoningModeSelect.addEventListener('change', (event) => {
          const mode = this.normalizeReasoningMode(event.target ? event.target.value : 'auto');
          this._patchUserSettings({
            reasoning: {
              reasoningMode: mode
            }
          });
          this.renderAgentControls();
        });
      }
      if (this.reasoningEffortSelect) {
        this.reasoningEffortSelect.addEventListener('change', (event) => {
          const effort = this.normalizeReasoningEffort(event.target ? event.target.value : 'medium');
          this._patchUserSettings({
            reasoning: {
              reasoningEffort: effort
            }
          });
          this.renderAgentControls();
        });
      }
      if (this.reasoningSummarySelect) {
        this.reasoningSummarySelect.addEventListener('change', (event) => {
          const summary = this.normalizeReasoningSummary(event.target ? event.target.value : 'auto');
          this._patchUserSettings({
            reasoning: {
              reasoningSummary: summary
            }
          });
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
      if (this.compareDiffThresholdInput) {
        this.compareDiffThresholdInput.addEventListener('input', (event) => {
          const value = Number(event && event.target ? event.target.value : null);
          const normalized = Number.isFinite(value)
            ? Math.max(500, Math.min(50000, Math.round(value)))
            : 8000;
          this.state.translationCompareDiffThreshold = normalized;
          if (event && event.target) {
            event.target.value = String(normalized);
          }
          this.scheduleSave({ translationCompareDiffThreshold: normalized });
        });
      }
      if (this.agentCompressionCooldownInput) {
        this.agentCompressionCooldownInput.addEventListener('input', (event) => {
          updateTuning({ compressionCooldownMs: event.target.value });
        });
      }
      if (this.autoTuneEnabledCheckbox) {
        this.autoTuneEnabledCheckbox.addEventListener('change', (event) => {
          updateTuning({ autoTuneEnabled: Boolean(event && event.target && event.target.checked) });
        });
      }
      if (this.autoTuneModeSelect) {
        this.autoTuneModeSelect.addEventListener('change', (event) => {
          const mode = event && event.target && event.target.value === 'ask_user' ? 'ask_user' : 'auto_apply';
          updateTuning({ autoTuneMode: mode });
        });
      }
      if (this.autoTuneApplyButton) {
        this.autoTuneApplyButton.addEventListener('click', () => {
          const proposal = this._pendingAutoTuneProposal();
          if (!proposal || !proposal.id) {
            return;
          }
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.APPLY_AUTOTUNE_PROPOSAL
            : 'APPLY_AUTOTUNE_PROPOSAL';
          this.ui.sendUiCommand(command, {
            tabId: this.activeTabId,
            jobId: this.state.translationJob && this.state.translationJob.id ? this.state.translationJob.id : null,
            proposalId: proposal.id
          });
        });
      }
      if (this.autoTuneRejectButton) {
        this.autoTuneRejectButton.addEventListener('click', () => {
          const proposal = this._pendingAutoTuneProposal();
          if (!proposal || !proposal.id) {
            return;
          }
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.REJECT_AUTOTUNE_PROPOSAL
            : 'REJECT_AUTOTUNE_PROPOSAL';
          this.ui.sendUiCommand(command, {
            tabId: this.activeTabId,
            jobId: this.state.translationJob && this.state.translationJob.id ? this.state.translationJob.id : null,
            proposalId: proposal.id,
            reason: 'Отклонено пользователем из popup'
          });
        });
      }
      if (this.autoTuneResetButton) {
        this.autoTuneResetButton.addEventListener('click', () => {
          const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
          const command = UiProtocol && UiProtocol.Commands
            ? UiProtocol.Commands.RESET_AUTOTUNE_OVERRIDES
            : 'RESET_AUTOTUNE_OVERRIDES';
          this.ui.sendUiCommand(command, {
            tabId: this.activeTabId,
            jobId: this.state.translationJob && this.state.translationJob.id ? this.state.translationJob.id : null
          });
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
          const mode = this.normalizeCategoryMode(event.target ? event.target.value : 'auto');
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
          this._patchUserSettings({
            caching: {
              compatCache: this.state.translationApiCacheEnabled
            }
          });
        });
      }
      if (this.memoryEnabledCheckbox) {
        this.memoryEnabledCheckbox.addEventListener('change', (event) => {
          this.state.translationMemoryEnabled = Boolean(event.target && event.target.checked);
          this.scheduleSave({ translationMemoryEnabled: this.state.translationMemoryEnabled });
          this._patchUserSettings({
            memory: {
              enabled: this.state.translationMemoryEnabled
            }
          });
          this.renderAgentControls();
        });
      }
      if (this.promptCacheRetentionSelect) {
        this.promptCacheRetentionSelect.addEventListener('change', (event) => {
          const retention = this.normalizePromptCacheRetention(event.target ? event.target.value : 'auto');
          this._patchUserSettings({
            caching: {
              promptCacheRetention: retention
            }
          });
          this.renderAgentControls();
        });
      }
      if (this.promptCacheKeyInput) {
        this.promptCacheKeyInput.addEventListener('input', (event) => {
          const raw = event && event.target && typeof event.target.value === 'string'
            ? event.target.value
            : '';
          const promptCacheKey = raw.trim() ? raw.trim().slice(0, 128) : null;
          this._patchUserSettings({
            caching: {
              promptCacheKey
            }
          });
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
          this._patchUserSettings({
            agent: {
              toolConfigUser: {
                [key]: mode
              }
            }
          });
          this.renderAgentControls();
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
          const allowlist = Array.from(list);
          const user = this._userSettings();
          const currentPriority = user.models && Array.isArray(user.models.modelUserPriority)
            ? user.models.modelUserPriority
            : [];
          const nextPriority = currentPriority.filter((spec) => allowlist.includes(spec));
          this.state.translationModelList = allowlist;
          this.scheduleSave({ translationModelList: allowlist });
          this._patchUserSettings({
            models: {
              agentAllowedModels: allowlist,
              modelUserPriority: nextPriority
            }
          });
          this.renderModels();
          this.renderAgentControls();
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

      if (this.displayModeSelect) {
        this.displayModeSelect.addEventListener('change', () => this.onDisplayModeChanged());
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
      if (this.proofreadAutoButton) {
        this.proofreadAutoButton.addEventListener('click', () => this.requestProofreadScope({
          scope: 'all_selected_categories',
          mode: 'auto'
        }));
      }
      if (this.proofreadAllButton) {
        this.proofreadAllButton.addEventListener('click', () => this.requestProofreadScope({
          scope: 'all_selected_categories',
          mode: 'manual'
        }));
      }
      if (this.proofreadCurrentCategoryButton) {
        this.proofreadCurrentCategoryButton.addEventListener('click', () => {
          const category = Array.isArray(this.state.selectedCategories) && this.state.selectedCategories.length
            ? this.state.selectedCategories[0]
            : null;
          this.requestProofreadScope({
            scope: category ? 'category' : 'all_selected_categories',
            category,
            mode: 'manual'
          });
        });
      }
      if (this.erasePageMemoryButton) {
        this.erasePageMemoryButton.addEventListener('click', () => this.erasePageMemory());
      }
      if (this.eraseAllMemoryButton) {
        this.eraseAllMemoryButton.addEventListener('click', () => this.eraseAllMemory());
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
      if (Object.prototype.hasOwnProperty.call(settings, 'schemaVersion')) {
        this.state.settingsSchemaVersion = Number.isFinite(Number(settings.schemaVersion))
          ? Number(settings.schemaVersion)
          : 1;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'userSettings')) {
        this.state.settingsUser = settings.userSettings && typeof settings.userSettings === 'object'
          ? settings.userSettings
          : null;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'effectiveSettings')) {
        this.state.settingsEffective = settings.effectiveSettings && typeof settings.effectiveSettings === 'object'
          ? settings.effectiveSettings
          : null;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'overrides')) {
        this.state.settingsOverrides = settings.overrides && typeof settings.overrides === 'object'
          ? settings.overrides
          : { changed: [], values: {} };
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
      if (Object.prototype.hasOwnProperty.call(settings, 'translationMemoryEnabled')) {
        this.state.translationMemoryEnabled = settings.translationMemoryEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationMemoryMaxPages')) {
        this.state.translationMemoryMaxPages = Number.isFinite(Number(settings.translationMemoryMaxPages))
          ? Number(settings.translationMemoryMaxPages)
          : this.state.translationMemoryMaxPages;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationMemoryMaxBlocks')) {
        this.state.translationMemoryMaxBlocks = Number.isFinite(Number(settings.translationMemoryMaxBlocks))
          ? Number(settings.translationMemoryMaxBlocks)
          : this.state.translationMemoryMaxBlocks;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationMemoryMaxAgeDays')) {
        this.state.translationMemoryMaxAgeDays = Number.isFinite(Number(settings.translationMemoryMaxAgeDays))
          ? Number(settings.translationMemoryMaxAgeDays)
          : this.state.translationMemoryMaxAgeDays;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationMemoryGcOnStartup')) {
        this.state.translationMemoryGcOnStartup = settings.translationMemoryGcOnStartup !== false;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationMemoryIgnoredQueryParams')) {
        this.state.translationMemoryIgnoredQueryParams = Array.isArray(settings.translationMemoryIgnoredQueryParams)
          ? settings.translationMemoryIgnoredQueryParams
          : this.state.translationMemoryIgnoredQueryParams;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationPageCacheEnabled')) {
        this.state.translationPageCacheEnabled = settings.translationPageCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationApiCacheEnabled')) {
        this.state.translationApiCacheEnabled = settings.translationApiCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationCompareDiffThreshold')) {
        this.state.translationCompareDiffThreshold = Number.isFinite(Number(settings.translationCompareDiffThreshold))
          ? Math.max(500, Math.min(50000, Math.round(Number(settings.translationCompareDiffThreshold))))
          : this.state.translationCompareDiffThreshold;
      }
      if (Object.prototype.hasOwnProperty.call(settings, 'translationPopupActiveTab')) {
        this.state.translationPopupActiveTab = this.normalizePopupTab(settings.translationPopupActiveTab);
      }
      this._syncLegacyStateFromV2();

      if (this.activeTabId === null && payload.tabId !== null && payload.tabId !== undefined) {
        this.activeTabId = payload.tabId;
      }

      const visibilityMap = payload.translationVisibilityByTab || {};
      const modeMap = payload.translationDisplayModeByTab || {};
      if (this.activeTabId !== null) {
        if (Object.prototype.hasOwnProperty.call(modeMap, this.activeTabId)) {
          this.state.translationDisplayMode = this.normalizeDisplayMode(modeMap[this.activeTabId], true);
          this.state.translationVisible = this.state.translationDisplayMode !== 'original';
        } else if (Object.prototype.hasOwnProperty.call(visibilityMap, this.activeTabId)) {
          this.state.translationVisible = visibilityMap[this.activeTabId] !== false;
          this.state.translationDisplayMode = this.normalizeDisplayMode(null, this.state.translationVisible);
        }
      }
      if (payload.translationStatusByTab && typeof payload.translationStatusByTab === 'object') {
        this.state.translationStatusByTab = payload.translationStatusByTab;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'modelLimitsBySpec')) {
        this.state.modelLimitsBySpec = payload.modelLimitsBySpec && typeof payload.modelLimitsBySpec === 'object'
          ? payload.modelLimitsBySpec
          : {};
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'translationJob')) {
        this.state.translationJob = payload.translationJob || null;
        this.state.lastMemoryRestore = this.state.translationJob
          && this.state.translationJob.memoryRestore
          && typeof this.state.translationJob.memoryRestore === 'object'
          ? this.state.translationJob.memoryRestore
          : this.state.lastMemoryRestore;
        if (this.state.translationJob && this.state.translationJob.displayMode) {
          this.state.translationDisplayMode = this.normalizeDisplayMode(this.state.translationJob.displayMode, true);
          this.state.translationVisible = this.state.translationDisplayMode !== 'original';
        }
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
      if (Object.prototype.hasOwnProperty.call(payload, 'serverCaps')) {
        const caps = payload.serverCaps && typeof payload.serverCaps === 'object' ? payload.serverCaps : null;
        this.state.schedulerRuntime = caps && caps.schedulerRuntime && typeof caps.schedulerRuntime === 'object'
          ? caps.schedulerRuntime
          : null;
      }
      if (Object.prototype.hasOwnProperty.call(payload, 'security')) {
        this._applySecuritySnapshot(payload.security);
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
      const rawPatch = payload.patch && typeof payload.patch === 'object'
        ? payload.patch
        : payload;
      const patch = rawPatch && rawPatch.settings && typeof rawPatch.settings === 'object'
        ? { ...rawPatch.settings, ...rawPatch }
        : rawPatch;
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const settingsResultType = UiProtocol && UiProtocol.UI_SETTINGS_RESULT ? UiProtocol.UI_SETTINGS_RESULT : 'ui:settings:result';
      if (patch && patch.type === settingsResultType && patch.ok === false) {
        const message = patch.error && patch.error.message
          ? patch.error.message
          : 'Ошибка сохранения настроек';
        if (this.statusTrace) {
          this.statusTrace.textContent = `Ошибка настроек: ${message}`;
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'security')) {
        this._applySecuritySnapshot(patch.security);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'schemaVersion')) {
        this.state.settingsSchemaVersion = Number.isFinite(Number(patch.schemaVersion))
          ? Number(patch.schemaVersion)
          : this.state.settingsSchemaVersion;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'userSettings')) {
        this.state.settingsUser = patch.userSettings && typeof patch.userSettings === 'object'
          ? patch.userSettings
          : this.state.settingsUser;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'effectiveSettings')) {
        this.state.settingsEffective = patch.effectiveSettings && typeof patch.effectiveSettings === 'object'
          ? patch.effectiveSettings
          : this.state.settingsEffective;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'overrides')) {
        this.state.settingsOverrides = patch.overrides && typeof patch.overrides === 'object'
          ? patch.overrides
          : this.state.settingsOverrides;
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
      if (Object.prototype.hasOwnProperty.call(patch, 'translationMemoryEnabled')) {
        this.state.translationMemoryEnabled = patch.translationMemoryEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationMemoryMaxPages')) {
        this.state.translationMemoryMaxPages = Number.isFinite(Number(patch.translationMemoryMaxPages))
          ? Number(patch.translationMemoryMaxPages)
          : this.state.translationMemoryMaxPages;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationMemoryMaxBlocks')) {
        this.state.translationMemoryMaxBlocks = Number.isFinite(Number(patch.translationMemoryMaxBlocks))
          ? Number(patch.translationMemoryMaxBlocks)
          : this.state.translationMemoryMaxBlocks;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationMemoryMaxAgeDays')) {
        this.state.translationMemoryMaxAgeDays = Number.isFinite(Number(patch.translationMemoryMaxAgeDays))
          ? Number(patch.translationMemoryMaxAgeDays)
          : this.state.translationMemoryMaxAgeDays;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationMemoryGcOnStartup')) {
        this.state.translationMemoryGcOnStartup = patch.translationMemoryGcOnStartup !== false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationMemoryIgnoredQueryParams')) {
        this.state.translationMemoryIgnoredQueryParams = Array.isArray(patch.translationMemoryIgnoredQueryParams)
          ? patch.translationMemoryIgnoredQueryParams
          : this.state.translationMemoryIgnoredQueryParams;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationPageCacheEnabled')) {
        this.state.translationPageCacheEnabled = patch.translationPageCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationApiCacheEnabled')) {
        this.state.translationApiCacheEnabled = patch.translationApiCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationCompareDiffThreshold')) {
        this.state.translationCompareDiffThreshold = Number.isFinite(Number(patch.translationCompareDiffThreshold))
          ? Math.max(500, Math.min(50000, Math.round(Number(patch.translationCompareDiffThreshold))))
          : this.state.translationCompareDiffThreshold;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationPopupActiveTab')) {
        this.state.translationPopupActiveTab = this.normalizePopupTab(patch.translationPopupActiveTab);
      }
      this._syncLegacyStateFromV2();
      if (this.activeTabId !== null) {
        if (Object.prototype.hasOwnProperty.call(patch, 'translationDisplayModeByTab')) {
          const modeMap = patch.translationDisplayModeByTab || {};
          if (Object.prototype.hasOwnProperty.call(modeMap, this.activeTabId)) {
            this.state.translationDisplayMode = this.normalizeDisplayMode(modeMap[this.activeTabId], true);
            this.state.translationVisible = this.state.translationDisplayMode !== 'original';
          }
        }
        if (Object.prototype.hasOwnProperty.call(patch, 'translationVisibilityByTab')) {
          const map = patch.translationVisibilityByTab || {};
          if (Object.prototype.hasOwnProperty.call(map, this.activeTabId)) {
            this.state.translationVisible = map[this.activeTabId] !== false;
            if (!Object.prototype.hasOwnProperty.call(patch, 'translationDisplayModeByTab')) {
              this.state.translationDisplayMode = this.normalizeDisplayMode(null, this.state.translationVisible);
            }
          }
        }
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationStatusByTab') && patch.translationStatusByTab && typeof patch.translationStatusByTab === 'object') {
        this.state.translationStatusByTab = patch.translationStatusByTab;
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'modelLimitsBySpec')) {
        this.state.modelLimitsBySpec = patch.modelLimitsBySpec && typeof patch.modelLimitsBySpec === 'object'
          ? patch.modelLimitsBySpec
          : {};
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'translationJob')) {
        this.state.translationJob = patch.translationJob || null;
        this.state.lastMemoryRestore = this.state.translationJob
          && this.state.translationJob.memoryRestore
          && typeof this.state.translationJob.memoryRestore === 'object'
          ? this.state.translationJob.memoryRestore
          : this.state.lastMemoryRestore;
        if (this.state.translationJob && this.state.translationJob.displayMode) {
          this.state.translationDisplayMode = this.normalizeDisplayMode(this.state.translationJob.displayMode, true);
          this.state.translationVisible = this.state.translationDisplayMode !== 'original';
        }
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
      if (Object.prototype.hasOwnProperty.call(patch, 'serverCaps')) {
        const caps = patch.serverCaps && typeof patch.serverCaps === 'object' ? patch.serverCaps : null;
        this.state.schedulerRuntime = caps && caps.schedulerRuntime && typeof caps.schedulerRuntime === 'object'
          ? caps.schedulerRuntime
          : this.state.schedulerRuntime;
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

    async onDisplayModeChanged() {
      const mode = this.normalizeDisplayMode(
        this.displayModeSelect ? this.displayModeSelect.value : this.state.translationDisplayMode,
        this.state.translationVisible
      );
      this.state.translationDisplayMode = mode;
      this.state.translationVisible = mode !== 'original';
      this.updateVisibilityIcon();
      if (this.activeTabId === null) {
        return;
      }
      await this.ui.setDisplayMode(this.activeTabId, mode);
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

    async requestProofreadScope({ scope = 'all_selected_categories', category = null, blockIds = null, mode = 'auto' } = {}) {
      if (this.activeTabId === null) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.REQUEST_PROOFREAD_SCOPE
        : 'REQUEST_PROOFREAD_SCOPE';
      const jobId = this.state.translationJob && this.state.translationJob.id
        ? this.state.translationJob.id
        : null;
      const payload = {
        tabId: this.activeTabId,
        jobId,
        scope: scope === 'category' || scope === 'blocks' ? scope : 'all_selected_categories',
        mode: mode === 'manual' ? 'manual' : 'auto'
      };
      const categoryKey = typeof category === 'string' ? category.trim() : '';
      if (categoryKey) {
        payload.category = categoryKey;
      }
      if (Array.isArray(blockIds) && blockIds.length) {
        payload.blockIds = blockIds
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 300);
      }
      this.ui.sendUiCommand(command, payload);
      if (this.statusTrace) {
        this.statusTrace.textContent = 'Запрос вычитки отправлен. План обновится после подтверждения BG.';
      }
    }

    async requestBlockAction({ blockId, action = 'style_improve' } = {}) {
      if (this.activeTabId === null) {
        return;
      }
      const id = typeof blockId === 'string' ? blockId.trim() : '';
      if (!id) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.REQUEST_BLOCK_ACTION
        : 'REQUEST_BLOCK_ACTION';
      const jobId = this.state.translationJob && this.state.translationJob.id
        ? this.state.translationJob.id
        : null;
      this.ui.sendUiCommand(command, {
        tabId: this.activeTabId,
        jobId,
        blockId: id,
        action: action === 'literal' ? 'literal' : 'style_improve'
      });
      if (this.statusTrace) {
        this.statusTrace.textContent = `Запрос действия по блоку ${id} отправлен.`;
      }
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

    erasePageMemory() {
      if (this.activeTabId === null) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.ERASE_TRANSLATION_MEMORY
        : 'ERASE_TRANSLATION_MEMORY';
      this.ui.sendUiCommand(command, {
        tabId: this.activeTabId,
        scope: 'page'
      });
      if (this.memoryRestoreStats) {
        this.memoryRestoreStats.textContent = 'Память страницы очищается...';
      }
    }

    eraseAllMemory() {
      const confirmed = global.confirm ? global.confirm('Стереть всю память перевода? Это действие нельзя отменить.') : true;
      if (!confirmed) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.ERASE_TRANSLATION_MEMORY
        : 'ERASE_TRANSLATION_MEMORY';
      this.ui.sendUiCommand(command, {
        scope: 'all'
      });
      if (this.memoryRestoreStats) {
        this.memoryRestoreStats.textContent = 'Вся память очищается...';
      }
    }

    async openDebug() {
      const tab = await this.ui.getActiveTab();
      this.ui.openDebug({
        tabId: tab ? tab.id : '',
        url: tab && tab.url ? tab.url : ''
      });
    }

    async openDebugExport() {
      const tab = await this.ui.getActiveTab();
      this.ui.openDebug({
        tabId: tab ? tab.id : '',
        url: tab && tab.url ? tab.url : '',
        section: 'export'
      });
    }

    normalizeAgentProfile(value) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'auto' || raw === 'fast' || raw === 'balanced' || raw === 'bulk' || raw === 'accurate' || raw === 'research' || raw === 'custom') {
        return raw;
      }
      if (raw === 'readable') {
        return 'bulk';
      }
      if (raw === 'literal') {
        return 'accurate';
      }
      if (raw === 'technical') {
        return 'research';
      }
      return 'auto';
    }

    _profileLabel(profile) {
      if (profile === 'fast') {
        return 'быстрый';
      }
      if (profile === 'balanced') {
        return 'сбаланс.';
      }
      if (profile === 'bulk') {
        return 'массовый';
      }
      if (profile === 'accurate') {
        return 'точный';
      }
      if (profile === 'research') {
        return 'исслед.';
      }
      if (profile === 'custom') {
        return 'кастом';
      }
      return 'авто';
    }

    _toLegacyAgentProfile(profile) {
      const normalized = this.normalizeAgentProfile(profile);
      if (normalized === 'bulk') {
        return 'readable';
      }
      if (normalized === 'accurate') {
        return 'literal';
      }
      if (normalized === 'research') {
        return 'technical';
      }
      if (normalized === 'fast') {
        return 'readable';
      }
      if (normalized === 'custom') {
        return 'balanced';
      }
      return normalized;
    }

    normalizeDisplayMode(value, visibleFallback = true) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      if (raw === 'original' || raw === 'translated' || raw === 'compare') {
        return raw;
      }
      return visibleFallback === false ? 'original' : 'translated';
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
      if (value === 'auto' || value === 'content' || value === 'interface' || value === 'meta' || value === 'custom') {
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
          : 'auto';
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
        autoTuneEnabled: source.autoTuneEnabled !== false,
        autoTuneMode: source.autoTuneMode === 'ask_user' ? 'ask_user' : 'auto_apply',
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
      const userSettings = this._userSettings();
      const effectiveSettings = this._effectiveSettings();
      const userReasoning = userSettings.reasoning && typeof userSettings.reasoning === 'object'
        ? userSettings.reasoning
        : {};
      const effectiveReasoning = effectiveSettings.reasoning && typeof effectiveSettings.reasoning === 'object'
        ? effectiveSettings.reasoning
        : {};
      const userCaching = userSettings.caching && typeof userSettings.caching === 'object'
        ? userSettings.caching
        : {};
      const userMemory = userSettings.memory && typeof userSettings.memory === 'object'
        ? userSettings.memory
        : {};
      const userModels = userSettings.models && typeof userSettings.models === 'object'
        ? userSettings.models
        : {};
      const effectiveModels = effectiveSettings.models && typeof effectiveSettings.models === 'object'
        ? effectiveSettings.models
        : {};
      const effectiveMemory = effectiveSettings.memory && typeof effectiveSettings.memory === 'object'
        ? effectiveSettings.memory
        : {};
      const userAgent = userSettings.agent && typeof userSettings.agent === 'object'
        ? userSettings.agent
        : {};
      this.state.translationModelList = this._resolveAllowlistForUi();
      this.state.translationAgentTools = this.normalizeAgentTools(
        userAgent.toolConfigUser && typeof userAgent.toolConfigUser === 'object'
          ? userAgent.toolConfigUser
          : this.state.translationAgentTools
      );
      this.state.translationAgentProfile = this.normalizeAgentProfile(
        userSettings.profile || this.state.translationAgentProfile
      );
      if (this.agentProfileSelect) {
        this.agentProfileSelect.value = this.normalizeAgentProfile(this.state.translationAgentProfile);
      }
      if (this.modelRoutingModeSelect) {
        this.modelRoutingModeSelect.value = this.normalizeModelRoutingMode(
          userModels.modelRoutingMode || effectiveModels.modelRoutingMode || 'auto'
        );
      }
      if (this.reasoningModeSelect) {
        this.reasoningModeSelect.value = this.normalizeReasoningMode(
          userReasoning.reasoningMode || effectiveReasoning.reasoningMode || 'auto'
        );
      }
      if (this.reasoningEffortSelect) {
        this.reasoningEffortSelect.value = this.normalizeReasoningEffort(
          userReasoning.reasoningEffort || effectiveReasoning.reasoningEffort || 'medium'
        );
      }
      if (this.reasoningSummarySelect) {
        this.reasoningSummarySelect.value = this.normalizeReasoningSummary(
          userReasoning.reasoningSummary || effectiveReasoning.reasoningSummary || 'auto'
        );
      }
      const reasoningCustom = this.reasoningModeSelect
        ? this.normalizeReasoningMode(this.reasoningModeSelect.value) === 'custom'
        : false;
      if (this.reasoningEffortSelect) {
        this.reasoningEffortSelect.disabled = !reasoningCustom;
      }
      if (this.reasoningSummarySelect) {
        this.reasoningSummarySelect.disabled = !reasoningCustom;
      }
      if (this.promptCacheRetentionSelect) {
        this.promptCacheRetentionSelect.value = this.normalizePromptCacheRetention(
          userCaching.promptCacheRetention || 'auto'
        );
      }
      if (this.promptCacheKeyInput) {
        this.promptCacheKeyInput.value = typeof userCaching.promptCacheKey === 'string'
          ? userCaching.promptCacheKey
          : '';
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
      if (this.compareDiffThresholdInput) {
        this.compareDiffThresholdInput.value = String(this.state.translationCompareDiffThreshold);
      }
      if (this.agentCompressionCooldownInput) {
        this.agentCompressionCooldownInput.value = String(tuning.compressionCooldownMs);
      }
      if (this.autoTuneEnabledCheckbox) {
        this.autoTuneEnabledCheckbox.checked = tuning.autoTuneEnabled !== false;
      }
      if (this.autoTuneModeSelect) {
        this.autoTuneModeSelect.value = tuning.autoTuneMode === 'ask_user' ? 'ask_user' : 'auto_apply';
      }
      if (this.pipelineEnabledCheckbox) {
        this.pipelineEnabledCheckbox.checked = this.state.translationPipelineEnabled === true;
      }
      if (Object.prototype.hasOwnProperty.call(userCaching, 'compatCache')) {
        this.state.translationApiCacheEnabled = userCaching.compatCache !== false;
      }
      if (this.cacheEnabledCheckbox) {
        this.cacheEnabledCheckbox.checked = this.state.translationPageCacheEnabled !== false;
      }
      if (this.apiCacheEnabledCheckbox) {
        this.apiCacheEnabledCheckbox.checked = this.state.translationApiCacheEnabled !== false;
      }
      this.state.translationMemoryEnabled = Object.prototype.hasOwnProperty.call(userMemory, 'enabled')
        ? userMemory.enabled !== false
        : (Object.prototype.hasOwnProperty.call(effectiveMemory, 'enabled')
          ? effectiveMemory.enabled !== false
          : this.state.translationMemoryEnabled !== false);
      if (this.memoryEnabledCheckbox) {
        this.memoryEnabledCheckbox.checked = this.state.translationMemoryEnabled !== false;
      }
      const memoryRestore = this.state.translationJob
        && this.state.translationJob.memoryRestore
        && typeof this.state.translationJob.memoryRestore === 'object'
        ? this.state.translationJob.memoryRestore
        : (this.state.agentState && this.state.agentState.memory && this.state.agentState.memory.lastRestore
          ? this.state.agentState.memory.lastRestore
          : null);
      if (this.memoryRestoreStats) {
        if (memoryRestore && Number.isFinite(Number(memoryRestore.restoredCount)) && Number(memoryRestore.restoredCount) > 0) {
          this.memoryRestoreStats.textContent = `Память: восстановлено ${Number(memoryRestore.restoredCount)} блоков (${memoryRestore.matchType || 'match'})`;
        } else {
          this.memoryRestoreStats.textContent = 'Память: данных восстановления пока нет';
        }
      }
      this.renderToolControls();
      this.renderCategorySettingsControls();
      this.renderProfileImpactPreview();
      this.renderAgentMiniStatuses();
      this.renderRuntimeCategoryChooser();
      this.renderAutoTuneControls();
    }

    _jobRunSettingsAutoTune() {
      const job = this.state.translationJob && typeof this.state.translationJob === 'object'
        ? this.state.translationJob
        : null;
      const runSettings = job && job.runSettings && typeof job.runSettings === 'object'
        ? job.runSettings
        : null;
      const autoTune = runSettings && runSettings.autoTune && typeof runSettings.autoTune === 'object'
        ? runSettings.autoTune
        : null;
      return autoTune;
    }

    _pendingAutoTuneProposal() {
      const autoTune = this._jobRunSettingsAutoTune();
      if (!autoTune || !Array.isArray(autoTune.proposals)) {
        return null;
      }
      return autoTune.proposals
        .slice()
        .reverse()
        .find((item) => item && item.status === 'proposed') || null;
    }

    renderAutoTuneControls() {
      const autoTune = this._jobRunSettingsAutoTune();
      const pending = this._pendingAutoTuneProposal();
      const lastDecision = autoTune && autoTune.lastDecision && typeof autoTune.lastDecision === 'object'
        ? autoTune.lastDecision
        : (autoTune && Array.isArray(autoTune.decisionLog) && autoTune.decisionLog.length
          ? autoTune.decisionLog[autoTune.decisionLog.length - 1]
          : null);
      if (this.autoTuneLastDecision) {
        if (!autoTune) {
          this.autoTuneLastDecision.textContent = 'Нет данных для текущей задачи';
        } else {
          const mode = autoTune.mode === 'ask_user' ? 'ask_user' : 'auto_apply';
          const stage = lastDecision && lastDecision.stage ? String(lastDecision.stage) : '—';
          const when = lastDecision && Number.isFinite(Number(lastDecision.ts))
            ? this._formatTimestamp(Number(lastDecision.ts))
            : '—';
          const summary = lastDecision && Array.isArray(lastDecision.patchSummary) && lastDecision.patchSummary.length
            ? lastDecision.patchSummary.slice(0, 4).join(', ')
            : '—';
          this.autoTuneLastDecision.textContent = `mode=${mode} | stage=${stage} | when=${when} | ${summary}`;
        }
      }
      if (this.autoTunePendingDiff) {
        this.autoTunePendingDiff.textContent = pending && pending.diffSummary
          ? pending.diffSummary
          : 'Ожидающих proposals нет';
      }
      if (this.autoTunePendingReason) {
        this.autoTunePendingReason.textContent = pending && pending.reason && pending.reason.short
          ? String(pending.reason.short)
          : '—';
      }
      const canAct = Boolean(pending && pending.id);
      if (this.autoTuneApplyButton) {
        this.autoTuneApplyButton.disabled = !canAct;
      }
      if (this.autoTuneRejectButton) {
        this.autoTuneRejectButton.disabled = !canAct;
      }
      if (this.autoTuneResetButton) {
        const hasAgentOverrides = Boolean(
          this.state.translationJob
          && this.state.translationJob.runSettings
          && this.state.translationJob.runSettings.agentOverrides
          && Object.keys(this.state.translationJob.runSettings.agentOverrides).length
        );
        this.autoTuneResetButton.disabled = !hasAgentOverrides;
      }
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
      if (mode === 'auto') {
        return 'авто';
      }
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
      if (mode === 'auto') {
        return 'Агент автоматически рекомендует категории после анализа страницы.';
      }
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
        select.value = this.state.translationAgentTools[tool.key] || 'auto';

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
      const resolved = preview && preview.resolved && typeof preview.resolved === 'object'
        ? preview.resolved
        : null;
      if (resolved) {
        const categoryMode = this.normalizeCategoryMode(resolved.categoryMode);
        const categoryList = this.normalizeCategoryList(resolved.categoryList);
        lines.push({
          label: 'Категории (первичный режим)',
          value: `${this._categoryModeLabel(categoryMode)}${categoryMode === 'custom' ? ` (${categoryList.length})` : ''}`
        });
        lines.push({
          label: 'Кэш страниц',
          value: resolved.pageCacheEnabled !== false ? 'вкл' : 'выкл'
        });
        const modelPolicy = resolved.modelPolicy && typeof resolved.modelPolicy === 'object'
          ? resolved.modelPolicy
          : {};
        const modelMode = modelPolicy.mode === 'fixed' ? 'fixed' : 'auto';
        const modelSpeed = modelPolicy.speed !== false ? 'on' : 'off';
        const modelPreference = modelPolicy.preference === 'smartest' || modelPolicy.preference === 'cheapest'
          ? modelPolicy.preference
          : 'none';
        const routeOverride = modelPolicy.allowRouteOverride !== false ? 'on' : 'off';
        lines.push({
          label: 'Политика модели',
          value: `${modelMode}, speed=${modelSpeed}, pref=${modelPreference}, routeOverride=${routeOverride}`
        });
        const effectiveTools = this._formatEffectiveToolsPreview(resolved);
        if (effectiveTools) {
          lines.push({
            label: 'Инструменты (эффективно)',
            value: effectiveTools
          });
        }
      }
      const effectiveV2 = this.state.settingsEffective && typeof this.state.settingsEffective === 'object'
        ? this.state.settingsEffective
        : null;
      if (effectiveV2) {
        const effReasoning = effectiveV2.reasoning && typeof effectiveV2.reasoning === 'object'
          ? effectiveV2.reasoning
          : {};
        const effCaching = effectiveV2.caching && typeof effectiveV2.caching === 'object'
          ? effectiveV2.caching
          : {};
        const effAgent = effectiveV2.agent && typeof effectiveV2.agent === 'object'
          ? effectiveV2.agent
          : {};
        const effModels = effectiveV2.models && typeof effectiveV2.models === 'object'
          ? effectiveV2.models
          : {};
        lines.push({
          label: 'Reasoning (effective)',
          value: `${effReasoning.reasoningEffort || 'auto'} / ${effReasoning.reasoningSummary || 'auto'}`
        });
        lines.push({
          label: 'Cache (effective)',
          value: `${effCaching.promptCacheRetention || 'auto'}${effCaching.promptCacheKey ? ' +key' : ''}, compat=${effCaching.compatCache !== false ? 'on' : 'off'}`
        });
        const toolConfigEffective = effAgent.toolConfigEffective && typeof effAgent.toolConfigEffective === 'object'
          ? effAgent.toolConfigEffective
          : {};
        lines.push({
          label: 'Tools (effective)',
          value: Object.keys(toolConfigEffective).length
            ? Object.keys(toolConfigEffective).slice(0, 4).map((key) => `${key}:${toolConfigEffective[key]}`).join(', ')
            : '—'
        });
        lines.push({
          label: 'Models (effective)',
          value: `allowlist=${Array.isArray(effModels.agentAllowedModels) ? effModels.agentAllowedModels.length : 0}, routing=${effModels.modelRoutingMode || 'auto'}`
        });
        const effMemory = effectiveV2.memory && typeof effectiveV2.memory === 'object'
          ? effectiveV2.memory
          : {};
        lines.push({
          label: 'Memory (effective)',
          value: `enabled=${effMemory.enabled !== false ? 'on' : 'off'}, pages=${Number.isFinite(Number(effMemory.maxPages)) ? Number(effMemory.maxPages) : '—'}, blocks=${Number.isFinite(Number(effMemory.maxBlocks)) ? Number(effMemory.maxBlocks) : '—'}, age=${Number.isFinite(Number(effMemory.maxAgeDays)) ? Number(effMemory.maxAgeDays) : '—'}d`
        });
      }
      const overrides = this.state.settingsOverrides && Array.isArray(this.state.settingsOverrides.changed)
        ? this.state.settingsOverrides.changed
        : [];
      lines.push({
        label: 'Overrides',
        value: overrides.length ? overrides.slice(0, 6).join(', ') : 'нет'
      });

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
      const legacyProfile = this._toLegacyAgentProfile(profile);
      const tuning = this.normalizeAgentTuning(this.state.translationAgentTuning);
      const TranslationAgent = global.NT && global.NT.TranslationAgent ? global.NT.TranslationAgent : null;
      const defaults = global.NT && global.NT.TranslationAgentDefaults && global.NT.TranslationAgentDefaults.PROFILE_PRESETS
        ? global.NT.TranslationAgentDefaults.PROFILE_PRESETS
        : null;
      const fallbackProfile = defaults && Object.prototype.hasOwnProperty.call(defaults, profile)
        ? defaults[profile]
        : (defaults && defaults.auto ? defaults.auto : { style: 'auto', maxBatchSize: 'auto', proofreadingPasses: 'auto', parallelism: 'auto' });
      const runtimeFallback = {
        auditIntervalMs: tuning.auditIntervalMs,
        mandatoryAuditIntervalMs: tuning.mandatoryAuditIntervalMs,
        compressionThreshold: tuning.compressionThreshold,
        contextFootprintLimit: tuning.contextFootprintLimit,
        compressionCooldownMs: tuning.compressionCooldownMs
      };
      const safeModelPolicy = this.normalizeAgentModelPolicy(this.state.translationAgentModelPolicy, this.state.modelSelection);

      if (TranslationAgent && typeof TranslationAgent.previewResolvedSettings === 'function') {
        let resolved = null;
        try {
          resolved = TranslationAgent.previewResolvedSettings({
            settings: {
              translationAgentProfile: legacyProfile,
              translationAgentTuning: tuning,
              translationAgentTools: this.normalizeAgentTools(this.state.translationAgentTools),
              translationAgentModelPolicy: safeModelPolicy,
              modelSelection: this.state.modelSelection,
              translationCategoryMode: this.normalizeCategoryMode(this.state.translationCategoryMode),
              translationCategoryList: this.normalizeCategoryList(this.state.translationCategoryList),
              translationPageCacheEnabled: this.state.translationPageCacheEnabled !== false
            },
            pageStats: null,
            blocks: null
          });
        } catch (_) {
          resolved = null;
        }
        return {
          base: resolved && resolved.baseProfile ? resolved.baseProfile : fallbackProfile,
          effective: resolved && resolved.effectiveProfile ? resolved.effectiveProfile : fallbackProfile,
          tuning: resolved && resolved.tuning ? resolved.tuning : tuning,
          runtime: resolved && resolved.runtimeTuning ? resolved.runtimeTuning : runtimeFallback,
          resolved: resolved && resolved.resolved ? resolved.resolved : null
        };
      }

      return {
        base: fallbackProfile,
        effective: fallbackProfile,
        tuning,
        runtime: runtimeFallback,
        resolved: null
      };
    }

    _formatEffectiveToolsPreview(resolved) {
      if (!resolved || typeof resolved !== 'object') {
        return '';
      }
      const requested = resolved.toolConfigRequested && typeof resolved.toolConfigRequested === 'object'
        ? resolved.toolConfigRequested
        : {};
      const effective = resolved.toolConfigEffective && typeof resolved.toolConfigEffective === 'object'
        ? resolved.toolConfigEffective
        : {};
      const keys = AGENT_TOOLS
        .map((item) => item.key)
        .filter((key) => (
          Object.prototype.hasOwnProperty.call(requested, key)
          || Object.prototype.hasOwnProperty.call(effective, key)
        ));
      if (!keys.length) {
        return '';
      }
      return keys.map((key) => {
        const req = requested[key];
        const reqNorm = req === 'on' || req === 'off' || req === 'auto' ? req : null;
        const eff = effective[key];
        const effNorm = eff === 'on' || eff === 'off' || eff === 'auto'
          ? eff
          : reqNorm;
        if (reqNorm === 'auto' && effNorm && effNorm !== 'auto') {
          return `${key}:auto->${effNorm}`;
        }
        if (effNorm) {
          return `${key}:${effNorm}`;
        }
        return `${key}:n/a`;
      }).join(', ');
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
      if (lower === 'fast') {
        return 'быстрый';
      }
      if (lower === 'bulk') {
        return 'массовый';
      }
      if (lower === 'accurate') {
        return 'точный';
      }
      if (lower === 'research') {
        return 'исследовательский';
      }
      if (lower === 'custom') {
        return 'кастом';
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
      const selectedSpecs = new Set(this._resolveAllowlistForUi());
      this.state.translationModelList = Array.from(selectedSpecs);
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
          input.checked = selectedSpecs.has(modelSpec);

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

    _setConnectionStatus(text) {
      if (this.credentialsStatus) {
        this.credentialsStatus.textContent = text || 'Подключение: —';
      }
    }

    _setConnectionTestStatus(text) {
      if (this.connectionTestStatus) {
        this.connectionTestStatus.textContent = text || 'Проверка: —';
      }
    }

    _applySecuritySnapshot(security) {
      const src = security && typeof security === 'object' ? security : {};
      const credentials = src.credentials && typeof src.credentials === 'object'
        ? src.credentials
        : null;
      const lastConnectionTest = src.lastConnectionTest && typeof src.lastConnectionTest === 'object'
        ? src.lastConnectionTest
        : null;
      const lastAudit = src.lastAudit && typeof src.lastAudit === 'object'
        ? src.lastAudit
        : null;
      this.state.security = {
        credentials,
        lastConnectionTest,
        lastAudit
      };
      if (credentials) {
        this.state.connectionModeDraft = credentials.mode === 'BYOK' ? 'BYOK' : 'PROXY';
        const proxy = credentials.proxy && typeof credentials.proxy === 'object' ? credentials.proxy : {};
        this.state.proxyDraft = {
          ...this.state.proxyDraft,
          baseUrl: typeof proxy.baseUrl === 'string' ? proxy.baseUrl : '',
          authHeaderName: typeof proxy.authHeaderName === 'string' && proxy.authHeaderName
            ? proxy.authHeaderName
            : 'X-NT-Token',
          projectId: typeof proxy.projectId === 'string' ? proxy.projectId : '',
          persistToken: proxy.authTokenPersisted === true
        };
      }
    }

    renderCredentials() {
      const security = this.state.security && typeof this.state.security === 'object'
        ? this.state.security
        : {};
      const credentials = security.credentials && typeof security.credentials === 'object'
        ? security.credentials
        : null;
      const mode = credentials && credentials.mode === 'BYOK' ? 'BYOK' : 'PROXY';
      const proxy = credentials && credentials.proxy && typeof credentials.proxy === 'object'
        ? credentials.proxy
        : {};
      if (this.connectionModeProxy) {
        this.connectionModeProxy.checked = mode === 'PROXY';
      }
      if (this.connectionModeByok) {
        this.connectionModeByok.checked = mode === 'BYOK';
      }
      if (this.proxyUrlInput && this.proxyUrlInput !== this.doc.activeElement) {
        this.proxyUrlInput.value = this.state.proxyDraft.baseUrl || '';
      }
      if (this.proxyProjectIdInput && this.proxyProjectIdInput !== this.doc.activeElement) {
        this.proxyProjectIdInput.value = this.state.proxyDraft.projectId || '';
      }
      if (this.proxyHeaderNameInput && this.proxyHeaderNameInput !== this.doc.activeElement) {
        this.proxyHeaderNameInput.value = this.state.proxyDraft.authHeaderName || 'X-NT-Token';
      }
      if (this.proxyTokenPersistCheckbox) {
        this.proxyTokenPersistCheckbox.checked = this.state.proxyDraft.persistToken === true;
      }
      if (this.byokPersistCheckbox) {
        this.byokPersistCheckbox.checked = this.state.byokDraft.persist === true;
      }
      if (this.byokPersistConfirmCheckbox) {
        this.byokPersistConfirmCheckbox.checked = this.state.byokDraft.persistConfirmed === true;
      }

      const hasByok = credentials ? credentials.hasByokKey === true : false;
      const byokPersisted = credentials ? credentials.byokPersisted === true : false;
      const hasProxyToken = proxy && proxy.hasAuthToken === true;
      const proxyBase = typeof proxy.baseUrl === 'string' ? proxy.baseUrl : '';
      this._setConnectionStatus(
        `Подключение: mode=${mode}, BYOK=${hasByok ? 'configured' : 'empty'}, proxy=${proxyBase || '—'}, token=${hasProxyToken ? 'yes' : 'no'}`
      );
      if (this.credentialsWarning) {
        this.credentialsWarning.textContent = byokPersisted
          ? 'Внимание: BYOK ключ сохранён постоянно. Это менее безопасно.'
          : 'Внимание: BYOK в браузере менее безопасен, чем Proxy режим.';
      }

      const test = security.lastConnectionTest && typeof security.lastConnectionTest === 'object'
        ? security.lastConnectionTest
        : null;
      if (test) {
        if (test.ok) {
          this._setConnectionTestStatus(`Проверка: OK (${test.latencyMs} ms, ${test.endpointHost || 'endpoint'})`);
        } else {
          const errCode = test.error && test.error.code ? test.error.code : 'FAILED';
          this._setConnectionTestStatus(`Проверка: FAIL (${errCode})`);
        }
      } else {
        this._setConnectionTestStatus('Проверка: —');
      }
    }

    renderSettings() {
      this.renderCredentials();
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
      this.renderActiveJobsSummary();
      this.renderRuntimeCategoryChooser();
      this.updateActionButtons();
      this.renderTabs();
    }

    renderActiveJobsSummary() {
      const runtime = this.state.schedulerRuntime && typeof this.state.schedulerRuntime === 'object'
        ? this.state.schedulerRuntime
        : {};
      const jobs = Array.isArray(runtime.activeJobs) ? runtime.activeJobs : [];
      if (this.activeJobsSummary) {
        this.activeJobsSummary.textContent = `Активные задачи: ${jobs.length}`;
      }
      if (!this.activeJobsSelect) {
        if (this.gotoJobTabButton) {
          this.gotoJobTabButton.disabled = jobs.length === 0;
        }
        return;
      }
      const prevValue = this.activeJobsSelect.value;
      this.activeJobsSelect.innerHTML = '';
      if (!jobs.length) {
        const empty = this.doc.createElement('option');
        empty.value = '';
        empty.textContent = 'Нет активных задач';
        this.activeJobsSelect.appendChild(empty);
        this.activeJobsSelect.disabled = true;
      } else {
        const sorted = jobs.slice().sort((a, b) => {
          const ta = Number.isFinite(Number(a && a.tabId)) ? Number(a.tabId) : Number.MAX_SAFE_INTEGER;
          const tb = Number.isFinite(Number(b && b.tabId)) ? Number(b.tabId) : Number.MAX_SAFE_INTEGER;
          return ta - tb;
        });
        sorted.forEach((job) => {
          const tabId = Number.isFinite(Number(job && job.tabId)) ? Number(job.tabId) : null;
          const status = job && job.status ? String(job.status) : 'unknown';
          const progress = Number.isFinite(Number(job && job.progress)) ? Number(job.progress) : 0;
          const option = this.doc.createElement('option');
          option.value = tabId === null ? '' : String(tabId);
          option.textContent = `tab ${tabId === null ? '?' : tabId}: ${status} (${progress}%)`;
          option.title = job && job.id ? String(job.id) : '';
          this.activeJobsSelect.appendChild(option);
        });
        this.activeJobsSelect.disabled = false;
        if (prevValue && sorted.some((job) => String(job.tabId) === prevValue)) {
          this.activeJobsSelect.value = prevValue;
        } else {
          const current = sorted.find((job) => Number(job.tabId) === Number(this.activeTabId));
          this.activeJobsSelect.value = current ? String(current.tabId) : String(sorted[0].tabId);
        }
      }
      if (this.gotoJobTabButton) {
        this.gotoJobTabButton.disabled = jobs.length === 0;
      }
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
      const runtimePolicy = agentState && agentState.modelPolicy
        ? this.normalizeAgentModelPolicy(agentState.modelPolicy, modelPolicy)
        : modelPolicy;
      const preferenceText = runtimePolicy.preference === 'smartest'
        ? 'умные'
        : runtimePolicy.preference === 'cheapest'
          ? 'дешёвые'
          : 'без приоритета';
      const runtimePolicyText = `${runtimePolicy.mode === 'fixed' ? 'фикс.' : 'авто'} / ${preferenceText} / ${runtimePolicy.speed ? 'скорость' : 'качество'}`;
      const modelDecision = entry && entry.modelDecision && typeof entry.modelDecision === 'object'
        ? entry.modelDecision
        : null;
      const chosenModelSpec = modelDecision && typeof modelDecision.chosenModelSpec === 'string'
        ? modelDecision.chosenModelSpec
        : '';
      const modelLimitsMap = this.state.modelLimitsBySpec && typeof this.state.modelLimitsBySpec === 'object'
        ? this.state.modelLimitsBySpec
        : {};
      const limits = chosenModelSpec && modelLimitsMap[chosenModelSpec] && typeof modelLimitsMap[chosenModelSpec] === 'object'
        ? modelLimitsMap[chosenModelSpec]
        : null;
      const modelText = chosenModelSpec
        ? `Модели: ${chosenModelSpec} · ${runtimePolicyText}`
        : `Модели: ${runtimePolicyText}`;
      let modelTitle = 'Эффективная политика выбора модели для переводчика-агента';
      if (chosenModelSpec) {
        modelTitle = `Фактическая модель: ${chosenModelSpec}. Политика: ${runtimePolicyText}.`;
        if (limits) {
          const show = (value) => (value === null || value === undefined ? '—' : String(value));
          modelTitle = `${modelTitle} RPM=${show(limits.remainingRequests)}/${show(limits.limitRequests)} до ${this._formatTimestamp(limits.resetRequestsAt)}; TPM=${show(limits.remainingTokens)}/${show(limits.limitTokens)} до ${this._formatTimestamp(limits.resetTokensAt)}; cooldown=${this._formatTimestamp(limits.cooldownUntilTs)}`;
        }
      }
      const cacheText = `Кэш: стр=${this.state.translationPageCacheEnabled ? 'вкл' : 'выкл'} · api=${this.state.translationApiCacheEnabled ? 'вкл' : 'выкл'}`;

      if (this.statusChipPipeline) {
        this.statusChipPipeline.textContent = pipelineText;
        this.statusChipPipeline.setAttribute('title', 'Состояние пайплайна перевода на текущей вкладке');
      }
      if (this.statusChipModel) {
        this.statusChipModel.textContent = modelText;
        this.statusChipModel.setAttribute('title', modelTitle);
      }
      if (this.statusChipCache) {
        this.statusChipCache.textContent = cacheText;
        this.statusChipCache.setAttribute('title', 'Состояние кэширования перевода страницы и ответов API');
      }
    }

    renderRuntimeDiagnostics({ job, agentState, entry, progress, message } = {}) {
      if (!this.statusMetricsRoot && !this.statusTrace) {
        return;
      }
      const safeEntry = entry && typeof entry === 'object' ? entry : {};
      const safeJob = job && typeof job === 'object' ? job : null;
      const safeEntryTotal = Object.prototype.hasOwnProperty.call(safeEntry, 'total') ? safeEntry.total : null;
      const safeEntryCompleted = Object.prototype.hasOwnProperty.call(safeEntry, 'completed') ? safeEntry.completed : null;
      const safeEntryFailed = Object.prototype.hasOwnProperty.call(safeEntry, 'failedBlocksCount')
        ? safeEntry.failedBlocksCount
        : null;
      const safeEntryInProgress = Object.prototype.hasOwnProperty.call(safeEntry, 'inProgress')
        ? safeEntry.inProgress
        : null;
      const safeEntryUpdatedAt = Object.prototype.hasOwnProperty.call(safeEntry, 'updatedAt')
        ? safeEntry.updatedAt
        : null;
      const toCount = (value, fallback = 0) => {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          return Number.isFinite(Number(fallback)) ? Math.max(0, Number(fallback)) : 0;
        }
        return Math.max(0, numeric);
      };
      const total = toCount(safeJob && safeJob.totalBlocks, toCount(safeEntryTotal, 0));
      const completed = toCount(safeJob && safeJob.completedBlocks, toCount(safeEntryCompleted, 0));
      const failed = toCount(
        safeJob && safeJob.failedBlocksCount,
        toCount(safeEntryFailed, toCount(this.state.failedBlocksCount, 0))
      );
      const inProgress = toCount(safeEntryInProgress, Math.max(0, total - completed - failed));

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
      const updatedAt = Number.isFinite(Number(safeJob && safeJob.updatedAt))
        ? Number(safeJob.updatedAt)
        : (Number.isFinite(Number(safeEntryUpdatedAt)) ? Number(safeEntryUpdatedAt) : null);
      const fetchDebug = this._resolveFetchDebugPayload({
        job: safeJob,
        entry: safeEntry,
        stateLastError: this.state.lastError
      });

      const pipelineStatus = safeJob && safeJob.status
        ? this._jobStatusLabel(safeJob.status)
        : (safeEntry.status ? this._jobStatusLabel(safeEntry.status) : '—');
      const phase = agentState && agentState.phase ? this._phaseLabel(agentState.phase) : '—';
      const profile = agentState && agentState.profile
        ? this._profileLabel(this.normalizeAgentProfile(agentState.profile))
        : this._profileLabel(this.normalizeAgentProfile(this.state.translationAgentProfile));

      const planStyle = plan && plan.style ? String(plan.style) : '—';
      const planBatch = plan && Number.isFinite(Number(plan.batchSize)) ? String(Math.round(Number(plan.batchSize))) : '—';
      const planProof = plan && Number.isFinite(Number(plan.proofreadingPasses)) ? String(Math.round(Number(plan.proofreadingPasses))) : '—';
      const planParallel = plan && plan.parallelism ? String(plan.parallelism) : '—';
      const lastRate = agentState && agentState.lastRateLimits && typeof agentState.lastRateLimits === 'object'
        ? agentState.lastRateLimits
        : null;
      const rateHeaders = lastRate && lastRate.headersSubset && typeof lastRate.headersSubset === 'object'
        ? lastRate.headersSubset
        : {};
      const rateValue = lastRate
        ? `RPM ${rateHeaders['x-ratelimit-remaining-requests'] || '—'}/${rateHeaders['x-ratelimit-limit-requests'] || '—'} | TPM ${rateHeaders['x-ratelimit-remaining-tokens'] || '—'}/${rateHeaders['x-ratelimit-limit-tokens'] || '—'}`
        : '—';

      const metrics = [
        {
          label: 'Job ID',
          value: this._shortId(safeJob && safeJob.id ? safeJob.id : ''),
          title: safeJob && safeJob.id ? safeJob.id : 'Идентификатор активной задачи'
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
          value: this._shortId(safeJob && safeJob.currentBatchId ? safeJob.currentBatchId : ''),
          title: safeJob && safeJob.currentBatchId ? safeJob.currentBatchId : 'Идентификатор текущего батча'
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
          label: 'Rate limit',
          value: rateValue,
          title: 'Последние заголовки x-ratelimit-* (RPM/TPM)'
        },
        {
          label: 'Обновлено',
          value: this._formatTimestamp(updatedAt),
          title: 'Время последнего обновления состояния'
        }
      ];
      if (fetchDebug) {
        metrics.push({
          label: 'OpenAI сеть',
          value: this._formatFetchDebugSummary(fetchDebug),
          title: 'Диагностика транспорта и probe при FETCH_FAILED'
        });
      }

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
          job: safeJob,
          agentState,
          message,
          fetchDebug
        });
      }
    }

    _buildRuntimeTrace({ job, agentState, message, fetchDebug } = {}) {
      const parts = [];
      if (message) {
        parts.push(`msg: ${this._truncateStatusText(String(message), 64)}`);
      }
      const runtime = job && job.runtime && typeof job.runtime === 'object'
        ? job.runtime
        : null;
      if (runtime) {
        const stage = runtime.stage || 'stage?';
        const status = runtime.status || 'status?';
        const retryAttempt = runtime.retry && Number.isFinite(Number(runtime.retry.attempt))
          ? Number(runtime.retry.attempt)
          : 0;
        parts.push(`runtime: ${status}/${stage} retry=${retryAttempt}`);
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
      if (fetchDebug) {
        const steps = this._formatFetchDebugSteps(fetchDebug);
        if (steps) {
          parts.push(`net: ${steps}`);
        }
      }

      return parts.length
        ? parts.join(' | ')
        : 'Подробных live-событий пока нет. После запуска здесь появятся последние отчёты и вызовы инструментов.';
    }

    _resolveFetchDebugPayload({ job, entry, stateLastError } = {}) {
      const pickDebug = (errorValue) => {
        if (!errorValue || typeof errorValue !== 'object') {
          return null;
        }
        const nested = errorValue.error && typeof errorValue.error === 'object'
          ? errorValue.error
          : null;
        const debug = nested && nested.debug && typeof nested.debug === 'object'
          ? nested.debug
          : (errorValue.debug && typeof errorValue.debug === 'object' ? errorValue.debug : null);
        if (!debug || !debug.probe || typeof debug.probe !== 'object') {
          return null;
        }
        return debug;
      };

      const candidates = [
        job && job.lastError ? job.lastError : null,
        stateLastError && typeof stateLastError === 'object' ? stateLastError : null,
        entry && entry.lastError ? entry.lastError : null
      ];
      for (let i = 0; i < candidates.length; i += 1) {
        const debug = pickDebug(candidates[i]);
        if (debug) {
          return debug;
        }
      }
      return null;
    }

    _formatFetchDebugSummary(debug) {
      if (!debug || typeof debug !== 'object') {
        return '—';
      }
      const parts = [];
      if (typeof debug.baseUrl === 'string' && debug.baseUrl) {
        parts.push(debug.baseUrl);
      }
      if (typeof debug.online === 'boolean') {
        parts.push(debug.online ? 'online' : 'offline');
      } else if (debug.probe && typeof debug.probe.online === 'boolean') {
        parts.push(debug.probe.online ? 'online' : 'offline');
      }
      if (Array.isArray(debug.transportTried) && debug.transportTried.length) {
        parts.push(`transport=${debug.transportTried.join('->')}`);
      }
      const probe = debug.probe && typeof debug.probe === 'object' ? debug.probe : null;
      if (probe && typeof probe.ok === 'boolean') {
        parts.push(`probe=${probe.ok ? 'ok' : 'fail'}`);
      }
      return parts.length ? parts.join(' | ') : '—';
    }

    _formatFetchDebugSteps(debug) {
      const probe = debug && debug.probe && typeof debug.probe === 'object'
        ? debug.probe
        : null;
      const steps = probe && Array.isArray(probe.steps) ? probe.steps : [];
      if (!steps.length) {
        return '';
      }
      return steps.slice(0, 3).map((step) => {
        const row = step && typeof step === 'object' ? step : {};
        const name = row.name ? String(row.name) : 'step';
        if (Number.isFinite(Number(row.status))) {
          return `${name}:HTTP${Number(row.status)}`;
        }
        const err = row.errMessage ? String(row.errMessage) : 'error';
        return `${name}:${this._truncateStatusText(err, 36)}`;
      }).join('; ');
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
      return job.status === 'awaiting_categories'
        && this._currentAvailableCategories().length > 0;
    }

    _categoryChooserHintText() {
      const job = this.state.translationJob || null;
      if (!job) {
        return '';
      }
      if (job.status === 'awaiting_categories') {
        return 'Планирование завершено. Выберите рекомендованные категории и запустите перевод. Дополнительные категории можно выбрать позже.';
      }
      return '';
    }

    updateVisibilityIcon() {
      const mode = this.normalizeDisplayMode(this.state.translationDisplayMode, this.state.translationVisible);
      this.state.translationDisplayMode = mode;
      this.state.translationVisible = mode !== 'original';
      if (this.displayModeSelect) {
        if (this.displayModeSelect.value !== mode) {
          this.displayModeSelect.value = mode;
        }
        this.displayModeSelect.setAttribute(
          'title',
          mode === 'compare'
            ? 'Сравнение подсвечивает изменения. Для больших блоков см. debug.'
            : (mode === 'original' ? 'Показ оригинального текста страницы' : 'Показ переведённого текста страницы')
        );
      }
    }

    updateActionButtons() {
      const job = this.state.translationJob || null;
      const running = job && (job.status === 'running' || job.status === 'preparing' || job.status === 'completing');
      const cancellable = job && (job.status === 'running' || job.status === 'preparing' || job.status === 'completing' || job.status === 'awaiting_categories');
      const categoryStep = this._isCategorySelectionStep();
      const canSubmitCategories = !categoryStep || this._currentCategoryDraft().length > 0;
      const selectedCategories = this._currentSelectedCategories();
      const canProofread = this.activeTabId !== null
        && Boolean(job)
        && (job.status === 'running'
          || job.status === 'done'
          || job.status === 'failed'
          || job.status === 'awaiting_categories');
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
      if (this.proofreadAutoButton) {
        this.proofreadAutoButton.disabled = !canProofread || selectedCategories.length === 0;
        this.proofreadAutoButton.setAttribute(
          'title',
          selectedCategories.length
            ? 'Агент сам выберет блоки для вычитки в выбранных категориях'
            : 'Сначала выберите хотя бы одну категорию'
        );
      }
      if (this.proofreadAllButton) {
        this.proofreadAllButton.disabled = !canProofread || selectedCategories.length === 0;
        this.proofreadAllButton.setAttribute(
          'title',
          selectedCategories.length
            ? 'Запустить вычитку всех выбранных категорий'
            : 'Сначала выберите хотя бы одну категорию'
        );
      }
      if (this.proofreadCurrentCategoryButton) {
        this.proofreadCurrentCategoryButton.disabled = !canProofread || selectedCategories.length === 0;
        this.proofreadCurrentCategoryButton.setAttribute(
          'title',
          selectedCategories.length
            ? `Запустить вычитку категории: ${selectedCategories[0]}`
            : 'Сначала выберите хотя бы одну категорию'
        );
      }
    }
  }

  async function resolveInitialPopupTabId(chromeApi) {
    try {
      const query = new URLSearchParams(global.location && global.location.search ? global.location.search : '');
      const fromQuery = Number(query.get('tabId'));
      if (Number.isFinite(fromQuery)) {
        return fromQuery;
      }
    } catch (_) {
      // fallback to active tab query
    }
    if (!chromeApi || !chromeApi.tabs || typeof chromeApi.tabs.query !== 'function') {
      return null;
    }
    return new Promise((resolve) => {
      try {
        chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const first = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
          resolve(first && Number.isFinite(Number(first.id)) ? Number(first.id) : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  (async () => {
    const initialTabId = await resolveInitialPopupTabId(global.chrome);
    const ui = new global.NT.UiModule({
      chromeApi: global.chrome,
      portName: 'popup',
      helloContext: { tabId: initialTabId }
    }).init();

    const controller = new PopupController({ doc: global.document, ui });
    ui.setHandlers({
      onSnapshot: (payload) => controller.applySnapshot(payload),
      onPatch: (payload) => controller.applyPatch(payload)
    });
    controller.init();
  })();
})(globalThis);
