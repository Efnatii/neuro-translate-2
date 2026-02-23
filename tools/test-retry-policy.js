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

async function run() {
  global.NT = {};
  load('extension/core/retry-policy.js');

  const policy = global.NT.RetryPolicy;
  assert(policy, 'RetryPolicy must be defined');

  const b1 = policy.computeBackoffMs({ attempt: 1, baseMs: 1000, maxMs: 10000, jitterRatio: 0, randomFn: () => 0.5 });
  const b2 = policy.computeBackoffMs({ attempt: 2, baseMs: 1000, maxMs: 10000, jitterRatio: 0, randomFn: () => 0.5 });
  const b3 = policy.computeBackoffMs({ attempt: 3, baseMs: 1000, maxMs: 10000, jitterRatio: 0, randomFn: () => 0.5 });
  assert.strictEqual(b1, 1000, 'attempt=1 backoff must equal base');
  assert.strictEqual(b2, 2000, 'attempt=2 backoff must be exponential');
  assert.strictEqual(b3, 4000, 'attempt=3 backoff must be exponential');

  assert.strictEqual(policy.shouldRetry({
    attempt: 0,
    maxAttempts: 3,
    firstAttemptTs: Date.now() - 5000,
    maxTotalMs: 60 * 1000
  }), true, 'attempt below maxAttempts should retry');

  assert.strictEqual(policy.shouldRetry({
    attempt: 3,
    maxAttempts: 3,
    firstAttemptTs: Date.now(),
    maxTotalMs: 60 * 1000
  }), false, 'attempt at maxAttempts should stop');

  assert.strictEqual(policy.shouldRetry({
    attempt: 1,
    maxAttempts: 5,
    firstAttemptTs: Date.now() - (10 * 60 * 1000),
    maxTotalMs: 1000
  }), false, 'elapsed above maxTotalMs should stop');

  const err429 = policy.classifyError({ status: 429, message: 'Rate limited' });
  assert.strictEqual(err429.code, 'OPENAI_429', '429 must map to OPENAI_429');
  assert.strictEqual(err429.isRetryable, true, '429 must be retryable');

  const errLease = policy.classifyError({ code: 'LEASE_EXPIRED', message: 'lease expired' });
  assert.strictEqual(errLease.code, 'LEASE_EXPIRED', 'LEASE_EXPIRED code must be preserved');
  assert.strictEqual(errLease.isRetryable, true, 'LEASE_EXPIRED must be retryable');

  const errTab = policy.classifyError({ code: 'TAB_GONE', message: 'tab closed' });
  assert.strictEqual(errTab.code, 'TAB_GONE', 'TAB_GONE must be classified');
  assert.strictEqual(errTab.isRetryable, false, 'TAB_GONE should not retry');

  console.log('PASS: retry policy');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
