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
  load('extension/ai/llm-engine.js');

  const LlmEngine = global.NT.LlmEngine;
  assert(LlmEngine, 'LlmEngine must be defined');

  const capturedMeta = [];
  const engine = new LlmEngine({
    responseCall: {
      send: async ({ meta }) => {
        capturedMeta.push(meta || {});
        return {
          status: 200,
          headers: { get() { return null; } },
          json: { output_text: '{"ok":true}' }
        };
      }
    },
    modelRegistry: {
      byKey: {
        'gpt-5-mini:standard': {
          id: 'gpt-5-mini',
          tier: 'standard',
          capabilityRank: 100,
          sum_1M: 2.25,
          cachedInputPrice: 0.025
        },
        'gpt-5-pro:standard': {
          id: 'gpt-5-pro',
          tier: 'standard',
          capabilityRank: 120,
          sum_1M: 135,
          cachedInputPrice: null
        }
      }
    },
    benchmarkStore: {
      getAll: async () => ({})
    },
    benchmarker: null,
    rateLimitStore: null,
    perfStore: null,
    loadScheduler: {
      reserveSlot: async () => {}
    },
    eventLogger: null,
    eventFactory: null
  });

  await engine.request({
    tabId: 10,
    taskType: 'translation_batch',
    selectedModelSpecs: ['gpt-5-mini:standard'],
    modelSelection: { speed: true, preference: null },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    maxOutputTokens: 64,
    temperature: 0,
    requestMeta: {
      jobId: 'job-translation-1',
      blockId: 'b1',
      attempt: 1,
      requestId: 'req-1'
    }
  });
  await engine.request({
    tabId: 10,
    taskType: 'translation_batch',
    selectedModelSpecs: ['gpt-5-mini:standard'],
    modelSelection: { speed: true, preference: null },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'world' }] }],
    maxOutputTokens: 64,
    temperature: 0,
    requestMeta: {
      jobId: 'job-translation-1',
      blockId: 'b2',
      attempt: 1,
      requestId: 'req-2'
    }
  });

  assert.strictEqual(capturedMeta.length >= 2, true, 'Expected at least two captured requests');
  assert.strictEqual(typeof capturedMeta[0].promptCacheKey, 'string', 'Prompt cache key should be generated for translation requests');
  assert.strictEqual(capturedMeta[0].promptCacheKey.length > 0, true, 'Prompt cache key should be non-empty');
  assert.strictEqual(capturedMeta[0].promptCacheKey, capturedMeta[1].promptCacheKey, 'Prompt cache key should stay stable within the same translation job');

  await engine.request({
    tabId: 10,
    taskType: 'benchmark',
    selectedModelSpecs: ['gpt-5-mini:standard'],
    modelSelection: { speed: true, preference: null },
    input: 'ping',
    maxOutputTokens: 4,
    temperature: 0,
    requestMeta: {
      jobId: 'job-bench-1',
      blockId: 'bench',
      attempt: 1,
      requestId: 'req-3'
    }
  });
  assert.strictEqual(Boolean(capturedMeta[2].promptCacheKey), false, 'Non-translation requests should not set prompt cache key');

  await engine.request({
    tabId: 10,
    taskType: 'translation_batch',
    selectedModelSpecs: ['gpt-5-pro:standard'],
    modelSelection: { speed: true, preference: null },
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'unsupported cache' }] }],
    maxOutputTokens: 64,
    temperature: 0,
    requestMeta: {
      jobId: 'job-translation-unsupported',
      blockId: 'b1',
      attempt: 1,
      requestId: 'req-4'
    }
  });
  assert.strictEqual(Boolean(capturedMeta[3].promptCacheKey), false, 'Models without prompt cache support should not set prompt cache key');

  console.log('PASS: llm engine prompt cache');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

