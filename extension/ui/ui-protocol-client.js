(function initUiProtocolClient(global) {
  const NT = global.NT || (global.NT = {});

  const DEFAULT_BACKOFF = [200, 500, 1200, 2200, 5000];

  class UiProtocolClient {
    constructor({ channelName } = {}) {
      this.channelName = channelName === 'debug' ? 'debug' : 'popup';
      this.portName = `ui:${this.channelName}`;
      this.port = null;

      this.closed = false;
      this.connected = false;
      this.handshakeDone = false;
      this.reconnectAttempt = 0;
      this.reconnectTimer = null;
      this.backoff = DEFAULT_BACKOFF.slice();

      this.helloContext = { tabId: null };
      this.statusListeners = [];
      this.snapshotListeners = [];
      this.patchListeners = [];

      this.pendingSnapshotWaiter = null;
      this.pendingCommands = new Map();
      this.latestSnapshot = null;

      this._boundMessage = (message) => this._onMessage(message);
      this._boundDisconnect = () => this._onDisconnect();
    }

    setHelloContext(context = {}) {
      const tabId = Number(context.tabId);
      this.helloContext = {
        tabId: Number.isFinite(tabId) ? Number(tabId) : null
      };
    }

    onStatus(cb) {
      if (typeof cb === 'function') {
        this.statusListeners.push(cb);
      }
      return this;
    }

    onSnapshot(cb) {
      if (typeof cb === 'function') {
        this.snapshotListeners.push(cb);
      }
      return this;
    }

    onPatch(cb) {
      if (typeof cb === 'function') {
        this.patchListeners.push(cb);
      }
      return this;
    }

    connect() {
      this.closed = false;
      this._clearReconnect();
      this._connectNow();
      return this;
    }

    disconnect() {
      this.closed = true;
      this._clearReconnect();
      this._setDisconnectedState('disconnected', 'Отключено');
      this._rejectPendingCommands({ code: 'CLIENT_CLOSED', message: 'UI client closed' });
      this._teardownPort();
    }

    async sendCommand(type, payload = {}, options = {}) {
      const name = typeof type === 'string' ? type.trim() : '';
      if (!name) {
        throw new Error('UI command type is required');
      }
      const timeoutMs = Math.max(500, Number(options.timeoutMs) || 4500);
      const retries = Math.max(0, Number(options.retries) || 1);
      const connectTimeoutMs = Math.max(1000, Number(options.connectTimeoutMs) || 6000);

      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          await this._waitForReady(connectTimeoutMs);
          const response = await this._sendCommandOnce(name, payload, timeoutMs);
          return response;
        } catch (error) {
          lastError = error;
          if (attempt >= retries) {
            break;
          }
          await this._sleep(Math.min(1800, 220 + (attempt * 380)));
        }
      }
      throw (lastError || new Error('UI command failed'));
    }

    _connectNow() {
      if (this.closed) {
        return;
      }
      this._teardownPort();
      this.connected = false;
      this.handshakeDone = false;
      this._emitStatus('connecting', 'Подключаюсь к фону...');

      if (!global.chrome || !global.chrome.runtime || typeof global.chrome.runtime.connect !== 'function') {
        this._scheduleReconnect('API chrome.runtime.connect недоступен');
        return;
      }

      let port = null;
      try {
        port = global.chrome.runtime.connect({ name: this.portName });
      } catch (_) {
        this._scheduleReconnect('Не удалось открыть runtime-порт');
        return;
      }

      this.port = port;
      this.connected = true;
      try {
        this.port.onMessage.addListener(this._boundMessage);
        this.port.onDisconnect.addListener(this._boundDisconnect);
      } catch (_) {
        this._scheduleReconnect('Ошибка подписки на события порта');
        return;
      }
      this._handshake();
    }

    async _handshake() {
      if (this.closed || !this.port) {
        return;
      }
      const MessageEnvelope = NT.MessageEnvelope || null;
      const UiProtocol = NT.UiProtocol || null;
      if (!MessageEnvelope || typeof MessageEnvelope.wrap !== 'function') {
        this._scheduleReconnect('MessageEnvelope недоступен');
        return;
      }

      const requestId = MessageEnvelope.newId();
      const helloPayload = {
        ...(Number.isFinite(Number(this.helloContext.tabId)) ? { tabId: Number(this.helloContext.tabId) } : {}),
        uiCaps: {
          locale: 'ru',
          supportsAccordion: true,
          supportsPatchStream: true,
          protocolClient: 'ui-protocol-client/v1'
        }
      };

      this._post(MessageEnvelope.wrap(
        UiProtocol && UiProtocol.UI_HELLO ? UiProtocol.UI_HELLO : 'ui:hello',
        helloPayload,
        {
          source: 'ui',
          stage: 'hello',
          requestId,
          ...(Number.isFinite(Number(this.helloContext.tabId)) ? { tabId: Number(this.helloContext.tabId) } : {})
        }
      ));

      try {
        await this._waitForSnapshot(4000);
      } catch (_) {
        this._scheduleReconnect('SNAPSHOT не получен вовремя');
        return;
      }

      this._post(MessageEnvelope.wrap(
        UiProtocol && UiProtocol.UI_SUBSCRIBE ? UiProtocol.UI_SUBSCRIBE : 'ui:subscribe',
        {},
        {
          source: 'ui',
          stage: 'subscribe',
          requestId: MessageEnvelope.newId(),
          ...(Number.isFinite(Number(this.helloContext.tabId)) ? { tabId: Number(this.helloContext.tabId) } : {})
        }
      ));

      this.handshakeDone = true;
      this.reconnectAttempt = 0;
      this._emitStatus('connected', 'Связь установлена');
    }

    _waitForSnapshot(timeoutMs = 4000) {
      if (this.latestSnapshot) {
        return Promise.resolve(this.latestSnapshot);
      }
      return new Promise((resolve, reject) => {
        const timeout = global.setTimeout(() => {
          this.pendingSnapshotWaiter = null;
          reject(new Error('SNAPSHOT_TIMEOUT'));
        }, Math.max(900, Number(timeoutMs) || 4000));

        this.pendingSnapshotWaiter = {
          resolve: (payload) => {
            global.clearTimeout(timeout);
            this.pendingSnapshotWaiter = null;
            resolve(payload);
          },
          reject: (error) => {
            global.clearTimeout(timeout);
            this.pendingSnapshotWaiter = null;
            reject(error instanceof Error ? error : new Error(String(error || 'SNAPSHOT_FAILED')));
          }
        };
      });
    }

    async _waitForReady(timeoutMs = 6000) {
      if (this.connected && this.handshakeDone && this.port) {
        return true;
      }
      const startedAt = Date.now();
      while ((Date.now() - startedAt) < Math.max(1000, Number(timeoutMs) || 6000)) {
        if (this.connected && this.handshakeDone && this.port) {
          return true;
        }
        await this._sleep(80);
      }
      throw new Error('UI_NOT_CONNECTED');
    }

    _sendCommandOnce(commandName, payload, timeoutMs) {
      const MessageEnvelope = NT.MessageEnvelope || null;
      const UiProtocol = NT.UiProtocol || null;
      if (!this.port || !MessageEnvelope || typeof MessageEnvelope.wrap !== 'function') {
        return Promise.reject(new Error('UI_NOT_CONNECTED'));
      }

      const requestId = MessageEnvelope.newId();
      return new Promise((resolve, reject) => {
        const timeout = global.setTimeout(() => {
          this.pendingCommands.delete(requestId);
          reject(new Error('UI_COMMAND_TIMEOUT'));
        }, Math.max(500, Number(timeoutMs) || 4500));

        this.pendingCommands.set(requestId, {
          resolve: (result) => {
            global.clearTimeout(timeout);
            resolve(result);
          },
          reject: (error) => {
            global.clearTimeout(timeout);
            reject(error instanceof Error ? error : new Error(String(error || 'UI_COMMAND_FAILED')));
          }
        });

        this._post(MessageEnvelope.wrap(
          UiProtocol && UiProtocol.UI_COMMAND ? UiProtocol.UI_COMMAND : 'ui:command',
          {
            name: commandName,
            payload: payload && typeof payload === 'object' ? payload : {}
          },
          {
            source: 'ui',
            stage: 'command',
            requestId,
            ...(Number.isFinite(Number(this.helloContext.tabId)) ? { tabId: Number(this.helloContext.tabId) } : {})
          }
        ));
      });
    }

    _onMessage(message) {
      const envelope = this._unwrapEnvelope(message);
      if (!envelope) {
        return;
      }
      const UiProtocol = NT.UiProtocol || {};
      if (envelope.type === (UiProtocol.UI_SNAPSHOT || 'ui:snapshot')) {
        const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
        this.latestSnapshot = payload;
        if (this.pendingSnapshotWaiter && typeof this.pendingSnapshotWaiter.resolve === 'function') {
          this.pendingSnapshotWaiter.resolve(payload);
        }
        this._emitSnapshot(payload);
        return;
      }

      if (envelope.type === (UiProtocol.UI_PATCH || 'ui:patch')) {
        const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};
        this._resolveCommandAck(payload);
        this._emitPatch(payload);
      }
    }

    _resolveCommandAck(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const UiProtocol = NT.UiProtocol || {};
      const type = typeof payload.type === 'string' ? payload.type : '';
      const isAck = type === (UiProtocol.UI_COMMAND_RESULT || 'ui:command:result')
        || type === (UiProtocol.UI_SETTINGS_RESULT || 'ui:settings:result');
      if (!isAck) {
        return;
      }
      const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
      if (!requestId || !this.pendingCommands.has(requestId)) {
        return;
      }
      const waiter = this.pendingCommands.get(requestId);
      this.pendingCommands.delete(requestId);
      if (!waiter) {
        return;
      }
      if (payload.ok === false) {
        const errorMessage = payload.error && payload.error.message
          ? payload.error.message
          : 'Команда завершилась с ошибкой';
        waiter.reject(new Error(errorMessage));
        return;
      }
      waiter.resolve(payload.result && typeof payload.result === 'object' ? payload.result : payload);
    }

    _onDisconnect() {
      if (this.closed) {
        return;
      }
      this._setDisconnectedState('reconnecting', 'Нет связи, переподключаюсь...');
      this._rejectPendingCommands({ code: 'PORT_DISCONNECTED', message: 'Порт отключен' });
      if (this.pendingSnapshotWaiter && typeof this.pendingSnapshotWaiter.reject === 'function') {
        this.pendingSnapshotWaiter.reject(new Error('PORT_DISCONNECTED'));
      }
      this._scheduleReconnect('Нет связи, переподключаюсь...');
    }

    _setDisconnectedState(state, message) {
      this.connected = false;
      this.handshakeDone = false;
      this._teardownPort();
      this._emitStatus(state, message);
    }

    _scheduleReconnect(reason) {
      if (this.closed) {
        return;
      }
      this._clearReconnect();
      const idx = Math.min(this.reconnectAttempt, this.backoff.length - 1);
      const delay = this.backoff[idx];
      this.reconnectAttempt += 1;
      this._emitStatus('reconnecting', reason || 'Нет связи, переподключаюсь...');
      this.reconnectTimer = global.setTimeout(() => {
        this.reconnectTimer = null;
        this._connectNow();
      }, delay);
    }

    _clearReconnect() {
      if (this.reconnectTimer) {
        global.clearTimeout(this.reconnectTimer);
      }
      this.reconnectTimer = null;
    }

    _teardownPort() {
      if (!this.port) {
        return;
      }
      try {
        if (this.port.onMessage && typeof this.port.onMessage.removeListener === 'function') {
          this.port.onMessage.removeListener(this._boundMessage);
        }
      } catch (_) {
        // ignore
      }
      try {
        if (this.port.onDisconnect && typeof this.port.onDisconnect.removeListener === 'function') {
          this.port.onDisconnect.removeListener(this._boundDisconnect);
        }
      } catch (_) {
        // ignore
      }
      try {
        this.port.disconnect();
      } catch (_) {
        // ignore
      }
      this.port = null;
    }

    _rejectPendingCommands(errorLike) {
      const error = new Error(
        errorLike && errorLike.message
          ? String(errorLike.message)
          : 'UI command failed'
      );
      const ids = Array.from(this.pendingCommands.keys());
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        const waiter = this.pendingCommands.get(id);
        this.pendingCommands.delete(id);
        if (waiter && typeof waiter.reject === 'function') {
          waiter.reject(error);
        }
      }
    }

    _emitStatus(state, message) {
      const payload = {
        state,
        message,
        channelName: this.channelName,
        ts: Date.now()
      };
      for (let i = 0; i < this.statusListeners.length; i += 1) {
        try {
          this.statusListeners[i](payload);
        } catch (_) {
          // ignore listener errors
        }
      }
    }

    _emitSnapshot(snapshot) {
      for (let i = 0; i < this.snapshotListeners.length; i += 1) {
        try {
          this.snapshotListeners[i](snapshot);
        } catch (_) {
          // ignore listener errors
        }
      }
    }

    _emitPatch(patch) {
      for (let i = 0; i < this.patchListeners.length; i += 1) {
        try {
          this.patchListeners[i](patch);
        } catch (_) {
          // ignore listener errors
        }
      }
    }

    _post(envelope) {
      if (!this.port) {
        return;
      }
      try {
        this.port.postMessage(envelope);
      } catch (_) {
        this._onDisconnect();
      }
    }

    _unwrapEnvelope(message) {
      const MessageEnvelope = NT.MessageEnvelope || null;
      if (!MessageEnvelope || typeof MessageEnvelope.isEnvelope !== 'function') {
        return null;
      }
      return MessageEnvelope.isEnvelope(message) ? message : null;
    }

    _sleep(ms) {
      return new Promise((resolve) => {
        global.setTimeout(resolve, Math.max(20, Number(ms) || 60));
      });
    }
  }

  NT.UiProtocolClient = UiProtocolClient;
})(globalThis);
