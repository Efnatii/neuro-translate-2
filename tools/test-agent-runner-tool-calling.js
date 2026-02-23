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
    id: 'job-plan-1',
    tabId: 44,
    targetLang: 'ru',
    agentState: {
      status: 'running',
      phase: 'planning_in_progress',
      profile: 'balanced',
      resolvedProfile: { style: 'balanced', maxBatchSize: 8, proofreadingPasses: 1, parallelism: 'mixed' },
      checklist: agent._buildInitialChecklist(),
      reports: [],
      toolHistory: [],
      toolExecutionTrace: []
    }
  };
  const blocks = [
    { blockId: 'b1', originalText: 'Hello world', category: 'paragraph', pathHint: 'p' },
    { blockId: 'b2', originalText: 'Save', category: 'button', pathHint: 'button' }
  ];

  const requestPayloads = [];
  const runLlmRequest = async (payload) => {
    requestPayloads.push(payload);
    if (requestPayloads.length === 1) {
      return {
        id: 'resp_plan_1',
        output: [
          {
            type: 'reasoning',
            summary: [{ type: 'summary_text', text: 'Collecting page context before setting plan.' }]
          },
          {
            type: 'function_call',
            call_id: 'call_plan_1',
            name: 'agent.set_plan',
            arguments: JSON.stringify({
              batchSize: 5,
              style: 'balanced',
              proofreadingPasses: 2,
              categoryOrder: ['paragraph', 'button'],
              recommendedCategories: ['paragraph'],
              summary: 'Plan set by model'
            })
          },
          {
            type: 'function_call',
            call_id: 'call_cat_1',
            name: 'agent.set_recommended_categories',
            arguments: JSON.stringify({
              categories: ['paragraph'],
              reason: 'Primary content category'
            })
          }
        ]
      };
    }
    return {
      id: 'resp_plan_2',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'planning complete' }]
        }
      ],
      output_text: 'planning complete'
    };
  };

  const registry = new AgentToolRegistry({
    translationAgent: agent,
    persistJobState: async () => {}
  });
  const runner = new AgentRunner({
    toolRegistry: registry,
    persistJobState: async () => {}
  });

  const result = await runner.runPlanning({
    job,
    blocks,
    settings: {
      translationAgentProfile: 'balanced',
      translationAgentTuning: {
        plannerMaxSteps: 4,
        plannerMaxToolCalls: 8
      }
    },
    runLlmRequest
  });

  assert(result && result.ok === true, 'Planning loop should complete successfully');
  assert.strictEqual(requestPayloads.length, 2, 'Planning loop should issue follow-up request after function call');
  const secondInput = requestPayloads[1] && requestPayloads[1].request ? requestPayloads[1].request.input : [];
  assert(Array.isArray(secondInput), 'Second request input should be an array');
  assert(secondInput.some((item) => item && item.type === 'reasoning'), 'Reasoning items must be replayed into the next request');
  const callOutput = secondInput.find((item) => item && item.type === 'function_call_output' && item.call_id === 'call_plan_1');
  assert(callOutput, 'Function call output must be appended into next request');
  assert.strictEqual(callOutput.call_id, 'call_plan_1', 'Function call output must preserve call_id');
  const categoryOutput = secondInput.find((item) => item && item.type === 'function_call_output' && item.call_id === 'call_cat_1');
  assert(categoryOutput, 'Second tool output must be appended into next request');

  const parsedOutput = JSON.parse(callOutput.output);
  assert(parsedOutput && parsedOutput.ok === true, 'Tool output must be JSON and indicate success');
  assert(job.agentState && job.agentState.plan && job.agentState.plan.batchSize === 5, 'agent.set_plan must update job.agentState.plan');
  assert(Array.isArray(job.agentState.selectedCategories) && job.agentState.selectedCategories.includes('paragraph'), 'agent.set_plan should set recommended categories');

  const trace = Array.isArray(job.agentState.toolExecutionTrace) ? job.agentState.toolExecutionTrace : [];
  const traceRow = trace.find((row) => row && row.meta && row.meta.callId === 'call_plan_1');
  assert(traceRow, 'Tool execution trace must include call_id metadata');

  console.log('PASS: agent runner tool calling');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
