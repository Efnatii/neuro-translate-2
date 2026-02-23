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
  load('extension/ai/translation-call.js');

  const TranslationCall = global.NT.TranslationCall;
  assert(TranslationCall, 'TranslationCall must be defined');

  const captured = [];
  const call = new TranslationCall({
    runLlmRequest: async (payload) => {
      captured.push(payload);
      return {
        output_text: JSON.stringify({
          items: [{ blockId: 'b1', text: 'T:World' }],
          report: { summary: 'ok', quality: 'ok' }
        }),
        __nt: {
          chosenModelSpec: 'gpt-test',
          policy: 'speed',
          reason: 'unit',
          attempt: 1,
          taskType: 'translation_batch',
          requestId: 'req-1',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          rate: { remainingRequests: 99, remainingTokens: 12345, limitRequests: 100, limitTokens: 20000 }
        }
      };
    }
  });

  const translated = await call.translateBatch([
    { blockId: 'b0', originalText: 'Hello', category: 'paragraph', pathHint: 'p' },
    { blockId: 'b1', originalText: 'World', category: 'paragraph', pathHint: 'p' }
  ], {
    tabId: 1,
    jobId: 'job-1',
    batchId: 'batch-1',
    targetLang: 'ru',
    agentContext: {
      systemPrompt: 'You are Neuro Translate Agent.',
      profile: 'balanced',
      style: 'balanced',
      batchGuidance: 'Keep important terms stable.',
      selectedCategories: ['paragraph'],
      glossary: [{ term: 'World', hint: 'Мир' }],
      contextSummary: 'Simple test context',
      reportDigest: 'No previous reports'
    }
  });

  assert.strictEqual(captured.length, 1, 'Expected one LLM request');
  const firstInput = captured[0] && captured[0].request ? captured[0].request.input : null;
  assert(Array.isArray(firstInput), 'Request input must be structured array');
  assert.strictEqual(firstInput.length, 2, 'Structured input must include system and user messages');
  assert.strictEqual(firstInput[0].role, 'system', 'First message must be system');
  assert.strictEqual(firstInput[1].role, 'user', 'Second message must be user');
  assert(firstInput[0].content[0].text.includes('Neuro Translate Agent'), 'System message must include system prompt');
  assert(firstInput[1].content[0].text.includes('Translate every item to ru.'), 'User message must include translation instruction');
  assert(!firstInput[1].content[0].text.includes('You are Neuro Translate Agent.'), 'System prompt must not be duplicated in user message');
  assert.strictEqual(captured[0].request.agentRoute, 'fast', 'Balanced batch should default to fast route when router is enabled');

  assert.strictEqual(translated.items.length, 2, 'Output item count must match input block count');
  assert.strictEqual(translated.items[0].text, 'Hello', 'Missing model item should fallback to original text');
  assert.strictEqual(translated.items[1].text, 'T:World', 'Model translation should be applied');
  assert(translated.report && translated.report.summary === 'ok', 'Report should be preserved');
  assert.strictEqual(translated.report.quality, 'ok', 'Report quality should be normalized');
  assert(Array.isArray(translated.report.notes), 'Report notes should be normalized to array');
  assert(translated.report.meta && typeof translated.report.meta === 'object', 'Report meta should be populated');
  assert.strictEqual(translated.report.meta.chosenModelSpec, 'gpt-test', 'Report meta should expose chosen model');
  assert.strictEqual(translated.report.meta.usage.totalTokens, 15, 'Report meta should expose usage');
  assert.strictEqual(translated.report.meta.rate.remainingTokens, 12345, 'Report meta should expose rate snapshot');
  assert.notStrictEqual(translated.report.meta.cached, true, 'Fresh response must not be flagged as cached');

  const translatedCached = await call.translateBatch([
    { blockId: 'b0', originalText: 'Hello', category: 'paragraph', pathHint: 'p' },
    { blockId: 'b1', originalText: 'World', category: 'paragraph', pathHint: 'p' }
  ], {
    tabId: 1,
    jobId: 'job-1',
    batchId: 'batch-1',
    targetLang: 'ru',
    agentContext: {
      systemPrompt: 'You are Neuro Translate Agent.',
      profile: 'balanced',
      style: 'balanced',
      batchGuidance: 'Keep important terms stable.',
      selectedCategories: ['paragraph'],
      glossary: [{ term: 'World', hint: 'Мир' }],
      contextSummary: 'Simple test context',
      reportDigest: 'No previous reports'
    }
  });
  assert.strictEqual(captured.length, 1, 'Second identical call should be served from translation-call cache');
  assert.strictEqual(translatedCached.items[1].text, 'T:World', 'Cached result should preserve translated text');
  assert(translatedCached.report && translatedCached.report.meta && translatedCached.report.meta.cached === true, 'Cached response should be flagged in report meta');

  await call.translateBatch([
    { blockId: 'b0', originalText: 'Hello', category: 'paragraph', pathHint: 'p' },
    { blockId: 'b1', originalText: 'World', category: 'paragraph', pathHint: 'p' }
  ], {
    tabId: 1,
    jobId: 'job-1',
    batchId: 'batch-1',
    targetLang: 'ru',
    cacheEnabled: false,
    agentContext: {
      systemPrompt: 'You are Neuro Translate Agent.',
      profile: 'balanced',
      style: 'balanced',
      batchGuidance: 'Keep important terms stable.',
      selectedCategories: ['paragraph'],
      glossary: [{ term: 'World', hint: 'Мир' }],
      contextSummary: 'Simple test context',
      reportDigest: 'No previous reports'
    }
  });
  assert.strictEqual(captured.length, 2, 'cacheEnabled=false should bypass translation-call cache');

  const capturedWithoutSystem = [];
  const callWithoutSystem = new TranslationCall({
    runLlmRequest: async (payload) => {
      capturedWithoutSystem.push(payload);
      return {
        output_text: JSON.stringify({
          items: [{ blockId: 'x0', text: 'T:Text' }]
        })
      };
    }
  });

  await callWithoutSystem.translateBatch([
    { blockId: 'x0', originalText: 'Text', category: 'paragraph', pathHint: 'p' }
  ], {
    tabId: 2,
    jobId: 'job-2',
    batchId: 'batch-2',
    targetLang: 'de',
    agentContext: {}
  });

  const secondInput = capturedWithoutSystem[0] && capturedWithoutSystem[0].request
    ? capturedWithoutSystem[0].request.input
    : null;
  assert(Array.isArray(secondInput), 'Request input without system prompt must still be structured');
  assert.strictEqual(secondInput.length, 1, 'Without system prompt only user message is required');
  assert.strictEqual(secondInput[0].role, 'user', 'Only user role expected without system prompt');
  assert(secondInput[0].content[0].text.includes('Translate every item to de.'), 'Target language instruction should be present');
  assert.strictEqual(capturedWithoutSystem[0].request.agentRoute, 'fast', 'Fallback route should be fast for simple context');
  assert.strictEqual(typeof callWithoutSystem.responseCache.size, 'number', 'Translation call should own response cache');

  const capturedNoRouter = [];
  const callNoRouter = new TranslationCall({
    runLlmRequest: async (payload) => {
      capturedNoRouter.push(payload);
      return {
        output_text: JSON.stringify({
          items: [{ blockId: 'z0', text: 'T:Alpha' }]
        })
      };
    }
  });

  await callNoRouter.translateBatch([
    { blockId: 'z0', originalText: 'Alpha', category: 'paragraph', pathHint: 'p' }
  ], {
    tabId: 3,
    jobId: 'job-3',
    batchId: 'batch-3',
    targetLang: 'fr',
    agentContext: {
      modelRouterEnabled: false,
      routeHint: 'strong'
    }
  });
  assert.strictEqual(capturedNoRouter[0].request.agentRoute, null, 'Disabled model router must not force route');
  const noRouterResult = await callNoRouter.translateBatch([
    { blockId: 'z0', originalText: 'Alpha', category: 'paragraph', pathHint: 'p' }
  ], {
    tabId: 3,
    jobId: 'job-3',
    batchId: 'batch-3',
    targetLang: 'fr',
    agentContext: {
      modelRouterEnabled: false,
      routeHint: 'strong'
    }
  });
  assert(noRouterResult.report && typeof noRouterResult.report.summary === 'string', 'Report must be normalized even when model did not return report');

  console.log('PASS: translation call');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
