/**
 * Debounced settings persistence adapter for UI/state modules.
 *
 * Besides plain get/set helpers, store now owns schema-v2 migration and
 * effective-settings derivation via `AgentSettingsPolicy`.
 */
(function initSettingsStore(global) {
  const NT = global.NT || (global.NT = {});
  const Policy = NT.AgentSettingsPolicy || null;

  class SettingsStore extends NT.ChromeLocalStoreBase {
    constructor({ chromeApi, defaults = {}, sanitize = null, debounceMs = 400 } = {}) {
      super({ chromeApi });
      this.defaults = {
        settingsSchemaVersion: Policy ? Policy.SCHEMA_VERSION : 2,
        translationAgentSettingsV2: Policy && Policy.DEFAULT_USER_SETTINGS
          ? this._cloneJson(Policy.DEFAULT_USER_SETTINGS, null)
          : null,
        ...defaults
      };
      this.sanitize = typeof sanitize === 'function' ? sanitize : null;
      this.debounceMs = debounceMs;
      this.pendingPatch = {};
      this.saveTimer = null;
    }

    async get(keys) {
      const fallback = this.applyDefaults({}, keys);
      const data = await this.storageGet(fallback);
      const merged = this.applyDefaults(data || {}, keys);
      return this.applySanitize(merged);
    }

    set(payload) {
      return this.storageSet(payload);
    }

    async ensureMigrated({ legacySettings } = {}) {
      if (!Policy) {
        return { schemaVersion: 1, migrated: false };
      }
      const full = await this.storageGet(null);
      const schemaVersion = Number(full && full.settingsSchemaVersion);
      const hasV2 = Boolean(full && full.translationAgentSettingsV2 && typeof full.translationAgentSettingsV2 === 'object');
      if (schemaVersion >= Policy.SCHEMA_VERSION && hasV2) {
        return { schemaVersion, migrated: false };
      }

      const modelList = Array.isArray(full && full.translationModelList) ? full.translationModelList : [];
      const migrated = Policy.migrateLegacy(full, {
        legacyLocal: legacySettings && typeof legacySettings === 'object' ? legacySettings : null,
        modelList
      });
      const resolved = Policy.getEffectiveSettings(migrated, { modelList });
      const payload = {
        settingsSchemaVersion: Policy.SCHEMA_VERSION,
        translationAgentSettingsV2: migrated,
        translationAgentProfile: resolved.effective && resolved.effective.legacyProjection
          ? resolved.effective.legacyProjection.translationAgentProfile
          : 'auto',
        translationAgentTools: resolved.effective && resolved.effective.legacyProjection
          ? resolved.effective.legacyProjection.translationAgentTools
          : {},
        translationAgentExecutionMode: resolved.effective && resolved.effective.legacyProjection
          ? resolved.effective.legacyProjection.translationAgentExecutionMode
          : 'agent',
        translationAgentAllowedModels: resolved.effective && resolved.effective.legacyProjection
          ? resolved.effective.legacyProjection.translationAgentAllowedModels
          : [],
        translationMemoryEnabled: resolved.effective && resolved.effective.legacyProjection
          ? resolved.effective.legacyProjection.translationMemoryEnabled !== false
          : true,
        translationMemoryMaxPages: resolved.effective && resolved.effective.legacyProjection
          ? Number(resolved.effective.legacyProjection.translationMemoryMaxPages || 200)
          : 200,
        translationMemoryMaxBlocks: resolved.effective && resolved.effective.legacyProjection
          ? Number(resolved.effective.legacyProjection.translationMemoryMaxBlocks || 5000)
          : 5000,
        translationMemoryMaxAgeDays: resolved.effective && resolved.effective.legacyProjection
          ? Number(resolved.effective.legacyProjection.translationMemoryMaxAgeDays || 30)
          : 30,
        translationMemoryGcOnStartup: resolved.effective && resolved.effective.legacyProjection
          ? resolved.effective.legacyProjection.translationMemoryGcOnStartup !== false
          : true,
        translationMemoryIgnoredQueryParams: resolved.effective && resolved.effective.legacyProjection
          ? (Array.isArray(resolved.effective.legacyProjection.translationMemoryIgnoredQueryParams)
            ? resolved.effective.legacyProjection.translationMemoryIgnoredQueryParams.slice()
            : ['utm_*', 'fbclid', 'gclid'])
          : ['utm_*', 'fbclid', 'gclid'],
        translationApiCacheEnabled: resolved.effective && resolved.effective.legacyProjection
          ? resolved.effective.legacyProjection.translationApiCacheEnabled !== false
          : true
      };
      await this.storageSet(payload);
      return { schemaVersion: Policy.SCHEMA_VERSION, migrated: true };
    }

    async getResolvedSettings({ legacySettings } = {}) {
      await this.ensureMigrated({ legacySettings });
      if (!Policy) {
        return {
          schemaVersion: 1,
          userSettings: null,
          effectiveSettings: null,
          overrides: { changed: [], values: {} }
        };
      }
      const full = await this.storageGet(null);
      const modelList = Array.isArray(full && full.translationModelList) ? full.translationModelList : [];
      const userSettings = Policy.normalizeUserSettings(full && full.translationAgentSettingsV2, { modelList });
      const resolved = Policy.getEffectiveSettings(userSettings, { modelList });
      return {
        schemaVersion: Policy.SCHEMA_VERSION,
        userSettings,
        effectiveSettings: resolved.effective,
        overrides: resolved.overrides || { changed: [], values: {} }
      };
    }

    async applySettingsPatch({ patch, expectedSchemaVersion = null, legacySettings = null } = {}) {
      if (!Policy) {
        return { ok: false, error: { code: 'SETTINGS_POLICY_MISSING', message: 'Agent settings policy unavailable' } };
      }
      const resolved = await this.getResolvedSettings({ legacySettings });
      const currentVersion = Number.isFinite(Number(resolved.schemaVersion))
        ? Number(resolved.schemaVersion)
        : Policy.SCHEMA_VERSION;
      if (
        expectedSchemaVersion !== null
        && expectedSchemaVersion !== undefined
        && Number(expectedSchemaVersion) !== currentVersion
      ) {
        return {
          ok: false,
          error: {
            code: 'SETTINGS_SCHEMA_MISMATCH',
            message: `Expected schema ${expectedSchemaVersion}, actual ${currentVersion}`,
            actualSchemaVersion: currentVersion
          }
        };
      }
      const srcPatch = patch && typeof patch === 'object' ? patch : {};
      const explicitUserPatch = srcPatch.userSettings && typeof srcPatch.userSettings === 'object'
        ? srcPatch.userSettings
        : {};
      const legacyUserPatch = this._legacyPatchToUserPatch(srcPatch);
      const userPatch = {
        ...legacyUserPatch,
        ...explicitUserPatch
      };

      let nextUserSettings = null;
      try {
        nextUserSettings = Policy.applyUserPatch(
          resolved.userSettings,
          userPatch,
          {
            modelList: Array.isArray(srcPatch.translationModelList)
              ? srcPatch.translationModelList
              : undefined
          }
        );
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'SETTINGS_VALIDATION_FAILED',
            message: error && error.message ? error.message : 'settings patch validation failed'
          }
        };
      }

      const topLevelPatch = this._sanitizeTopLevelPatch(srcPatch);
      const modelList = Array.isArray(topLevelPatch.translationModelList)
        ? topLevelPatch.translationModelList
        : (await this.get(['translationModelList'])).translationModelList;
      const recalculated = Policy.getEffectiveSettings(nextUserSettings, {
        modelList: Array.isArray(modelList) ? modelList : []
      });
      const payload = {
        settingsSchemaVersion: Policy.SCHEMA_VERSION,
        translationAgentSettingsV2: nextUserSettings,
        translationAgentProfile: recalculated.effective && recalculated.effective.legacyProjection
          ? recalculated.effective.legacyProjection.translationAgentProfile
          : 'auto',
        translationAgentTools: recalculated.effective && recalculated.effective.legacyProjection
          ? recalculated.effective.legacyProjection.translationAgentTools
          : {},
        translationAgentExecutionMode: recalculated.effective && recalculated.effective.legacyProjection
          ? recalculated.effective.legacyProjection.translationAgentExecutionMode
          : 'agent',
        translationAgentAllowedModels: recalculated.effective && recalculated.effective.legacyProjection
          ? recalculated.effective.legacyProjection.translationAgentAllowedModels
          : [],
        translationMemoryEnabled: recalculated.effective && recalculated.effective.legacyProjection
          ? recalculated.effective.legacyProjection.translationMemoryEnabled !== false
          : true,
        translationMemoryMaxPages: recalculated.effective && recalculated.effective.legacyProjection
          ? Number(recalculated.effective.legacyProjection.translationMemoryMaxPages || 200)
          : 200,
        translationMemoryMaxBlocks: recalculated.effective && recalculated.effective.legacyProjection
          ? Number(recalculated.effective.legacyProjection.translationMemoryMaxBlocks || 5000)
          : 5000,
        translationMemoryMaxAgeDays: recalculated.effective && recalculated.effective.legacyProjection
          ? Number(recalculated.effective.legacyProjection.translationMemoryMaxAgeDays || 30)
          : 30,
        translationMemoryGcOnStartup: recalculated.effective && recalculated.effective.legacyProjection
          ? recalculated.effective.legacyProjection.translationMemoryGcOnStartup !== false
          : true,
        translationMemoryIgnoredQueryParams: recalculated.effective && recalculated.effective.legacyProjection
          ? (Array.isArray(recalculated.effective.legacyProjection.translationMemoryIgnoredQueryParams)
            ? recalculated.effective.legacyProjection.translationMemoryIgnoredQueryParams.slice()
            : ['utm_*', 'fbclid', 'gclid'])
          : ['utm_*', 'fbclid', 'gclid'],
        translationApiCacheEnabled: recalculated.effective && recalculated.effective.legacyProjection
          ? recalculated.effective.legacyProjection.translationApiCacheEnabled !== false
          : true,
        ...topLevelPatch
      };
      await this.storageSet(payload);
      return {
        ok: true,
        schemaVersion: Policy.SCHEMA_VERSION,
        userSettings: nextUserSettings,
        effectiveSettings: recalculated.effective,
        overrides: recalculated.overrides || { changed: [], values: {} }
      };
    }

    async getPublicSnapshot({ legacySettings } = {}) {
      const resolved = await this.getResolvedSettings({ legacySettings });
      const data = await this.get([
        'apiKey',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationAgentModelPolicy',
        'translationPipelineEnabled',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationAgentExecutionMode',
        'translationAgentAllowedModels',
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
        'translationPopupActiveTab',
        'translationVisibilityByTab',
        'translationDisplayModeByTab',
        'translationCompareDiffThreshold',
        'debugAllowTestCommands'
      ]);
      const apiKey = typeof data.apiKey === 'string' ? data.apiKey : '';
      const compareDiffThreshold = Number.isFinite(Number(data.translationCompareDiffThreshold))
        ? Math.max(500, Math.min(50000, Math.round(Number(data.translationCompareDiffThreshold))))
        : 8000;
      return {
        hasApiKey: Boolean(apiKey),
        apiKeyLength: apiKey.length,
        schemaVersion: resolved.schemaVersion,
        userSettings: resolved.userSettings,
        effectiveSettings: resolved.effectiveSettings,
        overrides: resolved.overrides,
        translationModelList: Array.isArray(data.translationModelList) ? data.translationModelList : [],
        modelSelection: data.modelSelection || null,
        modelSelectionPolicy: data.modelSelectionPolicy || null,
        translationAgentModelPolicy: data.translationAgentModelPolicy || null,
        translationPipelineEnabled: Boolean(data.translationPipelineEnabled),
        translationAgentProfile: data.translationAgentProfile || 'auto',
        translationAgentTools: data.translationAgentTools && typeof data.translationAgentTools === 'object'
          ? data.translationAgentTools
          : {},
        translationAgentTuning: data.translationAgentTuning && typeof data.translationAgentTuning === 'object'
          ? data.translationAgentTuning
          : {},
        translationAgentExecutionMode: data.translationAgentExecutionMode === 'legacy' ? 'legacy' : 'agent',
        translationAgentAllowedModels: Array.isArray(data.translationAgentAllowedModels)
          ? data.translationAgentAllowedModels
          : [],
        translationCategoryMode: data.translationCategoryMode || 'auto',
        translationCategoryList: Array.isArray(data.translationCategoryList) ? data.translationCategoryList : [],
        translationMemoryEnabled: data.translationMemoryEnabled !== false,
        translationMemoryMaxPages: Number.isFinite(Number(data.translationMemoryMaxPages))
          ? Number(data.translationMemoryMaxPages)
          : 200,
        translationMemoryMaxBlocks: Number.isFinite(Number(data.translationMemoryMaxBlocks))
          ? Number(data.translationMemoryMaxBlocks)
          : 5000,
        translationMemoryMaxAgeDays: Number.isFinite(Number(data.translationMemoryMaxAgeDays))
          ? Number(data.translationMemoryMaxAgeDays)
          : 30,
        translationMemoryGcOnStartup: data.translationMemoryGcOnStartup !== false,
        translationMemoryIgnoredQueryParams: Array.isArray(data.translationMemoryIgnoredQueryParams)
          ? data.translationMemoryIgnoredQueryParams
          : ['utm_*', 'fbclid', 'gclid'],
        translationPageCacheEnabled: data.translationPageCacheEnabled !== false,
        translationApiCacheEnabled: data.translationApiCacheEnabled !== false,
        translationPopupActiveTab: data.translationPopupActiveTab || 'control',
        translationVisibilityByTab: data.translationVisibilityByTab && typeof data.translationVisibilityByTab === 'object'
          ? data.translationVisibilityByTab
          : {},
        translationDisplayModeByTab: data.translationDisplayModeByTab && typeof data.translationDisplayModeByTab === 'object'
          ? data.translationDisplayModeByTab
          : {},
        translationCompareDiffThreshold: compareDiffThreshold,
        debugAllowTestCommands: data.debugAllowTestCommands === true
      };
    }

    queuePatch(patch, { finalize } = {}) {
      Object.assign(this.pendingPatch, patch);

      if (this.saveTimer) {
        global.clearTimeout(this.saveTimer);
      }

      this.saveTimer = global.setTimeout(() => {
        const payload = { ...this.pendingPatch };
        this.pendingPatch = {};

        if (typeof finalize === 'function') {
          finalize(payload);
        }

        this.set(payload);
      }, this.debounceMs);
    }

    applyDefaults(payload, keys) {
      const defaults = {};
      const keyList = Array.isArray(keys) ? keys : Object.keys(this.defaults || {});
      keyList.forEach((key) => {
        if (this.defaults && Object.prototype.hasOwnProperty.call(this.defaults, key)) {
          defaults[key] = this.defaults[key];
        }
      });
      return { ...defaults, ...(payload || {}) };
    }

    applySanitize(payload) {
      return this.sanitize ? this.sanitize(payload) : payload;
    }

    _sanitizeTopLevelPatch(patch) {
      const src = patch && typeof patch === 'object' ? patch : {};
      const out = {};
      const allow = [
        'apiKey',
        'translationModelList',
        'modelSelection',
        'modelSelectionPolicy',
        'translationAgentModelPolicy',
        'translationAgentProfile',
        'translationAgentTools',
        'translationAgentTuning',
        'translationAgentExecutionMode',
        'translationAgentAllowedModels',
        'translationPipelineEnabled',
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
        'translationPopupActiveTab',
        'translationVisibilityByTab',
        'translationDisplayModeByTab',
        'translationCompareDiffThreshold',
        'debugAllowTestCommands'
      ];
      allow.forEach((key) => {
        if (!Object.prototype.hasOwnProperty.call(src, key)) {
          return;
        }
        out[key] = src[key];
      });
      if (Object.prototype.hasOwnProperty.call(out, 'translationCompareDiffThreshold')) {
        const value = Number(out.translationCompareDiffThreshold);
        out.translationCompareDiffThreshold = Number.isFinite(value)
          ? Math.max(500, Math.min(50000, Math.round(value)))
          : 8000;
      }
      return out;
    }

    _legacyPatchToUserPatch(patch) {
      const src = patch && typeof patch === 'object' ? patch : {};
      const out = {};
      const legacyToolMap = {
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
        workflowController: ['agent.set_tool_config', 'agent.update_checklist']
      };
      const mapProfile = (value) => {
        const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
        if (!raw) {
          return null;
        }
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
        return null;
      };
      const profile = mapProfile(src.translationAgentProfile);
      if (profile) {
        out.profile = profile;
      }
      if (src.translationAgentExecutionMode === 'agent' || src.translationAgentExecutionMode === 'legacy') {
        out.agent = out.agent || {};
        out.agent.agentMode = src.translationAgentExecutionMode;
      }
      if (Array.isArray(src.translationAgentAllowedModels)) {
        out.models = out.models || {};
        out.models.agentAllowedModels = src.translationAgentAllowedModels;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationApiCacheEnabled')) {
        out.caching = out.caching || {};
        out.caching.compatCache = src.translationApiCacheEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationMemoryEnabled')
        || Object.prototype.hasOwnProperty.call(src, 'translationMemoryMaxPages')
        || Object.prototype.hasOwnProperty.call(src, 'translationMemoryMaxBlocks')
        || Object.prototype.hasOwnProperty.call(src, 'translationMemoryMaxAgeDays')
        || Object.prototype.hasOwnProperty.call(src, 'translationMemoryGcOnStartup')
        || Object.prototype.hasOwnProperty.call(src, 'translationMemoryIgnoredQueryParams')) {
        out.memory = out.memory || {};
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationMemoryEnabled')) {
        out.memory.enabled = src.translationMemoryEnabled !== false;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationMemoryMaxPages')) {
        out.memory.maxPages = src.translationMemoryMaxPages;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationMemoryMaxBlocks')) {
        out.memory.maxBlocks = src.translationMemoryMaxBlocks;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationMemoryMaxAgeDays')) {
        out.memory.maxAgeDays = src.translationMemoryMaxAgeDays;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationMemoryGcOnStartup')) {
        out.memory.gcOnStartup = src.translationMemoryGcOnStartup !== false;
      }
      if (Object.prototype.hasOwnProperty.call(src, 'translationMemoryIgnoredQueryParams')) {
        out.memory.ignoredQueryParams = src.translationMemoryIgnoredQueryParams;
      }
      if (src.translationAgentTools && typeof src.translationAgentTools === 'object') {
        out.agent = out.agent || {};
        out.agent.toolConfigUser = out.agent.toolConfigUser && typeof out.agent.toolConfigUser === 'object'
          ? out.agent.toolConfigUser
          : {};
        Object.keys(src.translationAgentTools).forEach((legacyKey) => {
          const mode = src.translationAgentTools[legacyKey];
          if (mode !== 'on' && mode !== 'off' && mode !== 'auto') {
            return;
          }
          const mapped = legacyToolMap[legacyKey];
          if (!Array.isArray(mapped)) {
            return;
          }
          mapped.forEach((toolName) => {
            out.agent.toolConfigUser[toolName] = mode;
          });
        });
      }
      return out;
    }

    _cloneJson(value, fallback) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }
  }

  NT.SettingsStore = SettingsStore;
})(globalThis);
