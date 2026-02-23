const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const AGENT_FILE = path.join(ROOT, 'extension/ai/translation-agent.js');

function loadAgentClass() {
  const code = fs.readFileSync(AGENT_FILE, 'utf8');
  const sandbox = { console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: AGENT_FILE });
  const NT = sandbox.NT || {};
  return NT.TranslationAgent || null;
}

function makeBlocks(category, count, startAt) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      blockId: `${category}-${startAt + i}`,
      category,
      pathHint: category,
      originalText: `${category} text ${startAt + i}`
    });
  }
  return out;
}

function makeAutoSettings() {
  return {
    translationCategoryMode: 'auto',
    translationAgentProfile: 'balanced',
    translationAgentTools: {},
    translationAgentTuning: {},
    translationModelList: []
  };
}

async function run() {
  const Agent = loadAgentClass();
  assert(Agent, 'TranslationAgent must be available as globalThis.NT.TranslationAgent');

  const agent = new Agent({});

  // Case A: content dominates.
  const contentBlocks = [
    ...makeBlocks('paragraph', 10, 0),
    ...makeBlocks('heading', 2, 100),
    ...makeBlocks('button', 1, 200)
  ];
  const caseA = await agent.prepareJob({
    job: {},
    blocks: contentBlocks,
    settings: makeAutoSettings()
  });
  assert(Array.isArray(caseA.selectedCategories), 'Case A selectedCategories must be an array');
  assert(
    caseA.selectedCategories.includes('paragraph') || caseA.selectedCategories.includes('heading'),
    'Case A must include content categories (paragraph/heading)'
  );
  assert(!caseA.selectedCategories.includes('button'), 'Case A should not force button when content dominates');

  // Case B: interface dominates.
  const interfaceBlocks = [
    ...makeBlocks('button', 10, 0),
    ...makeBlocks('label', 2, 100),
    ...makeBlocks('paragraph', 1, 200)
  ];
  const caseB = await agent.prepareJob({
    job: {},
    blocks: interfaceBlocks,
    settings: makeAutoSettings()
  });
  assert(Array.isArray(caseB.selectedCategories), 'Case B selectedCategories must be an array');
  assert(
    caseB.selectedCategories.includes('button') || caseB.selectedCategories.includes('label'),
    'Case B must include interface categories (button/label)'
  );

  // Case C: empty or malformed input must be best-effort.
  const caseC1 = await agent.prepareJob({
    job: {},
    settings: makeAutoSettings()
  });
  assert(Array.isArray(caseC1.selectedCategories), 'Case C1 selectedCategories must be an array');

  const caseC2 = await agent.prepareJob({
    job: {},
    blocks: [],
    settings: makeAutoSettings()
  });
  assert(Array.isArray(caseC2.selectedCategories), 'Case C2 selectedCategories must be an array');

  console.log('selftest-agent-categories-auto: OK');
}

run().catch((error) => {
  const message = error && error.stack ? error.stack : String(error);
  console.error(`selftest-agent-categories-auto: FAILED\n${message}`);
  process.exitCode = 1;
});
