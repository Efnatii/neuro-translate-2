/**
 * Resilient UI runtime-port client with reconnect and command bus.
 *
 * `UiPortClient` owns Port lifecycle for popup/debug and exposes strict
 * command request/response semantics through `MessageBus`.
 *
 * Contracts:
 * - handshake stays HELLO -> SNAPSHOT -> SUBSCRIBE;
 * - critical commands use ACK/RESPONSE with bounded timeouts;
 * - reconnect is bounded and pending requests fail on disconnect.
 *
 * This file does not perform DOM rendering or storage access.
 */
(function initUiPortClient(global) {
  class UiPortClient {
    constructor({ portName, onSnapshot, onPatch, getHelloPayload } = {}) {
      this.portName = portName;
      this.onSnapshot = onSnapshot;
      this.onPatch = onPatch;
      this.getHelloPayload = typeof getHelloPayload === 'function' ? getHelloPayload : null;
      this.port = null;
      this.connected = false;
      this.retryController = null;
      this.retryInFlight = null;

      const NT = global.NT || {};
      const RetryLoop = NT.RetryLoop || null;
      const MessageBus = NT.MessageBus || null;
      this.bus = MessageBus ? new MessageBus({ source: this.portName || 'ui-port-client' }) : null;

      if (this.bus) {
        const UiProtocol = NT.UiProtocol || {};
        this.bus.on(UiProtocol.UI_SNAPSHOT, (envelope) => {
          if (this.onSnapshot) {
            this.onSnapshot(envelope.payload || {});
          }
          return { received: true };
        });
        this.bus.on(UiProtocol.UI_PATCH, (envelope) => {
          if (this.onPatch) {
            this.onPatch(envelope.payload || {});
          }
          return { received: true };
        });
      }

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

      if (this.bus) {
        this.bus.attachPort(this.port);
      } else {
        this.port.onMessage.addListener((message) => this.handleMessage(message));
        this.port.onDisconnect.addListener(() => this.handleDisconnect());
      }
      this.startHandshake();
      return true;
    }

    handleMessage(message) {
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope || !MessageEnvelope.isEnvelope(message)) {
        return;
      }
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      if (message.type === UiProtocol.UI_SNAPSHOT && this.onSnapshot) {
        this.onSnapshot(message.payload || {});
        return;
      }
      if (message.type === UiProtocol.UI_PATCH && this.onPatch) {
        this.onPatch(message.payload || {});
      }
    }

    handleDisconnect() {
      this.connected = false;
      this.port = null;
      this.scheduleReconnect();
    }

    startHandshake() {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      const helloPayload = this.getHelloPayload ? this.getHelloPayload() : {};
      if (this.bus) {
        this.bus.send(UiProtocol.UI_HELLO, helloPayload || {}, { source: this.portName, stage: 'handshake' });
        return;
      }
      const MessageEnvelope = global.NT && global.NT.MessageEnvelope ? global.NT.MessageEnvelope : null;
      if (!MessageEnvelope) {
        return;
      }
      this.postEnvelope(MessageEnvelope.wrap(UiProtocol.UI_HELLO, helloPayload || {}, { source: this.portName, stage: 'handshake' }));
    }

    async sendCommand(name, payload, { timeoutMs = 15000 } = {}) {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      if (this.bus) {
        return this.bus.request(
          UiProtocol.UI_COMMAND,
          { name, payload: payload || {} },
          { source: this.portName, expectResponse: true },
          { timeoutMs }
        );
      }
      throw Object.assign(new Error('MessageBus unavailable'), { code: 'BUS_UNAVAILABLE' });
    }

    acknowledgeSnapshot() {
      const UiProtocol = global.NT && global.NT.UiProtocol ? global.NT.UiProtocol : {};
      if (this.bus) {
        this.bus.send(UiProtocol.UI_SUBSCRIBE, {}, { source: this.portName });
        return;
      }
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
      } catch (_) {
        // ignore post errors
      }
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
