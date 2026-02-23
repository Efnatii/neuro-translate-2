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
    this.jobsById = {};
    this.activeByTab = {};
    this.lastByTab = {};
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
    this.activeByTab[key] = jobId;
    this.lastByTab[key] = jobId;
  }

  async clearActiveJob(tabId, jobId) {
    const key = String(tabId);
    if (jobId && this.activeByTab[key] && this.activeByTab[key] !== jobId) {
      return;
    }
    this.activeByTab[key] = null;
  }

  async getActiveJob(tabId) {
    const key = String(tabId);
    const jobId = this.activeByTab[key];
    return jobId ? this.jobsById[jobId] || null : null;
  }

  async getLastJobId(tabId) {
    return this.lastByTab[String(tabId)] || null;
  }

  async listActiveJobs() {
    return Object.values(this.activeByTab)
      .filter(Boolean)
      .map((id) => this.jobsById[id])
      .filter(Boolean);
  }
}

class MemoryTabStateStore {
  constructor(visibilityByTab) {
    this.visibilityByTab = { ...(visibilityByTab || {}) };
    this.statusByTab = {};
  }

  async upsertStatusPatch(tabId, patch) {
    const key = String(tabId);
    this.statusByTab[key] = { ...(this.statusByTab[key] || {}), ...(patch || {}) };
  }

  async upsertVisibility(tabId, visible) {
    this.visibilityByTab[String(tabId)] = Boolean(visible);
  }

  async getVisibility(tabId) {
    const key = String(tabId);
    if (Object.prototype.hasOwnProperty.call(this.visibilityByTab, key)) {
      return this.visibilityByTab[key] !== false;
    }
    return true;
  }
}

function buildJob({ id, tabId, contentSessionId }) {
  const now = Date.now();
  return {
    id,
    tabId,
    url: 'https://example.test/visibility',
    targetLang: 'ru',
    status: 'running',
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
        originalText: 'Hello',
        category: 'paragraph'
      }
    },
    currentBatchId: null,
    lastError: null,
    message: 'Выполняется',
    attempts: 0,
    scanReceived: true,
    selectedCategories: ['paragraph'],
    availableCategories: ['paragraph'],
    contentSessionId: contentSessionId || null
  };
}

function unwrapOutgoing(protocol, message) {
  if (protocol && typeof protocol.unwrap === 'function') {
    try {
      return protocol.unwrap(message);
    } catch (_) {
      // best-effort fallback below
    }
  }
  return {
    type: message && message.type ? message.type : null,
    payload: message && typeof message === 'object' ? message : {}
  };
}

async function runScenario({ tabId, visibilityByTab, sessionId, expectedVisible }) {
  const protocol = global.NT.TranslationProtocol;
  const Orchestrator = global.NT.TranslationOrchestrator;
  const sent = [];
  const chromeApi = {
    runtime: {
      lastError: null
    },
    tabs: {
      sendMessage(_tabId, message, cb) {
        const parsed = unwrapOutgoing(protocol, message);
        sent.push({
          tabId: _tabId,
          type: parsed.type,
          payload: parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {}
        });
        cb({ ok: true });
      }
    },
    scripting: {
      executeScript: async () => {}
    }
  };
  const settingsStore = {
    async get() {
      return { translationPipelineEnabled: true };
    }
  };
  const jobStore = new MemoryJobStore();
  const tabStateStore = new MemoryTabStateStore(visibilityByTab);
  const orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore,
    pageCacheStore: null,
    translationCall: null,
    translationAgent: null,
    eventFactory: null,
    eventLogFn: null
  });

  const job = buildJob({ id: `job-vis-${tabId}`, tabId, contentSessionId: sessionId });
  await jobStore.upsertJob(job);
  await jobStore.setActiveJob(tabId, job.id);

  const res = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_READY,
      contentSessionId: sessionId
    },
    sender: { tab: { id: tabId } }
  });

  assert.strictEqual(res && res.ok, true, 'CS_READY must be accepted');
  assert(sent.length >= 2, 'CS_READY should produce at least visibility sync and restart scan');
  assert.strictEqual(sent[0].type, protocol.BG_SET_VISIBILITY, 'First outbound command must sync visibility');
  assert.strictEqual(sent[0].payload.visible, expectedVisible, 'Visibility sync should use persisted value/default');
  assert.strictEqual(sent[0].payload.contentSessionId, sessionId, 'Visibility sync should carry contentSessionId when available');
  assert.strictEqual(sent[1].type, protocol.BG_START_JOB, 'Second outbound command must restart scan');
  assert.strictEqual(sent[1].payload.jobId, job.id, 'Restart command should target active job');
}

async function run() {
  global.NT = {};
  load('extension/core/message-envelope.js');
  load('extension/core/event-types.js');
  load('extension/core/translation-protocol.js');
  load('extension/bg/translation-orchestrator.js');

  await runScenario({
    tabId: 11,
    visibilityByTab: { '11': false },
    sessionId: 'cs-1',
    expectedVisible: false
  });

  await runScenario({
    tabId: 12,
    visibilityByTab: {},
    sessionId: 'cs-2',
    expectedVisible: true
  });

  console.log('PASS test-visibility-resync');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

