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

function createChromeApi(initialState = {}) {
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

async function run() {
  const createdStores = [];
  const existingStores = new Set(['pages', 'blocks']);
  let requestedVersion = null;

  global.indexedDB = {
    open(_name, version) {
      requestedVersion = version;
      const request = {};
      setTimeout(() => {
        const db = {
          objectStoreNames: {
            contains(storeName) {
              return existingStores.has(storeName);
            }
          },
          createObjectStore(storeName) {
            existingStores.add(storeName);
            createdStores.push(storeName);
            return {
              createIndex() {}
            };
          }
        };
        request.result = db;
        if (typeof request.onupgradeneeded === 'function') {
          request.onupgradeneeded({ oldVersion: 1, newVersion: version, target: request });
        }
        if (typeof request.onsuccess === 'function') {
          request.onsuccess({ target: request });
        }
      }, 0);
      return request;
    }
  };

  global.NT = {};
  load('extension/core/chrome-local-store-base.js');
  load('extension/bg/translation-memory-store.js');

  const chromeApi = createChromeApi({});
  const store = new global.NT.TranslationMemoryStore({ chromeApi });
  const initResult = await store.init();
  assert(initResult && initResult.ok === true, 'TranslationMemoryStore init should succeed');
  assert.strictEqual(requestedVersion, 2, 'IDB version must be bumped to 2');
  assert(createdStores.includes('quarantine'), 'Upgrade should add quarantine store');
  assert(!createdStores.includes('pages'), 'Existing pages store must be preserved');
  assert(!createdStores.includes('blocks'), 'Existing blocks store must be preserved');

  console.log('PASS: translation memory idb upgrade');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
