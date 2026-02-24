(function initUiI18nRu(global) {
  const NT = global.NT || (global.NT = {});

  const dict = {
    common: {
      appName: 'Neuro Translate',
      noData: 'Нет данных',
      loading: 'Загрузка...',
      connected: 'Связь с фоном есть',
      reconnecting: 'Нет связи, переподключаюсь...',
      disconnected: 'Нет связи',
      copyDone: 'Скопировано в буфер',
      errorUnknown: 'Неизвестная ошибка',
      yes: 'Да',
      no: 'Нет'
    },
    stage: {
      idle: 'Ожидание',
      preparing: 'Сканирование',
      planning: 'Анализ агентом',
      awaiting_categories: 'Выбор категорий',
      running: 'Перевод',
      completing: 'Вычитка',
      proofreading: 'Вычитка',
      done: 'Готово',
      failed: 'Ошибка',
      cancelled: 'Отменено',
      unknown: 'Неизвестный этап'
    },
    status: {
      queued: 'В очереди',
      idle: 'Ожидание',
      running: 'Выполняется',
      done: 'Готово',
      failed: 'Ошибка',
      cancelled: 'Отменено'
    },
    popup: {
      subtitle: 'Управление переводом страницы',
      sectionStatus: 'Статус',
      sectionCategories: 'Категории',
      sectionProfile: 'Профиль и настройки',
      sectionAdvanced: 'Расширенные',
      sectionErrors: 'Ошибки',
      connection: 'Связь',
      currentStage: 'Текущий этап',
      progress: 'Прогресс',
      done: 'Готово',
      pending: 'Ожидает',
      failed: 'С ошибкой',
      agentStatus: 'Последний статус агента',
      whatNow: 'Что происходит сейчас',
      btnTranslate: 'Перевести',
      btnCancel: 'Отменить',
      btnErase: 'Стереть задачу и данные',
      btnDebug: 'Отладка',
      btnStartSelected: 'Начать перевод выбранного',
      btnAddLater: 'Добавить категории позже',
      btnOpenDebugError: 'Открыть отладку',
      modeOriginal: 'Оригинал',
      modeTranslated: 'Перевод',
      modeCompare: 'Сравнение',
      categoriesHint: 'Категории появятся после этапа планирования.',
      categoriesQuestion: 'Вопрос агента',
      profile: 'Профиль',
      profileEffect: 'Эффект профиля',
      showAdvanced: 'Расширенные настройки',
      reasoning: 'Reasoning',
      cacheRetention: 'Prompt cache retention',
      tools: 'Инструменты',
      models: 'Разрешенные модели',
      routingMode: 'Роутинг моделей',
      rateLimits: 'Rate limits',
      leaseWarning: 'Lease задачи истек. Откройте отладку и проверьте планировщик.'
    },
    debug: {
      title: 'Панель оператора',
      subtitle: 'Текущая вкладка и состояние задачи',
      navOverview: 'Обзор',
      navPlan: 'План',
      navTools: 'Инструменты',
      navDiffPatches: 'Diff / Патчи',
      navCategories: 'Категории',
      navMemory: 'Память',
      navRateLimits: 'Rate limits',
      navPerf: 'Perf',
      navSecurity: 'Security audit',
      navExport: 'Export',
      btnExportJson: 'Экспорт отчета JSON',
      btnExportHtml: 'Экспорт HTML',
      btnCopyDiagnostics: 'Копировать диагностику',
      btnKickScheduler: 'Пнуть планировщик',
      btnCancel: 'Отменить',
      btnErase: 'Стереть',
      btnReclassify: 'Переклассифицировать',
      btnRepair: 'Repair/Compact',
      planNotReady: 'План еще не построен для текущей задачи.',
      categoriesHidden: 'Категории показываются только при awaiting_categories.',
      includeTextMode: 'Режим текста в экспорте',
      includeNone: 'none',
      includeSnippets: 'snippets',
      includeFull: 'full'
    },
    tooltips: {
      popupTranslate: 'Запускает перевод для текущей вкладки.',
      popupCancel: 'Останавливает текущую задачу.',
      popupErase: 'Удаляет задачу и данные перевода для вкладки.',
      popupDebug: 'Открывает расширенную страницу отладки.',
      modeOriginal: 'Показывать оригинальный текст страницы.',
      modeTranslated: 'Показывать переведенный текст.',
      modeCompare: 'Показывать отличия оригинала и перевода.',
      profile: 'Профиль влияет на баланс скорости и качества.',
      reasoning: 'Глубина рассуждения модели для планирования и перевода.',
      cacheRetention: 'Срок хранения prompt-cache в API.',
      tools: 'Режим инструмента: on/off/auto.',
      models: 'Список моделей, разрешенных для агента.',
      routingMode: 'Стратегия выбора модели из allowlist.',
      rateLimits: 'Последние ограничения API по RPM/TPM.',
      debugKick: 'Запускает scheduler tick принудительно.',
      diagnostics: 'Создает и копирует redacted-диагностику.',
      exportJson: 'Скачать redacted JSON-отчет.',
      exportHtml: 'Скачать HTML-отчет для передачи коллегам.'
    }
  };

  function getByPath(path, fallback = '') {
    const safePath = typeof path === 'string' ? path.trim() : '';
    if (!safePath) {
      return fallback;
    }
    const keys = safePath.split('.');
    let cursor = dict;
    for (let i = 0; i < keys.length; i += 1) {
      const key = keys[i];
      if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, key)) {
        return fallback;
      }
      cursor = cursor[key];
    }
    return typeof cursor === 'string' ? cursor : fallback;
  }

  function stageLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    return getByPath(`stage.${key}`, getByPath('stage.unknown', key || getByPath('common.noData', 'Нет данных')));
  }

  function statusLabel(value) {
    const key = String(value || '').trim().toLowerCase();
    return getByPath(`status.${key}`, stageLabel(key));
  }

  NT.UiI18nRu = {
    locale: 'ru',
    dict,
    t: getByPath,
    stageLabel,
    statusLabel
  };
})(globalThis);
