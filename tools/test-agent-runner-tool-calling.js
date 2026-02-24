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
  const now = Date.now();
  const baseAgentState = {
    status: 'running',
    phase: 'planning_in_progress',
    profile: 'balanced',
    resolvedProfile: { style: 'balanced', maxBatchSize: 8, proofreadingPasses: 1, parallelism: 'mixed' },
    checklist: agent._buildInitialChecklist(),
    reports: [],
    toolHistory: [],
    toolExecutionTrace: [],
    planningMarkers: {},
    createdAt: now,
    updatedAt: now
  };
  const blocks = [
    { blockId: 'b1', originalText: 'Hello world', category: 'main_content', preCategory: 'paragraph', pathHint: 'main > p', domOrder: 1 },
    { blockId: 'b2', originalText: 'Save', category: 'ui_controls', preCategory: 'button', pathHint: 'form > button', domOrder: 2 }
  ];
  const pageAnalysis = {
    domHash: 'dom:2:abc',
    preanalysisVersion: 'dom-preanalysis/1.0.0',
    stats: {
      blockCount: 2,
      totalChars: 16,
      byPreCategory: { paragraph: 1, button: 1 },
      rangeCount: 2
    },
    blocksById: {
      b1: blocks[0],
      b2: blocks[1]
    },
    preRangesById: {
      r1: { rangeId: 'r1', preCategory: 'paragraph', blockIds: ['b1'], domOrderFrom: 1, domOrderTo: 1, anchorHint: 'main:1' },
      r2: { rangeId: 'r2', preCategory: 'button', blockIds: ['b2'], domOrderFrom: 2, domOrderTo: 2, anchorHint: 'form:1' }
    }
  };
  const job = {
    id: 'job-plan-1',
    tabId: 44,
    targetLang: 'ru',
    status: 'planning',
    selectedCategories: [],
    availableCategories: [],
    blocksById: {
      b1: { ...blocks[0] },
      b2: { ...blocks[1] }
    },
    pageAnalysis,
    agentState: JSON.parse(JSON.stringify(baseAgentState))
  };

  const registry = new AgentToolRegistry({
    translationAgent: agent,
    persistJobState: async () => {}
  });

  const invalidFinish = await registry.execute({
    name: 'agent.plan.request_finish_analysis',
    arguments: { reason: 'premature check' },
    job: {
      id: 'job-invalid-finish',
      tabId: 45,
      targetLang: 'ru',
      status: 'planning',
      blocksById: job.blocksById,
      pageAnalysis,
      agentState: JSON.parse(JSON.stringify(baseAgentState))
    },
    blocks,
    settings: {},
    callId: 'call_invalid_finish',
    source: 'model'
  });
  const invalidFinishJson = JSON.parse(invalidFinish);
  assert.strictEqual(invalidFinishJson.ok, false, 'request_finish_analysis must report missing plan state');
  assert(
    Array.isArray(invalidFinishJson.missing) && invalidFinishJson.missing.length > 0,
    'request_finish_analysis must expose missing fields'
  );

  const badAskRaw = await registry.execute({
    name: 'agent.ui.ask_user_categories',
    arguments: {
      questionRu: 'Какие категории перевести?',
      categories: [{ id: 'main_content', titleRu: 'Контент', descriptionRu: '', countUnits: 1 }],
      defaults: ['main_content']
    },
    job: {
      id: 'job-bad-seq',
      tabId: 46,
      targetLang: 'ru',
      status: 'planning',
      selectedCategories: [],
      availableCategories: [],
      blocksById: job.blocksById,
      pageAnalysis,
      agentState: JSON.parse(JSON.stringify(baseAgentState))
    },
    blocks,
    settings: {},
    callId: 'call_bad_ask',
    source: 'model'
  });
  const badAskJson = JSON.parse(badAskRaw);
  assert.strictEqual(badAskJson.ok, false, 'ask_user_categories must fail when called before finish_analysis');
  assert(
    badAskJson.error && badAskJson.error.code === 'BAD_TOOL_SEQUENCE',
    'agent.ui.ask_user_categories must return BAD_TOOL_SEQUENCE before successful request_finish_analysis'
  );

  const requestPayloads = [];
  const runLlmRequest = async (payload) => {
    requestPayloads.push(payload);
    const n = requestPayloads.length;
    if (n === 1) {
      return {
        id: 'resp_plan_1',
        output: [
          {
            type: 'function_call',
            call_id: 'call_pre_1',
            name: 'page.get_preanalysis',
            arguments: JSON.stringify({})
          }
        ]
      };
    }
    if (n === 2) {
      return {
        id: 'resp_plan_2',
        output: [
          {
            type: 'function_call',
            call_id: 'call_tax_1',
            name: 'agent.plan.set_taxonomy',
            arguments: JSON.stringify({
              categories: [
                {
                  id: 'main_content',
                  titleRu: 'Основной текст',
                  descriptionRu: 'Основной контент',
                  criteriaRu: 'Абзацы и основной текст',
                  defaultTranslate: true
                },
                {
                  id: 'ui_controls',
                  titleRu: 'Интерфейс',
                  descriptionRu: 'Кнопки и элементы формы',
                  criteriaRu: 'Кнопки, поля, подписи',
                  defaultTranslate: false
                }
              ],
              mapping: {
                blockToCategory: {
                  b1: 'main_content',
                  b2: 'ui_controls'
                },
                rangeToCategory: {
                  r1: 'main_content',
                  r2: 'ui_controls'
                }
              }
            })
          },
          {
            type: 'function_call',
            call_id: 'call_pipe_1',
            name: 'agent.plan.set_pipeline',
            arguments: JSON.stringify({
              modelRouting: {
                main_content: { route: 'auto', model: 'auto', style: 'balanced' },
                ui_controls: { route: 'auto', model: 'auto', style: 'literal' }
              },
              batching: {
                main_content: { unit: 'block', mode: 'mixed', maxUnitsPerBatch: 'auto', keepHistory: 'auto' },
                ui_controls: { unit: 'block', mode: 'parallel', maxUnitsPerBatch: 'auto', keepHistory: 'auto' }
              },
              context: {
                main_content: { buildGlobalContext: 'auto', buildGlossary: 'auto', useCategoryJoinedContext: 'auto' },
                ui_controls: { buildGlobalContext: 'off', buildGlossary: 'off', useCategoryJoinedContext: 'off' }
              },
              qc: {
                main_content: { proofreadingPasses: 'auto', qualityBar: 'high' },
                ui_controls: { proofreadingPasses: 'auto', qualityBar: 'medium' }
              }
            })
          },
          {
            type: 'function_call',
            call_id: 'call_finish_1',
            name: 'agent.plan.request_finish_analysis',
            arguments: JSON.stringify({
              reason: 'taxonomy and pipeline are complete'
            })
          }
        ]
      };
    }
    if (n === 3) {
      return {
        id: 'resp_plan_3',
        output: [
          {
            type: 'function_call',
            call_id: 'call_ask_1',
            name: 'agent.ui.ask_user_categories',
            arguments: JSON.stringify({
              questionRu: 'Какие категории переводить сейчас?',
              categories: [
                { id: 'main_content', titleRu: 'Основной текст', descriptionRu: 'Основной контент', countUnits: 1 },
                { id: 'ui_controls', titleRu: 'Интерфейс', descriptionRu: 'Кнопки и формы', countUnits: 1 }
              ],
              defaults: ['main_content']
            })
          }
        ]
      };
    }
    return {
      id: `resp_plan_${n}`,
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'planning complete' }]
        }
      ],
      output_text: 'planning complete'
    };
  };

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
        plannerMaxSteps: 8,
        plannerMaxToolCalls: 24
      }
    },
    runLlmRequest
  });

  assert(result && result.ok === true, 'Planning loop should complete successfully');
  assert.strictEqual(job.status, 'awaiting_categories', 'Planning must end in awaiting_categories stage');
  assert.strictEqual(requestPayloads.length, 3, 'Planning should finish right after ask_user_categories tool call');

  const secondInput = requestPayloads[1] && requestPayloads[1].request ? requestPayloads[1].request.input : [];
  assert(Array.isArray(secondInput), 'Second request input should be an array');
  assert(
    secondInput.some((item) => item && item.type === 'function_call_output' && item.call_id === 'call_pre_1'),
    'Second request must include output for page.get_preanalysis'
  );
  const thirdInput = requestPayloads[2] && requestPayloads[2].request ? requestPayloads[2].request.input : [];
  ['call_tax_1', 'call_pipe_1', 'call_finish_1'].forEach((callId) => {
    assert(
      thirdInput.some((item) => item && item.type === 'function_call_output' && item.call_id === callId),
      `Third request must include output for ${callId}`
    );
  });

  const markers = job.agentState && job.agentState.planningMarkers && typeof job.agentState.planningMarkers === 'object'
    ? job.agentState.planningMarkers
    : {};
  assert.strictEqual(markers.preanalysisReadByTool, true, 'preanalysis marker must be set');
  assert.strictEqual(markers.taxonomySetByTool, true, 'taxonomy marker must be set');
  assert.strictEqual(markers.pipelineSetByTool, true, 'pipeline marker must be set');
  assert.strictEqual(markers.finishAnalysisRequestedByTool, true, 'finish-analysis marker must be set');
  assert.strictEqual(markers.finishAnalysisOk, true, 'finish-analysis must be successful');
  assert.strictEqual(markers.askUserCategoriesByTool, true, 'ask-user marker must be set');

  assert(
    job.agentState && job.agentState.taxonomy && Array.isArray(job.agentState.taxonomy.categories) && job.agentState.taxonomy.categories.length >= 1,
    'taxonomy must be persisted in agentState'
  );
  assert(
    job.agentState && job.agentState.pipeline && typeof job.agentState.pipeline === 'object',
    'pipeline must be persisted in agentState'
  );
  assert(Array.isArray(job.availableCategories) && job.availableCategories.length >= 1, 'available categories must be published to job');
  assert(Array.isArray(job.selectedCategories) && job.selectedCategories.length === 0, 'selected categories must stay empty before user choice');

  const trace = Array.isArray(job.agentState.toolExecutionTrace) ? job.agentState.toolExecutionTrace : [];
  assert(trace.some((row) => row && row.toolName === 'agent.plan.set_taxonomy'), 'trace must include taxonomy tool call');
  assert(trace.some((row) => row && row.toolName === 'agent.plan.set_pipeline'), 'trace must include pipeline tool call');
  assert(trace.some((row) => row && row.toolName === 'agent.ui.ask_user_categories'), 'trace must include ask-user tool call');

  const gatingJob = {
    id: 'job-exec-gating',
    tabId: 55,
    targetLang: 'ru',
    status: 'awaiting_categories',
    pendingBlockIds: ['b1'],
    blocksById: { b1: { ...blocks[0], translatedText: '' } },
    agentState: {
      ...JSON.parse(JSON.stringify(baseAgentState)),
      phase: 'awaiting_categories',
      pendingToolCalls: {}
    }
  };
  let llmCalls = 0;
  const execResult = await runner.runExecution({
    job: gatingJob,
    blocks,
    settings: {},
    runLlmRequest: async () => {
      llmCalls += 1;
      return { id: 'resp_exec_should_not_happen', output: [] };
    }
  });
  assert(execResult && execResult.ok === true && execResult.stopped === true, 'execution must stop when job.status != running');
  assert.strictEqual(llmCalls, 0, 'execution gating must prevent LLM calls before user category confirmation');

  const sanitized = runner._sanitizePendingInputItems({
    agentState: {
      pendingToolCalls: {
        call_valid_1: { toolName: 'page.get_preanalysis' }
      }
    },
    inputItems: [
      { type: 'function_call_output', call_id: 'call_orphan', output: '{}' },
      { type: 'function_call_output', call_id: 'call_valid_1', output: '{}' },
      { type: 'message', role: 'assistant', content: [{ type: 'input_text', text: 'continue' }] }
    ]
  });
  assert(Array.isArray(sanitized.items), 'sanitize must return items');
  assert(Array.isArray(sanitized.removedCallIds), 'sanitize must return removedCallIds');
  assert(
    sanitized.items.some((item) => item && item.type === 'function_call_output' && item.call_id === 'call_valid_1'),
    'valid function_call_output with known call_id must be preserved'
  );
  assert(
    sanitized.removedCallIds.includes('call_orphan'),
    'unknown/mismatched call_id must be removed from pending input items'
  );

  console.log('PASS: agent runner tool calling');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
