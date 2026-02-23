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

function createFakeChrome() {
  const alarms = new Map();
  let createCalls = 0;
  const alarmListeners = [];
  return {
    chromeApi: {
      alarms: {
        getAll(cb) {
          cb(Array.from(alarms.values()).map((entry) => ({ ...entry })));
        },
        create(name, options) {
          createCalls += 1;
          alarms.set(name, { name, ...(options || {}) });
        },
        onAlarm: {
          addListener(fn) {
            alarmListeners.push(fn);
          }
        }
      }
    },
    stats() {
      return {
        createCalls,
        alarms: Array.from(alarms.values()).map((entry) => ({ ...entry })),
        listeners: alarmListeners.length
      };
    }
  };
}

async function run() {
  global.NT = {};
  load('extension/bg/scheduler.js');
  const Scheduler = global.NT.Scheduler;
  assert(Scheduler, 'Scheduler must be defined');

  const env = createFakeChrome();
  let stepped = 0;
  const scheduler = new Scheduler({
    chromeApi: env.chromeApi,
    jobStore: {
      async listActiveJobs() {
        return [];
      }
    },
    jobRunner: {
      async step() {
        stepped += 1;
        return { ok: true };
      }
    }
  });

  const first = await scheduler.ensureAlarms();
  assert.strictEqual(first.ok, true, 'ensureAlarms should succeed');
  const statsAfterFirst = env.stats();
  assert.strictEqual(statsAfterFirst.alarms.some((item) => item.name === 'nt.tick'), true, 'nt.tick must be created when missing');
  assert.strictEqual(statsAfterFirst.createCalls, 1, 'first ensure must create nt.tick once');

  const second = await scheduler.ensureAlarms();
  assert.strictEqual(second.ok, true, 'second ensure should succeed');
  const statsAfterSecond = env.stats();
  assert.strictEqual(statsAfterSecond.createCalls, 1, 'second ensure must not recreate existing nt.tick');

  await scheduler.kickNow({ delayMs: 200, reason: 'test' });
  const statsAfterKick = env.stats();
  assert.strictEqual(statsAfterKick.alarms.some((item) => item.name === 'nt.wake'), true, 'kickNow should create nt.wake');

  const tickRes = await scheduler.tick('unit');
  assert.strictEqual(tickRes.ok, true, 'tick should complete');
  assert.strictEqual(stepped, 0, 'no jobs means no step calls');

  console.log('PASS: scheduler alarms');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
