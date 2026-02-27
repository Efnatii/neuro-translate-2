(function initPopup(global) {
  const NT = global.NT || {};
  const Ui = NT.Ui;
  const UiProtocol = NT.UiProtocol || {};
  const I18n = NT.UiI18nRu || null;
  const PopupVm = NT.PopupViewModel || null;

  if (!Ui || !I18n || !PopupVm || !NT.UiProtocolClient) {
    return;
  }

  function safeString(value, fallback = '') {
    if (value === null || value === undefined) {
      return fallback;
    }
    return String(value);
  }

  function shortText(value, limit = 160) {
    const text = safeString(value, '').replace(/\s+/g, ' ').trim();
    if (!text) {
      return '';
    }
    return text.length <= limit ? text : `${text.slice(0, Math.max(1, limit - 1))}...`;
  }

  class PopupApp {
    constructor(doc) {
      this.doc = doc;
      this.root = this.doc.getElementById('popupRoot');
      this.fields = {};

      this.client = null;
      this.scheduler = new Ui.RenderScheduler();
      this.toasts = null;
      this.accordion = null;

      this.snapshot = {};
      this.vm = PopupVm.computeViewModel({}, {});
      this.uiStatus = {
        state: 'connecting',
        message: I18n.t('common.loading', 'Загрузка...')
      };

      this.categoryDraft = new Set();
      this.categoryDraftJobId = null;
      this.pendingSettingsPatch = {};
      this.flushSettingsDebounced = Ui.debounce(() => {
        this._flushSettingsPatch();
      }, 260);

      this._toolsRenderKey = '';
      this._allowlistRenderKey = '';
      this._categoriesRenderKey = '';
    }

    init(initialTabId) {
      this._cacheElements();
      this._bind();

      this.toasts = new Ui.Toasts(this.fields.toastHost);
      this.accordion = new Ui.Accordion(this.fields.accordionRoot, {
        onToggle: (sectionId, isOpen) => {
          this._queueSettingsPatch({
            userSettings: {
              ui: {
                collapseState: {
                  [sectionId]: isOpen === true
                }
              }
            }
          });
        }
      });

      this.client = new NT.UiProtocolClient({ channelName: 'popup' });
      this.client
        .onStatus((status) => {
          this.uiStatus = status || this.uiStatus;
          this._scheduleRender();
        })
        .onSnapshot((payload) => {
          this.snapshot = PopupVm.cloneJson(payload, {}) || {};
          this._scheduleRender();
        })
        .onPatch((patch) => {
          this.snapshot = PopupVm.applyPatch(this.snapshot, patch);
          this._scheduleRender();
        });

      this.client.setHelloContext({ tabId: initialTabId });
      this.client.connect();
      this._scheduleRender();
    }

    _cacheElements() {
      this.fields.connectionBadge = this.doc.querySelector('[data-field="connection-badge"]');
      this.fields.connectionText = this.doc.querySelector('[data-field="connection-text"]');

      this.fields.stage = this.doc.querySelector('[data-field="stage"]');
      this.fields.progress = this.doc.querySelector('[data-field="progress"]');
      this.fields.progressDone = this.doc.querySelector('[data-field="progress-done"]');
      this.fields.progressPending = this.doc.querySelector('[data-field="progress-pending"]');
      this.fields.progressFailed = this.doc.querySelector('[data-field="progress-failed"]');
      this.fields.agentDigest = this.doc.querySelector('[data-field="agent-digest"]');
      this.fields.agentLine1 = this.doc.querySelector('[data-field="agent-line-1"]');
      this.fields.agentLine2 = this.doc.querySelector('[data-field="agent-line-2"]');
      this.fields.leaseWarning = this.doc.querySelector('[data-field="lease-warning"]');

      this.fields.categoryChooser = this.doc.querySelector('[data-section="category-chooser"]');
      this.fields.categoryChooserList = this.doc.querySelector('[data-section="category-chooser-list"]');
      this.fields.categoryQuestion = this.doc.querySelector('[data-field="category-question"]');
      this.fields.reclassifyForceBtn = this.doc.querySelector('[data-field="reclassify-force-btn"]');
      this.fields.categoriesHiddenHint = this.doc.querySelector('[data-field="categories-hidden-hint"]');

      this.fields.profileSelect = this.doc.querySelector('[data-field="profile-select"]');
      this.fields.profileEffect = this.doc.querySelector('[data-field="profile-effect"]');

      this.fields.reasoningSelect = this.doc.querySelector('[data-field="reasoning-select"]');
      this.fields.cacheRetentionSelect = this.doc.querySelector('[data-field="cache-retention-select"]');
      this.fields.routingModeSelect = this.doc.querySelector('[data-field="routing-mode-select"]');
      this.fields.modelAllowlist = this.doc.querySelector('[data-field="model-allowlist"]');
      this.fields.toolsList = this.doc.querySelector('[data-field="tools-list"]');
      this.fields.rateLimits = this.doc.querySelector('[data-field="rate-limits"]');

      this.fields.errorBox = this.doc.querySelector('[data-field="error-box"]');
      this.fields.errorCode = this.doc.querySelector('[data-field="error-code"]');
      this.fields.errorMessage = this.doc.querySelector('[data-field="error-message"]');
      this.fields.errorEmpty = this.doc.querySelector('[data-field="error-empty"]');

      this.fields.accordionRoot = this.doc.querySelector('[data-field="accordion-root"]');
      this.fields.toastHost = this.doc.querySelector('[data-field="toast-host"]');
    }

    _bind() {
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
        this._handleAction(action, trigger).catch((error) => this._showErrorToast(error));
      });

      this.root.addEventListener('change', (event) => {
        const target = event && event.target ? event.target : null;
        if (!target || !target.getAttribute) {
          return;
        }

        if (target === this.fields.profileSelect) {
          this._queueSettingsPatch({ userSettings: { profile: safeString(target.value, 'auto') } });
          return;
        }
        if (target === this.fields.reasoningSelect) {
          const effort = safeString(target.value, 'auto');
          const patch = effort === 'auto'
            ? { reasoning: { reasoningMode: 'auto' } }
            : { reasoning: { reasoningMode: 'custom', reasoningEffort: effort } };
          this._queueSettingsPatch({ userSettings: patch });
          return;
        }
        if (target === this.fields.cacheRetentionSelect) {
          this._queueSettingsPatch({ userSettings: { caching: { promptCacheRetention: safeString(target.value, 'auto') } } });
          return;
        }
        if (target === this.fields.routingModeSelect) {
          this._queueSettingsPatch({ userSettings: { models: { modelRoutingMode: safeString(target.value, 'auto') } } });
          return;
        }
        if (target === this.fields.modelAllowlist) {
          const selected = Array.from(target.selectedOptions || [])
            .map((option) => safeString(option.value, '').trim())
            .filter(Boolean);
          this._queueSettingsPatch({
            userSettings: { models: { agentAllowedModels: selected } },
            translationAgentAllowedModels: selected
          });
          return;
        }

        const toolMode = target.getAttribute('data-tool-mode');
        if (toolMode) {
          const toolKey = target.getAttribute('data-tool-key');
          if (!toolKey) {
            return;
          }
          this._queueSettingsPatch({ userSettings: { agent: { toolConfigUser: { [toolKey]: safeString(target.value, 'auto') } } } });
          return;
        }

        const categoryToggle = target.getAttribute('data-category-toggle');
        if (categoryToggle) {
          const categoryId = safeString(categoryToggle, '').trim().toLowerCase();
          if (!categoryId) {
            return;
          }
          if (target.checked) {
            this.categoryDraft.add(categoryId);
          } else {
            this.categoryDraft.delete(categoryId);
          }
        }
      });
    }

    async _handleAction(action, trigger) {
      if (action === 'open-debug' || action === 'open-debug-from-error') {
        this._openDebugPage('overview');
        return;
      }

      if (action === 'start-translation') {
        if (this.vm.awaitingCategories) {
          await this._applyCategorySelection();
          return;
        }
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.START_TRANSLATION : 'START_TRANSLATION', {
          tabId: this.vm.tabId
        });
        return;
      }

      if (action === 'cancel-translation') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CANCEL_TRANSLATION : 'CANCEL_TRANSLATION', {
          tabId: this.vm.tabId
        });
        return;
      }

      if (action === 'clear-translation-data') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.CLEAR_TRANSLATION_DATA : 'CLEAR_TRANSLATION_DATA', {
          tabId: this.vm.tabId,
          includeCache: true
        });
        return;
      }

      if (action === 'set-view-mode') {
        const mode = trigger && trigger.getAttribute ? safeString(trigger.getAttribute('data-mode'), 'translated') : 'translated';
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_TRANSLATION_VISIBILITY : 'SET_TRANSLATION_VISIBILITY', {
          tabId: this.vm.tabId,
          mode,
          visible: mode !== 'original'
        });
        return;
      }

      if (action === 'start-selected-categories') {
        await this._applyCategorySelection();
        return;
      }

      if (action === 'reclassify-force') {
        await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.RECLASSIFY_BLOCKS : 'RECLASSIFY_BLOCKS', {
          tabId: this.vm.tabId,
          jobId: this.vm.job && this.vm.job.id ? this.vm.job.id : null,
          force: true
        });
        this.toasts.show('Классификация обновлена. Проверьте категории.', { tone: 'ok' });
        return;
      }

      if (action === 'add-categories-later') {
        this.toasts.show('Вы сможете выбрать дополнительные категории позже.', { tone: 'info' });
        return;
      }

      if (action === 'open-advanced' && this.accordion) {
        this.accordion.setOpen('advanced', true);
      }
    }

    async _applyCategorySelection() {
      const categories = Array.from(this.categoryDraft.values()).filter(Boolean);
      if (!categories.length) {
        this.toasts.show('Выберите минимум одну категорию.', { tone: 'warn' });
        return;
      }
      await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_TRANSLATION_CATEGORIES : 'SET_TRANSLATION_CATEGORIES', {
        tabId: this.vm.tabId,
        jobId: this.vm.job && this.vm.job.id ? this.vm.job.id : null,
        categories,
        mode: 'replace'
      });
      await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.KICK_SCHEDULER : 'KICK_SCHEDULER', {
        tabId: this.vm.tabId
      }, { timeoutMs: 2500, retries: 0 }).catch(() => null);
      this.toasts.show('Выбор категорий применен.', { tone: 'ok' });
    }

    _queueSettingsPatch(patch) {
      this.pendingSettingsPatch = PopupVm.mergeDeep(this.pendingSettingsPatch || {}, patch || {});
      this.flushSettingsDebounced();
    }

    async _flushSettingsPatch() {
      const patch = this.pendingSettingsPatch && typeof this.pendingSettingsPatch === 'object' ? this.pendingSettingsPatch : null;
      this.pendingSettingsPatch = {};
      if (!patch || !Object.keys(patch).length) {
        return;
      }
      await this._sendCommand(UiProtocol.Commands ? UiProtocol.Commands.SET_SETTINGS : 'SET_SETTINGS', {
        patch,
        expectedSchemaVersion: this.vm.settings && Number.isFinite(Number(this.vm.settings.schemaVersion))
          ? Number(this.vm.settings.schemaVersion)
          : null
      }, { timeoutMs: 5000, retries: 1 });
    }

    async _sendCommand(type, payload, options = {}) {
      if (!this.client) {
        throw new Error('UI client not initialized');
      }
      const commandType = safeString(type, '').trim();
      if (!commandType) {
        throw new Error('Команда не указана');
      }
      const result = await this.client.sendCommand(commandType, payload && typeof payload === 'object' ? payload : {}, options);
      if (!result || result.ok !== false) {
        return result;
      }
      const errorMessage = result.error && result.error.message
        ? result.error.message
        : I18n.t('common.errorUnknown', 'Неизвестная ошибка');
      throw new Error(errorMessage);
    }

    _openDebugPage(section) {
      const runtime = global.chrome && global.chrome.runtime ? global.chrome.runtime : null;
      const tabs = global.chrome && global.chrome.tabs ? global.chrome.tabs : null;
      if (!runtime || !tabs || typeof runtime.getURL !== 'function' || typeof tabs.create !== 'function') {
        return;
      }
      const url = new URL(runtime.getURL('extension/ui/debug.html'));
      if (Number.isFinite(Number(this.vm.tabId))) {
        url.searchParams.set('tabId', String(this.vm.tabId));
      }
      if (section) {
        url.hash = String(section).startsWith('#') ? String(section) : `#${section}`;
      }
      tabs.create({ url: url.toString() });
    }

    _scheduleRender() {
      this.scheduler.queueRender(() => {
        this.vm = PopupVm.computeViewModel(this.snapshot, this.uiStatus);
        this._syncCollapseState();
        this._syncCategoryDraft();
        this._render();
      });
    }

    _syncCollapseState() {
      const collapseState = this.vm
        && this.vm.settings
        && this.vm.settings.userSettings
        && this.vm.settings.userSettings.ui
        && this.vm.settings.userSettings.ui.collapseState
        && typeof this.vm.settings.userSettings.ui.collapseState === 'object'
        ? this.vm.settings.userSettings.ui.collapseState
        : null;
      if (this.accordion && collapseState) {
        this.accordion.sync(collapseState);
      }
      if (this.accordion && (!collapseState || !Object.keys(collapseState).length)) {
        this.accordion.setOpen('status', true);
        this.accordion.setOpen('categories', false);
        this.accordion.setOpen('profile', false);
        this.accordion.setOpen('advanced', false);
        this.accordion.setOpen('errors', false);
      }
    }

    _syncCategoryDraft() {
      if (!this.vm.awaitingCategories) {
        this.categoryDraft.clear();
        this.categoryDraftJobId = null;
        return;
      }
      const jobId = this.vm.job && this.vm.job.id ? this.vm.job.id : '__no_job__';
      if (this.categoryDraftJobId === jobId && this.categoryDraft.size) {
        return;
      }
      this.categoryDraft.clear();
      const items = this.vm.categories && Array.isArray(this.vm.categories.items) ? this.vm.categories.items : [];
      items.forEach((item) => {
        if (!item || item.disabled) {
          return;
        }
        if (item.selected === true) {
          this.categoryDraft.add(item.id);
        }
      });
      this.categoryDraftJobId = jobId;
    }

    _render() {
      this._renderConnection();
      this._renderStatus();
      this._renderCategories();
      this._renderProfile();
      this._renderAdvanced();
      this._renderErrors();
      this._renderViewModeButtons();
      this._renderButtonsState();
    }

    _renderConnection() {
      const state = safeString(this.vm.connectionState, 'connecting');
      let tone = 'neutral';
      let label = I18n.t('common.loading', 'Загрузка...');
      if (state === 'connected') {
        tone = 'ok';
        label = I18n.t('common.connected', 'Связь с фоном есть');
      } else if (state === 'reconnecting') {
        tone = 'warn';
        label = I18n.t('common.reconnecting', 'Нет связи, переподключаюсь...');
      } else if (state === 'disconnected') {
        tone = 'danger';
        label = I18n.t('common.disconnected', 'Нет связи');
      }
      if (this.fields.connectionBadge) {
        this.fields.connectionBadge.className = `nt-badge nt-badge--${tone}`;
        Ui.setText(this.fields.connectionBadge, state.toUpperCase(), '...');
      }
      Ui.setText(this.fields.connectionText, shortText(this.vm.connectionMessage || label, 140), label);
    }

    _renderStatus() {
      Ui.setText(this.fields.stage, I18n.stageLabel(this.vm.stage), I18n.t('common.noData', 'Нет данных'));
      if (this.fields.progress) {
        this.fields.progress.value = Math.max(0, Math.min(100, Number(this.vm.progress.percent || 0)));
      }
      Ui.setText(this.fields.progressDone, `Готово: ${Number(this.vm.progress.done || 0)}`);
      Ui.setText(this.fields.progressPending, `Ожидает: ${Number(this.vm.progress.pending || 0)}`);
      Ui.setText(this.fields.progressFailed, `С ошибкой: ${Number(this.vm.progress.failed || 0)}`);
      Ui.setText(this.fields.agentDigest, shortText(this.vm.agentStatus.digest, 180) || I18n.t('common.noData', 'Нет данных'));
      Ui.setText(this.fields.agentLine1, shortText(this.vm.agentStatus.line1, 180));
      Ui.setText(this.fields.agentLine2, shortText(this.vm.agentStatus.line2, 180));

      const leaseExpired = this.vm.status === 'running'
        && Number.isFinite(Number(this.vm.leaseUntilTs))
        && Number(this.vm.leaseUntilTs) < Date.now();
      Ui.setHidden(this.fields.leaseWarning, !leaseExpired);
      if (leaseExpired) {
        Ui.setText(this.fields.leaseWarning, I18n.t('popup.leaseWarning', 'Lease задачи истек. Откройте отладку и проверьте планировщик.'));
      }
    }

    _renderCategories() {
      const awaiting = this.vm.awaitingCategories === true;
      const staleSelection = (
        this.vm.job
        && this.vm.job.classificationStale === true
      ) || (
        this.vm.lastError
        && this.vm.lastError.code === 'CLASSIFICATION_STALE'
      );
      Ui.setHidden(this.fields.categoryChooser, !awaiting);
      Ui.setHidden(this.fields.categoriesHiddenHint, awaiting);
      Ui.setHidden(this.fields.reclassifyForceBtn, !(awaiting && staleSelection));
      if (!awaiting) {
        return;
      }

      Ui.setText(this.fields.categoryQuestion, this.vm.categories.userQuestion || I18n.t('popup.categoriesHint', 'Категории появятся после этапа планирования.'));
      const items = this.vm.categories && Array.isArray(this.vm.categories.items) ? this.vm.categories.items : [];
      const renderKey = JSON.stringify({
        ids: items.map((row) => [row.id, row.mode, row.disabled, row.countUnits]),
        draft: Array.from(this.categoryDraft.values()).sort()
      });
      if (this._categoriesRenderKey === renderKey) {
        return;
      }
      this._categoriesRenderKey = renderKey;

      Ui.clearNode(this.fields.categoryChooserList);
      if (!items.length) {
        this.fields.categoryChooserList.appendChild(Ui.createElement('div', {
          className: 'popup__hint',
          text: I18n.t('common.noData', 'Нет данных')
        }));
        return;
      }

      items.forEach((item) => {
        const row = Ui.createElement('label', {
          className: `popup__category-row${item.disabled ? ' is-excluded' : ''}`
        });
        const checkbox = Ui.createElement('input', {
          attrs: {
            type: 'checkbox',
            'data-category-toggle': item.id
          }
        });
        checkbox.checked = this.categoryDraft.has(item.id);
        checkbox.disabled = item.disabled === true;

        const content = Ui.createElement('div');
        content.appendChild(Ui.createElement('div', { className: 'popup__category-title', text: item.titleRu || item.id }));
        content.appendChild(Ui.createElement('div', { className: 'popup__category-desc', text: shortText(item.descriptionRu || '', 110) }));

        const tag = Ui.createElement('span', {
          className: 'popup__tag',
          text: `${item.mode} • ${Number(item.countUnits || 0)}`
        });

        row.appendChild(checkbox);
        row.appendChild(content);
        row.appendChild(tag);
        this.fields.categoryChooserList.appendChild(row);
      });
    }

    _renderProfile() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const user = settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : {};
      const profile = safeString(user.profile || settings.translationAgentProfile || 'auto', 'auto');
      if (this.fields.profileSelect && this.fields.profileSelect.value !== profile) {
        this.fields.profileSelect.value = profile;
      }
      const changed = settings.overrides && Array.isArray(settings.overrides.changed) ? settings.overrides.changed : [];
      const effective = settings.effectiveSettings && typeof settings.effectiveSettings === 'object' ? settings.effectiveSettings : {};
      Ui.setText(this.fields.profileEffect, [
        `profile: ${profile}`,
        `overrides: ${changed.length ? changed.join(', ') : 'нет'}`,
        `effective: ${shortText(JSON.stringify(effective), 220)}`
      ].join('\n'));
    }

    _renderAdvanced() {
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const user = settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : {};
      const reasoning = user.reasoning && typeof user.reasoning === 'object' ? user.reasoning : {};
      const reasoningValue = reasoning.reasoningMode === 'custom' ? safeString(reasoning.reasoningEffort, 'medium') : 'auto';
      if (this.fields.reasoningSelect && this.fields.reasoningSelect.value !== reasoningValue) {
        this.fields.reasoningSelect.value = reasoningValue;
      }
      const caching = user.caching && typeof user.caching === 'object' ? user.caching : {};
      const retention = safeString(caching.promptCacheRetention || 'auto', 'auto');
      if (this.fields.cacheRetentionSelect && this.fields.cacheRetentionSelect.value !== retention) {
        this.fields.cacheRetentionSelect.value = retention;
      }
      const models = user.models && typeof user.models === 'object' ? user.models : {};
      const routingMode = safeString(models.modelRoutingMode || 'auto', 'auto');
      if (this.fields.routingModeSelect && this.fields.routingModeSelect.value !== routingMode) {
        this.fields.routingModeSelect.value = routingMode;
      }

      this._renderAllowlist();
      this._renderTools();
      this._renderRateLimits();
    }

    _renderAllowlist() {
      const registry = this.snapshot && this.snapshot.modelRegistry && Array.isArray(this.snapshot.modelRegistry.entries)
        ? this.snapshot.modelRegistry.entries
        : [];
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const user = settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : {};
      const selected = user.models && Array.isArray(user.models.agentAllowedModels)
        ? user.models.agentAllowedModels
        : (Array.isArray(settings.translationAgentAllowedModels) ? settings.translationAgentAllowedModels : []);
      const selectedSet = new Set(selected.map((item) => safeString(item, '').trim()).filter(Boolean));
      const options = registry
        .map((entry) => {
          const id = safeString(entry && entry.id, '').trim();
          const tier = safeString(entry && entry.tier, 'standard').trim();
          if (!id) {
            return null;
          }
          return { value: `${id}:${tier}`, label: `${id} (${tier})` };
        })
        .filter(Boolean)
        .sort((a, b) => a.value.localeCompare(b.value));

      const key = JSON.stringify({ options, selected: Array.from(selectedSet.values()).sort() });
      if (this._allowlistRenderKey === key) {
        return;
      }
      this._allowlistRenderKey = key;
      Ui.clearNode(this.fields.modelAllowlist);
      options.forEach((item) => {
        const option = Ui.createElement('option', { text: item.label, attrs: { value: item.value } });
        option.selected = selectedSet.has(item.value);
        this.fields.modelAllowlist.appendChild(option);
      });
    }

    _renderTools() {
      const toolset = this.vm.toolset && Array.isArray(this.vm.toolset.tools) ? this.vm.toolset.tools : [];
      const settings = this.vm.settings && typeof this.vm.settings === 'object' ? this.vm.settings : {};
      const user = settings.userSettings && typeof settings.userSettings === 'object' ? settings.userSettings : {};
      const toolConfig = user.agent && user.agent.toolConfigUser && typeof user.agent.toolConfigUser === 'object'
        ? user.agent.toolConfigUser
        : {};

      const key = JSON.stringify({ tools: toolset.map((tool) => [tool.name, tool.descriptionShort]), toolConfig });
      if (this._toolsRenderKey === key) {
        return;
      }
      this._toolsRenderKey = key;
      Ui.clearNode(this.fields.toolsList);

      if (!toolset.length) {
        this.fields.toolsList.appendChild(Ui.createElement('div', { className: 'popup__hint', text: I18n.t('common.noData', 'Нет данных') }));
        return;
      }

      toolset.forEach((tool) => {
        const toolName = safeString(tool && tool.name, 'tool.unknown');
        const row = Ui.createElement('div', { className: 'popup__tool-row' });
        const left = Ui.createElement('div');
        left.appendChild(Ui.createElement('div', { className: 'popup__tool-name', text: toolName }));
        left.appendChild(Ui.createElement('div', { className: 'popup__category-desc', text: shortText(safeString(tool && tool.descriptionShort, ''), 96) }));

        const select = Ui.createElement('select', {
          className: 'popup__input',
          attrs: {
            'data-tool-mode': '1',
            'data-tool-key': toolName
          }
        });
        ['auto', 'on', 'off'].forEach((mode) => {
          const option = Ui.createElement('option', { text: mode, attrs: { value: mode } });
          if (mode === safeString(toolConfig[toolName], 'auto')) {
            option.selected = true;
          }
          select.appendChild(option);
        });

        row.appendChild(left);
        row.appendChild(select);
        this.fields.toolsList.appendChild(row);
      });
    }

    _renderRateLimits() {
      const limits = this.vm.modelLimitsBySpec && typeof this.vm.modelLimitsBySpec === 'object' ? this.vm.modelLimitsBySpec : {};
      const keys = Object.keys(limits).sort();
      if (!keys.length) {
        Ui.setText(this.fields.rateLimits, I18n.t('common.noData', 'Нет данных'));
        return;
      }
      const text = keys.slice(0, 10).map((spec) => {
        const item = limits[spec] && typeof limits[spec] === 'object' ? limits[spec] : {};
        const req = item.remainingRequests === null || item.remainingRequests === undefined ? '—' : String(item.remainingRequests);
        const tok = item.remainingTokens === null || item.remainingTokens === undefined ? '—' : String(item.remainingTokens);
        return `${spec} | req:${req} tok:${tok}`;
      }).join('\n');
      Ui.setText(this.fields.rateLimits, text);
    }

    _renderErrors() {
      const lastError = this.vm.lastError && typeof this.vm.lastError === 'object' ? this.vm.lastError : null;
      const hasError = Boolean(lastError);
      Ui.setHidden(this.fields.errorBox, !hasError);
      Ui.setHidden(this.fields.errorEmpty, hasError);
      if (!hasError) {
        return;
      }
      Ui.setText(this.fields.errorCode, safeString(lastError.code, 'UNKNOWN'));
      Ui.setText(this.fields.errorMessage, shortText(lastError.message, 220) || I18n.t('common.errorUnknown', 'Неизвестная ошибка'));
    }

    _renderViewModeButtons() {
      const mode = this.snapshot && this.snapshot.translationDisplayModeByTab && Number.isFinite(Number(this.vm.tabId))
        ? safeString(this.snapshot.translationDisplayModeByTab[this.vm.tabId], 'translated')
        : 'translated';
      const normalized = ['original', 'translated', 'compare'].includes(mode) ? mode : 'translated';
      const buttons = this.root.querySelectorAll('[data-action="set-view-mode"]');
      buttons.forEach((button) => {
        const value = button.getAttribute('data-mode');
        if (value === normalized) {
          button.classList.add('is-active');
        } else {
          button.classList.remove('is-active');
        }
      });
    }

    _renderButtonsState() {
      const busy = this.vm.status === 'running' || this.vm.status === 'preparing' || this.vm.status === 'planning';
      const hasTab = Number.isFinite(Number(this.vm.tabId));
      const start = this.root.querySelector('[data-action="start-translation"]');
      const cancel = this.root.querySelector('[data-action="cancel-translation"]');
      const erase = this.root.querySelector('[data-action="clear-translation-data"]');
      const startSelected = this.root.querySelector('[data-action="start-selected-categories"]');
      const reclassifyForce = this.root.querySelector('[data-action="reclassify-force"]');
      if (start) {
        start.disabled = !hasTab || busy;
      }
      if (cancel) {
        cancel.disabled = !hasTab || !(this.vm.status === 'running' || this.vm.status === 'planning' || this.vm.status === 'awaiting_categories');
      }
      if (erase) {
        erase.disabled = !hasTab;
      }
      if (startSelected) {
        startSelected.disabled = !hasTab || !this.vm.awaitingCategories || this.categoryDraft.size === 0;
      }
      if (reclassifyForce) {
        reclassifyForce.disabled = !hasTab || !this.vm.awaitingCategories;
      }
    }

    _showErrorToast(error) {
      const message = error && error.message ? error.message : I18n.t('common.errorUnknown', 'Неизвестная ошибка');
      this.toasts.show(shortText(message, 180), { tone: 'danger' });
    }
  }

  function resolveInitialTabId() {
    try {
      const params = new URLSearchParams(global.location.search || '');
      const value = Number(params.get('tabId'));
      if (Number.isFinite(value)) {
        return Promise.resolve(value);
      }
    } catch (_) {
      // fallback
    }
    if (!global.chrome || !global.chrome.tabs || typeof global.chrome.tabs.query !== 'function') {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      try {
        global.chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const first = Array.isArray(tabs) && tabs.length ? tabs[0] : null;
          resolve(first && Number.isFinite(Number(first.id)) ? Number(first.id) : null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  (async () => {
    const tabId = await resolveInitialTabId();
    const app = new PopupApp(global.document);
    app.init(tabId);
  })();
})(globalThis);
