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

function waitFor(predicate, timeoutMs = 3000, stepMs = 20) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if ((Date.now() - started) > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
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
    const jobId = this.jobsByTab[String(tabId)];
    return jobId ? this.jobsById[jobId] || null : null;
  }

  async getLastJobId(tabId) {
    const row = this.indexByTab[String(tabId)] || null;
    return row && row.lastJobId ? row.lastJobId : null;
  }

  async listActiveJobs() {
    return Object.keys(this.jobsByTab)
      .map((tabId) => this.jobsByTab[tabId])
      .filter(Boolean)
      .map((jobId) => this.jobsById[jobId])
      .filter(Boolean);
  }

  async clearTabHistory(_tabId) {
    return true;
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

  const statuses = {};
  const applyMessages = [];
  const translationCalls = [];
  let orchestrator = null;

  const chromeApi = {
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript: async () => {}
    },
    tabs: {
      sendMessage(tabId, message, cb) {
        if (message && message.type === protocol.BG_APPLY_BATCH) {
          applyMessages.push({
            tabId,
            batchId: message.batchId,
            items: Array.isArray(message.items) ? message.items.slice() : []
          });
          setTimeout(() => {
            orchestrator.handleContentMessage({
              message: {
                type: protocol.CS_APPLY_ACK,
                jobId: message.jobId,
                batchId: message.batchId,
                appliedCount: Array.isArray(message.items) ? message.items.length : 0,
                ok: true
              },
              sender: { tab: { id: tabId } }
            }).catch(() => {});
          }, 0);
        }
        cb({ ok: true });
      }
    }
  };

  const settingsStore = {
    async get(keys) {
      const data = {
        translationPipelineEnabled: true,
        translationApiCacheEnabled: true
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
    async upsertStatusPatch(tabId, patch) {
      statuses[tabId] = { ...(statuses[tabId] || {}), ...(patch || {}) };
    },
    async upsertVisibility() {}
  };

  const translationCall = {
    async translateBatch(inputBlocks, options) {
      const callIndex = translationCalls.length + 1;
      translationCalls.push({
        blocks: (inputBlocks || []).map((block) => ({
          blockId: block.blockId,
          originalText: block.originalText
        })),
        options: options || null
      });
      return {
        items: (inputBlocks || []).map((block) => ({
          blockId: block.blockId,
          text: callIndex === 1
            ? `T:${block.originalText}`
            : `P:${block.originalText}`
        })),
        report: {
          summary: callIndex === 1 ? 'translation pass' : 'proofread pass',
          quality: 'ok',
          notes: []
        }
      };
    }
  };

  const translationAgent = {
    async prepareJob({ blocks }) {
      return {
        blocks: Array.isArray(blocks) ? blocks : [],
        selectedCategories: ['paragraph'],
        agentState: {
          status: 'ready',
          phase: 'planned',
          profile: 'balanced',
          selectedCategories: ['paragraph'],
          plan: {
            style: 'balanced',
            batchSize: 8,
            proofreadingPasses: 1,
            instructions: 'translate then proofread'
          },
          toolConfig: {},
          checklist: [],
          toolHistory: [],
          reports: [],
          audits: [],
          recentDiffItems: []
        }
      };
    }
  };

  const eventFactory = {
    info: (tag, message, meta) => ({ ts: Date.now(), level: 'info', tag, message, meta }),
    warn: (tag, message, meta) => ({ ts: Date.now(), level: 'warn', tag, message, meta }),
    error: (tag, message, meta) => ({ ts: Date.now(), level: 'error', tag, message, meta })
  };

  const store = new MemoryJobStore();
  orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore: store,
    translationCall,
    translationAgent,
    eventFactory,
    eventLogFn: () => {},
    onUiPatch: () => {}
  });

  const started = await orchestrator.startJob({
    tabId: 31,
    url: 'https://proofread.example.test/page'
  });
  assert.strictEqual(started.ok, true, 'startJob must succeed');
  assert(started.job && started.job.id, 'startJob should return job summary');

  const scanned = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: started.job.id,
      blocks: [
        { blockId: 'p0', originalText: 'Alpha text', category: 'paragraph', pathHint: 'body > p:nth-of-type(1)' },
        { blockId: 'p1', originalText: 'Beta text', category: 'paragraph', pathHint: 'body > p:nth-of-type(2)' }
      ]
    },
    sender: { tab: { id: 31 } }
  });
  assert.strictEqual(scanned.ok, true, 'Scan should be accepted');
  assert.strictEqual(scanned.awaitingCategorySelection, true, 'Scan should wait for category selection');
  const selected = await orchestrator.applyCategorySelection({
    tabId: 31,
    jobId: started.job.id,
    categories: Array.isArray(scanned.availableCategories) && scanned.availableCategories.length
      ? scanned.availableCategories
      : ['paragraph']
  });
  assert.strictEqual(selected.ok, true, 'Category selection should start translation');

  await waitFor(() => {
    const status = statuses[31] || {};
    return status.status === 'done';
  }, 5000);

  const finalJobId = await store.getLastJobId(31);
  const finalJob = finalJobId ? await store.getJob(finalJobId) : null;
  assert(finalJob, 'Final job should be available');
  assert.strictEqual(finalJob.status, 'done', 'Job should finish successfully');
  assert(finalJob.proofreadingState && finalJob.proofreadingState.completedPasses >= 1, 'Proofreading pass should be completed');
  assert.strictEqual(finalJob.proofreadingState.totalPasses, 1, 'Total proofreading passes should match plan');
  assert.strictEqual(translationCalls.length, 2, 'Pipeline should execute translation pass and proofread pass');
  assert(translationCalls[1].blocks.every((item) => String(item.originalText || '').startsWith('T:')), 'Proofread pass should use translated text as input');
  assert(finalJob.blocksById.p0 && String(finalJob.blocksById.p0.translatedText || '').startsWith('P:T:'), 'Final translation should include proofread output');
  assert(applyMessages.some((row) => String(row.batchId || '').includes(':proofread:')), 'Proofread batch should be streamed to content runtime');

  console.log('PASS: translation proofreading');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
