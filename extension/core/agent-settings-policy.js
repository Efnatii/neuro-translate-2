/**
 * Centralized policy for Translation Agent settings schema v2.
 *
 * Responsibilities:
 * - Validate and normalize user settings.
 * - Migrate legacy flat keys to v2 grouped schema.
 * - Derive effective settings from profile defaults + user overrides.
 */
(function initAgentSettingsPolicy(global) {
  const NT = global.NT || (global.NT = {});

  const SCHEMA_VERSION = 2;

  const PROFILE_IDS = Object.freeze([
    'auto',
    'fast',
    'balanced',
    'bulk',
    'accurate',
    'research',
    'custom'
  ]);

  const TOOL_KEYS = Object.freeze([
    'page.get_stats',
    'page.get_blocks',
    'agent.set_tool_config',
    'agent.propose_tool_policy',
    'agent.get_tool_context',
    'agent.get_autotune_context',
    'agent.propose_run_settings_patch',
    'agent.apply_run_settings_proposal',
    'agent.reject_run_settings_proposal',
    'agent.explain_current_run_settings',
    'agent.set_plan',
    'agent.set_recommended_categories',
    'agent.append_report',
    'agent.update_checklist',
    'agent.compress_context',
    'job.get_next_blocks',
    'translator.translate_block_stream',
    'page.apply_delta',
    'job.mark_block_done',
    'job.mark_block_failed',
    'agent.audit_progress',
    'memory.build_glossary',
    'memory.update_context_summary'
  ]);

  const TOOL_MODE_VALUES = Object.freeze(['on', 'off', 'auto']);
  const AGENT_MODE_VALUES = Object.freeze(['agent', 'legacy']);
  const REASONING_MODE_VALUES = Object.freeze(['auto', 'custom']);
  const REASONING_EFFORT_VALUES = Object.freeze(['minimal', 'low', 'medium', 'high', 'max']);
  const REASONING_SUMMARY_VALUES = Object.freeze(['auto', 'none', 'short', 'detailed']);
  const CACHE_RETENTION_VALUES = Object.freeze(['auto', 'in_memory', 'extended', 'disabled']);
  const ROUTING_MODE_VALUES = Object.freeze(['auto', 'user_priority', 'profile_priority']);
  const UI_LANG_VALUES = Object.freeze(['ru']);
  const DEFAULT_MEMORY_IGNORED_QUERY_PARAMS = Object.freeze(['utm_*', 'fbclid', 'gclid']);

  const LEGACY_PROFILE_MAP = Object.freeze({
    auto: 'auto',
    balanced: 'balanced',
    literal: 'accurate',
    readable: 'bulk',
    technical: 'research'
  });

  const PROFILE_TO_LEGACY = Object.freeze({
    auto: 'auto',
    fast: 'readable',
    balanced: 'balanced',
    bulk: 'readable',
    accurate: 'technical',
    research: 'technical',
    custom: 'balanced'
  });

  const LEGACY_TOOL_MAP = Object.freeze({
    pageAnalyzer: ['page.get_stats', 'page.get_blocks'],
    categorySelector: ['agent.set_recommended_categories'],
    glossaryBuilder: ['translator.translate_block_stream'],
    batchPlanner: ['agent.set_plan'],
    modelRouter: ['translator.translate_block_stream'],
    progressAuditor: ['agent.audit_progress'],
    antiRepeatGuard: ['agent.audit_progress'],
    contextCompressor: ['agent.compress_context'],
    reportWriter: ['agent.append_report'],
    pageRuntime: ['page.apply_delta'],
    cacheManager: ['job.get_next_blocks'],
    workflowController: [
      'agent.set_tool_config',
      'agent.propose_tool_policy',
      'agent.get_tool_context',
      'agent.get_autotune_context',
      'agent.propose_run_settings_patch',
      'agent.apply_run_settings_proposal',
      'agent.reject_run_settings_proposal',
      'agent.explain_current_run_settings',
      'agent.update_checklist'
    ]
  });

  const LEGACY_TOOL_DEFAULTS = Object.freeze({
    pageAnalyzer: 'on',
    categorySelector: 'auto',
    glossaryBuilder: 'auto',
    batchPlanner: 'auto',
    modelRouter: 'auto',
    progressAuditor: 'on',
    antiRepeatGuard: 'on',
    contextCompressor: 'auto',
    reportWriter: 'on',
    pageRuntime: 'on',
    cacheManager: 'auto',
    workflowController: 'on'
  });

  const PROFILE_DEFAULTS = Object.freeze({
    auto: {
      agentMode: 'agent',
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      promptCacheRetention: 'auto',
      compatCache: true,
      modelRoutingMode: 'auto',
      modelProfilePriority: ['gpt-5-mini:standard', 'gpt-4.1-mini:standard', 'o4-mini:standard'],
      toolConfigDefault: {
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
        'memory.update_context_summary': 'auto'
      }
    },
    fast: {
      agentMode: 'agent',
      reasoningEffort: 'low',
      reasoningSummary: 'short',
      promptCacheRetention: 'in_memory',
      compatCache: true,
      modelRoutingMode: 'auto',
      modelProfilePriority: ['gpt-4.1-mini:standard', 'gpt-4o-mini:standard', 'gpt-5-nano:standard'],
      toolConfigDefault: {
        'agent.audit_progress': 'auto',
        'agent.compress_context': 'auto'
      }
    },
    balanced: {
      agentMode: 'agent',
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      promptCacheRetention: 'auto',
      compatCache: true,
      modelRoutingMode: 'auto',
      modelProfilePriority: ['gpt-5-mini:standard', 'gpt-4.1-mini:standard', 'o4-mini:standard'],
      toolConfigDefault: {}
    },
    bulk: {
      agentMode: 'agent',
      reasoningEffort: 'minimal',
      reasoningSummary: 'none',
      promptCacheRetention: 'extended',
      compatCache: true,
      modelRoutingMode: 'profile_priority',
      modelProfilePriority: ['gpt-5-nano:standard', 'gpt-4.1-mini:standard', 'gpt-4o-mini:standard'],
      toolConfigDefault: {
        'agent.compress_context': 'on',
        'agent.audit_progress': 'auto'
      }
    },
    accurate: {
      agentMode: 'agent',
      reasoningEffort: 'high',
      reasoningSummary: 'detailed',
      promptCacheRetention: 'auto',
      compatCache: true,
      modelRoutingMode: 'profile_priority',
      modelProfilePriority: ['gpt-5:standard', 'o3:standard', 'gpt-4.1:standard'],
      toolConfigDefault: {
        'agent.audit_progress': 'on',
        'agent.compress_context': 'auto'
      }
    },
    research: {
      agentMode: 'agent',
      reasoningEffort: 'max',
      reasoningSummary: 'detailed',
      promptCacheRetention: 'extended',
      compatCache: true,
      modelRoutingMode: 'profile_priority',
      modelProfilePriority: ['o3:standard', 'gpt-5:standard', 'o4-mini:standard'],
      toolConfigDefault: {
        'agent.audit_progress': 'on',
        'agent.compress_context': 'on'
      }
    },
    custom: {
      agentMode: 'agent',
      reasoningEffort: 'medium',
      reasoningSummary: 'auto',
      promptCacheRetention: 'auto',
      compatCache: true,
      modelRoutingMode: 'auto',
      modelProfilePriority: ['gpt-5-mini:standard', 'gpt-4.1-mini:standard', 'o4-mini:standard'],
      toolConfigDefault: {}
    }
  });

  const DEFAULT_USER_SETTINGS = Object.freeze({
    profile: 'auto',
    agent: {
      agentMode: 'agent',
      toolConfigUser: {}
    },
    reasoning: {
      reasoningMode: 'auto',
      reasoningEffort: 'medium',
      reasoningSummary: 'auto'
    },
    caching: {
      promptCacheRetention: 'auto',
      promptCacheKey: null,
      compatCache: true
    },
    models: {
      agentAllowedModels: [],
      modelRoutingMode: 'auto',
      modelUserPriority: []
    },
    memory: {
      enabled: true,
      maxPages: 200,
      maxBlocks: 5000,
      maxAgeDays: 30,
      gcOnStartup: true,
      ignoredQueryParams: DEFAULT_MEMORY_IGNORED_QUERY_PARAMS.slice()
    },
    ui: {
      uiLanguage: 'ru',
      showAdvanced: false,
      collapseState: {}
    }
  });

  function cloneJson(value, fallback) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function normalizeEnum(value, allowed, fallback) {
    const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return allowed.includes(raw) ? raw : fallback;
  }

  function normalizeModelList(list) {
    const source = Array.isArray(list) ? list : [];
    const out = [];
    source.forEach((item) => {
      const spec = typeof item === 'string' ? item.trim() : '';
      if (!spec || out.includes(spec)) {
        return;
      }
      out.push(spec);
    });
    return out;
  }

  function normalizeToolConfig(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    TOOL_KEYS.forEach((toolKey) => {
      const mode = src[toolKey];
      if (TOOL_MODE_VALUES.includes(mode)) {
        out[toolKey] = mode;
      }
    });
    return out;
  }

  function normalizeCollapseState(input) {
    const src = input && typeof input === 'object' ? input : {};
    const out = {};
    Object.keys(src).slice(0, 80).forEach((key) => {
      const section = typeof key === 'string' ? key.trim() : '';
      if (!section) {
        return;
      }
      out[section] = Boolean(src[key]);
    });
    return out;
  }

  function normalizeBoundedInteger(value, fallback, { min, max = null } = {}) {
    if (!Number.isFinite(Number(value))) {
      return fallback;
    }
    const numeric = Math.round(Number(value));
    const minApplied = Number.isFinite(Number(min)) ? Math.max(Number(min), numeric) : numeric;
    if (!Number.isFinite(Number(max))) {
      return minApplied;
    }
    return Math.min(Number(max), minApplied);
  }

  function normalizeIgnoredQueryParams(input) {
    const source = Array.isArray(input) ? input : DEFAULT_MEMORY_IGNORED_QUERY_PARAMS;
    const out = [];
    source.forEach((item) => {
      const token = typeof item === 'string' ? item.trim().toLowerCase() : '';
      if (!token || out.includes(token)) {
        return;
      }
      out.push(token);
    });
    return out.length ? out : DEFAULT_MEMORY_IGNORED_QUERY_PARAMS.slice();
  }

  function normalizeUserSettings(input, { modelList = [] } = {}) {
    const src = input && typeof input === 'object' ? input : {};
    const normalizedProfile = normalizeEnum(src.profile, PROFILE_IDS, DEFAULT_USER_SETTINGS.profile);
    const agent = src.agent && typeof src.agent === 'object' ? src.agent : {};
    const reasoning = src.reasoning && typeof src.reasoning === 'object' ? src.reasoning : {};
    const caching = src.caching && typeof src.caching === 'object' ? src.caching : {};
    const models = src.models && typeof src.models === 'object' ? src.models : {};
    const memory = src.memory && typeof src.memory === 'object' ? src.memory : {};
    const ui = src.ui && typeof src.ui === 'object' ? src.ui : {};

    const allowedModels = normalizeModelList(models.agentAllowedModels);
    const modelUserPriorityRaw = normalizeModelList(models.modelUserPriority);
    const modelUserPriority = allowedModels.length
      ? modelUserPriorityRaw.filter((spec) => allowedModels.includes(spec))
      : modelUserPriorityRaw;

    return {
      profile: normalizedProfile,
      agent: {
        agentMode: normalizeEnum(agent.agentMode, AGENT_MODE_VALUES, DEFAULT_USER_SETTINGS.agent.agentMode),
        toolConfigUser: normalizeToolConfig(agent.toolConfigUser)
      },
      reasoning: {
        reasoningMode: normalizeEnum(reasoning.reasoningMode, REASONING_MODE_VALUES, DEFAULT_USER_SETTINGS.reasoning.reasoningMode),
        reasoningEffort: normalizeEnum(reasoning.reasoningEffort, REASONING_EFFORT_VALUES, DEFAULT_USER_SETTINGS.reasoning.reasoningEffort),
        reasoningSummary: normalizeEnum(reasoning.reasoningSummary, REASONING_SUMMARY_VALUES, DEFAULT_USER_SETTINGS.reasoning.reasoningSummary)
      },
      caching: {
        promptCacheRetention: normalizeEnum(caching.promptCacheRetention, CACHE_RETENTION_VALUES, DEFAULT_USER_SETTINGS.caching.promptCacheRetention),
        promptCacheKey: typeof caching.promptCacheKey === 'string' && caching.promptCacheKey.trim()
          ? caching.promptCacheKey.trim().slice(0, 128)
          : null,
        compatCache: caching.compatCache !== false
      },
      models: {
        agentAllowedModels: allowedModels,
        modelRoutingMode: normalizeEnum(models.modelRoutingMode, ROUTING_MODE_VALUES, DEFAULT_USER_SETTINGS.models.modelRoutingMode),
        modelUserPriority
      },
      memory: {
        enabled: memory.enabled !== false,
        maxPages: normalizeBoundedInteger(memory.maxPages, DEFAULT_USER_SETTINGS.memory.maxPages, { min: 10, max: 5000 }),
        maxBlocks: normalizeBoundedInteger(memory.maxBlocks, DEFAULT_USER_SETTINGS.memory.maxBlocks, { min: 50, max: 100000 }),
        maxAgeDays: normalizeBoundedInteger(memory.maxAgeDays, DEFAULT_USER_SETTINGS.memory.maxAgeDays, { min: 1, max: 365 }),
        gcOnStartup: memory.gcOnStartup !== false,
        ignoredQueryParams: normalizeIgnoredQueryParams(memory.ignoredQueryParams)
      },
      ui: {
        uiLanguage: normalizeEnum(ui.uiLanguage, UI_LANG_VALUES, DEFAULT_USER_SETTINGS.ui.uiLanguage),
        showAdvanced: ui.showAdvanced === true,
        collapseState: normalizeCollapseState(ui.collapseState)
      },
      _meta: {
        availableModelCount: normalizeModelList(modelList).length
      }
    };
  }

  function mergeToolDefaults(profileDefaults) {
    const base = cloneJson(PROFILE_DEFAULTS.auto.toolConfigDefault, {});
    const src = profileDefaults && profileDefaults.toolConfigDefault && typeof profileDefaults.toolConfigDefault === 'object'
      ? profileDefaults.toolConfigDefault
      : {};
    Object.keys(src).forEach((toolKey) => {
      if (!TOOL_KEYS.includes(toolKey)) {
        return;
      }
      const mode = src[toolKey];
      if (TOOL_MODE_VALUES.includes(mode)) {
        base[toolKey] = mode;
      }
    });
    return base;
  }

  function addOverride(overrides, key, value) {
    if (!overrides || !Array.isArray(overrides.changed)) {
      return;
    }
    if (!overrides.changed.includes(key)) {
      overrides.changed.push(key);
    }
    overrides.values[key] = value;
  }

  function getEffectiveSettings(userSettings, { modelList = [] } = {}) {
    const normalized = normalizeUserSettings(userSettings, { modelList });
    const profileKey = PROFILE_IDS.includes(normalized.profile) ? normalized.profile : 'auto';
    const profileDefaults = PROFILE_DEFAULTS[profileKey] || PROFILE_DEFAULTS.auto;
    const mergedToolDefaults = mergeToolDefaults(profileDefaults);
    const overrides = { changed: [], values: {} };

    const reasoningMode = normalized.reasoning.reasoningMode;
    const reasoningEffort = reasoningMode === 'custom'
      ? normalized.reasoning.reasoningEffort
      : profileDefaults.reasoningEffort;
    const reasoningSummary = reasoningMode === 'custom'
      ? normalized.reasoning.reasoningSummary
      : profileDefaults.reasoningSummary;
    if (reasoningMode === 'custom') {
      addOverride(overrides, 'reasoning.reasoningEffort', reasoningEffort);
      addOverride(overrides, 'reasoning.reasoningSummary', reasoningSummary);
    }

    const promptCacheRetention = normalized.caching.promptCacheRetention === 'auto'
      ? profileDefaults.promptCacheRetention
      : normalized.caching.promptCacheRetention;
    if (normalized.caching.promptCacheRetention !== 'auto') {
      addOverride(overrides, 'caching.promptCacheRetention', normalized.caching.promptCacheRetention);
    }
    if (normalized.caching.promptCacheKey) {
      addOverride(overrides, 'caching.promptCacheKey', normalized.caching.promptCacheKey);
    }
    if (normalized.caching.compatCache !== profileDefaults.compatCache) {
      addOverride(overrides, 'caching.compatCache', normalized.caching.compatCache);
    }

    const modelRoutingMode = normalized.models.modelRoutingMode === 'auto'
      ? profileDefaults.modelRoutingMode
      : normalized.models.modelRoutingMode;
    if (normalized.models.modelRoutingMode !== 'auto') {
      addOverride(overrides, 'models.modelRoutingMode', normalized.models.modelRoutingMode);
    }

    const availableModels = normalizeModelList(modelList);
    const allowlist = normalized.models.agentAllowedModels.filter((spec) => !availableModels.length || availableModels.includes(spec));
    if (allowlist.length) {
      addOverride(overrides, 'models.agentAllowedModels', allowlist.slice());
    }
    const profilePriority = normalizeModelList(profileDefaults.modelProfilePriority);
    const modelUserPriority = normalized.models.modelUserPriority.filter((spec) => !allowlist.length || allowlist.includes(spec));
    if (modelUserPriority.length) {
      addOverride(overrides, 'models.modelUserPriority', modelUserPriority.slice());
    }

    const toolConfigUser = normalizeToolConfig(normalized.agent.toolConfigUser);
    const toolConfigEffective = { ...mergedToolDefaults };
    Object.keys(toolConfigUser).forEach((toolKey) => {
      toolConfigEffective[toolKey] = toolConfigUser[toolKey];
      addOverride(overrides, `agent.toolConfigUser.${toolKey}`, toolConfigUser[toolKey]);
    });

    const defaultAgentMode = profileDefaults.agentMode || 'agent';
    const agentMode = normalized.agent.agentMode || defaultAgentMode;
    if (agentMode !== defaultAgentMode) {
      addOverride(overrides, 'agent.agentMode', agentMode);
    }

    const effectiveProfile = overrides.changed.length && profileKey !== 'custom'
      ? 'custom'
      : profileKey;

    const legacyProfile = PROFILE_TO_LEGACY[effectiveProfile] || PROFILE_TO_LEGACY[profileKey] || 'auto';
    const legacyTools = { ...LEGACY_TOOL_DEFAULTS };
    Object.keys(LEGACY_TOOL_MAP).forEach((legacyKey) => {
      const related = LEGACY_TOOL_MAP[legacyKey];
      if (!Array.isArray(related) || !related.length) {
        return;
      }
      const forced = related
        .map((toolKey) => toolConfigEffective[toolKey])
        .filter((mode) => TOOL_MODE_VALUES.includes(mode));
      if (!forced.length) {
        return;
      }
      if (forced.some((mode) => mode === 'off')) {
        legacyTools[legacyKey] = 'off';
        return;
      }
      if (forced.some((mode) => mode === 'on')) {
        legacyTools[legacyKey] = 'on';
        return;
      }
      legacyTools[legacyKey] = 'auto';
    });

    const effective = {
      profile: profileKey,
      effectiveProfile,
      agent: {
        agentMode,
        toolConfigDefault: mergedToolDefaults,
        toolConfigUser,
        toolConfigEffective
      },
      reasoning: {
        reasoningMode,
        reasoningEffort: reasoningEffort || 'medium',
        reasoningSummary: reasoningSummary || 'auto'
      },
      caching: {
        promptCacheRetention: promptCacheRetention || 'auto',
        promptCacheKey: normalized.caching.promptCacheKey,
        compatCache: normalized.caching.compatCache !== false
      },
      models: {
        agentAllowedModels: allowlist.slice(),
        modelRoutingMode,
        modelUserPriority: modelUserPriority.slice(),
        modelProfilePriority: profilePriority
      },
      memory: {
        enabled: normalized.memory.enabled !== false,
        maxPages: normalized.memory.maxPages,
        maxBlocks: normalized.memory.maxBlocks,
        maxAgeDays: normalized.memory.maxAgeDays,
        gcOnStartup: normalized.memory.gcOnStartup !== false,
        ignoredQueryParams: normalizeIgnoredQueryParams(normalized.memory.ignoredQueryParams)
      },
      ui: {
        uiLanguage: normalized.ui.uiLanguage || 'ru',
        showAdvanced: normalized.ui.showAdvanced === true,
        collapseState: cloneJson(normalized.ui.collapseState, {})
      },
      legacyProjection: {
        translationAgentProfile: legacyProfile,
        translationAgentTools: legacyTools,
        translationAgentExecutionMode: agentMode,
        translationAgentAllowedModels: allowlist.slice(),
        translationApiCacheEnabled: normalized.caching.compatCache !== false,
        translationMemoryEnabled: normalized.memory.enabled !== false,
        translationMemoryMaxPages: normalized.memory.maxPages,
        translationMemoryMaxBlocks: normalized.memory.maxBlocks,
        translationMemoryMaxAgeDays: normalized.memory.maxAgeDays,
        translationMemoryGcOnStartup: normalized.memory.gcOnStartup !== false,
        translationMemoryIgnoredQueryParams: normalizeIgnoredQueryParams(normalized.memory.ignoredQueryParams)
      }
    };

    return { effective, overrides, normalizedUserSettings: normalized };
  }

  function migrateLegacy(rawSettings, { legacyLocal = null, modelList = [] } = {}) {
    const src = rawSettings && typeof rawSettings === 'object' ? rawSettings : {};
    const local = legacyLocal && typeof legacyLocal === 'object' ? legacyLocal : {};
    const fromV2 = src.translationAgentSettingsV2 && typeof src.translationAgentSettingsV2 === 'object'
      ? src.translationAgentSettingsV2
      : null;
    if (fromV2) {
      return normalizeUserSettings(fromV2, { modelList });
    }

    const legacyProfileRaw = String(
      src.translationAgentProfile
      || local.translationAgentProfile
      || DEFAULT_USER_SETTINGS.profile
    ).trim().toLowerCase();
    const migratedProfile = LEGACY_PROFILE_MAP[legacyProfileRaw] || DEFAULT_USER_SETTINGS.profile;

    const legacyTools = src.translationAgentTools && typeof src.translationAgentTools === 'object'
      ? src.translationAgentTools
      : {};
    const migratedToolConfig = {};
    Object.keys(LEGACY_TOOL_MAP).forEach((legacyKey) => {
      const mode = legacyTools[legacyKey];
      if (!TOOL_MODE_VALUES.includes(mode)) {
        return;
      }
      LEGACY_TOOL_MAP[legacyKey].forEach((toolKey) => {
        if (!TOOL_KEYS.includes(toolKey)) {
          return;
        }
        migratedToolConfig[toolKey] = mode;
      });
    });

    const base = cloneJson(DEFAULT_USER_SETTINGS, {});
    base.profile = migratedProfile;
    base.agent.agentMode = normalizeEnum(
      src.translationAgentExecutionMode || local.translationAgentExecutionMode,
      AGENT_MODE_VALUES,
      DEFAULT_USER_SETTINGS.agent.agentMode
    );
    base.agent.toolConfigUser = migratedToolConfig;
    base.caching.compatCache = src.translationApiCacheEnabled !== false;
    base.models.agentAllowedModels = normalizeModelList(
      src.translationAgentAllowedModels || local.translationAgentAllowedModels
    );
    base.memory.enabled = src.translationMemoryEnabled !== false;
    base.memory.maxPages = normalizeBoundedInteger(src.translationMemoryMaxPages, DEFAULT_USER_SETTINGS.memory.maxPages, { min: 10, max: 5000 });
    base.memory.maxBlocks = normalizeBoundedInteger(src.translationMemoryMaxBlocks, DEFAULT_USER_SETTINGS.memory.maxBlocks, { min: 50, max: 100000 });
    base.memory.maxAgeDays = normalizeBoundedInteger(src.translationMemoryMaxAgeDays, DEFAULT_USER_SETTINGS.memory.maxAgeDays, { min: 1, max: 365 });
    base.memory.gcOnStartup = src.translationMemoryGcOnStartup !== false;
    base.memory.ignoredQueryParams = normalizeIgnoredQueryParams(src.translationMemoryIgnoredQueryParams);

    return normalizeUserSettings(base, { modelList });
  }

  function applyUserPatch(userSettings, patch, { modelList = [] } = {}) {
    const current = normalizeUserSettings(userSettings, { modelList });
    const srcPatch = patch && typeof patch === 'object' ? patch : {};
    const merged = cloneJson(current, cloneJson(DEFAULT_USER_SETTINGS, {}));
    const applySection = (sectionName) => {
      if (!srcPatch[sectionName] || typeof srcPatch[sectionName] !== 'object') {
        return;
      }
      merged[sectionName] = {
        ...(merged[sectionName] && typeof merged[sectionName] === 'object' ? merged[sectionName] : {}),
        ...srcPatch[sectionName]
      };
    };
    if (Object.prototype.hasOwnProperty.call(srcPatch, 'profile')) {
      merged.profile = srcPatch.profile;
    }
    applySection('agent');
    applySection('reasoning');
    applySection('caching');
    applySection('models');
    applySection('memory');
    applySection('ui');
    return normalizeUserSettings(merged, { modelList });
  }

  NT.AgentSettingsPolicy = {
    SCHEMA_VERSION,
    PROFILE_IDS,
    TOOL_KEYS,
    DEFAULT_USER_SETTINGS,
    PROFILE_DEFAULTS,
    normalizeUserSettings,
    migrateLegacy,
    getEffectiveSettings,
    applyUserPatch
  };
})(globalThis);
