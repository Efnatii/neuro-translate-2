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

  async putEntry({ url, targetLang, signature, items, blockCount = 0 } = {}) {
    const key = this.buildKey({ url, targetLang });
    this.map[key] = {
      key,
      signature,
      items: Array.isArray(items) ? items.slice() : [],
      blockCount,
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

  const blocks = [
    { blockId: 'c0', originalText: 'Cached hello', pathHint: 'body > p:nth-of-type(1)', category: 'paragraph' },
    { blockId: 'c1', originalText: 'Cached world', pathHint: 'body > p:nth-of-type(2)', category: 'paragraph' }
  ];

  const startFirst = await orchestrator.startJob({ tabId: 51, url: 'https://cache.example.test/article?x=1' });
  assert.strictEqual(startFirst.ok, true, 'First job should start');
  const firstScan = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: startFirst.job.id,
      blocks
    },
    sender: { tab: { id: 51 } }
  });
  assert.strictEqual(firstScan.ok, true, 'First scan should be accepted');
  assert.strictEqual(firstScan.awaitingCategorySelection, true, 'First scan should wait for category selection');
  const firstSelect = await orchestrator.applyCategorySelection({
    tabId: 51,
    jobId: startFirst.job.id,
    categories: Array.isArray(firstScan.availableCategories) && firstScan.availableCategories.length
      ? firstScan.availableCategories
      : ['paragraph']
  });
  assert.strictEqual(firstSelect.ok, true, 'First category selection should start translation');
  await waitFor(() => (statuses[51] || {}).status === 'done');
  assert(llmCalls >= 1, 'First run should call translation model');

  const firstCache = await pageCacheStore.getEntry({
    url: 'https://cache.example.test/article?x=1',
    targetLang: 'ru'
  });
  assert(firstCache && Array.isArray(firstCache.items) && firstCache.items.length === 2, 'First run should persist page cache entry');

  const llmCallsBeforeSecond = llmCalls;
  const startSecond = await orchestrator.startJob({ tabId: 51, url: 'https://cache.example.test/article?x=2' });
  assert.strictEqual(startSecond.ok, true, 'Second job should start');
  const secondScan = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: startSecond.job.id,
      blocks
    },
    sender: { tab: { id: 51 } }
  });
  assert.strictEqual(secondScan.ok, true, 'Second scan should be accepted');
  assert.strictEqual(secondScan.awaitingCategorySelection, true, 'Second scan should wait for category selection');
  const secondSelect = await orchestrator.applyCategorySelection({
    tabId: 51,
    jobId: startSecond.job.id,
    categories: Array.isArray(secondScan.availableCategories) && secondScan.availableCategories.length
      ? secondScan.availableCategories
      : ['paragraph']
  });
  assert.strictEqual(secondSelect.ok, true, 'Second category selection should be accepted');
  assert.strictEqual(secondSelect.fromCache, true, 'Second run should indicate cache usage');
  await waitFor(() => (statuses[51] || {}).status === 'done');
  assert.strictEqual(llmCalls, llmCallsBeforeSecond, 'Second run should not call LLM when cache signature matches');

  const cacheApply = sentMessages.filter((row) => row.type === protocol.BG_APPLY_BATCH && row.message && String(row.message.batchId || '').includes(':cache:'));
  assert(cacheApply.length >= 1, 'Second run should apply at least one cache batch');

  console.log('PASS: translation page cache');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
