/**
 * AutoTune run-settings patch validator.
 *
 * Validates structural correctness only (no semantic translation limits).
 */
(function initRunSettingsValidator(global) {
  const NT = global.NT || (global.NT = {});

  const REASONING_EFFORT = new Set(['minimal', 'low', 'medium', 'high', 'max']);
  const REASONING_SUMMARY = new Set(['auto', 'none', 'short', 'detailed']);
  const ROUTING_MODE = new Set(['auto', 'user_priority', 'profile_priority']);
  const TOOL_MODE = new Set(['on', 'off', 'auto']);
  const CACHE_RETENTION = new Set(['auto', 'in_memory', 'extended', 'disabled']);
  const TRUNCATION = new Set(['auto', 'disabled']);
  const STYLE = new Set(['auto', 'literal', 'readable', 'technical', 'balanced']);

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  class RunSettingsValidator {
    validateAndNormalize({ patch, context } = {}) {
      const src = isObject(patch) ? patch : {};
      const ctx = isObject(context) ? context : {};
      const warnings = [];
      const errors = [];
      const normalizedPatch = {};
      const allowedTop = ['reasoning', 'caching', 'tools', 'models', 'responses', 'translation'];

      Object.keys(src).forEach((key) => {
        if (!allowedTop.includes(key)) {
          errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: `Unknown patch section: ${key}` });
        }
      });

      if (isObject(src.reasoning)) {
        Object.keys(src.reasoning).forEach((key) => {
          if (key !== 'mode' && key !== 'effort' && key !== 'summary') {
            errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: `Unknown reasoning key: ${key}` });
          }
        });
        const out = {};
        if (src.reasoning.mode !== undefined) {
          out.mode = src.reasoning.mode === 'custom' ? 'custom' : 'auto';
        }
        if (src.reasoning.effort !== undefined) {
          const effort = String(src.reasoning.effort || '').trim().toLowerCase();
          if (REASONING_EFFORT.has(effort)) {
            out.effort = effort;
          } else {
            out.effort = 'medium';
            warnings.push({ code: 'REASONING_DOWNGRADE', message: 'Unknown reasoning.effort downgraded to medium' });
          }
        }
        if (src.reasoning.summary !== undefined) {
          const summary = String(src.reasoning.summary || '').trim().toLowerCase();
          if (REASONING_SUMMARY.has(summary)) {
            out.summary = summary;
          } else {
            out.summary = 'auto';
            warnings.push({ code: 'REASONING_DOWNGRADE', message: 'Unknown reasoning.summary downgraded to auto' });
          }
        }
        if (Object.keys(out).length) {
          normalizedPatch.reasoning = out;
        }
      }

      if (isObject(src.caching)) {
        Object.keys(src.caching).forEach((key) => {
          if (key !== 'promptCacheRetention' && key !== 'compatCache') {
            errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: `Unknown caching key: ${key}` });
          }
        });
        const out = {};
        if (src.caching.promptCacheRetention !== undefined) {
          const retention = String(src.caching.promptCacheRetention || '').trim().toLowerCase();
          if (!CACHE_RETENTION.has(retention)) {
            warnings.push({ code: 'CACHING_UNSUPPORTED', message: 'Unknown promptCacheRetention ignored' });
          } else if (ctx.promptCacheSupported === false) {
            warnings.push({ code: 'CACHING_UNSUPPORTED', message: 'prompt cache retention ignored for current provider' });
          } else {
            out.promptCacheRetention = retention;
          }
        }
        if (src.caching.compatCache !== undefined) {
          out.compatCache = src.caching.compatCache !== false;
        }
        if (Object.keys(out).length) {
          normalizedPatch.caching = out;
        }
      }

      if (isObject(src.models)) {
        Object.keys(src.models).forEach((key) => {
          if (key !== 'routingMode' && key !== 'userPriority' && key !== 'preferredRoute') {
            errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: `Unknown models key: ${key}` });
          }
        });
        const out = {};
        if (src.models.routingMode !== undefined) {
          const mode = String(src.models.routingMode || '').trim().toLowerCase();
          out.routingMode = ROUTING_MODE.has(mode) ? mode : 'auto';
        }
        if (src.models.userPriority !== undefined) {
          const list = Array.isArray(src.models.userPriority) ? src.models.userPriority : [];
          const allow = Array.isArray(ctx.allowlist) ? ctx.allowlist : [];
          const normalized = list
            .map((item) => (typeof item === 'string' ? item.trim() : ''))
            .filter((item, index, arr) => item && arr.indexOf(item) === index);
          const disallowed = allow.length ? normalized.filter((model) => !allow.includes(model)) : [];
          if (disallowed.length) {
            errors.push({
              code: 'MODEL_NOT_ALLOWED',
              message: `Model outside allowlist: ${disallowed[0]}`,
              model: disallowed[0]
            });
          } else {
            out.userPriority = normalized.slice(0, 12);
          }
        }
        if (src.models.preferredRoute !== undefined) {
          const route = String(src.models.preferredRoute || '').trim().toLowerCase();
          out.preferredRoute = route === 'fast' || route === 'strong' ? route : 'auto';
        }
        if (Object.keys(out).length) {
          normalizedPatch.models = out;
        }
      }

      if (isObject(src.responses)) {
        Object.keys(src.responses).forEach((key) => {
          if (key !== 'parallel_tool_calls' && key !== 'truncation') {
            errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: `Unknown responses key: ${key}` });
          }
        });
        const out = {};
        if (src.responses.parallel_tool_calls !== undefined) {
          out.parallel_tool_calls = Boolean(src.responses.parallel_tool_calls);
        }
        if (src.responses.truncation !== undefined) {
          const mode = String(src.responses.truncation || '').trim().toLowerCase();
          if (!TRUNCATION.has(mode)) {
            errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: 'responses.truncation must be auto|disabled' });
          } else {
            out.truncation = mode;
          }
        }
        if (Object.keys(out).length) {
          normalizedPatch.responses = out;
        }
      }

      if (isObject(src.translation)) {
        Object.keys(src.translation).forEach((key) => {
          if (key !== 'style' && key !== 'batchGuidance' && key !== 'proofreadPasses') {
            errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: `Unknown translation key: ${key}` });
          }
        });
        const out = {};
        if (src.translation.style !== undefined) {
          const style = String(src.translation.style || '').trim().toLowerCase();
          out.style = STYLE.has(style) ? style : 'auto';
        }
        if (src.translation.batchGuidance !== undefined) {
          out.batchGuidance = String(src.translation.batchGuidance || '').slice(0, 1200);
        }
        if (src.translation.proofreadPasses !== undefined) {
          const num = Number(src.translation.proofreadPasses);
          out.proofreadPasses = Number.isFinite(num) ? Math.max(0, Math.min(5, Math.round(num))) : 0;
        }
        if (Object.keys(out).length) {
          normalizedPatch.translation = out;
        }
      }

      if (isObject(src.tools) && isObject(src.tools.proposal)) {
        const proposal = {};
        Object.keys(src.tools.proposal).forEach((rawKey) => {
          const mode = String(src.tools.proposal[rawKey] || '').trim().toLowerCase();
          if (!TOOL_MODE.has(mode)) {
            return;
          }
          const compat = isObject(ctx.toolCompatMap) && typeof ctx.toolCompatMap[rawKey] === 'string'
            ? ctx.toolCompatMap[rawKey]
            : rawKey;
          if (compat !== rawKey) {
            warnings.push({ code: 'TOOL_DEPRECATED', message: `Tool key mapped: ${rawKey} -> ${compat}` });
          }
          if (mode === 'on' && typeof ctx.isToolAllowed === 'function' && !ctx.isToolAllowed(compat)) {
            proposal[compat] = 'off';
            warnings.push({ code: 'missing_capability', message: `Tool ${compat} downgraded to off` });
            return;
          }
          proposal[compat] = mode;
        });
        if (Object.keys(proposal).length) {
          normalizedPatch.tools = { proposal };
        }
      } else if (isObject(src.tools)) {
        Object.keys(src.tools).forEach((key) => {
          if (key !== 'proposal') {
            errors.push({ code: 'SETTINGS_PATCH_UNKNOWN_KEY', message: `Unknown tools key: ${key}` });
          }
        });
      }

      return { normalizedPatch, warnings, errors };
    }
  }

  NT.RunSettingsValidator = RunSettingsValidator;
})(globalThis);
