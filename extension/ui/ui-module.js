/**
 * Unified UI facade for popup/debug controllers.
 *
 * Role:
 * - Provide one UI-side narrow throat for settings, tab/runtime actions, and
 *   runtime-port command/snapshot flows.
 *
 * Public contract:
 * - Settings API: `getSettings`, `queueSettingsPatch`, `normalizeSelection`.
 * - Runtime/tab API: `getActiveTab`, `openDebug`, `setVisibility`.
 * - Command API: `sendUiCommand`.
 * - Model registry API: `getModelRegistry` from cached snapshot payloads.
 *
 * Dependencies:
 * - `SettingsStore`, `UiPortClient`, and protocol helpers (`UiProtocol`,
 *   `MessageEnvelope`).
 *
 * Side effects:
 * - Connects runtime port, dispatches UI commands, and writes debounced settings
 *   patches to `chrome.storage.local` through store abstractions.
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
      this._lastEventSeq = 0;
      this.modelRegistry = { entries: [], byKey: {} };
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
          translationVisibilityByTab: {},
          translationPipelineEnabled: false
        }
      });

      const UiPortClient = NT.UiPortClient || null;
      if (UiPortClient) {
        this.portClient = new UiPortClient({
          portName: this.portName,
          getHelloPayload: () => ({ lastEventSeq: this._lastEventSeq || 0 }),
          onSnapshot: (payload) => {
            this._trackEventSeq(payload);
            this._trackModelRegistry(payload);
            if (this.onSnapshot) {
              this.onSnapshot(payload);
            }
          },
          onPatch: (payload) => {
            this._trackEventSeq(payload);
            this._trackModelRegistry(payload);
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

    _trackModelRegistry(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const direct = payload.modelRegistry;
      const fromPatch = payload.patch && typeof payload.patch === 'object'
        ? payload.patch.modelRegistry
        : null;
      const next = direct || fromPatch;
      if (!next || typeof next !== 'object') {
        return;
      }
      const entries = Array.isArray(next.entries) ? next.entries : [];
      const byKey = next.byKey && typeof next.byKey === 'object' ? next.byKey : {};
      this.modelRegistry = {
        entries: entries.slice(),
        byKey: { ...byKey }
      };
    }

    normalizeSelection(modelSelection, legacyPolicy) {
      return this._normalizeSelection(modelSelection, legacyPolicy);
    }

    _normalizeSelection(modelSelection, legacyPolicy) {
      if (modelSelection && typeof modelSelection === 'object') {
        const preference = modelSelection.preference === 'smartest' || modelSelection.preference === 'cheapest'
          ? modelSelection.preference
          : null;
        return {
          speed: modelSelection.speed !== false,
          preference
        };
      }
      if (legacyPolicy === 'smartest') {
        return { speed: false, preference: 'smartest' };
      }
      if (legacyPolicy === 'cheapest') {
        return { speed: false, preference: 'cheapest' };
      }
      return { speed: true, preference: null };
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
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.SET_TRANSLATION_VISIBILITY
        : 'SET_TRANSLATION_VISIBILITY';
      this.sendUiCommand(command, {
        tabId,
        visible: Boolean(visible)
      });
      this.queueSettingsPatch({ translationVisibilityByTab: { [tabId]: Boolean(visible) } });
    }

    getModelRegistry() {
      return this.modelRegistry || { entries: [], byKey: {} };
    }
  }

  NT.UiModule = UiModule;
})(globalThis);
