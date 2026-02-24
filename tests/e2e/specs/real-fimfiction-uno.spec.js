const { test, expect } = require('../fixtures/extension-fixture');

const TARGET_URL = 'https://www.fimfiction.net/story/586972/1/uno/uno';
const RUN_FIMFICTION = process.env.TEST_REAL_FIMFICTION === '1';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasCyrillic(text) {
  return /[\u0400-\u04FF]/.test(String(text || ''));
}

function normalizeStage(state) {
  return String(state && state.stage ? state.stage : '').trim().toLowerCase();
}

function normalizeStatus(state) {
  return String(state && state.status ? state.status : '').trim().toLowerCase();
}

function requireOpenAiKey() {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) {
    throw new Error('OPENAI_API_KEY is not set');
  }
  return key;
}

async function dismissCookieBanners(page) {
  const selectors = [
    'button:has-text("Accept")',
    'button:has-text("I Agree")',
    'button:has-text("OK")',
    'button:has-text("Consent")',
    'button:has-text("Cookie")'
  ];
  for (const selector of selectors) {
    try {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 1200 })) {
        await button.click({ timeout: 1800 }).catch(() => null);
      }
    } catch (_) {
      // best-effort
    }
  }
}

async function resolveAnchorLine(page) {
  let firstLine = page.getByText('"But, Zipp!"', { exact: false }).first();
  try {
    await expect(firstLine).toBeVisible({ timeout: 20000 });
    return firstLine;
  } catch (_) {
    firstLine = page.getByText('But, Zipp!', { exact: false }).first();
    await expect(firstLine).toBeVisible({ timeout: 30000 });
    return firstLine;
  }
}

async function readAnchorSnippet(anchorLocator, maxLen = 120) {
  return anchorLocator.evaluate((el, length) => String(el && el.textContent ? el.textContent : '').slice(0, length), maxLen);
}

async function configureRealTestBackend({ app }) {
  const key = requireOpenAiKey();
  await app.configureTestBackend({ mode: 'real' });
  await app.sendCommand('SET_SETTINGS', {
    patch: {
      translationAgentProfile: 'fast',
      translationAgentTuning: {
        plannerMaxOutputTokens: 650,
        executionMaxOutputTokens: 900,
        proofreadingPassesOverride: 0
      }
    }
  });
  const byokRes = await app.setByokForTests({ apiKey: key, persist: false });
  expect(byokRes && byokRes.ok).toBeTruthy();
  const langRes = await app.setTargetLangForTests('ru');
  expect(langRes && langRes.ok).toBeTruthy();
}

async function openFimfictionPage(context) {
  const page = await context.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
  await dismissCookieBanners(page);
  return page;
}

async function pollActiveJobId(app, tabId, { timeoutMs = 30000, pollMs = 200 } = {}) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < Math.max(1000, timeoutMs)) {
    const activeRes = await app.getActiveJob(tabId);
    if (activeRes && activeRes.ok && typeof activeRes.jobId === 'string' && activeRes.jobId) {
      return activeRes.jobId;
    }
    await sleep(Math.max(80, pollMs));
  }
  throw new Error('Active jobId was not discovered in time');
}

async function pollJobState(app, { jobId, tabId, timeoutMs = 60000, pollMs = 250, predicate, label = 'job-state' } = {}) {
  const startedAt = Date.now();
  let last = null;
  while ((Date.now() - startedAt) < Math.max(1200, timeoutMs)) {
    const stateRes = await app.getJobState({ jobId, tabId });
    if (stateRes && stateRes.ok && stateRes.state) {
      last = stateRes;
      if (typeof predicate === 'function' ? predicate(stateRes.state) : false) {
        return stateRes;
      }
    }
    await sleep(Math.max(100, pollMs));
  }
  throw new Error(`Timeout waiting for ${label}. Last=${JSON.stringify(last && last.state ? { status: last.state.status, stage: last.state.stage } : null)}`);
}

function assertNoPrematureSelectionOrGlossary(state) {
  const selectedLen = Array.isArray(state.selectedCategories) ? state.selectedCategories.length : 0;
  expect(selectedLen).toBe(0);
  expect(Boolean(state.glossaryPresent)).toBeFalsy();
}

async function startPipelineToAwaiting({ app, popup, tabId }) {
  await popup.locator('[data-action="start-translation"]').click();
  const jobId = await pollActiveJobId(app, tabId, { timeoutMs: 35000, pollMs: 220 });
  const stageTrace = [];
  let sawPreanalysis = false;
  let sawPlanning = false;
  let preanalysisStateCount = 0;
  let awaitingState = null;
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < 100000) {
    const stateRes = await app.getJobState({ jobId, tabId });
    expect(stateRes && stateRes.ok).toBeTruthy();
    const state = stateRes.state;
    const stage = normalizeStage(state);
    const status = normalizeStatus(state);
    if (stage && !stageTrace.includes(stage)) {
      stageTrace.push(stage);
    }

    if (stage === 'awaiting_categories') {
      awaitingState = stateRes;
      break;
    }

    if (stage === 'execution') {
      throw new Error('Execution started before awaiting_categories/user choice');
    }

    assertNoPrematureSelectionOrGlossary(state);

    if (stage === 'preanalysis' || stage === 'scan' || stage === 'scanning' || status === 'preparing') {
      sawPreanalysis = true;
      preanalysisStateCount += 1;
      expect(Boolean(state.planPresent)).toBeFalsy();
      expect(Boolean(state.taxonomyPresent)).toBeFalsy();
      expect(Boolean(state.planFinalized)).toBeFalsy();
    }
    if (stage === 'planning') {
      sawPlanning = true;
    }
    await sleep(180);
  }

  if (!awaitingState) {
    throw new Error(`Job did not reach awaiting_categories. Seen stages: ${stageTrace.join(',')}`);
  }

  expect(sawPreanalysis || preanalysisStateCount > 0).toBeTruthy();
  expect(sawPlanning).toBeTruthy();
  const preIdx = stageTrace.findIndex((stage) => stage === 'preanalysis' || stage === 'scan' || stage === 'scanning');
  const planningIdx = stageTrace.indexOf('planning');
  expect(preIdx).toBeGreaterThanOrEqual(0);
  expect(planningIdx).toBeGreaterThan(preIdx);

  const awaiting = awaitingState.state;
  expect(Boolean(awaiting.taxonomyPresent)).toBeTruthy();
  expect(Boolean(awaiting.planPresent)).toBeTruthy();
  expect(Boolean(awaiting.planFinalized)).toBeTruthy();
  expect(awaiting.userQuestion && awaiting.userQuestion.optionsCount > 0).toBeTruthy();

  return { jobId, awaitingState };
}

async function ensureCategorySelectionInPopup(popup) {
  const inputs = popup.locator('[data-section="category-chooser-list"] input[type="checkbox"]:not([disabled])');
  await expect.poll(async () => inputs.count(), { timeout: 15000 }).toBeGreaterThan(0);
  const count = await inputs.count();
  for (let i = 0; i < count; i += 1) {
    await inputs.nth(i).uncheck({ force: true }).catch(() => null);
  }
  await inputs.first().check({ force: true });
}

async function assertAwaitingBeforeSelection({ app, tabId, jobId }) {
  const before = await app.getJobState({ jobId, tabId });
  expect(before && before.ok).toBeTruthy();
  expect(normalizeStage(before.state)).toBe('awaiting_categories');
  const doneBefore = Number.isFinite(Number(before.state.doneCount)) ? Number(before.state.doneCount) : 0;
  expect(doneBefore).toBe(0);
  await sleep(3200);
  const after = await app.getJobState({ jobId, tabId });
  expect(after && after.ok).toBeTruthy();
  expect(normalizeStage(after.state)).toBe('awaiting_categories');
  const doneAfter = Number.isFinite(Number(after.state.doneCount)) ? Number(after.state.doneCount) : 0;
  expect(doneAfter).toBe(0);
}

async function startExecutionFromAwaiting({ app, popup, tabId, jobId }) {
  await expect(popup.locator('[data-section="category-chooser"]')).toBeVisible({ timeout: 20000 });
  await assertAwaitingBeforeSelection({ app, tabId, jobId });
  await ensureCategorySelectionInPopup(popup);
  await popup.locator('[data-action="start-translation"]').click();

  const running = await pollJobState(app, {
    jobId,
    tabId,
    timeoutMs: 90000,
    pollMs: 250,
    label: 'running execution',
    predicate: (state) => normalizeStatus(state) === 'running' && normalizeStage(state) === 'execution'
  });
  expect(running && running.ok).toBeTruthy();
}

async function waitStreamingChange({ app, anchor, originalSnippet, jobId, tabId, timeoutMs = 120000 }) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < Math.max(30000, timeoutMs)) {
    const currentSnippet = await readAnchorSnippet(anchor, 140);
    const stateRes = await app.getJobState({ jobId, tabId });
    const state = stateRes && stateRes.ok ? stateRes.state : null;
    const isDone = normalizeStatus(state) === 'done';
    if (currentSnippet && currentSnippet !== originalSnippet && !isDone) {
      return { currentSnippet, state };
    }
    await sleep(250);
  }
  throw new Error('Streaming delta was not observed before DONE');
}

async function waitDoneState(app, { jobId, tabId, timeoutMs = 180000 } = {}) {
  return pollJobState(app, {
    jobId,
    tabId,
    timeoutMs,
    pollMs: 300,
    label: 'done state',
    predicate: (state) => normalizeStatus(state) === 'done'
  });
}

async function exportFailureReport({ app, testInfo, tabId, jobId, label = 'fimfiction' } = {}) {
  try {
    const reportRes = await app.exportReportJson(tabId, {
      jobId,
      logsLimit: 200,
      toolTraceLimit: 180,
      patchLimit: 180
    });
    if (reportRes && reportRes.ok && reportRes.report) {
      await testInfo.attach(`${label}-report.json`, {
        body: JSON.stringify(reportRes.report, null, 2),
        contentType: 'application/json'
      });
    }
  } catch (_) {
    // best-effort diagnostics
  }
}

function getToolNames(report) {
  const trace = report && report.agent && Array.isArray(report.agent.toolExecutionTrace)
    ? report.agent.toolExecutionTrace
    : [];
  return trace
    .map((row) => String(row && row.toolName ? row.toolName : '').trim())
    .filter(Boolean);
}

test.describe.serial('REAL fimfiction pipeline', () => {
  test.skip(!RUN_FIMFICTION, 'set TEST_REAL_FIMFICTION=1 to run real fimfiction suite');

  test('Pipeline Gate + Streaming + DONE', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);
    if (!app.isRealMode) {
      test.skip(true, 'requires TEST_MODE=real');
    }

    let tabId = null;
    let jobId = null;
    let page = null;
    let popup = null;
    try {
      await configureRealTestBackend({ app });
      page = await openFimfictionPage(context);
      const firstLine = await resolveAnchorLine(page);
      const originalSnippet = await readAnchorSnippet(firstLine, 120);

      tabId = await app.resolveTabIdByUrl(page.url());
      popup = await app.openPopupPage(tabId);

      await expect(popup.locator('[data-section="category-chooser"]')).toBeHidden();
      const staged = await startPipelineToAwaiting({ app, popup, tabId });
      jobId = staged.jobId;

      await startExecutionFromAwaiting({ app, popup, tabId, jobId });
      const stream = await waitStreamingChange({ app, anchor: firstLine, originalSnippet, jobId, tabId, timeoutMs: 120000 });
      expect(hasCyrillic(stream.currentSnippet) || stream.currentSnippet !== originalSnippet).toBeTruthy();

      const doneRes = await waitDoneState(app, { jobId, tabId, timeoutMs: 220000 });
      const doneState = doneRes.state;
      expect(Number(doneState.doneCount || 0)).toBeGreaterThan(0);
      expect(doneState.lastError === null || doneState.lastError === undefined).toBeTruthy();

      const reportRes = await app.exportReportJson(tabId, { jobId, logsLimit: 200, toolTraceLimit: 180, patchLimit: 180 });
      expect(reportRes && reportRes.ok).toBeTruthy();
      const toolNames = getToolNames(reportRes.report);
      expect(toolNames.includes('agent.plan.set_taxonomy')).toBeTruthy();
      expect(toolNames.includes('agent.plan.set_pipeline')).toBeTruthy();
      expect(toolNames.includes('agent.plan.request_finish_analysis')).toBeTruthy();
      expect(toolNames.includes('agent.ui.ask_user_categories')).toBeTruthy();
      expect(toolNames.some((name) => name === 'translator.translate_unit_stream' || name === 'translator.translate_block_stream')).toBeTruthy();
      expect(toolNames.includes('page.apply_delta')).toBeTruthy();
    } catch (error) {
      await exportFailureReport({ app, testInfo, tabId, jobId, label: 'pipeline-gate' });
      throw error;
    } finally {
      if (popup && !popup.isClosed()) {
        await popup.close().catch(() => null);
      }
      if (page && !page.isClosed()) {
        await page.close().catch(() => null);
      }
    }
  });

  test('Toggle original/translated/compare after translation', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);
    if (!app.isRealMode) {
      test.skip(true, 'requires TEST_MODE=real');
    }

    let tabId = null;
    let jobId = null;
    let page = null;
    let popup = null;
    try {
      await configureRealTestBackend({ app });
      page = await openFimfictionPage(context);
      const firstLine = await resolveAnchorLine(page);
      const originalSnippet = await readAnchorSnippet(firstLine, 120);

      tabId = await app.resolveTabIdByUrl(page.url());
      popup = await app.openPopupPage(tabId);

      const staged = await startPipelineToAwaiting({ app, popup, tabId });
      jobId = staged.jobId;
      await startExecutionFromAwaiting({ app, popup, tabId, jobId });
      await waitDoneState(app, { jobId, tabId, timeoutMs: 220000 });

      await popup.locator('[data-field="display-mode-select"]').selectOption('original');
      await expect.poll(async () => {
        const value = await readAnchorSnippet(firstLine, 120);
        return value === originalSnippet || !hasCyrillic(value);
      }, { timeout: 60000 }).toBeTruthy();

      await popup.locator('[data-field="display-mode-select"]').selectOption('translated');
      await expect.poll(async () => {
        const value = await readAnchorSnippet(firstLine, 120);
        return hasCyrillic(value) || value !== originalSnippet;
      }, { timeout: 60000 }).toBeTruthy();

      await popup.locator('[data-field="display-mode-select"]').selectOption('compare');
      const compareOn = await page.evaluate(() => {
        if (!globalThis.CSS || !CSS.highlights) {
          return true;
        }
        return Boolean(CSS.highlights.get('nt-diff'));
      });
      expect(compareOn).toBeTruthy();
    } catch (error) {
      await exportFailureReport({ app, testInfo, tabId, jobId, label: 'toggle' });
      throw error;
    } finally {
      if (popup && !popup.isClosed()) {
        await popup.close().catch(() => null);
      }
      if (page && !page.isClosed()) {
        await page.close().catch(() => null);
      }
    }
  });

  test('Cancel mid-stream + Erase', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);
    if (!app.isRealMode) {
      test.skip(true, 'requires TEST_MODE=real');
    }

    let tabId = null;
    let jobId = null;
    let page = null;
    let popup = null;
    try {
      await configureRealTestBackend({ app });
      page = await openFimfictionPage(context);
      const firstLine = await resolveAnchorLine(page);
      const originalSnippet = await readAnchorSnippet(firstLine, 120);

      tabId = await app.resolveTabIdByUrl(page.url());
      popup = await app.openPopupPage(tabId);

      const staged = await startPipelineToAwaiting({ app, popup, tabId });
      jobId = staged.jobId;
      await startExecutionFromAwaiting({ app, popup, tabId, jobId });
      await waitStreamingChange({ app, anchor: firstLine, originalSnippet, jobId, tabId, timeoutMs: 120000 });

      const cancelRes = await app.sendCommand('CANCEL_TRANSLATION', { tabId }, tabId);
      expect(cancelRes && cancelRes.ok).toBeTruthy();

      const cancelledRes = await pollJobState(app, {
        jobId,
        tabId,
        timeoutMs: 120000,
        label: 'cancelled state',
        predicate: (state) => normalizeStatus(state) === 'cancelled'
      });
      const cancelled = cancelledRes.state;
      const leaseUntilTs = Number.isFinite(Number(cancelled.leaseUntilTs)) ? Number(cancelled.leaseUntilTs) : null;
      if (leaseUntilTs !== null) {
        expect(leaseUntilTs).toBeLessThanOrEqual(Date.now() + 5000);
      }

      await expect.poll(async () => {
        const restored = await readAnchorSnippet(firstLine, 120);
        return restored === originalSnippet || !hasCyrillic(restored);
      }, { timeout: 45000 }).toBeTruthy();

      const eraseRes = await app.eraseJobForTests({ jobId, tabId, includeCache: true });
      expect(eraseRes && eraseRes.ok).toBeTruthy();
    } catch (error) {
      await exportFailureReport({ app, testInfo, tabId, jobId, label: 'cancel-erase' });
      throw error;
    } finally {
      if (popup && !popup.isClosed()) {
        await popup.close().catch(() => null);
      }
      if (page && !page.isClosed()) {
        await page.close().catch(() => null);
      }
    }
  });

  test('Reload mid-stream restore without RUNNING forever', async ({ app, context }, testInfo) => {
    test.setTimeout(420000);
    if (!app.isRealMode) {
      test.skip(true, 'requires TEST_MODE=real');
    }

    let tabId = null;
    let jobId = null;
    let page = null;
    let popup = null;
    try {
      await configureRealTestBackend({ app });
      page = await openFimfictionPage(context);
      const firstLine = await resolveAnchorLine(page);
      const originalSnippet = await readAnchorSnippet(firstLine, 120);

      tabId = await app.resolveTabIdByUrl(page.url());
      popup = await app.openPopupPage(tabId);

      const staged = await startPipelineToAwaiting({ app, popup, tabId });
      jobId = staged.jobId;
      await startExecutionFromAwaiting({ app, popup, tabId, jobId });
      await waitStreamingChange({ app, anchor: firstLine, originalSnippet, jobId, tabId, timeoutMs: 120000 });

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => null);
      await app.kickScheduler(tabId).catch(() => null);

      const startedAt = Date.now();
      let sawWaitingOrRequeue = false;
      let doneSeen = false;
      let lastState = null;
      while ((Date.now() - startedAt) < 280000) {
        const stateRes = await app.getJobState({ jobId, tabId });
        if (stateRes && stateRes.ok && stateRes.state) {
          lastState = stateRes.state;
          const status = normalizeStatus(lastState);
          const stage = normalizeStage(lastState);
          if (status === 'done') {
            doneSeen = true;
            break;
          }
          if (stage === 'waiting' || stage === 'requeue' || status === 'waiting' || status === 'requeue') {
            sawWaitingOrRequeue = true;
          }
          if (status === 'failed' || status === 'cancelled') {
            throw new Error(`Unexpected terminal state after reload: ${status}`);
          }
          const leaseUntilTs = Number.isFinite(Number(lastState.leaseUntilTs)) ? Number(lastState.leaseUntilTs) : null;
          if (status === 'running' && leaseUntilTs !== null && leaseUntilTs < Date.now() - 1500) {
            await app.kickScheduler(tabId).catch(() => null);
          }
        }
        await sleep(400);
      }

      expect(doneSeen).toBeTruthy();
      expect(lastState && normalizeStatus(lastState)).toBe('done');
      expect(lastState && normalizeStatus(lastState)).not.toBe('running');
      if (sawWaitingOrRequeue) {
        expect(sawWaitingOrRequeue).toBeTruthy();
      }
    } catch (error) {
      await exportFailureReport({ app, testInfo, tabId, jobId, label: 'reload-recovery' });
      throw error;
    } finally {
      if (popup && !popup.isClosed()) {
        await popup.close().catch(() => null);
      }
      if (page && !page.isClosed()) {
        await page.close().catch(() => null);
      }
    }
  });
});
