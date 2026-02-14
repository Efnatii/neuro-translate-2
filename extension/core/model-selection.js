/**
 * Compatibility shim for legacy `NT.ModelSelection` consumers.
 *
 * Role:
 * - Preserve backward-compatible symbol/path while AI policy logic lives in
 *   `NT.AiModelSelection` (`extension/ai/model-selection-policy.js`).
 *
 * Public contract:
 * - Exposes `NT.ModelSelection` for old callers.
 * - Uses `NT.AiModelSelection` when available.
 * - Falls back to inline-safe implementation when load order is different.
 *
 * Dependencies:
 * - Optional `NT.AiModelSelection`.
 *
 * Side effects:
 * - Assigns `NT.ModelSelection` only; no storage/runtime side effects.
 */
(function initModelSelection(global) {
  const NT = global.NT || (global.NT = {});

  if (NT.AiModelSelection) {
    NT.ModelSelection = NT.AiModelSelection;
    return;
  }

  class ModelSelectionFallback {
    static default() {
      return { speed: true, preference: null };
    }

    static normalize(modelSelection, legacyPolicy) {
      if (modelSelection && typeof modelSelection === 'object') {
        return {
          speed: modelSelection.speed !== false,
          preference: ModelSelectionFallback.isValidPreference(modelSelection.preference)
            ? modelSelection.preference
            : null
        };
      }

      if (legacyPolicy === 'smartest') {
        return { speed: false, preference: 'smartest' };
      }
      if (legacyPolicy === 'cheapest') {
        return { speed: false, preference: 'cheapest' };
      }

      return ModelSelectionFallback.default();
    }

    static isValidPreference(x) {
      return x === 'smartest' || x === 'cheapest';
    }
  }

  NT.ModelSelection = ModelSelectionFallback;
})(globalThis);
