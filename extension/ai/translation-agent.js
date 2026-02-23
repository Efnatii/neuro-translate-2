/**
 * Agent-oriented translation planner/executor helpers.
 *
 * The agent keeps deterministic state in job payloads:
 * - planning/checklist/tool history
 * - category strategy and batch routing
 * - periodic audits and context compression
 *
 * It can optionally ask the LLM for a higher-level plan, but always has a
 * deterministic fallback so pipeline behavior remains stable.
 */
(function initTranslationAgent(global) {
  const NT = global.NT || (global.NT = {});

  const KNOWN_CATEGORIES = Object.freeze([
    'heading',
    'paragraph',
    'list',
    'button',
    'label',
    'navigation',
    'meta',
    'code',
    'quote',
    'table',
    'other'
  ]);

  const TOOL_KEYS = Object.freeze({
    PAGE_ANALYZER: 'pageAnalyzer',
    CATEGORY_SELECTOR: 'categorySelector',
    GLOSSARY_BUILDER: 'glossaryBuilder',
    BATCH_PLANNER: 'batchPlanner',
    MODEL_ROUTER: 'modelRouter',
    PROGRESS_AUDITOR: 'progressAuditor',
    ANTI_REPEAT_GUARD: 'antiRepeatGuard',
    CONTEXT_COMPRESSOR: 'contextCompressor',
    REPORT_WRITER: 'reportWriter',
    PAGE_RUNTIME: 'pageRuntime',
    CACHE_MANAGER: 'cacheManager',
    WORKFLOW_CONTROLLER: 'workflowController'
  });

  const DEFAULT_TOOL_CONFIG = Object.freeze({
    [TOOL_KEYS.PAGE_ANALYZER]: 'on',
    [TOOL_KEYS.CATEGORY_SELECTOR]: 'auto',
    [TOOL_KEYS.GLOSSARY_BUILDER]: 'auto',
    [TOOL_KEYS.BATCH_PLANNER]: 'auto',
    [TOOL_KEYS.MODEL_ROUTER]: 'auto',
    [TOOL_KEYS.PROGRESS_AUDITOR]: 'on',
    [TOOL_KEYS.ANTI_REPEAT_GUARD]: 'on',
    [TOOL_KEYS.CONTEXT_COMPRESSOR]: 'auto',
    [TOOL_KEYS.REPORT_WRITER]: 'on',
    [TOOL_KEYS.PAGE_RUNTIME]: 'on',
    [TOOL_KEYS.CACHE_MANAGER]: 'auto',
    [TOOL_KEYS.WORKFLOW_CONTROLLER]: 'on'
  });

  const PROFILE_PRESETS = Object.freeze({
    auto: {
      style: 'auto',
      maxBatchSize: 'auto',
      proofreadingPasses: 'auto',
      parallelism: 'auto'
    },
    balanced: {
      style: 'balanced',
      maxBatchSize: 8,
      proofreadingPasses: 1,
      parallelism: 'mixed'
    },
    literal: {
      style: 'literal',
      maxBatchSize: 6,
      proofreadingPasses: 1,
      parallelism: 'low'
    },
    readable: {
      style: 'readable',
      maxBatchSize: 10,
      proofreadingPasses: 2,
      parallelism: 'high'
    },
    technical: {
      style: 'technical',
      maxBatchSize: 5,
      proofreadingPasses: 2,
      parallelism: 'low'
    }
  });

  const DEFAULT_AGENT_TUNING = Object.freeze({
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
  });

  const CATEGORY_GROUPS = Object.freeze({
    all: KNOWN_CATEGORIES,
    content: ['heading', 'paragraph', 'list', 'quote', 'table', 'code'],
    interface: ['button', 'label', 'navigation'],
    meta: ['meta']
  });

  class TranslationAgent {
    constructor({ runLlmRequest, eventFactory, eventLogFn } = {}) {
      this.runLlmRequest = typeof runLlmRequest === 'function' ? runLlmRequest : null;
      this.eventFactory = eventFactory || null;
      this.eventLogFn = typeof eventLogFn === 'function' ? eventLogFn : null;

      this.MAX_TOOL_LOG = 140;
      this.MAX_TOOL_TRACE = 320;
      this.MAX_REPORTS = 100;
      this.MAX_AUDITS = 60;
      this.MAX_DIFF_ITEMS = 30;
      this.COMPRESS_THRESHOLD = 80;
      this.AUDIT_INTERVAL_MS = 2500;
      this.MANDATORY_AUDIT_INTERVAL_MS = 1000;
      this.COMPRESS_COOLDOWN_MS = 1200;
      this.CONTEXT_FOOTPRINT_LIMIT = 9000;
    }

    static previewResolvedSettings({ settings, pageStats, blocks } = {}) {
      const runtimeFallback = {
        auditIntervalMs: DEFAULT_AGENT_TUNING.auditIntervalMs,
        mandatoryAuditIntervalMs: DEFAULT_AGENT_TUNING.mandatoryAuditIntervalMs,
        compressionThreshold: DEFAULT_AGENT_TUNING.compressionThreshold,
        contextFootprintLimit: DEFAULT_AGENT_TUNING.contextFootprintLimit,
        compressionCooldownMs: DEFAULT_AGENT_TUNING.compressionCooldownMs
      };
      const modelPolicyFallback = {
        mode: 'auto',
        speed: true,
        preference: null,
        allowRouteOverride: true
      };
      const toolStatsFallback = {
        blockCount: 0,
        totalChars: 0,
        avgChars: 0,
        codeRatio: 0,
        headingRatio: 0
      };

      const normalizeFiniteNumber = (value, fallback, min = null) => {
        if (!Number.isFinite(Number(value))) {
          return fallback;
        }
        const numeric = Number(value);
        if (Number.isFinite(Number(min))) {
          return Math.max(Number(min), numeric);
        }
        return numeric;
      };
      const normalizePageStats = (stats) => {
        if (!stats || typeof stats !== 'object') {
          return null;
        }
        const blockCount = normalizeFiniteNumber(stats.blockCount, 0, 0);
        const totalChars = normalizeFiniteNumber(stats.totalChars, 0, 0);
        const safeBlockCount = Math.max(1, blockCount);
        return {
          blockCount,
          totalChars,
          avgChars: normalizeFiniteNumber(stats.avgChars, totalChars / safeBlockCount, 0),
          codeRatio: normalizeFiniteNumber(stats.codeRatio, 0, 0),
          headingRatio: normalizeFiniteNumber(stats.headingRatio, 0, 0)
        };
      };
      const cloneCategoryStats = (stats) => {
        if (!stats || typeof stats !== 'object') {
          return null;
        }
        const out = {};
        Object.keys(stats).forEach((key) => {
          const entry = stats[key] && typeof stats[key] === 'object' ? stats[key] : {};
          out[key] = {
            count: normalizeFiniteNumber(entry.count, 0, 0),
            chars: normalizeFiniteNumber(entry.chars, 0, 0)
          };
        });
        return out;
      };
      const cloneReuseStats = (stats) => {
        if (!stats || typeof stats !== 'object') {
          return null;
        }
        return {
          duplicatedBlocks: normalizeFiniteNumber(stats.duplicatedBlocks, 0, 0),
          duplicateRatio: normalizeFiniteNumber(stats.duplicateRatio, 0, 0)
        };
      };
      const buildFallbackToolResolution = () => {
        const toolConfigEffective = {};
        const toolAutoDecisions = [];
        Object.keys(DEFAULT_TOOL_CONFIG).forEach((tool) => {
          const requestedMode = DEFAULT_TOOL_CONFIG[tool];
          const effectiveMode = requestedMode === 'on' || requestedMode === 'off' ? requestedMode : 'on';
          toolConfigEffective[tool] = effectiveMode;
          toolAutoDecisions.push({
            tool,
            source: requestedMode === 'auto' ? 'auto' : 'explicit',
            requestedMode,
            effectiveMode,
            reason: requestedMode === 'auto'
              ? 'Автополитика (резервный режим)'
              : (requestedMode === 'on' ? 'Настроено пользователем/профилем: ВКЛ' : 'Настроено пользователем/профилем: ВЫКЛ')
          });
        });
        return {
          toolConfigEffective,
          toolAutoDecisions
        };
      };
      const fallbackToolResolution = buildFallbackToolResolution();
      const fallbackResult = {
        profile: 'auto',
        baseProfile: { ...PROFILE_PRESETS.auto },
        effectiveProfile: { ...PROFILE_PRESETS.auto },
        tuning: { ...DEFAULT_AGENT_TUNING },
        runtimeTuning: { ...runtimeFallback },
        resolved: {
          profile: 'auto',
          tuning: { ...DEFAULT_AGENT_TUNING },
          modelPolicy: { ...modelPolicyFallback },
          toolConfigRequested: { ...DEFAULT_TOOL_CONFIG },
          toolConfigEffective: { ...fallbackToolResolution.toolConfigEffective },
          toolAutoDecisions: fallbackToolResolution.toolAutoDecisions.slice(),
          categoryMode: 'auto',
          categoryList: [],
          pageCacheEnabled: true
        },
        pageStats: null,
        categoryStats: null,
        reuseStats: null
      };

      try {
        const probe = new TranslationAgent({ runLlmRequest: null });
        const safeSettings = settings && typeof settings === 'object' ? settings : {};
        const inputBlocks = Array.isArray(blocks)
          ? blocks.filter((item) => item && typeof item === 'object')
          : null;

        let computedCategoryStats = null;
        let computedPageStats = null;
        let computedReuseStats = null;
        if (inputBlocks) {
          computedCategoryStats = probe._collectCategoryStats(inputBlocks);
          computedPageStats = probe._collectPageStats(inputBlocks, computedCategoryStats);
          computedReuseStats = probe._collectReuseStats(inputBlocks);
        } else {
          computedPageStats = normalizePageStats(pageStats);
        }

        const resolved = probe.resolveSettings(safeSettings, computedPageStats || null);
        const baseProfileRaw = probe._resolveProfilePreset(resolved.profile, computedPageStats || null);
        const baseProfile = baseProfileRaw && typeof baseProfileRaw === 'object'
          ? { ...baseProfileRaw }
          : { ...PROFILE_PRESETS.auto };
        const effectiveProfile = resolved.resolvedProfile && typeof resolved.resolvedProfile === 'object'
          ? { ...resolved.resolvedProfile }
          : { ...baseProfile };
        const tuning = resolved.tuning && typeof resolved.tuning === 'object'
          ? { ...resolved.tuning }
          : { ...DEFAULT_AGENT_TUNING };
        const runtimeTuning = probe._resolveRuntimeTuning(tuning);

        const effectiveToolResolution = probe._resolveEffectiveToolConfig({
          requestedToolConfig: resolved.toolConfig,
          resolvedProfile: resolved.resolvedProfile,
          pageStats: computedPageStats || toolStatsFallback,
          categoryStats: computedCategoryStats || {},
          reuseStats: computedReuseStats || {},
          blockCount: inputBlocks ? inputBlocks.length : 0
        });
        const toolConfigEffective = effectiveToolResolution && effectiveToolResolution.toolConfig && typeof effectiveToolResolution.toolConfig === 'object'
          ? { ...effectiveToolResolution.toolConfig }
          : {};
        const toolAutoDecisions = Array.isArray(effectiveToolResolution && effectiveToolResolution.decisions)
          ? effectiveToolResolution.decisions.slice()
          : [];
        const modelPolicy = resolved.modelPolicy && typeof resolved.modelPolicy === 'object'
          ? { ...resolved.modelPolicy }
          : { ...modelPolicyFallback };
        const toolConfigRequested = resolved.toolConfig && typeof resolved.toolConfig === 'object'
          ? { ...resolved.toolConfig }
          : { ...DEFAULT_TOOL_CONFIG };
        const normalizedRuntime = runtimeTuning && typeof runtimeTuning === 'object'
          ? { ...runtimeTuning }
          : { ...runtimeFallback };

        return {
          profile: resolved.profile || 'auto',
          baseProfile,
          effectiveProfile,
          tuning,
          runtimeTuning: normalizedRuntime,
          resolved: {
            profile: resolved.profile || 'auto',
            tuning: { ...tuning },
            modelPolicy,
            toolConfigRequested,
            toolConfigEffective,
            toolAutoDecisions,
            categoryMode: resolved.categoryMode || 'auto',
            categoryList: Array.isArray(resolved.categoryList) ? resolved.categoryList.slice() : [],
            pageCacheEnabled: resolved.pageCacheEnabled !== false
          },
          pageStats: computedPageStats ? { ...computedPageStats } : null,
          categoryStats: cloneCategoryStats(computedCategoryStats),
          reuseStats: cloneReuseStats(computedReuseStats)
        };
      } catch (_) {
        return fallbackResult;
      }
    }

    resolveSettings(settings, pageStats) {
      const safeSettings = settings && typeof settings === 'object' ? settings : {};
      const profile = Object.prototype.hasOwnProperty.call(PROFILE_PRESETS, safeSettings.translationAgentProfile)
        ? safeSettings.translationAgentProfile
        : 'auto';
      const rawToolConfig = safeSettings.translationAgentTools && typeof safeSettings.translationAgentTools === 'object'
        ? safeSettings.translationAgentTools
        : {};
      const toolConfig = {};
      Object.keys(DEFAULT_TOOL_CONFIG).forEach((key) => {
        const value = rawToolConfig[key];
        toolConfig[key] = value === 'on' || value === 'off' || value === 'auto'
          ? value
          : DEFAULT_TOOL_CONFIG[key];
      });

      const categoryMode = this._normalizeCategoryMode(safeSettings.translationCategoryMode);
      const categoryList = Array.isArray(safeSettings.translationCategoryList)
        ? safeSettings.translationCategoryList
          .map((value) => this._normalizeCategory(value))
          .filter(Boolean)
        : [];
      const tuning = this._normalizeAgentTuning(safeSettings.translationAgentTuning);
      const modelPolicy = this._normalizeModelPolicy(
        safeSettings.translationAgentModelPolicy,
        safeSettings.modelSelection || null
      );
      const baseResolvedProfile = this._resolveProfilePreset(profile, pageStats);
      const resolvedProfile = this._applyProfileTuning(baseResolvedProfile, tuning);

      return {
        profile,
        resolvedProfile,
        tuning,
        modelPolicy,
        toolConfig,
        categoryMode,
        categoryList,
        pageCacheEnabled: safeSettings.translationPageCacheEnabled !== false
      };
    }

    async prepareJob({ job, blocks, settings } = {}) {
      const safeJob = job && typeof job === 'object' ? job : {};
      const inputBlocks = Array.isArray(blocks) ? blocks.filter((item) => item && item.blockId) : [];
      const categoryStats = this._collectCategoryStats(inputBlocks);
      const pageStats = this._collectPageStats(inputBlocks, categoryStats);
      const reuseStats = this._collectReuseStats(inputBlocks);
      const resolved = this.resolveSettings(settings, pageStats);
      const runtimeTuning = this._resolveRuntimeTuning(resolved.tuning);
      const resolvedTools = this._resolveEffectiveToolConfig({
        requestedToolConfig: resolved.toolConfig,
        resolvedProfile: resolved.resolvedProfile,
        pageStats,
        categoryStats,
        reuseStats,
        blockCount: inputBlocks.length
      });
      const effectiveToolConfig = resolvedTools.toolConfig;
      let effectiveResolvedProfile = resolved.resolvedProfile;
      if (resolved.profile === 'auto' && !this._isToolEnabled(effectiveToolConfig[TOOL_KEYS.PAGE_ANALYZER])) {
        effectiveResolvedProfile = { ...PROFILE_PRESETS.balanced };
      }

      const toolHistory = [];
      const reports = [];
      const checklist = this._buildInitialChecklist();
      const planningToolState = {
        toolConfig: effectiveToolConfig,
        toolHistory,
        toolExecutionTrace: []
      };
      this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        message: 'update_checklist_analyze_page',
        action: () => this._updateChecklist(checklist, 'analyze_page', 'done', `блоков=${inputBlocks.length}`)
      });

      this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.PAGE_ANALYZER,
        onDisabledMessage: 'Анализатор страницы отключён; использую только базовые эвристики профиля',
        message: 'page_stats_collected',
        action: () => {
          this._pushToolLog(
            toolHistory,
            TOOL_KEYS.PAGE_ANALYZER,
            effectiveToolConfig[TOOL_KEYS.PAGE_ANALYZER],
            'ok',
            `Статистика страницы: блоки=${pageStats.blockCount}, символы=${pageStats.totalChars}, codeRatio=${(pageStats.codeRatio || 0).toFixed(2)}`
          );
        }
      });
      (resolvedTools.decisions || []).forEach((decision) => {
        if (!decision || decision.source !== 'auto') {
          return;
        }
        this._pushToolLog(
          toolHistory,
          decision.tool,
          decision.requestedMode,
          decision.effectiveMode === 'on' ? 'ok' : 'skip',
          `Автоконфиг -> ${decision.effectiveMode}. ${decision.reason}`
        );
      });

      const selectedCategories = this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.CATEGORY_SELECTOR,
        onDisabledMessage: `Селектор категорий отключён; использую все категории: ${(KNOWN_CATEGORIES || []).join(', ')}`,
        disabledValue: this._selectCategories({
          mode: 'all',
          custom: [],
          blocks: inputBlocks,
          categoryStats
        }),
        message: 'select_categories',
        action: () => this._selectCategories({
          mode: resolved.categoryMode,
          custom: resolved.categoryList,
          blocks: inputBlocks,
          categoryStats
        })
      });
      const categorySelectorEnabled = this._isToolEnabled(effectiveToolConfig[TOOL_KEYS.CATEGORY_SELECTOR]);
      this._pushToolLog(
        toolHistory,
        TOOL_KEYS.CATEGORY_SELECTOR,
        effectiveToolConfig[TOOL_KEYS.CATEGORY_SELECTOR],
        categorySelectorEnabled ? 'ok' : 'skip',
        categorySelectorEnabled
          ? `Выбраны категории: ${selectedCategories.join(', ')}`
          : `Селектор категорий отключён; использую все категории: ${selectedCategories.join(', ')}`
      );
      this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        message: 'update_checklist_select_categories',
        action: () => this._updateChecklist(checklist, 'select_categories', 'done', `выбрано=${selectedCategories.join(',')}`)
      });

      const filteredBlocks = inputBlocks.filter((item) => selectedCategories.includes(this._normalizeCategory(item.category) || 'other'));
      const effectiveBlocks = filteredBlocks.length ? filteredBlocks : inputBlocks.slice();
      if (!filteredBlocks.length) {
        this._pushToolLog(toolHistory, TOOL_KEYS.CATEGORY_SELECTOR, effectiveToolConfig[TOOL_KEYS.CATEGORY_SELECTOR], 'warn', 'Выбранные категории дали пустой набор; откат на все блоки');
      }

      const glossary = this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.GLOSSARY_BUILDER,
        onDisabledMessage: 'Инструмент глоссария отключён',
        disabledValue: [],
        message: 'build_glossary',
        action: () => this._buildGlossary(effectiveBlocks)
      });
      if (this._isToolEnabled(effectiveToolConfig[TOOL_KEYS.GLOSSARY_BUILDER])) {
        this._pushToolLog(toolHistory, TOOL_KEYS.GLOSSARY_BUILDER, effectiveToolConfig[TOOL_KEYS.GLOSSARY_BUILDER], 'ok', `Терминов глоссария: ${glossary.length}`);
      } else {
        this._pushToolLog(toolHistory, TOOL_KEYS.GLOSSARY_BUILDER, effectiveToolConfig[TOOL_KEYS.GLOSSARY_BUILDER], 'skip', 'Инструмент глоссария отключён');
      }
      this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        message: 'update_checklist_build_glossary',
        action: () => this._updateChecklist(checklist, 'build_glossary', 'done', `терминов=${glossary.length}`)
      });

      let plan = this._buildFallbackPlan({
        blocks: effectiveBlocks,
        profile: resolved.profile,
        resolvedProfile: effectiveResolvedProfile,
        selectedCategories,
        categoryStats,
        glossary
      });
      if (this._isToolEnabled(effectiveToolConfig[TOOL_KEYS.BATCH_PLANNER])) {
        const planned = await this._executeToolAsync({
          agentState: planningToolState,
          tool: TOOL_KEYS.BATCH_PLANNER,
          message: 'planner_request',
          action: () => this._askPlanner({
            job: safeJob,
            blocks: effectiveBlocks,
            selectedCategories,
            glossary,
            resolved: {
              ...resolved,
              resolvedProfile: effectiveResolvedProfile
            }
          }),
          fallbackValue: null
        });
        if (planned) {
          plan = this._mergePlan(plan, planned);
          this._pushToolLog(toolHistory, TOOL_KEYS.BATCH_PLANNER, effectiveToolConfig[TOOL_KEYS.BATCH_PLANNER], 'ok', 'Планирование: ответ модели принят');
        } else {
          this._pushToolLog(toolHistory, TOOL_KEYS.BATCH_PLANNER, effectiveToolConfig[TOOL_KEYS.BATCH_PLANNER], 'warn', 'Планирование: модель недоступна; использован базовый план');
        }
      } else {
        this._pushToolLog(toolHistory, TOOL_KEYS.BATCH_PLANNER, effectiveToolConfig[TOOL_KEYS.BATCH_PLANNER], 'skip', 'Планировщик отключён');
      }
      this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        message: 'update_checklist_plan_pipeline',
        action: () => this._updateChecklist(checklist, 'plan_pipeline', 'done', `размер_батча=${plan.batchSize}`)
      });

      this._executeToolSync({
        agentState: planningToolState,
        tool: TOOL_KEYS.MODEL_ROUTER,
        force: true,
        message: 'model_policy_context',
        action: () => this._pushToolLog(
          toolHistory,
          TOOL_KEYS.MODEL_ROUTER,
          effectiveToolConfig[TOOL_KEYS.MODEL_ROUTER],
          'ok',
          `Политика модели: mode=${resolved.modelPolicy.mode}, speed=${resolved.modelPolicy.speed ? 'on' : 'off'}, preference=${resolved.modelPolicy.preference || 'none'}, routeOverride=${resolved.modelPolicy.allowRouteOverride ? 'on' : 'off'}`
        )
      });

      const systemPrompt = this._buildSystemPrompt({
        profile: resolved.profile,
        style: plan.style,
        targetLang: safeJob.targetLang || 'ru',
        toolConfig: effectiveToolConfig
      });

      const createdAt = Date.now();
      const agentState = {
        status: 'ready',
        phase: 'planned',
        profile: resolved.profile,
        resolvedProfile: effectiveResolvedProfile,
        tuning: resolved.tuning,
        runtimeTuning,
        modelPolicy: resolved.modelPolicy,
        toolConfig: effectiveToolConfig,
        toolConfigRequested: resolved.toolConfig,
        toolAutoDecisions: resolvedTools.decisions || [],
        selectedCategories,
        categoryMode: resolved.categoryMode,
        glossary,
        plan,
        toolHistory,
        toolExecutionTrace: planningToolState.toolExecutionTrace || [],
        checklist,
        reports,
        audits: [],
        contextSummary: '',
        compressedContextCount: 0,
        lastCompressionAt: null,
        seenBatchSignatures: [],
        processedBlockIds: [],
        repeatedBatchCount: 0,
        batchCounter: 0,
        lastAuditAt: null,
        lastBatchAt: null,
        systemPrompt,
        reportFormat: this._defaultReportFormat(),
        recentDiffItems: [],
        createdAt,
        updatedAt: createdAt
      };

      this._appendReportViaTool(agentState, {
        type: 'plan',
        title: 'План перевода сформирован',
        body: plan.summary || 'План подготовлен',
        meta: {
          batchSize: plan.batchSize,
          selectedCategories,
          glossaryTerms: glossary.length
        }
      }, {
        message: 'plan_report_created'
      });
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        message: 'update_checklist_agent_ready',
        action: () => this._updateChecklist(checklist, 'agent_ready', 'done', `профиль=${resolved.profile}`)
      });
      return {
        blocks: effectiveBlocks,
        selectedCategories,
        agentState
      };
    }

    shouldUseCache(resolvedSettings) {
      return Boolean(resolvedSettings && resolvedSettings.pageCacheEnabled !== false);
    }

    buildNextBatch(job) {
      const agentState = job && job.agentState ? job.agentState : null;
      const pending = Array.isArray(job && job.pendingBlockIds) ? job.pendingBlockIds.slice() : [];
      if (!agentState || !pending.length) {
        return null;
      }

      const plan = agentState.plan && typeof agentState.plan === 'object' ? agentState.plan : {};
      const batchSize = this._clampBatchSize(plan.batchSize);
      const order = this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.ANTI_REPEAT_GUARD,
        force: true,
        message: 'order_pending_blocks',
        action: () => this._computeOrderedPending(job, agentState, pending),
        disabledValue: pending.slice()
      });
      if (!order.length) {
        return null;
      }

      const guardMode = agentState.toolConfig ? agentState.toolConfig[TOOL_KEYS.ANTI_REPEAT_GUARD] : 'on';
      const configuredGuardEnabled = this._isToolEnabled(guardMode);
      // Baseline duplicate protection is mandatory even when explicit tool mode is off.
      const guardEnabled = true;
      const seen = Array.isArray(agentState.seenBatchSignatures) ? agentState.seenBatchSignatures : [];
      const processedSet = new Set(Array.isArray(agentState.processedBlockIds) ? agentState.processedBlockIds : []);
      let selected = null;

      for (let offset = 0; offset < order.length; offset += batchSize) {
        const candidateIdsRaw = order.slice(offset, offset + batchSize);
        const candidateIds = guardEnabled
          ? candidateIdsRaw.filter((id) => !processedSet.has(id))
          : candidateIdsRaw;
        if (!candidateIds.length) {
          continue;
        }
        const signature = this._batchSignature(candidateIds);
        if (guardEnabled && seen.includes(signature)) {
          continue;
        }
        selected = { blockIds: candidateIds, signature };
        break;
      }

      if (!selected) {
        const fallbackIdsRaw = order.slice(0, batchSize);
        const fallbackIds = fallbackIdsRaw.filter((id) => !processedSet.has(id));
        const fallbackResolved = fallbackIds.length ? fallbackIds : fallbackIdsRaw;
        if (!fallbackResolved.length) {
          return null;
        }
        if (!configuredGuardEnabled) {
          this._pushToolLog(
            agentState.toolHistory,
            TOOL_KEYS.ANTI_REPEAT_GUARD,
            guardMode,
            'warn',
            'Baseline anti-repeat protection was enforced even though explicit antiRepeatGuard mode is off'
          );
        }
        agentState.repeatedBatchCount = Number(agentState.repeatedBatchCount || 0) + 1;
        this._pushToolLog(
          agentState.toolHistory,
          TOOL_KEYS.ANTI_REPEAT_GUARD,
          guardMode,
          'warn',
          'Repeated batch signature detected; fallback batch emitted'
        );
        if (!fallbackIds.length) {
          this._pushToolLog(
            agentState.toolHistory,
            TOOL_KEYS.ANTI_REPEAT_GUARD,
            guardMode,
            'warn',
            'Fallback used already-processed block IDs because no unique pending IDs remained'
          );
        }
        selected = {
          blockIds: fallbackResolved,
          signature: this._batchSignature(fallbackResolved)
        };
      }

      agentState.seenBatchSignatures = this._pushBounded(seen, selected.signature, 90);
      agentState.batchCounter = Number(agentState.batchCounter || 0) + 1;
      agentState.lastBatchAt = Date.now();
      agentState.updatedAt = Date.now();
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: 'update_checklist_execute_batches',
        action: () => this._updateChecklist(agentState.checklist, 'execute_batches', 'running', `батч#${agentState.batchCounter}`)
      });

      const blocks = selected.blockIds
        .map((id) => (job.blocksById && job.blocksById[id]) ? job.blocksById[id] : null)
        .filter(Boolean);
      if (!blocks.length) {
        return null;
      }

      return {
        batchId: `${job.id}:batch:${agentState.batchCounter}`,
        index: Math.max(0, agentState.batchCounter - 1),
        blockIds: selected.blockIds,
        blocks,
        signature: selected.signature
      };
    }

    buildBatchContext({ job, batch } = {}) {
      const agentState = job && job.agentState ? job.agentState : null;
      if (!agentState || !batch) {
        return null;
      }
      this.runContextCompressionTool({
        job,
        force: false,
        mandatory: true,
        reason: 'pre_batch_context'
      });

      const modelRouterMode = agentState.toolConfig
        ? agentState.toolConfig[TOOL_KEYS.MODEL_ROUTER]
        : 'auto';
      const modelPolicy = this._normalizeModelPolicy(agentState.modelPolicy, null);
      const routeOverrideAllowed = modelPolicy.allowRouteOverride !== false;
      const modelRouterEnabled = this._isToolEnabled(modelRouterMode) && routeOverrideAllowed;
      const routeHint = modelRouterEnabled
        ? this._executeToolSync({
          agentState,
          tool: TOOL_KEYS.MODEL_ROUTER,
          message: 'resolve_batch_route_hint',
          action: () => this._resolveBatchRouteHint({ agentState, batch }),
          disabledValue: null
        })
        : null;
      const recentReports = Array.isArray(agentState.reports) ? agentState.reports.slice(-4) : [];
      const reportDigest = recentReports.map((item) => {
        const title = item && item.title ? String(item.title) : '';
        const body = item && item.body ? String(item.body) : '';
        return `${title}: ${body}`.trim();
      }).filter(Boolean).join('\n');

      this._pushToolLog(
        agentState.toolHistory,
        TOOL_KEYS.MODEL_ROUTER,
        modelRouterMode,
        modelRouterEnabled ? 'ok' : 'skip',
        modelRouterEnabled
          ? `Выбран маршрут батча: ${routeHint || 'fast'}`
          : (routeOverrideAllowed ? 'Маршрутизатор моделей отключён' : 'Переопределение маршрута запрещено политикой модели')
      );

      return {
        systemPrompt: agentState.systemPrompt || '',
        profile: agentState.profile || 'auto',
        style: agentState.plan && agentState.plan.style ? agentState.plan.style : 'balanced',
        batchGuidance: agentState.plan && agentState.plan.instructions ? agentState.plan.instructions : '',
        glossary: Array.isArray(agentState.glossary) ? agentState.glossary.slice(0, 24) : [],
        contextSummary: agentState.contextSummary || '',
        reportDigest,
        reportFormat: agentState.reportFormat || this._defaultReportFormat(),
        selectedCategories: Array.isArray(agentState.selectedCategories) ? agentState.selectedCategories.slice() : [],
        batchCategoryCounts: this._countBatchCategories(batch.blocks || []),
        modelRouterEnabled,
        modelPolicy,
        routeHint
      };
    }

    markPhase(job, phase, message) {
      if (!job || !job.agentState) {
        return;
      }
      const agentState = job.agentState;
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: `mark_phase:${String(phase || 'unknown')}`,
        action: () => {
          agentState.phase = phase || agentState.phase;
          agentState.status = phase === 'failed' ? 'failed' : phase === 'done' ? 'done' : 'running';
          agentState.updatedAt = Date.now();
          if (message) {
            this._appendReportViaTool(agentState, {
              type: 'phase',
              title: String(phase || 'phase'),
              body: String(message),
              meta: {}
            }, {
              message: 'phase_report_written'
            });
          }
        }
      });
    }

    recordRuntimeAction(job, {
      tool,
      status = 'ok',
      message = '',
      meta = null,
      force = false
    } = {}) {
      try {
        if (!job || !job.agentState || typeof job.agentState !== 'object') {
          return null;
        }
        const agentState = job.agentState;
        const runtimeTool = typeof tool === 'string' && tool ? tool : TOOL_KEYS.PAGE_RUNTIME;
        const resolvedMode = this._resolveToolMode(agentState, runtimeTool, null);
        const enabled = Boolean(force) || this._isToolEnabled(resolvedMode);
        const safeStatus = status === 'warn' || status === 'error' || status === 'skip'
          ? status
          : 'ok';
        const safeMessage = typeof message === 'string' ? message : '';
        const safeMeta = meta && typeof meta === 'object' ? { ...meta } : null;

        if (!enabled) {
          if (safeMessage) {
            this._pushToolLog(agentState.toolHistory, runtimeTool, resolvedMode, 'skip', safeMessage);
          }
        this._recordToolExecution(agentState, {
          tool: runtimeTool,
          mode: resolvedMode,
          status: 'skip',
          forced: Boolean(force),
          message: safeMessage || 'инструмент отключён',
          meta: safeMeta
        });
          agentState.updatedAt = Date.now();
          return { tool: runtimeTool, status: 'skip', mode: resolvedMode };
        }

        this._pushToolLog(agentState.toolHistory, runtimeTool, resolvedMode, safeStatus, safeMessage);
        this._recordToolExecution(agentState, {
          tool: runtimeTool,
          mode: resolvedMode,
          status: safeStatus,
          forced: Boolean(force),
          message: safeMessage,
          meta: safeMeta
        });
        agentState.updatedAt = Date.now();
        return { tool: runtimeTool, status: safeStatus, mode: resolvedMode };
      } catch (_) {
        return null;
      }
    }

    recordBatchSuccess({ job, batch, translatedItems, report } = {}) {
      if (!job || !job.agentState || !batch) {
        return;
      }
      const agentState = job.agentState;
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: 'record_batch_success',
        action: () => {
          const translatedList = Array.isArray(translatedItems) ? translatedItems : [];
          const reportObj = this._normalizeExternalBatchReport(report, {
            batch,
            translatedItems: translatedList
          });
          const now = Date.now();

          const processed = Array.isArray(agentState.processedBlockIds) ? agentState.processedBlockIds : [];
          batch.blockIds.forEach((id) => {
            if (!processed.includes(id)) {
              processed.push(id);
            }
          });
          agentState.processedBlockIds = processed.slice(-2000);
          agentState.lastBatchAt = now;
          agentState.updatedAt = now;

          const diffItems = this._buildDiffItems(batch.blocks, translatedList);
          if (diffItems.length) {
            const merged = Array.isArray(agentState.recentDiffItems)
              ? agentState.recentDiffItems.concat(diffItems)
              : diffItems.slice();
            agentState.recentDiffItems = merged.slice(-this.MAX_DIFF_ITEMS);
          }

          const summary = reportObj.summary || `Батч ${batch.index + 1} переведён: ${batch.blockIds.length} блоков`;
          const reportMode = agentState.toolConfig ? agentState.toolConfig[TOOL_KEYS.REPORT_WRITER] : 'on';
          if (this._isToolEnabled(reportMode)) {
            const notesText = Array.isArray(reportObj.notes) && reportObj.notes.length
              ? ` | примечания: ${reportObj.notes.join('; ')}`
              : '';
            const reportMeta = reportObj && reportObj.meta && typeof reportObj.meta === 'object'
              ? reportObj.meta
              : {};
            const usageMeta = reportMeta.usage && typeof reportMeta.usage === 'object'
              ? reportMeta.usage
              : null;
            const rateMeta = reportMeta.rate && typeof reportMeta.rate === 'object'
              ? reportMeta.rate
              : null;
            this._appendReportViaTool(agentState, {
              type: 'batch',
              title: `Батч ${batch.index + 1}`,
              body: `${summary}${notesText}`.slice(0, 600),
              meta: {
                batchId: batch.batchId,
                blockCount: batch.blockIds.length,
                quality: reportObj.quality || 'ok',
                notes: Array.isArray(reportObj.notes) ? reportObj.notes.slice(0, 8) : [],
                categoryCounts: this._countBatchCategories(batch.blocks || []),
                ...(reportObj.meta || {})
              }
            }, {
              message: 'batch_report_written'
            });
            const toolMsg = [
              `Отчёт батча сохранён (${batch.blockIds.length} блоков)`,
              `модель=${reportMeta.chosenModelSpec || 'н/д'}`,
              `токены=${usageMeta && usageMeta.totalTokens !== undefined && usageMeta.totalTokens !== null ? usageMeta.totalTokens : 'н/д'}`,
              `остатокRPM=${rateMeta && rateMeta.remainingRequests !== undefined && rateMeta.remainingRequests !== null ? rateMeta.remainingRequests : 'н/д'} остатокTPM=${rateMeta && rateMeta.remainingTokens !== undefined && rateMeta.remainingTokens !== null ? rateMeta.remainingTokens : 'н/д'}${reportMeta.cached ? ' | кэш' : ''}`
            ].join(' | ').slice(0, 320);
            this._pushToolLog(agentState.toolHistory, TOOL_KEYS.REPORT_WRITER, reportMode, 'ok', toolMsg);
          } else {
            this._pushToolLog(agentState.toolHistory, TOOL_KEYS.REPORT_WRITER, reportMode, 'skip', 'Запись отчётов отключена');
          }
          this.runProgressAuditTool({ job, reason: 'batch_success' });
          this.runContextCompressionTool({ job, force: false, reason: 'batch_success' });
        }
      });
    }

    recordBatchFailure({ job, batch, error } = {}) {
      if (!job || !job.agentState) {
        return;
      }
      const agentState = job.agentState;
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: 'record_batch_failure',
        action: () => {
          const safeError = error && typeof error === 'object' ? error : {};
          this._appendReportViaTool(agentState, {
            type: 'batch_error',
            title: `Ошибка батча${batch && Number.isFinite(Number(batch.index)) ? ` #${Number(batch.index) + 1}` : ''}`,
            body: safeError.message || 'Неизвестная ошибка батча',
            meta: {
              code: safeError.code || 'BATCH_FAILED',
              batchId: batch && batch.batchId ? batch.batchId : null
            }
          }, {
            message: 'batch_error_report_written'
          });
          this._pushToolLog(agentState.toolHistory, TOOL_KEYS.PROGRESS_AUDITOR, agentState.toolConfig[TOOL_KEYS.PROGRESS_AUDITOR], 'warn', safeError.message || 'Ошибка батча');
          this.runProgressAuditTool({ job, reason: 'batch_failure', force: true });
          this.runContextCompressionTool({ job, force: false, reason: 'batch_failure' });
        }
      });
    }

    runProgressAuditTool({ job, reason = 'periodic', force = false, mandatory = false } = {}) {
      return this.maybeAudit({ job, reason, force, mandatory });
    }

    runContextCompressionTool({ job, force = false, mandatory = false, reason = 'periodic' } = {}) {
      return this.maybeCompressContext({ job, force, mandatory, reason });
    }

    maybeAudit({ job, reason = 'periodic', force = false, mandatory = false } = {}) {
      if (!job || !job.agentState) {
        return null;
      }
      const agentState = job.agentState;
      const runtimeTuning = this._resolveRuntimeTuning(agentState.runtimeTuning || agentState.tuning || null);
      const mode = agentState.toolConfig ? agentState.toolConfig[TOOL_KEYS.PROGRESS_AUDITOR] : 'on';
      const modeEnabled = this._isToolEnabled(mode);
      if (!mandatory && !modeEnabled) {
        return null;
      }

      const now = Date.now();
      const lastAuditAt = Number(agentState.lastAuditAt || 0);
      const minIntervalMs = mandatory
        ? runtimeTuning.mandatoryAuditIntervalMs
        : runtimeTuning.auditIntervalMs;
      if (!force && (now - lastAuditAt) < minIntervalMs) {
        return null;
      }

      const total = Number.isFinite(Number(job.totalBlocks)) ? Number(job.totalBlocks) : 0;
      const completed = Number.isFinite(Number(job.completedBlocks)) ? Number(job.completedBlocks) : 0;
      const failed = Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0;
      const pending = Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0;
      const ratio = total > 0 ? completed / total : 1;
      const coverage = Math.max(0, Math.min(100, Math.round(ratio * 100)));
      const status = pending === 0
        ? 'complete'
        : failed > 0
          ? 'attention'
          : 'running';
      const statusLabel = status === 'complete'
        ? 'готово'
        : status === 'attention'
          ? 'требует внимания'
          : 'в процессе';

      const auditEntry = {
        ts: now,
        reason,
        status,
        coverage,
        total,
        completed,
        pending,
        failed,
        repeatedBatches: Number(agentState.repeatedBatchCount || 0)
      };
      agentState.audits = Array.isArray(agentState.audits) ? agentState.audits : [];
      agentState.audits.push(auditEntry);
      if (agentState.audits.length > this.MAX_AUDITS) {
        agentState.audits = agentState.audits.slice(-this.MAX_AUDITS);
      }
      agentState.lastAuditAt = now;
      agentState.updatedAt = now;

      const logMode = modeEnabled ? mode : `${mode}->forced`;
      this._pushToolLog(
        agentState.toolHistory,
        TOOL_KEYS.PROGRESS_AUDITOR,
        logMode,
        mandatory && !modeEnabled ? 'warn' : 'ok',
        `Аудит: статус=${statusLabel}, покрытие=${coverage}%${mandatory ? ' (обязательный)' : ''}`
      );
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: 'update_checklist_run_audits',
        action: () => this._updateChecklist(agentState.checklist, 'run_audits', pending === 0 ? 'done' : 'running', `покрытие=${coverage}%`)
      });

      return auditEntry;
    }

    maybeCompressContext({ job, force = false, mandatory = false, reason = 'periodic' } = {}) {
      if (!job || !job.agentState) {
        return null;
      }
      const agentState = job.agentState;
      const runtimeTuning = this._resolveRuntimeTuning(agentState.runtimeTuning || agentState.tuning || null);
      const mode = agentState.toolConfig ? agentState.toolConfig[TOOL_KEYS.CONTEXT_COMPRESSOR] : 'auto';
      const modeEnabled = this._isToolEnabled(mode);
      if (!mandatory && !modeEnabled) {
        return null;
      }

      const now = Date.now();
      const lastCompressionAt = Number(agentState.lastCompressionAt || 0);
      if (!force && (now - lastCompressionAt) < runtimeTuning.compressionCooldownMs) {
        return null;
      }

      const toolCount = Array.isArray(agentState.toolHistory) ? agentState.toolHistory.length : 0;
      const reportCount = Array.isArray(agentState.reports) ? agentState.reports.length : 0;
      const footprint = this._estimateContextFootprint(agentState);
      const pressureHigh = footprint >= runtimeTuning.contextFootprintLimit;
      if (!force && !pressureHigh && Math.max(toolCount, reportCount) < runtimeTuning.compressionThreshold) {
        return null;
      }

      const recentReports = (agentState.reports || []).slice(-8).map((item) => `${item.title}: ${item.body}`).join(' | ');
      const recentAudits = (agentState.audits || []).slice(-4).map((item) => `${item.status}:${item.coverage}%`).join(', ');
      const checklistDigest = (agentState.checklist || [])
        .filter((item) => item && item.status !== 'done')
        .slice(0, 4)
        .map((item) => `${item.id}:${item.status}`)
        .join(', ');
      const summary = [
        `профиль=${agentState.profile}`,
        `категории=${(agentState.selectedCategories || []).join(',') || 'нет'}`,
        `аудиты=${recentAudits || 'н/д'}`,
        `чеклист=${checklistDigest || 'всё_готово'}`,
        `объём_контекста=${footprint}`,
        `недавнее=${recentReports || 'н/д'}`
      ].join(' ; ');

      agentState.contextSummary = summary.slice(0, 1600);
      agentState.compressedContextCount = Number(agentState.compressedContextCount || 0) + 1;
      agentState.toolHistory = Array.isArray(agentState.toolHistory) ? agentState.toolHistory.slice(-50) : [];
      agentState.reports = Array.isArray(agentState.reports) ? agentState.reports.slice(-40) : [];
      agentState.lastCompressionAt = now;
      agentState.updatedAt = now;

      const logMode = modeEnabled ? mode : `${mode}->forced`;
      this._pushToolLog(
        agentState.toolHistory,
        TOOL_KEYS.CONTEXT_COMPRESSOR,
        logMode,
        mandatory && !modeEnabled ? 'warn' : 'ok',
        `Контекст сжат (${reason}; объём=${footprint})`
      );
      const pendingCount = Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0;
      const checklistStatus = pendingCount === 0 ? 'done' : 'running';
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: 'update_checklist_compress_context',
        action: () => this._updateChecklist(agentState.checklist, 'compress_context', checklistStatus, `сжатий=${agentState.compressedContextCount}`)
      });
      return agentState.contextSummary;
    }

    finalizeJob(job) {
      if (!job || !job.agentState) {
        return;
      }
      const agentState = job.agentState;
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: 'finalize_job',
        action: () => {
          this.runProgressAuditTool({ job, reason: 'finalize', force: true, mandatory: true });
          this.runContextCompressionTool({ job, force: true, mandatory: true, reason: 'finalize' });
          this._updateChecklist(agentState.checklist, 'execute_batches', 'done', 'все батчи обработаны');
          this._updateChecklist(agentState.checklist, 'proofread', 'done', 'финальная вычитка завершена');
          this._updateChecklist(agentState.checklist, 'final_report', 'done', 'отчёт готов');
          this._appendReportViaTool(agentState, {
            type: 'final',
            title: 'Перевод завершён',
            body: this._buildFinalSummary(job),
            meta: {
              totalBlocks: job.totalBlocks || 0,
              completedBlocks: job.completedBlocks || 0,
              failedBlocks: Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0
            }
          }, {
            message: 'final_report_written'
          });
          agentState.phase = 'done';
          agentState.status = 'done';
          agentState.updatedAt = Date.now();
        }
      });
    }

    markFailed(job, error) {
      if (!job || !job.agentState) {
        return;
      }
      const agentState = job.agentState;
      this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.WORKFLOW_CONTROLLER,
        force: true,
        message: 'mark_failed',
        action: () => {
          const safeError = error && typeof error === 'object' ? error : {};
          this._appendReportViaTool(agentState, {
            type: 'error',
            title: 'Перевод завершился ошибкой',
            body: safeError.message || 'Неизвестная ошибка',
            meta: {
              code: safeError.code || 'TRANSLATION_FAILED'
            }
          }, {
            message: 'failure_report_written'
          });
          this._updateChecklist(agentState.checklist, 'final_report', 'running', 'задача завершилась ошибкой; отчёт обновлён');
          agentState.phase = 'failed';
          agentState.status = 'failed';
          agentState.updatedAt = Date.now();
        }
      });
    }

    toUiSnapshot(agentState) {
      if (!agentState || typeof agentState !== 'object') {
        return null;
      }
      const checklist = Array.isArray(agentState.checklist) ? agentState.checklist.slice(-12) : [];
      const toolHistory = Array.isArray(agentState.toolHistory) ? agentState.toolHistory.slice(-20) : [];
      const reports = Array.isArray(agentState.reports) ? agentState.reports.slice(-12) : [];
      const audits = Array.isArray(agentState.audits) ? agentState.audits.slice(-10) : [];
      const toolConfig = agentState.toolConfig && typeof agentState.toolConfig === 'object'
        ? { ...agentState.toolConfig }
        : null;
      const toolConfigRequested = agentState.toolConfigRequested && typeof agentState.toolConfigRequested === 'object'
        ? { ...agentState.toolConfigRequested }
        : null;
      const toolAutoDecisions = Array.isArray(agentState.toolAutoDecisions)
        ? agentState.toolAutoDecisions.slice(-30)
        : [];
      const tuning = agentState.tuning && typeof agentState.tuning === 'object'
        ? { ...agentState.tuning }
        : null;
      const runtimeTuning = agentState.runtimeTuning && typeof agentState.runtimeTuning === 'object'
        ? { ...agentState.runtimeTuning }
        : null;
      const modelPolicy = this._normalizeModelPolicy(agentState.modelPolicy, null);
      const toolExecutionTrace = Array.isArray(agentState.toolExecutionTrace)
        ? agentState.toolExecutionTrace.slice(-40)
        : [];
      return {
        status: agentState.status || 'idle',
        phase: agentState.phase || 'idle',
        profile: agentState.profile || 'auto',
        selectedCategories: Array.isArray(agentState.selectedCategories) ? agentState.selectedCategories.slice() : [],
        tuning,
        runtimeTuning,
        modelPolicy,
        toolConfig,
        toolConfigRequested,
        toolAutoDecisions,
        toolExecutionTrace,
        checklist,
        toolHistory,
        reports,
        audits,
        contextSummary: agentState.contextSummary || '',
        compressedContextCount: Number(agentState.compressedContextCount || 0),
        glossarySize: Array.isArray(agentState.glossary) ? agentState.glossary.length : 0,
        plan: agentState.plan || null,
        recentDiffItems: Array.isArray(agentState.recentDiffItems) ? agentState.recentDiffItems.slice(-20) : []
      };
    }

    _resolveProfilePreset(profile, pageStats) {
      const preset = PROFILE_PRESETS[profile] || PROFILE_PRESETS.auto;
      if (profile !== 'auto') {
        return { ...preset };
      }

      const stats = pageStats || {};
      const codeRatio = typeof stats.codeRatio === 'number' ? stats.codeRatio : 0;
      const headingRatio = typeof stats.headingRatio === 'number' ? stats.headingRatio : 0;
      const avgChars = typeof stats.avgChars === 'number' ? stats.avgChars : 0;

      if (codeRatio > 0.18) {
        return { ...PROFILE_PRESETS.technical };
      }
      if (headingRatio > 0.16 && avgChars < 80) {
        return { ...PROFILE_PRESETS.literal };
      }
      if (avgChars > 220) {
        return { ...PROFILE_PRESETS.readable };
      }
      return { ...PROFILE_PRESETS.balanced };
    }

    _normalizeModelPolicy(input, fallbackSelection) {
      const fallback = fallbackSelection && typeof fallbackSelection === 'object'
        ? {
          speed: fallbackSelection.speed !== false,
          preference: fallbackSelection.preference === 'smartest' || fallbackSelection.preference === 'cheapest'
            ? fallbackSelection.preference
            : null
        }
        : { speed: true, preference: null };
      const src = input && typeof input === 'object' ? input : {};
      const hasSpeed = Object.prototype.hasOwnProperty.call(src, 'speed');
      return {
        mode: src.mode === 'fixed' ? 'fixed' : 'auto',
        speed: hasSpeed ? src.speed !== false : fallback.speed,
        preference: src.preference === 'smartest' || src.preference === 'cheapest'
          ? src.preference
          : fallback.preference,
        allowRouteOverride: src.allowRouteOverride !== false
      };
    }

    _normalizeAgentTuning(input) {
      const src = input && typeof input === 'object' ? input : {};
      const normalizeToken = (value, allowed, fallback) => {
        if (typeof value !== 'string') {
          return fallback;
        }
        const key = value.trim().toLowerCase();
        return allowed.includes(key) ? key : fallback;
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
        styleOverride: normalizeToken(src.styleOverride, ['auto', 'balanced', 'literal', 'readable', 'technical'], DEFAULT_AGENT_TUNING.styleOverride),
        maxBatchSizeOverride: normalizeNullableInt(src.maxBatchSizeOverride, 1),
        proofreadingPassesOverride: normalizeNullableInt(src.proofreadingPassesOverride, 0),
        parallelismOverride: normalizeToken(src.parallelismOverride, ['auto', 'low', 'mixed', 'high'], DEFAULT_AGENT_TUNING.parallelismOverride),
        plannerTemperature: normalizeNumber(src.plannerTemperature, 0, null, DEFAULT_AGENT_TUNING.plannerTemperature),
        plannerMaxOutputTokens: Math.round(normalizeNumber(src.plannerMaxOutputTokens, 1, null, DEFAULT_AGENT_TUNING.plannerMaxOutputTokens)),
        auditIntervalMs: Math.round(normalizeNumber(src.auditIntervalMs, 0, null, DEFAULT_AGENT_TUNING.auditIntervalMs)),
        mandatoryAuditIntervalMs: Math.round(normalizeNumber(src.mandatoryAuditIntervalMs, 0, null, DEFAULT_AGENT_TUNING.mandatoryAuditIntervalMs)),
        compressionThreshold: Math.round(normalizeNumber(src.compressionThreshold, 0, null, DEFAULT_AGENT_TUNING.compressionThreshold)),
        contextFootprintLimit: Math.round(normalizeNumber(src.contextFootprintLimit, 1, null, DEFAULT_AGENT_TUNING.contextFootprintLimit)),
        compressionCooldownMs: Math.round(normalizeNumber(src.compressionCooldownMs, 0, null, DEFAULT_AGENT_TUNING.compressionCooldownMs))
      };
    }

    _applyProfileTuning(resolvedProfile, tuning) {
      const base = resolvedProfile && typeof resolvedProfile === 'object'
        ? { ...resolvedProfile }
        : { ...PROFILE_PRESETS.auto };
      const safeTuning = this._normalizeAgentTuning(tuning);
      if (safeTuning.styleOverride !== 'auto') {
        base.style = safeTuning.styleOverride;
      }
      if (Number.isFinite(Number(safeTuning.maxBatchSizeOverride))) {
        base.maxBatchSize = this._clampBatchSize(Number(safeTuning.maxBatchSizeOverride));
      }
      if (Number.isFinite(Number(safeTuning.proofreadingPassesOverride))) {
        base.proofreadingPasses = Math.max(0, Number(safeTuning.proofreadingPassesOverride));
      }
      if (safeTuning.parallelismOverride !== 'auto') {
        base.parallelism = safeTuning.parallelismOverride;
      }
      return base;
    }

    _resolveRuntimeTuning(tuning) {
      const normalized = this._normalizeAgentTuning(tuning);
      const auditIntervalMs = normalized.auditIntervalMs;
      const mandatoryAuditIntervalMs = normalized.mandatoryAuditIntervalMs;
      return {
        auditIntervalMs,
        mandatoryAuditIntervalMs,
        compressionThreshold: normalized.compressionThreshold,
        contextFootprintLimit: normalized.contextFootprintLimit,
        compressionCooldownMs: normalized.compressionCooldownMs
      };
    }

    _normalizeCategoryMode(value) {
      if (value === 'all' || value === 'auto' || value === 'content' || value === 'interface' || value === 'meta' || value === 'custom') {
        return value;
      }
      return 'all';
    }

    _normalizeCategory(value) {
      if (typeof value !== 'string') {
        return null;
      }
      const raw = value.trim().toLowerCase();
      if (!raw) {
        return null;
      }
      if (KNOWN_CATEGORIES.includes(raw)) {
        return raw;
      }
      if (raw.includes('h1') || raw.includes('h2') || raw.includes('h3')) {
        return 'heading';
      }
      if (raw.includes('button')) {
        return 'button';
      }
      if (raw.includes('nav') || raw.includes('menu')) {
        return 'navigation';
      }
      if (raw.includes('code') || raw.includes('pre')) {
        return 'code';
      }
      if (raw.includes('meta') || raw.includes('title') || raw.includes('description')) {
        return 'meta';
      }
      if (raw.includes('label')) {
        return 'label';
      }
      if (raw.includes('li')) {
        return 'list';
      }
      if (raw.includes('table') || raw.includes('th') || raw.includes('td')) {
        return 'table';
      }
      if (raw.includes('blockquote') || raw.includes('quote')) {
        return 'quote';
      }
      if (raw.includes('p') || raw.includes('article')) {
        return 'paragraph';
      }
      return 'other';
    }

    _collectCategoryStats(blocks) {
      const stats = {};
      KNOWN_CATEGORIES.forEach((category) => {
        stats[category] = { count: 0, chars: 0 };
      });
      (blocks || []).forEach((item) => {
        const category = this._normalizeCategory(item.category || item.pathHint) || 'other';
        const text = typeof item.originalText === 'string' ? item.originalText : '';
        stats[category] = stats[category] || { count: 0, chars: 0 };
        stats[category].count += 1;
        stats[category].chars += text.length;
      });
      return stats;
    }

    _collectPageStats(blocks, categoryStats) {
      const totalBlocks = Array.isArray(blocks) ? blocks.length : 0;
      const totalChars = (blocks || []).reduce((acc, item) => acc + (item && typeof item.originalText === 'string' ? item.originalText.length : 0), 0);
      const safeTotal = Math.max(1, totalBlocks);
      const codeCount = categoryStats && categoryStats.code ? categoryStats.code.count : 0;
      const headingCount = categoryStats && categoryStats.heading ? categoryStats.heading.count : 0;
      return {
        blockCount: totalBlocks,
        totalChars,
        avgChars: totalChars / safeTotal,
        codeRatio: codeCount / safeTotal,
        headingRatio: headingCount / safeTotal
      };
    }

    _collectReuseStats(blocks) {
      const list = Array.isArray(blocks) ? blocks : [];
      const counts = {};
      list.forEach((item) => {
        const text = item && typeof item.originalText === 'string'
          ? item.originalText.trim().toLowerCase()
          : '';
        if (!text) {
          return;
        }
        counts[text] = (counts[text] || 0) + 1;
      });
      const duplicated = Object.keys(counts).reduce((acc, key) => {
        const count = counts[key];
        return count > 1 ? acc + (count - 1) : acc;
      }, 0);
      const safeTotal = Math.max(1, list.length);
      return {
        duplicatedBlocks: duplicated,
        duplicateRatio: duplicated / safeTotal
      };
    }

    _resolveEffectiveToolConfig({ requestedToolConfig, resolvedProfile, pageStats, categoryStats, reuseStats, blockCount } = {}) {
      const requested = requestedToolConfig && typeof requestedToolConfig === 'object'
        ? requestedToolConfig
        : {};
      const profileInfo = resolvedProfile && typeof resolvedProfile === 'object'
        ? resolvedProfile
        : PROFILE_PRESETS.auto;
      const stats = pageStats && typeof pageStats === 'object' ? pageStats : {};
      const categoryMap = categoryStats && typeof categoryStats === 'object' ? categoryStats : {};
      const reuse = reuseStats && typeof reuseStats === 'object' ? reuseStats : {};
      const totalBlocks = Number.isFinite(Number(blockCount)) ? Number(blockCount) : 0;
      const populatedCategoryCount = Object.keys(categoryMap)
        .filter((key) => categoryMap[key] && Number(categoryMap[key].count || 0) > 0)
        .length;

      const context = {
        style: profileInfo.style || 'balanced',
        blockCount: totalBlocks,
        totalChars: Number.isFinite(Number(stats.totalChars)) ? Number(stats.totalChars) : 0,
        avgChars: Number.isFinite(Number(stats.avgChars)) ? Number(stats.avgChars) : 0,
        codeRatio: Number.isFinite(Number(stats.codeRatio)) ? Number(stats.codeRatio) : 0,
        headingRatio: Number.isFinite(Number(stats.headingRatio)) ? Number(stats.headingRatio) : 0,
        categoryCount: populatedCategoryCount,
        duplicateRatio: Number.isFinite(Number(reuse.duplicateRatio)) ? Number(reuse.duplicateRatio) : 0
      };

      const toolConfig = {};
      const decisions = [];
      Object.keys(DEFAULT_TOOL_CONFIG).forEach((toolKey) => {
        const requestedMode = requested[toolKey] === 'on' || requested[toolKey] === 'off' || requested[toolKey] === 'auto'
          ? requested[toolKey]
          : DEFAULT_TOOL_CONFIG[toolKey];
        if (requestedMode === 'on' || requestedMode === 'off') {
          toolConfig[toolKey] = requestedMode;
        decisions.push({
          tool: toolKey,
          source: 'explicit',
          requestedMode,
          effectiveMode: requestedMode,
          reason: requestedMode === 'on' ? 'Настроено пользователем/профилем: ВКЛ' : 'Настроено пользователем/профилем: ВЫКЛ'
        });
          return;
        }

        const autoDecision = this._resolveAutoToolMode(toolKey, context);
        toolConfig[toolKey] = autoDecision.mode;
        decisions.push({
          tool: toolKey,
          source: 'auto',
          requestedMode: 'auto',
          effectiveMode: autoDecision.mode,
          reason: autoDecision.reason
        });
      });
      return {
        toolConfig,
        decisions
      };
    }

    _resolveAutoToolMode(toolKey, context) {
      const safe = context && typeof context === 'object' ? context : {};
      const blockCount = Number.isFinite(Number(safe.blockCount)) ? Number(safe.blockCount) : 0;
      const totalChars = Number.isFinite(Number(safe.totalChars)) ? Number(safe.totalChars) : 0;
      const avgChars = Number.isFinite(Number(safe.avgChars)) ? Number(safe.avgChars) : 0;
      const codeRatio = Number.isFinite(Number(safe.codeRatio)) ? Number(safe.codeRatio) : 0;
      const headingRatio = Number.isFinite(Number(safe.headingRatio)) ? Number(safe.headingRatio) : 0;
      const categoryCount = Number.isFinite(Number(safe.categoryCount)) ? Number(safe.categoryCount) : 0;
      const duplicateRatio = Number.isFinite(Number(safe.duplicateRatio)) ? Number(safe.duplicateRatio) : 0;
      const style = typeof safe.style === 'string' ? safe.style : 'balanced';

      if (toolKey === TOOL_KEYS.PAGE_ANALYZER) {
        return { mode: 'on', reason: 'Нужен для планирования и диагностики с учётом структуры страницы' };
      }
      if (toolKey === TOOL_KEYS.CATEGORY_SELECTOR) {
        if (categoryCount > 1 || blockCount > 6) {
          return { mode: 'on', reason: 'Обнаружено несколько категорий; селективный выбор полезен' };
        }
        return { mode: 'off', reason: 'Одна категория или маленькая страница; лишняя селекция не нужна' };
      }
      if (toolKey === TOOL_KEYS.GLOSSARY_BUILDER) {
        if (totalChars > 900 || duplicateRatio > 0.16 || codeRatio > 0.08 || style === 'technical') {
          return { mode: 'on', reason: 'Высокий риск рассинхрона терминологии на этой странице' };
        }
        return { mode: 'off', reason: 'Низкий повтор терминов; шаг глоссария пропущен ради скорости' };
      }
      if (toolKey === TOOL_KEYS.BATCH_PLANNER) {
        if (blockCount > 14 || categoryCount > 3 || style === 'technical' || style === 'readable') {
          return { mode: 'on', reason: 'Сложной странице полезно явное планирование батчей' };
        }
        return { mode: 'off', reason: 'Для простой страницы достаточно детерминированного базового плана' };
      }
      if (toolKey === TOOL_KEYS.MODEL_ROUTER) {
        if (style === 'technical' || style === 'literal' || codeRatio > 0.02 || headingRatio > 0.12 || blockCount > 4) {
          return { mode: 'on', reason: 'Смешанный сложный контент требует маршрутизации модели по батчам' };
        }
        return { mode: 'off', reason: 'Однородному простому контенту не нужна динамическая маршрутизация' };
      }
      if (toolKey === TOOL_KEYS.PROGRESS_AUDITOR) {
        return { mode: 'on', reason: 'Периодический аудит обязателен для контроля плана и прогресса' };
      }
      if (toolKey === TOOL_KEYS.ANTI_REPEAT_GUARD) {
        return { mode: 'on', reason: 'Предотвращение дубликатов обязательно для стабильного выполнения' };
      }
      if (toolKey === TOOL_KEYS.CONTEXT_COMPRESSOR) {
        if (blockCount > 45 || totalChars > 6000 || avgChars > 180) {
          return { mode: 'on', reason: 'Большой объём контекста; нужно сжатие, чтобы избежать переполнения' };
        }
        return { mode: 'off', reason: 'Контекст небольшой; сжатие отложено' };
      }
      if (toolKey === TOOL_KEYS.REPORT_WRITER) {
        return { mode: 'on', reason: 'Отчёты нужны для прозрачной отладки и трассировки' };
      }
      if (toolKey === TOOL_KEYS.PAGE_RUNTIME) {
        return { mode: 'on', reason: 'Отслеживает runtime-действия контент-скрипта (apply/restore/rescan) для полной трассы' };
      }
      if (toolKey === TOOL_KEYS.CACHE_MANAGER) {
        return { mode: 'on', reason: 'Отслеживает решения по восстановлению/сохранению кэша для воспроизводимости' };
      }
      return { mode: 'on', reason: 'Политика авто по умолчанию' };
    }

    _resolveBatchRouteHint({ agentState, batch } = {}) {
      const state = agentState && typeof agentState === 'object' ? agentState : {};
      const plan = state.plan && typeof state.plan === 'object' ? state.plan : {};
      const modelHints = plan.modelHints && typeof plan.modelHints === 'object' ? plan.modelHints : {};
      const strongSet = new Set(
        (Array.isArray(modelHints.strongFor) ? modelHints.strongFor : [])
          .map((item) => this._normalizeCategory(item))
          .filter(Boolean)
      );
      const fastSet = new Set(
        (Array.isArray(modelHints.fastFor) ? modelHints.fastFor : [])
          .map((item) => this._normalizeCategory(item))
          .filter(Boolean)
      );
      const categoryCounts = this._countBatchCategories(batch && batch.blocks ? batch.blocks : []);
      const categories = Object.keys(categoryCounts).filter((key) => Number(categoryCounts[key] || 0) > 0);
      if (!categories.length) {
        return 'fast';
      }
      if (categories.some((category) => strongSet.has(category))) {
        return 'strong';
      }
      if (categories.every((category) => fastSet.has(category))) {
        return 'fast';
      }
      const style = typeof plan.style === 'string' ? plan.style : '';
      if (style === 'technical' || style === 'literal') {
        return 'strong';
      }
      if ((categoryCounts.code || 0) > 0 || (categoryCounts.table || 0) > 0 || (categoryCounts.heading || 0) > 0) {
        return 'strong';
      }
      return 'fast';
    }

    _selectCategories({ mode, custom, blocks, categoryStats } = {}) {
      const inputBlocks = Array.isArray(blocks) ? blocks : [];
      const safeCategoryStats = categoryStats && typeof categoryStats === 'object'
        ? categoryStats
        : {};
      const availableSet = new Set(
        inputBlocks
          .map((item) => this._normalizeCategory(
            item && typeof item === 'object'
              ? (item.category || item.pathHint)
              : ''
          ) || 'other')
      );
      if (!availableSet.size) {
        Object.keys(safeCategoryStats).forEach((category) => {
          const normalized = this._normalizeCategory(category);
          const count = Number(safeCategoryStats[category] && safeCategoryStats[category].count || 0);
          if (normalized && count > 0) {
            availableSet.add(normalized);
          }
        });
      }
      const available = Array.from(availableSet);
      const hasAvailable = (category) => availableSet.has(category);
      const countFor = (category) => {
        if (!hasAvailable(category)) {
          return 0;
        }
        const bucket = safeCategoryStats[category] && typeof safeCategoryStats[category] === 'object'
          ? safeCategoryStats[category]
          : {};
        const count = Number(bucket.count || 0);
        return Number.isFinite(count) && count > 0 ? count : 0;
      };
      const sumGroup = (groupName) => (CATEGORY_GROUPS[groupName] || [])
        .reduce((sum, category) => sum + countFor(category), 0);
      const normalizeOutput = (list) => {
        const seen = new Set();
        const out = [];
        (Array.isArray(list) ? list : []).forEach((value) => {
          const category = this._normalizeCategory(value);
          if (!category || seen.has(category)) {
            return;
          }
          seen.add(category);
          out.push(category);
        });
        return out;
      };
      const allAvailableOrdered = normalizeOutput(KNOWN_CATEGORIES.filter((category) => hasAvailable(category)));
      const ensureHeadingIfPresent = (list) => {
        const output = normalizeOutput(list);
        if (hasAvailable('heading') && !output.includes('heading')) {
          output.unshift('heading');
        }
        return normalizeOutput(output);
      };

      let selected = [];
      if (mode === 'custom') {
        selected = normalizeOutput((Array.isArray(custom) ? custom : []).filter((item) => hasAvailable(item)));
      } else if (mode === 'content' || mode === 'interface' || mode === 'meta') {
        selected = normalizeOutput((CATEGORY_GROUPS[mode] || []).filter((item) => hasAvailable(item)));
        if (mode === 'content') {
          selected = ensureHeadingIfPresent(selected);
        }
      } else if (mode === 'auto') {
        const contentWeight = sumGroup('content');
        const interfaceWeight = sumGroup('interface');
        const metaWeight = countFor('meta');

        const contentDominates = (contentWeight >= interfaceWeight * 2 && contentWeight > 0) || contentWeight >= 8;
        const interfaceDominates = interfaceWeight > contentWeight * 1.5 && contentWeight <= 3 && interfaceWeight > 0;
        const metaDominates = metaWeight > 0 && contentWeight <= 1 && interfaceWeight <= 2;

        if (metaDominates) {
          const metaOnly = normalizeOutput((CATEGORY_GROUPS.meta || []).filter((item) => hasAvailable(item)));
          const metaWithInterface = normalizeOutput([
            ...metaOnly,
            ...((CATEGORY_GROUPS.interface || []).filter((item) => hasAvailable(item)))
          ]);
          selected = metaWithInterface.length ? metaWithInterface : metaOnly;
        } else if (contentDominates) {
          selected = ensureHeadingIfPresent((CATEGORY_GROUPS.content || []).filter((item) => hasAvailable(item)));
        } else if (interfaceDominates) {
          selected = normalizeOutput((CATEGORY_GROUPS.interface || []).filter((item) => hasAvailable(item)));
        } else {
          selected = allAvailableOrdered.slice();
        }
      } else {
        selected = allAvailableOrdered.slice();
      }

      if (!selected.length) {
        selected = normalizeOutput(
          Object.keys(safeCategoryStats).filter((category) => Number((safeCategoryStats[category] || {}).count || 0) > 0)
        );
      }
      if (!selected.length) {
        selected = ['other'];
      }
      return selected;
    }

    _buildGlossary(blocks) {
      const counter = {};
      const termRegex = /\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g;
      (blocks || []).forEach((item) => {
        const text = typeof item.originalText === 'string' ? item.originalText : '';
        const matches = text.match(termRegex);
        if (!matches) {
          return;
        }
        matches.forEach((token) => {
          const key = token.toLowerCase();
          counter[key] = (counter[key] || 0) + 1;
        });
      });

      const candidates = Object.keys(counter)
        .filter((term) => counter[term] > 2)
        .sort((a, b) => counter[b] - counter[a] || a.localeCompare(b))
        .slice(0, 24);
      return candidates.map((term) => ({
        term,
        count: counter[term],
        hint: null
      }));
    }

    _buildFallbackPlan({ blocks, profile, resolvedProfile, selectedCategories } = {}) {
      const blockCount = Array.isArray(blocks) ? blocks.length : 0;
      const batchSize = this._resolveBatchSize(resolvedProfile, blockCount);
      const style = resolvedProfile && typeof resolvedProfile.style === 'string'
        ? resolvedProfile.style
        : 'balanced';
      const passes = this._resolveProofreadingPasses(resolvedProfile, blockCount);
      const categoryOrder = this._buildCategoryOrder(blocks, selectedCategories);
      const summary = `Профиль ${profile} -> стиль=${style}, размер_батча=${batchSize}, категории=${selectedCategories.join(', ')}`;
      return {
        style,
        batchSize,
        proofreadingPasses: passes,
        categoryOrder,
        parallelCategories: categoryOrder.filter((item) => item === 'paragraph' || item === 'list' || item === 'meta'),
        sequentialCategories: categoryOrder.filter((item) => item === 'heading' || item === 'table' || item === 'code'),
        instructions: this._buildStyleInstruction(style),
        modelHints: {
          strongFor: ['heading', 'code', 'table'],
          fastFor: ['paragraph', 'list', 'button', 'label']
        },
        summary
      };
    }

    _mergePlan(basePlan, llmPlan) {
      const merged = { ...(basePlan || {}) };
      const src = llmPlan && typeof llmPlan === 'object' ? llmPlan : {};

      if (typeof src.style === 'string' && src.style) {
        merged.style = src.style;
      }
      if (Number.isFinite(Number(src.batchSize))) {
        merged.batchSize = this._clampBatchSize(Number(src.batchSize));
      }
      if (Number.isFinite(Number(src.proofreadingPasses))) {
        merged.proofreadingPasses = Math.max(0, Number(src.proofreadingPasses));
      }
      if (Array.isArray(src.categoryOrder) && src.categoryOrder.length) {
        merged.categoryOrder = src.categoryOrder.map((item) => this._normalizeCategory(item)).filter(Boolean);
      }
      if (typeof src.summary === 'string' && src.summary) {
        merged.summary = src.summary.slice(0, 800);
      }
      if (typeof src.instructions === 'string' && src.instructions) {
        merged.instructions = src.instructions.slice(0, 1200);
      }
      if (src.modelHints && typeof src.modelHints === 'object') {
        merged.modelHints = {
          strongFor: Array.isArray(src.modelHints.strongFor) ? src.modelHints.strongFor.slice(0, 10) : (merged.modelHints ? merged.modelHints.strongFor : []),
          fastFor: Array.isArray(src.modelHints.fastFor) ? src.modelHints.fastFor.slice(0, 10) : (merged.modelHints ? merged.modelHints.fastFor : [])
        };
      }
      return merged;
    }

    async _askPlanner({ job, blocks, selectedCategories, glossary, resolved } = {}) {
      if (!this.runLlmRequest) {
        return null;
      }

      try {
        const prompt = this._buildPlannerPrompt({
          targetLang: job && job.targetLang ? job.targetLang : 'ru',
          profile: resolved ? resolved.profile : 'auto',
          resolvedProfile: resolved ? resolved.resolvedProfile : PROFILE_PRESETS.auto,
          tuning: resolved && resolved.tuning ? resolved.tuning : DEFAULT_AGENT_TUNING,
          blockCount: Array.isArray(blocks) ? blocks.length : 0,
          selectedCategories,
          glossary
        });

        const tuning = resolved && resolved.tuning ? resolved.tuning : DEFAULT_AGENT_TUNING;
        const raw = await this.runLlmRequest({
          tabId: job && Number.isFinite(Number(job.tabId)) ? Number(job.tabId) : null,
          taskType: 'translation_agent_plan',
          request: {
            input: prompt,
            maxOutputTokens: tuning.plannerMaxOutputTokens,
            temperature: tuning.plannerTemperature,
            store: false,
            background: false,
            attempt: 1,
            jobId: job && job.id ? job.id : `job-${Date.now()}`,
            blockId: 'agent-plan',
            hintBatchSize: 1
          }
        });

        const text = this._extractOutputText(raw);
        if (!text) {
          return null;
        }
        const json = this._parseJsonBlock(text);
        return json && typeof json === 'object' ? json : null;
      } catch (_) {
        return null;
      }
    }

    _buildPlannerPrompt({ targetLang, profile, resolvedProfile, tuning, blockCount, selectedCategories, glossary } = {}) {
      const profileInfo = resolvedProfile && typeof resolvedProfile === 'object' ? resolvedProfile : {};
      const safeTuning = tuning && typeof tuning === 'object' ? tuning : DEFAULT_AGENT_TUNING;
      return [
        'You are a translation planning agent for a browser extension.',
        `Target language: ${targetLang || 'ru'}`,
        `Profile: ${profile || 'auto'}`,
        `Base style: ${profileInfo.style || 'balanced'}`,
        `Base batch size: ${profileInfo.maxBatchSize || 'auto'}`,
        `Planning temperature: ${safeTuning.plannerTemperature}`,
        `Planner output tokens: ${safeTuning.plannerMaxOutputTokens}`,
        `Block count: ${Number(blockCount || 0)}`,
        `Selected categories: ${(selectedCategories || []).join(', ') || 'none'}`,
        `Glossary candidates: ${(glossary || []).slice(0, 20).map((item) => item.term).join(', ') || 'none'}`,
        'Return ONLY JSON object with keys:',
        '{',
        '  "summary": "short summary",',
        '  "style": "preferred style hint",',
        '  "batchSize": "preferred integer batch size",',
        '  "proofreadingPasses": "preferred integer proofreading passes",',
        '  "categoryOrder": ["..."],',
        '  "instructions": "compact translation instruction",',
        '  "modelHints": { "strongFor": ["..."], "fastFor": ["..."] }',
        '}'
      ].join('\n');
    }

    _buildSystemPrompt({ profile, style, targetLang, toolConfig } = {}) {
      const toolsLine = Object.keys(toolConfig || {})
        .map((key) => `${key}:${toolConfig[key]}`)
        .join(', ');
      return [
        'You are Neuro Translate Agent.',
        `Translate content to ${targetLang || 'ru'} while preserving intent and UX semantics.`,
        `Profile=${profile || 'auto'} style=${style || 'balanced'}.`,
        'Always return structured output and include concise batch report.',
        `Enabled tools: ${toolsLine || 'default'}`
      ].join(' ');
    }

    _defaultReportFormat() {
      return {
        version: 'nt.agent.report.v1',
        type: 'object',
        keys: ['summary', 'quality', 'notes']
      };
    }

    _buildInitialChecklist() {
      const now = Date.now();
      return [
        { id: 'analyze_page', title: 'Анализ текста страницы', status: 'pending', details: '', updatedAt: now },
        { id: 'select_categories', title: 'Выбор категорий перевода', status: 'pending', details: '', updatedAt: now },
        { id: 'build_glossary', title: 'Глоссарий / контекст', status: 'pending', details: '', updatedAt: now },
        { id: 'plan_pipeline', title: 'План выполнения', status: 'pending', details: '', updatedAt: now },
        { id: 'agent_ready', title: 'Агент готов', status: 'pending', details: '', updatedAt: now },
        { id: 'execute_batches', title: 'Выполнение батчей', status: 'pending', details: '', updatedAt: now },
        { id: 'run_audits', title: 'Периодические аудиты', status: 'pending', details: '', updatedAt: now },
        { id: 'compress_context', title: 'Автосжатие контекста', status: 'pending', details: '', updatedAt: now },
        { id: 'proofread', title: 'Вычитка / полировка', status: 'pending', details: '', updatedAt: now },
        { id: 'final_report', title: 'Финальный отчёт', status: 'pending', details: '', updatedAt: now }
      ];
    }

    _updateChecklist(checklist, id, status, details) {
      if (!Array.isArray(checklist)) {
        return;
      }
      const now = Date.now();
      const item = checklist.find((entry) => entry && entry.id === id);
      if (!item) {
        return;
      }
      item.status = status || item.status;
      item.details = typeof details === 'string' ? details : item.details;
      item.updatedAt = now;
    }

    _computeOrderedPending(job, agentState, pending) {
      const categoryOrder = agentState && agentState.plan && Array.isArray(agentState.plan.categoryOrder)
        ? agentState.plan.categoryOrder
        : [];
      if (!categoryOrder.length) {
        return pending;
      }
      const weightByCategory = {};
      categoryOrder.forEach((category, index) => {
        weightByCategory[category] = index;
      });

      return pending.slice().sort((a, b) => {
        const blockA = job.blocksById && job.blocksById[a] ? job.blocksById[a] : null;
        const blockB = job.blocksById && job.blocksById[b] ? job.blocksById[b] : null;
        const catA = this._normalizeCategory(blockA ? blockA.category || blockA.pathHint : '') || 'other';
        const catB = this._normalizeCategory(blockB ? blockB.category || blockB.pathHint : '') || 'other';
        const weightA = Object.prototype.hasOwnProperty.call(weightByCategory, catA) ? weightByCategory[catA] : 999;
        const weightB = Object.prototype.hasOwnProperty.call(weightByCategory, catB) ? weightByCategory[catB] : 999;
        if (weightA !== weightB) {
          return weightA - weightB;
        }
        return String(a).localeCompare(String(b));
      });
    }

    _buildCategoryOrder(blocks, selectedCategories) {
      const base = Array.isArray(selectedCategories) ? selectedCategories.slice() : [];
      const counts = {};
      (blocks || []).forEach((item) => {
        const category = this._normalizeCategory(item.category || item.pathHint) || 'other';
        counts[category] = (counts[category] || 0) + 1;
      });
      return base.sort((a, b) => (counts[b] || 0) - (counts[a] || 0));
    }

    _countBatchCategories(blocks) {
      const out = {};
      (blocks || []).forEach((item) => {
        const category = this._normalizeCategory(item.category || item.pathHint) || 'other';
        out[category] = (out[category] || 0) + 1;
      });
      return out;
    }

    _batchSignature(blockIds) {
      const src = Array.isArray(blockIds) ? blockIds.join('|') : '';
      let hash = 0;
      for (let i = 0; i < src.length; i += 1) {
        hash = ((hash << 5) - hash) + src.charCodeAt(i);
        hash |= 0;
      }
      return `s${Math.abs(hash)}`;
    }

    _buildDiffItems(blocks, translatedItems) {
      const translatedMap = {};
      (translatedItems || []).forEach((item) => {
        if (!item || !item.blockId || typeof item.text !== 'string') {
          return;
        }
        translatedMap[item.blockId] = item.text;
      });
      return (blocks || [])
        .map((block) => {
          const before = block && typeof block.originalText === 'string' ? block.originalText : '';
          const after = block && block.blockId && Object.prototype.hasOwnProperty.call(translatedMap, block.blockId)
            ? translatedMap[block.blockId]
            : null;
          if (after === null || before === after) {
            return null;
          }
          return {
            blockId: block.blockId,
            category: this._normalizeCategory(block.category || block.pathHint) || 'other',
            before: before.slice(0, 220),
            after: after.slice(0, 220)
          };
        })
        .filter(Boolean)
        .slice(0, 12);
    }

    _estimateContextFootprint(agentState) {
      const state = agentState && typeof agentState === 'object' ? agentState : {};
      const sections = [
        state.contextSummary || '',
        JSON.stringify(Array.isArray(state.reports) ? state.reports.slice(-24) : []),
        JSON.stringify(Array.isArray(state.audits) ? state.audits.slice(-24) : []),
        JSON.stringify(Array.isArray(state.toolHistory) ? state.toolHistory.slice(-40) : []),
        JSON.stringify(Array.isArray(state.checklist) ? state.checklist : [])
      ];
      return sections.reduce((acc, value) => {
        if (typeof value === 'string') {
          return acc + value.length;
        }
        return acc;
      }, 0);
    }

    _buildFinalSummary(job) {
      const total = Number.isFinite(Number(job.totalBlocks)) ? Number(job.totalBlocks) : 0;
      const completed = Number.isFinite(Number(job.completedBlocks)) ? Number(job.completedBlocks) : 0;
      const failed = Array.isArray(job.failedBlockIds) ? job.failedBlockIds.length : 0;
      if (failed > 0) {
        return `Завершено с проблемами: переведено ${completed}/${total}, ошибок ${failed}.`;
      }
      return `Успешно завершено: переведено ${completed}/${total}.`;
    }

    _resolveBatchSize(resolvedProfile, blockCount) {
      if (resolvedProfile && Number.isFinite(Number(resolvedProfile.maxBatchSize))) {
        return this._clampBatchSize(Number(resolvedProfile.maxBatchSize));
      }
      if (blockCount > 260) {
        return 10;
      }
      if (blockCount > 120) {
        return 8;
      }
      if (blockCount > 40) {
        return 6;
      }
      return 4;
    }

    _resolveProofreadingPasses(resolvedProfile, blockCount) {
      if (resolvedProfile && Number.isFinite(Number(resolvedProfile.proofreadingPasses))) {
        return Math.max(0, Number(resolvedProfile.proofreadingPasses));
      }
      if (blockCount > 180) {
        return 1;
      }
      return 2;
    }

    _buildStyleInstruction(style) {
      if (style === 'literal') {
        return 'Prefer literal translation where structure and terminology must remain strict.';
      }
      if (style === 'readable') {
        return 'Prefer readability and natural phrasing while preserving meaning.';
      }
      if (style === 'technical') {
        return 'Preserve technical terms, code syntax, placeholders, and UI constraints.';
      }
      return 'Balance readability and literal precision depending on local context.';
    }

    _resolveToolMode(agentState, tool, modeOverride) {
      if (modeOverride === 'on' || modeOverride === 'off' || modeOverride === 'auto') {
        return modeOverride;
      }
      const state = agentState && typeof agentState === 'object' ? agentState : {};
      const configured = state.toolConfig && typeof state.toolConfig === 'object'
        ? state.toolConfig[tool]
        : null;
      if (configured === 'on' || configured === 'off' || configured === 'auto') {
        return configured;
      }
      const fallback = Object.prototype.hasOwnProperty.call(DEFAULT_TOOL_CONFIG, tool)
        ? DEFAULT_TOOL_CONFIG[tool]
        : 'on';
      return fallback;
    }

    _ensureToolExecutionTrace(agentState) {
      if (!agentState || typeof agentState !== 'object') {
        return null;
      }
      if (!Array.isArray(agentState.toolExecutionTrace)) {
        agentState.toolExecutionTrace = [];
      }
      return agentState.toolExecutionTrace;
    }

    _recordToolExecution(agentState, {
      tool,
      mode,
      status,
      forced = false,
      message = '',
      meta = null
    } = {}) {
      const trace = this._ensureToolExecutionTrace(agentState);
      if (!trace) {
        return;
      }
      trace.push({
        ts: Date.now(),
        tool: tool || 'unknown',
        mode: mode || 'auto',
        status: status || 'ok',
        forced: Boolean(forced),
        message: typeof message === 'string' ? message : '',
        meta: meta && typeof meta === 'object' ? { ...meta } : null
      });
      if (trace.length > this.MAX_TOOL_TRACE) {
        trace.splice(0, trace.length - this.MAX_TOOL_TRACE);
      }
    }

    _executeToolSync({
      agentState,
      tool,
      mode = null,
      force = false,
      message = '',
      action = null,
      onDisabledMessage = '',
      disabledValue = null
    } = {}) {
      const resolvedMode = this._resolveToolMode(agentState, tool, mode);
      const enabled = force || this._isToolEnabled(resolvedMode);
      if (!enabled) {
        if (onDisabledMessage) {
          this._pushToolLog(agentState && agentState.toolHistory, tool, resolvedMode, 'skip', onDisabledMessage);
        }
        this._recordToolExecution(agentState, {
          tool,
          mode: resolvedMode,
          status: 'skip',
          forced: force,
          message: onDisabledMessage || message || 'инструмент отключён'
        });
        return disabledValue;
      }

      try {
        const out = typeof action === 'function' ? action() : disabledValue;
        this._recordToolExecution(agentState, {
          tool,
          mode: resolvedMode,
          status: 'ok',
          forced: force,
          message: message || 'действие инструмента выполнено'
        });
        return out;
      } catch (error) {
        const errMessage = error && error.message ? error.message : 'ошибка действия инструмента';
        this._recordToolExecution(agentState, {
          tool,
          mode: resolvedMode,
          status: 'error',
          forced: force,
          message: `${message || 'действие инструмента'} | ${errMessage}`
        });
        this._pushToolLog(agentState && agentState.toolHistory, tool, resolvedMode, 'error', errMessage);
        return disabledValue;
      }
    }

    async _executeToolAsync({
      agentState,
      tool,
      mode = null,
      force = false,
      message = '',
      action = null,
      onDisabledMessage = '',
      fallbackValue = null
    } = {}) {
      const resolvedMode = this._resolveToolMode(agentState, tool, mode);
      const enabled = force || this._isToolEnabled(resolvedMode);
      if (!enabled) {
        if (onDisabledMessage) {
          this._pushToolLog(agentState && agentState.toolHistory, tool, resolvedMode, 'skip', onDisabledMessage);
        }
        this._recordToolExecution(agentState, {
          tool,
          mode: resolvedMode,
          status: 'skip',
          forced: force,
          message: onDisabledMessage || message || 'инструмент отключён'
        });
        return fallbackValue;
      }
      try {
        const out = typeof action === 'function'
          ? await action()
          : fallbackValue;
        this._recordToolExecution(agentState, {
          tool,
          mode: resolvedMode,
          status: 'ok',
          forced: force,
          message: message || 'действие инструмента выполнено'
        });
        return out;
      } catch (error) {
        const errMessage = error && error.message ? error.message : 'ошибка действия инструмента';
        this._recordToolExecution(agentState, {
          tool,
          mode: resolvedMode,
          status: 'error',
          forced: force,
          message: `${message || 'действие инструмента'} | ${errMessage}`
        });
        this._pushToolLog(agentState && agentState.toolHistory, tool, resolvedMode, 'error', errMessage);
        return fallbackValue;
      }
    }

    _appendReportViaTool(agentState, report, { force = false, message = 'append_report' } = {}) {
      return this._executeToolSync({
        agentState,
        tool: TOOL_KEYS.REPORT_WRITER,
        force,
        message,
        onDisabledMessage: 'Запись отчётов отключена',
        disabledValue: null,
        action: () => this._appendReport(agentState, report)
      });
    }

    _pushToolLog(toolHistory, tool, mode, status, message) {
      if (!Array.isArray(toolHistory)) {
        return;
      }
      toolHistory.push({
        ts: Date.now(),
        tool,
        mode: mode || 'auto',
        status: status || 'ok',
        message: message || ''
      });
      if (toolHistory.length > this.MAX_TOOL_LOG) {
        toolHistory.splice(0, toolHistory.length - this.MAX_TOOL_LOG);
      }
    }

    _appendReport(agentState, report) {
      if (!agentState) {
        return;
      }
      if (
        agentState.toolConfig
        && Object.prototype.hasOwnProperty.call(agentState.toolConfig, TOOL_KEYS.REPORT_WRITER)
        && !this._isToolEnabled(agentState.toolConfig[TOOL_KEYS.REPORT_WRITER])
      ) {
        return;
      }
      agentState.reports = Array.isArray(agentState.reports) ? agentState.reports : [];
      const next = {
        ts: Date.now(),
        type: this._sanitizeReportToken(report && report.type ? report.type : 'note', 'note'),
        title: this._sanitizeReportText(report && report.title ? report.title : 'Отчёт', 140),
        body: this._sanitizeReportText(report && report.body ? report.body : '', 1200),
        meta: this._sanitizeReportMeta(report && report.meta ? report.meta : {}),
        formatVersion: 'nt.agent.report.v1'
      };
      agentState.reports.push(next);
      if (agentState.reports.length > this.MAX_REPORTS) {
        agentState.reports = agentState.reports.slice(-this.MAX_REPORTS);
      }
    }

    _normalizeExternalBatchReport(report, { batch, translatedItems } = {}) {
      const raw = report && typeof report === 'object' ? report : {};
      const batchSize = Array.isArray(batch && batch.blockIds) ? batch.blockIds.length : 0;
      const translatedCount = Array.isArray(translatedItems) ? translatedItems.length : 0;
      const summaryRaw = typeof raw.summary === 'string' ? raw.summary.trim() : '';
      const summary = summaryRaw
        ? summaryRaw.slice(0, 320)
        : `Батч ${Number.isFinite(Number(batch && batch.index)) ? Number(batch.index) + 1 : '?'} переведён: ${translatedCount}/${batchSize} блоков`;
      const qualityRaw = typeof raw.quality === 'string' ? raw.quality.trim().toLowerCase() : '';
      const quality = qualityRaw === 'needs_review'
        || qualityRaw === 'review'
        || qualityRaw === 'warn'
        || qualityRaw === 'error'
        ? 'needs_review'
        : 'ok';
      const notesRaw = Array.isArray(raw.notes)
        ? raw.notes
        : (typeof raw.notes === 'string' && raw.notes ? [raw.notes] : []);
      const notes = notesRaw
        .map((item) => this._sanitizeReportText(String(item || ''), 180))
        .filter(Boolean)
        .slice(0, 8);
      const meta = this._sanitizeReportMeta(raw && raw.meta && typeof raw.meta === 'object' ? raw.meta : {});
      return {
        summary,
        quality,
        notes,
        meta
      };
    }

    _sanitizeReportToken(value, fallback) {
      const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
      const clean = raw.replace(/[^a-z0-9_.-]+/g, '');
      return clean || fallback || 'note';
    }

    _sanitizeReportText(value, maxLen) {
      const raw = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      const limit = Number.isFinite(Number(maxLen)) ? Math.max(1, Number(maxLen)) : 240;
      if (!raw) {
        return '';
      }
      return raw.slice(0, limit);
    }

    _sanitizeReportMeta(meta) {
      if (!meta || typeof meta !== 'object') {
        return {};
      }
      const out = {};
      const keys = Object.keys(meta).slice(0, 20);
      keys.forEach((key) => {
        if (!key) {
          return;
        }
        const raw = meta[key];
        if (raw === null || raw === undefined) {
          out[key] = raw;
          return;
        }
        if (typeof raw === 'number' || typeof raw === 'boolean') {
          out[key] = raw;
          return;
        }
        if (typeof raw === 'string') {
          out[key] = this._sanitizeReportText(raw, 240);
          return;
        }
        if (Array.isArray(raw)) {
          out[key] = raw
            .slice(0, 20)
            .map((item) => (typeof item === 'string' ? this._sanitizeReportText(item, 160) : item))
            .filter((item) => item !== undefined);
          return;
        }
        if (typeof raw === 'object') {
          try {
            out[key] = JSON.parse(JSON.stringify(raw));
          } catch (_) {
            out[key] = String(raw);
          }
        }
      });
      return out;
    }

    _pushBounded(list, value, max) {
      const out = Array.isArray(list) ? list.slice() : [];
      out.push(value);
      return out.slice(-(max || 100));
    }

    _extractOutputText(rawJson) {
      if (rawJson && typeof rawJson.output_text === 'string' && rawJson.output_text) {
        return rawJson.output_text;
      }
      if (!rawJson || !Array.isArray(rawJson.output)) {
        return '';
      }
      for (const outputItem of rawJson.output) {
        if (!outputItem || !Array.isArray(outputItem.content)) {
          continue;
        }
        for (const contentItem of outputItem.content) {
          if (contentItem && typeof contentItem.text === 'string' && contentItem.text) {
            return contentItem.text;
          }
        }
      }
      return '';
    }

    _parseJsonBlock(text) {
      if (typeof text !== 'string' || !text.trim()) {
        return null;
      }
      const raw = text.trim();
      try {
        return JSON.parse(raw);
      } catch (_) {
        // fallthrough
      }
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (fenced && fenced[1]) {
        try {
          return JSON.parse(fenced[1].trim());
        } catch (_) {
          return null;
        }
      }
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          return JSON.parse(raw.slice(start, end + 1));
        } catch (_) {
          return null;
        }
      }
      return null;
    }

    _isToolEnabled(mode) {
      return mode === 'on' || mode === 'auto';
    }

    _clampBatchSize(value) {
      const numeric = Number.isFinite(Number(value)) ? Number(value) : 8;
      return Math.max(1, Math.round(numeric));
    }
  }

  NT.TranslationAgent = TranslationAgent;
  NT.TranslationAgentDefaults = {
    TOOL_KEYS,
    DEFAULT_TOOL_CONFIG,
    PROFILE_PRESETS,
    DEFAULT_AGENT_TUNING,
    CATEGORY_GROUPS,
    KNOWN_CATEGORIES
  };
})(globalThis);
