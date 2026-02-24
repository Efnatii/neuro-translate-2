const { test, expect } = require('../fixtures/extension-fixture');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMockQuiescence(app, { timeoutMs = 12000, stableMs = 1500, pollMs = 200 } = {}) {
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
    if ((Date.now() - stableSince) >= Math.max(400, stableMs)) {
      return lastCount;
    }
  }
  throw new Error(`mock server did not become quiescent in time, lastCount=${lastCount}`);
}

async function beginTranslationFlow(app, tabId, { attempts = 2, categoryLimit = 5 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startRes = await app.sendCommand('START_TRANSLATION', { tabId }, tabId);
    if (!startRes || startRes.ok !== true) {
      lastError = new Error(`START_TRANSLATION failed: ${JSON.stringify(startRes || null)}`);
      if (attempt >= attempts) {
        throw lastError;
      }
      await sleep(500 * attempt);
      continue;
    }
    try {
      const awaiting = await app.waitForState(
        tabId,
        (state) => state && state.jobStatus === 'awaiting_categories',
        { timeoutMs: 50000, label: 'awaiting_categories' }
      );
      const available = awaiting && awaiting.job && Array.isArray(awaiting.job.availableCategories)
        ? awaiting.job.availableCategories
        : [];
      const recommended = awaiting && awaiting.job && Array.isArray(awaiting.job.selectedCategories)
        ? awaiting.job.selectedCategories
        : [];
      const maxCategories = Math.max(1, Math.round(Number(categoryLimit) || 1));
      const categories = (recommended.length ? recommended : available).slice(0, maxCategories);
      expect(categories.length).toBeGreaterThan(0);
      const selectRes = await app.sendCommand('SET_TRANSLATION_CATEGORIES', {
        tabId,
        jobId: awaiting.jobId || null,
        categories
      }, tabId);
      expect(selectRes && selectRes.ok).toBeTruthy();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        throw error;
      }
      await app.sendCommand('CANCEL_TRANSLATION', { tabId }, tabId).catch(() => null);
      await app.sendCommand('KICK_SCHEDULER', {}, tabId).catch(() => null);
      await sleep(600 * attempt);
    }
  }
  throw lastError || new Error('beginTranslationFlow failed');
}

async function waitRunning(app, tabId) {
  return app.waitForState(
    tabId,
    (state) => state && state.jobStatus === 'running',
    { timeoutMs: 50000, label: 'running' }
  );
}

async function waitTerminal(app, tabId, timeoutMs = 95000) {
  return app.waitForState(
    tabId,
    (state) => {
      const status = state && typeof state.jobStatus === 'string' ? state.jobStatus : '';
      return status === 'done' || status === 'failed' || status === 'cancelled';
    },
    { timeoutMs, label: 'terminal' }
  );
}

test.describe('MV3 translation e2e', () => {
  test('C1: happy path streaming -> DONE', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureMockProxy();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());
    const popup = await app.openPopupPage(tabId);
    const original = (await site.textContent('#simple-intro')) || '';

    await beginTranslationFlow(app, tabId);
    await waitRunning(app, tabId);

    await app.waitForState(
      tabId,
      (state) => {
        const job = state && state.job;
        if (!job || !job.blocksById) return false;
        return Object.values(job.blocksById).some((row) => row && typeof row.translatedText === 'string' && row.translatedText.trim());
      },
      { timeoutMs: 110000, label: 'translated block' }
    );
    const done = await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'done',
      { timeoutMs: 130000, label: 'done' }
    );

    const current = (await site.textContent('#simple-intro')) || '';
    expect(current).not.toBe(original);
    const trace = done.job && done.job.agentState && Array.isArray(done.job.agentState.toolExecutionTrace)
      ? done.job.agentState.toolExecutionTrace
      : [];
    expect(trace.some((row) => row && row.toolName === 'page.apply_delta')).toBeTruthy();
    expect(trace.some((row) => row && row.toolName === 'job.mark_block_done')).toBeTruthy();

    const debug = await app.openDebugPage(tabId);
    await expect(debug.locator('[data-field="translation-job-status"]')).toContainText(/done|готово/i);

    await debug.close();
    await popup.close();
    await site.close();
  });

  test('C2: toggle original/translated/compare during run', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureMockProxy();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());
    const popup = await app.openPopupPage(tabId);
    const original = (await site.textContent('#simple-intro')) || '';

    await beginTranslationFlow(app, tabId);
    await waitRunning(app, tabId);

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'original', visible: false }, tabId);
    await expect.poll(async () => (await site.textContent('#simple-intro')) || '', { timeout: 20000 }).toContain('This paragraph');

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'translated', visible: true }, tabId);
    await expect.poll(async () => (await site.textContent('#simple-intro')) || '', { timeout: 45000 }).not.toBe(original);

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'compare', visible: true }, tabId);
    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', { timeoutMs: 130000, label: 'done after compare' });
    await expect.poll(async () => await site.locator('mark.nt-diff-ins').count(), { timeout: 20000 }).toBeGreaterThan(0);

    await popup.close();
    await site.close();
  });

  test('C3: cancel stops job and clears running lease', async ({ app }) => {
    await app.configureMockProxy();
    const site = await app.openSite('/big.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId);
    await waitRunning(app, tabId);
    const cancelRes = await app.sendCommand('CANCEL_TRANSLATION', { tabId }, tabId);
    expect(cancelRes && cancelRes.ok).toBeTruthy();

    const cancelled = await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'cancelled',
      { timeoutMs: 45000, label: 'cancelled' }
    );
    const runtimeStatus = cancelled && cancelled.job && cancelled.job.runtime && cancelled.job.runtime.status
      ? String(cancelled.job.runtime.status).toUpperCase()
      : '';
    expect(runtimeStatus).not.toBe('RUNNING');

    await site.close();
  });

  test('C4: reload page mid-run recovers and reaches terminal status', async ({ app }) => {
    await app.configureMockProxy();
    const site = await app.openSite('/dynamic.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId);
    await waitRunning(app, tabId);
    await site.reload({ waitUntil: 'domcontentloaded' });

    const terminal = await waitTerminal(app, tabId, 110000);
    expect(['done', 'failed']).toContain(terminal.jobStatus);

    await site.close();
  });

  test('C5: extension reload does not leave RUNNING forever', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureMockProxy();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId, { categoryLimit: 1 });
    await waitRunning(app, tabId);
    const reloadRes = await app.sendCommand('BG_TEST_RELOAD_EXTENSION', { mode: 'soft' });
    expect(reloadRes && reloadRes.ok).toBeTruthy();

    const terminal = await waitTerminal(app, tabId, 120000);
    expect(['done', 'failed', 'cancelled']).toContain(terminal.jobStatus);

    await site.close();
  });

  test('C6: second open restores from memory without extra LLM calls', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureMockProxy();

    const first = await app.openSite('/simple.html');
    const firstTabId = await app.resolveTabIdByUrl(first.url());
    await beginTranslationFlow(app, firstTabId);
    await app.waitForState(firstTabId, (state) => state && state.jobStatus === 'done', { timeoutMs: 90000, label: 'first done' });
    await waitForMockQuiescence(app, { timeoutMs: 15000, stableMs: 1800 });
    const clearFirst = await app.sendCommand('CLEAR_TRANSLATION_DATA', {
      tabId: firstTabId,
      includeCache: false
    }, firstTabId);
    expect(clearFirst && clearFirst.ok).toBeTruthy();
    await waitForMockQuiescence(app, { timeoutMs: 10000, stableMs: 1000, pollMs: 150 });
    app.mockServer.resetStats();
    await first.close();

    const second = await app.openSite('/simple.html');
    const secondTabId = await app.resolveTabIdByUrl(second.url());
    const secondStart = await app.sendCommand('START_TRANSLATION', { tabId: secondTabId }, secondTabId);
    expect(secondStart && secondStart.ok).toBeTruthy();

    const state = await app.waitForState(
      secondTabId,
      (row) => row && (row.jobStatus === 'awaiting_categories' || row.jobStatus === 'done'),
      { timeoutMs: 45000, label: 'memory restore stage' }
    );
    expect(state && (state.jobStatus === 'awaiting_categories' || state.jobStatus === 'done')).toBeTruthy();

    await waitForMockQuiescence(app, { timeoutMs: 8000, stableMs: 1000, pollMs: 150 });
    const after = app.mockServer.getStats().responsesRequests;
    expect(after).toBe(0);

    await second.close();
  });
});
