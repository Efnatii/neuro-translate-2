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

  let orchestrator = null;
  const sentMessages = [];
  const jobStore = new MemoryJobStore();

  let activeSignal = null;
  let abortEvents = 0;
  const translationCall = {
    async translateBatch(_inputBlocks, options = {}) {
      activeSignal = options.signal || null;
      return new Promise((resolve, reject) => {
        if (!activeSignal) {
          resolve({ items: [] });
          return;
        }
        if (activeSignal.aborted) {
          const err = new Error('aborted');
          err.name = 'AbortError';
          err.code = 'ABORT_ERR';
          reject(err);
          return;
        }
        const onAbort = () => {
          abortEvents += 1;
          const err = new Error('aborted');
          err.name = 'AbortError';
          err.code = 'ABORT_ERR';
          reject(err);
        };
        activeSignal.addEventListener('abort', onAbort, { once: true });
      });
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
      sendMessage(tabId, message, cb) {
        sentMessages.push({ tabId, type: message && message.type ? message.type : 'unknown', message });
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
    async upsertStatusPatch() {},
    async upsertVisibility() {}
  };

  orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore,
    translationCall,
    eventFactory: {
      info: (tag, message, meta) => ({ ts: Date.now(), level: 'info', tag, message, meta }),
      warn: (tag, message, meta) => ({ ts: Date.now(), level: 'warn', tag, message, meta }),
      error: (tag, message, meta) => ({ ts: Date.now(), level: 'error', tag, message, meta })
    },
    eventLogFn: () => {}
  });

  const start = await orchestrator.startJob({ tabId: 21, url: 'https://example.test/cancel' });
  assert.strictEqual(start.ok, true, 'Job should start');
  assert(start.job && start.job.id, 'Started job id must exist');

  const scan = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start.job.id,
      blocks: [
        { blockId: 'b0', originalText: 'One', pathHint: 'body > p:nth-of-type(1)', category: 'paragraph' },
        { blockId: 'b1', originalText: 'Two', pathHint: 'body > p:nth-of-type(2)', category: 'paragraph' }
      ]
    },
    sender: { tab: { id: 21 } }
  });
  assert.strictEqual(scan.ok, true, 'Scan should be accepted');
  assert.strictEqual(scan.awaitingCategorySelection, true, 'Scan should wait for category selection');
  const selectCategories = await orchestrator.applyCategorySelection({
    tabId: 21,
    jobId: start.job.id,
    categories: Array.isArray(scan.availableCategories) && scan.availableCategories.length
      ? scan.availableCategories
      : ['paragraph']
  });
  assert.strictEqual(selectCategories.ok, true, 'Category selection should start translation');

  await waitFor(() => Boolean(activeSignal), 2500, 20);
  assert(activeSignal, 'Active translation request signal should be captured');

  const cancelled = await orchestrator.cancelJob({ tabId: 21 });
  assert.strictEqual(cancelled.ok, true, 'Cancel should succeed');
  assert.strictEqual(cancelled.cancelled, true, 'Cancel should report cancelled=true');

  await waitFor(() => orchestrator.processingJobs.size === 0, 3500, 20);

  const finalJob = await jobStore.getJob(start.job.id);
  assert(finalJob, 'Final job should still exist');
  assert.strictEqual(finalJob.status, 'cancelled', 'Cancelled job must keep cancelled status');
  assert.strictEqual(Array.isArray(finalJob.failedBlockIds) ? finalJob.failedBlockIds.length : 0, 0, 'Cancelled job must not mark failed blocks');

  const activeAfterCancel = await jobStore.getActiveJob(21);
  assert.strictEqual(activeAfterCancel, null, 'Cancelled job must not remain active');

  assert(activeSignal.aborted, 'Signal must be aborted after cancel');
  assert(abortEvents >= 1, 'Abort handler should run at least once');

  const applyMessages = sentMessages.filter((row) => row.type === protocol.BG_APPLY_BATCH);
  assert.strictEqual(applyMessages.length, 0, 'No apply batch should be sent for cancelled in-flight request');

  console.log('PASS: translation cancel abort');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
