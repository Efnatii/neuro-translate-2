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
  load('extension/ai/ai-load-scheduler.js');

  const Scheduler = global.NT.AiLoadScheduler;
  assert(Scheduler, 'AiLoadScheduler must be defined');

  const scheduler = new Scheduler({ windowMs: 1000 });
  const startedAt = Date.now();
  await Promise.all(
    Array.from({ length: 20 }, (_, idx) => scheduler.reserveSlot({
      kind: `task-${idx}`,
      priority: 'high',
      estRpm: 1,
      estTokens: 1_000_000
    }))
  );
  const elapsedMs = Date.now() - startedAt;
  assert(elapsedMs < 500, 'Default scheduler should not enforce hidden RPM/TPM caps');

  const availability = scheduler.getAvailability();
  assert.strictEqual(availability.rpmRemaining, null, 'Default scheduler should expose unlimited RPM budget');
  assert.strictEqual(availability.tpmRemaining, null, 'Default scheduler should expose unlimited TPM budget');

  scheduler.onRateLimited({ retryAfterMs: 200, kind: 'LLM_REQUEST' });
  const backoffStartedAt = Date.now();
  await scheduler.reserveSlot({
    kind: 'after-backoff',
    priority: 'high',
    estRpm: 1,
    estTokens: 10
  });
  const backoffElapsedMs = Date.now() - backoffStartedAt;
  assert(backoffElapsedMs >= 150, 'Scheduler must still honor server retry-after backoff');

  console.log('PASS: ai-load-scheduler');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
