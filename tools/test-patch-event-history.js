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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MemoryJobStore {
  constructor() {
    this.jobs = {};
    this.activeByTab = {};
    this.indexByTab = {};
  }

  async getJob(jobId) {
    return this.jobs[jobId] || null;
  }

  async upsertJob(job) {
    this.jobs[job.id] = { ...(this.jobs[job.id] || {}), ...(job || {}) };
    return this.jobs[job.id];
  }

  async setActiveJob(tabId, jobId) {
    const key = String(tabId);
    this.activeByTab[key] = jobId;
    this.indexByTab[key] = { activeJobId: jobId, lastJobId: jobId, updatedAt: Date.now() };
  }

  async clearActiveJob(tabId, jobId) {
    const key = String(tabId);
    if (jobId && this.activeByTab[key] && this.activeByTab[key] !== jobId) {
      return;
    }
    this.activeByTab[key] = null;
    this.indexByTab[key] = { ...(this.indexByTab[key] || {}), activeJobId: null, updatedAt: Date.now() };
  }

  async getLastJobId(tabId) {
    const key = String(tabId);
    const row = this.indexByTab[key] || null;
    return row && row.lastJobId ? row.lastJobId : null;
  }
}

async function run() {
  global.NT = {};
  load('extension/core/message-envelope.js');
  load('extension/core/translation-protocol.js');
  load('extension/bg/translation-orchestrator.js');

  const Orchestrator = global.NT.TranslationOrchestrator;
  assert(Orchestrator, 'TranslationOrchestrator must be defined');

  const store = new MemoryJobStore();
  const orchestrator = new Orchestrator({
    chromeApi: {},
    settingsStore: { async get() { return { translationPipelineEnabled: true }; } },
    tabStateStore: {
      async upsertStatusPatch() {},
      async getDisplayMode() { return 'translated'; }
    },
    jobStore: store
  });

  const now = Date.now();
  const job = {
    id: 'job-patch-1',
    tabId: 77,
    status: 'running',
    message: 'running',
    createdAt: now,
    updatedAt: now,
    leaseUntilTs: now + 60_000,
    totalBlocks: 1,
    completedBlocks: 0,
    pendingBlockIds: ['b1'],
    failedBlockIds: [],
    blocksById: {
      b1: {
        blockId: 'b1',
        category: 'paragraph',
        originalText: 'Hello world',
        translatedText: ''
      }
    },
    agentState: {
      phase: 'execution',
      patchHistory: [],
      patchSeq: 0
    }
  };
  await store.upsertJob(job);
  await store.setActiveJob(job.tabId, job.id);

  for (let i = 0; i < 10; i += 1) {
    orchestrator._queuePatchEvent(job, {
      blockId: 'b1',
      phase: 'execution',
      kind: 'delta',
      prev: { textHash: `h${i}`, textPreview: `prev-${i}` },
      next: { textHash: `h${i + 1}`, textPreview: `next-${i}` }
    }, { debounceKey: 'delta:b1' });
  }
  await sleep(orchestrator.PATCH_DELTA_DEBOUNCE_MS + 140);

  const afterDebounce = await store.getJob(job.id);
  const debouncedHistory = afterDebounce && afterDebounce.agentState && Array.isArray(afterDebounce.agentState.patchHistory)
    ? afterDebounce.agentState.patchHistory
    : [];
  assert.strictEqual(debouncedHistory.length, 1, '10 delta events within debounce window should collapse into 1 event');
  assert.strictEqual(debouncedHistory[0].kind, 'delta', 'Collapsed event kind must remain delta');

  orchestrator._queuePatchEvent(afterDebounce, {
    blockId: 'b1',
    phase: 'execution',
    kind: 'final',
    prev: { textHash: 'h-prev', textPreview: 'prev-final' },
    next: { textHash: 'h-next', textPreview: 'next-final' }
  });
  await orchestrator._flushPatchEvents(job.id, { forceSave: true });
  const afterFinal = await store.getJob(job.id);
  const history = afterFinal && afterFinal.agentState && Array.isArray(afterFinal.agentState.patchHistory)
    ? afterFinal.agentState.patchHistory
    : [];
  assert(history.length >= 2, 'Final event must be appended after debounced delta event');
  for (let i = 1; i < history.length; i += 1) {
    assert(history[i].seq > history[i - 1].seq, 'PatchEvent seq must be strictly monotonic');
  }

  console.log('PASS: patch event history');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
