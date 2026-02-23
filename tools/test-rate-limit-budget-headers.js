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

async function run() {
  global.NT = {};
  load('extension/core/chrome-local-store-base.js');
  load('extension/core/duration.js');
  load('extension/bg/rate-limit-budget-store.js');

  const Store = global.NT.RateLimitBudgetStore;
  assert(Store, 'RateLimitBudgetStore must be defined');

  const store = new Store({ chromeApi: createChromeApi() });
  const now = Date.now();
  await store.updateFromHeaders({
    provider: 'openai',
    model: 'gpt-4o-mini',
    headersSubset: {
      'x-ratelimit-remaining-requests': '12',
      'x-ratelimit-remaining-tokens': '24000',
      'x-ratelimit-reset-requests': '5',
      'x-ratelimit-reset-tokens': '7'
    },
    ts: now
  });

  const snapshot = await store.getBudgetSnapshot({ provider: 'openai' });
  assert.strictEqual(snapshot.requestsRemaining, 12, 'requestsRemaining should be parsed from headers');
  assert.strictEqual(snapshot.tokensRemaining, 24000, 'tokensRemaining should be parsed from headers');
  assert(snapshot.resetAt >= now + 5000, 'resetAt should be projected from reset headers');

  const on429 = await store.on429({ provider: 'openai', retryAfterMs: 1500 });
  assert.strictEqual(on429.ok, true, 'on429 should update cooldown');
  const after429 = await store.getBudgetSnapshot({ provider: 'openai' });
  assert(after429.cooldownUntilTs && after429.cooldownUntilTs > Date.now(), 'cooldown must be active after on429');

  console.log('PASS: rate-limit budget update headers');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});