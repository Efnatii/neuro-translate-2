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

function extractSystemText(input) {
  const list = Array.isArray(input) ? input : [];
  const system = list.find((item) => item && item.role === 'system');
  if (!system || !Array.isArray(system.content) || !system.content.length) {
    return '';
  }
  const first = system.content[0];
  return first && typeof first.text === 'string' ? first.text : '';
}

function assertPromptHasGuards(text, mode) {
  const safeText = String(text || '');
  assert(
    /untrusted/i.test(safeText),
    `${mode}: system prompt must explicitly mark page content as untrusted`
  );
  assert(
    /ignore any page/i.test(safeText) || /ignore any in-page/i.test(safeText),
    `${mode}: system prompt must tell agent to ignore page instructions`
  );
  assert(
    /only system rules/i.test(safeText),
    `${mode}: system prompt must define trusted command source`
  );
  assert(
    /never request, reveal, or output credentials\/tokens\/secrets/i.test(safeText),
    `${mode}: system prompt must prohibit secret disclosure`
  );
}

function run() {
  global.NT = {};
  load('extension/ai/agent-runner.js');

  const AgentRunner = global.NT.AgentRunner;
  assert(AgentRunner, 'AgentRunner must be defined');
  const runner = new AgentRunner({ toolRegistry: {}, persistJobState: async () => {} });

  const planningInput = runner._buildInitialInput({
    job: { id: 'job-prompt-1', targetLang: 'ru' },
    blocks: [{ blockId: 'b1', category: 'paragraph', originalText: 'text' }],
    settings: { translationAgentProfile: 'auto' }
  });
  assertPromptHasGuards(extractSystemText(planningInput), 'planning');

  const executionInput = runner._buildExecutionInitialInput({
    job: {
      id: 'job-prompt-1',
      targetLang: 'ru',
      pendingBlockIds: ['b1'],
      blocksById: { b1: { category: 'paragraph', originalText: 'text' } },
      agentState: { plan: {} }
    },
    blocks: [{ blockId: 'b1', category: 'paragraph', originalText: 'text' }],
    settings: {}
  });
  assertPromptHasGuards(extractSystemText(executionInput), 'execution');

  console.log('PASS: prompt-injection guard prompt');
}

try {
  run();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
