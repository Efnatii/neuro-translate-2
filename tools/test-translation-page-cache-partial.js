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

class MemoryPageCacheStore {
  constructor() {
    this.map = {};
  }

  buildKey({ url, targetLang } = {}) {
    const lang = String(targetLang || 'ru').toLowerCase();
    const normalizedUrl = typeof url === 'string' ? url.split('#')[0].split('?')[0] : 'about:blank';
    return `${lang}::${normalizedUrl}`;
  }

  async getEntry({ url, targetLang, key } = {}) {
    const cacheKey = key || this.buildKey({ url, targetLang });
    return this.map[cacheKey] || null;
  }

  async putEntry(entry = {}) {
    const key = this.buildKey({ url: entry.url, targetLang: entry.targetLang });
    this.map[key] = {
      ...(entry && typeof entry === 'object' ? entry : {}),
      key,
      items: Array.isArray(entry && entry.items) ? entry.items.slice() : [],
      memoryMap: entry && entry.memoryMap && typeof entry.memoryMap === 'object' ? { ...entry.memoryMap } : entry.memoryMap,
      coverage: entry && entry.coverage && typeof entry.coverage === 'object' ? { ...entry.coverage } : entry.coverage,
      updatedAt: Date.now()
    };
    return this.map[key];
  }

  async removeEntry({ url, targetLang, key } = {}) {
    const cacheKey = key || this.buildKey({ url, targetLang });
    if (!Object.prototype.hasOwnProperty.call(this.map, cacheKey)) {
      return false;
    }
    delete this.map[cacheKey];
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

  const statuses = {};
  const sentMessages = [];
  const jobStore = new MemoryJobStore();
  const pageCacheStore = new MemoryPageCacheStore();
  let orchestrator = null;

  let llmCalls = 0;
  const translationCall = {
    async translateBatch(inputBlocks) {
      llmCalls += 1;
      return {
        items: (inputBlocks || []).map((block) => ({
          blockId: block.blockId,
          text: `T:${block.originalText}`
        }))
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
      sendMessage(tabId, message, cb) {
        const outgoing = unwrapOutgoing(message);
        const payload = outgoing.payload || {};
        sentMessages.push({ tabId, type: outgoing.type || 'unknown', message });
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

  const settingsStore = {
    async get(keys) {
      const data = {
        translationPipelineEnabled: true,
        translationPageCacheEnabled: true
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

  orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore,
    pageCacheStore,
    translationCall,
    eventFactory: {
      info: (tag, message, meta) => ({ ts: Date.now(), level: 'info', tag, message, meta }),
      warn: (tag, message, meta) => ({ ts: Date.now(), level: 'warn', tag, message, meta }),
      error: (tag, message, meta) => ({ ts: Date.now(), level: 'error', tag, message, meta })
    },
    eventLogFn: () => {}
  });

  const blocksScan1 = [
    { blockId: 'p0', originalText: 'Hello', category: 'paragraph', pathHint: 'body > p:nth-of-type(1)' },
    { blockId: 'p1', originalText: 'World', category: 'paragraph', pathHint: 'body > p:nth-of-type(2)' },
    { blockId: 'b0', originalText: 'Buy', category: 'button', pathHint: 'body > button:nth-of-type(1)' }
  ];

  const start1 = await orchestrator.startJob({ tabId: 61, url: 'https://cache.example.test/partial?run=1' });
  assert.strictEqual(start1.ok, true, 'First partial-cache job should start');
  const scan1 = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start1.job.id,
      blocks: blocksScan1
    },
    sender: { tab: { id: 61 } }
  });
  assert.strictEqual(scan1.ok, true, 'First scan should be accepted');
  assert(Array.isArray(scan1.availableCategories) && scan1.availableCategories.includes('paragraph') && scan1.availableCategories.includes('button'), 'First scan should expose paragraph/button categories');

  const firstSelect = await orchestrator.applyCategorySelection({
    tabId: 61,
    jobId: start1.job.id,
    categories: ['paragraph']
  });
  assert.strictEqual(firstSelect.ok, true, 'Selecting paragraph category should succeed');
  await waitFor(() => (statuses[61] || {}).status === 'done');
  assert(llmCalls >= 1, 'First run should call LLM for paragraph translation');

  const firstEntry = await pageCacheStore.getEntry({
    url: 'https://cache.example.test/partial?run=1',
    targetLang: 'ru'
  });
  assert(firstEntry, 'Partial run should store page cache entry');
  assert(firstEntry.coverage && Array.isArray(firstEntry.coverage.categories) && firstEntry.coverage.categories.includes('paragraph'), 'Cache coverage should include paragraph');
  assert(firstEntry.coverage && firstEntry.coverage.isFull === false, 'Partial cache coverage should be marked as non-full');

  const llmBeforeSecond = llmCalls;
  const blocksScan2 = [
    { blockId: 'pA', originalText: 'Hello', category: 'paragraph', pathHint: 'body > p:nth-of-type(1)' },
    { blockId: 'pB', originalText: 'World', category: 'paragraph', pathHint: 'body > p:nth-of-type(2)' },
    { blockId: 'bZ', originalText: 'Buy', category: 'button', pathHint: 'body > button:nth-of-type(1)' }
  ];

  const start2 = await orchestrator.startJob({ tabId: 61, url: 'https://cache.example.test/partial?run=2' });
  assert.strictEqual(start2.ok, true, 'Second partial-cache job should start');
  const scan2 = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start2.job.id,
      blocks: blocksScan2
    },
    sender: { tab: { id: 61 } }
  });
  assert.strictEqual(scan2.ok, true, 'Second scan should be accepted');

  const secondSelect = await orchestrator.applyCategorySelection({
    tabId: 61,
    jobId: start2.job.id,
    categories: ['paragraph']
  });
  assert.strictEqual(secondSelect.ok, true, 'Second paragraph selection should succeed');
  assert.strictEqual(secondSelect.fromCache, true, 'Second paragraph selection should be restored from cache');
  await waitFor(() => (statuses[61] || {}).status === 'done');
  assert.strictEqual(llmCalls, llmBeforeSecond, 'Second run with changed blockId should not call LLM for paragraph cache restore');

  const cacheApply = sentMessages.filter((row) => {
    const outgoing = unwrapOutgoing(row.message);
    const payload = outgoing.payload || {};
    return outgoing.type === protocol.BG_APPLY_BATCH && String(payload.batchId || '').includes(':cache:');
  });
  assert(cacheApply.length >= 1, 'Cache restore should send BG_APPLY_BATCH with cache prefix');

  const llmBeforeThird = llmCalls;
  const start3 = await orchestrator.startJob({ tabId: 61, url: 'https://cache.example.test/partial?run=3' });
  assert.strictEqual(start3.ok, true, 'Third partial-cache job should start');
  const scan3 = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start3.job.id,
      blocks: blocksScan2
    },
    sender: { tab: { id: 61 } }
  });
  assert.strictEqual(scan3.ok, true, 'Third scan should be accepted');

  const thirdSelect = await orchestrator.applyCategorySelection({
    tabId: 61,
    jobId: start3.job.id,
    categories: ['button']
  });
  assert.strictEqual(thirdSelect.ok, true, 'Third selection for button should succeed');
  assert.notStrictEqual(thirdSelect.fromCache, true, 'Button-only selection should not be fully restored from cache');
  await waitFor(() => (statuses[61] || {}).status === 'done');
  assert(llmCalls > llmBeforeThird, 'Button translation should call LLM because it was not cached');

  console.log('PASS: translation page cache partial');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
