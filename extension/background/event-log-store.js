(function initEventLogStore(global) {
  const STORAGE_KEY = 'eventLog';
  const DEFAULT_LIMIT = 500;

  class EventLogStore {
    constructor({ chromeApi, limit = DEFAULT_LIMIT } = {}) {
      this.chromeApi = chromeApi;
      this.limit = limit;
      this.loaded = false;
      this.seq = 0;
      this.items = [];
    }

    async load() {
      if (this.loaded) {
        return this.getSnapshot();
      }

      const data = await this.storageGet({ [STORAGE_KEY]: { seq: 0, items: [] } });
      const stored = data[STORAGE_KEY] || { seq: 0, items: [] };
      this.seq = typeof stored.seq === 'number' ? stored.seq : 0;
      this.items = Array.isArray(stored.items) ? stored.items.slice(-this.limit) : [];
      this.loaded = true;
      return this.getSnapshot();
    }

    async append(event) {
      await this.load();
      const safeEvent = this.normalizeEvent(event);
      this.seq += 1;
      safeEvent.seq = this.seq;
      this.items.push(safeEvent);
      if (this.items.length > this.limit) {
        this.items.splice(0, this.items.length - this.limit);
      }

      await this.persist();
      return safeEvent;
    }

    async clear() {
      await this.load();
      this.items = [];
      await this.persist();
      return this.getSnapshot();
    }

    getSnapshot() {
      return {
        seq: this.seq,
        items: this.items.map((item) => ({ ...item, meta: { ...(item.meta || {}) } }))
      };
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

    storageGet(defaults) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve(defaults || {});
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(defaults, (result) => resolve(result || defaults || {}));
      });
    }

    storageSet(payload) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.set(payload, () => resolve());
      });
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.EventLogStore = EventLogStore;
})(globalThis);
