/**
 * Persistent ring buffer for diagnostic events emitted by extension modules.
 *
 * The store keeps monotonically increasing sequence numbers and bounded item
 * history in `chrome.storage.local` so UI clients can recover after MV3 worker
 * restarts and request historical pages by sequence range.
 *
 * Public API includes append/clear plus paging helpers (`getTail`, `getBefore`)
 * used by snapshot/patch streaming and debug "load older" flows.
 */
(function initEventLogStore(global) {
  const STORAGE_KEY = 'eventLog';
  const DEFAULT_LIMIT = 800;

  class EventLogStore extends global.NT.ChromeLocalStoreBase {
    constructor({ chromeApi, limit = DEFAULT_LIMIT } = {}) {
      super({ chromeApi });
      this.limit = limit;
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

    clampLimit(limit) {
      const value = Number(limit);
      if (!Number.isFinite(value)) {
        return 200;
      }
      return Math.max(1, Math.min(400, Math.floor(value)));
    }

    normalizeEvent(event) {
      const safeEvent = event && typeof event === 'object' ? event : {};
      const meta = safeEvent.meta && typeof safeEvent.meta === 'object' ? safeEvent.meta : {};
      return {
        ts: typeof safeEvent.ts === 'number' ? safeEvent.ts : Date.now(),
        level: this.normalizeLevel(safeEvent.level),
        tag: safeEvent.tag ? String(safeEvent.tag) : 'general',
        message: safeEvent.message ? String(safeEvent.message) : '',
        meta: {
          source: meta.source || 'background',
          tabId: meta.tabId ?? null,
          requestId: meta.requestId || null,
          stage: meta.stage || null,
          modelSpec: meta.modelSpec || null,
          status: meta.status || null,
          latencyMs: typeof meta.latencyMs === 'number' ? meta.latencyMs : null
        }
      };
    }

    normalizeLevel(level) {
      if (level === 'warn' || level === 'error') {
        return level;
      }
      return 'info';
    }

    async persist() {
      await this.storageSet({ [STORAGE_KEY]: { seq: this.seq, items: this.items } });
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.EventLogStore = EventLogStore;
})(globalThis);
