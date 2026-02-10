/**
 * Thin base class for chrome.storage.local access in persistent stores.
 *
 * MV3 service workers are ephemeral, so persistent state must be read/written
 * through `chrome.storage.local` rather than in-memory singletons. This base
 * class removes repeated `storageGet`/`storageSet` wrappers and gives modules a
 * single fallback behavior when the storage API is unavailable.
 *
 * The class intentionally contains no business logic: subclasses remain
 * responsible for validation, normalization, and domain rules.
 */
(function initChromeLocalStoreBase(global) {
  const NT = global.NT || (global.NT = {});

  class ChromeLocalStoreBase {
    constructor({ chromeApi } = {}) {
      this.chromeApi = chromeApi;
    }

    storageGet(defaults) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve(defaults || {});
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.get(defaults, (result) => {
          resolve(result || defaults || {});
        });
      });
    }

    storageSet(payload) {
      if (!this.chromeApi || !this.chromeApi.storage || !this.chromeApi.storage.local) {
        return Promise.resolve();
      }

      return new Promise((resolve) => {
        this.chromeApi.storage.local.set(payload, () => resolve());
      });
    }
  }

  NT.ChromeLocalStoreBase = ChromeLocalStoreBase;
})(globalThis);
