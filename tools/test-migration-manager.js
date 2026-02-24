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
        },
        remove(keys, cb) {
          const list = Array.isArray(keys) ? keys : [keys];
          list.forEach((key) => {
            if (typeof key === 'string' && Object.prototype.hasOwnProperty.call(state, key)) {
              delete state[key];
            }
          });
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

async function run() {
  global.NT = {};
  load('extension/core/chrome-local-store-base.js');
  load('extension/bg/translation-job-store.js');
  load('extension/bg/inflight-request-store.js');
  load('extension/bg/migration-manager.js');

  const chromeApi = createChromeApi({});
  const jobStore = new global.NT.TranslationJobStore({ chromeApi });
  const inflightStore = new global.NT.InflightRequestStore({ chromeApi });
  const manager = new global.NT.MigrationManager({
    chromeApi,
    translationJobStore: jobStore,
    inflightStore
  });

  const corruptJob = {
    id: 'job-corrupt-1',
    tabId: 7,
    status: 'running',
    message: 'Running',
    totalBlocks: 3,
    completedBlocks: 1,
    pendingBlockIds: [],
    failedBlockIds: [],
    blocksById: { b1: { blockId: 'b1', originalText: 'A' } },
    runtime: {
      status: 'RUNNING',
      stage: 'execution',
      lease: {
        leaseUntilTs: null,
        op: 'translate_batch',
        opId: null
      }
    }
  };
  await jobStore.replaceSnapshot({
    translationSchemaVersion: 3,
    translationJobsByTab: { 7: 'job-corrupt-1' },
    translationJobsById: { 'job-corrupt-1': corruptJob },
    translationJobIndexByTab: { 7: { activeJobId: 'job-corrupt-1', lastJobId: 'job-corrupt-1', updatedAt: Date.now() } }
  });

  const integrity = await manager.verifyIntegrity();
  assert.strictEqual(integrity.ok, true, 'Integrity verification should succeed');
  const repairedSnapshot = await jobStore.getSnapshot();
  const repairedJob = repairedSnapshot.translationJobsById['job-corrupt-1'];
  assert(repairedJob, 'Corrupt job should still exist after repair');
  assert.strictEqual(repairedJob.status, 'failed', 'Corrupt running job must be forced to FAILED');
  assert(repairedJob.lastError && repairedJob.lastError.code === 'STATE_CORRUPT', 'Corrupt job must carry STATE_CORRUPT');

  const hugeJob = {
    id: 'job-big-1',
    tabId: 10,
    status: 'awaiting_categories',
    totalBlocks: 12,
    completedBlocks: 0,
    pendingBlockIds: [],
    failedBlockIds: [],
    blocksById: {},
    recentDiffItems: Array.from({ length: 30 }, (_, idx) => ({
      blockId: `b${idx}`,
      before: `before-${idx}`,
      after: `after-${idx}`
    })),
    agentState: {
      toolExecutionTrace: Array.from({ length: 150 }, (_, idx) => ({ idx, tool: 'x', payload: 'y'.repeat(300) })),
      patchHistory: Array.from({ length: 160 }, (_, idx) => ({
        seq: idx + 1,
        prev: { textPreview: 'p'.repeat(500) },
        next: { textPreview: 'n'.repeat(500) }
      })),
      reports: Array.from({ length: 120 }, (_, idx) => ({ ts: Date.now() - idx, code: `R${idx}` })),
      rateLimitHistory: Array.from({ length: 90 }, (_, idx) => ({ ts: Date.now() - idx, model: 'gpt-5-mini' }))
    }
  };

  const compactFirst = jobStore.compactJobState(hugeJob, {
    traceLimit: 20,
    patchLimit: 25,
    reportsLimit: 18,
    rateLimitLimit: 16,
    diffLimit: 10,
    sizeThresholdBytes: 3000,
    hardSizeThresholdBytes: 8000
  });
  assert.strictEqual(compactFirst.changed, true, 'Compaction should mutate oversized job');
  assert(compactFirst.sizeAfter < compactFirst.sizeBefore, 'Compaction must reduce serialized size');
  assert(hugeJob.agentState.toolExecutionTrace.length <= 20, 'toolExecutionTrace should keep last N');
  assert(hugeJob.agentState.patchHistory.length <= 25, 'patchHistory should keep last N');
  assert(hugeJob.agentState.rateLimitHistory.length <= 16, 'rateLimitHistory should keep last N');
  assert(hugeJob.agentState.reports.length <= 18, 'reports should keep last N');
  assert(hugeJob.recentDiffItems.length <= 10, 'recentDiffItems should keep last N');

  const compactSecond = jobStore.compactJobState(hugeJob, {
    traceLimit: 20,
    patchLimit: 25,
    reportsLimit: 18,
    rateLimitLimit: 16,
    diffLimit: 10,
    sizeThresholdBytes: 3000,
    hardSizeThresholdBytes: 8000
  });
  assert.strictEqual(compactSecond.changed, false, 'Second compaction should be idempotent at limits');
  const reports = Array.isArray(hugeJob.agentState.reports) ? hugeJob.agentState.reports : [];
  const compactReports = reports.filter((row) => row && row.code === 'STATE_COMPACTED');
  assert.strictEqual(compactReports.length, 1, 'STATE_COMPACTED report should be emitted only once');

  console.log('PASS: migration manager integrity + compaction');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
