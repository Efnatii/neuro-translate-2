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

class MemoryJobStore {
  constructor() {
    this.jobsByTab = {};
    this.jobsById = {};
    this.indexByTab = {};
  }

  async getJob(jobId) {
    return this.jobsById[jobId] || null;
  }

  async upsertJob(job) {
    this.jobsById[job.id] = { ...(this.jobsById[job.id] || {}), ...(job || {}) };
    return this.jobsById[job.id];
  }

  async setActiveJob(tabId, jobId) {
    const key = String(tabId);
    this.jobsByTab[key] = jobId;
    this.indexByTab[key] = {
      activeJobId: jobId,
      lastJobId: jobId,
      updatedAt: Date.now()
    };
  }

  async clearActiveJob(tabId, jobId) {
    const key = String(tabId);
    if (jobId && this.jobsByTab[key] && this.jobsByTab[key] !== jobId) {
      return;
    }
    this.jobsByTab[key] = null;
    this.indexByTab[key] = {
      ...(this.indexByTab[key] || {}),
      activeJobId: null,
      lastJobId: jobId || (this.indexByTab[key] ? this.indexByTab[key].lastJobId : null),
      updatedAt: Date.now()
    };
  }

  async getActiveJob(tabId) {
    const key = String(tabId);
    const jobId = this.jobsByTab[key];
    return jobId ? this.jobsById[jobId] || null : null;
  }

  async getLastJobId(tabId) {
    const key = String(tabId);
    return this.indexByTab[key] ? this.indexByTab[key].lastJobId : null;
  }

  async listActiveJobs() {
    return Object.keys(this.jobsByTab)
      .map((tabId) => this.jobsByTab[tabId])
      .filter(Boolean)
      .map((jobId) => this.jobsById[jobId])
      .filter(Boolean);
  }
}

async function run() {
  global.NT = {};
  load('extension/core/message-envelope.js');
  load('extension/core/event-types.js');
  load('extension/core/translation-protocol.js');
  load('extension/bg/translation-orchestrator.js');

  const protocol = global.NT.TranslationProtocol;
  const Orchestrator = global.NT.TranslationOrchestrator;
  assert(Orchestrator, 'TranslationOrchestrator must be defined');
  function unwrapOutgoing(msg) {
    const Env = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
    if (Env && typeof Env.isEnvelope === 'function' && Env.isEnvelope(msg)) {
      return {
        type: msg.type || null,
        payload: msg && msg.payload && typeof msg.payload === 'object' ? msg.payload : {}
      };
    }
    return {
      type: msg && msg.type ? msg.type : null,
      payload: msg && typeof msg === 'object' ? msg : {}
    };
  }

  const sentMessages = [];
  const injectedTabs = [];
  const tabStatuses = {};
  const now = Date.now();

  const chromeApi = {
    runtime: {
      lastError: null
    },
    scripting: {
      async executeScript(args) {
        const targetTabId = args && args.target && Number.isFinite(Number(args.target.tabId))
          ? Number(args.target.tabId)
          : null;
        injectedTabs.push(targetTabId);
      }
    },
    tabs: {
      get(tabId, cb) {
        cb({ id: Number(tabId), url: 'https://example.test/lease' });
      },
      query(_queryInfo, cb) {
        cb([]);
      },
      sendMessage(tabId, message, cb) {
        const outgoing = unwrapOutgoing(message);
        sentMessages.push({ tabId, message, type: outgoing.type || 'unknown', payload: outgoing.payload || {} });
        cb({ ok: true });
      }
    }
  };

  const jobStore = new MemoryJobStore();
  const orchestrator = new Orchestrator({
    chromeApi,
    settingsStore: {
      async get() {
        return {};
      }
    },
    tabStateStore: {
      async upsertStatusPatch(tabId, patch) {
        tabStatuses[tabId] = { ...(tabStatuses[tabId] || {}), ...(patch || {}) };
      },
      async upsertVisibility() {}
    },
    jobStore,
    translationCall: {
      async translateBatch() {
        return { items: [] };
      }
    },
    onUiPatch: () => {}
  });

  await jobStore.upsertJob({
    id: 'job-lease-1',
    tabId: 301,
    url: 'https://example.test/lease',
    targetLang: 'ru',
    status: 'running',
    createdAt: now - (5 * 60 * 1000),
    updatedAt: now - (5 * 60 * 1000),
    leaseUntilTs: now - 1000,
    totalBlocks: 1,
    completedBlocks: 0,
    pendingBlockIds: ['b1'],
    failedBlockIds: [],
    blocksById: {
      b1: {
        blockId: 'b1',
        originalText: 'Hi',
        category: 'paragraph'
      }
    },
    currentBatchId: null,
    lastError: null,
    message: 'Running'
  });
  await jobStore.setActiveJob(301, 'job-lease-1');

  await orchestrator.restoreStateAfterRestart();

  const recovered = await jobStore.getJob('job-lease-1');
  assert(recovered, 'Recovered job should exist');
  assert.notStrictEqual(recovered.status, 'failed', 'Expired lease should not auto-fail recent job');
  assert.strictEqual(recovered.status, 'preparing', 'Expired lease should requeue job to preparing for rescan');
  assert(
    String(recovered.message || '').toLowerCase().includes('перескан')
      || String(recovered.message || '').toLowerCase().includes('переподключ')
      || String(recovered.message || '').toLowerCase().includes('rescan')
      || String(recovered.message || '').toLowerCase().includes('reconnect'),
    'Recovered job message should indicate reconnect/rescanning'
  );
  assert(Number.isFinite(Number(recovered.leaseUntilTs)) && Number(recovered.leaseUntilTs) > Date.now(), 'Recovered job must receive future lease');

  const startMessage = sentMessages.find((entry) => (
    Number(entry.tabId) === 301
    && entry.type === protocol.BG_START_JOB
    && entry.payload.jobId === 'job-lease-1'
  ));
  assert(startMessage, 'BG_START_JOB must be sent for requeued expired-lease job');
  assert(injectedTabs.includes(301), 'Content runtime reinjection should run for requeued job');

  await jobStore.upsertJob({
    id: 'job-lease-too-old',
    tabId: 302,
    url: 'https://example.test/lease-old',
    targetLang: 'ru',
    status: 'running',
    createdAt: now - (8 * 24 * 60 * 60 * 1000),
    updatedAt: now - (8 * 24 * 60 * 60 * 1000),
    leaseUntilTs: now - 1000,
    totalBlocks: 1,
    completedBlocks: 0,
    pendingBlockIds: ['c1'],
    failedBlockIds: [],
    blocksById: {
      c1: {
        blockId: 'c1',
        originalText: 'Old',
        category: 'paragraph'
      }
    },
    currentBatchId: null,
    lastError: null,
    message: 'Running'
  });
  await jobStore.setActiveJob(302, 'job-lease-too-old');

  await orchestrator.restoreStateAfterRestart();
  const tooOld = await jobStore.getJob('job-lease-too-old');
  assert(tooOld, 'Too-old job should exist');
  assert.strictEqual(tooOld.status, 'failed', 'Too-old job should fail on restart');
  assert.strictEqual(
    tooOld.lastError && tooOld.lastError.code,
    'JOB_TOO_OLD',
    'Too-old expired lease should fail with JOB_TOO_OLD'
  );

  console.log('PASS: translation lease recovery');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
