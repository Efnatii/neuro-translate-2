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

function run() {
  global.NT = {};
  load('extension/core/agent-settings-policy.js');

  const Policy = global.NT.AgentSettingsPolicy;
  assert(Policy, 'AgentSettingsPolicy must be defined');

  const userSettings = {
    profile: 'fast',
    reasoning: {
      reasoningMode: 'custom',
      reasoningEffort: 'high',
      reasoningSummary: 'short'
    }
  };
  const result = Policy.getEffectiveSettings(userSettings, {
    modelList: ['gpt-4.1-mini:standard', 'gpt-5-mini:standard']
  });
  assert(result && result.effective, 'Effective settings must be returned');
  assert.strictEqual(result.effective.profile, 'fast', 'Base profile must remain fast');
  assert.strictEqual(result.effective.effectiveProfile, 'custom', 'Manual override should switch effective profile to custom');
  assert.strictEqual(result.effective.reasoning.reasoningEffort, 'high', 'Reasoning effort override must be applied');
  assert(
    result.overrides
    && Array.isArray(result.overrides.changed)
    && result.overrides.changed.includes('reasoning.reasoningEffort'),
    'Overrides should include reasoning effort override key'
  );

  console.log('PASS: effective settings + overrides');
}

try {
  run();
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
}
