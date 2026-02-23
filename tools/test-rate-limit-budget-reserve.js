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
  await store.updateFromHeaders({
    provider: 'openai',
    headersSubset: {
      'x-ratelimit-remaining-requests': '1',
      'x-ratelimit-remaining-tokens': '500',
      'x-ratelimit-reset-requests': '2'
    },
    ts: Date.now()
  });

  const first = await store.reserve({ provider: 'openai', jobId: 'job-1', estRequests: 1, estTokens: 100 });
  assert.strictEqual(first.ok, true, 'first reserve must succeed');

  const second = await store.reserve({ provider: 'openai', jobId: 'job-2', estRequests: 1, estTokens: 100 });
  assert.strictEqual(second.ok, false, 'second reserve should wait when remaining requests are exhausted');
  assert(second.waitMs > 0, 'reserve waitMs must be > 0 when budget is exhausted');

  await store.release({ grantId: first.grantId, usedTokens: 120, usedRequests: 1 });
  const third = await store.reserve({ provider: 'openai', jobId: 'job-3', estRequests: 1, estTokens: 50 });
  assert.strictEqual(third.ok, true, 'reserve should succeed after grant release');

  console.log('PASS: rate-limit budget reserve/wait');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});