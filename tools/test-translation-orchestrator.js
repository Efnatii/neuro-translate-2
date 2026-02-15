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

function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
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

  const tabStatuses = {};
  const uiPatches = [];
  const events = [];

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
      const data = { translationPipelineEnabled: true };
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
      tabStatuses[tabId] = { ...(tabStatuses[tabId] || {}), ...(patch || {}) };
    },
    async upsertVisibility() {}
  };

  const translationCall = {
    async translateBatch(inputBlocks) {
      return {
        items: (inputBlocks || []).map((block) => ({
          blockId: block.blockId,
          text: `T:${block.originalText}`
        }))
      };
    }
  };

  const eventFactory = {
    info: (tag, message, meta) => ({ ts: Date.now(), level: 'info', tag, message, meta }),
    warn: (tag, message, meta) => ({ ts: Date.now(), level: 'warn', tag, message, meta }),
    error: (tag, message, meta) => ({ ts: Date.now(), level: 'error', tag, message, meta })
  };

  orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore: new MemoryJobStore(),
    translationCall,
    eventFactory,
    eventLogFn: (event) => events.push(event),
    onUiPatch: (patch) => uiPatches.push(patch)
  });

  const start = await orchestrator.startJob({ tabId: 11, url: 'https://example.test' });
  assert.strictEqual(start.ok, true, 'startJob must succeed');
  assert(start.job && start.job.id, 'startJob must return job summary');

  const invalidScan = await orchestrator.handleContentMessage({
    message: { type: protocol.CS_SCAN_RESULT, blocks: [] },
    sender: { tab: { id: 11 } }
  });
  assert.strictEqual(invalidScan.ok, false, 'Invalid scan payload must be rejected');

  const scan = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start.job.id,
      blocks: [
        { blockId: 'b0', originalText: 'One', pathHint: 'body > p:nth-of-type(1)' },
        { blockId: 'b1', originalText: 'Two', pathHint: 'body > p:nth-of-type(2)' },
        { blockId: 'b2', originalText: 'Three', pathHint: 'body > p:nth-of-type(3)' }
      ]
    },
    sender: { tab: { id: 11 } }
  });
  assert.strictEqual(scan.ok, true, 'Scan result must be accepted');

  await waitFor(() => {
    const status = tabStatuses[11] || {};
    return status.status === 'done';
  });
  assert.strictEqual(tabStatuses[11].progress, 100, 'Done status must have 100% progress');

  const retry = await orchestrator.retryFailed({ tabId: 11 });
  assert.strictEqual(retry.ok, false, 'Retry must fail when there are no failed blocks');

  const start2 = await orchestrator.startJob({ tabId: 12, url: 'https://example.test' });
  assert.strictEqual(start2.ok, true, 'Second startJob must succeed');
  const cancel2 = await orchestrator.cancelJob({ tabId: 12 });
  assert.strictEqual(cancel2.ok, true, 'Cancel must succeed');
  assert.strictEqual(cancel2.cancelled, true, 'Cancel must mark active job');

  assert(events.length > 0, 'Events should be emitted');
  assert(uiPatches.length > 0, 'UI patches should be emitted');
  console.log('PASS: translation orchestrator');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

