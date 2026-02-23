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

async function run() {
  global.NT = {};
  load('extension/ai/translation-agent.js');

  const Agent = global.NT.TranslationAgent;
  assert(Agent, 'TranslationAgent must be defined');

  const agent = new Agent({});
  const blocks = [
    { blockId: 'b0', originalText: 'Welcome to Dashboard', category: 'heading', pathHint: 'h1' },
    { blockId: 'b1', originalText: 'Click Save button to apply settings', category: 'paragraph', pathHint: 'p' },
    { blockId: 'b2', originalText: 'Save', category: 'button', pathHint: 'button' },
    { blockId: 'b3', originalText: 'Status: ready', category: 'meta', pathHint: 'header' }
  ];

  const prepared = await agent.prepareJob({
    job: { id: 'job-1', tabId: 10, targetLang: 'ru' },
    blocks,
    settings: {
      translationAgentProfile: 'balanced',
      translationCategoryMode: 'all',
      translationAgentTools: {
        batchPlanner: 'off'
      }
    }
  });

  assert(Array.isArray(prepared.blocks), 'Prepared blocks must be an array');
  assert(prepared.blocks.length > 0, 'Prepared blocks must not be empty');
  assert(prepared.agentState, 'Agent state must be produced');
  assert.strictEqual(prepared.agentState.profile, 'balanced', 'Profile must be preserved');
  assert(prepared.agentState.toolConfig && typeof prepared.agentState.toolConfig === 'object', 'Resolved tool config must be present');
  assert(prepared.agentState.toolConfigRequested && typeof prepared.agentState.toolConfigRequested === 'object', 'Requested tool config must be tracked');
  assert(Array.isArray(prepared.agentState.toolAutoDecisions), 'Auto tool decisions should be tracked');
  assert(Array.isArray(prepared.agentState.toolExecutionTrace), 'Tool execution trace should be tracked');
  assert(prepared.agentState.toolExecutionTrace.some((entry) => entry && entry.tool === 'pageAnalyzer'), 'Prepare phase must execute pageAnalyzer tool');
  assert(prepared.agentState.toolExecutionTrace.some((entry) => entry && entry.tool === 'workflowController'), 'Prepare phase must execute workflow controller tool');
  assert(prepared.agentState.toolAutoDecisions.length > 0, 'Auto tool decisions should not be empty');
  assert(!Object.values(prepared.agentState.toolConfig).includes('auto'), 'Resolved tool modes must not keep auto values');
  assert.strictEqual(prepared.agentState.toolConfig.batchPlanner, 'off', 'Explicitly disabled planner must stay disabled');
  assert.strictEqual(prepared.agentState.toolConfigRequested.batchPlanner, 'off', 'Requested planner mode must be preserved');
  assert(prepared.agentState.tuning && typeof prepared.agentState.tuning === 'object', 'Agent state should expose normalized tuning');
  assert(prepared.agentState.runtimeTuning && typeof prepared.agentState.runtimeTuning === 'object', 'Agent state should expose runtime tuning');

  const tunedPrepared = await agent.prepareJob({
    job: { id: 'job-tuned', tabId: 18, targetLang: 'ru' },
    blocks,
    settings: {
      translationAgentProfile: 'balanced',
      translationAgentTuning: {
        styleOverride: 'technical',
        maxBatchSizeOverride: 3,
        proofreadingPassesOverride: 4,
        parallelismOverride: 'high',
        plannerTemperature: 0.35,
        plannerMaxOutputTokens: 1500,
        auditIntervalMs: 7000,
        mandatoryAuditIntervalMs: 1200,
        compressionThreshold: 12,
        contextFootprintLimit: 1800,
        compressionCooldownMs: 450
      }
    }
  });
  assert.strictEqual(tunedPrepared.agentState.plan.batchSize, 3, 'Batch-size tuning override must affect fallback plan');
  assert.strictEqual(tunedPrepared.agentState.plan.proofreadingPasses, 4, 'Proofread-pass override must affect fallback plan');
  assert.strictEqual(tunedPrepared.agentState.plan.style, 'technical', 'Style override must affect fallback plan');
  assert.strictEqual(tunedPrepared.agentState.resolvedProfile.parallelism, 'high', 'Parallelism override must update resolved profile');
  assert.strictEqual(tunedPrepared.agentState.runtimeTuning.auditIntervalMs, 7000, 'Runtime audit interval should be tunable');
  assert.strictEqual(tunedPrepared.agentState.runtimeTuning.mandatoryAuditIntervalMs, 1200, 'Runtime mandatory audit interval should be tunable');
  assert.strictEqual(tunedPrepared.agentState.runtimeTuning.contextFootprintLimit, 1800, 'Runtime context limit should be tunable');
  assert.strictEqual(tunedPrepared.agentState.runtimeTuning.compressionCooldownMs, 450, 'Runtime compression cooldown should be tunable');
  assert.strictEqual(agent._clampBatchSize(999), 999, 'Batch-size clamp should not enforce hidden upper bounds');

  const unrestrictedPrepared = await agent.prepareJob({
    job: { id: 'job-unrestricted', tabId: 19, targetLang: 'ru' },
    blocks,
    settings: {
      translationAgentProfile: 'balanced',
      translationAgentTuning: {
        maxBatchSizeOverride: 123,
        proofreadingPassesOverride: 57,
        auditIntervalMs: 1200,
        mandatoryAuditIntervalMs: 9000
      }
    }
  });
  assert.strictEqual(unrestrictedPrepared.agentState.plan.batchSize, 123, 'Agent plan must preserve large batch-size override');
  assert.strictEqual(unrestrictedPrepared.agentState.plan.proofreadingPasses, 57, 'Agent plan must preserve large proofreading-pass override');
  assert.strictEqual(
    unrestrictedPrepared.agentState.runtimeTuning.mandatoryAuditIntervalMs,
    9000,
    'Mandatory audit interval should not be implicitly capped by regular audit interval'
  );

  const job = {
    id: 'job-1',
    tabId: 10,
    targetLang: 'ru',
    blocksById: {},
    pendingBlockIds: prepared.blocks.map((item) => item.blockId),
    failedBlockIds: [],
    completedBlocks: 0,
    totalBlocks: prepared.blocks.length,
    agentState: prepared.agentState
  };
  prepared.blocks.forEach((item) => {
    job.blocksById[item.blockId] = { ...item };
  });

  const batch = agent.buildNextBatch(job);
  assert(batch && batch.blockIds.length, 'Agent should build next batch');
  const batchContext = agent.buildBatchContext({ job, batch });
  assert(batchContext && typeof batchContext === 'object', 'Batch context must be produced');
  assert(batchContext.modelRouterEnabled !== false, 'Model router should be enabled for mixed content');
  assert(batchContext.routeHint === 'strong' || batchContext.routeHint === 'fast', 'Batch route hint should be set when model router is enabled');

  const translatedItems = batch.blockIds.map((blockId) => ({ blockId, text: `T:${job.blocksById[blockId].originalText}` }));
  agent.recordBatchSuccess({
    job,
    batch,
    translatedItems,
    report: {
      summary: 'ok',
      quality: 'needs_review',
      notes: ['term mismatch']
    }
  });
  const lastBatchReport = job.agentState.reports[job.agentState.reports.length - 1];
  assert(lastBatchReport && lastBatchReport.formatVersion === 'nt.agent.report.v1', 'Agent report should include format version');
  assert(lastBatchReport.meta && lastBatchReport.meta.quality === 'needs_review', 'Batch report quality should be preserved in meta');
  assert(Array.isArray(lastBatchReport.meta.notes) && lastBatchReport.meta.notes[0] === 'term mismatch', 'Batch report notes should be preserved in meta');
  assert(job.agentState.reportFormat && job.agentState.reportFormat.version === 'nt.agent.report.v1', 'Default report format version should be present');

  job.pendingBlockIds = job.pendingBlockIds.filter((id) => !batch.blockIds.includes(id));
  job.completedBlocks = translatedItems.length;
  const audit = agent.maybeAudit({ job, reason: 'test', force: true });
  assert(audit && typeof audit.coverage === 'number', 'Audit must be produced');

  agent.finalizeJob(job);
  assert.strictEqual(job.agentState.status, 'done', 'Finalize should mark agent state as done');

  const snapshot = agent.toUiSnapshot(job.agentState);
  assert(snapshot && snapshot.phase === 'done', 'UI snapshot must be available');
  assert(snapshot.toolConfig && typeof snapshot.toolConfig === 'object', 'UI snapshot should expose resolved tool config');
  assert(snapshot.toolConfigRequested && typeof snapshot.toolConfigRequested === 'object', 'UI snapshot should expose requested tool config');
  assert(Array.isArray(snapshot.toolAutoDecisions), 'UI snapshot should expose auto tool decisions');
  assert(Array.isArray(snapshot.toolExecutionTrace), 'UI snapshot should expose tool execution trace');
  assert(snapshot.toolExecutionTrace.some((entry) => entry && entry.tool === 'workflowController'), 'Tool execution trace should include workflow controller actions');
  assert(snapshot.tuning && typeof snapshot.tuning === 'object', 'UI snapshot should expose tuning');
  assert(snapshot.runtimeTuning && typeof snapshot.runtimeTuning === 'object', 'UI snapshot should expose runtime tuning');

  const preview = Agent.previewResolvedSettings({
    settings: {
      translationAgentProfile: 'technical',
      translationAgentTuning: {
        maxBatchSizeOverride: 104,
        compressionThreshold: 33,
        auditIntervalMs: 1000,
        mandatoryAuditIntervalMs: 8000
      }
    },
    pageStats: null
  });
  assert(preview && preview.effectiveProfile && preview.runtimeTuning, 'Static profile preview helper should return resolved profile and runtime tuning');
  assert.strictEqual(preview.effectiveProfile.maxBatchSize, 104, 'Preview helper should apply large max batch override without upper clamp');
  assert.strictEqual(preview.runtimeTuning.compressionThreshold, 33, 'Preview helper should apply compression-threshold override');
  assert.strictEqual(preview.runtimeTuning.mandatoryAuditIntervalMs, 8000, 'Preview helper should keep mandatory audit interval uncapped');
  assert(preview.resolved && typeof preview.resolved === 'object', 'Preview helper should expose resolved object');
  assert(preview.resolved.toolConfigRequested && typeof preview.resolved.toolConfigRequested === 'object', 'Preview helper should expose requested tool config');
  assert(preview.resolved.toolConfigEffective && typeof preview.resolved.toolConfigEffective === 'object', 'Preview helper should expose effective tool config');
  assert(preview.resolved.modelPolicy && typeof preview.resolved.modelPolicy === 'object', 'Preview helper should expose model policy');
  assert(typeof preview.resolved.modelPolicy.mode === 'string', 'Preview model policy should contain mode');
  assert.strictEqual(typeof preview.resolved.pageCacheEnabled, 'boolean', 'Preview should expose page-cache toggle');
  assert.strictEqual(preview.pageStats, null, 'Preview without blocks should keep pageStats null');

  const previewWithBlocks = Agent.previewResolvedSettings({
    settings: {
      translationAgentProfile: 'balanced'
    },
    blocks
  });
  assert(previewWithBlocks.pageStats && previewWithBlocks.pageStats.blockCount === blocks.length, 'Preview with blocks should derive page stats');
  assert(previewWithBlocks.categoryStats && previewWithBlocks.categoryStats.heading, 'Preview with blocks should derive category stats');

  const categoryOffPrepared = await agent.prepareJob({
    job: { id: 'job-2', tabId: 12, targetLang: 'ru' },
    blocks,
    settings: {
      translationAgentProfile: 'balanced',
      translationCategoryMode: 'custom',
      translationCategoryList: ['meta'],
      translationAgentTools: {
        categorySelector: 'off',
        glossaryBuilder: 'off',
        batchPlanner: 'off',
        modelRouter: 'off',
        progressAuditor: 'off',
        contextCompressor: 'off'
      }
    }
  });

  assert(categoryOffPrepared.selectedCategories.includes('heading'), 'With disabled category selector all detected categories should remain');
  assert(categoryOffPrepared.selectedCategories.includes('button'), 'With disabled category selector UI categories should remain');
  assert.strictEqual(categoryOffPrepared.agentState.toolConfig.categorySelector, 'off', 'Category selector should remain disabled');
  assert.strictEqual(categoryOffPrepared.agentState.toolConfig.modelRouter, 'off', 'Model router should remain disabled');
  const jobNoRouter = {
    id: 'job-2',
    tabId: 12,
    targetLang: 'ru',
    blocksById: {},
    pendingBlockIds: categoryOffPrepared.blocks.map((item) => item.blockId),
    failedBlockIds: [],
    completedBlocks: 0,
    totalBlocks: categoryOffPrepared.blocks.length,
    agentState: categoryOffPrepared.agentState
  };
  categoryOffPrepared.blocks.forEach((item) => {
    jobNoRouter.blocksById[item.blockId] = { ...item };
  });
  const noRouterBatch = agent.buildNextBatch(jobNoRouter);
  const noRouterContext = agent.buildBatchContext({ job: jobNoRouter, batch: noRouterBatch });
  assert(noRouterContext && typeof noRouterContext === 'object', 'Batch context without router should still be produced');
  assert.strictEqual(noRouterContext.modelRouterEnabled, false, 'Batch context must expose disabled model router');
  assert.strictEqual(noRouterContext.routeHint, null, 'Disabled model router should not provide route hint');

  const mandatoryAudit = agent.runProgressAuditTool({
    job: jobNoRouter,
    reason: 'mandatory-audit-test',
    force: true,
    mandatory: true
  });
  assert(mandatoryAudit && mandatoryAudit.reason === 'mandatory-audit-test', 'Mandatory audit tool call must work even when auditor is disabled');

  const beforeCompressionCount = Number(jobNoRouter.agentState.compressedContextCount || 0);
  const compressedSummary = agent.runContextCompressionTool({
    job: jobNoRouter,
    force: true,
    mandatory: true,
    reason: 'mandatory-compress-test'
  });
  assert(typeof compressedSummary === 'string' && compressedSummary.length > 0, 'Mandatory context compression tool call must produce summary');
  assert(Number(jobNoRouter.agentState.compressedContextCount || 0) > beforeCompressionCount, 'Mandatory context compression should increment compression counter');

  jobNoRouter.agentState.runtimeTuning = {
    ...jobNoRouter.agentState.runtimeTuning,
    auditIntervalMs: 9000,
    mandatoryAuditIntervalMs: 800,
    compressionThreshold: 8,
    contextFootprintLimit: 1500,
    compressionCooldownMs: 120
  };
  jobNoRouter.agentState.toolConfig.progressAuditor = 'on';
  jobNoRouter.agentState.lastAuditAt = Date.now();
  const skippedAuditByInterval = agent.runProgressAuditTool({
    job: jobNoRouter,
    reason: 'interval-guard-test',
    force: false,
    mandatory: false
  });
  assert.strictEqual(skippedAuditByInterval, null, 'Audit interval tuning should prevent too-frequent audits');
  const forcedAuditWithInterval = agent.runProgressAuditTool({
    job: jobNoRouter,
    reason: 'interval-guard-test-forced',
    force: true,
    mandatory: false
  });
  assert(forcedAuditWithInterval && forcedAuditWithInterval.reason === 'interval-guard-test-forced', 'Forced audit should still bypass tuned interval');

  const allIds = categoryOffPrepared.blocks.map((item) => item.blockId);
  jobNoRouter.pendingBlockIds = allIds.slice();
  jobNoRouter.agentState.processedBlockIds = [allIds[0]];
  const antiRepeatBatch = agent.buildNextBatch(jobNoRouter);
  assert(antiRepeatBatch && antiRepeatBatch.blockIds.length > 0, 'Anti-repeat baseline should still build a batch');
  assert(!antiRepeatBatch.blockIds.includes(allIds[0]), 'Anti-repeat baseline should avoid already processed block ids even when tool is disabled');

  jobNoRouter.pendingBlockIds = allIds.slice(0, 2);
  jobNoRouter.agentState.processedBlockIds = [];
  jobNoRouter.agentState.seenBatchSignatures = [agent._batchSignature(jobNoRouter.pendingBlockIds)];
  const nonStoppingBatch = agent.buildNextBatch(jobNoRouter);
  assert(nonStoppingBatch && nonStoppingBatch.blockIds.length > 0, 'Agent batch builder should not self-stop when pending blocks still exist');

  const plannerPrompt = agent._buildPlannerPrompt({
    targetLang: 'ru',
    profile: 'auto',
    resolvedProfile: { style: 'balanced', maxBatchSize: 'auto' },
    blockCount: 12,
    selectedCategories: ['paragraph'],
    glossary: []
  });
  assert(!plannerPrompt.includes('1..12'), 'Planner prompt should not hard-limit batch size range');
  assert(!plannerPrompt.includes('0..4'), 'Planner prompt should not hard-limit proofreading pass range');
  console.log('PASS: translation agent');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
