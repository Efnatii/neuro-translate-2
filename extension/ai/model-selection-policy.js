/**
 * Canonical AI model-selection policy normalization.
 *
 * Role:
 * - Own normalization rules for model-selection settings in AI domain.
 * - Provide one stable policy contract for AI/background orchestration.
 *
 * Public contract:
 * - `AiModelSelection.default()` returns canonical defaults.
 * - `AiModelSelection.normalize(modelSelection, legacyPolicy)` maps modern and
 *   legacy settings to the canonical shape.
 * - `AiModelSelection.isValidPreference(x)` validates supported preferences.
 *
 * Dependencies:
 * - None besides namespace bootstrap (`NT`).
 *
 * Side effects:
 * - Exposes `NT.AiModelSelection` for consumers and core compatibility shim.
 */
(function initModelSelectionPolicy(global) {
  const NT = global.NT || (global.NT = {});

  class AiModelSelection {
    static default() {
      return { speed: true, preference: null };
    }

    static normalize(modelSelection, legacyPolicy) {
      if (modelSelection && typeof modelSelection === 'object') {
        return {
          speed: modelSelection.speed !== false,
          preference: AiModelSelection.isValidPreference(modelSelection.preference)
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

      return AiModelSelection.default();
    }

    static isValidPreference(x) {
      return x === 'smartest' || x === 'cheapest';
    }
  }

  NT.AiModelSelection = AiModelSelection;
})(globalThis);
