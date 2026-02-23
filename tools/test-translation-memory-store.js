const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

function load(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInThisContext(code, { filename: fullPath });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function createChromeApi(initialState) {
  const state = { ...(initialState || {}) };
  return {
    storage: {
      local: {
        get(defaults, cb) {
          if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
            cb({ ...defaults, ...state });
            return;
          }
          cb({ ...state });
        },
        set(payload, cb) {
          Object.assign(state, payload || {});
          if (typeof cb === 'function') {
            cb();
          }
        }
      }
    },
    _dump() {
      return { ...state };
    }
  };
}

function createFakeIndexedDb() {
  class FakeRequest {
    constructor() {
      this.result = undefined;
      this.error = null;
      this.onsuccess = null;
      this.onerror = null;
      this.onupgradeneeded = null;
    }
  }

  class FakeObjectStore {
    constructor(storeDef, tx) {
      this._store = storeDef;
      this._tx = tx || null;
      this.keyPath = storeDef.keyPath || 'id';
    }

    createIndex(name, keyPath, options) {
      this._store.indexes[name] = {
        keyPath: String(keyPath || ''),
        unique: Boolean(options && options.unique)
      };
      return {};
    }

    _markStart() {
      if (this._tx) {
        this._tx._startRequest();
      }
    }

    _markDone() {
      if (this._tx) {
        this._tx._finishRequest();
      }
    }

    get(key) {
      const req = new FakeRequest();
      this._markStart();
      const lookup = this._store.data.has(String(key))
        ? clone(this._store.data.get(String(key)))
        : undefined;
      setTimeout(() => {
        req.result = lookup;
        if (typeof req.onsuccess === 'function') {
          req.onsuccess({ target: req });
        }
        this._markDone();
      }, 0);
      return req;
    }

    put(value) {
      const req = new FakeRequest();
      this._markStart();
      const row = clone(value);
      const key = String(row && row[this.keyPath] !== undefined ? row[this.keyPath] : '');
      this._store.data.set(key, row);
      setTimeout(() => {
        req.result = key;
        if (typeof req.onsuccess === 'function') {
          req.onsuccess({ target: req });
        }
        this._markDone();
      }, 0);
      return req;
    }

    delete(key) {
      const req = new FakeRequest();
      this._markStart();
      this._store.data.delete(String(key));
      setTimeout(() => {
        req.result = undefined;
        if (typeof req.onsuccess === 'function') {
          req.onsuccess({ target: req });
        }
        this._markDone();
      }, 0);
      return req;
    }

    clear() {
      const req = new FakeRequest();
      this._markStart();
      this._store.data.clear();
      setTimeout(() => {
        req.result = undefined;
        if (typeof req.onsuccess === 'function') {
          req.onsuccess({ target: req });
        }
        this._markDone();
      }, 0);
      return req;
    }

    openCursor() {
      const req = new FakeRequest();
      this._markStart();
      const values = Array.from(this._store.data.values()).map((value) => clone(value));
      let index = 0;
      const emit = () => {
        if (index >= values.length) {
          req.result = null;
          if (typeof req.onsuccess === 'function') {
            req.onsuccess({ target: req });
          }
          this._markDone();
          return;
        }
        const cursor = {
          value: values[index],
          continue: () => {
            index += 1;
            setTimeout(emit, 0);
          }
        };
        req.result = cursor;
        if (typeof req.onsuccess === 'function') {
          req.onsuccess({ target: req });
        }
      };
      setTimeout(emit, 0);
      return req;
    }
  }

  class FakeTransaction {
    constructor(db, storeName) {
      this._db = db;
      this._storeName = storeName;
      this._pending = 0;
      this._completeScheduled = false;
      this.error = null;
      this.onabort = null;
      this.onerror = null;
      this.oncomplete = null;
      setTimeout(() => this._maybeComplete(), 0);
    }

    objectStore(name) {
      const storeName = String(name || this._storeName || '');
      const storeDef = this._db._stores[storeName];
      if (!storeDef) {
        throw new Error(`Store not found: ${storeName}`);
      }
      return new FakeObjectStore(storeDef, this);
    }

    _startRequest() {
      this._pending += 1;
      this._completeScheduled = false;
    }

    _finishRequest() {
      this._pending = Math.max(0, this._pending - 1);
      this._maybeComplete();
    }

    _maybeComplete() {
      if (this._pending > 0 || this._completeScheduled) {
        return;
      }
      this._completeScheduled = true;
      setTimeout(() => {
        if (typeof this.oncomplete === 'function') {
          this.oncomplete({ target: this });
        }
      }, 0);
    }
  }

  class FakeDb {
    constructor(meta) {
      this._meta = meta;
      this._stores = meta.stores;
      this.objectStoreNames = {
        contains: (name) => Object.prototype.hasOwnProperty.call(this._stores, String(name || ''))
      };
    }

    createObjectStore(name, options) {
      const storeName = String(name || '');
      if (!this._stores[storeName]) {
        this._stores[storeName] = {
          keyPath: options && options.keyPath ? String(options.keyPath) : 'id',
          indexes: {},
          data: new Map()
        };
      }
      return new FakeObjectStore(this._stores[storeName], null);
    }

    transaction(storeName) {
      return new FakeTransaction(this, String(storeName || ''));
    }
  }

  const dbMap = new Map();
  return {
    open(name, version) {
      const req = new FakeRequest();
      setTimeout(() => {
        const dbName = String(name || '');
        const requestedVersion = Number.isFinite(Number(version)) ? Number(version) : 1;
        let meta = dbMap.get(dbName);
        const shouldUpgrade = !meta || requestedVersion > meta.version;
        if (!meta) {
          meta = {
            version: requestedVersion,
            stores: {}
          };
          dbMap.set(dbName, meta);
        } else if (requestedVersion > meta.version) {
          meta.version = requestedVersion;
        }
        const db = new FakeDb(meta);
        req.result = db;
        if (shouldUpgrade && typeof req.onupgradeneeded === 'function') {
          req.onupgradeneeded({ target: req });
        }
        setTimeout(() => {
          if (typeof req.onsuccess === 'function') {
            req.onsuccess({ target: req });
          }
        }, 0);
      }, 0);
      return req;
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  global.NT = {};
  global.indexedDB = createFakeIndexedDb();

  load('extension/core/chrome-local-store-base.js');
  load('extension/bg/translation-memory-store.js');

  const TranslationMemoryStore = global.NT && global.NT.TranslationMemoryStore;
  assert(TranslationMemoryStore, 'TranslationMemoryStore must be defined');

  const chromeApi = createChromeApi();
  const store = new TranslationMemoryStore({ chromeApi });
  const init = await store.init();
  assert(init && init.ok === true, 'Memory store init should succeed');

  for (let i = 1; i <= 12; i += 1) {
    await store.upsertPage({
      pageKey: `page:${i}`,
      url: 'https://example.com/a',
      domHash: `dom:${i}`,
      domSigVersion: 'v1',
      targetLang: 'ru',
      categories: {},
      blocks: {}
    });
    await delay(1);
  }

  for (let i = 1; i <= 55; i += 1) {
    await store.upsertBlock({
      blockKey: `block:${i}`,
      originalHash: `orig:${i}`,
      targetLang: 'ru',
      translatedText: `text:${i}`,
      sourcePageKeys: [`page:${Math.max(1, Math.min(12, i % 12))}`]
    });
  }

  const page = await store.getPage('page:1');
  assert(page && page.pageKey === 'page:1', 'Page lookup by key should work');
  const block = await store.getBlock('block:1');
  assert(block && block.blockKey === 'block:1', 'Block lookup by key should work');

  const best = await store.findBestPage({
    pageKey: 'page:1',
    normalizedUrl: 'https://example.com/a',
    domHash: 'dom:1'
  });
  assert(best && best.page && best.page.pageKey === 'page:1', 'findBestPage should return exact page');
  assert.strictEqual(best.matchType, 'exact_page_key', 'Exact key lookup matchType expected');

  const beforeStats = await store.getStats();
  assert(beforeStats.counters.pages >= 12, 'Expected >=12 pages before GC');
  assert(beforeStats.counters.blocks >= 55, 'Expected >=55 blocks before GC');

  const gc = await store.runGc({
    maxPages: 10,
    maxBlocks: 50,
    maxAgeDays: 365
  });
  assert(gc && gc.ok === true, 'GC should succeed');

  const afterStats = await store.getStats();
  assert(afterStats.counters.pages <= 10, 'GC must cap pages by maxPages');
  assert(afterStats.counters.blocks <= 50, 'GC must cap blocks by maxBlocks');

  const index = await store.getIndex();
  assert(index && index.counters && Number.isFinite(Number(index.counters.pages)), 'Index counters must be maintained');

  console.log('PASS: translation memory store');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
