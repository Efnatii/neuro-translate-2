const path = require('path');
const fs = require('fs/promises');
const { test: base, expect, chromium } = require('@playwright/test');
const { createStaticServer } = require('../server/static-server');
const { createMockOpenAiServer } = require('../server/mock-openai');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendUiCommand(page, { command, payload = {}, tabId = null } = {}) {
  return page.evaluate(async ({ commandName, commandPayload, resolvedTabId }) => {
    const NT = globalThis.NT || {};
    const UiProtocol = NT.UiProtocol || {};
    const MessageEnvelope = NT.MessageEnvelope || {};
    const type = UiProtocol.UI_COMMAND || 'ui:command';
    const body = { name: commandName, payload: commandPayload || {} };
    const meta = {
      source: 'e2e',
      stage: 'e2e',
      tabId: Number.isFinite(Number(resolvedTabId)) ? Number(resolvedTabId) : null,
      requestId: `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`
    };
    const envelope = MessageEnvelope && typeof MessageEnvelope.wrap === 'function'
      ? MessageEnvelope.wrap(type, body, meta)
      : {
        v: 1,
        id: meta.requestId,
        type,
        ts: Date.now(),
        meta,
        payload: body
      };
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(envelope, (response) => {
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
    commandName: command,
    commandPayload: payload,
    resolvedTabId: tabId
  });
}

async function readTabRuntimeState(page, tabId) {
  return page.evaluate(async ({ targetTabId }) => {
    const tabKey = String(targetTabId);
    const dump = await chrome.storage.local.get({
      translationStatusByTab: {},
      translationJobsByTab: {},
      translationJobsById: {},
      translationJobIndexByTab: {}
    });
    const statusByTab = dump.translationStatusByTab || {};
    const jobsByTab = dump.translationJobsByTab || {};
    const jobsById = dump.translationJobsById || {};
    const indexByTab = dump.translationJobIndexByTab || {};
    const statusEntry = statusByTab[tabKey] || statusByTab[targetTabId] || null;
    const activeJobId = jobsByTab[tabKey] || null;
    const lastJobId = indexByTab[tabKey] && indexByTab[tabKey].lastJobId
      ? indexByTab[tabKey].lastJobId
      : null;
    const resolvedJobId = activeJobId || lastJobId || null;
    const job = resolvedJobId && jobsById[resolvedJobId] ? jobsById[resolvedJobId] : null;
    return {
      tabId: targetTabId,
      activeJobId,
      lastJobId,
      jobId: resolvedJobId,
      jobStatus: job && job.status ? job.status : null,
      statusEntry,
      job
    };
  }, { targetTabId: tabId });
}

const test = base.extend({
  servers: [async ({}, use) => {
    const staticServer = createStaticServer({
      rootDir: path.join(REPO_ROOT, 'tests', 'e2e', 'pages')
    });
    const mockServer = createMockOpenAiServer();
    await staticServer.start();
    await mockServer.start();
    await use({ staticServer, mockServer });
    await mockServer.stop();
    await staticServer.stop();
  }, { scope: 'worker' }],

  context: async ({ servers }, use, testInfo) => {
    const userDataDir = testInfo.outputPath('user-data');
    await fs.rm(userDataDir, { recursive: true, force: true });
    await fs.mkdir(userDataDir, { recursive: true });
    servers.mockServer.resetStats();
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: false,
      viewport: { width: 1440, height: 900 },
      args: [
        `--disable-extensions-except=${REPO_ROOT}`,
        `--load-extension=${REPO_ROOT}`
      ]
    });
    await use(context);
    await context.close();
    await sleep(300);
  },

  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0] || null;
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }
    const extensionId = new URL(sw.url()).host;
    await use(extensionId);
  },

  app: async ({ context, extensionId, servers }, use, testInfo) => {
    let helperPage = null;
    let currentExtensionId = extensionId;
    const refreshExtensionId = async ({ allowWait = false } = {}) => {
      try {
        const workers = context.serviceWorkers();
        if (workers && workers.length) {
          currentExtensionId = new URL(workers[workers.length - 1].url()).host;
          return currentExtensionId;
        }
      } catch (_) {
        // fall through
      }
      if (allowWait) {
        try {
          const sw = await context.waitForEvent('serviceworker', { timeout: 5000 });
          if (sw) {
            currentExtensionId = new URL(sw.url()).host;
          }
        } catch (_) {
          // keep last known extension id
        }
      }
      return currentExtensionId;
    };
    const popupBaseUrl = () => `chrome-extension://${currentExtensionId}/extension/ui/popup.html`;
    const debugBaseUrl = () => `chrome-extension://${currentExtensionId}/extension/ui/debug.html`;

    const ensureHelperPage = async () => {
      if (helperPage && !helperPage.isClosed()) {
        return helperPage;
      }
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        try {
          await refreshExtensionId({ allowWait: attempt > 2 });
          helperPage = await context.newPage();
          await helperPage.goto(debugBaseUrl(), { waitUntil: 'domcontentloaded', timeout: 12000 });
          return helperPage;
        } catch (error) {
          if (helperPage && !helperPage.isClosed()) {
            await helperPage.close().catch(() => {});
          }
          helperPage = null;
          if (attempt >= 10) {
            throw error;
          }
          await refreshExtensionId({ allowWait: true }).catch(() => {});
          const message = error && error.message ? String(error.message) : '';
          const blocked = message.includes('ERR_BLOCKED_BY_CLIENT');
          await sleep((blocked ? 500 : 300) * attempt);
        }
      }
      throw new Error('Failed to create helper page');
    };

    const app = {
      staticOrigin: servers.staticServer.origin,
      mockOrigin: servers.mockServer.origin,
      mockServer: servers.mockServer,

      openSite: async (pagePath) => {
        const page = await context.newPage();
        const url = servers.staticServer.urlFor(pagePath || '/simple.html');
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return page;
      },

      resolveTabIdByUrl: async (url, timeoutMs = 10000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          let tabId = null;
          try {
            const helper = await ensureHelperPage();
            tabId = await helper.evaluate(async (targetUrl) => {
              const tabs = await new Promise((resolve) => chrome.tabs.query({}, resolve));
              const hit = Array.isArray(tabs)
                ? tabs.find((tab) => tab && tab.url === targetUrl)
                : null;
              return hit && Number.isFinite(Number(hit.id)) ? Number(hit.id) : null;
            }, url);
          } catch (_) {
            if (helperPage && !helperPage.isClosed()) {
              await helperPage.close().catch(() => {});
            }
            helperPage = null;
          }
          if (Number.isFinite(Number(tabId))) {
            return Number(tabId);
          }
          await sleep(150);
        }
        throw new Error(`tabId not found for url: ${url}`);
      },

      openPopupPage: async (tabId) => {
        await refreshExtensionId({ allowWait: true });
        const page = await context.newPage();
        const url = `${popupBaseUrl()}?tabId=${encodeURIComponent(String(tabId))}`;
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-action="start-translation"]', { timeout: 12000 });
        return page;
      },

      openDebugPage: async (tabId, section = null) => {
        await refreshExtensionId({ allowWait: true });
        const page = await context.newPage();
        const params = new URLSearchParams();
        if (Number.isFinite(Number(tabId))) params.set('tabId', String(tabId));
        if (section) params.set('section', String(section));
        const suffix = params.toString();
        await page.goto(`${debugBaseUrl()}${suffix ? `?${suffix}` : ''}`, { waitUntil: 'domcontentloaded' });
        return page;
      },

      sendCommand: async (command, payload = {}, tabId = null) => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          let result = null;
          try {
            const helper = await ensureHelperPage();
            result = await sendUiCommand(helper, { command, payload, tabId });
          } catch (error) {
            if (helperPage && !helperPage.isClosed()) {
              await helperPage.close().catch(() => {});
            }
            helperPage = null;
            if (String(command) === 'BG_TEST_RELOAD_EXTENSION') {
              // runtime.reload can close the page before response is delivered.
              return { ok: true, reloaded: true, detachedDuringReload: true };
            }
            if (attempt >= 3) {
              return {
                ok: false,
                error: {
                  code: 'COMMAND_EVAL_FAILED',
                  message: error && error.message ? error.message : String(error || 'sendCommand failed')
                }
              };
            }
            await sleep(250 * attempt);
            continue;
          }
          const code = result && result.error && result.error.code ? result.error.code : '';
          if (code === 'RUNTIME_MESSAGE_FAILED' && attempt < 3) {
            if (helperPage && !helperPage.isClosed()) {
              await helperPage.close().catch(() => {});
            }
            helperPage = null;
            await sleep(300 * attempt);
            continue;
          }
          return result;
        }
        return { ok: false, error: { code: 'COMMAND_RETRY_EXHAUSTED', message: command } };
      },

      configureMockProxy: async () => {
        const settingsRes = await app.sendCommand('SET_SETTINGS', {
          patch: {
            debugAllowTestCommands: true,
            translationAgentTuning: {
              proofreadingPassesOverride: 0
            }
          }
        });
        if (!settingsRes || settingsRes.ok !== true) {
          throw new Error(`Failed to apply e2e settings patch: ${JSON.stringify(settingsRes || null)}`);
        }
        const proxyRes = await app.sendCommand('BG_TEST_SET_PROXY_CONFIG', {
          baseUrl: servers.mockServer.origin
        });
        if (!proxyRes || proxyRes.ok !== true) {
          throw new Error(`Failed to configure mock proxy: ${JSON.stringify(proxyRes || null)}`);
        }
        const ping = await app.sendCommand('BG_TEST_CONNECTION', { timeoutMs: 8000 });
        const expectedHost = new URL(servers.mockServer.origin).host;
        if (!ping || ping.ok !== true) {
          throw new Error(`Mock proxy connection test failed: ${JSON.stringify(ping || null)}`);
        }
        if (ping.endpointHost && ping.endpointHost !== expectedHost) {
          throw new Error(`Connection endpoint mismatch: expected=${expectedHost} actual=${ping.endpointHost}`);
        }
      },

      readTabState: async (tabId) => {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            const helper = await ensureHelperPage();
            return await readTabRuntimeState(helper, tabId);
          } catch (error) {
            if (helperPage && !helperPage.isClosed()) {
              await helperPage.close().catch(() => {});
            }
            helperPage = null;
            if (attempt >= 3) {
              throw error;
            }
            await sleep(250 * attempt);
          }
        }
        return { tabId, jobStatus: null, statusEntry: null, job: null };
      },

      waitForState: async (tabId, predicate, { timeoutMs = 60000, intervalMs = 250, label = 'state predicate' } = {}) => {
        const deadline = Date.now() + timeoutMs;
        let last = null;
        while (Date.now() < deadline) {
          try {
            last = await app.readTabState(tabId);
          } catch (error) {
            last = {
              tabId,
              jobStatus: null,
              statusEntry: null,
              readError: error && error.message ? error.message : String(error || 'readTabState failed')
            };
            await sleep(intervalMs);
            continue;
          }
          if (predicate(last)) {
            return last;
          }
          await sleep(intervalMs);
        }
        throw new Error(`Timeout waiting for ${label}. Last state: ${JSON.stringify(last && { jobStatus: last.jobStatus, status: last.statusEntry && last.statusEntry.status })}`);
      }
    };

    await use(app);

    if (testInfo.status !== testInfo.expectedStatus) {
      try {
        await Promise.race([
          (async () => {
            const helper = await ensureHelperPage();
            const logs = await sendUiCommand(helper, {
              command: 'BG_TEST_GET_LOGS',
              payload: { limit: 200 }
            });
            const storageDump = await helper.evaluate(async () => chrome.storage.local.get(null));
            const diagnostics = {
              logs,
              storageDump,
              mockStats: servers.mockServer.getStats(),
              mockRecentRequests: servers.mockServer.getRecentRequests(120)
            };
            await fs.writeFile(
              testInfo.outputPath('debug-diagnostics.json'),
              JSON.stringify(diagnostics, null, 2),
              'utf-8'
            );
          })(),
          sleep(8000)
        ]);
      } catch (_) {
        // best-effort diagnostics
      }
    }
  }
});

module.exports = {
  test,
  expect
};
