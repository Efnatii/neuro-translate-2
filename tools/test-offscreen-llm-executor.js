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

function waitTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeChrome() {
  const storageState = {
    ntInflightRequests: {}
  };
  const sentMessages = [];
  let createDocumentCalls = 0;
  let connectCalls = 0;

  function createPort() {
    const messageListeners = [];
    const disconnectListeners = [];
    const port = {
      name: 'nt-offscreen',
      onMessage: {
        addListener(fn) {
          messageListeners.push(fn);
        }
      },
      onDisconnect: {
        addListener(fn) {
          disconnectListeners.push(fn);
        }
      },
      postMessage(message) {
        const envelope = message && typeof message === 'object' ? message : {};
        const type = envelope.type || null;
        const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
        const meta = envelope.meta && typeof envelope.meta === 'object' ? envelope.meta : {};
        sentMessages.push({ type, payload, meta, message: envelope });

        const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
        const reply = (replyType, replyPayload, requestId) => {
          const out = MessageEnvelope && typeof MessageEnvelope.wrap === 'function'
            ? MessageEnvelope.wrap(replyType, replyPayload || {}, {
              source: 'offscreen',
              stage: replyType,
              requestId: requestId || null
            })
            : { type: replyType, ...(replyPayload || {}) };
          setTimeout(() => {
            messageListeners.forEach((fn) => fn(out));
          }, 0);
        };

        if (type === 'OFFSCREEN_HELLO') {
          reply('OFFSCREEN_HELLO_ACK', { ok: true, ts: Date.now() }, meta.requestId || null);
          return;
        }
        if (type === 'OFFSCREEN_QUERY_STATUS') {
          reply('OFFSCREEN_QUERY_STATUS_ACK', { ok: true, statuses: {}, ts: Date.now() }, meta.requestId || null);
          return;
        }
        if (type === 'OFFSCREEN_PING') {
          reply('OFFSCREEN_PING_ACK', { ok: true, ts: Date.now() }, meta.requestId || null);
          return;
        }
        if (type === 'OFFSCREEN_EXECUTE_REQUEST') {
          reply('OFFSCREEN_RESULT', {
            requestId: payload.requestId,
            requestKey: payload.requestKey || null,
            ok: true,
            json: {
              output_text: '{"items":[],"report":{"summary":"ok"}}'
            },
            status: 200,
            http: { status: 200 },
            headers: {},
            ts: Date.now()
          }, null);
          return;
        }
      },
      _disconnect() {
        disconnectListeners.forEach((fn) => fn());
      }
    };
    return port;
  }

  const chromeApi = {
    runtime: {
      getURL(rel) {
        return `chrome-extension://id/${rel}`;
      },
      async getContexts() {
        return [];
      },
      connect() {
        connectCalls += 1;
        return createPort();
      }
    },
    offscreen: {
      async createDocument() {
        createDocumentCalls += 1;
      }
    },
    storage: {
      local: {
        get(defaults, cb) {
          const out = { ...(defaults || {}) };
          Object.keys(out).forEach((key) => {
            if (Object.prototype.hasOwnProperty.call(storageState, key)) {
              out[key] = storageState[key];
            }
          });
          cb(out);
        },
        set(payload, cb) {
          Object.keys(payload || {}).forEach((key) => {
            storageState[key] = payload[key];
          });
          cb && cb();
        }
      }
    }
  };

  return {
    chromeApi,
    storageState,
    sentMessages,
    stats() {
      return { createDocumentCalls, connectCalls };
    }
  };
}

async function run() {
  global.NT = {};
  load('extension/core/nt-namespace.js');
  load('extension/core/chrome-local-store-base.js');
  load('extension/core/message-envelope.js');
  load('extension/bg/inflight-request-store.js');
  load('extension/bg/offscreen-llm-executor.js');

  const InflightStore = global.NT.InflightRequestStore;
  const Executor = global.NT.OffscreenLlmExecutor;
  assert(InflightStore, 'InflightRequestStore must exist');
  assert(Executor, 'OffscreenLlmExecutor must exist');

  const env = createFakeChrome();
  const inflightStore = new InflightStore({ chromeApi: env.chromeApi });
  const executor = new Executor({
    chromeApi: env.chromeApi,
    inflightStore,
    offscreenPath: 'offscreen/offscreen.html'
  });

  const reqArgs = {
    requestId: 'req-1',
    payload: {
      url: 'https://api.openai.com/v1/responses',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer test'
      },
      body: JSON.stringify({
        model: 'gpt-test',
        input: 'hello'
      }),
      taskType: 'translation_batch',
      meta: {
        jobId: 'job-1',
        blockId: 'b1'
      },
      attempt: 1
    },
    timeoutMs: 5000
  };

  const first = await executor.execute(reqArgs);
  assert(first && first.ok === true, 'first execute should succeed');
  assert(first.json && typeof first.json === 'object', 'first execute should return json payload');
  const statsAfterFirst = env.stats();
  assert.strictEqual(statsAfterFirst.createDocumentCalls, 1, 'offscreen document should be created once on first execute');
  const storedFirst = await inflightStore.get('req-1');
  assert(storedFirst && storedFirst.status === 'done', 'inflight store should mark request as done');

  const executeMessagesBeforeSecond = env.sentMessages.filter((row) => row.type === 'OFFSCREEN_EXECUTE_REQUEST').length;
  const second = await executor.execute(reqArgs);
  const executeMessagesAfterSecond = env.sentMessages.filter((row) => row.type === 'OFFSCREEN_EXECUTE_REQUEST').length;
  assert(second && second.ok === true, 'second execute should succeed');
  assert.strictEqual(executeMessagesAfterSecond, executeMessagesBeforeSecond, 'idempotent second execute should not send OFFSCREEN_EXECUTE_REQUEST');

  await inflightStore.upsert({
    requestId: 'req-cancel-1',
    requestKey: 'job-cancel:b1:1:translation_batch',
    payloadHash: 'h1',
    status: 'pending',
    meta: { jobId: 'job-cancel', blockId: 'b1' },
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const cancelRes = await executor.cancel('req-cancel-1');
  assert(cancelRes && cancelRes.ok === true, 'cancel should succeed');
  const cancelMessages = env.sentMessages.filter((row) => row.type === 'OFFSCREEN_CANCEL_REQUEST');
  assert(cancelMessages.length >= 1, 'cancel should send OFFSCREEN_CANCEL_REQUEST');
  const cancelStored = await inflightStore.get('req-cancel-1');
  assert(cancelStored && cancelStored.status === 'cancelled', 'cancel should persist cancelled status');

  const executorRestarted = new Executor({
    chromeApi: env.chromeApi,
    inflightStore: new InflightStore({ chromeApi: env.chromeApi }),
    offscreenPath: 'offscreen/offscreen.html'
  });

  const executeMessagesBeforeRestarted = env.sentMessages.filter((row) => row.type === 'OFFSCREEN_EXECUTE_REQUEST').length;
  const third = await executorRestarted.execute(reqArgs);
  await waitTick();
  const executeMessagesAfterRestarted = env.sentMessages.filter((row) => row.type === 'OFFSCREEN_EXECUTE_REQUEST').length;
  assert(third && third.ok === true, 'restarted executor should return done result');
  assert.strictEqual(executeMessagesAfterRestarted, executeMessagesBeforeRestarted, 'restarted executor should use persisted done result without network execute');

  console.log('PASS: offscreen llm executor');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
