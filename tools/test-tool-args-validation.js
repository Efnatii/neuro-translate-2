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
  load('extension/core/json-schema-validator.js');
  load('extension/ai/tool-manifest.js');
  load('extension/ai/tool-execution-engine.js');

  const ToolManifest = global.NT.ToolManifest;
  const ToolExecutionEngine = global.NT.ToolExecutionEngine;
  assert(ToolManifest, 'ToolManifest must be defined');
  assert(ToolExecutionEngine, 'ToolExecutionEngine must be defined');

  const manifest = new ToolManifest();
  const engine = new ToolExecutionEngine({
    toolManifest: manifest,
    persistJobState: async () => {}
  });

  const job = { id: 'job-security-validation-1', agentState: {} };
  let sideEffects = 0;
  const out = await engine.executeToolCall({
    job,
    stage: 'execution',
    responseId: 'resp-validation-1',
    callId: 'call-validation-1',
    toolName: 'page.get_stats',
    toolArgs: { unexpectedField: true },
    executeNow: async () => {
      sideEffects += 1;
      return { ok: true };
    }
  });

  assert.strictEqual(out.status, 'failed', 'Tool call with unknown fields must fail validation');
  assert.strictEqual(sideEffects, 0, 'Validation failure must block tool side effects');
  const parsed = JSON.parse(out.outputString || '{}');
  assert.strictEqual(parsed.ok, false, 'Validation failure output should be an error object');
  assert.strictEqual(parsed.error && parsed.error.code, 'TOOL_ARGS_INVALID', 'Validation failure must return TOOL_ARGS_INVALID');

  const trace = Array.isArray(job.agentState.toolExecutionTrace) ? job.agentState.toolExecutionTrace : [];
  const failedTrace = trace.find((row) => row && row.errorCode === 'TOOL_ARGS_INVALID');
  assert(failedTrace, 'Tool trace must contain TOOL_ARGS_INVALID record');

  console.log('PASS: tool args validation');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
