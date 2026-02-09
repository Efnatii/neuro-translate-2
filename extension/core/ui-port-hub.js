(function initUiPortHub(global) {
  class UiPortHub {
    constructor({ onCommand } = {}) {
      this.subscribers = new Set();
      this.onCommand = typeof onCommand === 'function' ? onCommand : null;
    }

    attachToRuntime() {
      if (!global.chrome || !global.chrome.runtime || !global.chrome.runtime.onConnect) {
        return;
      }

      global.chrome.runtime.onConnect.addListener((port) => {
        if (!port || (port.name !== 'popup' && port.name !== 'debug')) {
          return;
        }

        port.onMessage.addListener((message) => this.handleMessage(port, message));
        port.onDisconnect.addListener(() => {
          this.subscribers.delete(port);
        });
      });
    }

    handleMessage(port, message) {
      const envelope = this.unwrapEnvelope(message);
      if (!envelope) {
        return;
      }

      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};

      if (envelope.type === UiProtocol.UI_HELLO) {
        this.sendSnapshot(port, envelope.meta);
        return;
      }

      if (envelope.type === UiProtocol.UI_SUBSCRIBE) {
        this.subscribers.add(port);
        return;
      }

      if (envelope.type === UiProtocol.UI_COMMAND && this.onCommand) {
        this.onCommand({ port, envelope });
      }
    }

    sendSnapshot(port, meta) {
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }

      this.loadSnapshot(meta, (snapshot) => {
        const envelope = MessageEnvelope.wrap(global.NT.UiProtocol.UI_SNAPSHOT, snapshot, {
          source: 'background',
          stage: 'snapshot',
          requestId: meta && meta.id ? meta.id : null
        });
        this.safePost(port, envelope);
      });
    }

    loadSnapshot(meta, callback) {
      if (!global.chrome || !global.chrome.storage || !global.chrome.storage.local) {
        callback({ settings: {}, tabId: null, translationStatusByTab: {} });
        return;
      }

      global.chrome.storage.local.get(null, (result) => {
        const settings = {
          apiKey: result.apiKey || '',
          translationModelList: Array.isArray(result.translationModelList) ? result.translationModelList : [],
          modelSelectionPolicy: result.modelSelectionPolicy || 'fastest'
        };

        const translationStatusByTab = result.translationStatusByTab || {};
        const translationVisibilityByTab = result.translationVisibilityByTab || {};
        const modelBenchmarkStatus = result.modelBenchmarkStatus || null;
        const modelBenchmarks = result.modelBenchmarks || {};
        const tabId = this.resolveTabId(meta, result);

        callback({
          settings,
          tabId,
          translationStatusByTab,
          translationVisibilityByTab,
          modelBenchmarkStatus,
          modelBenchmarks
        });
      });
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

    safePost(port, message) {
      try {
        port.postMessage(message);
      } catch (error) {
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
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.UiPortHub = UiPortHub;
})(globalThis);
