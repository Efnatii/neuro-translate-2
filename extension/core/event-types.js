/**
 * Unified event taxonomy used across BG/AI/UI/content logging.
 *
 * Stable tags and levels make debug filtering deterministic and prevent drift in
 * event semantics between modules. `EventFactory` validates against this map,
 * `EventLogStore` persists normalized entries, and debug UI renders/filters by
 * level/tag without per-module special cases.
 *
 * MV3 note: events are persisted and replayed after service-worker restart, so
 * taxonomy must remain compact and backward-compatible.
 */
(function initEventTypes(global) {
  const Levels = Object.freeze({
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error'
  });

  const Tags = Object.freeze({
    UI_HELLO: 'ui.hello',
    UI_SNAPSHOT: 'ui.snapshot',
    UI_PATCH: 'ui.patch',
    UI_DISCONNECT: 'ui.disconnect',
    UI_COMMAND: 'ui.command',

    BG_START: 'bg.start',
    BG_STORAGE_CHANGE: 'bg.storage.change',
    BG_TAB: 'bg.tab',
    BG_ERROR: 'bg.error',

    AI_CHOOSE: 'ai.choose',
    AI_REQUEST: 'ai.request',
    AI_RESPONSE: 'ai.response',
    AI_RATE_LIMIT: 'ai.rateLimit',
    AI_COOLDOWN: 'ai.cooldown',

    BENCH_START: 'bench.start',
    BENCH_SAMPLE: 'bench.sample',
    BENCH_DONE: 'bench.done',
    BENCH_SKIP: 'bench.skip',

    TRANSLATION_START: 'translation.start',
    TRANSLATION_BATCH_SENT: 'translation.batch.sent',
    TRANSLATION_BATCH_APPLIED: 'translation.batch.applied',
    TRANSLATION_CANCEL: 'translation.cancel',
    TRANSLATION_FAIL: 'translation.fail',
    TRANSLATION_RESUME: 'translation.resume',

    CS_HELLO: 'cs.hello',
    CS_STATUS: 'cs.status',
    CS_APPLY: 'cs.apply',
    CS_ERROR: 'cs.error'
  });

  const tagValues = new Set(Object.values(Tags));
  const levelValues = new Set(Object.values(Levels));

  const EventTypes = Object.freeze({
    Levels,
    Tags,
    isValidTag(tag) {
      return typeof tag === 'string' && tagValues.has(tag);
    },
    isValidLevel(level) {
      return typeof level === 'string' && levelValues.has(level);
    }
  });

  global.NT.EventTypes = EventTypes;
})(globalThis);
