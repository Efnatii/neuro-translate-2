const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const util = require('util');
const webStream = require('stream/web');

if (typeof global.TextEncoder === 'undefined' && util.TextEncoder) {
  global.TextEncoder = util.TextEncoder;
}
if (typeof global.ReadableStream === 'undefined' && webStream.ReadableStream) {
  global.ReadableStream = webStream.ReadableStream;
}

const ROOT = path.resolve(__dirname, '..');

function load(relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInThisContext(code, { filename: fullPath });
}

async function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeStreamResponse() {
  const chunks = [
    'data: {"type":"response.output_text.delta","delta":"Hel',
    'lo"}\n\n',
    'data: {"type":"response.output_text.delta","delta":" world"}\n\n',
    'data: {"type":"response.completed","response":{"id":"resp_sse_1","output_text":"Hello world","output":[]}}\n\n'
  ];
  const encoder = new TextEncoder();
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[index]));
      index += 1;
    }
  });
  return {
    ok: true,
    status: 200,
    headers: {
      get() {
        return null;
      }
    },
    body
  };
}

async function run() {
  global.NT = {};
  global.chrome = {
    runtime: {
      onConnect: {
        addListener() {}
      },
      onMessage: {
        addListener() {}
      }
    }
  };
  global.fetch = async () => makeStreamResponse();
  load('extension/core/nt-namespace.js');
  load('extension/core/message-envelope.js');
  load('extension/offscreen/offscreen.js');

  const Host = global.NT.OffscreenLlmHost;
  const Envelope = global.NT.MessageEnvelope;
  assert(Host, 'OffscreenLlmHost must be defined');
  assert(Envelope, 'MessageEnvelope must be defined');

  const host = new Host();
  const posted = [];
  const port = {
    postMessage(message) {
      posted.push(message);
    }
  };

  const message = Envelope.wrap('OFFSCREEN_EXECUTE_REQUEST', {
    requestId: 'req-stream-1',
    requestKey: 'job-1:block-1:1:translation_agent_execute_stream',
    openai: {
      endpoint: 'https://api.openai.com/v1/responses',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: {
        model: 'gpt-4.1-mini',
        input: 'hello',
        stream: true
      }
    },
    timeoutMs: 20000
  }, {
    requestId: 'meta-stream-1'
  });

  const accepted = await host._handleIncoming({
    message,
    transport: 'port',
    port
  });
  assert(accepted && accepted.ok === true, 'Port execute should be accepted');
  await waitMs(40);

  const parsed = posted.map((item) => {
    const unwrapped = Envelope.isEnvelope(item)
      ? {
        type: item.type,
        payload: item.payload || {},
        meta: item.meta || {}
      }
      : {
        type: item && item.type ? item.type : null,
        payload: item && typeof item === 'object' ? item : {},
        meta: {}
      };
    return unwrapped;
  });
  const streamEvents = parsed.filter((item) => item.type === 'OFFSCREEN_STREAM_EVENT');
  assert(streamEvents.length >= 2, 'SSE stream must emit OFFSCREEN_STREAM_EVENT records');
  const firstDelta = streamEvents[0] && streamEvents[0].payload && streamEvents[0].payload.event
    ? streamEvents[0].payload.event.delta
    : null;
  assert(firstDelta, 'First stream event should include delta payload');

  const done = parsed.find((item) => item.type === 'OFFSCREEN_STREAM_DONE');
  assert(done, 'Stream execution should emit OFFSCREEN_STREAM_DONE');
  assert(done.payload && done.payload.ok === true, 'Stream done payload should be ok');
  assert(done.payload.json && done.payload.json.id === 'resp_sse_1', 'Done payload should include final response object');

  console.log('PASS: offscreen stream SSE parser');
  process.exit(0);
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
