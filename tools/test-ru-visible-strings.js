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
  delete global.NT;
  load('extension/core/nt-namespace.js');
  load('extension/ai/translation-agent.js');

  const Agent = global.NT && global.NT.TranslationAgent;
  assert(Agent, 'TranslationAgent must be defined');

  const agent = new Agent({ runLlmRequest: null });
  const prepared = await agent.prepareJob({
    job: { targetLang: 'ru' },
    blocks: [
      { blockId: 'b1', originalText: 'Hello', category: 'paragraph' }
    ],
    settings: {
      translationAgentProfile: 'balanced',
      translationAgentTools: { batchPlanner: 'off' },
      translationCategoryMode: 'all',
      translationCategoryList: []
    }
  });

  assert(prepared && prepared.agentState, 'prepareJob must return agentState');
  const jobObj = {
    totalBlocks: 1,
    completedBlocks: 1,
    pendingBlockIds: [],
    failedBlockIds: [],
    agentState: prepared.agentState
  };
  agent.finalizeJob(jobObj);

  const reports = Array.isArray(jobObj.agentState.reports) ? jobObj.agentState.reports : [];
  assert(reports.length > 0, 'agent reports must not be empty');
  const lastReport = reports[reports.length - 1] || {};
  assert(/Перевод/.test(String(lastReport.title || '')), 'final report title should be in Russian');
  assert(/Успешно|Завершено/.test(String(lastReport.body || '')), 'final report summary should be in Russian');

  const checklist = Array.isArray(jobObj.agentState.checklist) ? jobObj.agentState.checklist : [];
  const titles = checklist.map((item) => String((item && item.title) || '')).join(' | ');
  assert(!/Analyze page|Plan execution pipeline|Translation finished|Translation failed/i.test(titles), 'checklist titles should not contain old English phrases');
  assert(/Анализ текста страницы/.test(titles), 'checklist should contain Russian analyze title');
}

run()
  .then(() => {
    console.log('ok');
  })
  .catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  });

