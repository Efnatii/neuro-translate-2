(function initPopupViewModel(global) {
  const NT = global.NT || (global.NT = {});

  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function mergeDeep(target, patch) {
    if (!patch || typeof patch !== 'object') {
      return target;
    }
    const dst = target && typeof target === 'object' ? target : {};
    Object.keys(patch).forEach((key) => {
      const value = patch[key];
      if (value === undefined) {
        return;
      }
      if (Array.isArray(value)) {
        dst[key] = value.slice();
        return;
      }
      if (value && typeof value === 'object') {
        const base = dst[key] && typeof dst[key] === 'object' && !Array.isArray(dst[key])
          ? dst[key]
          : {};
        dst[key] = mergeDeep(base, value);
        return;
      }
      dst[key] = value;
    });
    return dst;
  }

  function resolveStage(job) {
    const status = job && typeof job.status === 'string' ? job.status.trim().toLowerCase() : '';
    if (status === 'awaiting_categories' || status === 'done' || status === 'failed' || status === 'cancelled') {
      return status;
    }
    const runtimeStage = job && job.runtime && typeof job.runtime.stage === 'string'
      ? job.runtime.stage.trim().toLowerCase()
      : '';
    if (runtimeStage) {
      if (runtimeStage === 'translating') {
        return 'running';
      }
      if (runtimeStage === 'scanning') {
        return 'preparing';
      }
      return runtimeStage;
    }
    return status || 'idle';
  }

  function resolveProgress(job, fallbackProgress = 0) {
    const total = Number.isFinite(Number(job && job.totalBlocks))
      ? Math.max(0, Number(job.totalBlocks))
      : 0;
    const done = Number.isFinite(Number(job && job.completedBlocks))
      ? Math.max(0, Number(job.completedBlocks))
      : 0;
    const failed = Number.isFinite(Number(job && job.failedBlocksCount))
      ? Math.max(0, Number(job.failedBlocksCount))
      : (Array.isArray(job && job.failedBlockIds) ? job.failedBlockIds.length : 0);
    const pending = Math.max(0, total - done - failed);
    const percentByCounts = total > 0
      ? Math.max(0, Math.min(100, Math.round((done / total) * 100)))
      : (String(job && job.status || '').toLowerCase() === 'done' ? 100 : 0);
    const fallback = Number.isFinite(Number(fallbackProgress))
      ? Math.max(0, Math.min(100, Math.round(Number(fallbackProgress))))
      : 0;
    return {
      total,
      done,
      failed,
      pending,
      percent: total > 0 ? percentByCounts : fallback
    };
  }

  function extractLastAgentStatus(agentState) {
    const safe = agentState && typeof agentState === 'object' ? agentState : {};
    const reports = Array.isArray(safe.reports) ? safe.reports : [];
    const toolTrace = Array.isArray(safe.toolExecutionTrace) ? safe.toolExecutionTrace : [];

    const lastReport = reports.length ? reports[reports.length - 1] : null;
    const lastTool = toolTrace.length ? toolTrace[toolTrace.length - 1] : null;

    const reportText = lastReport
      ? String(lastReport.body || lastReport.title || '').trim()
      : '';
    const toolText = lastTool
      ? String(lastTool.message || lastTool.toolName || lastTool.tool || '').trim()
      : '';

    const digest = reportText || toolText || '';
    const line1 = reportText || (lastTool ? `Инструмент: ${String(lastTool.toolName || lastTool.tool || '—')}` : '');
    const line2 = toolText
      ? (lastTool && lastTool.status ? `Статус: ${String(lastTool.status)}. ${toolText}` : toolText)
      : '';

    return {
      digest,
      line1,
      line2,
      lastToolName: lastTool ? String(lastTool.toolName || lastTool.tool || '') : ''
    };
  }

  function normalizeCategoryId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function buildCategoryList(job, agentState) {
    const safeJob = job && typeof job === 'object' ? job : {};
    const safeAgent = agentState && typeof agentState === 'object' ? agentState : {};

    const countsByCategory = safeJob.classification
      && safeJob.classification.summary
      && safeJob.classification.summary.countsByCategory
      && typeof safeJob.classification.summary.countsByCategory === 'object'
      ? safeJob.classification.summary.countsByCategory
      : {};

    const recommendations = safeJob.categoryRecommendations && typeof safeJob.categoryRecommendations === 'object'
      ? safeJob.categoryRecommendations
      : (safeAgent.categoryRecommendations && typeof safeAgent.categoryRecommendations === 'object'
        ? safeAgent.categoryRecommendations
        : {});

    const selected = new Set(
      (Array.isArray(safeJob.selectedCategories) ? safeJob.selectedCategories : [])
        .map(normalizeCategoryId)
        .filter(Boolean)
    );

    const recommended = new Set(
      (Array.isArray(recommendations.recommended) ? recommendations.recommended : [])
        .map(normalizeCategoryId)
        .filter(Boolean)
    );
    const optional = new Set(
      (Array.isArray(recommendations.optional) ? recommendations.optional : [])
        .map(normalizeCategoryId)
        .filter(Boolean)
    );
    const excluded = new Set(
      (Array.isArray(recommendations.excluded) ? recommendations.excluded : [])
        .map(normalizeCategoryId)
        .filter(Boolean)
    );

    const question = safeJob.categoryQuestion && typeof safeJob.categoryQuestion === 'object'
      ? safeJob.categoryQuestion
      : (safeAgent.userQuestion && typeof safeAgent.userQuestion === 'object'
        ? safeAgent.userQuestion
        : null);

    const optionsFromQuestion = question && Array.isArray(question.options)
      ? question.options
      : [];

    const map = {};
    const put = (id, info = {}) => {
      const key = normalizeCategoryId(id);
      if (!key) {
        return;
      }
      const prev = map[key] || { id: key };
      map[key] = {
        ...prev,
        ...info,
        id: key
      };
    };

    optionsFromQuestion.forEach((row) => {
      const src = row && typeof row === 'object' ? row : {};
      put(src.id, {
        titleRu: typeof src.titleRu === 'string' && src.titleRu.trim() ? src.titleRu.trim() : normalizeCategoryId(src.id),
        descriptionRu: typeof src.descriptionRu === 'string' ? src.descriptionRu.trim() : '',
        countUnits: Number.isFinite(Number(src.countUnits)) ? Number(src.countUnits) : null
      });
    });

    const available = Array.isArray(safeJob.availableCategories) ? safeJob.availableCategories : [];
    available.forEach((idRaw) => {
      put(idRaw, {
        titleRu: map[normalizeCategoryId(idRaw)] && map[normalizeCategoryId(idRaw)].titleRu
          ? map[normalizeCategoryId(idRaw)].titleRu
          : normalizeCategoryId(idRaw)
      });
    });

    Object.keys(countsByCategory).forEach((idRaw) => {
      const key = normalizeCategoryId(idRaw);
      const count = Number.isFinite(Number(countsByCategory[idRaw])) ? Number(countsByCategory[idRaw]) : null;
      put(key, {
        countUnits: count
      });
    });

    const ids = Object.keys(map).sort((a, b) => a.localeCompare(b));
    const items = ids.map((id) => {
      const row = map[id];
      const mode = excluded.has(id)
        ? 'excluded'
        : (recommended.has(id) ? 'recommended' : (optional.has(id) ? 'optional' : 'optional'));
      const selectedByJob = selected.has(id);
      const defaultSelected = selected.size > 0
        ? selectedByJob
        : (mode === 'recommended');

      return {
        id,
        titleRu: row.titleRu || id,
        descriptionRu: row.descriptionRu || '',
        countUnits: Number.isFinite(Number(row.countUnits)) ? Number(row.countUnits) : 0,
        mode,
        disabled: mode === 'excluded',
        selected: mode === 'excluded' ? false : defaultSelected
      };
    });

    return {
      userQuestion: question && typeof question.questionRu === 'string' ? question.questionRu : '',
      items
    };
  }

  function isAwaitingCategories(job) {
    const stage = resolveStage(job);
    return stage === 'awaiting_categories';
  }

  function computeViewModel(snapshot, uiStatus = {}) {
    const src = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const job = src.translationJob && typeof src.translationJob === 'object' ? src.translationJob : null;
    const settings = src.settings && typeof src.settings === 'object' ? src.settings : {};
    const progress = resolveProgress(job || {}, src.translationProgress);
    const stage = resolveStage(job || {});
    const agentState = src.agentState && typeof src.agentState === 'object' ? src.agentState : null;
    const agentStatus = extractLastAgentStatus(agentState);

    const connectionState = typeof uiStatus.state === 'string' ? uiStatus.state : 'connecting';
    const connectionMessage = typeof uiStatus.message === 'string' ? uiStatus.message : '';

    const categories = buildCategoryList(job || {}, agentState || {});

    const leaseUntilTs = job && job.runtime && Number.isFinite(Number(job.runtime.leaseUntilTs))
      ? Number(job.runtime.leaseUntilTs)
      : null;

    return {
      tabId: Number.isFinite(Number(src.tabId)) ? Number(src.tabId) : null,
      stage,
      status: job && typeof job.status === 'string' ? job.status.toLowerCase() : 'idle',
      progress,
      job,
      settings,
      agentStatus,
      connectionState,
      connectionMessage,
      lastError: src.lastError && typeof src.lastError === 'object' ? src.lastError : null,
      awaitingCategories: isAwaitingCategories(job || {}),
      categories,
      leaseUntilTs,
      modelLimitsBySpec: src.modelLimitsBySpec && typeof src.modelLimitsBySpec === 'object'
        ? src.modelLimitsBySpec
        : {},
      toolset: src.toolset && typeof src.toolset === 'object' ? src.toolset : null
    };
  }

  function applyPatch(snapshot, patchPayload) {
    const target = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const payload = patchPayload && typeof patchPayload === 'object' ? patchPayload : {};

    if (payload.patch && typeof payload.patch === 'object') {
      mergeDeep(target, payload.patch);
    }

    Object.keys(payload).forEach((key) => {
      if (key === 'patch' || key === 'changedKeys' || key === 'eventLogAppend' || key === 'eventLogReset') {
        return;
      }
      const value = payload[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const base = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
          ? target[key]
          : {};
        target[key] = mergeDeep(base, value);
      } else if (Array.isArray(value)) {
        target[key] = value.slice();
      } else {
        target[key] = value;
      }
    });

    if (payload.eventLogReset === true) {
      target.eventLog = { seq: 0, items: [] };
    }
    if (payload.eventLogAppend && typeof payload.eventLogAppend === 'object') {
      const current = target.eventLog && typeof target.eventLog === 'object'
        ? target.eventLog
        : { seq: 0, items: [] };
      const items = Array.isArray(current.items) ? current.items.slice() : [];
      const item = payload.eventLogAppend.item;
      if (item && typeof item === 'object') {
        items.push(item);
      }
      target.eventLog = {
        seq: Number.isFinite(Number(payload.eventLogAppend.seq)) ? Number(payload.eventLogAppend.seq) : current.seq,
        items
      };
    }
    return target;
  }

  NT.PopupViewModel = {
    cloneJson,
    mergeDeep,
    applyPatch,
    computeViewModel,
    isAwaitingCategories
  };
})(globalThis);
