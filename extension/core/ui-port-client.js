(function initUiPortClient(global) {
  class UiPortClient {
    constructor({ portName, onSnapshot, onPatch }) {
      this.portName = portName;
      this.onSnapshot = onSnapshot;
      this.onPatch = onPatch;
      this.port = null;
      this.retryDelay = 300;
      this.retryTimer = null;
      this.connected = false;
    }

    connect() {
      if (!global.chrome || !global.chrome.runtime || typeof global.chrome.runtime.connect !== 'function') {
        return;
      }

      this.clearRetry();
      this.port = global.chrome.runtime.connect({ name: this.portName });
      this.connected = true;
      this.port.onMessage.addListener((message) => this.handleMessage(message));
      this.port.onDisconnect.addListener(() => this.handleDisconnect());
      this.startHandshake();
    }

    handleMessage(message) {
      const envelope = this.unwrapEnvelope(message);
      if (!envelope) {
        return;
      }

      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};

      if (envelope.type === UiProtocol.UI_SNAPSHOT && this.onSnapshot) {
        this.onSnapshot(envelope.payload || {});
        return;
      }

      if (envelope.type === UiProtocol.UI_PATCH && this.onPatch) {
        this.onPatch(envelope.payload || {});
      }
    }

    handleDisconnect() {
      this.connected = false;
      this.port = null;
      this.scheduleReconnect();
    }

    startHandshake() {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;

      if (!MessageEnvelope) {
        return;
      }

      const source = this.portName;
      this.postEnvelope(MessageEnvelope.wrap(UiProtocol.UI_HELLO, {}, { source, stage: 'handshake' }));
    }

    sendCommand(name, payload) {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;

      if (!MessageEnvelope) {
        return;
      }

      this.postEnvelope(MessageEnvelope.wrap(UiProtocol.UI_COMMAND, { name, payload }, { source: this.portName }));
    }

    acknowledgeSnapshot() {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;

      if (!MessageEnvelope) {
        return;
      }

      this.postEnvelope(MessageEnvelope.wrap(UiProtocol.UI_SUBSCRIBE, {}, { source: this.portName }));
    }

    postEnvelope(envelope) {
      if (!this.port) {
        return;
      }

      try {
        this.port.postMessage(envelope);
      } catch (error) {
        // ignore post errors
      }
    }

    unwrapEnvelope(message) {
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope || !MessageEnvelope.isEnvelope) {
        return null;
      }
      return MessageEnvelope.isEnvelope(message) ? message : null;
    }

    scheduleReconnect() {
      if (this.retryTimer) {
        return;
      }

      const delay = Math.min(this.retryDelay, 5000);
      this.retryTimer = global.setTimeout(() => {
        this.retryTimer = null;
        this.retryDelay = Math.min(this.retryDelay * 1.6, 5000);
        this.connect();
      }, delay);
    }

    clearRetry() {
      if (this.retryTimer) {
        global.clearTimeout(this.retryTimer);
        this.retryTimer = null;
      }
      this.retryDelay = 300;
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.UiPortClient = UiPortClient;
})(globalThis);
