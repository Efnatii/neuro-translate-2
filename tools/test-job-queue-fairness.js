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
  load('extension/bg/job-queue.js');

  const JobQueue = global.NT.JobQueue;
  assert(JobQueue, 'JobQueue must be defined');

  const queue = new JobQueue({ chromeApi: createChromeApi() });

  await queue.enqueue('job-tab1', 0, 'seed', { tabId: 1 });
  await queue.enqueue('job-tab2', 0, 'seed', { tabId: 2 });
  await queue.enqueue('job-tab3', 0, 'seed', { tabId: 3 });

  const picked = [];
  for (let i = 0; i < 3; i += 1) {
    const next = await queue.dequeueNext({ now: Date.now() });
    picked.push(next && next.tabId);
  }

  assert.deepStrictEqual(picked, [1, 2, 3], 'round-robin dequeue should iterate tabs fairly');
  console.log('PASS: job-queue fairness');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});