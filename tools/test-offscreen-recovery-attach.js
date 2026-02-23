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

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class MemoryInflightStore {
  constructor() {
    this.rows = {};
  }

  async upsert(requestIdOrEntry, patch) {
    const src = requestIdOrEntry && typeof requestIdOrEntry === 'object'
      ? requestIdOrEntry
      : { ...(patch || {}), requestId: requestIdOrEntry };
    const requestId = src.requestId;
    if (!requestId) {
      return null;
    }
    this.rows[requestId] = { ...(this.rows[requestId] || {}), ...(src || {}) };
    return this.rows[requestId];
  }

  async listPending({ limit = 200 } = {}) {
    return Object.keys(this.rows)
      .map((requestId) => this.rows[requestId])
      .filter((row) => row && row.status === 'pending')
      .slice(0, limit);
  }

  async markDone(requestId, { rawJson = null, rawResult = null } = {}) {
    this.rows[requestId] = {
      ...(this.rows[requestId] || {}),
      requestId,
      status: 'done',
      rawJson,
      rawResult,
      error: null
    };
    return this.rows[requestId];
  }

  async markFailed(requestId, { error = null } = {}) {
    this.rows[requestId] = {
      ...(this.rows[requestId] || {}),
      requestId,
      status: 'failed',
      error: error || { code: 'FAILED', message: 'failed' }
    };
    return this.rows[requestId];
  }

  async get(requestId) {
    return this.rows[requestId] || null;
  }

  nextLease(nowTs) {
    return Number(nowTs || Date.now()) + 60_000;
  }

  async touchStreamHeartbeat(requestId, { leaseUntilTs = null } = {}) {
    const now = Date.now();
    this.rows[requestId] = {
      ...(this.rows[requestId] || {}),
      requestId,
      status: 'pending',
      lastEventTs: now,
      leaseUntilTs: Number.isFinite(Number(leaseUntilTs)) ? Number(leaseUntilTs) : this.nextLease(now),
      updatedAt: now
    };
    return this.rows[requestId];
  }
}

class FakeOffscreenManager {
  constructor() {
    this.listeners = new Set();
    this.attached = [];
    this.active = [
      { requestId: 'req-active', startedTs: Date.now() - 5000, lastEventTs: Date.now() - 2000, mode: 'stream' },
      { requestId: 'req-unknown', startedTs: Date.now() - 3000, lastEventTs: Date.now() - 1000, mode: 'stream' }
    ];
  }

  onMessage(handler) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit(parsed) {
    this.listeners.forEach((handler) => {
      handler(parsed);
    });
  }

  async ensureReady() {
    return true;
  }

  getActiveRequests() {
    return this.active.slice();
  }

  getConnectionState() {
    return {
      connected: true,
      offscreenInstanceId: 'offscreen-test',
      activeRequestsCount: this.active.length
    };
  }

  async attach(requestId) {
    this.attached.push(requestId);
    return true;
  }

  async queryStatus(requestIds) {
    const out = {};
    (requestIds || []).forEach((requestId) => {
      if (requestId === 'req-lost') {
        out[requestId] = { status: 'missing', result: null };
      } else if (requestId === 'req-active' || requestId === 'req-unknown') {
        out[requestId] = { status: 'pending', result: null };
      }
    });
    return out;
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
  await inflightStore.upsert({
    requestId: 'req-active',
    status: 'pending',
    requestKey: 'job1:block1:1:execution',
    createdAt: Date.now() - 6000,
    updatedAt: Date.now() - 5000
  });
  await inflightStore.upsert({
    requestId: 'req-lost',
    status: 'pending',
    requestKey: 'job2:block1:1:execution',
    createdAt: Date.now() - 6000,
    updatedAt: Date.now() - 5000
  });

  const manager = new FakeOffscreenManager();
  const executor = new Executor({
    chromeApi: {},
    inflightStore,
    offscreenManager: manager
  });

  const recover = await executor.recoverInflightRequests({ limit: 50 });
  assert.strictEqual(recover.ok, true, 'recovery should complete');
  assert.strictEqual(recover.activeInOffscreen, 2, 'recovery should see active offscreen requests');
  assert(manager.attached.includes('req-active'), 'active known request should be attached');
  assert(manager.attached.includes('req-unknown'), 'active unknown request should also be attached');

  const unknownRow = await inflightStore.get('req-unknown');
  assert(unknownRow && unknownRow.status === 'pending', 'unknown active request should be persisted as pending');

  const lostRow = await inflightStore.get('req-lost');
  assert(lostRow && lostRow.status === 'failed', 'missing request should be marked failed');
  assert.strictEqual(lostRow.error && lostRow.error.code, 'OFFSCREEN_REQUEST_LOST', 'missing request should use OFFSCREEN_REQUEST_LOST code');

  manager.emit({
    type: 'OFFSCREEN_STREAM_EVENT',
    payload: {
      requestId: 'req-active',
      event: {
        type: 'response.output_text.delta',
        delta: 'hello'
      }
    }
  });
  await wait(180);
  const touched = await inflightStore.get('req-active');
  assert(touched && touched.status === 'pending', 'stream event after attach should keep pending status');
  assert(Number.isFinite(Number(touched.lastEventTs)), 'stream event after attach should update lastEventTs');

  manager.emit({
    type: 'OFFSCREEN_RESULT',
    payload: {
      requestId: 'req-active',
      ok: true,
      status: 200,
      json: { ok: true }
    }
  });
  await wait(50);
  const done = await inflightStore.get('req-active');
  assert(done && done.status === 'done', 'attached request should finalize to done when result arrives');

  console.log('PASS: offscreen recovery attach');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
