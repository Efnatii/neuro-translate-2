/**
 * Background runtime-port hub for popup/debug synchronization.
 *
 * `UiPortHub` handles unstable MV3 port lifecycle, serves HELLO snapshots from
 * dedicated stores (without wide full-storage reads), and broadcasts incremental
 * patches to subscribers.
 *
 * Event log transport is delta-based: snapshot returns tail/delta, patch emits
 * append/reset notifications, and older pages are fetched via command replies
 * targeted only to requesting port.
 *
 * Snapshot also includes compact per-model limit state (`modelLimitsBySpec`) so
 * debug UI can show cooldown/reservations/waiting context without direct store
 * reads in UI controllers.
 */
(function initUiPortHub(global) {
  class UiPortHub {
    constructor({ settingsStore, tabStateStore, eventLogStore, benchmarkStore, rateLimitStore, onCommand, onEvent } = {}) {
      this.subscribers = new Set();
      this.settingsStore = settingsStore || null;
      this.tabStateStore = tabStateStore || null;
      this.eventLogStore = eventLogStore || null;
      this.benchmarkStore = benchmarkStore || null;
      this.rateLimitStore = rateLimitStore || null;
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
      if (!this.settingsStore || !this.tabStateStore || !this.eventLogStore || !this.benchmarkStore) {
        return { settings: {}, tabId: null, translationStatusByTab: {}, eventLog: { seq: 0, items: [] } };
      }
      const helloPayload = envelope && envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
      const lastEventSeq = typeof helloPayload.lastEventSeq === 'number' ? helloPayload.lastEventSeq : null;
      const settings = await this.settingsStore.getPublicSnapshot();
      const visibilityData = await this.settingsStore.get(['translationVisibilityByTab', 'activeTabId']);
      const translationStatusByTab = await this.tabStateStore.getAllStatus();
      const benchmarkData = await this.benchmarkStore.storageGet({ modelBenchmarkStatus: null, modelBenchmarks: {} });
      const eventLog = await this.loadEventLogForHello(lastEventSeq);
      const modelLimitsBySpec = await this.buildModelLimitsSnapshot();
      const tabId = this.resolveTabId(envelope && envelope.meta ? envelope.meta : null, visibilityData);

      return {
        settings,
        tabId,
        translationStatusByTab,
        translationVisibilityByTab: visibilityData.translationVisibilityByTab || {},
        modelBenchmarkStatus: benchmarkData.modelBenchmarkStatus || null,
        modelBenchmarks: benchmarkData.modelBenchmarks || {},
        modelLimitsBySpec,
        eventLog
      };
    }

    async buildModelLimitsSnapshot() {
      if (!this.rateLimitStore) {
        return {};
      }
      const now = Date.now();
      const all = await this.rateLimitStore.getAll();
      const settings = await this.settingsStore.get(['translationModelList']);
      const modelList = Array.isArray(settings.translationModelList) ? settings.translationModelList.slice(0, 20) : [];
      const keys = modelList.length ? modelList : Object.keys(all).slice(0, 20);
      const out = {};
      keys.forEach((modelSpec) => {
        const snapshot = all[modelSpec] || null;
        if (!snapshot) {
          return;
        }
        const reserved = typeof this.rateLimitStore._sumReservations === 'function'
          ? this.rateLimitStore._sumReservations(snapshot, now)
          : { tokens: 0, requests: 0 };
        out[modelSpec] = {
          cooldownUntilTs: snapshot.cooldownUntilTs || null,
          remainingRequests: snapshot.remainingRequests === undefined ? null : snapshot.remainingRequests,
          remainingTokens: snapshot.remainingTokens === undefined ? null : snapshot.remainingTokens,
          limitRequests: snapshot.limitRequests === undefined ? null : snapshot.limitRequests,
          limitTokens: snapshot.limitTokens === undefined ? null : snapshot.limitTokens,
          resetRequestsAt: snapshot.resetRequestsAt || null,
          resetTokensAt: snapshot.resetTokensAt || null,
          reservedRequests: reserved.requests || 0,
          reservedTokens: reserved.tokens || 0
        };
      });
      return out;
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
