/**
 * Persistent ring buffer for background diagnostics with redaction.
 *
 * Responsibilities:
 * - keep bounded event history in local storage for debug recovery;
 * - assign monotonic sequence numbers for paging and incremental patches;
 * - redact sensitive payload fields before persistence.
 *
 * MV3 note: service worker may restart at any time, so `load()` restores
 * in-memory cursor (`seq`) and tail items from storage.
 *
 * This store does not decide event semantics; callers own event meaning.
 */
(function initEventLogStore(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  const STORAGE_KEY = 'eventLog';
  const DEFAULT_LIMIT = 800;

  class EventLogStore extends NT.LocalStore {
    constructor({ chromeApi, limit = DEFAULT_LIMIT, time, eventSink, redactor } = {}) {
      super({ chromeApi, time, eventSink, storeName: 'EventLogStore' });
      this.limit = Number.isFinite(Number(limit)) ? Math.max(100, Number(limit)) : DEFAULT_LIMIT;
      this.redactor = redactor || new NT.Redactor();
      this.loaded = false;
      this.seq = 0;
      this.items = [];
    }

    async load() {
      if (this.loaded) {
        return { seq: this.seq, items: this.items.slice() };
      }

      const data = await this.storageGet({ [STORAGE_KEY]: { seq: 0, items: [] } });
      const stored = data[STORAGE_KEY] || { seq: 0, items: [] };
      this.seq = typeof stored.seq === 'number' ? stored.seq : 0;
      this.items = Array.isArray(stored.items) ? stored.items.slice(-this.limit) : [];
      this.loaded = true;
      return { seq: this.seq, items: this.items.slice() };
    }

    async append(event) {
      await this.load();
      const item = this.normalizeEvent(event);
      this.seq += 1;
      item.seq = this.seq;
      this.items.push(item);
      if (this.items.length > this.limit) {
        this.items.splice(0, this.items.length - this.limit);
      }
      await this.persist();
      return { seq: this.seq, item: { ...item, meta: { ...(item.meta || {}) } } };
    }

    async clear() {
      await this.load();
      this.seq += 1;
      this.items = [];
      await this.persist();
    }

    async getTail(limit = 200) {
      await this.load();
      const safeLimit = this.clampLimit(limit);
      return {
        seq: this.seq,
        items: this.items.slice(-safeLimit).map((item) => ({ ...item, meta: { ...(item.meta || {}) } }))
      };
    }

    async getBefore(beforeSeq, limit = 200) {
      await this.load();
      const safeLimit = this.clampLimit(limit);
      const boundary = typeof beforeSeq === 'number' ? beforeSeq : null;
      const filtered = boundary === null
        ? this.items.slice()
        : this.items.filter((item) => typeof item.seq === 'number' && item.seq < boundary);
      return {
        seq: this.seq,
        items: filtered.slice(-safeLimit).map((item) => ({ ...item, meta: { ...(item.meta || {}) } }))
      };
    }

    async persist() {
      await this.storageSet({
        [STORAGE_KEY]: {
          seq: this.seq,
          items: this.items
        }
      });
    }

    clampLimit(limit) {
      const value = Number(limit);
      if (!Number.isFinite(value)) {
        return 200;
      }
      return Math.max(1, Math.min(400, Math.floor(value)));
    }

    normalizeEvent(event) {
      const src = event && typeof event === 'object' ? event : {};
      const rawMeta = src.meta && typeof src.meta === 'object' ? src.meta : {};
      return this.redactor.redactEventPayload({
        ts: typeof src.ts === 'number' ? src.ts : Date.now(),
        level: typeof src.level === 'string' ? src.level : 'info',
        tag: typeof src.tag === 'string' ? src.tag : 'general',
        message: typeof src.message === 'string' ? src.message : '',
        meta: { ...rawMeta }
      });
    }
  }

  BG.EventLogStore = EventLogStore;
})(globalThis);
