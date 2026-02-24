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

function parseToolOutput(raw) {
  assert.strictEqual(typeof raw, 'string', 'Tool output must be JSON string');
  const parsed = JSON.parse(raw);
  assert(parsed && typeof parsed === 'object', 'Tool output must parse into object');
  return parsed;
}

async function run() {
  global.NT = {};
  load('extension/ai/translation-agent.js');
  load('extension/ai/agent-tool-registry.js');

  const TranslationAgent = global.NT.TranslationAgent;
  const AgentToolRegistry = global.NT.AgentToolRegistry;
  assert(TranslationAgent, 'TranslationAgent must be defined');
  assert(AgentToolRegistry, 'AgentToolRegistry must be defined');

  const applyCalls = [];
  const runLlmRequest = async ({ taskType }) => {
    if (taskType === 'translation_agent_proofread_stream') {
      return {
        id: 'resp-proof-1',
        output_text: 'Одинаковый результат',
        __nt: { chosenModelSpec: 'gpt-4.1-mini:standard' }
      };
    }
    throw new Error(`Unexpected taskType in test: ${taskType}`);
  };

  const registry = new AgentToolRegistry({
    translationAgent: new TranslationAgent({}),
    persistJobState: async () => {},
    runLlmRequest,
    applyDelta: async ({ blockId, text, isFinal }) => {
      applyCalls.push({ blockId, text, isFinal: Boolean(isFinal) });
      return { ok: true, applied: true };
    }
  });

  const job = {
    id: 'job-proof-tools-1',
    tabId: 88,
    status: 'running',
    targetLang: 'ru',
    selectedCategories: ['paragraph'],
    pendingBlockIds: [],
    failedBlockIds: [],
    blocksById: {
      b1: {
        blockId: 'b1',
        category: 'paragraph',
        originalText: 'A long technical ORIGINAL with API and HTTP and JSON tokens for risk scoring.',
        translatedText: 'Короткий перевод.',
        quality: { tag: 'raw', lastUpdatedTs: Date.now() }
      },
      b2: {
        blockId: 'b2',
        category: 'paragraph',
        originalText: 'Second block original.',
        translatedText: 'Текущий перевод',
        quality: { tag: 'raw', lastUpdatedTs: Date.now() }
      },
      b3: {
        blockId: 'b3',
        category: 'paragraph',
        originalText: 'Already proofread text.',
        translatedText: 'Уже вычитано',
        quality: { tag: 'proofread', lastUpdatedTs: Date.now() }
      }
    },
    agentState: {
      status: 'running',
      phase: 'execution_in_progress',
      plan: { style: 'balanced' },
      checklist: [],
      reports: [],
      toolHistory: [],
      toolExecutionTrace: []
    }
  };

  const planAuto = parseToolOutput(await registry.execute({
    name: 'proof.plan_proofreading',
    arguments: {
      scope: 'all_selected_categories',
      mode: 'auto',
      maxBlocks: 1
    },
    job,
    settings: {},
    callId: 't-plan-auto'
  }));
  assert.strictEqual(planAuto.ok, true, 'proof.plan_proofreading should succeed');
  assert.strictEqual(Number(planAuto.pendingCount), 1, 'auto plan should respect maxBlocks');
  assert(!planAuto.blockIds.includes('b3'), 'auto plan should skip blocks that already have proof quality tag');

  const idempotentSkip = parseToolOutput(await registry.execute({
    name: 'proof.proofread_block_stream',
    arguments: {
      blockId: 'b3',
      mode: 'proofread'
    },
    job,
    settings: {},
    callId: 't-idempotent'
  }));
  assert.strictEqual(idempotentSkip.ok, true, 'proof.proofread_block_stream should return ok on idempotent skip');
  assert.strictEqual(idempotentSkip.skipped, true, 'proof.proofread_block_stream should skip when tag already matches');

  const firstProof = parseToolOutput(await registry.execute({
    name: 'proof.proofread_block_stream',
    arguments: {
      blockId: 'b2',
      mode: 'proofread'
    },
    job,
    settings: {},
    callId: 't-proof-1'
  }));
  assert.strictEqual(firstProof.ok, true, 'first proofread call should succeed');
  assert.strictEqual(firstProof.qualityTag, 'proofread', 'first proofread call should map mode to proofread quality tag');

  const secondProof = parseToolOutput(await registry.execute({
    name: 'proof.proofread_block_stream',
    arguments: {
      blockId: 'b2',
      mode: 'proofread'
    },
    job,
    settings: {},
    callId: 't-proof-2'
  }));
  assert.strictEqual(secondProof.ok, false, 'second identical proofread result should be blocked by repeat guard');
  assert.strictEqual(secondProof.code, 'NO_IMPROVEMENT', 'repeat guard should return NO_IMPROVEMENT');

  const uiAction = parseToolOutput(await registry.execute({
    name: 'ui.request_block_action',
    arguments: {
      blockId: 'b1',
      action: 'literal'
    },
    job,
    settings: {},
    callId: 't-ui-action'
  }));
  assert.strictEqual(uiAction.ok, true, 'ui.request_block_action should succeed');
  assert(job.proofreading && Array.isArray(job.proofreading.pendingBlockIds) && job.proofreading.pendingBlockIds.includes('b1'), 'ui.request_block_action should enqueue target block');
  assert.strictEqual(job.proofreading.requestedActionByBlockId.b1, 'literal', 'ui.request_block_action should persist requested action');

  const uiScope = parseToolOutput(await registry.execute({
    name: 'ui.request_proofread_scope',
    arguments: {
      scope: 'blocks',
      blockIds: ['b1'],
      mode: 'manual'
    },
    job,
    settings: {},
    callId: 't-ui-scope'
  }));
  assert.strictEqual(uiScope.ok, true, 'ui.request_proofread_scope should succeed');
  assert(uiScope.planned && uiScope.planned.ok === true, 'ui.request_proofread_scope should return planned payload');
  assert.strictEqual(job.agentState.phase, 'proofreading_in_progress', 'ui.request_proofread_scope should move phase to proofreading');

  job.proofreading.pendingBlockIds = [];
  job.proofreading.doneBlockIds = ['b1'];
  const finish = parseToolOutput(await registry.execute({
    name: 'proof.finish',
    arguments: { reason: 'unit-test' },
    job,
    settings: {},
    callId: 't-finish'
  }));
  assert.strictEqual(finish.ok, true, 'proof.finish should succeed when pending is empty');
  assert.strictEqual(Number(finish.pendingCount), 0, 'proof.finish should keep pending count zero');
  assert.strictEqual(job.agentState.phase, 'proofreading_done', 'proof.finish should mark proofreading_done phase');

  const finalApply = applyCalls.length ? applyCalls[applyCalls.length - 1] : null;
  assert(finalApply && finalApply.isFinal === true, 'proofread stream should produce final page.apply_delta');

  console.log('PASS: proofreading tools');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
