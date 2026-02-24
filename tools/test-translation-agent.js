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

function checklistStatus(checklist, id) {
  const list = Array.isArray(checklist) ? checklist : [];
  const row = list.find((item) => item && item.id === id);
  return row && typeof row.status === 'string' ? row.status : null;
}

async function run() {
  global.NT = {};
  load('extension/ai/translation-agent.js');

  const Agent = global.NT.TranslationAgent;
  assert(Agent, 'TranslationAgent must be defined');

  const persisted = [];
  const agent = new Agent({
    persistJobState: async (job, meta) => {
      persisted.push({
        jobId: job && job.id ? job.id : null,
        reason: meta && meta.reason ? meta.reason : null
      });
    }
  });

  const blocks = [
    { blockId: 'b0', originalText: 'Welcome to Dashboard', category: 'headings', preCategory: 'heading', pathHint: 'h1', domOrder: 1 },
    { blockId: 'b1', originalText: 'Click Save button to apply settings', category: 'main_content', preCategory: 'paragraph', pathHint: 'p', domOrder: 2 },
    { blockId: 'b2', originalText: 'Save', category: 'ui_controls', preCategory: 'button', pathHint: 'button', domOrder: 3 }
  ];
  const pageAnalysis = {
    domHash: 'dom:abc',
    preanalysisVersion: 'dom-preanalysis/1.0.0',
    stats: {
      blockCount: 3,
      totalChars: blocks.reduce((sum, row) => sum + String(row.originalText || '').length, 0),
      byPreCategory: { heading: 1, paragraph: 1, button: 1 },
      rangeCount: 2
    }
  };
  const job = {
    id: 'job-prepare-1',
    tabId: 10,
    targetLang: 'ru',
    status: 'planning',
    pageAnalysis
  };

  const prepared = await agent.prepareJob({
    job,
    blocks,
    settings: {
      translationAgentProfile: 'balanced',
      translationCategoryMode: 'all',
      translationAgentTools: {
        batchPlanner: 'off'
      }
    }
  });

  assert(Array.isArray(prepared.blocksAll), 'prepareJob should return blocksAll');
  assert.strictEqual(prepared.blocksAll.length, blocks.length, 'blocksAll should include all scanned blocks');
  assert(Array.isArray(prepared.blocks), 'prepareJob should keep compatibility blocks array');
  assert.strictEqual(prepared.blocks.length, blocks.length, 'prepareJob should not filter blocks');
  assert(prepared.agentState && typeof prepared.agentState === 'object', 'Agent state must be produced');
  assert.strictEqual(prepared.agentState.profile, 'balanced', 'Profile should remain resolved');
  assert.strictEqual(Array.isArray(prepared.agentState.selectedCategories), true, 'selectedCategories should exist');
  assert.strictEqual(prepared.agentState.selectedCategories.length, 0, 'prepareJob must not preselect categories');
  assert.strictEqual(Array.isArray(prepared.agentState.glossary), true, 'glossary should exist');
  assert.strictEqual(prepared.agentState.glossary.length, 0, 'prepareJob must not build glossary');
  assert.strictEqual(prepared.agentState.plan, null, 'prepareJob must not build execution plan');
  assert.strictEqual(Boolean(prepared.agentState.systemPrompt), false, 'prepareJob must not build execution system prompt');
  assert(prepared.agentState.pageStats && prepared.agentState.pageStats.blockCount === blocks.length, 'pageStats should be present');
  assert(prepared.agentState.preStats && prepared.agentState.preStats.blockCount === pageAnalysis.stats.blockCount, 'preStats should come from pageAnalysis');
  assert.strictEqual(checklistStatus(prepared.agentState.checklist, 'scanned'), 'done', 'scanned checklist item should be done');
  assert.strictEqual(checklistStatus(prepared.agentState.checklist, 'analyze_page'), 'done', 'analyze_page checklist item should be done');
  assert.notStrictEqual(checklistStatus(prepared.agentState.checklist, 'select_categories'), 'done', 'select_categories must not be done during prepare');
  assert.notStrictEqual(checklistStatus(prepared.agentState.checklist, 'categories_selected'), 'done', 'categories_selected must not be done during prepare');
  assert.notStrictEqual(checklistStatus(prepared.agentState.checklist, 'plan_pipeline'), 'done', 'plan_pipeline must not be done during prepare');
  assert(
    persisted.some((row) => row && row.jobId === 'job-prepare-1' && row.reason === 'planning_init'),
    'prepareJob should persist planning_init state'
  );

  const llmUnavailableAgent = new Agent({});
  let unavailableError = null;
  try {
    await llmUnavailableAgent.runPlanning({
      job: { id: 'job-no-llm', tabId: 15, targetLang: 'ru' },
      blocks,
      settings: {}
    });
  } catch (error) {
    unavailableError = error;
  }
  assert(unavailableError && unavailableError.code === 'PLANNING_LLM_UNAVAILABLE', 'runPlanning must fail without runLlmRequest');

  const preview = Agent.previewResolvedSettings({
    settings: {
      translationAgentProfile: 'balanced',
      translationAgentTuning: {
        maxBatchSizeOverride: 104,
        compressionThreshold: 33
      }
    },
    blocks
  });
  assert(preview && preview.pageStats && preview.pageStats.blockCount === blocks.length, 'preview helper should remain available');
  assert(preview.resolved && typeof preview.resolved === 'object', 'preview helper should expose resolved settings');

  console.log('PASS: translation agent');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
