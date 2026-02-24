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

function createChromeApiMock() {
  const storage = {};
  return {
    storage,
    chromeApi: {
      storage: {
        local: {
          get(defaults, callback) {
            const out = {};
            const src = defaults && typeof defaults === 'object' ? defaults : {};
            Object.keys(src).forEach((key) => {
              out[key] = Object.prototype.hasOwnProperty.call(storage, key)
                ? storage[key]
                : src[key];
            });
            callback(out);
          },
          set(payload, callback) {
            const src = payload && typeof payload === 'object' ? payload : {};
            Object.keys(src).forEach((key) => {
              storage[key] = src[key];
            });
            if (typeof callback === 'function') {
              callback();
            }
          }
        }
      }
    }
  };
}

async function run() {
  global.NT = {};
  load('extension/core/chrome-local-store-base.js');
  load('extension/core/perf-profiler.js');
  load('extension/bg/translation-orchestrator.js');

  const PerfProfiler = global.NT && global.NT.PerfProfiler;
  const TranslationOrchestrator = global.NT && global.NT.TranslationOrchestrator;
  assert(PerfProfiler, 'PerfProfiler must be defined');
  assert(TranslationOrchestrator, 'TranslationOrchestrator must be defined');

  const { storage, chromeApi } = createChromeApiMock();
  const profiler = new PerfProfiler({
    chromeApi,
    flushDebounceMs: 10
  });
  await profiler.init();

  profiler.attachJobContext('job-1', { tabId: 7, status: 'running' });
  profiler.recordJobMetric('job-1', 'scanTimeMs', 123);
  profiler.recordJobMetric('job-1', 'classifyTimeMs', 34);
  profiler.recordJobMetric('job-1', 'applyDeltaCount', 4);
  profiler.recordJobMetric('job-1', 'deltaLatencyMs', 50);
  profiler.recordJobMetric('job-1', 'deltaLatencyMs', 70);
  profiler.recordJobMetric('job-1', 'memoryCacheLookup', 10);
  profiler.recordJobMetric('job-1', 'memoryCacheHit', 7);
  profiler.recordJobMetric('job-1', 'storageBytesEstimate', 2048);
  profiler.recordJobMetric('job-1', 'offscreenBytesOut', 512);
  profiler.recordJobMetric('job-1', 'offscreenBytesIn', 256);

  const orchestratorCoalesce = TranslationOrchestrator.prototype._computeCoalescedCountFromTrace.call({}, {
    agentState: {
      toolExecutionTrace: [
        { qos: { coalescedCount: 2 } },
        { meta: { qos: { coalescedCount: 1 } } },
        { qos: { coalescedCount: 3 } },
        { qos: { coalescedCount: 0 } }
      ]
    }
  });
  assert.strictEqual(orchestratorCoalesce, 6, 'coalesced count must be summed from trace');

  profiler.recordJobMetric('job-1', 'coalescedCount', orchestratorCoalesce);
  const snapshot = profiler.getSnapshot();
  const row = Array.isArray(snapshot.jobs)
    ? snapshot.jobs.find((item) => item && item.jobId === 'job-1')
    : null;
  assert(row, 'job row must exist in snapshot');
  assert.strictEqual(row.metrics.scanTimeMs, 123, 'scan metric must be recorded');
  assert.strictEqual(row.metrics.classifyTimeMs, 34, 'classify metric must be recorded');
  assert.strictEqual(row.metrics.applyDeltaCount, 4, 'apply count must be recorded');
  assert.strictEqual(row.metrics.avgDeltaLatencyMs, 60, 'avg delta latency must be aggregated');
  assert.strictEqual(row.metrics.memoryCacheHitRate, 0.7, 'cache hit rate must be calculated');
  assert.strictEqual(row.metrics.coalescedCount, 6, 'coalesced count must be recorded');
  assert.strictEqual(row.metrics.storageBytesEstimate, 2048, 'storage size estimate must be recorded');

  const withoutCoalesce = row.metrics.applyDeltaCount + row.metrics.coalescedCount;
  assert(withoutCoalesce > row.metrics.applyDeltaCount, 'coalescing should reduce actual apply count');

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(Object.prototype.hasOwnProperty.call(storage, 'nt.perf.v1'), 'snapshot must persist to storage.local');

  console.log('PASS: perf profiler + coalesce metrics');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
