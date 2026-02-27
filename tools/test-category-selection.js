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

function buildJob() {
  const blocksById = {
    b1: { blockId: 'b1', originalText: 'Paragraph A', category: 'main_content', translatedText: '' },
    b2: { blockId: 'b2', originalText: 'Paragraph B', category: 'main_content', translatedText: 'Абзац B' },
    b3: { blockId: 'b3', originalText: 'Save', category: 'ui_controls', translatedText: '' },
    b4: { blockId: 'b4', originalText: 'Footer text', category: 'footer', translatedText: '' }
  };
  return {
    id: 'job-categories-1',
    tabId: 9,
    targetLang: 'ru',
    status: 'awaiting_categories',
    blocksById,
    selectedCategories: [],
    availableCategories: ['main_content', 'ui_controls', 'footer'],
    pendingBlockIds: [],
    failedBlockIds: [],
    completedBlocks: 0,
    totalBlocks: 0,
    classificationStale: false,
    classification: {
      classifierVersion: 'dom-classifier/1.0.0',
      domHash: 'dom:4:test',
      byBlockId: {
        b1: { category: 'main_content', confidence: 0.9, reasons: ['rule:main_content'] },
        b2: { category: 'main_content', confidence: 0.9, reasons: ['rule:main_content'] },
        b3: { category: 'ui_controls', confidence: 0.95, reasons: ['rule:ui_controls'] },
        b4: { category: 'footer', confidence: 0.92, reasons: ['rule:footer'] }
      },
      summary: {
        countsByCategory: { main_content: 2, ui_controls: 1, footer: 1 },
        confidenceStats: {}
      },
      ts: Date.now()
    },
    agentState: {}
  };
}

async function run() {
  global.NT = {};
  load('extension/core/message-envelope.js');
  load('extension/core/event-types.js');
  load('extension/core/translation-protocol.js');
  load('extension/bg/translation-orchestrator.js');

  const Orchestrator = global.NT && global.NT.TranslationOrchestrator;
  assert(Orchestrator, 'TranslationOrchestrator must be defined');

  const orchestrator = new Orchestrator({
    jobStore: {
      async upsertJob() {},
      async setActiveJob() {},
      async clearActiveJob() {}
    }
  });
  orchestrator._saveJob = async () => ({ ok: true });
  orchestrator._readAgentSettings = async () => ({ translationPageCacheEnabled: false });
  orchestrator._tryApplyCachedJob = async () => ({ ok: false, fromCache: false });
  orchestrator.classifyBlocksForJob = async ({ job }) => ({
    ok: true,
    domHash: job && job.classification ? job.classification.domHash : null,
    classifierVersion: 'dom-classifier/1.0.0',
    summary: job && job.classification ? job.classification.summary : {},
    byBlockId: job && job.classification ? job.classification.byBlockId : {},
    classificationStale: job && job.classificationStale === true
  });

  const job = buildJob();

  const replaceResult = await orchestrator._setSelectedCategories({
    job,
    categories: ['main_content'],
    mode: 'replace',
    reason: 'test:replace'
  });
  assert.strictEqual(replaceResult.ok, true, 'replace should succeed');
  assert.deepStrictEqual(job.selectedCategories, ['main_content'], 'replace should overwrite selected categories');
  assert.deepStrictEqual(job.pendingBlockIds, ['b1'], 'replace should set pending only for untranslated selected blocks');
  assert.strictEqual(job.completedBlocks, 1, 'replace should count already translated selected blocks');
  assert.strictEqual(job.totalBlocks, 2, 'replace should set totalBlocks from selected categories');

  const addResult = await orchestrator._setSelectedCategories({
    job,
    categories: ['footer'],
    mode: 'add',
    reason: 'test:add'
  });
  assert.strictEqual(addResult.ok, true, 'add should succeed');
  assert.deepStrictEqual(job.selectedCategories, ['main_content', 'footer'], 'add should append new categories');
  assert.deepStrictEqual(job.pendingBlockIds.sort(), ['b1', 'b4'], 'add should include only newly eligible untranslated blocks');
  assert.strictEqual(job.blocksById.b2.translatedText, 'Абзац B', 'add must not modify already translated blocks');

  const removeResult = await orchestrator._setSelectedCategories({
    job,
    categories: ['main_content'],
    mode: 'remove',
    reason: 'test:remove'
  });
  assert.strictEqual(removeResult.ok, true, 'remove should succeed');
  assert.deepStrictEqual(job.selectedCategories, ['footer'], 'remove should drop requested categories');
  assert.deepStrictEqual(job.pendingBlockIds, ['b4'], 'remove should recompute pending from remaining categories');
  assert.strictEqual(job.blocksById.b2.translatedText, 'Абзац B', 'remove must not modify translated history');

  job.status = 'awaiting_categories';
  job.classificationStale = true;
  const staleResult = await orchestrator._setSelectedCategories({
    job,
    categories: ['footer'],
    mode: 'replace',
    reason: 'test:stale'
  });
  assert.strictEqual(staleResult.ok, false, 'stale classification must block selection');
  assert(staleResult.error && staleResult.error.code === 'CLASSIFICATION_STALE', 'stale flow must return CLASSIFICATION_STALE');
  assert.strictEqual(staleResult.stale, true, 'stale flow must mark stale=true');

  const orchestratorMismatch = new Orchestrator({
    jobStore: {
      async upsertJob() {},
      async setActiveJob() {},
      async clearActiveJob() {}
    }
  });
  orchestratorMismatch._saveJob = async () => ({ ok: true });
  orchestratorMismatch._ensureContentRuntime = async () => ({ ok: true });
  orchestratorMismatch._readAgentSettings = async () => ({
    translationClassifierObserveDomChanges: false,
    classifier: { observeDomChanges: false }
  });
  orchestratorMismatch._sendToTab = async (_tabId, payload) => {
    const force = payload && payload.force === true;
    const baseResponse = {
      ok: true,
      classifierVersion: 'dom-classifier/1.0.0',
      byBlockId: {
        b1: { category: 'main_content', confidence: 0.9, reasons: ['rule:main_content'] },
        b2: { category: 'main_content', confidence: 0.9, reasons: ['rule:main_content'] },
        b3: { category: 'ui_controls', confidence: 0.95, reasons: ['rule:ui_controls'] },
        b5: { category: 'headings', confidence: 0.97, reasons: ['rule:headings'] }
      },
      summary: {
        countsByCategory: { main_content: 2, ui_controls: 1, headings: 1 },
        confidenceStats: {}
      },
      domHash: 'dom:5:new',
      classificationStale: false,
      blocks: [
        { blockId: 'b1', originalText: 'Paragraph A', pathHint: 'main > p:nth-of-type(1)', domOrder: 0, category: 'unknown', features: { tag: 'p', textLen: 11 } },
        { blockId: 'b2', originalText: 'Paragraph B', pathHint: 'main > p:nth-of-type(2)', domOrder: 1, category: 'unknown', features: { tag: 'p', textLen: 11 } },
        { blockId: 'b3', originalText: 'New CTA', pathHint: 'form > button:nth-of-type(1)', domOrder: 2, category: 'unknown', features: { tag: 'button', textLen: 7 } },
        { blockId: 'b5', originalText: 'Fresh heading', pathHint: 'main > h2:nth-of-type(1)', domOrder: 3, category: 'unknown', features: { tag: 'h2', textLen: 13 } }
      ]
    };
    if (force) {
      return { ok: true, response: baseResponse };
    }
    return { ok: true, response: baseResponse };
  };

  const mismatchJob = buildJob();
  mismatchJob.domHash = 'dom:4:old';
  mismatchJob.classification.domHash = 'dom:4:old';
  mismatchJob.categorySelectionConfirmed = true;
  mismatchJob.selectedCategories = ['main_content'];
  mismatchJob.blocksById.b1.translatedText = 'T_A';

  const mismatchClassify = await orchestratorMismatch.classifyBlocksForJob({
    job: mismatchJob,
    force: false
  });
  assert.strictEqual(mismatchClassify.ok, true, 'classify should succeed even on domHash mismatch');
  assert.strictEqual(mismatchClassify.classificationStale, true, 'domHash mismatch must set classificationStale');
  assert.strictEqual(mismatchJob.classificationStale, true, 'job.classificationStale should be true on mismatch');

  const mismatchSelection = await orchestratorMismatch._setSelectedCategories({
    job: mismatchJob,
    categories: ['main_content'],
    mode: 'replace',
    reason: 'test:mismatch'
  });
  assert.strictEqual(mismatchSelection.ok, false, 'selection should be blocked when classification is stale');
  assert(mismatchSelection.error && mismatchSelection.error.code === 'CLASSIFICATION_STALE', 'mismatch flow should require force reclassify');

  const forceClassify = await orchestratorMismatch.classifyBlocksForJob({
    job: mismatchJob,
    force: true
  });
  assert.strictEqual(forceClassify.ok, true, 'force reclassify should succeed');
  assert.strictEqual(forceClassify.classificationStale, false, 'force reclassify should clear stale flag');
  assert.strictEqual(mismatchJob.classificationStale, false, 'job stale flag should clear after force reclassify');
  const rescannedHeadingBlock = Object.values(mismatchJob.blocksById || {}).find((block) => (
    block
    && typeof block.originalText === 'string'
    && block.originalText === 'Fresh heading'
  ));
  assert(rescannedHeadingBlock, 'force reclassify should bring newly scanned blocks');
  const paragraphABlock = Object.values(mismatchJob.blocksById || {}).find((block) => (
    block
    && typeof block.originalText === 'string'
    && block.originalText === 'Paragraph A'
  ));
  assert(paragraphABlock, 'paragraph block should be present after force reclassify');
  assert.strictEqual(
    paragraphABlock.translatedText,
    'T_A',
    'force reclassify should preserve translated text for existing blocks'
  );
  const classifyByBlockId = mismatchJob.classification && mismatchJob.classification.byBlockId
    ? mismatchJob.classification.byBlockId
    : {};
  assert(
    classifyByBlockId[rescannedHeadingBlock.blockId]
      && classifyByBlockId[rescannedHeadingBlock.blockId].category === 'headings',
    'classification must stay aligned with merged block ids after force reclassify'
  );

  console.log('PASS: category selection modes + stale guard');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
