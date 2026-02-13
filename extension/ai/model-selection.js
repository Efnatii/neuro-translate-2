/**
 * AI-scoped normalization helper for model selection preferences.
 *
 * This module belongs to the AI layer and defines canonical shape for
 * `modelSelection` settings consumed by model-choice logic.
 *
 * Contract:
 * - `AiModelSelection.default()` returns `{ speed: true, preference: null }`.
 * - `AiModelSelection.normalize(modelSelection, legacyPolicy)` accepts current
 *   object form or legacy policy string and always returns safe object form.
 * - `AiModelSelection.isValidPreference(value)` validates supported preferences.
 *
 * This file does not access storage, UI, tabs, or network APIs.
 * It only normalizes values and keeps legacy policy migration compatibility
 * inside AI scope.
 */
(function initAiModelSelection(global) {
  const NT = global.NT || (global.NT = {});
  const AI = NT.Internal.ai;

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

    static isValidPreference(value) {
      return value === 'smartest' || value === 'cheapest';
    }
  }

  AI.AiModelSelection = AiModelSelection;
})(globalThis);
