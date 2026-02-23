const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const AGENT_FILE = path.join(ROOT, 'extension/ai/translation-agent.js');

function loadAgentIntoIsolatedContext() {
  const code = fs.readFileSync(AGENT_FILE, 'utf8');
  const sandbox = {
    console
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: AGENT_FILE });
  return sandbox;
}

function assertPreviewShape(preview) {
  assert(preview && typeof preview === 'object', 'previewResolvedSettings must return an object');
  assert(preview.baseProfile && typeof preview.baseProfile === 'object', 'preview.baseProfile must be an object');
  assert(preview.effectiveProfile && typeof preview.effectiveProfile === 'object', 'preview.effectiveProfile must be an object');
  assert(preview.runtimeTuning && typeof preview.runtimeTuning === 'object', 'preview.runtimeTuning must be an object');
  assert(preview.resolved && typeof preview.resolved === 'object', 'preview.resolved must be an object');
  assert(Object.prototype.hasOwnProperty.call(preview, 'pageStats'), 'preview.pageStats field is required');
  assert(Object.prototype.hasOwnProperty.call(preview, 'categoryStats'), 'preview.categoryStats field is required');

  const resolved = preview.resolved;
  const requiredResolvedKeys = [
    'profile',
    'tuning',
    'modelPolicy',
    'toolConfigRequested',
    'toolConfigEffective',
    'toolAutoDecisions',
    'categoryMode',
    'categoryList',
    'pageCacheEnabled'
  ];
  requiredResolvedKeys.forEach((key) => {
    assert(Object.prototype.hasOwnProperty.call(resolved, key), `preview.resolved.${key} field is required`);
  });
}

function run() {
  const sandbox = loadAgentIntoIsolatedContext();
  const NT = sandbox.NT || {};
  const Agent = NT.TranslationAgent;

  assert(Agent, 'TranslationAgent must be exported on globalThis.NT');
  assert(typeof Agent.previewResolvedSettings === 'function', 'TranslationAgent.previewResolvedSettings must be a function');

  const tunedPreview = Agent.previewResolvedSettings({
    settings: {
      translationAgentProfile: 'balanced',
      translationAgentTuning: {
        maxBatchSizeOverride: 17,
        auditIntervalMs: 3210,
        mandatoryAuditIntervalMs: 1900,
        compressionThreshold: 42,
        contextFootprintLimit: 7777,
        compressionCooldownMs: 555
      }
    },
    blocks: [
      { blockId: 'a1', category: 'paragraph', originalText: 'hello world' },
      { blockId: 'a2', category: 'heading', originalText: 'Title' }
    ]
  });

  assertPreviewShape(tunedPreview);
  assert.strictEqual(
    tunedPreview.effectiveProfile.maxBatchSize,
    17,
    'maxBatchSizeOverride must change preview.effectiveProfile.maxBatchSize'
  );
  assert.strictEqual(
    tunedPreview.runtimeTuning.auditIntervalMs,
    3210,
    'runtimeTuning.auditIntervalMs must match passed tuning'
  );
  assert.strictEqual(
    tunedPreview.runtimeTuning.mandatoryAuditIntervalMs,
    1900,
    'runtimeTuning.mandatoryAuditIntervalMs must match passed tuning'
  );
  assert.strictEqual(
    tunedPreview.runtimeTuning.compressionThreshold,
    42,
    'runtimeTuning.compressionThreshold must match passed tuning'
  );
  assert.strictEqual(
    tunedPreview.runtimeTuning.contextFootprintLimit,
    7777,
    'runtimeTuning.contextFootprintLimit must match passed tuning'
  );
  assert.strictEqual(
    tunedPreview.runtimeTuning.compressionCooldownMs,
    555,
    'runtimeTuning.compressionCooldownMs must match passed tuning'
  );

  const emptyPreview = Agent.previewResolvedSettings();
  assertPreviewShape(emptyPreview);
}

try {
  run();
  console.log('selftest-agent-preview: OK');
} catch (error) {
  const message = error && error.stack ? error.stack : String(error);
  console.error('selftest-agent-preview: FAILED\n' + message);
  process.exitCode = 1;
}
