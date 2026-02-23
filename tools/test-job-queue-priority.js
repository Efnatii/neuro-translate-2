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
  await queue.setActiveTab(2);
  await queue.enqueue('job-tab1', 0, 'seed', { tabId: 1 });
  await queue.enqueue('job-tab2', 0, 'seed', { tabId: 2 });
  await queue.enqueue('job-tab3', 0, 'seed', { tabId: 3 });

  const counts = { 1: 0, 2: 0, 3: 0 };
  for (let i = 0; i < 9; i += 1) {
    const next = await queue.dequeueNext({ now: Date.now(), activeTabId: 2 });
    counts[next.tabId] = (counts[next.tabId] || 0) + 1;
  }

  assert(counts[2] > counts[1], 'active tab should receive more dequeue slots than tab 1');
  assert(counts[2] > counts[3], 'active tab should receive more dequeue slots than tab 3');
  console.log('PASS: job-queue priority');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});