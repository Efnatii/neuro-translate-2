const { test, expect } = require('../fixtures/extension-fixture');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getChecklistStatus(checklist, id) {
  const rows = Array.isArray(checklist) ? checklist : [];
  const hit = rows.find((row) => row && row.id === id);
  return hit && typeof hit.status === 'string' ? hit.status : null;
}

function hasTranslatedBlocks(state) {
  const blocks = state && state.job && state.job.blocksById && typeof state.job.blocksById === 'object'
    ? Object.values(state.job.blocksById)
    : [];
  return blocks.some((row) => row && typeof row.translatedText === 'string' && row.translatedText.trim());
}

function getAgentCategoryOptions(job) {
  const safeJob = job && typeof job === 'object' ? job : {};
  const fromJob = safeJob.categoryQuestion && typeof safeJob.categoryQuestion === 'object'
    ? safeJob.categoryQuestion
    : null;
  if (fromJob && Array.isArray(fromJob.options)) {
    return fromJob.options;
  }
  const agent = safeJob.agentState && typeof safeJob.agentState === 'object'
    ? safeJob.agentState
    : {};
  const fromAgent = agent.userQuestion && typeof agent.userQuestion === 'object'
    ? agent.userQuestion
    : null;
  return fromAgent && Array.isArray(fromAgent.options) ? fromAgent.options : [];
}

function getRecommendedCategories(job) {
  const safeJob = job && typeof job === 'object' ? job : {};
  const rec = safeJob.categoryRecommendations && typeof safeJob.categoryRecommendations === 'object'
    ? safeJob.categoryRecommendations
    : (safeJob.agentState && safeJob.agentState.categoryRecommendations && typeof safeJob.agentState.categoryRecommendations === 'object'
      ? safeJob.agentState.categoryRecommendations
      : null);
  if (!rec || !Array.isArray(rec.recommended)) {
    return [];
  }
  return rec.recommended
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function pickCategoriesFromState(state, { maxCategories = 6 } = {}) {
  const job = state && state.job && typeof state.job === 'object' ? state.job : {};
  const options = getAgentCategoryOptions(job);
  const available = Array.isArray(job.availableCategories) ? job.availableCategories : [];
  const byId = new Set(options.map((row) => String(row && row.id ? row.id : '').trim().toLowerCase()).filter(Boolean));
  const all = [];
  options.forEach((row) => {
    const id = String(row && row.id ? row.id : '').trim().toLowerCase();
    if (id && !all.includes(id)) {
      all.push(id);
    }
  });
  available.forEach((idRaw) => {
    const id = String(idRaw || '').trim().toLowerCase();
    if (id && !all.includes(id)) {
      all.push(id);
    }
  });

  const recommended = getRecommendedCategories(job).filter((id) => all.includes(id));
  const merged = recommended.concat(all.filter((id) => !recommended.includes(id)));
  const picked = (merged.length ? merged : all).slice(0, Math.max(1, Number(maxCategories) || 1));
  if (!picked.length && byId.size) {
    return Array.from(byId).slice(0, 1);
  }
  return picked;
}

async function startToAwaitingCategories(app, tabId, { timeoutMs = 70000, usePopup = null } = {}) {
  if (usePopup) {
    await usePopup.locator('[data-action="start-translation"]').click();
  } else {
    const startRes = await app.sendCommand('START_TRANSLATION', { tabId }, tabId);
    expect(startRes && startRes.ok).toBeTruthy();
  }
  return app.waitForState(
    tabId,
    (state) => state && state.jobStatus === 'awaiting_categories',
    { timeoutMs, label: 'awaiting_categories' }
  );
}

async function selectCategoriesAndRun(app, tabId, awaitingState, { mode = 'replace', maxCategories = 6 } = {}) {
  const categories = pickCategoriesFromState(awaitingState, { maxCategories });
  expect(categories.length).toBeGreaterThan(0);
  const selectRes = await app.sendCommand('SET_TRANSLATION_CATEGORIES', {
    tabId,
    jobId: awaitingState && awaitingState.jobId ? awaitingState.jobId : null,
    categories,
    mode
  }, tabId);
  expect(selectRes && selectRes.ok).toBeTruthy();
  return categories;
}

async function beginTranslationFlow(app, tabId, options = {}) {
  const awaiting = await startToAwaitingCategories(app, tabId, {
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 70000,
    usePopup: options.popup || null
  });
  await selectCategoriesAndRun(app, tabId, awaiting, {
    mode: options.mode || 'replace',
    maxCategories: Number.isFinite(Number(options.maxCategories)) ? Number(options.maxCategories) : 6
  });
  return app.waitForState(
    tabId,
    (state) => state && state.jobStatus === 'running',
    { timeoutMs: 70000, label: 'running' }
  );
}

async function waitForStreamingDomChange(app, site, tabId, selector, originalText, { timeoutMs = 90000, pollMs = 200 } = {}) {
  const startedAt = Date.now();
  while ((Date.now() - startedAt) < Math.max(5000, timeoutMs)) {
    const currentText = ((await site.textContent(selector)) || '').trim();
    const state = await app.readTabState(tabId);
    if (currentText && currentText !== String(originalText || '').trim() && state && state.jobStatus !== 'done') {
      return { currentText, state };
    }
    await sleep(Math.max(80, pollMs));
  }
  throw new Error(`streaming DOM change not detected in time for selector=${selector}`);
}

async function waitForTerminal(app, tabId, timeoutMs = 120000) {
  return app.waitForState(
    tabId,
    (state) => {
      const status = state && typeof state.jobStatus === 'string' ? state.jobStatus : '';
      return status === 'done' || status === 'failed' || status === 'cancelled';
    },
    { timeoutMs, label: 'terminal' }
  );
}

async function waitForMockQuiescence(app, { timeoutMs = 12000, stableMs = 1400, pollMs = 200 } = {}) {
  if (!app || !app.mockServer || !app.isMockMode) {
    return 0;
  }
  const startedAt = Date.now();
  let lastCount = Number(app.mockServer.getStats().responsesRequests || 0);
  let stableSince = Date.now();
  while ((Date.now() - startedAt) < Math.max(1000, timeoutMs)) {
    await sleep(Math.max(80, pollMs));
    const nextCount = Number(app.mockServer.getStats().responsesRequests || 0);
    if (nextCount !== lastCount) {
      lastCount = nextCount;
      stableSince = Date.now();
      continue;
    }
    if ((Date.now() - stableSince) >= Math.max(300, stableMs)) {
      return lastCount;
    }
  }
  throw new Error(`mock server did not become quiescent in ${timeoutMs}ms`);
}

test.describe('MV3 translation e2e', () => {
  test('C1: scan-only preanalysis -> planning -> awaiting_categories -> execution', async ({ app }) => {
    test.setTimeout(220000);
    await app.configureTestBackend();

    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());
    const popup = await app.openPopupPage(tabId);
    const originalIntro = ((await site.textContent('#simple-intro')) || '').trim();

    await expect(popup.locator('[data-section="category-chooser"]')).toBeHidden();

    await popup.locator('[data-action="start-translation"]').click();

    const planningOrAwaiting = await app.waitForState(
      tabId,
      (state) => state && (state.jobStatus === 'planning' || state.jobStatus === 'awaiting_categories' || state.jobStatus === 'preparing'),
      { timeoutMs: 70000, label: 'planning_or_awaiting' }
    );

    const activeDuringPlanning = await app.getActiveJobState(tabId);
    expect(activeDuringPlanning && activeDuringPlanning.ok).toBeTruthy();
    const planningJob = activeDuringPlanning && activeDuringPlanning.job && typeof activeDuringPlanning.job === 'object'
      ? activeDuringPlanning.job
      : {};
    const planningAgent = planningJob.agentState && typeof planningJob.agentState === 'object'
      ? planningJob.agentState
      : {};

    expect(Array.isArray(planningJob.selectedCategories) ? planningJob.selectedCategories.length : 0).toBe(0);
    expect(Array.isArray(planningAgent.glossary) ? planningAgent.glossary.length : 0).toBe(0);

    if (planningOrAwaiting && planningOrAwaiting.jobStatus !== 'awaiting_categories') {
      await expect(popup.locator('[data-section="category-chooser"]')).toBeHidden();
      expect(hasTranslatedBlocks(planningOrAwaiting)).toBeFalsy();
      if (planningOrAwaiting.jobStatus === 'preparing') {
        expect(planningAgent.pipeline === null || planningAgent.pipeline === undefined).toBeTruthy();
      }
    }

    const awaiting = planningOrAwaiting && planningOrAwaiting.jobStatus === 'awaiting_categories'
      ? planningOrAwaiting
      : await app.waitForState(
        tabId,
        (state) => state && state.jobStatus === 'awaiting_categories',
        { timeoutMs: 70000, label: 'awaiting_categories' }
      );

    await expect(popup.locator('[data-section="category-chooser"]')).toBeVisible();
    await expect.poll(async () => {
      return popup.locator('[data-section="category-chooser-list"] input[type="checkbox"]').count();
    }, { timeout: 15000 }).toBeGreaterThan(0);

    const awaitingSnapshot = await app.getActiveJobState(tabId);
    expect(awaitingSnapshot && awaitingSnapshot.ok).toBeTruthy();
    const awaitingJob = awaitingSnapshot && awaitingSnapshot.job && typeof awaitingSnapshot.job === 'object'
      ? awaitingSnapshot.job
      : {};
    const options = getAgentCategoryOptions(awaitingJob);
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((row) => row && typeof row.titleRu === 'string' && row.titleRu.trim())).toBeTruthy();
    expect(options.some((row) => row && Number.isFinite(Number(row.countUnits)))).toBeTruthy();

    const traceAtAwaiting = awaitingJob && awaitingJob.agentState && Array.isArray(awaitingJob.agentState.toolExecutionTrace)
      ? awaitingJob.agentState.toolExecutionTrace
      : [];
    expect(traceAtAwaiting.some((row) => row && row.toolName === 'agent.ui.ask_user_categories')).toBeTruthy();

    await popup.locator('[data-action="start-translation"]').click();
    let running = null;
    try {
      running = await app.waitForState(
        tabId,
        (state) => state && state.jobStatus === 'running',
        { timeoutMs: 12000, label: 'running after popup click' }
      );
    } catch (_) {
      await selectCategoriesAndRun(app, tabId, awaiting, { mode: 'replace', maxCategories: 6 });
      running = await app.waitForState(
        tabId,
        (state) => state && state.jobStatus === 'running',
        { timeoutMs: 70000, label: 'running after explicit category select' }
      );
    }
    expect(running && running.jobStatus).toBe('running');

    await waitForStreamingDomChange(app, site, tabId, '#simple-intro', originalIntro, {
      timeoutMs: 90000,
      pollMs: 180
    });

    const done = await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'done',
      { timeoutMs: 140000, label: 'done' }
    );
    expect(done && done.jobStatus).toBe('done');

    const currentIntro = ((await site.textContent('#simple-intro')) || '').trim();
    expect(currentIntro).not.toBe(originalIntro);

    const reportRes = await app.exportReportJson(tabId, {
      logsLimit: 200,
      toolTraceLimit: 200,
      patchLimit: 120
    });
    expect(reportRes && reportRes.ok).toBeTruthy();

    const report = reportRes && reportRes.report && typeof reportRes.report === 'object'
      ? reportRes.report
      : {};
    const toolTrace = report && report.agent && Array.isArray(report.agent.toolExecutionTrace)
      ? report.agent.toolExecutionTrace
      : [];
    const checklist = report && report.agent && Array.isArray(report.agent.checklist)
      ? report.agent.checklist
      : [];
    const patchHistory = report && report.agent && Array.isArray(report.agent.patchHistory)
      ? report.agent.patchHistory
      : [];

    expect(toolTrace.some((row) => row && row.toolName === 'page.get_preanalysis')).toBeTruthy();
    expect(toolTrace.some((row) => row && row.toolName === 'agent.plan.set_taxonomy')).toBeTruthy();
    expect(toolTrace.some((row) => row && row.toolName === 'agent.plan.set_pipeline')).toBeTruthy();
    expect(toolTrace.some((row) => row && row.toolName === 'agent.plan.request_finish_analysis')).toBeTruthy();
    expect(toolTrace.some((row) => row && row.toolName === 'agent.ui.ask_user_categories')).toBeTruthy();
    expect(
      toolTrace.some((row) => row && (row.toolName === 'translator.translate_unit_stream' || row.toolName === 'translator.translate_block_stream'))
    ).toBeTruthy();
    expect(toolTrace.some((row) => row && row.toolName === 'page.apply_delta')).toBeTruthy();
    expect(toolTrace.some((row) => row && row.toolName === 'job.mark_block_done')).toBeTruthy();

    expect(getChecklistStatus(checklist, 'scanned')).toBe('done');
    expect(getChecklistStatus(checklist, 'analyze_page')).toBe('done');
    expect(getChecklistStatus(checklist, 'plan_pipeline')).toBe('done');
    expect(['done', 'running']).toContain(getChecklistStatus(checklist, 'categories_selected'));
    expect(patchHistory.length).toBeGreaterThan(0);

    await popup.close();
    await site.close();
  });

  test('C2: execution does not start before category selection', async ({ app }) => {
    test.skip(app.isRealMode, 'C2 strict gating check is mock-only');
    test.setTimeout(150000);

    await app.configureTestBackend();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const awaiting = await startToAwaitingCategories(app, tabId, { timeoutMs: 70000 });
    expect(awaiting && awaiting.jobStatus).toBe('awaiting_categories');

    await sleep(3500);
    await app.kickScheduler(tabId).catch(() => null);
    await sleep(1200);

    const stillAwaiting = await app.readTabState(tabId);
    expect(stillAwaiting && stillAwaiting.jobStatus).toBe('awaiting_categories');
    expect(hasTranslatedBlocks(stillAwaiting)).toBeFalsy();

    const reportRes = await app.exportReportJson(tabId, { toolTraceLimit: 120, patchLimit: 60 });
    expect(reportRes && reportRes.ok).toBeTruthy();
    const toolTrace = reportRes && reportRes.report && reportRes.report.agent && Array.isArray(reportRes.report.agent.toolExecutionTrace)
      ? reportRes.report.agent.toolExecutionTrace
      : [];
    expect(toolTrace.some((row) => row && row.toolName === 'page.apply_delta')).toBeFalsy();

    await site.close();
  });

  test('C3: cancel mid-stream stops job without RUNNING forever', async ({ app }) => {
    test.setTimeout(220000);
    await app.configureTestBackend();

    const size = app.isRealMode ? 320 : 1500;
    const site = await app.openSite(`/big.html?size=${size}`);
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId, {
      timeoutMs: 90000,
      maxCategories: app.isRealMode ? 2 : 6
    });

    await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'running' && hasTranslatedBlocks(state),
      { timeoutMs: 120000, label: 'running with first translated block' }
    );

    const cancelRes = await app.sendCommand('CANCEL_TRANSLATION', { tabId }, tabId);
    expect(cancelRes && cancelRes.ok).toBeTruthy();

    const cancelled = await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'cancelled',
      { timeoutMs: 60000, label: 'cancelled' }
    );
    const runtime = cancelled && cancelled.job && cancelled.job.runtime && typeof cancelled.job.runtime === 'object'
      ? cancelled.job.runtime
      : {};
    const runtimeStatus = String(runtime.status || '').toUpperCase();
    expect(runtimeStatus).not.toBe('RUNNING');
    const leaseUntil = runtime && runtime.lease && Number.isFinite(Number(runtime.lease.leaseUntilTs))
      ? Number(runtime.lease.leaseUntilTs)
      : null;
    if (leaseUntil !== null) {
      expect(leaseUntil).toBeLessThanOrEqual(Date.now() + 5000);
    }

    await sleep(2500);
    const after = await app.readTabState(tabId);
    expect(after && after.jobStatus).toBe('cancelled');

    await site.close();
  });

  test('C3b: big scan keeps page event loop responsive', async ({ app }) => {
    test.skip(app.isRealMode, 'heavy scan stress is mock-only');
    test.setTimeout(180000);

    await app.configureTestBackend();
    const site = await app.openSite('/big.html?size=7000');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const settingsRes = await app.sendCommand('SET_SETTINGS', {
      patch: {
        translationPerfMaxTextNodesPerScan: 2500,
        translationPerfYieldEveryNNodes: 100,
        translationPerfAbortScanIfOverMs: 0,
        translationPerfDegradedScanOnHeavy: true
      }
    }, tabId);
    expect(settingsRes && settingsRes.ok).toBeTruthy();

    const startPromise = app.sendCommand('START_TRANSLATION', { tabId }, tabId);
    await sleep(180);
    const probeStartedAt = Date.now();
    const probe = await site.evaluate(async () => {
      const startTick = Number(window.__ntUiTick || 0);
      await new Promise((resolve) => setTimeout(resolve, 700));
      const endTick = Number(window.__ntUiTick || 0);
      return { startTick, endTick };
    });
    const probeElapsedMs = Date.now() - probeStartedAt;

    const startRes = await startPromise;
    expect(startRes && startRes.ok).toBeTruthy();
    expect((probe.endTick - probe.startTick)).toBeGreaterThan(1);
    expect(probeElapsedMs).toBeLessThan(2500);

    await app.waitForState(
      tabId,
      (state) => state && (state.jobStatus === 'awaiting_categories' || state.jobStatus === 'running'),
      { timeoutMs: 80000, label: 'post-scan stage' }
    );

    await site.close();
  });

  test('C4: toggle original/translated/compare during run', async ({ app }) => {
    test.skip(app.isRealMode, 'toggle assertions run in mock suite to reduce real API spend');
    test.setTimeout(180000);

    await app.configureTestBackend();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());
    const original = (await site.textContent('#simple-intro')) || '';

    await beginTranslationFlow(app, tabId, { timeoutMs: 80000, maxCategories: 5 });

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'original', visible: false }, tabId);
    await expect.poll(async () => (await site.textContent('#simple-intro')) || '', { timeout: 20000 }).toContain('This paragraph');

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'translated', visible: true }, tabId);
    await expect.poll(async () => (await site.textContent('#simple-intro')) || '', { timeout: 45000 }).not.toBe(original);

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'compare', visible: true }, tabId);
    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', { timeoutMs: 130000, label: 'done after compare' });

    const highlightsSupported = await site.evaluate(() => Boolean(globalThis.CSS && CSS.highlights && typeof globalThis.Highlight === 'function'));
    if (highlightsSupported) {
      await expect.poll(async () => await site.locator('mark.nt-diff-ins').count(), { timeout: 20000 }).toBe(0);
      await expect.poll(async () => {
        return site.evaluate(() => {
          const highlight = globalThis.CSS && CSS.highlights ? CSS.highlights.get('nt-diff') : null;
          if (!highlight) {
            return 0;
          }
          let count = 0;
          if (typeof highlight.forEach === 'function') {
            highlight.forEach(() => { count += 1; });
            return count;
          }
          if (typeof highlight[Symbol.iterator] === 'function') {
            for (const _item of highlight) {
              count += 1;
            }
            return count;
          }
          if (Number.isFinite(Number(highlight.size))) {
            return Number(highlight.size);
          }
          return count;
        });
      }, { timeout: 20000 }).toBeGreaterThan(0);
    } else {
      await expect.poll(async () => await site.locator('mark.nt-diff-ins').count(), { timeout: 20000 }).toBeGreaterThan(0);
    }

    await site.close();
  });

  test('C5: reload mid-run restore does not get stuck in RUNNING', async ({ app }) => {
    test.setTimeout(220000);
    await app.configureTestBackend();

    const site = await app.openSite('/dynamic.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId, { timeoutMs: 90000, maxCategories: 4 });
    await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'running' && hasTranslatedBlocks(state),
      { timeoutMs: 120000, label: 'running before reload' }
    );

    await site.reload({ waitUntil: 'domcontentloaded' });
    await app.kickScheduler(tabId).catch(() => null);

    const terminal = await waitForTerminal(app, tabId, 150000);
    expect(['done', 'failed', 'cancelled']).toContain(terminal.jobStatus);

    const reportRes = await app.exportReportJson(tabId, { logsLimit: 200, toolTraceLimit: 120, patchLimit: 120 });
    expect(reportRes && reportRes.ok).toBeTruthy();

    await site.close();
  });

  test('C6: extension soft reload recovers without permanent RUNNING', async ({ app }) => {
    test.skip(app.isRealMode, 'extension reload scenario is validated in mock suite');
    test.setTimeout(220000);

    await app.configureTestBackend();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId, { timeoutMs: 80000, maxCategories: 2 });
    await app.waitForState(tabId, (state) => state && state.jobStatus === 'running', { timeoutMs: 70000, label: 'running' });

    const reloadRes = await app.softReloadExtension();
    expect(reloadRes && reloadRes.ok).toBeTruthy();

    const terminal = await waitForTerminal(app, tabId, 130000);
    expect(['done', 'failed', 'cancelled']).toContain(terminal.jobStatus);

    await site.close();
  });

  test('C7: memory restore on second open', async ({ app }) => {
    test.setTimeout(220000);
    await app.configureTestBackend();

    const first = await app.openSite('/simple.html');
    const firstTabId = await app.resolveTabIdByUrl(first.url());

    await beginTranslationFlow(app, firstTabId, { timeoutMs: 80000, maxCategories: 4 });
    await app.waitForState(firstTabId, (state) => state && state.jobStatus === 'done', { timeoutMs: 130000, label: 'first done' });

    const clearFirst = await app.sendCommand('CLEAR_TRANSLATION_DATA', {
      tabId: firstTabId,
      includeCache: false
    }, firstTabId);
    expect(clearFirst && clearFirst.ok).toBeTruthy();

    if (app.isMockMode) {
      await waitForMockQuiescence(app, { timeoutMs: 12000, stableMs: 1300 });
      app.mockServer.resetStats();
    }

    await first.close();

    const second = await app.openSite('/simple.html');
    const secondTabId = await app.resolveTabIdByUrl(second.url());
    const secondStart = await app.sendCommand('START_TRANSLATION', { tabId: secondTabId }, secondTabId);
    expect(secondStart && secondStart.ok).toBeTruthy();

    const secondState = await app.waitForState(
      secondTabId,
      (state) => state && (state.jobStatus === 'awaiting_categories' || state.jobStatus === 'done'),
      { timeoutMs: 70000, label: 'memory restore stage' }
    );
    expect(secondState && (secondState.jobStatus === 'awaiting_categories' || secondState.jobStatus === 'done')).toBeTruthy();

    if (app.isMockMode) {
      await waitForMockQuiescence(app, { timeoutMs: 10000, stableMs: 1000, pollMs: 150 });
      expect(Number(app.mockServer.getStats().responsesRequests || 0)).toBe(0);
    } else {
      const snapshot = await app.getActiveJobState(secondTabId);
      expect(snapshot && snapshot.ok).toBeTruthy();
      const memoryRestore = snapshot && snapshot.job && snapshot.job.memoryRestore && typeof snapshot.job.memoryRestore === 'object'
        ? snapshot.job.memoryRestore
        : null;
      expect(Boolean(memoryRestore)).toBeTruthy();
    }

    await second.close();
  });

  test('C8: multi-tab fairness (no starvation)', async ({ app }) => {
    test.skip(app.isRealMode, 'multi-tab fairness is validated in mock suite');
    test.setTimeout(260000);
    await app.configureTestBackend();

    const siteA = await app.openSite('/big.html?size=900');
    const siteB = await app.openSite('/glossary.html');
    const tabA = await app.resolveTabIdByUrl(siteA.url());
    const tabB = await app.resolveTabIdByUrl(siteB.url());

    await beginTranslationFlow(app, tabA, { timeoutMs: 100000, maxCategories: 3 });
    await beginTranslationFlow(app, tabB, { timeoutMs: 100000, maxCategories: 3 });

    let maxDoneA = 0;
    let maxDoneB = 0;
    let lastAdvanceA = Date.now();
    let lastAdvanceB = Date.now();
    let starvationDetected = false;
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < 80000) {
      const [stateA, stateB] = await Promise.all([
        app.readTabState(tabA),
        app.readTabState(tabB)
      ]);
      const doneA = Number(stateA && stateA.job && stateA.job.completedBlocks || 0);
      const doneB = Number(stateB && stateB.job && stateB.job.completedBlocks || 0);

      if (doneA > maxDoneA) {
        maxDoneA = doneA;
        lastAdvanceA = Date.now();
      }
      if (doneB > maxDoneB) {
        maxDoneB = doneB;
        lastAdvanceB = Date.now();
      }

      const bothRunning = stateA && stateB && stateA.jobStatus === 'running' && stateB.jobStatus === 'running';
      if (bothRunning) {
        if ((Date.now() - lastAdvanceA) > 30000 || (Date.now() - lastAdvanceB) > 30000) {
          starvationDetected = true;
          break;
        }
      }
      if (maxDoneA > 0 && maxDoneB > 0) {
        break;
      }
      await sleep(700);
    }

    expect(maxDoneA).toBeGreaterThan(0);
    expect(maxDoneB).toBeGreaterThan(0);
    expect(starvationDetected).toBeFalsy();

    await app.sendCommand('CANCEL_TRANSLATION', { tabId: tabA }, tabA).catch(() => null);
    await app.sendCommand('CANCEL_TRANSLATION', { tabId: tabB }, tabB).catch(() => null);

    await siteA.close();
    await siteB.close();
  });

  test('C9: rate-limit 429 backoff requeues and resumes', async ({ app }) => {
    test.skip(app.isRealMode, '429 fault injection test is mock-only');
    test.setTimeout(220000);

    await app.configureTestBackend();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const awaiting = await startToAwaitingCategories(app, tabId, { timeoutMs: 80000 });
    await app.setMockFaultInjection({
      status429Count: 2,
      retryAfterMs: 900
    });

    await selectCategoriesAndRun(app, tabId, awaiting, { mode: 'replace', maxCategories: 4 });

    const waitingState = await app.waitForState(
      tabId,
      (state) => {
        const runtime = state && state.job && state.job.runtime && typeof state.job.runtime === 'object'
          ? state.job.runtime
          : null;
        const nextRetry = runtime && runtime.retry && Number.isFinite(Number(runtime.retry.nextRetryAtTs))
          ? Number(runtime.retry.nextRetryAtTs)
          : 0;
        return Boolean(nextRetry && nextRetry > Date.now());
      },
      { timeoutMs: 90000, label: 'backoff nextRetryAtTs' }
    );
    expect(waitingState && waitingState.job).toBeTruthy();

    const done = await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'done',
      { timeoutMs: 140000, label: 'done after 429 backoff' }
    );
    expect(done && done.jobStatus).toBe('done');

    const stats = app.mockServer.getStats();
    expect(Number(stats.status429 || 0)).toBeGreaterThanOrEqual(2);

    await site.close();
  });
});

