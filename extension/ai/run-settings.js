/**
 * Job-scoped run settings helper for AutoTune.
 *
 * Operates on compact effective shape used by agent tools and runtime request
 * options. Global settings are never mutated from this module.
 */
(function initRunSettings(global) {
  const NT = global.NT || (global.NT = {});

  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  function isObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function mergeDeep(base, patch) {
    const out = isObject(base) ? cloneJson(base, {}) : {};
    const src = isObject(patch) ? patch : {};
    Object.keys(src).forEach((key) => {
      const next = src[key];
      if (isObject(next)) {
        out[key] = mergeDeep(out[key], next);
        return;
      }
      if (Array.isArray(next)) {
        out[key] = next.slice();
        return;
      }
      out[key] = next;
    });
    return out;
  }

  class RunSettings {
    computeBaseEffective({ globalEffectiveSettings, jobContext } = {}) {
      const globalEffective = isObject(globalEffectiveSettings) ? globalEffectiveSettings : {};
      const reasoning = isObject(globalEffective.reasoning) ? globalEffective.reasoning : {};
      const caching = isObject(globalEffective.caching) ? globalEffective.caching : {};
      const models = isObject(globalEffective.models) ? globalEffective.models : {};
      const agent = isObject(globalEffective.agent) ? globalEffective.agent : {};
      const plan = isObject(jobContext && jobContext.agentState && jobContext.agentState.plan)
        ? jobContext.agentState.plan
        : {};
      return {
        reasoning: {
          mode: reasoning.reasoningMode || 'auto',
          effort: reasoning.reasoningEffort || 'medium',
          summary: reasoning.reasoningSummary || 'auto'
        },
        caching: {
          promptCacheRetention: caching.promptCacheRetention || 'auto',
          promptCacheKey: typeof caching.promptCacheKey === 'string' ? caching.promptCacheKey : null,
          compatCache: caching.compatCache !== false
        },
        tools: {
          proposal: isObject(agent.toolConfigEffective) ? cloneJson(agent.toolConfigEffective, {}) : {}
        },
        models: {
          allowlist: Array.isArray(models.agentAllowedModels) ? models.agentAllowedModels.slice() : [],
          routingMode: models.modelRoutingMode || 'auto',
          userPriority: Array.isArray(models.modelUserPriority) ? models.modelUserPriority.slice() : [],
          preferredRoute: 'auto'
        },
        responses: {
          parallel_tool_calls: true,
          truncation: 'auto'
        },
        translation: {
          style: typeof plan.style === 'string' ? plan.style : 'balanced',
          batchGuidance: typeof plan.instructions === 'string' ? plan.instructions : '',
          proofreadPasses: Number.isFinite(Number(plan.proofreadingPasses))
            ? Number(plan.proofreadingPasses)
            : null
        },
        agentMode: {
          executionMode: agent.agentMode || 'agent',
          parallelToolCallsDefault: true
        }
      };
    }

    applyPatch(baseEffective, patch) {
      return mergeDeep(baseEffective, patch);
    }

    diff(oldEffective, newEffective) {
      const before = isObject(oldEffective) ? oldEffective : {};
      const after = isObject(newEffective) ? newEffective : {};
      const changedKeys = [];
      const changedPatch = {};
      const walk = (left, right, path, patchOut) => {
        const leftKeys = isObject(left) ? Object.keys(left) : [];
        const rightKeys = isObject(right) ? Object.keys(right) : [];
        const keys = Array.from(new Set(leftKeys.concat(rightKeys))).sort();
        keys.forEach((key) => {
          const nextPath = path ? `${path}.${key}` : key;
          const a = left ? left[key] : undefined;
          const b = right ? right[key] : undefined;
          if (isObject(a) || isObject(b)) {
            const nestedOut = {};
            walk(isObject(a) ? a : {}, isObject(b) ? b : {}, nextPath, nestedOut);
            if (Object.keys(nestedOut).length) {
              patchOut[key] = nestedOut;
            }
            return;
          }
          const same = JSON.stringify(a) === JSON.stringify(b);
          if (same) {
            return;
          }
          changedKeys.push(nextPath);
          patchOut[key] = Array.isArray(b) ? b.slice() : b;
        });
      };
      walk(before, after, '', changedPatch);
      return {
        changedKeys,
        changedPatch,
        humanSummary: changedKeys.length
          ? `Изменено параметров: ${changedKeys.length}`
          : 'Изменений нет'
      };
    }

    serializeForAgent(effective) {
      const src = isObject(effective) ? effective : {};
      return {
        reasoning: isObject(src.reasoning)
          ? { mode: src.reasoning.mode || 'auto', effort: src.reasoning.effort || 'medium', summary: src.reasoning.summary || 'auto' }
          : null,
        caching: isObject(src.caching)
          ? { promptCacheRetention: src.caching.promptCacheRetention || 'auto', compatCache: src.caching.compatCache !== false }
          : null,
        models: isObject(src.models)
          ? {
            routingMode: src.models.routingMode || 'auto',
            preferredRoute: src.models.preferredRoute || 'auto',
            allowlistSize: Array.isArray(src.models.allowlist) ? src.models.allowlist.length : 0,
            userPrioritySize: Array.isArray(src.models.userPriority) ? src.models.userPriority.length : 0
          }
          : null,
        responses: isObject(src.responses)
          ? {
            parallel_tool_calls: src.responses.parallel_tool_calls !== false,
            truncation: src.responses.truncation || 'auto'
          }
          : null,
        translation: isObject(src.translation)
          ? {
            style: src.translation.style || 'balanced',
            hasBatchGuidance: Boolean(src.translation.batchGuidance),
            proofreadPasses: Number.isFinite(Number(src.translation.proofreadPasses))
              ? Number(src.translation.proofreadPasses)
              : null
          }
          : null,
        agentMode: isObject(src.agentMode)
          ? { executionMode: src.agentMode.executionMode || 'agent', parallelToolCallsDefault: src.agentMode.parallelToolCallsDefault !== false }
          : null
      };
    }
  }

  NT.RunSettings = RunSettings;
})(globalThis);
