const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

function load(context, relativePath) {
  const fullPath = path.join(ROOT, relativePath);
  const code = fs.readFileSync(fullPath, 'utf8');
  vm.runInContext(code, context, { filename: fullPath });
}

function createFakePort(name) {
  const messageListeners = [];
  const disconnectListeners = [];

  const port = {
    name,
    sent: [],
    onMessage: {
      addListener(fn) {
        messageListeners.push(fn);
      },
      removeListener(fn) {
        const idx = messageListeners.indexOf(fn);
        if (idx >= 0) {
          messageListeners.splice(idx, 1);
        }
      }
    },
    onDisconnect: {
      addListener(fn) {
        disconnectListeners.push(fn);
      },
      removeListener(fn) {
        const idx = disconnectListeners.indexOf(fn);
        if (idx >= 0) {
          disconnectListeners.splice(idx, 1);
        }
      }
    },
    postMessage(message) {
      this.sent.push(message);
    },
    disconnect() {
      this.emitDisconnect();
    },
    emitMessage(message) {
      messageListeners.slice().forEach((fn) => fn(message));
    },
    emitDisconnect() {
      disconnectListeners.slice().forEach((fn) => fn());
    }
  };

  return port;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    URLSearchParams,
    navigator: {},
    chrome: null,
    globalThis: null
  };
  sandbox.globalThis = sandbox;

  const connectCalls = [];
  const ports = [];
  sandbox.chrome = {
    runtime: {
      connect({ name }) {
        const port = createFakePort(name);
        connectCalls.push(name);
        ports.push(port);
        return port;
      }
    }
  };

  const context = vm.createContext(sandbox);
  load(context, 'extension/core/nt-namespace.js');
  load(context, 'extension/core/message-envelope.js');
  load(context, 'extension/core/ui-protocol.js');
  load(context, 'extension/ui/ui-protocol-client.js');

  const MessageEnvelope = context.NT.MessageEnvelope;
  const UiProtocol = context.NT.UiProtocol;
  const UiProtocolClient = context.NT.UiProtocolClient;

  const statuses = [];
  const snapshots = [];

  const client = new UiProtocolClient({ channelName: 'popup' });
  client.onStatus((s) => statuses.push(s.state));
  client.onSnapshot((s) => snapshots.push(s));
  client.setHelloContext({ tabId: 123 });
  client.connect();

  await wait(20);
  assert.strictEqual(connectCalls.length, 1, 'must connect once on start');
  const firstPort = ports[0];
  assert(firstPort.sent.length >= 1, 'must send HELLO envelope');
  assert.strictEqual(firstPort.sent[0].type, UiProtocol.UI_HELLO, 'first message should be HELLO');

  firstPort.emitMessage(MessageEnvelope.wrap(
    UiProtocol.UI_SNAPSHOT,
    { tabId: 123, translationProgress: 10 },
    { source: 'background', stage: 'snapshot' }
  ));

  await wait(30);
  assert(snapshots.length >= 1, 'must receive snapshot');
  assert(firstPort.sent.some((m) => m && m.type === UiProtocol.UI_SUBSCRIBE), 'must send SUBSCRIBE after snapshot');
  assert(statuses.includes('connected'), 'must report connected status');

  const commandPromise = client.sendCommand('PING', { ok: true }, {
    timeoutMs: 700,
    retries: 0,
    connectTimeoutMs: 800
  });

  await wait(30);
  const commandEnvelope = firstPort.sent.find((m) => m && m.type === UiProtocol.UI_COMMAND);
  assert(commandEnvelope, 'must send UI_COMMAND envelope');

  const requestId = commandEnvelope.meta && commandEnvelope.meta.requestId
    ? commandEnvelope.meta.requestId
    : null;
  assert(requestId, 'command envelope should have requestId');

  firstPort.emitMessage(MessageEnvelope.wrap(
    UiProtocol.UI_PATCH,
    {
      type: UiProtocol.UI_COMMAND_RESULT,
      requestId,
      ok: true,
      result: { ok: true, pong: true }
    },
    { source: 'background', stage: 'patch', requestId }
  ));

  const commandResult = await commandPromise;
  assert.strictEqual(commandResult && commandResult.pong, true, 'must resolve command by ACK patch');

  firstPort.emitDisconnect();
  await wait(280);
  assert(connectCalls.length >= 2, 'must reconnect after disconnect');

  const timeoutStatuses = [];
  const timeoutClient = new UiProtocolClient({ channelName: 'debug' });
  timeoutClient.onStatus((s) => timeoutStatuses.push(s.state));
  timeoutClient._waitForSnapshot = () => Promise.reject(new Error('SNAPSHOT_TIMEOUT'));
  timeoutClient.connect();

  await wait(100);
  assert(
    timeoutStatuses.includes('reconnecting') || timeoutStatuses.includes('connecting'),
    'timeout path should transition through reconnecting'
  );

  timeoutClient.disconnect();
  client.disconnect();
  console.log('PASS: ui-protocol-client reconnect/backoff + handshake handling');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
