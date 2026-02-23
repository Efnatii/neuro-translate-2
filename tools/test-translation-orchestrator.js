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

function waitFor(predicate, timeoutMs = 3000, stepMs = 25) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (predicate()) {
          resolve();
          return;
        }
      } catch (error) {
        reject(error);
        return;
      }
      if ((Date.now() - started) > timeoutMs) {
        reject(new Error('waitFor timeout'));
        return;
      }
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

class MemoryJobStore {
  constructor() {
    this.jobsByTab = {};
    this.jobsById = {};
    this.indexByTab = {};
    this.clearedTabs = [];
  }

  async getJob(jobId) {
    return this.jobsById[jobId] || null;
  }

  async upsertJob(job) {
    this.jobsById[job.id] = { ...(this.jobsById[job.id] || {}), ...(job || {}) };
    return this.jobsById[job.id];
  }

  async setActiveJob(tabId, jobId) {
    const key = String(tabId);
    this.jobsByTab[key] = jobId;
    this.indexByTab[key] = {
      activeJobId: jobId,
      lastJobId: jobId,
      updatedAt: Date.now()
    };
  }

  async clearActiveJob(tabId, jobId) {
    const key = String(tabId);
    if (jobId && this.jobsByTab[key] && this.jobsByTab[key] !== jobId) {
      return;
    }
    this.jobsByTab[key] = null;
    this.indexByTab[key] = {
      ...(this.indexByTab[key] || {}),
      activeJobId: null,
      lastJobId: jobId || (this.indexByTab[key] ? this.indexByTab[key].lastJobId : null),
      updatedAt: Date.now()
    };
  }

  async getActiveJob(tabId) {
    const key = String(tabId);
    const jobId = this.jobsByTab[key];
    return jobId ? this.jobsById[jobId] || null : null;
  }

  async getLastJobId(tabId) {
    const key = String(tabId);
    return this.indexByTab[key] ? this.indexByTab[key].lastJobId : null;
  }

  async listActiveJobs() {
    return Object.keys(this.jobsByTab)
      .map((tabId) => this.jobsByTab[tabId])
      .filter(Boolean)
      .map((jobId) => this.jobsById[jobId])
      .filter(Boolean);
  }

  async clearTabHistory(tabId) {
    const key = String(tabId);
    this.clearedTabs.push(Number(tabId));
    const activeId = this.jobsByTab[key] || null;
    const index = this.indexByTab[key] || {};
    const lastId = index.lastJobId || null;
    this.jobsByTab[key] = null;
    this.indexByTab[key] = {
      ...index,
      activeJobId: null,
      lastJobId: null,
      updatedAt: Date.now()
    };
    if (activeId && this.jobsById[activeId]) {
      delete this.jobsById[activeId];
    }
    if (lastId && this.jobsById[lastId]) {
      delete this.jobsById[lastId];
    }
    return true;
  }
}

async function run() {
  global.NT = {};
  load('extension/core/message-envelope.js');
  load('extension/core/event-types.js');
  load('extension/core/translation-protocol.js');
  load('extension/bg/translation-orchestrator.js');

  const protocol = global.NT.TranslationProtocol;
  const Orchestrator = global.NT.TranslationOrchestrator;
  assert(Orchestrator, 'TranslationOrchestrator must be defined');
  function unwrapOutgoing(msg) {
    const Env = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
    if (Env && typeof Env.isEnvelope === 'function' && Env.isEnvelope(msg)) {
      return {
        type: msg.type || null,
        payload: msg && msg.payload && typeof msg.payload === 'object' ? msg.payload : {}
      };
    }
    return {
      type: msg && msg.type ? msg.type : null,
      payload: msg && typeof msg === 'object' ? msg : {}
    };
  }

  const tabStatuses = {};
  const uiPatches = [];
  const events = [];
  const sentMessages = [];
  const translationCallInvocations = [];
  const translationCallOptions = [];

  let orchestrator = null;
  const chromeApi = {
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript: async () => {}
    },
    tabs: {
      sendMessage(tabId, message, cb) {
        const outgoing = unwrapOutgoing(message);
        const payload = outgoing.payload || {};
        sentMessages.push({ tabId, type: outgoing.type || 'unknown', message });
        if (outgoing.type === protocol.BG_APPLY_BATCH) {
          setTimeout(() => {
            const ack = typeof protocol.wrap === 'function'
              ? protocol.wrap(protocol.CS_APPLY_ACK, {
                jobId: payload.jobId,
                batchId: payload.batchId,
                appliedCount: Array.isArray(payload.items) ? payload.items.length : 0,
                ok: true,
                contentSessionId: payload.contentSessionId || null
              }, { source: 'content' })
              : {
                type: protocol.CS_APPLY_ACK,
                jobId: payload.jobId,
                batchId: payload.batchId,
                appliedCount: Array.isArray(payload.items) ? payload.items.length : 0,
                ok: true,
                contentSessionId: payload.contentSessionId || null
              };
            orchestrator.handleContentMessage({
              message: ack,
              sender: { tab: { id: tabId } }
            }).catch(() => {});
          }, 0);
        }
        cb({ ok: true });
      }
    }
  };

  const settingsData = {
    translationPipelineEnabled: true,
    translationApiCacheEnabled: true
  };
  const settingsStore = {
    async get(keys) {
      if (Array.isArray(keys)) {
        const out = {};
        keys.forEach((key) => {
          out[key] = Object.prototype.hasOwnProperty.call(settingsData, key) ? settingsData[key] : null;
        });
        return out;
      }
      return { ...settingsData };
    }
  };

  const tabStateStore = {
    async upsertStatusPatch(tabId, patch) {
      tabStatuses[tabId] = { ...(tabStatuses[tabId] || {}), ...(patch || {}) };
    },
    async upsertVisibility() {}
  };

  const translationCall = {
    async translateBatch(inputBlocks, options) {
      translationCallInvocations.push((inputBlocks || []).map((block) => block.blockId));
      translationCallOptions.push(options || null);
      return {
        items: (inputBlocks || []).map((block) => ({
          blockId: block.blockId,
          text: `T:${block.originalText}`
        }))
      };
    }
  };

  const eventFactory = {
    info: (tag, message, meta) => ({ ts: Date.now(), level: 'info', tag, message, meta }),
    warn: (tag, message, meta) => ({ ts: Date.now(), level: 'warn', tag, message, meta }),
    error: (tag, message, meta) => ({ ts: Date.now(), level: 'error', tag, message, meta })
  };

  const memoryStore = new MemoryJobStore();
  orchestrator = new Orchestrator({
    chromeApi,
    settingsStore,
    tabStateStore,
    jobStore: memoryStore,
    translationCall,
    eventFactory,
    eventLogFn: (event) => events.push(event),
    onUiPatch: (patch) => uiPatches.push(patch)
  });

  const start = await orchestrator.startJob({ tabId: 11, url: 'https://example.test' });
  assert.strictEqual(start.ok, true, 'startJob must succeed');
  assert(start.job && start.job.id, 'startJob must return job summary');

  const invalidScan = await orchestrator.handleContentMessage({
    message: { type: protocol.CS_SCAN_RESULT, blocks: [] },
    sender: { tab: { id: 11 } }
  });
  assert.strictEqual(invalidScan.ok, false, 'Invalid scan payload must be rejected');

  const scan = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: start.job.id,
      blocks: [
        { blockId: 'b0', originalText: 'One', pathHint: 'body > p:nth-of-type(1)' },
        { blockId: 'b1', originalText: 'Two', pathHint: 'body > p:nth-of-type(2)' },
        { blockId: 'b2', originalText: 'Three', pathHint: 'body > p:nth-of-type(3)' }
      ]
    },
    sender: { tab: { id: 11 } }
  });
  assert.strictEqual(scan.ok, true, 'Scan result must be accepted');
  assert.strictEqual(scan.awaitingCategorySelection, true, 'Scan should pause for category selection');

  const startEnvelopeScan = await orchestrator.startJob({ tabId: 15, url: 'https://example.test/envelope' });
  assert.strictEqual(startEnvelopeScan.ok, true, 'Envelope scan scenario job must start');
  const envScan = protocol.wrap(protocol.CS_SCAN_RESULT, {
    jobId: startEnvelopeScan.job.id,
    blocks: [
      { blockId: 'env0', originalText: 'Envelope block', category: 'paragraph', pathHint: 'body > p' }
    ],
    contentSessionId: 'cs-test'
  }, { source: 'content' });
  const envScanResult = await orchestrator.handleContentMessage({
    message: envScan,
    sender: { tab: { id: 15 } }
  });
  assert.strictEqual(envScanResult.ok, true, 'Envelope scan payload must be accepted');
  assert.strictEqual(envScanResult.awaitingCategorySelection, true, 'Envelope scan should pause for category selection');

  await memoryStore.upsertJob({
    id: 'job-ack-session',
    tabId: 16,
    url: 'https://example.test/ack',
    targetLang: 'ru',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    leaseUntilTs: Date.now() + 60_000,
    totalBlocks: 1,
    completedBlocks: 0,
    pendingBlockIds: ['a0'],
    failedBlockIds: [],
    blocksById: {
      a0: { blockId: 'a0', originalText: 'Ack block', category: 'paragraph', pathHint: 'body > p' }
    },
    currentBatchId: 'batch-1',
    lastError: null,
    message: 'Running',
    attempts: 0,
    scanReceived: true,
    contentSessionId: 'cs-A'
  });
  const ackWaiter = orchestrator._waitForApplyAck('job-ack-session', 'batch-1', 400);
  const wrongAckResult = await orchestrator.handleContentMessage({
    message: protocol.wrap(protocol.CS_APPLY_ACK, {
      jobId: 'job-ack-session',
      batchId: 'batch-1',
      appliedCount: 1,
      ok: true,
      contentSessionId: 'cs-B'
    }, { source: 'content' }),
    sender: { tab: { id: 16 } }
  });
  assert.strictEqual(wrongAckResult.ok, true, 'Wrong-session ack should be processed as ignored');
  assert.strictEqual(wrongAckResult.ignored, true, 'Wrong-session ack must be ignored');
  await new Promise((resolve) => setTimeout(resolve, 25));
  const rightAckResult = await orchestrator.handleContentMessage({
    message: protocol.wrap(protocol.CS_APPLY_ACK, {
      jobId: 'job-ack-session',
      batchId: 'batch-1',
      appliedCount: 1,
      ok: true,
      contentSessionId: 'cs-A'
    }, { source: 'content' }),
    sender: { tab: { id: 16 } }
  });
  assert.strictEqual(rightAckResult.ok, true, 'Matching-session ack should be accepted');
  const resolvedAck = await ackWaiter;
  assert.strictEqual(resolvedAck.ok, true, 'Matching-session ack must resolve waiter');
  assert.strictEqual(resolvedAck.appliedCount, 1, 'Matching-session ack must carry appliedCount');

  const applyCategories = await orchestrator.applyCategorySelection({
    tabId: 11,
    jobId: start.job.id,
    categories: Array.isArray(scan.availableCategories) && scan.availableCategories.length
      ? scan.availableCategories
      : ['paragraph']
  });
  assert.strictEqual(applyCategories.ok, true, 'Category selection should start translation');

  await waitFor(() => {
    const status = tabStatuses[11] || {};
    return status.status === 'done';
  });
  assert.strictEqual(tabStatuses[11].progress, 100, 'Done status must have 100% progress');
  assert(translationCallOptions.some((row) => row && row.cacheEnabled === true), 'API cache flag should be enabled by default');

  const beforeRestartMessages = sentMessages.length;
  const restart = await orchestrator.startJob({ tabId: 11, url: 'https://example.test/restart' });
  assert.strictEqual(restart.ok, true, 'Restarted job must start');
  const restartMessages = sentMessages.slice(beforeRestartMessages).filter((row) => row.tabId === 11);
  const restoreIndex = restartMessages.findIndex((row) => row.type === protocol.BG_RESTORE_ORIGINALS);
  const startIndex = restartMessages.findIndex((row) => {
    const payload = unwrapOutgoing(row.message).payload || {};
    return row.type === protocol.BG_START_JOB && payload.jobId === restart.job.id;
  });
  assert(restoreIndex >= 0, 'Restart must request originals restore before new scan');
  assert(startIndex > restoreIndex, 'Restore must happen before BG_START_JOB');

  const retry = await orchestrator.retryFailed({ tabId: 11 });
  assert.strictEqual(retry.ok, false, 'Retry must fail when there are no failed blocks');

  const clear = await orchestrator.clearJobData({ tabId: 11, includeCache: false });
  assert.strictEqual(clear.ok, true, 'Clear data must succeed');
  assert.strictEqual((tabStatuses[11] || {}).status, 'idle', 'Clear data must reset tab status to idle');
  assert(memoryStore.clearedTabs.includes(11), 'Clear data should clear tab history in store');

  orchestrator.BATCH_SIZE = 1;
  settingsData.translationApiCacheEnabled = false;
  const callsBeforeDup = translationCallInvocations.length;
  const optionsBeforeDup = translationCallOptions.length;
  const startDup = await orchestrator.startJob({ tabId: 13, url: 'https://example.test/dups' });
  assert.strictEqual(startDup.ok, true, 'Duplicate scenario job must start');
  const scanDup = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: startDup.job.id,
      blocks: [
        { blockId: 'd0', originalText: 'Same text', category: 'paragraph', pathHint: 'body > p:nth-of-type(1)' },
        { blockId: 'd1', originalText: 'Same text', category: 'paragraph', pathHint: 'body > p:nth-of-type(2)' },
        { blockId: 'd2', originalText: 'Same text', category: 'paragraph', pathHint: 'body > p:nth-of-type(3)' }
      ]
    },
    sender: { tab: { id: 13 } }
  });
  assert.strictEqual(scanDup.ok, true, 'Duplicate scan must be accepted');
  assert.strictEqual(scanDup.awaitingCategorySelection, true, 'Duplicate scan should wait for category selection');
  const applyDupCategories = await orchestrator.applyCategorySelection({
    tabId: 13,
    jobId: startDup.job.id,
    categories: Array.isArray(scanDup.availableCategories) && scanDup.availableCategories.length
      ? scanDup.availableCategories
      : ['paragraph']
  });
  assert.strictEqual(applyDupCategories.ok, true, 'Duplicate flow category selection should start translation');
  await waitFor(() => {
    const status = tabStatuses[13] || {};
    return status.status === 'done';
  });
  const callsForDup = translationCallInvocations.length - callsBeforeDup;
  const optionsForDup = translationCallOptions.slice(optionsBeforeDup);
  assert.strictEqual(callsForDup, 1, 'Duplicate text batches should reuse translation memory and avoid repeated LLM calls');
  assert(optionsForDup.length >= 1 && optionsForDup.every((row) => row && row.cacheEnabled === false), 'API cache flag should propagate into translation-call options');

  const callsBeforeExtend = translationCallInvocations.length;
  const startExtend = await orchestrator.startJob({ tabId: 14, url: 'https://example.test/extend' });
  assert.strictEqual(startExtend.ok, true, 'Extend-categories job must start');
  const scanExtend = await orchestrator.handleContentMessage({
    message: {
      type: protocol.CS_SCAN_RESULT,
      jobId: startExtend.job.id,
      blocks: [
        { blockId: 'e0', originalText: 'Heading text', category: 'heading', pathHint: 'body > h1' },
        { blockId: 'e1', originalText: 'Paragraph text', category: 'paragraph', pathHint: 'body > p' }
      ]
    },
    sender: { tab: { id: 14 } }
  });
  assert.strictEqual(scanExtend.ok, true, 'Extend-categories scan must be accepted');
  assert.strictEqual(scanExtend.awaitingCategorySelection, true, 'Extend-categories scan must pause for selection');
  const applyInitialExtend = await orchestrator.applyCategorySelection({
    tabId: 14,
    jobId: startExtend.job.id,
    categories: ['heading']
  });
  assert.strictEqual(applyInitialExtend.ok, true, 'Initial partial category selection must succeed');
  await waitFor(() => {
    const status = tabStatuses[14] || {};
    return status.status === 'done';
  });
  const activeAfterPartial = await memoryStore.getActiveJob(14);
  const lastAfterPartialId = await memoryStore.getLastJobId(14);
  const lastAfterPartial = lastAfterPartialId ? await memoryStore.getJob(lastAfterPartialId) : null;
  assert(lastAfterPartial && lastAfterPartial.status === 'done', 'Partial category completion should persist done state for future category expansion');
  assert(!activeAfterPartial || activeAfterPartial.status === 'done', 'Partial category completion may keep or clear active mapping depending on terminal-state policy');

  const applyExtendMore = await orchestrator.applyCategorySelection({
    tabId: 14,
    jobId: startExtend.job.id,
    categories: ['heading', 'paragraph']
  });
  assert.strictEqual(applyExtendMore.ok, true, 'Adding remaining categories should succeed');
  await waitFor(() => {
    const status = tabStatuses[14] || {};
    return status.status === 'done';
  });
  const activeAfterFull = await memoryStore.getActiveJob(14);
  assert.strictEqual(activeAfterFull, null, 'Full category completion should clear active job mapping');
  const extendCalls = translationCallInvocations.length - callsBeforeExtend;
  assert.strictEqual(extendCalls, 2, 'Category extension flow should translate only newly requested categories in the second pass');

  const start2 = await orchestrator.startJob({ tabId: 12, url: 'https://example.test' });
  assert.strictEqual(start2.ok, true, 'Second startJob must succeed');
  const cancel2 = await orchestrator.cancelJob({ tabId: 12 });
  assert.strictEqual(cancel2.ok, true, 'Cancel must succeed');
  assert.strictEqual(cancel2.cancelled, true, 'Cancel must mark active job');
  assert.strictEqual(cancel2.job && cancel2.job.message, 'Отменено пользователем', 'User cancel should preserve user-facing message');

  const tabStatusesRecovery = {};
  const recoveryStore = new MemoryJobStore();
  const recoveryMessages = [];
  const recoveryEvents = [];
  const recoveryChromeApi = {
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript: async () => {}
    },
    tabs: {
      get(tabId, cb) {
        if (Number(tabId) === 71) {
          recoveryChromeApi.runtime.lastError = { message: 'No tab with id: 71' };
          cb(undefined);
          recoveryChromeApi.runtime.lastError = null;
          return;
        }
        cb({ id: Number(tabId), url: 'https://example.test/recover?restored=1' });
      },
      query(_queryInfo, cb) {
        cb([
          { id: 171, url: 'https://example.test/recover?restored=1' },
          { id: 172, url: 'https://example.test/other' }
        ]);
      },
      sendMessage(tabId, message, cb) {
        recoveryMessages.push({ tabId, type: message && message.type ? message.type : 'unknown', message });
        cb({ ok: true });
      }
    }
  };

  const recoveryOrchestrator = new Orchestrator({
    chromeApi: recoveryChromeApi,
    settingsStore,
    tabStateStore: {
      async upsertStatusPatch(tabId, patch) {
        tabStatusesRecovery[tabId] = { ...(tabStatusesRecovery[tabId] || {}), ...(patch || {}) };
      },
      async upsertVisibility() {}
    },
    jobStore: recoveryStore,
    translationCall,
    eventFactory,
    eventLogFn: (event) => recoveryEvents.push(event),
    onUiPatch: () => {}
  });

  await recoveryStore.upsertJob({
    id: 'job-recover-1',
    tabId: 71,
    url: 'https://example.test/recover?old=1',
    targetLang: 'ru',
    status: 'preparing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    leaseUntilTs: Date.now() + 60_000,
    totalBlocks: 0,
    completedBlocks: 0,
    pendingBlockIds: [],
    failedBlockIds: [],
    blocksById: {},
    currentBatchId: null,
    lastError: null,
    message: 'Preparing',
    attempts: 0,
    scanReceived: false
  });
  await recoveryStore.setActiveJob(71, 'job-recover-1');

  await recoveryOrchestrator.restoreStateAfterRestart();
  const recoveredJob = await recoveryStore.getJob('job-recover-1');
  assert(recoveredJob, 'Recovered job should still exist');
  assert.strictEqual(recoveredJob.tabId, 171, 'Recovery should remap job to replacement tab with matching URL');
  const activeOld = await recoveryStore.getActiveJob(71);
  assert.strictEqual(activeOld, null, 'Old tab mapping should be cleared after recovery remap');
  const activeNew = await recoveryStore.getActiveJob(171);
  assert(activeNew && activeNew.id === 'job-recover-1', 'Recovered tab should become active mapping');
  const resumedStartMessage = recoveryMessages.find((item) => item.type === protocol.BG_START_JOB && item.tabId === 171);
  assert(resumedStartMessage, 'Recovered preparing job should receive BG_START_JOB on replacement tab');
  const recoveryEvent = recoveryEvents.find((item) => item && item.message === 'Задача перевода восстановлена в замещающей вкладке после перезапуска');
  assert(recoveryEvent, 'Recovery remap should emit a diagnostic event');

  const failureStore = new MemoryJobStore();
  const failureChromeApi = {
    runtime: {
      lastError: null
    },
    scripting: {
      executeScript: async () => {}
    },
    tabs: {
      get(_tabId, cb) {
        failureChromeApi.runtime.lastError = { message: 'No tab available' };
        cb(undefined);
        failureChromeApi.runtime.lastError = null;
      },
      query(_queryInfo, cb) {
        cb([]);
      },
      sendMessage(_tabId, _message, cb) {
        cb({ ok: true });
      }
    }
  };

  const failureOrchestrator = new Orchestrator({
    chromeApi: failureChromeApi,
    settingsStore,
    tabStateStore: {
      async upsertStatusPatch() {},
      async upsertVisibility() {}
    },
    jobStore: failureStore,
    translationCall,
    eventFactory,
    eventLogFn: () => {},
    onUiPatch: () => {}
  });

  await failureStore.upsertJob({
    id: 'job-recover-miss',
    tabId: 88,
    url: 'https://missing.example.test/path',
    targetLang: 'ru',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    leaseUntilTs: Date.now() + 60_000,
    totalBlocks: 1,
    completedBlocks: 0,
    pendingBlockIds: ['m0'],
    failedBlockIds: [],
    blocksById: {
      m0: { blockId: 'm0', originalText: 'Missing tab case', pathHint: 'body > p', category: 'paragraph' }
    },
    currentBatchId: null,
    lastError: null,
    message: 'Running',
    attempts: 0,
    scanReceived: true
  });
  await failureStore.setActiveJob(88, 'job-recover-miss');

  await failureOrchestrator.restoreStateAfterRestart();
  const missingJob = await failureStore.getJob('job-recover-miss');
  assert(missingJob, 'Missing-tab job should still exist after failed restore');
  assert.strictEqual(missingJob.status, 'failed', 'Restore should fail job when tab is unavailable and unrecoverable');
  assert.strictEqual(
    missingJob.lastError && missingJob.lastError.code,
    'TAB_UNAVAILABLE_AFTER_RESTART',
    'Missing-tab failure should expose deterministic error code'
  );
  const stillActiveMissing = await failureStore.getActiveJob(88);
  assert.strictEqual(stillActiveMissing, null, 'Failed restore job should not remain active');

  assert(events.length > 0, 'Events should be emitted');
  assert(uiPatches.length > 0, 'UI patches should be emitted');
  console.log('PASS: translation orchestrator');
}

run().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
