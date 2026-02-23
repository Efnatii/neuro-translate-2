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
    this.jobs = {};
  }

  async getJob(jobId) {
    return this.jobs[jobId] || null;
  }

  async upsertJob(job) {
    this.jobs[job.id] = { ...(this.jobs[job.id] || {}), ...(job || {}) };
    return this.jobs[job.id];
  }
}

function createChrome() {
  return {
    tabs: {
      get(tabId, cb) {
        cb({ id: Number(tabId), url: 'https://example.test' });
      }
    },
    runtime: {
      lastError: null
    }
  };
}

async function run() {
  global.NT = {};
  load('extension/core/retry-policy.js');
  load('extension/bg/job-runner.js');

  const JobRunner = global.NT.JobRunner;
  assert(JobRunner, 'JobRunner must be defined');

  const store = new MemoryJobStore();
  const failedCalls = [];
  const orchestrator = {
    processingJobs: new Set(),
    async _saveJob(job) {
      await store.upsertJob(job);
    },
    async _markFailed(job, error) {
      failedCalls.push({ jobId: job.id, error });
      job.status = 'failed';
      job.lastError = error;
      await store.upsertJob(job);
    },
    _processJob() {}
  };

  const runner = new JobRunner({
    chromeApi: createChrome(),
    jobStore: store,
    translationOrchestrator: orchestrator,
    retryPolicy: global.NT.RetryPolicy,
    maxAttempts: 3,
    maxTotalMs: 10 * 60 * 1000,
    leaseMs: 60 * 1000
  });

  const now = Date.now();
  await store.upsertJob({
    id: 'job-retry-lease',
    tabId: 1,
    status: 'running',
    updatedAt: now - 20000,
    createdAt: now - 60000,
    leaseUntilTs: now - 1000,
    pendingBlockIds: ['b1'],
    failedBlockIds: [],
    completedBlocks: 0,
    totalBlocks: 1,
    runtime: {
      status: 'RUNNING',
      stage: 'execution',
      lease: {
        leaseUntilTs: now - 1000,
        heartbeatTs: now - 5000,
        op: 'execution',
        opId: 'op1'
      },
      retry: {
        attempt: 0,
        maxAttempts: 3,
        nextRetryAtTs: 0,
        firstAttemptTs: now - 10000,
        lastError: null
      },
      watchdog: {
        lastProgressTs: now - 3000,
        lastProgressKey: '0:0:1:0:execution'
      }
    }
  });

  const requeueResult = await runner.step({ id: 'job-retry-lease' }, { reason: 'unit' });
  assert.strictEqual(requeueResult.ok, true, 'lease-expired job should be recovered via retry');
  const requeuedJob = await store.getJob('job-retry-lease');
  assert.strictEqual(requeuedJob.status, 'preparing', 'lease-expired running job should be requeued to preparing');
  assert.strictEqual(requeuedJob.runtime.status, 'QUEUED', 'runtime status should move to QUEUED');
  assert.strictEqual(requeuedJob.runtime.retry.attempt, 1, 'retry attempt should increment');
  assert(requeuedJob.runtime.retry.nextRetryAtTs > Date.now(), 'nextRetryAtTs should be in future');
  assert.strictEqual(failedCalls.length, 0, 'recoverable lease expiration should not fail job');

  await store.upsertJob({
    id: 'job-fail-lease',
    tabId: 2,
    status: 'running',
    updatedAt: now - 20000,
    createdAt: now - 60000,
    leaseUntilTs: now - 1000,
    pendingBlockIds: ['c1'],
    failedBlockIds: [],
    completedBlocks: 0,
    totalBlocks: 1,
    runtime: {
      status: 'RUNNING',
      stage: 'execution',
      lease: {
        leaseUntilTs: now - 2000,
        heartbeatTs: now - 8000,
        op: 'execution',
        opId: 'op2'
      },
      retry: {
        attempt: 3,
        maxAttempts: 3,
        nextRetryAtTs: 0,
        firstAttemptTs: now - (11 * 60 * 1000),
        lastError: null
      },
      watchdog: {
        lastProgressTs: now - 4000,
        lastProgressKey: '0:0:1:0:execution'
      }
    }
  });

  const failResult = await runner.step({ id: 'job-fail-lease' }, { reason: 'unit' });
  assert.strictEqual(Boolean(failResult && failResult.terminal), true, 'non-recoverable lease expiration should terminate');
  const failedJob = await store.getJob('job-fail-lease');
  assert.strictEqual(failedJob.status, 'failed', 'exhausted lease retries should fail job');
  assert.strictEqual(
    failedCalls[failedCalls.length - 1] && failedCalls[failedCalls.length - 1].error && failedCalls[failedCalls.length - 1].error.code,
    'LEASE_EXPIRED_NO_RECOVERY',
    'failure should use LEASE_EXPIRED_NO_RECOVERY code'
  );

  console.log('PASS: job-runner lease recovery');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
