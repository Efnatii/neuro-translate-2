const path = require('path');
const { chromium } = require('@playwright/test');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

async function launchExtensionContext({
  userDataDir,
  extensionPath = REPO_ROOT,
  headless = false,
  viewport = { width: 1440, height: 900 }
} = {}) {
  if (!userDataDir) {
    throw new Error('userDataDir is required');
  }
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: Boolean(headless),
    viewport,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  const extensionId = await resolveExtensionId(context);
  return { context, extensionId };
}

async function resolveExtensionId(context) {
  let sw = context.serviceWorkers()[0] || null;
  if (!sw) {
    sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
  }
  return new URL(sw.url()).host;
}

async function openPopup(context, extensionId, tabId = null) {
  const page = await context.newPage();
  const suffix = Number.isFinite(Number(tabId)) ? `?tabId=${encodeURIComponent(String(tabId))}` : '';
  await page.goto(`chrome-extension://${extensionId}/extension/ui/popup.html${suffix}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function openDebug(context, extensionId, tabId = null) {
  const page = await context.newPage();
  const suffix = Number.isFinite(Number(tabId)) ? `?tabId=${encodeURIComponent(String(tabId))}` : '';
  await page.goto(`chrome-extension://${extensionId}/extension/ui/debug.html${suffix}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function sendBgMsg(page, type, payload) {
  return page.evaluate(async ({ messageType, messagePayload }) => {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: messageType,
        payload: messagePayload && typeof messagePayload === 'object' ? messagePayload : {}
      }, (response) => {
        const runtimeError = chrome.runtime && chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : null;
        if (runtimeError) {
          resolve({ ok: false, error: { code: 'RUNTIME_MESSAGE_FAILED', message: runtimeError } });
          return;
        }
        resolve(response || null);
      });
    });
  }, {
    messageType: type,
    messagePayload: payload
  });
}

module.exports = {
  REPO_ROOT,
  launchExtensionContext,
  resolveExtensionId,
  openPopup,
  openDebug,
  sendBgMsg
};
