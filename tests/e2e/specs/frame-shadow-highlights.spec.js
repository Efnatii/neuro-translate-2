const { test, expect } = require('../fixtures/extension-fixture');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function beginTranslationFlow(app, tabId, { attempts = 2, categoryLimit = 6 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startRes = await app.sendCommand('START_TRANSLATION', { tabId }, tabId);
    if (!startRes || startRes.ok !== true) {
      lastError = new Error(`START_TRANSLATION failed: ${JSON.stringify(startRes || null)}`);
      if (attempt >= attempts) {
        throw lastError;
      }
      await sleep(400 * attempt);
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
      const recommendations = awaiting && awaiting.job && awaiting.job.categoryRecommendations && typeof awaiting.job.categoryRecommendations === 'object'
        ? awaiting.job.categoryRecommendations
        : (awaiting && awaiting.job && awaiting.job.agentState && awaiting.job.agentState.categoryRecommendations && typeof awaiting.job.agentState.categoryRecommendations === 'object'
          ? awaiting.job.agentState.categoryRecommendations
          : null);
      const recommended = recommendations && Array.isArray(recommendations.recommended)
        ? recommendations.recommended
        : (awaiting && awaiting.job && Array.isArray(awaiting.job.selectedCategories)
          ? awaiting.job.selectedCategories
          : []);
      const merged = recommended
        .concat(available.filter((category) => !recommended.includes(category)));
      const categories = (merged.length ? merged : available).slice(0, Math.max(1, Number(categoryLimit) || 1));
      expect(categories.length).toBeGreaterThan(0);
      const selectRes = await app.sendCommand('SET_TRANSLATION_CATEGORIES', {
        tabId,
        jobId: awaiting.jobId || null,
        categories,
        mode: 'replace'
      }, tabId);
      expect(selectRes && selectRes.ok).toBeTruthy();
      return;
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        throw error;
      }
      await app.sendCommand('CANCEL_TRANSLATION', { tabId }, tabId).catch(() => null);
      await sleep(500 * attempt);
    }
  }
  throw lastError || new Error('beginTranslationFlow failed');
}

test.describe('Frames/Shadow/Highlights e2e', () => {
  test('G1: scan/apply covers iframe srcdoc and same-origin iframe', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureTestBackend();
    const site = await app.openSite('/iframe.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const srcdocOriginal = ((await site.frameLocator('#frame-srcdoc').locator('#srcdoc-text').textContent()) || '').trim();
    const childOriginal = ((await site.frameLocator('#frame-same-origin').locator('#frame-child-text').textContent()) || '').trim();
    expect(srcdocOriginal.length).toBeGreaterThan(0);
    expect(childOriginal.length).toBeGreaterThan(0);

    await beginTranslationFlow(app, tabId, { categoryLimit: 20 });
    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', { timeoutMs: 130000, label: 'done' });

    await expect.poll(
      async () => (((await site.frameLocator('#frame-srcdoc').locator('#srcdoc-text').textContent()) || '').trim()),
      { timeout: 40000 }
    ).not.toBe(srcdocOriginal);
    await expect.poll(
      async () => (((await site.frameLocator('#frame-same-origin').locator('#frame-child-text').textContent()) || '').trim()),
      { timeout: 40000 }
    ).not.toBe(childOriginal);

    await site.close();
  });

  test('G2: scan detects open shadow text and apply writes into shadow root', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureTestBackend();
    const site = await app.openSite('/shadow.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    const originalShadow = await site.evaluate(() => {
      const host = document.getElementById('shadow-host');
      if (!host || !host.shadowRoot) {
        return '';
      }
      const node = host.shadowRoot.getElementById('shadow-text');
      return node ? String(node.textContent || '') : '';
    });
    expect(originalShadow.length).toBeGreaterThan(0);
    await expect.poll(async () => {
      return site.evaluate(() => {
        const host = document.getElementById('shadow-host');
        if (!host || !host.shadowRoot) {
          return '';
        }
        const node = host.shadowRoot.getElementById('shadow-text');
        return node ? String(node.textContent || '') : '';
      });
    }, { timeout: 10000 }).toContain('inside open shadow root');

    const startRes = await app.sendCommand('START_TRANSLATION', { tabId }, tabId);
    expect(startRes && startRes.ok).toBeTruthy();
    const awaiting = await app.waitForState(
      tabId,
      (state) => state && state.jobStatus === 'awaiting_categories',
      { timeoutMs: 50000, label: 'awaiting_categories' }
    );
    const blocks = awaiting && awaiting.job && awaiting.job.blocksById && typeof awaiting.job.blocksById === 'object'
      ? Object.values(awaiting.job.blocksById)
      : [];
    const hasShadowText = blocks.some((row) => row && typeof row.originalText === 'string' && row.originalText.includes('inside open shadow root'));
    expect(hasShadowText).toBeTruthy();

    const available = awaiting && awaiting.job && Array.isArray(awaiting.job.availableCategories)
      ? awaiting.job.availableCategories
      : [];
    const recommendations = awaiting && awaiting.job && awaiting.job.categoryRecommendations && typeof awaiting.job.categoryRecommendations === 'object'
      ? awaiting.job.categoryRecommendations
      : (awaiting && awaiting.job && awaiting.job.agentState && awaiting.job.agentState.categoryRecommendations && typeof awaiting.job.agentState.categoryRecommendations === 'object'
        ? awaiting.job.agentState.categoryRecommendations
        : null);
    const recommended = recommendations && Array.isArray(recommendations.recommended)
      ? recommendations.recommended
      : (awaiting && awaiting.job && Array.isArray(awaiting.job.selectedCategories)
        ? awaiting.job.selectedCategories
        : []);
    const categories = (recommended.length ? recommended : available).slice(0, Math.max(1, available.length || 1));
    expect(categories.length).toBeGreaterThan(0);
    const selectRes = await app.sendCommand('SET_TRANSLATION_CATEGORIES', {
      tabId,
      jobId: awaiting.jobId || null,
      categories,
      mode: 'replace'
    }, tabId);
    expect(selectRes && selectRes.ok).toBeTruthy();

    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', { timeoutMs: 130000, label: 'done' });

    const translatedShadow = await site.evaluate(() => {
      const host = document.getElementById('shadow-host');
      if (!host || !host.shadowRoot) {
        return '';
      }
      const node = host.shadowRoot.getElementById('shadow-text');
      return node ? String(node.textContent || '') : '';
    });
    expect(translatedShadow).not.toBe(originalShadow);

    await site.close();
  });

  test('G3: compare mode uses CSS highlights without mark wrappers', async ({ app }) => {
    test.setTimeout(180000);
    await app.configureTestBackend();
    const site = await app.openSite('/simple.html');
    const tabId = await app.resolveTabIdByUrl(site.url());

    await beginTranslationFlow(app, tabId, { categoryLimit: 5 });
    await app.waitForState(tabId, (state) => state && state.jobStatus === 'done', { timeoutMs: 130000, label: 'done' });

    await app.sendCommand('SET_TRANSLATION_VISIBILITY', { tabId, mode: 'compare', visible: true }, tabId);
    const supportsHighlights = await site.evaluate(() => Boolean(globalThis.CSS && CSS.highlights && typeof globalThis.Highlight === 'function'));
    expect(supportsHighlights).toBeTruthy();

    await expect.poll(async () => await site.locator('mark.nt-diff-ins').count(), { timeout: 20000 }).toBe(0);
    await expect.poll(async () => {
      return site.evaluate(() => {
        if (!globalThis.CSS || !CSS.highlights) {
          return 0;
        }
        const highlight = CSS.highlights.get('nt-diff');
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

    await site.close();
  });
});
