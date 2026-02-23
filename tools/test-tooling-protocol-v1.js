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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  global.NT = {};
  load('extension/ai/tool-manifest.js');
  load('extension/ai/tool-policy.js');
  load('extension/ai/tool-execution-engine.js');

  const ToolManifest = global.NT.ToolManifest;
  const ToolPolicyResolver = global.NT.ToolPolicyResolver;
  const ToolExecutionEngine = global.NT.ToolExecutionEngine;

  assert(ToolManifest, 'ToolManifest must be defined');
  assert(ToolPolicyResolver, 'ToolPolicyResolver must be defined');
  assert(ToolExecutionEngine, 'ToolExecutionEngine must be defined');

  // 1) Manifest hash must change when schema changes.
  const manifestA = new ToolManifest();
  const toolsB = JSON.parse(JSON.stringify(manifestA.tools || []));
  const applyIdx = toolsB.findIndex((tool) => tool && tool.name === 'page.apply_delta');
  assert(applyIdx >= 0, 'page.apply_delta must exist in default manifest');
  toolsB[applyIdx].toolVersion = '1.1.0';
  toolsB[applyIdx].parametersJsonSchema = toolsB[applyIdx].parametersJsonSchema || { type: 'object', properties: {} };
  toolsB[applyIdx].parametersJsonSchema.properties = toolsB[applyIdx].parametersJsonSchema.properties || {};
  toolsB[applyIdx].parametersJsonSchema.properties.previewMode = { type: 'boolean' };
  const manifestB = new ToolManifest({
    toolsetSemver: '1.0.1',
    tools: toolsB
  });
  assert.notStrictEqual(
    manifestA.toolsetHash,
    manifestB.toolsetHash,
    'toolsetHash must change after tool schema update'
  );

  // 2) Capabilities negotiation must disable apply_delta when unsupported.
  const resolver = new ToolPolicyResolver({ toolManifest: manifestA });
  const resolved = resolver.resolve({
    profileDefaults: { 'page.apply_delta': 'on' },
    userOverrides: {},
    agentProposal: {},
    capabilities: {
      content: { supportsApplyDelta: false },
      offscreen: { supportsStream: true }
    },
    stage: 'execution'
  });
  assert.strictEqual(
    resolved.effective['page.apply_delta'],
    'off',
    'page.apply_delta must be forced off when content capability is missing'
  );
  assert(
    String(resolved.reasons['page.apply_delta'] || '').includes('missing_capability'),
    'reason must include missing_capability'
  );

  // 3) Coalesce/debounce apply_delta: 20 calls in burst -> 1 dom write.
  let domWriteCount = 0;
  const coalesceJob = { id: 'job-coalesce-1', agentState: {} };
  const coalesceEngine = new ToolExecutionEngine({
    toolManifest: manifestA,
    persistJobState: async () => {}
  });
  const burstCalls = [];
  for (let i = 0; i < 20; i += 1) {
    burstCalls.push(coalesceEngine.executeToolCall({
      job: coalesceJob,
      stage: 'execution',
      responseId: 'resp-coalesce-1',
      callId: `call-coalesce-${i}`,
      toolName: 'page.apply_delta',
      toolArgs: {
        blockId: 'block-1',
        text: `delta-${i}`,
        isFinal: false
      },
      executeNow: async () => {
        domWriteCount += 1;
        return { ok: true, applied: true };
      }
    }));
  }
  await Promise.all(burstCalls);
  await sleep(260);
  assert.strictEqual(domWriteCount, 1, 'coalesced burst should perform exactly one dom_write');
  const trace = Array.isArray(coalesceJob.agentState.toolExecutionTrace)
    ? coalesceJob.agentState.toolExecutionTrace
    : [];
  const hasCoalesceTrace = trace.some((row) => row && row.qos && Number(row.qos.coalescedCount || 0) === 19);
  assert(hasCoalesceTrace, 'trace must include coalescedCount=19 for burst calls');

  // 4) Idempotency replay by call_id after simulated restart.
  let sideEffectCount = 0;
  const replayJob = { id: 'job-replay-1', agentState: {} };
  const engineA = new ToolExecutionEngine({
    toolManifest: manifestA,
    persistJobState: async () => {}
  });
  const firstRun = await engineA.executeToolCall({
    job: replayJob,
    stage: 'execution',
    responseId: 'resp-replay-1',
    callId: 'call-replay-1',
    toolName: 'job.mark_block_done',
    toolArgs: { blockId: 'b1', text: 'ready' },
    executeNow: async () => {
      sideEffectCount += 1;
      return { ok: true, persisted: true };
    }
  });
  assert.strictEqual(firstRun.status, 'ok', 'first call must execute normally');
  assert.strictEqual(sideEffectCount, 1, 'first call must perform one side effect');

  const engineB = new ToolExecutionEngine({
    toolManifest: manifestA,
    persistJobState: async () => {}
  });
  const replayRun = await engineB.executeToolCall({
    job: replayJob,
    stage: 'execution',
    responseId: 'resp-replay-2',
    callId: 'call-replay-1',
    toolName: 'job.mark_block_done',
    toolArgs: { blockId: 'b1', text: 'ready' },
    executeNow: async () => {
      sideEffectCount += 1;
      return { ok: true, persisted: true, unexpected: true };
    }
  });
  assert.strictEqual(replayRun.status, 'skipped', 'replay call must be served from stored output');
  assert.strictEqual(sideEffectCount, 1, 'replay must not repeat side effect');

  console.log('PASS: tool protocol v1');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
