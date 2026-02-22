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

async function tick(ms = 20) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function run() {
  global.NT = {
    EventTypes: {
      Tags: {
        TRANSLATION_CANCEL: 'translation.cancel',
        BG_ERROR: 'bg.error'
      }
    }
  };
  load('extension/bg/background-app.js');

  const BackgroundApp = global.NT.BackgroundApp;
  assert(BackgroundApp, 'BackgroundApp must be defined');

  const app = new BackgroundApp({
    chromeApi: {},
    fetchFn: async () => null
  });

  const cancelCalls = [];
  const logEvents = [];
  app.translationOrchestrator = {
    async cancelJob(args) {
      cancelCalls.push(args);
      return { ok: true, cancelled: true };
    }
  };
  app.eventFactory = {
    warn(tag, message, meta) {
      return { level: 'warn', tag, message, meta };
    }
  };
  app._logEvent = (event) => {
    logEvents.push(event);
  };

  app._onTabRemoved(44, { isWindowClosing: true });
  await tick();
  assert.strictEqual(cancelCalls.length, 1, 'Tab removal should call orchestrator cancel');
  assert.strictEqual(cancelCalls[0].tabId, 44, 'Tab removal should pass removed tab id');
  assert.strictEqual(cancelCalls[0].reason, 'TAB_CLOSED', 'Tab removal should pass TAB_CLOSED reason');
  assert(logEvents.some((event) => event && event.tag === 'translation.cancel'), 'Tab removal should emit translation cancel log');

  app._onTabRemoved('invalid', { isWindowClosing: false });
  await tick();
  assert.strictEqual(cancelCalls.length, 1, 'Invalid tab id should be ignored');

  console.log('PASS: background tab lifecycle');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
