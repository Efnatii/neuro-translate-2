/**
 * Shared duration parser for rate-limit and retry headers.
 *
 * This utility provides one strict parser for compact duration strings like
 * `17ms`, `1s`, `6m0s`, or `1h30m` used in OpenAI rate-limit reset headers.
 * Keeping parsing in one place prevents drift between LLM request handling and
 * rate-limit snapshot persistence.
 *
 * Consumers currently include `LlmClient` and `ModelRateLimitStore`.
 * The class is intentionally stateless and pure so it is safe for MV3 service
 * worker restarts and simple to reuse across modules.
 */
(function initDuration(global) {
  const NT = global.NT || (global.NT = {});

  class Duration {
    static parseMs(raw) {
      if (typeof raw !== 'string' || !raw.trim()) {
        return null;
      }

      const value = raw.trim();
      const pattern = /(\d+)(ms|s|m|h)/g;
      let total = 0;
      let consumed = '';
      let match = pattern.exec(value);

      while (match) {
        const amount = Number(match[1]);
        const unit = match[2];
        if (!Number.isFinite(amount)) {
          return null;
        }

        if (unit === 'ms') {
          total += amount;
        } else if (unit === 's') {
          total += amount * 1000;
        } else if (unit === 'm') {
          total += amount * 60 * 1000;
        } else if (unit === 'h') {
          total += amount * 60 * 60 * 1000;
        }

        consumed += match[0];
        match = pattern.exec(value);
      }

      return consumed === value ? total : null;
    }

    static maxDefined(a, b) {
      const hasA = typeof a === 'number' && Number.isFinite(a);
      const hasB = typeof b === 'number' && Number.isFinite(b);
      if (!hasA && !hasB) {
        return null;
      }
      if (!hasA) {
        return b;
      }
      if (!hasB) {
        return a;
      }
      return Math.max(a, b);
    }
  }

  NT.Duration = Duration;
})(globalThis);
