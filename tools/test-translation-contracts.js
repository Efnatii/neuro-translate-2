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

global.NT = {};
load('extension/core/ui-protocol.js');
load('extension/core/translation-protocol.js');

const UiProtocol = global.NT.UiProtocol;
const TranslationProtocol = global.NT.TranslationProtocol;

assert(UiProtocol, 'UiProtocol must be defined');
assert(TranslationProtocol, 'TranslationProtocol must be defined');
assert(UiProtocol.Commands, 'UiProtocol.Commands must be defined');
assert.strictEqual(typeof TranslationProtocol.wrap, 'function', 'TranslationProtocol.wrap must be a function');
assert.strictEqual(typeof TranslationProtocol.unwrap, 'function', 'TranslationProtocol.unwrap must be a function');

[
  'START_TRANSLATION',
  'CANCEL_TRANSLATION',
  'CLEAR_TRANSLATION_DATA',
  'SET_TRANSLATION_CATEGORIES',
  'RECLASSIFY_BLOCKS',
  'SET_TRANSLATION_VISIBILITY',
  'RETRY_FAILED_BLOCKS',
  'BENCHMARK_SELECTED_MODELS',
  'CLEAR_EVENT_LOG',
  'EVENT_LOG_PAGE',
  'BG_TEST_SET_CREDENTIALS_BYOK',
  'BG_TEST_SET_TARGET_LANG',
  'BG_TEST_GET_ACTIVE_JOB',
  'BG_TEST_GET_JOB_STATE',
  'BG_TEST_ERASE_JOB',
  'BG_TEST_WAIT_FOR_STAGE',
  'BG_TEST_GET_ACTIVE_JOB_STATE',
  'BG_TEST_EXPORT_REPORT_JSON',
  'BG_TEST_FORCE_SW_IDLE_SIM',
  'BG_TEST_KICK_SCHEDULER',
  'BG_REPAIR_ALL',
  'BG_EXPORT_MIGRATION_STATUS'
].forEach((key) => {
  assert.strictEqual(typeof UiProtocol.Commands[key], 'string', `Missing command: ${key}`);
});

assert.strictEqual(
  TranslationProtocol.isContentToBackground(TranslationProtocol.CS_READY),
  true,
  'CS_READY must be classified as content->background'
);
assert.strictEqual(
  TranslationProtocol.isContentToBackground(TranslationProtocol.BG_START_JOB),
  false,
  'BG_START_JOB must not be classified as content->background'
);
assert.strictEqual(
  TranslationProtocol.isBackgroundToContent(TranslationProtocol.BG_APPLY_BATCH),
  true,
  'BG_APPLY_BATCH must be classified as background->content'
);
assert.strictEqual(
  TranslationProtocol.isBackgroundToContent(TranslationProtocol.BG_CLASSIFY_BLOCKS),
  true,
  'BG_CLASSIFY_BLOCKS must be classified as background->content'
);

console.log('PASS: translation contracts');
