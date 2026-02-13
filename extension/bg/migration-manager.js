/**
 * Startup migration coordinator for persistent stores.
 *
 * Responsibilities:
 * - run `ensureMigrated()` for configured stores during background startup;
 * - keep migration sequencing outside `BackgroundApp` to avoid god-object drift;
 * - emit concise diagnostics for success/failure through provided event sink.
 *
 * Contracts:
 * - best-effort execution: one failing store does not hide the failure reason;
 * - no business logic for translation pipeline or UI command handling.
 */
(function initMigrationManager(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  class MigrationManager {
    constructor({ settingsStore, aiStores, bgStores, eventSink } = {}) {
      this.settingsStore = settingsStore || null;
      this.aiStores = Array.isArray(aiStores) ? aiStores : [];
      this.bgStores = Array.isArray(bgStores) ? bgStores : [];
      this.eventSink = typeof eventSink === 'function' ? eventSink : null;
    }

    async run() {
      const stores = [this.settingsStore, ...this.bgStores, ...this.aiStores].filter(Boolean);
      for (const store of stores) {
        if (typeof store.ensureMigrated !== 'function') {
          continue;
        }
        try {
          const result = await store.ensureMigrated();
          this._emit('info', 'STORE_MIGRATION_COMPLETE', 'Store migration completed', {
            store: store.storeName || store.constructor.name,
            schemaVersion: result && result.schemaVersion ? result.schemaVersion : null
          });
        } catch (error) {
          this._emit('error', 'STORE_MIGRATION_FAILED', 'Store migration failed', {
            store: store.storeName || store.constructor.name,
            code: error && error.code ? error.code : 'MIGRATION_FAILED',
            message: error && error.message ? error.message : String(error)
          });
          throw error;
        }
      }
    }

    _emit(level, tag, message, meta) {
      if (!this.eventSink) {
        return;
      }
      this.eventSink({
        level,
        tag,
        message,
        meta: meta && typeof meta === 'object' ? { ...meta } : {}
      });
    }
  }

  BG.MigrationManager = MigrationManager;
})(globalThis);
