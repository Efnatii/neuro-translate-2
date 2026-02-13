/**
 * Capability ranking heuristics for AI model identifiers.
 *
 * This module provides deterministic rank/feature helpers used by registry and
 * model selection scoring. It is intentionally static and side-effect free.
 *
 * Contracts:
 * - input is model id string, output is normalized capability hints;
 * - no persistence, network requests, or browser API access;
 * - only AI-internal consumers should depend on this ranking surface.
 */
(function initCapabilityRank(global) {
  const NT = global.NT;
  const AI = NT.Internal.ai;

  class CapabilityRank {
    static normalizeId(modelId) {
      return String(modelId || '').trim().toLowerCase();
    }

    static isPro(modelId) {
      return CapabilityRank.normalizeId(modelId).includes('-pro');
    }

    static isMini(modelId) {
      return CapabilityRank.normalizeId(modelId).includes('-mini');
    }

    static isNano(modelId) {
      return CapabilityRank.normalizeId(modelId).includes('-nano');
    }

    static isChatLatest(modelId) {
      return CapabilityRank.normalizeId(modelId).includes('chat-latest');
    }

    static isDeepResearch(modelId) {
      return CapabilityRank.normalizeId(modelId).includes('deep-research');
    }

    static getBaseRank(modelId) {
      const normalized = CapabilityRank.normalizeId(modelId);
      const hasDeepResearch = CapabilityRank.isDeepResearch(normalized);

      if (hasDeepResearch) {
        if (normalized.includes('o3')) {
          return 86;
        }
        if (normalized.includes('o4-mini')) {
          return 76;
        }
      }

      let baseId = normalized.replace('-chat-latest', '').replace('-pro', '');

      const baseMap = {
        'gpt-5.2': 100,
        'gpt-5.1': 95,
        'gpt-5': 90,
        'o3': 88,
        'gpt-4o': 85,
        'gpt-4.1': 84,
        'o1': 82,
        'o4-mini': 75,
        'gpt-5-mini': 74,
        'gpt-4.1-mini': 72,
        'o3-mini': 70,
        'o1-mini': 66,
        'gpt-4o-mini': 65,
        'gpt-5-nano': 60,
        'gpt-4.1-nano': 58
      };

      if (baseMap[baseId] !== undefined) {
        return baseMap[baseId];
      }

      return 50;
    }

    static rank(modelId) {
      let rank = CapabilityRank.getBaseRank(modelId);

      if (CapabilityRank.isPro(modelId)) {
        rank += 6;
      }

      if (CapabilityRank.isChatLatest(modelId)) {
        rank -= 1;
      }

      return rank;
    }
  }

  AI.CapabilityRank = CapabilityRank;
})(globalThis);
