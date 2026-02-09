importScripts(
  'core/nt-namespace.js',
  'core/message-envelope.js',
  'core/ui-protocol.js',
  'core/ui-port-hub.js'
);

(function initBackground(global) {
  const hub = new global.NT.UiPortHub();
  hub.attachToRuntime();

  if (global.chrome && global.chrome.storage && global.chrome.storage.onChanged) {
    global.chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') {
        return;
      }

      const watchedKeys = [
        'apiKey',
        'translationModelList',
        'modelSelectionPolicy',
        'translationStatusByTab',
        'translationVisibilityByTab'
      ];
      const changedKeys = Object.keys(changes).filter((key) => watchedKeys.includes(key));

      if (!changedKeys.length) {
        return;
      }

      const patch = {};
      changedKeys.forEach((key) => {
        patch[key] = changes[key].newValue;
      });

      hub.broadcastPatch({ changedKeys, patch });
    });
  }
})(globalThis);
