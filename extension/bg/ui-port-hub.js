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
  class UiPortHub {
    constructor({ settingsStore, tabStateStore, eventLogStore, aiModule, onCommand, onEvent } = {}) {
      this.subscribers = new Set();
      this.settingsStore = settingsStore || null;
      this.tabStateStore = tabStateStore || null;
      this.eventLogStore = eventLogStore || null;
      this.aiModule = aiModule || null;
      this.onCommand = typeof onCommand === 'function' ? onCommand : null;
      this.onEvent = typeof onEvent === 'function' ? onEvent : null;
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
          eventLog: { seq: 0, items: [] },
          modelBenchmarkStatus: null,
          modelBenchmarks: {},
          modelLimitsBySpec: {},
          modelRegistry: { entries: [], byKey: {} }
        };
      }
      const helloPayload = envelope && envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
      const lastEventSeq = typeof helloPayload.lastEventSeq === 'number' ? helloPayload.lastEventSeq : null;
      const settings = await this.settingsStore.getPublicSnapshot();
      const visibilityData = await this.settingsStore.get(['translationVisibilityByTab', 'activeTabId']);
      const translationStatusByTab = await this.tabStateStore.getAllStatus();
      const benchmarkData = this.aiModule && typeof this.aiModule.getBenchmarkSnapshot === 'function'
        ? await this.aiModule.getBenchmarkSnapshot()
        : { modelBenchmarkStatus: null, modelBenchmarks: {} };
      const eventLog = await this.loadEventLogForHello(lastEventSeq);
      const modelLimitsBySpec = await this.buildModelLimitsSnapshot();
      const modelRegistry = this.aiModule && typeof this.aiModule.getRegistry === 'function'
        ? this.aiModule.getRegistry()
        : { entries: [], byKey: {} };
      const tabId = this.resolveTabId(envelope && envelope.meta ? envelope.meta : null, visibilityData);

      return {
        settings,
        tabId,
        translationStatusByTab,
        translationVisibilityByTab: visibilityData.translationVisibilityByTab || {},
        modelBenchmarkStatus: benchmarkData.modelBenchmarkStatus || null,
        modelBenchmarks: benchmarkData.modelBenchmarks || {},
        modelLimitsBySpec,
        modelRegistry,
        eventLog
      };
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

    resolveTabId(meta, result) {
      if (meta && typeof meta.tabId === 'number') {
        return meta.tabId;
      }
      if (result && typeof result.activeTabId === 'number') {
        return result.activeTabId;
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
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.UiPortHub = UiPortHub;
})(globalThis);
