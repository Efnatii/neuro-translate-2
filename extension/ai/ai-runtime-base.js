/**
 * Shared AI runtime base for engine/benchmarker orchestration classes.
 *
 * Role:
 * - Provide one reusable runtime mix of clock, event emission, and model-spec
 *   adapters for AI orchestration classes.
 *
 * Public contract:
 * - `now()` returns a stable timestamp source (`NT.Time` when available).
 * - `logEvent(level, tag, message, meta)` emits either EventFactory-built
 *   objects or plain `{level, tag, message, meta}` payloads.
 * - `parseModelSpec(modelSpec)` and `mapServiceTier(tier)` proxy `NT.AiCommon`
 *   safely with deterministic fallbacks.
 *
 * Dependencies:
 * - Optional `time`, `eventFactory`, `eventLogger`, and `aiCommon` providers.
 *
 * Side effects:
 * - None. The class only emits through injected logger callbacks.
 */
(function initAiRuntimeBase(global) {
  const NT = global.NT || (global.NT = {});

  class AiRuntimeBase {
    constructor({ time, eventFactory, eventLogger, aiCommon } = {}) {
      this.time = time || (NT.Time || null);
      this.eventFactory = eventFactory || null;
      this.eventLogger = typeof eventLogger === 'function' ? eventLogger : null;
      this.aiCommon = aiCommon || (NT.AiCommon || null);
    }

    now() {
      return this.time && typeof this.time.now === 'function' ? this.time.now() : Date.now();
    }

    logEvent(level, tag, message, meta) {
      if (!this.eventLogger) {
        return;
      }

      if (this.eventFactory) {
        const event = level === 'error'
          ? this.eventFactory.error(tag, message, meta)
          : level === 'warn'
            ? this.eventFactory.warn(tag, message, meta)
            : this.eventFactory.info(tag, message, meta);
        this.eventLogger(event);
        return;
      }

      this.eventLogger({ level, tag, message, meta });
    }

    parseModelSpec(modelSpec) {
      if (this.aiCommon && typeof this.aiCommon.parseModelSpec === 'function') {
        return this.aiCommon.parseModelSpec(modelSpec);
      }
      return { id: '', tier: 'standard' };
    }

    mapServiceTier(tier) {
      if (this.aiCommon && typeof this.aiCommon.mapServiceTier === 'function') {
        return this.aiCommon.mapServiceTier(tier);
      }
      return 'default';
    }
  }

  NT.AiRuntimeBase = AiRuntimeBase;
})(globalThis);
