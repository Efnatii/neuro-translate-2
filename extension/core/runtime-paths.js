/**
 * Runtime path resolver for mixed extension layouts.
 *
 * This helper normalizes file paths for runtime APIs (`getURL`, offscreen,
 * scripting.executeScript) based on active manifest background path.
 */
(function initRuntimePaths(global) {
  const NT = global.NT || (global.NT = {});

  const RuntimePaths = Object.freeze({
    detectPrefix(chromeApi) {
      try {
        const runtime = chromeApi && chromeApi.runtime ? chromeApi.runtime : null;
        if (!runtime || typeof runtime.getManifest !== 'function') {
          return '';
        }
        const manifest = runtime.getManifest() || {};
        const workerPath = manifest.background && typeof manifest.background.service_worker === 'string'
          ? manifest.background.service_worker
          : '';
        if (workerPath.startsWith('extension/')) {
          return 'extension/';
        }
      } catch (_) {
        // ignore and fallback to no prefix
      }
      return '';
    },

    withPrefix(chromeApi, relativePath) {
      const clean = String(relativePath || '').replace(/^\/+/, '');
      if (!clean) {
        return '';
      }
      const prefix = RuntimePaths.detectPrefix(chromeApi);
      if (prefix && clean.startsWith(prefix)) {
        return clean;
      }
      return `${prefix}${clean}`;
    }
  });

  NT.RuntimePaths = RuntimePaths;
})(globalThis);

