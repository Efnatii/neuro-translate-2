/**
 * Unified UI facade for popup/debug controllers.
 *
 * `UiModule` hides browser APIs behind a small contract: settings reads/writes,
 * runtime/tab actions, and port messaging. Controllers receive snapshot/patch
 * callbacks and stay focused on rendering.
 *
 * The module tracks last known event sequence to support incremental HELLO
 * payloads and command requestIds (for paged event-log responses).
 */
(function initUiModule(global) {
  const NT = global.NT || (global.NT = {});

  class UiModule {
    constructor({ chromeApi, portName, onSnapshot, onPatch } = {}) {
      this.chromeApi = chromeApi;
      this.portName = portName;
      this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : null;
      this.onPatch = typeof onPatch === 'function' ? onPatch : null;

      this.settingsStore = null;
      this.portClient = null;
      this.ModelSelection = NT.ModelSelection || null;
      this._lastEventSeq = 0;
    }

    init() {
      this.settingsStore = new NT.SettingsStore({
        chromeApi: this.chromeApi,
        debounceMs: 400,
        defaults: {
          apiKey: '',
          translationModelList: [],
          modelSelection: { speed: true, preference: null },
          modelSelectionPolicy: null,
          translationVisibilityByTab: {}
        }
      });

      const UiPortClient = NT.UiPortClient || null;
      if (UiPortClient) {
        this.portClient = new UiPortClient({
          portName: this.portName,
          getHelloPayload: () => ({ lastEventSeq: this._lastEventSeq || 0 }),
          onSnapshot: (payload) => {
            this._trackEventSeq(payload);
            if (this.onSnapshot) {
              this.onSnapshot(payload);
            }
          },
          onPatch: (payload) => {
            this._trackEventSeq(payload);
            if (this.onPatch) {
              this.onPatch(payload);
            }
          }
        });
        this.portClient.connect();
      }

      return this;
    }

    setHandlers({ onSnapshot, onPatch } = {}) {
      this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : this.onSnapshot;
      this.onPatch = typeof onPatch === 'function' ? onPatch : this.onPatch;
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

    normalizeSelection(modelSelection, legacyPolicy) {
      return this.ModelSelection
        ? this.ModelSelection.normalize(modelSelection, legacyPolicy)
        : { speed: true, preference: null };
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

    queueSettingsPatch(patch, { finalize } = {}) {
      if (!this.settingsStore) {
        return;
      }
      this.settingsStore.queuePatch(patch, { finalize });
    }

    getSettings(keys) {
      if (!this.settingsStore) {
        return Promise.resolve({});
      }
      return this.settingsStore.get(keys);
    }

    sendUiCommand(name, payload, { requestId } = {}) {
      const MessageEnvelope = NT.MessageEnvelope || null;
      const UiProtocol = NT.UiProtocol || null;
      const resolvedRequestId = requestId || (MessageEnvelope ? MessageEnvelope.newId() : null);

      if (this.portClient && typeof this.portClient.sendCommand === 'function') {
        this.portClient.sendCommand(name, payload || {}, { requestId: resolvedRequestId });
        return resolvedRequestId;
      }

      if (!UiProtocol || !MessageEnvelope || !this.chromeApi || !this.chromeApi.runtime) {
        return resolvedRequestId;
      }

      const envelope = MessageEnvelope.wrap(UiProtocol.UI_COMMAND, { name, payload: payload || {} }, {
        source: this.portName || 'ui',
        requestId: resolvedRequestId
      });
      try {
        this.chromeApi.runtime.sendMessage(envelope);
      } catch (error) {
        // ignore fallback errors
      }
      return resolvedRequestId;
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
        } catch (error) {
          // ignore tab message failures
        }
      }

      this.queueSettingsPatch({ translationVisibilityByTab: { [tabId]: Boolean(visible) } });
    }

    getModelRegistry() {
      const AiCommon = NT.AiCommon || null;
      if (!AiCommon || typeof AiCommon.createModelRegistry !== 'function') {
        return { entries: [], byKey: {} };
      }
      return AiCommon.createModelRegistry();
    }
  }

  NT.UiModule = UiModule;
})(globalThis);
