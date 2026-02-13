/**
 * Runtime UI port hub with snapshot streaming and command bus dispatch.
 *
 * `UiPortHub` manages popup/debug subscriptions and delegates command requests
 * to `BackgroundApp` through one strict request contract.
 *
 * Contracts:
 * - handshake remains HELLO -> SNAPSHOT -> SUBSCRIBE;
 * - `ui:command` is handled only via `MessageBus` request handlers;
 * - command requests always receive ACK/RESPONSE from the bus;
 * - snapshot payload includes AI/UI/env state without secrets.
 *
 * This module does not implement business logic for commands.
 */
(function initUiPortHub(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  class UiPortHub {
    constructor({ settingsStore, tabStateStore, eventLogStore, aiFacade, offscreenExecutor, redactor, onCommand, onEvent } = {}) {
      this.subscribers = new Set();
      this.portBuses = new Map();
      this.settingsStore = settingsStore || null;
      this.tabStateStore = tabStateStore || null;
      this.eventLogStore = eventLogStore || null;
      this.aiFacade = aiFacade || null;
      this.offscreenExecutor = offscreenExecutor || null;
      this.redactor = redactor || new NT.Redactor();
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

        const MessageBus = NT.MessageBus || null;
        const bus = MessageBus ? new MessageBus({ source: 'bg-ui-hub' }) : null;
        if (bus) {
          bus.attachPort(port);
          bus.on(NT.UiProtocol.UI_COMMAND, async (envelope) => {
            const payload = envelope && envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
            const name = payload && payload.name ? payload.name : null;
            if (!name) {
              const error = new Error('Missing command name');
              error.code = 'BAD_COMMAND';
              throw error;
            }
            if (!this.onCommand) {
              const error = new Error('Command handler unavailable');
              error.code = 'NO_COMMAND_HANDLER';
              throw error;
            }
            return this.onCommand({
              name,
              payload: payload.payload || {},
              port,
              env: envelope
            });
          });
          this.portBuses.set(port, bus);
        }

        port.onMessage.addListener((message) => {
          this.handleHandshakeMessage(port, message).catch(() => {});
        });
        port.onDisconnect.addListener(() => {
          this.subscribers.delete(port);
          this.portBuses.delete(port);
          this.logEvent('warn', 'ui', 'Port disconnected', { source: port.name });
        });
      });
    }

    async handleHandshakeMessage(port, message) {
      const envelope = this.unwrapEnvelope(message);
      if (!envelope) {
        return;
      }
      const UiProtocol = NT && NT.UiProtocol ? NT.UiProtocol : {};

      if (envelope.type === UiProtocol.UI_HELLO) {
        this.logEvent('info', 'ui', 'UI hello', { source: port.name, stage: 'hello' });
        await this.sendSnapshot(port, envelope);
        return;
      }
      if (envelope.type === UiProtocol.UI_SUBSCRIBE) {
        this.subscribers.add(port);
        this.logEvent('info', 'ui', 'UI subscribed', { source: port.name, stage: 'subscribe' });
      }
    }

    async sendSnapshot(port, envelope) {
      const MessageEnvelope = NT && NT.MessageEnvelope ? NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }
      const snapshot = await this.loadSnapshot(envelope);
      const wrapped = MessageEnvelope.wrap(NT.UiProtocol.UI_SNAPSHOT, snapshot, {
        source: 'background',
        stage: 'snapshot',
        requestId: envelope && envelope.meta ? envelope.meta.requestId || null : null
      });
      this.safePost(port, wrapped);
    }

    async loadSnapshot(envelope) {
      if (!this.settingsStore || !this.tabStateStore || !this.eventLogStore) {
        const snapshot = {
          settings: {},
          modelOptions: [],
          tabId: null,
          translationStatusByTab: {},
          eventLog: { seq: 0, items: [] },
          env: {
            offscreenMode: this.offscreenExecutor ? this.offscreenExecutor.mode || 'unknown' : 'unknown',
            offscreenDisabledReason: this.offscreenExecutor ? this.offscreenExecutor.disabledReason || null : null
          }
        };
        return this.redactor.redactSnapshot(snapshot);
      }

      const helloPayload = envelope && envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
      const lastEventSeq = typeof helloPayload.lastEventSeq === 'number' ? helloPayload.lastEventSeq : null;

      const settings = await this.settingsStore.getPublicSnapshot(this.redactor);
      const rawSettings = await this.settingsStore.get(['translationModelList', 'translationVisibilityByTab', 'activeTabId']);
      const translationStatusByTab = await this.tabStateStore.getAllStatus();
      const eventLog = await this.loadEventLogForHello(lastEventSeq);
      const tabId = this.resolveTabId(envelope && envelope.meta ? envelope.meta : null, rawSettings);

      const selected = Array.isArray(rawSettings.translationModelList) ? rawSettings.translationModelList : [];
      const aiSnap = this.aiFacade
        ? await this.aiFacade.getUiSnapshot({ selectedModelSpecs: selected, maxModels: 20 })
        : { modelOptions: [], modelBenchmarkStatus: null, modelBenchmarks: {}, modelLimitsBySpec: {} };

      const snapshot = {
        settings,
        tabId,
        translationStatusByTab,
        translationVisibilityByTab: rawSettings.translationVisibilityByTab || {},
        modelBenchmarkStatus: aiSnap.modelBenchmarkStatus,
        modelBenchmarks: aiSnap.modelBenchmarks,
        modelLimitsBySpec: aiSnap.modelLimitsBySpec,
        modelOptions: aiSnap.modelOptions,
        eventLog,
        env: {
          offscreenMode: this.offscreenExecutor ? this.offscreenExecutor.mode || 'unknown' : 'unknown',
          offscreenDisabledReason: this.offscreenExecutor ? this.offscreenExecutor.disabledReason || null : null
        }
      };
      return this.redactor.redactSnapshot(snapshot);
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

    broadcastPatch(payload) {
      const MessageEnvelope = NT && NT.MessageEnvelope ? NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }
      const envelope = MessageEnvelope.wrap(NT.UiProtocol.UI_PATCH, payload, {
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

    safePost(port, message) {
      try {
        port.postMessage(message);
      } catch (_) {
        this.subscribers.delete(port);
        this.portBuses.delete(port);
      }
    }

    unwrapEnvelope(message) {
      const MessageEnvelope = NT && NT.MessageEnvelope ? NT.MessageEnvelope : null;
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

  BG.UiPortHub = UiPortHub;
})(globalThis);
