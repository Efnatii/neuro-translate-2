/**
 * Resilient UI runtime-port client with reconnect handshake.
 *
 * `UiPortClient` connects popup/debug pages to background hub, performs
 * HELLO/SUBSCRIBE handshake, and re-establishes the channel when MV3 ports are
 * disconnected.
 *
 * The client accepts `getHelloPayload` so reconnects can include incremental
 * sync hints (for example last known event sequence), reducing snapshot size.
 */
(function initUiPortClient(global) {
  class UiPortClient {
    constructor({ portName, onSnapshot, onPatch, getHelloPayload, getHelloMeta } = {}) {
      this.portName = portName;
      this.onSnapshot = onSnapshot;
      this.onPatch = onPatch;
      this.getHelloPayload = typeof getHelloPayload === 'function' ? getHelloPayload : null;
      this.getHelloMeta = typeof getHelloMeta === 'function' ? getHelloMeta : null;
      this.port = null;
      this.connected = false;
      this.retryController = null;
      this.retryInFlight = null;
      const RetryLoop = global.NT && global.NT.RetryLoop ? global.NT.RetryLoop : null;
      this.retryLoop = RetryLoop
        ? new RetryLoop({
          maxAttempts: 8,
          maxTotalMs: 60000,
          baseDelayMs: 300,
          maxDelayMs: 5000,
          multiplier: 1.6,
          jitterMs: 200
        })
        : null;
    }

    connect({ skipAbort = false } = {}) {
      if (!global.chrome || !global.chrome.runtime || typeof global.chrome.runtime.connect !== 'function') {
        return false;
      }

      if (!skipAbort) {
        this.abortRetry();
      }
      this.port = global.chrome.runtime.connect({ name: this.portName });
      this.connected = true;
      this.port.onMessage.addListener((message) => this.handleMessage(message));
      this.port.onDisconnect.addListener(() => this.handleDisconnect());
      this.startHandshake();
      return true;
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
      const helloPayload = this.getHelloPayload ? this.getHelloPayload() : {};
      const helloMeta = this.getHelloMeta ? this.getHelloMeta() : {};
      this.postEnvelope(MessageEnvelope.wrap(UiProtocol.UI_HELLO, helloPayload || {}, {
        source,
        stage: 'handshake',
        ...(helloMeta && typeof helloMeta === 'object' ? helloMeta : {})
      }));
    }

    sendCommand(name, payload, meta = {}) {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }

      this.postEnvelope(MessageEnvelope.wrap(UiProtocol.UI_COMMAND, { name, payload }, {
        source: this.portName,
        requestId: meta.requestId || null
      }));
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
      if (this.retryInFlight || !this.retryLoop) {
        return;
      }

      this.retryController = new AbortController();
      this.retryInFlight = this.retryLoop
        .run(
          () => {
            const connected = this.connect({ skipAbort: true });
            if (!connected) {
              const error = new Error('UI port reconnect failed');
              error.code = 'UI_PORT_CONNECT_FAILED';
              throw error;
            }
            return true;
          },
          { signal: this.retryController.signal }
        )
        .catch(() => {})
        .finally(() => {
          this.retryController = null;
          this.retryInFlight = null;
        });
    }

    abortRetry() {
      if (this.retryController) {
        this.retryController.abort();
        this.retryController = null;
      }
      this.retryInFlight = null;
    }
  }

  if (!global.NT) {
    global.NT = {};
  }
  global.NT.UiPortClient = UiPortClient;
})(globalThis);
