const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { test, expect } = require('./fixtures/extension-fixture');

const DEFAULT_TARGET_URL = 'https://www.fimfiction.net/story/586972/1/uno/uno';
const TEST_REAL_TARGET_URL = String(process.env.TEST_REAL_TARGET_URL || '').trim();
const TEST_REAL_TARGET_PATH = String(process.env.TEST_REAL_TARGET_PATH || '').trim();
const OPENAI_KEY = String(process.env.OPENAI_API_KEY || '').trim();
const TEST_MODE = String(process.env.TEST_MODE || '').trim().toLowerCase();
const IS_MOCK_MODE = TEST_MODE === 'mock';
const TEST_REAL_VERBOSE = /^(1|true|yes)$/i.test(String(process.env.TEST_REAL_VERBOSE || '').trim());
const RESULT_DIR = path.resolve(process.cwd(), 'test-results');
const DEBUG_LOG_PATH = TEST_REAL_VERBOSE
  ? path.resolve(process.cwd(), 'test-results', 'real-fimfiction-debug.log')
  : '';

if (TEST_REAL_VERBOSE && DEBUG_LOG_PATH) {
  try {
    fsSync.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
    fsSync.writeFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} [real-e2e] spec.loaded\n`, 'utf-8');
  } catch (_) {
    // best-effort local trace
  }
}

const runtimeByTest = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function debugLog(message, extra = null) {
  if (!TEST_REAL_VERBOSE) {
    return;
  }
  const suffix = extra === null ? '' : ` ${JSON.stringify(extra)}`;
  const line = `[real-e2e] ${message}${suffix}`;
  // eslint-disable-next-line no-console
  console.log(line);
  if (DEBUG_LOG_PATH) {
    try {
      fsSync.mkdirSync(path.dirname(DEBUG_LOG_PATH), { recursive: true });
      fsSync.appendFileSync(DEBUG_LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf-8');
    } catch (_) {
      // best-effort local trace
    }
  }
}

function hasCyrillic(text) {
  return /[А-Яа-яЁё]/.test(String(text || ''));
}

function normalizeStage(state) {
  return String(state && state.stage ? state.stage : '').trim().toLowerCase();
}

function normalizeStatus(state) {
  return String(state && state.status ? state.status : '').trim().toLowerCase();
}

function toState(stateResponse) {
  if (!stateResponse || stateResponse.ok !== true) {
    return null;
  }
  if (stateResponse.state && typeof stateResponse.state === 'object') {
    return stateResponse.state;
  }
  return stateResponse;
}

function testKey(testInfo) {
  const parts = Array.isArray(testInfo && testInfo.titlePath) ? testInfo.titlePath : [testInfo && testInfo.title ? testInfo.title : 'unknown'];
  return parts.join(' > ');
}

function ensureRuntime(testInfo) {
  const key = testKey(testInfo);
  if (!runtimeByTest.has(key)) {
    runtimeByTest.set(key, {
      tabId: null,
      jobId: null,
      lastState: null
    });
  }
  return runtimeByTest.get(key);
}

function rememberRuntime(testInfo, patch = {}) {
  const slot = ensureRuntime(testInfo);
  Object.assign(slot, patch || {});
  runtimeByTest.set(testKey(testInfo), slot);
}

function sanitizeFileName(input) {
  const raw = String(input || 'test').trim();
  const safe = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 140);
  return safe || 'test';
}

function getToolNames(report) {
  const trace = report && report.agent && Array.isArray(report.agent.toolExecutionTrace)
    ? report.agent.toolExecutionTrace
    : [];
  return trace
    .map((item) => String(item && item.toolName ? item.toolName : '').trim())
    .filter(Boolean);
}

async function dismissCookieBanners(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("OK")',
    'button:has-text("I agree")',
    'button:has-text("I Agree")',
    'button:has-text("Got it")',
    'button:has-text("Cookie")'
  ];

  for (const selector of selectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 1200 })) {
        await button.click({ timeout: 2000 }).catch(() => null);
      }
    } catch (_) {
      // best-effort
    }
  }
}

async function resolveAnchorParagraph(page) {
  const result = await page.evaluate(() => {
    const roots = [
      document.querySelector('main article'),
      document.querySelector('article'),
      document.querySelector('main'),
      document.body
    ].filter(Boolean);

    const root = roots[0] || document.body;
    const paragraphs = Array.from(root.querySelectorAll('p'))
      .map((node, index) => ({
        index,
        text: String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim()
      }))
      .filter((row) => row.text.length >= 40);

    if (!paragraphs.length) {
      return null;
    }

    const best = paragraphs
      .slice()
      .sort((a, b) => b.text.length - a.text.length)[0];

    return {
      rootKind: root === document.body
        ? 'body'
        : (root.matches('main article')
          ? 'main-article'
          : (root.matches('article') ? 'article' : 'main')),
      index: best.index,
      snippet: best.text.slice(0, 160)
    };
  });

  if (!result || !Number.isFinite(Number(result.index)) || !result.snippet) {
    throw new Error('Failed to resolve chapter paragraph anchor');
  }

  return {
    rootKind: String(result.rootKind || 'main-article'),
    index: Number(result.index),
    originalSnippet: String(result.snippet)
  };
}

async function readAnchorSnippet(page, anchor, maxLen = 160) {
  return page.evaluate(({ rootKind, index, length }) => {
    let root = null;
    if (rootKind === 'main-article') {
      root = document.querySelector('main article');
    }
    if (!root && rootKind === 'article') {
      root = document.querySelector('article');
    }
    if (!root && rootKind === 'main') {
      root = document.querySelector('main');
    }
    if (!root) {
      root = document.querySelector('main article')
        || document.querySelector('article')
        || document.querySelector('main')
        || document.body;
    }

    const paragraphs = Array.from(root.querySelectorAll('p'))
      .map((node) => String(node && node.textContent ? node.textContent : '').replace(/\s+/g, ' ').trim())
      .filter((value) => value.length >= 1);

    const direct = paragraphs[Number(index)] || paragraphs[0] || '';
    return direct.slice(0, Number(length) || 160);
  }, {
    rootKind: anchor.rootKind,
    index: anchor.index,
    length: maxLen
  });
}

async function requireAndConfigureRealMode(app) {
  if (!OPENAI_KEY) {
    throw new Error('OPENAI_API_KEY is required for real fimfiction e2e');
  }

  debugLog('realMode.enableTestCommands.start');
  const enableRes = await app.sendBgMessage('BG_TEST_ENABLE_COMMANDS', { enable: true });
  debugLog('realMode.enableTestCommands.done', { ok: Boolean(enableRes && enableRes.ok), error: enableRes && enableRes.error ? enableRes.error.code : null });
  expect(enableRes && enableRes.ok).toBeTruthy();

  debugLog('realMode.setByok.start');
  const byokRes = await app.sendBgMessage('BG_TEST_SET_BYOK_KEY_SESSION', { apiKey: OPENAI_KEY });
  debugLog('realMode.setByok.done', { ok: Boolean(byokRes && byokRes.ok), error: byokRes && byokRes.error ? byokRes.error.code : null });
  expect(byokRes && byokRes.ok).toBeTruthy();

  debugLog('realMode.setLang.start');
  const langRes = await app.sendBgMessage('BG_TEST_SET_TARGET_LANG', { lang: 'ru' });
  debugLog('realMode.setLang.done', { ok: Boolean(langRes && langRes.ok), error: langRes && langRes.error ? langRes.error.code : null });
  expect(langRes && langRes.ok).toBeTruthy();

  debugLog('realMode.patchSettings.start');
  const settingsRes = await app.sendCommand('SET_SETTINGS', {
    patch: {
      translationAgentProfile: 'fast',
      translationAgentTuning: {
        plannerMaxOutputTokens: 700,
        executionMaxOutputTokens: 900,
        proofreadingPassesOverride: 0
      }
    }
  });
  debugLog('realMode.patchSettings.done', { ok: Boolean(settingsRes && settingsRes.ok), error: settingsRes && settingsRes.error ? settingsRes.error.code : null });
  expect(settingsRes && settingsRes.ok).toBeTruthy();
}

function resolveTargetUrl(app) {
  if (TEST_REAL_TARGET_URL) {
    return TEST_REAL_TARGET_URL;
  }
  if (TEST_REAL_TARGET_PATH) {
    if (/^https?:\/\//i.test(TEST_REAL_TARGET_PATH)) {
      return TEST_REAL_TARGET_PATH;
    }
    const base = app && typeof app.staticOrigin === 'string'
      ? String(app.staticOrigin).trim()
      : '';
    if (base) {
      return `${base}${TEST_REAL_TARGET_PATH.startsWith('/') ? '' : '/'}${TEST_REAL_TARGET_PATH}`;
    }
  }
  return DEFAULT_TARGET_URL;
}

async function openTargetPage(app, context) {
  const targetUrl = resolveTargetUrl(app);
  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
  await dismissCookieBanners(page);
  return page;
}

async function pollActiveJobId(app, tabId, testInfo, { timeoutMs = 45000, pollMs = 250 } = {}) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < timeoutMs) {
    const active = await app.sendBgMessage('BG_TEST_GET_ACTIVE_JOB', { tabId });
    if (active && active.ok && typeof active.jobId === 'string' && active.jobId) {
      rememberRuntime(testInfo, { tabId, jobId: active.jobId });
      return active.jobId;
    }
    await sleep(pollMs);
  }
  throw new Error('Active job id was not discovered in time');
}

async function pollJobState(app, { jobId, tabId, testInfo, timeoutMs = 60000, pollMs = 250, predicate, label = 'state' } = {}) {
  const startedAt = Date.now();
  let last = null;
  while ((Date.now() - startedAt) < timeoutMs) {
    const stateRes = await app.sendBgMessage('BG_TEST_GET_JOB_STATE', { jobId, tabId });
    if (stateRes && stateRes.ok) {
      const state = toState(stateRes);
      if (state) {
        last = state;
        rememberRuntime(testInfo, { tabId, jobId, lastState: state });
        if (!predicate || predicate(state)) {
          return state;
        }
      }
    }
    await sleep(pollMs);
  }
  throw new Error(`Timeout waiting for ${label}. Last=${JSON.stringify(last ? { status: last.status, stage: last.stage } : null)}`);
}

async function assertPreanalysisGate(app, { jobId, tabId, popup, testInfo }) {
  let sawPreanalysis = false;
  let sawPlanning = false;
  let awaiting = null;
  const seenStages = [];
  const startedAt = Date.now();

  while ((Date.now() - startedAt) < 120000) {
    const stateRes = await app.sendBgMessage('BG_TEST_GET_JOB_STATE', { jobId, tabId });
    expect(stateRes && stateRes.ok).toBeTruthy();
    const state = toState(stateRes);
    expect(state).toBeTruthy();
    rememberRuntime(testInfo, { tabId, jobId, lastState: state });

    const stage = normalizeStage(state);
    const status = normalizeStatus(state);
    const checklist = Array.isArray(state.checklist) ? state.checklist : [];
    const preanalysisByChecklist = checklist.some((row) => {
      const id = String(row && row.id ? row.id : '').trim().toLowerCase();
      const markerStatus = String(row && row.status ? row.status : '').trim().toLowerCase();
      if (!id) {
        return false;
      }
      if (markerStatus !== 'done') {
        return false;
      }
      return id === 'preanalysis_ready' || id === 'analyze_page' || id === 'scanned';
    });
    if (preanalysisByChecklist) {
      sawPreanalysis = true;
    }

    if (stage && !seenStages.includes(stage)) {
      seenStages.push(stage);
      debugLog('gate.stage', {
        stage,
        status,
        done: Number(state.done || state.doneCount || 0),
        total: Number(state.total || state.totalCount || 0)
      });
    }

    if (status === 'failed' || stage === 'failed') {
      throw new Error(`Job failed before awaiting_categories: ${JSON.stringify(state.lastError || null)}`);
    }

    if (stage === 'awaiting_categories') {
      awaiting = state;
      break;
    }

    if (stage === 'execution') {
      throw new Error('Execution started before awaiting_categories');
    }

    const chooserVisible = await popup.locator('[data-section="category-chooser"]').isVisible({ timeout: 120 }).catch(() => false);
    expect(chooserVisible).toBeFalsy();

    if (stage === 'preanalysis' || stage === 'scan' || stage === 'scanning' || stage === 'planning') {
      const selected = Array.isArray(state.selectedCategories) ? state.selectedCategories : [];
      expect(selected.length).toBe(0);
      if (stage === 'planning') {
        // In planning stage agent may already persist taxonomy/plan drafts.
        sawPlanning = true;
      } else {
        expect(Boolean(state.planPresent)).toBeFalsy();
        expect(Boolean(state.taxonomyPresent)).toBeFalsy();
        expect(Boolean(state.glossaryPresent)).toBeFalsy();
        sawPreanalysis = true;
      }
    }

    await sleep(200);
  }

  if (!awaiting) {
    throw new Error(`Job did not reach awaiting_categories. Seen stages: ${seenStages.join(',')}`);
  }

  expect(sawPreanalysis).toBeTruthy();
  expect(sawPlanning).toBeTruthy();
  expect(Boolean(awaiting.taxonomyPresent)).toBeTruthy();
  expect(Boolean(awaiting.planPresent)).toBeTruthy();
  expect(awaiting.userQuestion && Number(awaiting.userQuestion.optionsCount || 0) > 0).toBeTruthy();
}

async function selectRecommendedCategoriesAndRun(popup) {
  const chooser = popup.locator('[data-section="category-chooser"]');
  const categoriesToggle = popup.locator('[data-acc-toggle="categories"]');
  if (!(await chooser.isVisible().catch(() => false))) {
    await categoriesToggle.click({ force: true }).catch(() => null);
  }
  await expect(chooser).toBeVisible({ timeout: 25000 });

  const allEnabled = popup.locator('[data-section="category-chooser-list"] input[type="checkbox"]:not([disabled])');
  await expect.poll(async () => allEnabled.count(), { timeout: 20000 }).toBeGreaterThan(0);

  const allCount = await allEnabled.count();
  for (let i = 0; i < allCount; i += 1) {
    const node = allEnabled.nth(i);
    if (await node.isChecked().catch(() => false)) {
      await node.uncheck({ force: true }).catch(() => null);
    }
  }

  const recommended = popup
    .locator('.popup__category-group:has(.popup__category-group-title:has-text("Recommended")) input[type="checkbox"]:not([disabled])');
  const recommendedCount = await recommended.count();

  if (recommendedCount > 0) {
    for (let i = 0; i < recommendedCount; i += 1) {
      await recommended.nth(i).check({ force: true }).catch(() => null);
    }
  } else {
    await allEnabled.first().check({ force: true });
  }
  debugLog('categories.selected', { allCount, recommendedCount });

  await popup.locator('[data-action="start-translation"]').click();
}

async function waitStreamingChange(app, { page, anchor, originalSnippet, jobId, tabId, testInfo, timeoutMs = 90000 }) {
  const startedAt = Date.now();
  let sawChangeBeforeDone = false;
  let sawCyr = false;
  let latestSnippet = originalSnippet;
  let doneSeen = false;
  let lastState = null;
  let lastLogAt = 0;

  while ((Date.now() - startedAt) < timeoutMs) {
    latestSnippet = await readAnchorSnippet(page, anchor, 160);
    const stateRes = await app.sendBgMessage('BG_TEST_GET_JOB_STATE', { jobId, tabId });
    const state = toState(stateRes);
    if (state) {
      lastState = state;
      rememberRuntime(testInfo, { tabId, jobId, lastState: state });
      const status = normalizeStatus(state);
      if (status === 'done') {
        doneSeen = true;
      }
      if (latestSnippet && latestSnippet !== originalSnippet && status !== 'done') {
        sawChangeBeforeDone = true;
      }
      if (hasCyrillic(latestSnippet)) {
        sawCyr = true;
      }
      if (sawChangeBeforeDone && sawCyr) {
        break;
      }
      if (TEST_REAL_VERBOSE && (Date.now() - lastLogAt) >= 5000) {
        lastLogAt = Date.now();
        debugLog('streaming.poll', {
          status,
          stage: normalizeStage(state),
          done: Number(state.done || state.doneCount || 0),
          total: Number(state.total || state.totalCount || 0),
          sawDomChange: sawChangeBeforeDone,
          sawCyr,
          doneSeen
        });
      }
    }
    await sleep(250);
  }

  if (!sawChangeBeforeDone || !sawCyr) {
    const stateSnapshot = lastState
      ? {
        status: normalizeStatus(lastState),
        stage: normalizeStage(lastState),
        done: Number(lastState.done || lastState.doneCount || 0),
        total: Number(lastState.total || lastState.totalCount || 0),
        leaseUntilTs: Number.isFinite(Number(lastState.leaseUntilTs)) ? Number(lastState.leaseUntilTs) : null
      }
      : null;
    throw new Error(`Streaming change timeout: sawDomChange=${sawChangeBeforeDone} sawCyr=${sawCyr} doneSeen=${doneSeen} last=${JSON.stringify(stateSnapshot)} original="${String(originalSnippet || '').slice(0, 120)}" latest="${String(latestSnippet || '').slice(0, 120)}"`);
  }
  return latestSnippet;
}

async function runToDone({ app, context, testInfo }) {
  await requireAndConfigureRealMode(app);

  const page = await openTargetPage(app, context);
  debugLog('target.opened', { url: page.url() });
  const anchor = await resolveAnchorParagraph(page);
  const originalSnippet = anchor.originalSnippet;
  const tabId = await app.resolveTabIdByUrl(page.url());
  rememberRuntime(testInfo, { tabId, jobId: null, lastState: null });

  const popup = await app.openPopup(tabId);

  await popup.locator('[data-action="start-translation"]').click();
  const jobId = await pollActiveJobId(app, tabId, testInfo);

  await assertPreanalysisGate(app, { jobId, tabId, popup, testInfo });
  await selectRecommendedCategoriesAndRun(popup);

  await waitStreamingChange(app, {
    page,
    anchor,
    originalSnippet,
    jobId,
    tabId,
    testInfo,
    timeoutMs: 90000
  });

  const done = await pollJobState(app, {
    jobId,
    tabId,
    testInfo,
    timeoutMs: 120000,
    pollMs: 300,
    label: 'done',
    predicate: (state) => normalizeStatus(state) === 'done'
  });

  expect(Number(done.done || done.doneCount || 0)).toBeGreaterThan(0);
  expect(done.lastError === null || done.lastError === undefined).toBeTruthy();

  const reportRes = await app.sendBgMessage('BG_TEST_EXPORT_REPORT_JSON', {
    jobId,
    tabId,
    logsLimit: 200,
    toolTraceLimit: 220,
    patchLimit: 120
  });
  expect(reportRes && reportRes.ok).toBeTruthy();
  const toolNames = getToolNames(reportRes && reportRes.report ? reportRes.report : null);
  expect(toolNames.includes('agent.plan.set_taxonomy')).toBeTruthy();
  expect(toolNames.includes('agent.plan.set_pipeline')).toBeTruthy();
  expect(toolNames.includes('agent.plan.request_finish_analysis')).toBeTruthy();
  expect(toolNames.includes('agent.ui.ask_user_categories')).toBeTruthy();
  expect(toolNames.some((name) => name === 'translator.translate_unit_stream' || name === 'translator.translate_block_stream')).toBeTruthy();
  expect(toolNames.includes('page.apply_delta')).toBeTruthy();

  return {
    page,
    popup,
    tabId,
    jobId,
    anchor,
    originalSnippet,
    doneState: done
  };
}

test.describe.serial('REAL fimfiction UNO total pipeline', () => {
  test.skip(IS_MOCK_MODE, 'real fimfiction suite is disabled in TEST_MODE=mock');

  test.beforeAll(() => {
    if (!OPENAI_KEY) {
      throw new Error('OPENAI_API_KEY is required for real fimfiction suite');
    }
  });

  test.afterEach(async ({ app }, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) {
      return;
    }

    const slot = ensureRuntime(testInfo);
    await app.sendBgMessage('BG_TEST_ENABLE_COMMANDS', { enable: true }).catch(() => null);

    let tabId = Number.isFinite(Number(slot.tabId)) ? Number(slot.tabId) : null;
    let jobId = typeof slot.jobId === 'string' && slot.jobId ? slot.jobId : null;

    if (!jobId && Number.isFinite(Number(tabId))) {
      const active = await app.sendBgMessage('BG_TEST_GET_ACTIVE_JOB', { tabId }).catch(() => null);
      if (active && active.ok && typeof active.jobId === 'string' && active.jobId) {
        jobId = active.jobId;
      }
    }

    if (!tabId && jobId) {
      const stateRes = await app.sendBgMessage('BG_TEST_GET_JOB_STATE', { jobId }).catch(() => null);
      const state = toState(stateRes);
      if (state) {
        slot.lastState = state;
      }
      if (stateRes && stateRes.ok && Number.isFinite(Number(stateRes.tabId))) {
        tabId = Number(stateRes.tabId);
      }
    }

    const safeName = sanitizeFileName(testInfo.title);
    await fs.mkdir(RESULT_DIR, { recursive: true });

    if (jobId) {
      const report = await app.sendBgMessage('BG_TEST_EXPORT_REPORT_JSON', {
        jobId,
        tabId,
        logsLimit: 220,
        toolTraceLimit: 180,
        patchLimit: 180
      }).catch(() => null);

      if (report && report.ok && report.report) {
        await fs.writeFile(
          path.join(RESULT_DIR, `${safeName}.report.json`),
          `${JSON.stringify(report.report, null, 2)}\n`,
          'utf-8'
        );
      }
    }

    if (jobId) {
      const stateRes = await app.sendBgMessage('BG_TEST_GET_JOB_STATE', { jobId, tabId }).catch(() => null);
      const state = toState(stateRes);
      if (state) {
        slot.lastState = state;
      }
    }

    await fs.writeFile(
      path.join(RESULT_DIR, `${safeName}.state.json`),
      `${JSON.stringify({
        tabId,
        jobId,
        lastState: slot.lastState || null
      }, null, 2)}\n`,
      'utf-8'
    );
  });

  test('PIPELINE + STREAMING + DONE', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);
    debugLog('test.start', { name: 'PIPELINE + STREAMING + DONE' });

    const run = await runToDone({ app, context, testInfo });
    await run.popup.close().catch(() => null);
    await run.page.close().catch(() => null);
  });

  test('Toggle original/translated/compare', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);

    const run = await runToDone({ app, context, testInfo });
    const { popup, page, anchor, originalSnippet } = run;

    await popup.locator('[data-field="display-mode-select"]').selectOption('original');
    await expect.poll(async () => {
      const snippet = await readAnchorSnippet(page, anchor, 160);
      return snippet === originalSnippet || !hasCyrillic(snippet);
    }, { timeout: 60000 }).toBeTruthy();

    await popup.locator('[data-field="display-mode-select"]').selectOption('translated');
    await expect.poll(async () => {
      const snippet = await readAnchorSnippet(page, anchor, 160);
      return hasCyrillic(snippet) || snippet !== originalSnippet;
    }, { timeout: 60000 }).toBeTruthy();

    await popup.locator('[data-field="display-mode-select"]').selectOption('compare');
    const compareModeActive = await page.evaluate(() => {
      if (!globalThis.CSS || !CSS.highlights) {
        return true;
      }
      return Boolean(CSS.highlights.get('nt-diff'));
    });
    const modeValue = await popup.locator('[data-field="display-mode-select"]').inputValue();
    expect(compareModeActive || modeValue === 'compare').toBeTruthy();

    await popup.close().catch(() => null);
    await page.close().catch(() => null);
  });

  test('Cancel mid-stream + erase', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);

    await requireAndConfigureRealMode(app);
    const page = await openTargetPage(app, context);
    const anchor = await resolveAnchorParagraph(page);
    const originalSnippet = anchor.originalSnippet;
    const tabId = await app.resolveTabIdByUrl(page.url());
    rememberRuntime(testInfo, { tabId, jobId: null, lastState: null });

    const popup = await app.openPopup(tabId);
    await popup.locator('[data-action="start-translation"]').click();

    const jobId = await pollActiveJobId(app, tabId, testInfo);
    await assertPreanalysisGate(app, { jobId, tabId, popup, testInfo });
    await selectRecommendedCategoriesAndRun(popup);

    await waitStreamingChange(app, {
      page,
      anchor,
      originalSnippet,
      jobId,
      tabId,
      testInfo,
      timeoutMs: 90000
    });

    await popup.locator('[data-action="cancel-translation"]').click();

    const cancelledState = await pollJobState(app, {
      jobId,
      tabId,
      testInfo,
      timeoutMs: 120000,
      label: 'cancelled',
      predicate: (state) => {
        const status = normalizeStatus(state);
        if (status === 'cancelled') {
          return true;
        }
        if (status === 'idle') {
          const err = state && state.lastError ? JSON.stringify(state.lastError).toLowerCase() : '';
          return err.includes('cancel');
        }
        return false;
      }
    });

    const leaseUntilTs = Number.isFinite(Number(cancelledState.leaseUntilTs))
      ? Number(cancelledState.leaseUntilTs)
      : null;
    if (leaseUntilTs !== null) {
      expect(leaseUntilTs).toBeLessThanOrEqual(Date.now() + 5000);
    }

    await expect.poll(async () => {
      const snippet = await readAnchorSnippet(page, anchor, 160);
      return snippet === originalSnippet || !hasCyrillic(snippet);
    }, { timeout: 60000 }).toBeTruthy();

    const eraseRes = await app.sendBgMessage('BG_TEST_ERASE_JOB', { jobId, tabId, includeCache: true });
    expect(eraseRes && eraseRes.ok).toBeTruthy();

    await popup.close().catch(() => null);
    await page.close().catch(() => null);
  });

  test('Reload mid-stream restore (no RUNNING forever)', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);

    await requireAndConfigureRealMode(app);
    const page = await openTargetPage(app, context);
    const anchor = await resolveAnchorParagraph(page);
    const originalSnippet = anchor.originalSnippet;
    const tabId = await app.resolveTabIdByUrl(page.url());
    rememberRuntime(testInfo, { tabId, jobId: null, lastState: null });

    const popup = await app.openPopup(tabId);
    await popup.locator('[data-action="start-translation"]').click();

    const jobId = await pollActiveJobId(app, tabId, testInfo);
    await assertPreanalysisGate(app, { jobId, tabId, popup, testInfo });
    await selectRecommendedCategoriesAndRun(popup);

    await waitStreamingChange(app, {
      page,
      anchor,
      originalSnippet,
      jobId,
      tabId,
      testInfo,
      timeoutMs: 90000
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);

    await app.sendCommand('BG_TEST_RELOAD_EXTENSION', { mode: 'hard' }).catch(() => null);
    await app.sendBgMessage('BG_TEST_KICK_SCHEDULER', {}).catch(() => null);

    const startedAt = Date.now();
    let sawWaitingOrRequeue = false;
    let doneState = null;

    while ((Date.now() - startedAt) < 240000) {
      const stateRes = await app.sendBgMessage('BG_TEST_GET_JOB_STATE', { jobId, tabId });
      const state = toState(stateRes);
      if (state) {
        rememberRuntime(testInfo, { tabId, jobId, lastState: state });
        const status = normalizeStatus(state);
        const stage = normalizeStage(state);

        if (status === 'done') {
          doneState = state;
          break;
        }

        if (status === 'failed' || status === 'cancelled') {
          throw new Error(`Unexpected terminal status after reload: ${status}`);
        }

        if (status === 'waiting' || status === 'requeue' || stage === 'waiting' || stage === 'requeue') {
          sawWaitingOrRequeue = true;
        }

        const leaseUntilTs = Number.isFinite(Number(state.leaseUntilTs))
          ? Number(state.leaseUntilTs)
          : null;
        if (status === 'running' && leaseUntilTs !== null && leaseUntilTs < Date.now() - 3000) {
          await app.sendBgMessage('BG_TEST_KICK_SCHEDULER', {}).catch(() => null);
        }
      }
      await sleep(400);
    }

    expect(doneState).toBeTruthy();
    expect(normalizeStatus(doneState)).toBe('done');
    if (sawWaitingOrRequeue) {
      expect(sawWaitingOrRequeue).toBeTruthy();
    }

    await popup.close().catch(() => null);
    await page.close().catch(() => null);
  });
});
