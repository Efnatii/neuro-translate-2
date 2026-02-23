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

async function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  global.NT = {};
  load('extension/ai/translation-agent.js');
  load('extension/ai/agent-tool-registry.js');
  load('extension/ai/agent-runner.js');

  const TranslationAgent = global.NT.TranslationAgent;
  const AgentToolRegistry = global.NT.AgentToolRegistry;
  const AgentRunner = global.NT.AgentRunner;
  assert(TranslationAgent, 'TranslationAgent must be defined');
  assert(AgentToolRegistry, 'AgentToolRegistry must be defined');
  assert(AgentRunner, 'AgentRunner must be defined');

  const agent = new TranslationAgent({});
  const job = {
    id: 'job-exec-1',
    tabId: 77,
    targetLang: 'ru',
    status: 'running',
    totalBlocks: 1,
    completedBlocks: 0,
    pendingBlockIds: ['b1'],
    failedBlockIds: [],
    blocksById: {
      b1: {
        blockId: 'b1',
        category: 'paragraph',
        pathHint: 'body > p',
        originalText: 'Hello'
      }
    },
    selectedCategories: ['paragraph'],
    agentState: {
      status: 'running',
      phase: 'execution_in_progress',
      profile: 'balanced',
      plan: { style: 'balanced', instructions: 'Keep text natural.' },
      glossary: [{ term: 'Hello', hint: 'UI greeting' }],
      contextSummary: 'Page context.',
      checklist: agent._buildInitialChecklist(),
      reports: [],
      toolHistory: [],
      toolExecutionTrace: []
    }
  };
  const blocks = [job.blocksById.b1];
  const applyCalls = [];
  let executionLoopCall = 0;

  const runLlmRequest = async ({ taskType, request }) => {
    if (taskType === 'translation_agent_execute_stream') {
      if (request && typeof request.onEvent === 'function') {
        request.onEvent({ type: 'response.output_text.delta', delta: 'Пр' });
        request.onEvent({ type: 'response.output_text.delta', delta: 'ивет' });
      }
      return {
        id: 'resp-stream-1',
        output_text: 'Привет',
        __nt: {
          chosenModelSpec: 'gpt-4.1-mini:standard'
        }
      };
    }

    if (taskType === 'translation_agent_execute') {
      executionLoopCall += 1;
      if (executionLoopCall === 1) {
        return {
          id: 'resp-exec-1',
          output: [{
            type: 'function_call',
            call_id: 'call_translate_1',
            name: 'translator.translate_block_stream',
            arguments: JSON.stringify({ blockId: 'b1', route: 'fast', model: 'auto' })
          }]
        };
      }
      if (executionLoopCall === 2) {
        return {
          id: 'resp-exec-2',
          output: [{
            type: 'function_call',
            call_id: 'call_done_1',
            name: 'job.mark_block_done',
            arguments: JSON.stringify({
              blockId: 'b1',
              text: 'Привет',
              modelUsed: 'gpt-4.1-mini:standard',
              routeUsed: 'fast'
            })
          }]
        };
      }
      return {
        id: 'resp-exec-3',
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'done' }]
        }],
        output_text: 'done'
      };
    }

    throw new Error(`Unexpected taskType: ${taskType}`);
  };

  const registry = new AgentToolRegistry({
    translationAgent: agent,
    persistJobState: async () => {},
    runLlmRequest,
    applyDelta: async ({ blockId, text, isFinal }) => {
      applyCalls.push({ blockId, text, isFinal: Boolean(isFinal) });
      return { ok: true, applied: true };
    }
  });

  const runner = new AgentRunner({
    toolRegistry: registry,
    persistJobState: async () => {}
  });

  const result = await runner.runExecution({
    job,
    blocks,
    settings: {
      translationModelList: ['gpt-4.1-mini:standard'],
      translationAgentAllowedModels: ['gpt-4.1-mini:standard'],
      translationAgentTuning: {
        executionMaxIterationsPerTick: 8,
        executionMaxNoProgressIterations: 3
      }
    },
    runLlmRequest
  });

  await waitMs(220);
  assert(result && result.ok === true, 'Execution loop should complete');
  assert.strictEqual(Array.isArray(job.pendingBlockIds) ? job.pendingBlockIds.length : 0, 0, 'Pending list should be empty after mark_block_done');
  assert.strictEqual(job.blocksById.b1.translatedText, 'Привет', 'Block should store final translated text');
  assert(Array.isArray(job.agentState.recentDiffItems) && job.agentState.recentDiffItems.length >= 1, 'recentDiffItems should be updated on block completion');
  assert(applyCalls.length >= 1, 'translate_block_stream should send at least one page.apply_delta');
  assert(applyCalls.length <= 2, 'page.apply_delta calls should be debounced');
  const finalApply = applyCalls[applyCalls.length - 1];
  assert(finalApply && finalApply.isFinal === true, 'Final delta apply should be marked as final');
  assert.strictEqual(finalApply.text, 'Привет', 'Final delta should contain complete translated text');

  console.log('PASS: agent execution stream tool flow');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
