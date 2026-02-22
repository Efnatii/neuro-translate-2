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

function normalizeSelection(selection) {
  return {
    speed: selection ? selection.speed !== false : true,
    preference: selection && (selection.preference === 'smartest' || selection.preference === 'cheapest')
      ? selection.preference
      : null
  };
}

async function run() {
  global.NT = {};
  load('extension/bg/background-app.js');

  const BackgroundApp = global.NT.BackgroundApp;
  assert(BackgroundApp, 'BackgroundApp must be defined');

  const app = new BackgroundApp({
    chromeApi: {},
    fetchFn: () => Promise.resolve(null)
  });
  const registry = {
    entries: [
      { id: 'gpt-5-mini', tier: 'standard' },
      { id: 'gpt-4o-mini', tier: 'standard' },
      { id: 'o4-mini', tier: 'standard' }
    ],
    byKey: {
      'gpt-5-mini:standard': { id: 'gpt-5-mini', tier: 'standard' },
      'gpt-4o-mini:standard': { id: 'gpt-4o-mini', tier: 'standard' },
      'o4-mini:standard': { id: 'o4-mini', tier: 'standard' }
    }
  };
  app.ai = {
    normalizeSelection,
    getRegistry: () => registry
  };

  const base = app._resolveEffectiveModelSelection({
    taskType: 'benchmark',
    request: {},
    modelSelection: { speed: true, preference: 'cheapest' },
    translationAgentProfile: 'technical'
  });
  assert.strictEqual(base.speed, true, 'Non-translation task should keep base speed');
  assert.strictEqual(base.preference, 'cheapest', 'Non-translation task should keep base preference');

  const profileRoute = app._resolveEffectiveModelSelection({
    taskType: 'translation_batch',
    request: {},
    modelSelection: { speed: true, preference: null },
    translationAgentProfile: 'technical'
  });
  assert.strictEqual(profileRoute.speed, false, 'Technical profile should bias to strongest model');
  assert.strictEqual(profileRoute.preference, 'smartest', 'Technical profile should prefer smartest');

  const fastRoute = app._resolveEffectiveModelSelection({
    taskType: 'translation_batch',
    request: { agentRoute: 'fast' },
    modelSelection: { speed: false, preference: 'smartest' },
    translationAgentProfile: 'technical'
  });
  assert.strictEqual(fastRoute.speed, true, 'Fast route should force speed');
  assert.strictEqual(fastRoute.preference, null, 'Fast route should remove smartest bias');

  const strongRoute = app._resolveEffectiveModelSelection({
    taskType: 'translation_batch',
    request: { agentRoute: 'strong' },
    modelSelection: { speed: true, preference: null },
    translationAgentProfile: 'readable'
  });
  assert.strictEqual(strongRoute.speed, false, 'Strong route should force smartest policy');
  assert.strictEqual(strongRoute.preference, 'smartest', 'Strong route should set smartest preference');

  const fixedPolicyNoProfileBias = app._resolveEffectiveModelSelection({
    taskType: 'translation_batch',
    request: {},
    modelSelection: { speed: false, preference: 'cheapest' },
    translationAgentModelPolicy: {
      mode: 'fixed',
      speed: false,
      preference: 'cheapest',
      allowRouteOverride: true
    },
    translationAgentProfile: 'technical'
  });
  assert.strictEqual(fixedPolicyNoProfileBias.speed, false, 'Fixed mode should keep configured speed policy');
  assert.strictEqual(fixedPolicyNoProfileBias.preference, 'cheapest', 'Fixed mode should keep configured preference');

  const fixedPolicyNoRouteOverride = app._resolveEffectiveModelSelection({
    taskType: 'translation_batch',
    request: { agentRoute: 'strong' },
    modelSelection: { speed: true, preference: null },
    translationAgentModelPolicy: {
      mode: 'fixed',
      speed: true,
      preference: null,
      allowRouteOverride: false
    },
    translationAgentProfile: 'technical'
  });
  assert.strictEqual(fixedPolicyNoRouteOverride.speed, true, 'Disabled route override should ignore strong route');
  assert.strictEqual(fixedPolicyNoRouteOverride.preference, null, 'Disabled route override should keep fixed preference');

  const sanitized = app._sanitizeModelList([
    'gpt-5-mini:standard',
    'gpt-5-mini:standard',
    'invalid:model',
    'o4-mini:standard'
  ]);
  assert.deepStrictEqual(sanitized, ['gpt-5-mini:standard', 'o4-mini:standard'], 'Model list should keep only unique registry-backed model specs');

  const defaults = app._buildDefaultModelList();
  assert(Array.isArray(defaults) && defaults.length >= 1, 'Default model list should be derived from registry');
  assert(defaults.every((spec) => Object.prototype.hasOwnProperty.call(registry.byKey, spec)), 'Default model list should contain only registry-backed specs');

  const setCalls = [];
  app.settingsStore = {
    get: async () => ({
      translationModelList: ['invalid:model'],
      modelSelection: null,
      modelSelectionPolicy: null,
      translationAgentModelPolicy: null,
      translationAgentProfile: 'auto',
      translationApiCacheEnabled: false
    }),
    set: async (payload) => {
      setCalls.push(payload);
    }
  };
  const llmSettings = await app._readLlmSettings();
  assert(Array.isArray(llmSettings.translationModelList) && llmSettings.translationModelList.length >= 1, 'Read settings should recover model list from defaults');
  assert.strictEqual(llmSettings.translationApiCacheEnabled, false, 'API cache setting should be preserved');
  assert(llmSettings.translationAgentModelPolicy && typeof llmSettings.translationAgentModelPolicy === 'object', 'Read settings should provide normalized agent model policy');
  assert(setCalls.some((payload) => Array.isArray(payload.translationModelList)), 'Read settings should self-heal invalid model list in storage');

  console.log('PASS: background selection routing');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
