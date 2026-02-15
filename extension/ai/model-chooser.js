/**
 * Deterministic model choice strategy used by LLM engine.
 *
 * This class owns scoring and hysteresis logic so `LlmEngine` can focus on
 * orchestration and I/O.
 */
(function initModelChooser(global) {
  const NT = global.NT || (global.NT = {});

  class ModelChooser {
    static choose({ prepared, selection, hintPrevModelSpec } = {}) {
      const list = Array.isArray(prepared) ? prepared : [];
      const normalized = ModelChooser.normalizeSelection(selection);
      const available = list.filter((item) => item && item.availability && item.availability.ok);
      if (!available.length) {
        const chosen = list.reduce((best, item) => {
          if (!best) {
            return item;
          }
          const wait = item.availability ? item.availability.waitMs : Number.POSITIVE_INFINITY;
          const bestWait = best.availability ? best.availability.waitMs : Number.POSITIVE_INFINITY;
          return wait < bestWait ? item : best;
        }, null);
        return {
          chosen,
          reason: 'rate_limited_all',
          scored: []
        };
      }

      const scored = available
        .map((candidate) => ({
          candidate,
          score: ModelChooser.scoreCandidate(candidate, normalized)
        }))
        .sort((a, b) => ModelChooser.compareScored(a, b));

      const bestScored = scored[0];
      const hysteresisWinner = ModelChooser.pickByHysteresis({
        scored,
        bestScored,
        hintPrevModelSpec,
        selection: normalized
      });

      return {
        chosen: hysteresisWinner || bestScored.candidate,
        reason: hysteresisWinner ? 'hysteresis_keep_prev' : ModelChooser.resolveReason(normalized),
        scored
      };
    }

    static normalizeSelection(selection) {
      return {
        speed: Boolean(selection && selection.speed),
        preference: selection && (selection.preference === 'smartest' || selection.preference === 'cheapest')
          ? selection.preference
          : null
      };
    }

    static resolveReason(selection) {
      if (selection.speed && selection.preference === 'smartest') {
        return 'score_speed_smartest';
      }
      if (selection.speed && selection.preference === 'cheapest') {
        return 'score_speed_cheapest';
      }
      if (selection.speed) {
        return 'score_speed';
      }
      if (selection.preference === 'smartest') {
        return 'score_smartest';
      }
      if (selection.preference === 'cheapest') {
        return 'score_cheapest';
      }
      return 'score_speed';
    }

    static scoreCandidate(candidate, selection) {
      let score = 0;
      const latencyMs = ModelChooser.clamp(Number.isFinite(candidate.latencyMs) ? candidate.latencyMs : 50000, 80, 50000);
      const cost = Number.isFinite(candidate.cost) ? candidate.cost : 1e9;

      if (selection.speed) {
        if (typeof candidate.tps === 'number' && Number.isFinite(candidate.tps) && candidate.tps > 0) {
          score += Math.log(1 + candidate.tps) * 12;
        } else {
          score += (-Math.log(1 + latencyMs / 200)) * 9;
        }
        score -= Math.log(1 + latencyMs / 300) * 2.2;
      }

      if (selection.preference === 'smartest') {
        score += (candidate.capabilityRank || 0) / 10;
      }
      if (selection.preference === 'cheapest') {
        score += (-Math.log(1 + cost)) * 4;
      }

      score -= (candidate.limitRiskPenalty || 0);
      score -= (candidate.usagePenalty || 0) * 6;
      return score;
    }

    static pickByHysteresis({ scored, bestScored, hintPrevModelSpec, selection }) {
      if (!selection || !selection.speed || !hintPrevModelSpec || !Array.isArray(scored) || !scored.length || !bestScored) {
        return null;
      }
      const prevScored = scored.find((entry) => entry.candidate.modelSpec === hintPrevModelSpec);
      if (!prevScored) {
        return null;
      }

      const prev = prevScored.candidate;
      const best = bestScored.candidate;
      const margin = Math.max(Math.abs(bestScored.score) * 0.08, 0.25);
      const nearBest = prevScored.score >= (bestScored.score - margin);
      const riskClose = (prev.limitRiskPenalty || 0) <= (best.limitRiskPenalty || 0) + 1.5;
      const tpsConsistency = !(typeof best.tps === 'number' && best.tps > 0) || (typeof prev.tps === 'number' && prev.tps > 0);
      return nearBest && riskClose && tpsConsistency ? prev : null;
    }

    static compareScored(a, b) {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      const aLatency = Number.isFinite(a.candidate.latencyMs) ? a.candidate.latencyMs : Number.POSITIVE_INFINITY;
      const bLatency = Number.isFinite(b.candidate.latencyMs) ? b.candidate.latencyMs : Number.POSITIVE_INFINITY;
      if (aLatency !== bLatency) {
        return aLatency - bLatency;
      }
      if ((b.candidate.capabilityRank || 0) !== (a.candidate.capabilityRank || 0)) {
        return (b.candidate.capabilityRank || 0) - (a.candidate.capabilityRank || 0);
      }
      if (a.candidate.cost !== b.candidate.cost) {
        return a.candidate.cost - b.candidate.cost;
      }
      return a.candidate.modelSpec.localeCompare(b.candidate.modelSpec);
    }

    static clamp(value, min, max) {
      if (!Number.isFinite(value)) {
        return max;
      }
      return Math.max(min, Math.min(max, value));
    }
  }

  NT.ModelChooser = ModelChooser;
})(globalThis);

