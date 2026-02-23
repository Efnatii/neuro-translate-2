/**
 * Unified UI facade for popup/debug controllers.
 *
 * Source of truth:
 * - Runtime snapshot/patch from background (HELLO -> SNAPSHOT -> SUBSCRIBE).
 * - Settings writes go through BG command (`SET_SETTINGS`) with schema checks.
 */
(function initUiModule(global) {
  const NT = global.NT || (global.NT = {});

  class UiModule {
    constructor({ chromeApi, portName, onSnapshot, onPatch, helloContext } = {}) {
      this.chromeApi = chromeApi;
      this.portName = portName;
      this.onSnapshot = typeof onSnapshot === 'function' ? onSnapshot : null;
      this.onPatch = typeof onPatch === 'function' ? onPatch : null;
      this.helloContext = this._normalizeHelloContext(helloContext);

      this.portClient = null;
      this._lastEventSeq = 0;
      this.modelRegistry = { entries: [], byKey: {} };
      this.settingsSnapshot = {};
      this.toolsetHash = null;
      this._snapshotReady = false;
      this._snapshotReadyResolvers = [];

      this.pendingSettingsPatch = {};
      this.settingsPatchTimer = null;
      this.settingsPatchDebounceMs = 250;
    }

    _normalizeHelloContext(context) {
      const source = context && typeof context === 'object' ? context : {};
      const tabId = Number.isFinite(Number(source.tabId)) ? Number(source.tabId) : null;
      return {
        tabId
      };
    }

    setHelloContext(context) {
      this.helloContext = this._normalizeHelloContext(context);
    }

    init() {
      const UiPortClient = NT.UiPortClient || null;
      if (UiPortClient) {
        this.portClient = new UiPortClient({
          portName: this.portName,
          getHelloPayload: () => ({
            ...(Number.isFinite(Number(this.helloContext && this.helloContext.tabId))
              ? { tabId: Number(this.helloContext.tabId) }
              : {}),
            lastEventSeq: this._lastEventSeq || 0,
            uiCaps: this._buildUiCaps(),
            toolsetWanted: this._buildToolsetWanted()
          }),
          getHelloMeta: () => ({
            ...(Number.isFinite(Number(this.helloContext && this.helloContext.tabId))
              ? { tabId: Number(this.helloContext.tabId) }
              : {}),
            clientCaps: { ui: this._buildUiCaps() },
            toolsetWanted: this._buildToolsetWanted()
          }),
          onSnapshot: (payload) => {
            this._trackEventSeq(payload);
            this._trackModelRegistry(payload);
            this._trackSettings(payload);
            this._trackToolset(payload);
            this._markSnapshotReady();
            if (this.onSnapshot) {
              this.onSnapshot(payload);
            }
          },
          onPatch: (payload) => {
            this._trackEventSeq(payload);
            this._trackModelRegistry(payload);
            this._trackSettings(payload);
            this._trackToolset(payload);
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

    setConnectionMode(mode) {
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.SET_CONNECTION_MODE
        : 'SET_CONNECTION_MODE';
      return this.sendUiCommand(command, { mode });
    }

    saveByokKey({ key, persist } = {}) {
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.SAVE_BYOK_KEY
        : 'SAVE_BYOK_KEY';
      return this.sendUiCommand(command, {
        key: typeof key === 'string' ? key : '',
        persist: Boolean(persist)
      });
    }

    clearByokKey() {
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.CLEAR_BYOK_KEY
        : 'CLEAR_BYOK_KEY';
      return this.sendUiCommand(command, {});
    }

    saveProxyConfig({ baseUrl, authHeaderName, authToken, projectId, persistToken } = {}) {
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.SAVE_PROXY_CONFIG
        : 'SAVE_PROXY_CONFIG';
      return this.sendUiCommand(command, {
        baseUrl: typeof baseUrl === 'string' ? baseUrl : '',
        authHeaderName: typeof authHeaderName === 'string' ? authHeaderName : 'X-NT-Token',
        authToken: typeof authToken === 'string' ? authToken : '',
        projectId: typeof projectId === 'string' ? projectId : '',
        persistToken: Boolean(persistToken)
      });
    }

    clearProxyConfig() {
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.CLEAR_PROXY_CONFIG
        : 'CLEAR_PROXY_CONFIG';
      return this.sendUiCommand(command, {});
    }

    testConnection({ timeoutMs } = {}) {
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.BG_TEST_CONNECTION
        : 'BG_TEST_CONNECTION';
      const payload = {};
      if (Number.isFinite(Number(timeoutMs))) {
        payload.timeoutMs = Number(timeoutMs);
      }
      return this.sendUiCommand(command, payload);
    }

    runSecurityAudit() {
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.RUN_SECURITY_AUDIT
        : 'RUN_SECURITY_AUDIT';
      return this.sendUiCommand(command, {});
    }

    _markSnapshotReady() {
      if (this._snapshotReady) {
        return;
      }
      this._snapshotReady = true;
      const resolvers = this._snapshotReadyResolvers.slice();
      this._snapshotReadyResolvers = [];
      resolvers.forEach((resolve) => {
        try {
          resolve(true);
        } catch (_) {
          // best-effort
        }
      });
    }

    _waitForSnapshot(timeoutMs = 1200) {
      if (this._snapshotReady) {
        return Promise.resolve(true);
      }
      return new Promise((resolve) => {
        const resolver = () => {
          global.clearTimeout(timer);
          resolve(true);
        };
        const timer = global.setTimeout(() => {
          const idx = this._snapshotReadyResolvers.indexOf(resolver);
          if (idx >= 0) {
            this._snapshotReadyResolvers.splice(idx, 1);
          }
          resolve(false);
        }, Math.max(50, Number(timeoutMs) || 1200));
        this._snapshotReadyResolvers.push(resolver);
      });
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

    _trackSettings(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      if (payload.settings && typeof payload.settings === 'object') {
        this.settingsSnapshot = { ...this.settingsSnapshot, ...payload.settings };
        return;
      }
      if (payload.patch && typeof payload.patch === 'object' && payload.patch.settings && typeof payload.patch.settings === 'object') {
        this.settingsSnapshot = { ...this.settingsSnapshot, ...payload.patch.settings };
      }
    }

    _buildUiCaps() {
      return {
        supportsAccordions: true,
        uiProtocolVersion: 'ui/v2',
        locale: 'ru'
      };
    }

    _buildToolsetWanted() {
      return {
        toolsetId: 'neuro-translate',
        minSemver: '1.0.0',
        toolsetHash: this.toolsetHash || null
      };
    }

    _trackToolset(payload) {
      if (!payload || typeof payload !== 'object') {
        return;
      }
      const direct = payload.toolset && typeof payload.toolset === 'object'
        ? payload.toolset
        : null;
      const fromPatch = payload.patch && payload.patch.toolset && typeof payload.patch.toolset === 'object'
        ? payload.patch.toolset
        : null;
      const candidate = direct || fromPatch;
      if (!candidate || typeof candidate.toolsetHash !== 'string' || !candidate.toolsetHash) {
        return;
      }
      this.toolsetHash = candidate.toolsetHash;
    }

    normalizeSelection(modelSelection, legacyPolicy) {
      return this._normalizeSelection(modelSelection, legacyPolicy);
    }

    normalizeAgentModelPolicy(modelPolicy, fallbackSelection) {
      return this._normalizeAgentModelPolicy(modelPolicy, fallbackSelection);
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

    _normalizeAgentModelPolicy(modelPolicy, fallbackSelection) {
      const fallback = this._normalizeSelection(fallbackSelection, null);
      const src = modelPolicy && typeof modelPolicy === 'object' ? modelPolicy : {};
      const mode = src.mode === 'fixed' ? 'fixed' : 'auto';
      const hasSpeed = Object.prototype.hasOwnProperty.call(src, 'speed');
      const preference = src.preference === 'smartest' || src.preference === 'cheapest'
        ? src.preference
        : fallback.preference;
      return {
        mode,
        speed: hasSpeed ? src.speed !== false : fallback.speed !== false,
        preference,
        allowRouteOverride: src.allowRouteOverride !== false
      };
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

    openDebug({ tabId, url, section = null }) {
      if (!this.chromeApi || !this.chromeApi.tabs || !this.chromeApi.runtime) {
        return;
      }
      const safeTabId = tabId === null || tabId === undefined ? '' : tabId;
      const safeUrl = url || '';
      const safeSection = typeof section === 'string' && section ? section : '';
      const RuntimePaths = NT.RuntimePaths || null;
      const debugPath = RuntimePaths && typeof RuntimePaths.withPrefix === 'function'
        ? RuntimePaths.withPrefix(this.chromeApi, 'ui/debug.html')
        : 'ui/debug.html';
      const debugUrl = `${this.chromeApi.runtime.getURL(debugPath)}?tabId=${safeTabId}&url=${encodeURIComponent(safeUrl)}${safeSection ? `&section=${encodeURIComponent(safeSection)}` : ''}`;
      this.chromeApi.tabs.create({ url: debugUrl });
    }

    queueSettingsPatch(patch, { finalize } = {}) {
      const srcPatch = patch && typeof patch === 'object' ? patch : {};
      this.pendingSettingsPatch = this._deepMerge(this.pendingSettingsPatch, srcPatch);
      if (this.settingsPatchTimer) {
        global.clearTimeout(this.settingsPatchTimer);
      }
      this.settingsPatchTimer = global.setTimeout(() => {
        const payload = this.pendingSettingsPatch && typeof this.pendingSettingsPatch === 'object'
          ? this.pendingSettingsPatch
          : {};
        this.pendingSettingsPatch = {};
        if (typeof finalize === 'function') {
          finalize(payload);
        }
        this.sendSettingsPatch(payload).catch(() => {});
      }, this.settingsPatchDebounceMs);
    }

    async sendSettingsPatch(userSettingsPatch) {
      const patch = userSettingsPatch && typeof userSettingsPatch === 'object' ? userSettingsPatch : {};
      await this._waitForSnapshot();
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.SET_SETTINGS
        : 'SET_SETTINGS';
      const expectedSchemaVersion = Number.isFinite(Number(this.settingsSnapshot && this.settingsSnapshot.schemaVersion))
        ? Number(this.settingsSnapshot.schemaVersion)
        : null;
      this.sendUiCommand(command, {
        patch,
        expectedSchemaVersion
      });
    }

    async getSettings(keys) {
      await this._waitForSnapshot();
      const source = this.settingsSnapshot && typeof this.settingsSnapshot === 'object'
        ? this.settingsSnapshot
        : {};
      if (!Array.isArray(keys) || !keys.length) {
        return this._cloneJson(source, {});
      }
      const out = {};
      keys.forEach((key) => {
        out[key] = Object.prototype.hasOwnProperty.call(source, key) ? source[key] : undefined;
      });
      return out;
    }

    async getSettingsSnapshot() {
      await this._waitForSnapshot();
      return this._cloneJson(this.settingsSnapshot, {});
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
        this.chromeApi.runtime.sendMessage(envelope, () => {
          if (this.chromeApi && this.chromeApi.runtime && this.chromeApi.runtime.lastError) {
            // fire-and-forget fallback
          }
        });
      } catch (_) {
        // ignore fallback errors
      }
      return resolvedRequestId;
    }

    async setVisibility(tabId, visible) {
      const mode = Boolean(visible) ? 'translated' : 'original';
      return this.setDisplayMode(tabId, mode);
    }

    async setDisplayMode(tabId, mode) {
      if (tabId === null || tabId === undefined) {
        return;
      }
      const normalizedMode = mode === 'original' || mode === 'compare'
        ? mode
        : 'translated';
      const UiProtocol = NT.UiProtocol || null;
      const command = UiProtocol && UiProtocol.Commands
        ? UiProtocol.Commands.SET_TRANSLATION_VISIBILITY
        : 'SET_TRANSLATION_VISIBILITY';
      this.sendUiCommand(command, {
        tabId,
        mode: normalizedMode,
        visible: normalizedMode !== 'original'
      });
    }

    getModelRegistry() {
      return this.modelRegistry || { entries: [], byKey: {} };
    }

    _deepMerge(base, patch) {
      const left = base && typeof base === 'object' ? this._cloneJson(base, {}) : {};
      const right = patch && typeof patch === 'object' ? patch : {};
      const mergeInto = (target, source) => {
        Object.keys(source).forEach((key) => {
          const value = source[key];
          if (Array.isArray(value)) {
            target[key] = value.slice();
            return;
          }
          if (value && typeof value === 'object') {
            const current = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
              ? target[key]
              : {};
            target[key] = mergeInto(current, value);
            return;
          }
          target[key] = value;
        });
        return target;
      };
      return mergeInto(left, right);
    }

    _cloneJson(value, fallback) {
      try {
        return JSON.parse(JSON.stringify(value));
      } catch (_) {
        return fallback;
      }
    }
  }

  NT.UiModule = UiModule;
})(globalThis);
