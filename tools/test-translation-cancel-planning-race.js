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

  const jobStore = new MemoryJobStore();

  const translationAgent = {
    async prepareJob({ blocks }) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return {
        blocks: Array.isArray(blocks) ? blocks : [],
        selectedCategories: ['paragraph'],
        agentState: {
          status: 'ready',
          toolConfig: {},
          toolHistory: [],
          toolExecutionTrace: [],
          checklist: [],
          reports: []
        }
      };
    }
  };

  const chromeApi = {
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript: async () => {}
    },
    tabs: {
      sendMessage(_tabId, _message, cb) {
        cb({ ok: true });
      }
    }
  };

  const settingsStore = {
    async get(keys) {
      const data = {
        translationPipelineEnabled: true,
        translationApiCacheEnabled: true,
        translationCategoryMode: 'auto',
        translationCategoryList: []
      };
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((key) => {
          out[key] = Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
        });
        return out;
      }
      return data;
    }
  };

  const tabStateStore = {
    async upsertStatusPatch() {},
    async upsertVisibility() {}
  };

  const orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore,
    translationCall: {
      async translateBatch() {
        return { items: [] };
      }
    },
    translationAgent,
    eventFactory: {
      info: (tag, message, meta) => ({ ts: Date.now(), level: 'info', tag, message, meta }),
      warn: (tag, message, meta) => ({ ts: Date.now(), level: 'warn', tag, message, meta }),
      error: (tag, message, meta) => ({ ts: Date.now(), level: 'error', tag, message, meta })
    },
    eventLogFn: () => {}
  });

  const start = await orchestrator.startJob({ tabId: 55, url: 'https://example.test/race' });
  assert.strictEqual(start.ok, true, 'startJob must succeed');
  assert(start.job && start.job.id, 'job id should exist');

  const scanPromise = orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start.job.id,
      blocks: [
        { blockId: 'b1', originalText: 'Hello', category: 'paragraph' }
      ]
    },
    sender: { tab: { id: 55 } }
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  const cancelled = await orchestrator.cancelJob({ tabId: 55 });
  assert.strictEqual(cancelled.ok, true, 'cancelJob should succeed');
  assert.strictEqual(cancelled.cancelled, true, 'cancelJob should report cancelled');

  const scanResult = await scanPromise;
  assert(scanResult && scanResult.ok === true, 'scanPromise should resolve with ok=true');

  const finalJob = await jobStore.getJob(start.job.id);
  assert(finalJob, 'final job should exist');
  assert.strictEqual(finalJob.status, 'cancelled', 'final job status must remain cancelled');

  const activeJob = await jobStore.getActiveJob(55);
  assert.strictEqual(activeJob, null, 'cancelled job must not remain active');

  assert(
    scanResult.ignored === true || (finalJob.status === 'cancelled' && activeJob === null),
    'late scan handling must not revive cancelled job'
  );

  console.log('PASS: translation cancel planning race');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

