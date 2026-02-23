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
    this.jobsById = {};
    this.jobsByTab = {};
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
    const jobId = this.jobsByTab[key] || null;
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

  async clearTabHistory(tabId) {
    const key = String(tabId);
    this.jobsByTab[key] = null;
    this.indexByTab[key] = {
      ...(this.indexByTab[key] || {}),
      activeJobId: null,
      lastJobId: null,
      updatedAt: Date.now()
    };
    return true;
  }
}

async function run() {
  global.NT = {};
  load('extension/core/message-envelope.js');
  load('extension/core/event-types.js');
  load('extension/core/translation-protocol.js');
  load('extension/ai/translation-agent.js');
  load('extension/bg/translation-orchestrator.js');

  const protocol = global.NT.TranslationProtocol;
  const TranslationAgent = global.NT.TranslationAgent;
  const Orchestrator = global.NT.TranslationOrchestrator;
  assert(TranslationAgent, 'TranslationAgent must be defined');
  assert(Orchestrator, 'TranslationOrchestrator must be defined');

  const jobStore = new MemoryJobStore();
  const tabStatuses = {};
  const sentMessages = [];
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
        let parsed = null;
        try {
          parsed = protocol && typeof protocol.unwrap === 'function'
            ? protocol.unwrap(message)
            : { type: message && message.type ? message.type : null, payload: message || {} };
        } catch (_) {
          parsed = { type: message && message.type ? message.type : null, payload: message || {} };
        }
        const payload = parsed && parsed.payload && typeof parsed.payload === 'object' ? parsed.payload : {};
        sentMessages.push({ tabId, type: parsed && parsed.type ? parsed.type : 'unknown', payload });

        if (parsed && parsed.type === protocol.BG_APPLY_BATCH) {
          setTimeout(() => {
            const ackMessage = typeof protocol.wrap === 'function'
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
              message: ackMessage,
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
    translationAgentTools: { pageRuntime: 'on', cacheManager: 'on', workflowController: 'on' },
    translationAgentProfile: 'balanced',
    translationAgentTuning: {},
    translationAgentModelPolicy: null,
    modelSelection: { speed: true, preference: null },
    translationCategoryMode: 'all',
    translationCategoryList: []
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
      return {
        items: (Array.isArray(inputBlocks) ? inputBlocks : []).map((block) => ({
          blockId: block.blockId,
          text: `T:${block.originalText}`
        })),
        report: {
          summary: 'ok',
          quality: 'ok',
          notes: []
        }
      };
    }
  };

  const eventFactory = {
    info: (tag, message, meta) => ({ ts: Date.now(), level: 'info', tag, message, meta }),
    warn: (tag, message, meta) => ({ ts: Date.now(), level: 'warn', tag, message, meta }),
    error: (tag, message, meta) => ({ ts: Date.now(), level: 'error', tag, message, meta })
  };

  const translationAgent = new TranslationAgent({ runLlmRequest: null });
  orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore,
    translationCall,
    translationAgent,
    eventFactory,
    eventLogFn: (event) => events.push(event),
    onUiPatch: () => {}
  });

  const start = await orchestrator.startJob({ tabId: 11, url: 'https://t.test', targetLang: 'ru' });
  assert.strictEqual(start.ok, true, 'startJob must succeed');

  const scan = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start.job.id,
      blocks: [
        { blockId: 'b1', originalText: 'Hello', category: 'paragraph' },
        { blockId: 'b2', originalText: 'World', category: 'paragraph' }
      ]
    },
    sender: { tab: { id: 11 } }
  });
  assert.strictEqual(scan.ok, true, 'scan must succeed');
  assert.strictEqual(scan.awaitingCategorySelection, true, 'scan must pause for category selection');

  const apply = await orchestrator.applyCategorySelection({
    tabId: 11,
    jobId: start.job.id,
    categories: ['paragraph']
  });
  assert.strictEqual(apply.ok, true, 'applyCategorySelection must succeed');

  await waitFor(() => tabStatuses[11] && tabStatuses[11].status === 'done');

  const job = await jobStore.getJob(start.job.id);
  assert(job && job.agentState, 'job.agentState must exist');

  const trace = Array.isArray(job.agentState.toolExecutionTrace)
    ? job.agentState.toolExecutionTrace
    : [];
  const history = Array.isArray(job.agentState.toolHistory)
    ? job.agentState.toolHistory
    : [];

  const sentTrace = trace.find((row) => row && row.tool === 'pageRuntime' && typeof row.message === 'string' && row.message.includes('content.apply_batch.sent'));
  const ackTrace = trace.find((row) => row && row.tool === 'pageRuntime' && typeof row.message === 'string' && row.message.includes('content.apply_batch.ack'));

  assert(sentTrace, 'Trace must include pageRuntime content.apply_batch.sent');
  assert(ackTrace, 'Trace must include pageRuntime content.apply_batch.ack');
  assert(history.some((row) => row && row.tool === 'pageRuntime'), 'History must include pageRuntime entries');
  assert(sentTrace.meta && sentTrace.meta.batchId, 'Sent trace meta must include batchId');
  assert(sentTrace.meta && (Object.prototype.hasOwnProperty.call(sentTrace.meta, 'blockCount') || Object.prototype.hasOwnProperty.call(sentTrace.meta, 'items')),
    'Sent trace meta must include blockCount/items');

  const applyMessage = sentMessages.find((row) => row && row.type === protocol.BG_APPLY_BATCH);
  assert(applyMessage, 'Test flow must send BG_APPLY_BATCH');

  assert(events.length >= 1, 'Flow should emit diagnostic events');
  console.log('PASS test-agent-runtime-tool-logging');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

