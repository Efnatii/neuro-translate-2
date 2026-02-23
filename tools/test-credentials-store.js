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

function createChromeApi() {
  const localState = {};
  const sessionState = {};
  const makeArea = (state) => ({
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
    },
    remove(keys, cb) {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => {
        delete state[key];
      });
      if (typeof cb === 'function') {
        cb();
      }
    }
  });
  return {
    storage: {
      local: makeArea(localState),
      session: makeArea(sessionState)
    },
    _dump() {
      return {
        local: { ...localState },
        session: { ...sessionState }
      };
    }
  };
}

async function run() {
  global.NT = {};
  load('extension/bg/credentials-store.js');

  const CredentialsStore = global.NT.CredentialsStore;
  assert(CredentialsStore, 'CredentialsStore must be defined');

  const chromeApi = createChromeApi();
  const store = new CredentialsStore({ chromeApi });
  const keys = store.getStorageKeys();

  assert.strictEqual(await store.getMode(), 'PROXY', 'Default mode should be PROXY');

  await store.setByokKey('sk-session-key-abc', { persist: false });
  assert.strictEqual(await store.getMode(), 'BYOK', 'BYOK set should switch mode to BYOK');
  assert.strictEqual(await store.getByokKey(), 'sk-session-key-abc', 'Session BYOK key should be readable');

  const afterSessionSave = chromeApi._dump();
  const localPayload = afterSessionSave.local[keys.localKey] || {};
  const sessionPayload = afterSessionSave.session[keys.sessionKey] || {};
  assert.strictEqual(localPayload.byokPersist, false, 'Session BYOK must not set persistent flag');
  assert.strictEqual(localPayload.byokKey, '', 'Session BYOK must not persist key in local storage');
  assert.strictEqual(sessionPayload.byokKey, 'sk-session-key-abc', 'Session BYOK must be stored in storage.session');

  await store.setByokKey('sk-persist-key-xyz', { persist: true });
  assert.strictEqual(await store.getByokKey(), 'sk-persist-key-xyz', 'Persistent BYOK key should be readable');

  const afterPersistSave = chromeApi._dump();
  const localPayloadPersist = afterPersistSave.local[keys.localKey] || {};
  const sessionPayloadPersist = afterPersistSave.session[keys.sessionKey] || {};
  assert.strictEqual(localPayloadPersist.byokPersist, true, 'Persistent BYOK must set byokPersist');
  assert.strictEqual(localPayloadPersist.byokKey, 'sk-persist-key-xyz', 'Persistent BYOK key must be in local storage');
  assert.strictEqual(sessionPayloadPersist.byokKey || '', '', 'Persistent BYOK should clear session copy');

  await store.clearByokKey();
  assert.strictEqual(await store.getByokKey(), null, 'clearByokKey must remove BYOK key from all storages');

  await store.setProxyConfig({
    baseUrl: 'https://proxy.example.com/v1/',
    authHeaderName: 'X-NT-Token',
    authToken: 'proxy-token-session',
    persistToken: false
  });
  const proxySession = await store.getProxyConfig();
  assert.strictEqual(proxySession.baseUrl, 'https://proxy.example.com/v1', 'Proxy URL must be normalized');
  assert.strictEqual(proxySession.authToken, 'proxy-token-session', 'Session proxy token should be readable');
  assert.strictEqual(proxySession.authTokenPersisted, false, 'Session proxy token must not be flagged persisted');

  await store.setProxyConfig({
    baseUrl: 'https://proxy.example.com',
    authHeaderName: 'X-NT-Token',
    authToken: 'proxy-token-persist',
    persistToken: true
  });
  const proxyPersist = await store.getProxyConfig();
  assert.strictEqual(proxyPersist.authToken, 'proxy-token-persist', 'Persistent proxy token should be readable');
  assert.strictEqual(proxyPersist.authTokenPersisted, true, 'Persistent proxy token must be flagged persisted');

  console.log('PASS: credentials store');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
