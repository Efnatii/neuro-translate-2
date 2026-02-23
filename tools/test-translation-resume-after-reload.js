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

function waitFor(predicate, timeoutMs = 4000, stepMs = 25) {
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

  const tabStatuses = {};
  const translateCalls = [];
  const sentMessages = [];
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
        const outgoing = unwrapOutgoing(message);
        const payload = outgoing.payload || {};
        sentMessages.push({ tabId, message, type: outgoing.type || 'unknown' });
        if (outgoing.type === protocol.BG_APPLY_BATCH) {
          setTimeout(() => {
            const ack = typeof protocol.wrap === 'function'
              ? protocol.wrap(protocol.CS_APPLY_ACK, {
                jobId: payload.jobId,
                batchId: payload.batchId,
                appliedCount: Array.isArray(payload.items) ? payload.items.length : 0,
                ok: true,
                contentSessionId: payload.contentSessionId || null
              }, { source: 'content' })
              : {
                type: protocol.CS_APPLY_ACK,
                jobId: payload.jobId,
                batchId: payload.batchId,
                appliedCount: Array.isArray(payload.items) ? payload.items.length : 0,
                ok: true,
                contentSessionId: payload.contentSessionId || null
              };
            orchestrator.handleContentMessage({
              message: ack,
              sender: { tab: { id: tabId } }
            }).catch(() => {});
          }, 0);
        }
        cb({ ok: true });
      }
    }
  };

  const settingsData = {
    translationPipelineEnabled: true,
    translationApiCacheEnabled: true,
    translationPageCacheEnabled: true
  };
  const settingsStore = {
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((key) => {
          out[key] = Object.prototype.hasOwnProperty.call(settingsData, key)
            ? settingsData[key]
            : null;
        });
        return out;
      }
      return { ...settingsData };
    }
  };

  const tabStateStore = {
    async upsertStatusPatch(tabId, patch) {
      tabStatuses[tabId] = { ...(tabStatuses[tabId] || {}), ...(patch || {}) };
    },
    async upsertVisibility() {}
  };

  const translationCall = {
    async translateBatch(inputBlocks) {
      const ids = (inputBlocks || []).map((block) => block.blockId);
      translateCalls.push(ids);
      await new Promise((resolve) => setTimeout(resolve, 40));
      return {
        items: (inputBlocks || []).map((block) => ({
          blockId: block.blockId,
          text: `T:${block.originalText}`
        }))
      };
    }
  };

  const memoryStore = new MemoryJobStore();
  orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore: memoryStore,
    translationCall,
    onUiPatch: () => {}
  });

  const now = Date.now();
  await memoryStore.upsertJob({
    id: 'job-resume-1',
    tabId: 21,
    url: 'https://example.test/reload',
    targetLang: 'ru',
    status: 'preparing',
    createdAt: now,
    updatedAt: now,
    leaseUntilTs: now + 60_000,
    totalBlocks: 0,
    completedBlocks: 0,
    pendingBlockIds: [],
    failedBlockIds: [],
    blocksById: {
      old0: {
        blockId: 'old0',
        originalText: 'One',
        category: 'paragraph',
        pathHint: 'body > p:nth-of-type(1)',
        translatedText: 'T:One'
      },
      old1: {
        blockId: 'old1',
        originalText: 'Two',
        category: 'paragraph',
        pathHint: 'body > p:nth-of-type(2)',
        translatedText: 'T:Two'
      }
    },
    currentBatchId: null,
    lastError: null,
    message: 'Rescanning page',
    attempts: 0,
    scanReceived: false,
    availableCategories: ['paragraph'],
    selectedCategories: ['paragraph'],
    categorySelectionConfirmed: true,
    agentState: null,
    recentDiffItems: [],
    translationMemoryBySource: {},
    apiCacheEnabled: true,
    proofreadingState: {
      totalPasses: 0,
      completedPasses: 0,
      updatedAt: now
    }
  });
  await memoryStore.setActiveJob(21, 'job-resume-1');

  const scan = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: 'job-resume-1',
      blocks: [
        { blockId: 'r0', originalText: 'One', category: 'paragraph', pathHint: 'body > p:nth-of-type(1)' },
        { blockId: 'r1', originalText: 'Two', category: 'paragraph', pathHint: 'body > p:nth-of-type(2)' },
        { blockId: 'r2', originalText: 'Three', category: 'paragraph', pathHint: 'body > p:nth-of-type(3)' }
      ]
    },
    sender: { tab: { id: 21 } }
  });

  assert.strictEqual(scan.ok, true, 'Scan result must be accepted');
  assert(scan.awaitingCategorySelection !== true, 'Resume flow must not request category selection again');

  const jobAfterScan = await memoryStore.getJob('job-resume-1');
  assert(jobAfterScan, 'Job should still exist after scan');
  assert.strictEqual(jobAfterScan.status, 'running', 'Job should move to running on resume when pending blocks remain');
  assert(Object.keys(jobAfterScan.translationMemoryBySource || {}).length > 0, 'Memory should be restored from old translatedText');

  await waitFor(() => {
    const status = tabStatuses[21] || {};
    return status.status === 'done';
  });

  const finalJob = await memoryStore.getJob('job-resume-1');
  assert(finalJob, 'Final job should exist');
  assert.strictEqual(finalJob.status, 'done', 'Job should be completed after resume continuation');
  assert.strictEqual((tabStatuses[21] || {}).progress, 100, 'Final progress should be 100%');
  assert.strictEqual(translateCalls.length, 1, 'Only one translateBatch call is expected');
  assert.deepStrictEqual(translateCalls[0], ['r2'], 'Only the not-yet-translated block should be sent to translateBatch');
  assert(finalJob.blocksById.r0 && finalJob.blocksById.r0.translatedText === 'T:One', 'Restored block r0 must keep translatedText');
  assert(finalJob.blocksById.r1 && finalJob.blocksById.r1.translatedText === 'T:Two', 'Restored block r1 must keep translatedText');
  assert(finalJob.blocksById.r2 && finalJob.blocksById.r2.translatedText === 'T:Three', 'Pending block r2 must be translated');

  const applyMessages = sentMessages.filter((entry) => unwrapOutgoing(entry.message).type === protocol.BG_APPLY_BATCH);
  assert(applyMessages.length >= 2, 'Resume flow should apply restored items and then apply translated pending items');

  console.log('PASS: translation resume after reload');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
