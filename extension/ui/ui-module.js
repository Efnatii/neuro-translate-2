/**
 * Thin UI facade for popup/debug communication with background.
 *
 * `UiModule` holds only in-memory state and delegates all critical commands to
 * `UiPortClient` request/response channel.
 *
 * Contracts:
 * - no direct storage access from UI layer;
 * - snapshot/patch are cached for render recovery after reconnect;
 * - settings patches are debounced and sent as acknowledged commands;
 * - command failures are captured in `lastUiError` with code/message/timestamp.
 *
 * This module does not contain AI logic or DOM rendering code.
 */
(function initUiModule(global) {
  const NT = global.NT || (global.NT = {});

  class UiModule {
    constructor({ chromeApi, portName, onSnapshot, onPatch, onUiError, settingsPatchDebounceMs = 320 } = {}) {
      this.chromeApi = chromeApi;
      this.portName = portName;
      this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : null;
      this.onPatch = typeof onPatch === 'function' ? onPatch : null;
      this.onUiError = typeof onUiError === 'function' ? onUiError : null;
      this.settingsPatchDebounceMs = Number.isFinite(Number(settingsPatchDebounceMs))
        ? Math.max(250, Math.min(400, Number(settingsPatchDebounceMs)))
        : 320;

      this.portClient = null;
      this._lastEventSeq = 0;

      this.lastSnapshot = null;
      this.lastSettings = {
        hasApiKey: false,
        apiKeyLength: 0,
        translationModelList: [],
        modelSelection: { speed: true, preference: null },
        modelSelectionPolicy: null
      };
      this.modelOptions = [];
      this.lastUiError = null;

      this.pendingSettingsPatch = {};
      this.settingsPatchTimer = null;

      this._firstSnapshotResolved = false;
      this._firstSnapshotPromise = new Promise((resolve) => {
        this._resolveFirstSnapshot = resolve;
      });
    }

    init() {
      const UiPortClient = NT.UiPortClient || null;
      if (UiPortClient) {
        this.portClient = new UiPortClient({
          portName: this.portName,
          getHelloPayload: () => ({ lastEventSeq: this._lastEventSeq || 0 }),
          onSnapshot: (payload) => {
            this._trackEventSeq(payload);
            this._applyIncomingSnapshot(payload);
            if (!this._firstSnapshotResolved && this._resolveFirstSnapshot) {
              this._firstSnapshotResolved = true;
              this._resolveFirstSnapshot(payload || {});
            }
            if (this.onSnapshot) {
              this.onSnapshot(payload || {});
            }
          },
          onPatch: (payload) => {
            this._trackEventSeq(payload);
            this._applyIncomingPatch(payload);
            if (this.onPatch) {
              this.onPatch(payload || {});
            }
          }
        });
        this.portClient.connect();
      }

      return this;
    }

    setHandlers({ onSnapshot, onPatch, onUiError } = {}) {
      this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : this.onSnapshot;
      this.onPatch = typeof onPatch === 'function' ? onPatch : this.onPatch;
      this.onUiError = typeof onUiError === 'function' ? onUiError : this.onUiError;
    }

    waitForFirstSnapshot() {
      return this._firstSnapshotPromise;
    }

    getLastUiError() {
      return this.lastUiError ? { ...this.lastUiError } : null;
    }

    clearLastUiError() {
      this.lastUiError = null;
    }

    getCachedSettings() {
      return {
        hasApiKey: Boolean(this.lastSettings.hasApiKey),
        apiKeyLength: Number(this.lastSettings.apiKeyLength || 0),
        translationModelList: Array.isArray(this.lastSettings.translationModelList)
          ? this.lastSettings.translationModelList.slice()
          : [],
        modelSelection: this.lastSettings.modelSelection && typeof this.lastSettings.modelSelection === 'object'
          ? { ...this.lastSettings.modelSelection }
          : { speed: true, preference: null },
        modelSelectionPolicy: this.lastSettings.modelSelectionPolicy || null
      };
    }

    getCachedModelOptions() {
      return Array.isArray(this.modelOptions) ? this.modelOptions.slice() : [];
    }

    _trackEventSeq(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      if (payload.eventLog && typeof payload.eventLog.seq === 'number') {
        this._lastEventSeq = Math.max(this._lastEventSeq || 0, payload.eventLog.seq);
      }
      if (payload.eventLogAppend && typeof payload.eventLogAppend.seq === 'number') {
        this._lastEventSeq = Math.max(this._lastEventSeq || 0, payload.eventLogAppend.seq);
      }
    }

    _applyIncomingSnapshot(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      this.lastSnapshot = payload;

      if (payload.settings && typeof payload.settings === 'object') {
        this.lastSettings = {
          ...this.lastSettings,
          ...payload.settings,
          translationModelList: Array.isArray(payload.settings.translationModelList)
            ? payload.settings.translationModelList.slice()
            : this.lastSettings.translationModelList
        };
      }

      if (Array.isArray(payload.modelOptions)) {
        this.modelOptions = payload.modelOptions.slice();
      }
    }

    _applyIncomingPatch(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }

      if (payload.settings && typeof payload.settings === 'object') {
        this.lastSettings = {
          ...this.lastSettings,
          ...payload.settings,
          translationModelList: Array.isArray(payload.settings.translationModelList)
            ? payload.settings.translationModelList.slice()
            : this.lastSettings.translationModelList
        };
      }

      if (Array.isArray(payload.modelOptions)) {
        this.modelOptions = payload.modelOptions.slice();
      }

      if (payload.patch && typeof payload.patch === 'object') {
        const patch = payload.patch;
        const nextSettings = { ...this.lastSettings };
        const allowedKeys = ['hasApiKey', 'apiKeyLength', 'translationModelList', 'modelSelection', 'modelSelectionPolicy'];
        allowedKeys.forEach((key) => {
          if (!Object.prototype.hasOwnProperty.call(patch, key)) {
            return;
          }
          if (key === 'translationModelList') {
            nextSettings.translationModelList = Array.isArray(patch.translationModelList)
              ? patch.translationModelList.slice()
              : nextSettings.translationModelList;
            return;
          }
          nextSettings[key] = patch[key];
        });
        this.lastSettings = nextSettings;
      }
    }

    getActiveTab() {
      if (!this.chromeApi || !this.chromeApi.tabs || typeof this.chromeApi.tabs.query !== 'function') {
        return Promise.resolve(null);
      }

      return new Promise((resolve) => {
        this.chromeApi.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve(tabs && tabs.length ? tabs[0] : null);
        });
      });
    }

    openDebug({ tabId, url }) {
      if (!this.chromeApi || !this.chromeApi.tabs || !this.chromeApi.runtime) {
        return;
      }
      const safeTabId = tabId === null || tabId === undefined ? '' : tabId;
      const safeUrl = url || '';
      const debugUrl = `${this.chromeApi.runtime.getURL('ui/debug.html')}?tabId=${safeTabId}&url=${encodeURIComponent(safeUrl)}`;
      this.chromeApi.tabs.create({ url: debugUrl });
    }

    queueSettingsPatch(patch) {
      if (!patch || typeof patch !== 'object') {
        return;
      }
      this.pendingSettingsPatch = { ...this.pendingSettingsPatch, ...patch };

      if (this.settingsPatchTimer) {
        global.clearTimeout(this.settingsPatchTimer);
      }

      this.settingsPatchTimer = global.setTimeout(async () => {
        const payload = { ...this.pendingSettingsPatch };
        this.pendingSettingsPatch = {};
        this.settingsPatchTimer = null;
        try {
          await this.sendUiCommand('SETTINGS_PATCH', { patch: payload }, { timeoutMs: 15000 });
        } catch (_) {
          // handled inside sendUiCommand
        }
      }, this.settingsPatchDebounceMs);
    }

    async requestApiKey() {
      return this.sendUiCommand('GET_API_KEY', {}, { timeoutMs: 8000 });
    }

    async sendUiCommand(name, payload, { timeoutMs = 15000 } = {}) {
      if (!this.portClient || typeof this.portClient.sendCommand !== 'function') {
        const error = Object.assign(new Error('UI command transport unavailable'), { code: 'UI_COMMAND_TRANSPORT_MISSING' });
        this._setUiError(error);
        throw error;
      }

      try {
        const result = await this.portClient.sendCommand(name, payload || {}, { timeoutMs });
        this.lastUiError = null;
        return result;
      } catch (error) {
        this._setUiError(error);
        throw error;
      }
    }

    _setUiError(error) {
      this.lastUiError = {
        code: error && error.code ? error.code : 'UI_COMMAND_FAILED',
        message: error && error.message ? error.message : 'Command failed',
        ts: Date.now()
      };
      if (this.onUiError) {
        this.onUiError(this.getLastUiError());
      }
    }

    async setVisibility(tabId, visible) {
      if (tabId === null || tabId === undefined) {
        return;
      }

      if (this.chromeApi && this.chromeApi.tabs && typeof this.chromeApi.tabs.sendMessage === 'function') {
        try {
          await new Promise((resolve, reject) => {
            this.chromeApi.tabs.sendMessage(
              tabId,
              { type: 'SET_TRANSLATION_VISIBILITY', visible: Boolean(visible) },
              () => {
                const error = this.chromeApi.runtime && this.chromeApi.runtime.lastError;
                if (error) {
                  reject(error);
                  return;
                }
                resolve();
              }
            );
          });
        } catch (_) {
          // ignore tab message failures
        }
      }
    }
  }

  NT.UiModule = UiModule;
})(globalThis);
