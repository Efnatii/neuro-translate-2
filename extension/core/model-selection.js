/**
 * Shared normalization helper for model selection settings.
 *
 * This file centralizes the legacy-to-modern mapping of user selection policy
 * so background, UI bridge, and other runtime modules do not duplicate the same
 * fallback logic. The helper is intentionally stateless: MV3 service workers can
 * be suspended and restarted at any time, therefore the canonical value always
 * comes from storage and is normalized on read.
 *
 * Contract:
 * - `ModelSelection.default()` returns the canonical default value.
 * - `ModelSelection.normalize(modelSelection, legacyPolicy)` accepts either the
 *   modern object shape or legacy policy string and always returns a safe object.
 * - `ModelSelection.isValidPreference(x)` validates supported preference values.
 */
(function initModelSelection(global) {
  const NT = global.NT || (global.NT = {});

  class ModelSelection {
    static default() {
      return { speed: true, preference: null };
    }

    static normalize(modelSelection, legacyPolicy) {
      if (modelSelection && typeof modelSelection === 'object') {
        return {
          speed: modelSelection.speed !== false,
          preference: ModelSelection.isValidPreference(modelSelection.preference)
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

      return ModelSelection.default();
    }

    static isValidPreference(x) {
      return x === 'smartest' || x === 'cheapest';
    }
  }

  NT.ModelSelection = ModelSelection;
})(globalThis);
