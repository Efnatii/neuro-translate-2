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

function createChromeApi() {
  return {
    storage: {
      local: {
        get(defaults, cb) {
          cb({ ...(defaults || {}), apiKey: 'sk-test' });
        },
        set(_payload, cb) {
          if (typeof cb === 'function') {
            cb();
          }
        }
      }
    }
  };
}

async function run() {
  global.NT = {};
  load('extension/core/chrome-local-store-base.js');
  load('extension/ai/llm-client.js');

  const LlmClient = global.NT.LlmClient;
  assert(LlmClient, 'LlmClient must be defined');

  {
    const executeCalls = [];
    const abortCalls = [];
    const resolvers = {};
    const client = new LlmClient({
      chromeApi: createChromeApi(),
      offscreenExecutor: {
        async execute({ requestId }) {
          executeCalls.push(requestId);
          return new Promise((resolve) => {
            resolvers[requestId] = resolve;
          });
        },
        async abort({ requestId, reason }) {
          abortCalls.push({ requestId, reason });
          if (resolvers[requestId]) {
            resolvers[requestId]({
              ok: false,
              status: 0,
              headers: {},
              json: null,
              text: null,
              error: { code: 'ABORTED', message: String(reason || 'aborted') }
            });
            delete resolvers[requestId];
          }
          return { ok: true, aborted: true };
        }
      }
    });

    const controller = new AbortController();
    const promise = client.generateResponseRaw({
      modelId: 'gpt-4.1-mini',
      input: 'hello',
      maxOutputTokens: 64,
      signal: controller.signal,
      meta: { requestId: 'rid-abort-1', timeoutMs: 10000 }
    });
    setTimeout(() => controller.abort('USER_CANCELLED'), 15);

    let caught = null;
    try {
      await promise;
    } catch (error) {
      caught = error;
    }
    assert(caught, 'Abort should reject');
    assert.strictEqual(caught.name, 'AbortError', 'Abort path must reject with AbortError');
    assert.strictEqual(caught.code, 'ABORT_ERR', 'Abort path must expose ABORT_ERR code');
    assert.strictEqual(executeCalls.length, 1, 'Offscreen execute must start exactly once');
    assert.strictEqual(abortCalls.length, 1, 'Offscreen abort must be invoked once');
    assert.strictEqual(abortCalls[0].requestId, 'rid-abort-1', 'Abort must target current requestId');
    assert.strictEqual(abortCalls[0].reason, 'USER_CANCELLED', 'Abort reason must be forwarded from signal');
  }

  {
    const executeCalls = [];
    const abortCalls = [];
    const client = new LlmClient({
      chromeApi: createChromeApi(),
      offscreenExecutor: {
        async execute() {
          executeCalls.push(true);
          return { ok: true, status: 200, headers: {}, json: { ok: true } };
        },
        async abort(args) {
          abortCalls.push(args);
          return { ok: true, aborted: true };
        }
      }
    });

    const controller = new AbortController();
    controller.abort('PRE_ABORT');
    await assert.rejects(
      () => client.generateResponseRaw({
        modelId: 'gpt-4.1-mini',
        input: 'hello',
        signal: controller.signal,
        meta: { requestId: 'rid-pre-abort' }
      }),
      (error) => Boolean(error && error.name === 'AbortError' && error.code === 'ABORT_ERR')
    );
    assert.strictEqual(executeCalls.length, 0, 'Pre-aborted signal must skip execute');
    assert.strictEqual(abortCalls.length, 1, 'Pre-aborted signal still sends offscreen abort');
    assert.strictEqual(abortCalls[0].requestId, 'rid-pre-abort', 'Pre-abort must reference requestId');
    assert.strictEqual(abortCalls[0].reason, 'PRE_ABORT', 'Pre-abort must preserve reason');
  }

  {
    const executePayloads = [];
    const client = new LlmClient({
      chromeApi: createChromeApi(),
      offscreenExecutor: {
        async execute(args) {
          executePayloads.push(args && args.payload ? args.payload : null);
          return {
            ok: true,
            status: 200,
            headers: { 'x-request-id': 'req-1' },
            json: { output_text: '{"ok":true}' },
            text: null
          };
        }
      }
    });

    const response = await client.generateResponseRaw({
      modelId: 'gpt-4.1-mini',
      input: 'hello',
      maxOutputTokens: 64,
      meta: { requestId: 'rid-success', promptCacheKey: 'nt:pc:unit-test' }
    });
    assert(response && response.json && response.json.output_text, 'Successful offscreen result must return json payload');
    assert.strictEqual(response.status, 200, 'Successful offscreen result must expose status');
    assert.strictEqual(executePayloads.length, 1, 'Offscreen execute should receive one request payload');
    const requestBody = executePayloads[0] && typeof executePayloads[0].body === 'string'
      ? JSON.parse(executePayloads[0].body)
      : {};
    assert.strictEqual(requestBody.prompt_cache_key, 'nt:pc:unit-test', 'Prompt cache key must be forwarded to Responses payload');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(requestBody, 'prompt_cache_retention'), false, 'Prompt cache retention should not be sent when not explicitly configured');
  }

  {
    let fallbackFetchCalls = 0;
    const client = new LlmClient({
      chromeApi: createChromeApi(),
      fetchFn: async () => {
        fallbackFetchCalls += 1;
        return {
          ok: true,
          status: 200,
          headers: {
            get() {
              return null;
            }
          },
          async json() {
            return { output_text: '{"fallback":true}' };
          }
        };
      },
      offscreenExecutor: {
        async execute() {
          const error = new Error('OFFSCREEN_UNAVAILABLE');
          error.code = 'OFFSCREEN_UNAVAILABLE';
          throw error;
        }
      }
    });

    const response = await client.generateResponseRaw({
      modelId: 'gpt-4.1-mini',
      input: 'fallback path',
      maxOutputTokens: 32,
      meta: { requestId: 'rid-fallback' }
    });
    assert.strictEqual(fallbackFetchCalls, 1, 'Client should fallback to direct fetch when offscreen is unavailable');
    assert(response && response.json && response.json.output_text, 'Fallback fetch response must be returned');
  }

  console.log('PASS: llm client offscreen abort');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
