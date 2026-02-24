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

async function run() {
  global.NT = {};
  global.indexedDB = createFakeIndexedDb();

  load('extension/core/chrome-local-store-base.js');
  load('extension/bg/translation-memory-store.js');

  const Store = global.NT.TranslationMemoryStore;
  assert(Store, 'TranslationMemoryStore must exist');

  const store = new Store({ chromeApi: createChromeApi() });
  const init = await store.init();
  assert(init && init.ok === true, 'store init must succeed');

  const base = await store.upsertPage({
    pageKey: 'page:1',
    url: 'https://example.com',
    domHash: 'dom:a',
    targetLang: 'ru',
    blocks: {},
    categories: {}
  });
  assert(base && base.ok === true, 'base page write should succeed');
  assert.strictEqual(base.rev, 1, 'first page write should create rev=1');

  const second = await store.upsertPage({
    pageKey: 'page:1',
    domHash: 'dom:b'
  }, { expectedRev: 1 });
  assert(second && second.ok === true, 'write with matching expectedRev should succeed');
  assert.strictEqual(second.rev, 2, 'revision should increment to 2');

  const strictConflict = await store.upsertPage({
    pageKey: 'page:1',
    domHash: 'dom:c'
  }, { expectedRev: 1, maxRetries: 0 });
  assert.strictEqual(strictConflict.ok, false, 'stale expectedRev with maxRetries=0 should fail');
  assert.strictEqual(strictConflict.code, 'REV_CONFLICT', 'stale write should return REV_CONFLICT');

  const mergeRetry = await store.upsertPage({
    pageKey: 'page:1',
    domHash: 'dom:d'
  }, { expectedRev: 1, maxRetries: 2 });
  assert.strictEqual(mergeRetry.ok, true, 'stale expectedRev should recover via merge/retry when retries allowed');
  assert.strictEqual(mergeRetry.hadConflict, true, 'merge/retry path should flag conflict');

  await store.upsertBlock({
    blockKey: 'block:1',
    originalHash: 'orig:1',
    targetLang: 'ru',
    translatedText: 'newer',
    updatedAt: 200
  });
  await store.upsertBlock({
    blockKey: 'block:1',
    originalHash: 'orig:1',
    targetLang: 'ru',
    translatedText: 'older',
    updatedAt: 100
  });
  const block = await store.getBlock('block:1');
  assert.strictEqual(block.translatedText, 'newer', 'block writes should be last-write-wins by updatedAt');

  await store.upsertBlock({
    blockKey: 'block:quality',
    originalHash: 'orig:quality',
    targetLang: 'ru',
    translatedText: 'proofread-text',
    qualityTag: 'proofread',
    updatedAt: 300
  });
  await store.upsertBlock({
    blockKey: 'block:quality',
    originalHash: 'orig:quality',
    targetLang: 'ru',
    translatedText: 'raw-newer',
    qualityTag: 'raw',
    updatedAt: 400
  });
  const preferredOverRaw = await store.getBlock('block:quality');
  assert.strictEqual(preferredOverRaw.qualityTag, 'proofread', 'raw update should not downgrade better cached quality');
  assert.strictEqual(preferredOverRaw.translatedText, 'proofread-text', 'raw update should not replace higher-quality text');

  await store.upsertBlock({
    blockKey: 'block:quality',
    originalHash: 'orig:quality',
    targetLang: 'ru',
    translatedText: 'styled-older',
    qualityTag: 'styled',
    updatedAt: 250
  });
  const upgradedByQuality = await store.getBlock('block:quality');
  assert.strictEqual(upgradedByQuality.qualityTag, 'styled', 'higher-quality tag should win even with older updatedAt');
  assert.strictEqual(upgradedByQuality.translatedText, 'styled-older', 'higher-quality cached text should be preserved');

  console.log('PASS: translation memory concurrency');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
