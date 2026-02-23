/**
 * Background runtime-port hub for popup/debug synchronization.
 *
 * Role:
 * - Own MV3 runtime-port lifecycle and deliver stable HELLO/SNAPSHOT/SUBSCRIBE/
 *   PATCH flows for UI clients.
 *
 * Public contract:
 * - `attachToRuntime`, `broadcastPatch`, `broadcastEventAppend`,
 *   `broadcastEventReset`.
 * - Snapshot payload remains backward compatible and now also carries
 *   `modelRegistry`.
 *
 * Dependencies:
 * - Settings/tab/event stores and AI facade (`AiModule`) as the only source of
 *   AI benchmark/rate-limit/model-registry data.
 *
 * Side effects:
 * - Subscribes to `chrome.runtime.onConnect`, posts runtime messages to ports,
 *   and relays command/event callbacks to background app.
 */
(function initUiPortHub(global) {
  function cloneJson(value, fallback = null) {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_) {
      return fallback;
    }
  }

  class UiPortHub {
    constructor({
      settingsStore,
      tabStateStore,
      translationJobStore,
      eventLogStore,
      aiModule,
      onCommand,
      onEvent,
      runtimeSnapshotProvider,
      onHello
    } = {}) {
      this.subscribers = new Set();
      this.settingsStore = settingsStore || null;
      this.tabStateStore = tabStateStore || null;
      this.translationJobStore = translationJobStore || null;
      this.eventLogStore = eventLogStore || null;
      this.aiModule = aiModule || null;
      this.onCommand = typeof onCommand === 'function' ? onCommand : null;
      this.onEvent = typeof onEvent === 'function' ? onEvent : null;
      this.runtimeSnapshotProvider = typeof runtimeSnapshotProvider === 'function' ? runtimeSnapshotProvider : null;
      this.onHello = typeof onHello === 'function' ? onHello : null;
      this.uiCapsByPort = {};
    }

    attachToRuntime() {
      if (!global.chrome || !global.chrome.runtime || !global.chrome.runtime.onConnect) {
        return;
      }
      global.chrome.runtime.onConnect.addListener((port) => {
        if (!port || (port.name !== 'popup' && port.name !== 'debug')) {
          return;
        }
        this.logEvent('info', 'ui', 'Port connected', { source: port.name });
        port.onMessage.addListener((message) => this.handleMessage(port, message));
        port.onDisconnect.addListener(() => {
          this.subscribers.delete(port);
          this.logEvent('warn', 'ui', 'Port disconnected', { source: port.name });
        });
      });
    }

    async handleMessage(port, message) {
      const envelope = this.unwrapEnvelope(message);
      if (!envelope) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};

      if (envelope.type === UiProtocol.UI_HELLO) {
        const payload = envelope && envelope.payload && typeof envelope.payload === 'object'
          ? envelope.payload
          : {};
        const meta = envelope && envelope.meta && typeof envelope.meta === 'object'
          ? envelope.meta
          : {};
        const uiCaps = payload.uiCaps && typeof payload.uiCaps === 'object'
          ? payload.uiCaps
          : (meta.clientCaps && meta.clientCaps.ui && typeof meta.clientCaps.ui === 'object'
            ? meta.clientCaps.ui
            : null);
        if (uiCaps && port && port.name) {
          this.uiCapsByPort[port.name] = { ...(this.uiCapsByPort[port.name] || {}), ...uiCaps };
        }
        if (this.onHello) {
          this.onHello({
            portName: port.name,
            uiCaps: uiCaps || null,
            toolsetWanted: payload.toolsetWanted || meta.toolsetWanted || null
          });
        }
        this.logEvent('info', 'ui', 'UI hello', { source: port.name, stage: 'hello' });
        await this.sendSnapshot(port, envelope);
        return;
      }
      if (envelope.type === UiProtocol.UI_SUBSCRIBE) {
        this.subscribers.add(port);
        this.logEvent('info', 'ui', 'UI subscribed', { source: port.name, stage: 'subscribe' });
        return;
      }
      if (envelope.type === UiProtocol.UI_COMMAND) {
        const payload = envelope.payload || {};
        if (payload.name === UiProtocol.UI_EVENT_LOG_PAGE) {
          await this.handleEventLogPage(port, envelope);
          return;
        }
        if (this.onCommand) {
          this.onCommand({ port, envelope });
        }
      }
    }

    async sendSnapshot(port, envelope) {
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }
      const snapshot = await this.loadSnapshot(envelope);
      const wrapped = MessageEnvelope.wrap(global.NT.UiProtocol.UI_SNAPSHOT, snapshot, {
        source: 'background',
        stage: 'snapshot',
        requestId: envelope && envelope.meta ? envelope.meta.requestId || null : null
      });
      this.safePost(port, wrapped);
    }

    async loadSnapshot(envelope) {
      if (!this.settingsStore || !this.tabStateStore || !this.eventLogStore) {
        return {
          settings: {},
          tabId: null,
          translationStatusByTab: {},
          translationVisibilityByTab: {},
          translationDisplayModeByTab: {},
          eventLog: { seq: 0, items: [] },
          modelBenchmarkStatus: null,
          modelBenchmarks: {},
          modelLimitsBySpec: {},
          modelRegistry: { entries: [], byKey: {} },
          translationJob: null,
          translationProgress: 0,
          failedBlocksCount: 0,
          lastError: null,
          agentState: null,
          selectedCategories: [],
          availableCategories: [],
          recentDiffItems: []
        };
      }
      const helloPayload = envelope && envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
      const lastEventSeq = typeof helloPayload.lastEventSeq === 'number' ? helloPayload.lastEventSeq : null;
      const settings = await this.settingsStore.getPublicSnapshot();
      const visibilityData = await this.settingsStore.get([
        'translationVisibilityByTab',
        'translationDisplayModeByTab',
        'activeTabId'
      ]);
      const translationStatusByTab = await this.tabStateStore.getAllStatus();
      const benchmarkData = this.aiModule && typeof this.aiModule.getBenchmarkSnapshot === 'function'
        ? await this.aiModule.getBenchmarkSnapshot()
        : { modelBenchmarkStatus: null, modelBenchmarks: {} };
      const eventLog = await this.loadEventLogForHello(lastEventSeq);
      const modelLimitsBySpec = await this.buildModelLimitsSnapshot();
      const modelRegistry = this.aiModule && typeof this.aiModule.getRegistry === 'function'
        ? this.aiModule.getRegistry()
        : { entries: [], byKey: {} };
      const tabId = this.resolveTabId(
        envelope && envelope.meta ? envelope.meta : null,
        visibilityData,
        helloPayload
      );
      const translationState = await this.buildTranslationStateSnapshot(tabId);
      const effectiveTabId = tabId === null || tabId === undefined ? translationState.tabId : tabId;
      const runtime = this.runtimeSnapshotProvider
        ? await this.runtimeSnapshotProvider({
          tabId: effectiveTabId,
          portName: envelope && envelope.meta ? envelope.meta.source || null : null,
          uiCaps: helloPayload.uiCaps || null,
          toolsetWanted: helloPayload.toolsetWanted
            || (envelope && envelope.meta && envelope.meta.toolsetWanted && typeof envelope.meta.toolsetWanted === 'object'
              ? envelope.meta.toolsetWanted
              : null)
        }).catch(() => null)
        : null;

      return {
        settings,
        tabId: effectiveTabId === null || effectiveTabId === undefined ? null : effectiveTabId,
        translationStatusByTab,
        translationVisibilityByTab: visibilityData.translationVisibilityByTab || {},
        translationDisplayModeByTab: visibilityData.translationDisplayModeByTab || {},
        modelBenchmarkStatus: benchmarkData.modelBenchmarkStatus || null,
        modelBenchmarks: benchmarkData.modelBenchmarks || {},
        modelLimitsBySpec,
        modelRegistry,
        eventLog,
        translationJob: translationState.translationJob,
        translationProgress: translationState.translationProgress,
        failedBlocksCount: translationState.failedBlocksCount,
        lastError: translationState.lastError,
        agentState: translationState.agentState,
        selectedCategories: translationState.selectedCategories,
        availableCategories: translationState.availableCategories,
        recentDiffItems: translationState.recentDiffItems,
        toolset: runtime && runtime.toolset ? runtime.toolset : null,
        effectiveToolPolicy: runtime && runtime.effectiveToolPolicy ? runtime.effectiveToolPolicy : null,
        effectiveToolPolicyReasons: runtime && runtime.effectiveToolPolicyReasons ? runtime.effectiveToolPolicyReasons : null,
        security: runtime && runtime.security ? runtime.security : null,
        negotiation: runtime && runtime.negotiation ? runtime.negotiation : null,
        serverCaps: runtime && runtime.serverCaps ? runtime.serverCaps : null
      };
    }

    async buildTranslationStateSnapshot(tabId) {
      if (!this.translationJobStore) {
        return {
          tabId: null,
          translationJob: null,
          translationProgress: 0,
          failedBlocksCount: 0,
          lastError: null,
          agentState: null,
          selectedCategories: [],
          availableCategories: [],
          recentDiffItems: []
        };
      }
      const resolvedTabId = (tabId === null || tabId === undefined)
        ? await this._guessTabIdFromActiveJobs()
        : tabId;
      if (resolvedTabId === null || resolvedTabId === undefined) {
        return {
          tabId: null,
          translationJob: null,
          translationProgress: 0,
          failedBlocksCount: 0,
          lastError: null,
          agentState: null,
          selectedCategories: [],
          availableCategories: [],
          recentDiffItems: []
        };
      }
      const active = await this.translationJobStore.getActiveJob(resolvedTabId);
      const fallback = active || await this._getLastJobForTab(resolvedTabId);
      if (!fallback) {
        return {
          tabId: resolvedTabId,
          translationJob: null,
          translationProgress: 0,
          failedBlocksCount: 0,
          lastError: null,
          agentState: null,
          selectedCategories: [],
          availableCategories: [],
          recentDiffItems: []
        };
      }
      const total = Number.isFinite(Number(fallback.totalBlocks)) ? Number(fallback.totalBlocks) : 0;
      const completed = Number.isFinite(Number(fallback.completedBlocks)) ? Number(fallback.completedBlocks) : 0;
      const failedBlocksCount = Array.isArray(fallback.failedBlockIds) ? fallback.failedBlockIds.length : 0;
      const runSettings = fallback.runSettings && typeof fallback.runSettings === 'object'
        ? fallback.runSettings
        : null;
      const autoTune = runSettings && runSettings.autoTune && typeof runSettings.autoTune === 'object'
        ? runSettings.autoTune
        : null;
      const pendingProposal = autoTune && Array.isArray(autoTune.proposals)
        ? autoTune.proposals.slice().reverse().find((item) => item && item.status === 'proposed')
        : null;
      return {
        tabId: resolvedTabId,
        translationJob: {
          id: fallback.id,
          tabId: fallback.tabId,
          status: fallback.status || 'idle',
          message: fallback.message || '',
          totalBlocks: total,
          completedBlocks: completed,
          failedBlocksCount,
          currentBatchId: fallback.currentBatchId || null,
          selectedCategories: Array.isArray(fallback.selectedCategories) ? fallback.selectedCategories.slice(0, 24) : [],
          availableCategories: Array.isArray(fallback.availableCategories) ? fallback.availableCategories.slice(0, 24) : [],
          runtime: fallback.runtime && typeof fallback.runtime === 'object'
            ? {
              status: fallback.runtime.status || null,
              stage: fallback.runtime.stage || null,
              leaseUntilTs: fallback.runtime.lease && Number.isFinite(Number(fallback.runtime.lease.leaseUntilTs))
                ? Number(fallback.runtime.lease.leaseUntilTs)
                : (Number.isFinite(Number(fallback.leaseUntilTs)) ? Number(fallback.leaseUntilTs) : null),
              heartbeatTs: fallback.runtime.lease && Number.isFinite(Number(fallback.runtime.lease.heartbeatTs))
                ? Number(fallback.runtime.lease.heartbeatTs)
                : null,
              attempt: fallback.runtime.retry && Number.isFinite(Number(fallback.runtime.retry.attempt))
                ? Number(fallback.runtime.retry.attempt)
                : 0,
              nextRetryAtTs: fallback.runtime.retry && Number.isFinite(Number(fallback.runtime.retry.nextRetryAtTs))
                ? Number(fallback.runtime.retry.nextRetryAtTs)
                : 0,
              lastErrorCode: fallback.runtime.retry && fallback.runtime.retry.lastError && fallback.runtime.retry.lastError.code
                ? fallback.runtime.retry.lastError.code
                : null
            }
            : null,
          runSettings: runSettings
            ? {
              effectiveSummary: runSettings.effective && typeof runSettings.effective === 'object'
                ? runSettings.effective
                : {},
              agentOverrides: runSettings.agentOverrides && typeof runSettings.agentOverrides === 'object'
                ? runSettings.agentOverrides
                : {},
              userOverrides: runSettings.userOverrides && typeof runSettings.userOverrides === 'object'
                ? runSettings.userOverrides
                : {},
              autoTune: {
                enabled: autoTune ? autoTune.enabled !== false : true,
                mode: autoTune && autoTune.mode === 'ask_user' ? 'ask_user' : 'auto_apply',
                lastProposalId: autoTune && typeof autoTune.lastProposalId === 'string' ? autoTune.lastProposalId : null,
                pendingProposal: pendingProposal || null,
                proposals: autoTune && Array.isArray(autoTune.proposals) ? autoTune.proposals.slice(-60) : [],
                decisionLog: autoTune && Array.isArray(autoTune.decisionLog) ? autoTune.decisionLog.slice(-120) : []
              }
            }
            : null,
          updatedAt: fallback.updatedAt || null
        },
        translationProgress: total > 0
          ? Math.max(0, Math.min(100, Math.round((completed / total) * 100)))
          : (fallback.status === 'done' ? 100 : 0),
        failedBlocksCount,
        lastError: fallback.lastError || null,
        agentState: fallback.agentState || null,
        selectedCategories: Array.isArray(fallback.selectedCategories) ? fallback.selectedCategories.slice(0, 24) : [],
        availableCategories: Array.isArray(fallback.availableCategories) ? fallback.availableCategories.slice(0, 24) : [],
        recentDiffItems: Array.isArray(fallback.recentDiffItems) ? fallback.recentDiffItems.slice(-20) : []
      };
    }

    async _guessTabIdFromActiveJobs() {
      if (!this.translationJobStore || typeof this.translationJobStore.listActiveJobs !== 'function') {
        return null;
      }
      const activeJobs = await this.translationJobStore.listActiveJobs();
      if (!Array.isArray(activeJobs) || !activeJobs.length) {
        return null;
      }
      return Number.isFinite(Number(activeJobs[0].tabId)) ? Number(activeJobs[0].tabId) : null;
    }

    async _getLastJobForTab(tabId) {
      if (!this.translationJobStore || tabId === null || tabId === undefined) {
        return null;
      }
      const lastJobId = await this.translationJobStore.getLastJobId(tabId);
      if (!lastJobId) {
        return null;
      }
      return this.translationJobStore.getJob(lastJobId);
    }

    async buildModelLimitsSnapshot() {
      if (!this.aiModule || typeof this.aiModule.getModelLimitsSnapshot !== 'function' || !this.settingsStore) {
        return {};
      }
      const settings = await this.settingsStore.get(['translationModelList']);
      const modelList = Array.isArray(settings.translationModelList) ? settings.translationModelList.slice(0, 20) : [];
      return this.aiModule.getModelLimitsSnapshot({
        selectedModelSpecs: modelList,
        limit: 20,
        now: Date.now()
      });
    }

    async loadEventLogForHello(lastEventSeq) {
      const tail = await this.eventLogStore.getTail(200);
      if (typeof lastEventSeq !== 'number') {
        return tail;
      }
      const itemsAfter = tail.items.filter((item) => typeof item.seq === 'number' && item.seq > lastEventSeq);
      if (itemsAfter.length) {
        return { seq: tail.seq, items: itemsAfter };
      }
      return tail;
    }

    resolveTabId(meta, result, helloPayload = null) {
      if (meta && Number.isFinite(Number(meta.tabId))) {
        return Number(meta.tabId);
      }
      if (helloPayload && Number.isFinite(Number(helloPayload.tabId))) {
        return Number(helloPayload.tabId);
      }
      if (result && Number.isFinite(Number(result.activeTabId))) {
        return Number(result.activeTabId);
      }
      return null;
    }

    async handleEventLogPage(port, envelope) {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      const payload = envelope && envelope.payload && envelope.payload.payload ? envelope.payload.payload : {};
      const beforeSeq = typeof payload.beforeSeq === 'number' ? payload.beforeSeq : null;
      const limit = this.clampPageLimit(payload.limit);
      const result = beforeSeq
        ? await this.eventLogStore.getBefore(beforeSeq, limit)
        : await this.eventLogStore.getTail(limit);
      const patchPayload = {
        type: UiProtocol.UI_EVENT_LOG_PAGE_RESULT,
        requestId: envelope && envelope.meta ? envelope.meta.requestId || null : null,
        seq: result.seq,
        items: result.items,
        isTail: !beforeSeq
      };
      this.sendPatchToPort(port, patchPayload, { stage: 'event-log-page', requestId: patchPayload.requestId });
    }

    clampPageLimit(limit) {
      const value = Number(limit);
      if (!Number.isFinite(value)) {
        return 200;
      }
      return Math.max(50, Math.min(400, Math.floor(value)));
    }

    broadcastPatch(payload) {
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }
      const envelope = MessageEnvelope.wrap(global.NT.UiProtocol.UI_PATCH, payload, {
        source: 'background',
        stage: 'patch'
      });
      this.subscribers.forEach((port) => this.safePost(port, envelope));
    }

    broadcastEventAppend(entry) {
      if (!entry || !entry.item) {
        return;
      }
      this.broadcastPatch({ eventLogAppend: { seq: entry.seq, item: entry.item } });
    }

    broadcastEventReset() {
      this.broadcastPatch({ eventLogReset: true });
    }

    sendPatchToPort(port, payload, { stage = 'patch', requestId = null } = {}) {
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }
      const envelope = MessageEnvelope.wrap(global.NT.UiProtocol.UI_PATCH, payload, {
        source: 'background',
        stage,
        requestId
      });
      this.safePost(port, envelope);
    }

    safePost(port, message) {
      try {
        port.postMessage(message);
      } catch (_) {
        this.subscribers.delete(port);
      }
    }

    unwrapEnvelope(message) {
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope || !MessageEnvelope.isEnvelope) {
        return null;
      }
      return MessageEnvelope.isEnvelope(message) ? message : null;
    }

    logEvent(level, tag, message, meta) {
      if (!this.onEvent) {
        return;
      }
      this.onEvent({ level, tag, message, meta });
    }

    getUiCapsSnapshot() {
      return cloneJson(this.uiCapsByPort, {});
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.UiPortHub = UiPortHub;
})(globalThis);
