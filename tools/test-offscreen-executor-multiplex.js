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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MemoryInflightStore {
  constructor() {
    this.rows = {};
  }

  async upsert(requestIdOrEntry, patch) {
    const source = requestIdOrEntry && typeof requestIdOrEntry === 'object'
      ? requestIdOrEntry
      : { ...(patch || {}), requestId: requestIdOrEntry };
    const requestId = source && source.requestId ? source.requestId : null;
    if (!requestId) {
      return null;
    }
    this.rows[requestId] = { ...(this.rows[requestId] || {}), ...(source || {}) };
    return this.rows[requestId];
  }

  async findByKey() {
    return null;
  }

  async get(requestId) {
    return this.rows[requestId] || null;
  }

  async markDone(requestId, patch) {
    this.rows[requestId] = {
      ...(this.rows[requestId] || {}),
      requestId,
      status: 'done',
      ...(patch || {})
    };
    return this.rows[requestId];
  }

  async markFailed(requestId, patch) {
    this.rows[requestId] = {
      ...(this.rows[requestId] || {}),
      requestId,
      status: 'failed',
      ...(patch || {})
    };
    return this.rows[requestId];
  }

  async markCancelled(requestId) {
    this.rows[requestId] = {
      ...(this.rows[requestId] || {}),
      requestId,
      status: 'cancelled'
    };
    return this.rows[requestId];
  }

  nextLease(nowTs) {
    return Number(nowTs || Date.now()) + 60_000;
  }
}

class FakeOffscreenManager {
  onMessage() {
    return () => {};
  }
}

async function run() {
  global.NT = {};
  load('extension/core/nt-namespace.js');
  load('extension/core/message-envelope.js');
  load('extension/bg/offscreen-llm-executor.js');

  const Executor = global.NT.OffscreenLlmExecutor;
  assert(Executor, 'OffscreenLlmExecutor must exist');

  const inflightStore = new MemoryInflightStore();
  const executor = new Executor({
    chromeApi: {},
    inflightStore,
    offscreenManager: new FakeOffscreenManager(),
    maxConcurrentRequests: 1,
    activeTabIdProvider: () => 1
  });

  let active = 0;
  let maxActive = 0;
  const startOrder = [];
  executor._dispatchOffscreenExecute = async ({ requestMeta }) => {
    const jobId = requestMeta && requestMeta.jobId ? requestMeta.jobId : 'unknown';
    startOrder.push(jobId);
    active += 1;
    maxActive = Math.max(maxActive, active);
    await delay(20);
    active -= 1;
    return {
      ok: true,
      status: 200,
      json: { ok: true, jobId }
    };
  };

  const makeCall = (jobId, blockId, tabId) => executor.execute({
    taskType: 'translation_execution',
    openaiRequest: {
      endpoint: '/v1/responses',
      headers: {},
      body: { input: `test:${jobId}:${blockId}`, stream: false }
    },
    requestMeta: {
      requestId: `${jobId}:${blockId}`,
      jobId,
      blockId,
      tabId,
      attempt: 1
    },
    timeoutMs: 5000,
    maxAttempts: 1
  });

  const calls = [
    makeCall('job-A', 'b1', 1),
    makeCall('job-B', 'b1', 2),
    makeCall('job-A', 'b2', 1),
    makeCall('job-B', 'b2', 2),
    makeCall('job-A', 'b3', 1)
  ];
  const results = await Promise.all(calls);
  assert.strictEqual(results.length, 5, 'all queued offscreen calls should resolve');
  assert.strictEqual(maxActive, 1, 'offscreen dispatch concurrency should be bounded by 1');
  assert(startOrder.slice(0, 4).includes('job-A') && startOrder.slice(0, 4).includes('job-B'), 'dispatch order should not starve either job');

  console.log('PASS: offscreen executor multiplex');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});