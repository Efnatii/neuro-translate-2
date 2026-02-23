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

function createChromeApi(initialState) {
  const state = { ...(initialState || {}) };
  return {
    storage: {
      local: {
        get(defaults, cb) {
          if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
            cb({ ...defaults, ...state });
            return;
          }
          cb({ ...state });
        },
        set(payload, cb) {
          Object.assign(state, payload || {});
          if (typeof cb === 'function') {
            cb();
          }
        }
      }
    },
    _dump() {
      return { ...state };
    }
  };
}

async function run() {
  global.NT = {};
  load('extension/core/chrome-local-store-base.js');
  load('extension/core/agent-settings-policy.js');
  load('extension/core/settings-store.js');

  const chromeApi = createChromeApi({
    translationAgentProfile: 'technical',
    translationAgentExecutionMode: 'agent',
    translationAgentAllowedModels: ['gpt-4.1-mini:standard'],
    translationApiCacheEnabled: true,
    translationModelList: ['gpt-4.1-mini:standard', 'gpt-5-mini:standard']
  });
  const store = new global.NT.SettingsStore({ chromeApi });

  const migrationResult = await store.ensureMigrated();
  assert(migrationResult && migrationResult.schemaVersion === 2, 'Schema version should migrate to 2');

  const resolved = await store.getResolvedSettings();
  assert(resolved && resolved.schemaVersion === 2, 'Resolved settings should report schema v2');
  assert(resolved.userSettings && resolved.userSettings.profile === 'research', 'Legacy technical profile should migrate to research');
  assert(
    resolved.userSettings.models
    && Array.isArray(resolved.userSettings.models.agentAllowedModels)
    && resolved.userSettings.models.agentAllowedModels.includes('gpt-4.1-mini:standard'),
    'Legacy allowed model list should migrate into v2 user settings'
  );

  const dumped = chromeApi._dump();
  assert(
    dumped.translationAgentSettingsV2 && typeof dumped.translationAgentSettingsV2 === 'object',
    'Migration must persist translationAgentSettingsV2'
  );
  assert.strictEqual(dumped.settingsSchemaVersion, 2, 'Migration must persist schema version 2');

  console.log('PASS: settings migration v2');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
