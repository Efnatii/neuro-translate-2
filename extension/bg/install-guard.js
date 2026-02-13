/**
 * Background installation diagnostics for MV3 runtime environment.
 *
 * `InstallGuard` runs best-effort startup checks and emits human-readable
 * events that explain common misconfiguration cases (wrong folder selected,
 * missing permissions/host permissions, unavailable offscreen API).
 *
 * Contracts:
 * - no persistent state is stored;
 * - no translation business logic is executed;
 * - checks never throw to callers, result is returned as a summary object;
 * - all messages are short and actionable for Edge extension setup.
 *
 * This module does not own runtime ports, AI requests, or UI rendering.
 */
(function initInstallGuard(global) {
  const NT = global.NT;
  const BG = NT.Internal.bg;

  class InstallGuard {
    constructor({ chromeApi, eventFactory, emitEventFn } = {}) {
      this.chromeApi = chromeApi || null;
      this.eventFactory = eventFactory || null;
      this.emitEventFn = typeof emitEventFn === 'function' ? emitEventFn : null;
    }

    _emit(level, tag, message, meta) {
      if (!this.emitEventFn) {
        return;
      }
      if (this.eventFactory) {
        const event = level === 'error'
          ? this.eventFactory.error(tag, message, meta)
          : level === 'warn'
            ? this.eventFactory.warn(tag, message, meta)
            : this.eventFactory.info(tag, message, meta);
        this.emitEventFn(event);
        return;
      }
      this.emitEventFn({ ts: Date.now(), level, tag, message, meta });
    }

    async runChecks({ offscreenExecutor, requireOpenAiHost = true } = {}) {
      const result = {
        ok: true,
        hasOffscreenApi: false,
        canCreateOffscreen: false,
        hasHostPermissionOpenAi: true,
        notes: []
      };

      const chromeApi = this.chromeApi || {};
      result.hasOffscreenApi = Boolean(chromeApi.offscreen);
      if (!result.hasOffscreenApi) {
        result.ok = false;
        result.notes.push('OFFSCREEN_API_MISSING');
        this._emit(
          'error',
          'INSTALL_OFFSCREEN_API_MISSING',
          'chrome.offscreen is unavailable — вероятно устаревший Edge или не MV3. Проверь manifest_version=3 и версию браузера.',
          { hint: 'reload extension from /extension' }
        );
      }

      if (chromeApi.permissions && typeof chromeApi.permissions.contains === 'function') {
        try {
          const hasOrigin = await chromeApi.permissions.contains({ origins: ['https://api.openai.com/*'] });
          result.hasHostPermissionOpenAi = Boolean(hasOrigin);
        } catch (_) {
          result.hasHostPermissionOpenAi = true;
        }
      }

      if (requireOpenAiHost && !result.hasHostPermissionOpenAi) {
        result.ok = false;
        result.notes.push('HOST_PERMISSIONS_MISSING');
        this._emit(
          'error',
          'INSTALL_HOST_PERMISSIONS_MISSING',
          'Нет host_permissions для https://api.openai.com/* — добавь host_permissions в extension/manifest.json и перезагрузи расширение.',
          { hint: 'host_permissions: ["https://api.openai.com/*"]' }
        );
      }

      if (offscreenExecutor && typeof offscreenExecutor.ensureDocument === 'function') {
        try {
          await Promise.race([
            offscreenExecutor.ensureDocument(),
            new Promise((_, reject) => global.setTimeout(() => {
              const err = new Error('OFFSCREEN_CHECK_TIMEOUT');
              err.code = 'OFFSCREEN_CHECK_TIMEOUT';
              reject(err);
            }, 4000))
          ]);

          if (offscreenExecutor.mode === 'offscreen') {
            result.canCreateOffscreen = true;
          } else {
            result.ok = false;
            result.canCreateOffscreen = false;
            result.notes.push(offscreenExecutor.disabledReason || 'OFFSCREEN_DISABLED');
            this._emit(
              'error',
              'INSTALL_OFFSCREEN_CREATE_FAILED',
              'Offscreen document creation failed — проверь permission "offscreen" и что загружена папка /extension.',
              { reason: offscreenExecutor.disabledReason || 'unknown' }
            );
          }
        } catch (error) {
          result.ok = false;
          result.canCreateOffscreen = false;
          result.notes.push(error && (error.code || error.message) ? (error.code || error.message) : 'OFFSCREEN_CREATE_FAILED');
          this._emit(
            'error',
            'INSTALL_OFFSCREEN_CREATE_FAILED',
            'Offscreen document creation failed — проверь permission "offscreen" и что загружена папка /extension.',
            { reason: error && (error.code || error.message) ? (error.code || error.message) : 'unknown' }
          );
        }
      }

      return result;
    }
  }

  BG.InstallGuard = InstallGuard;
})(globalThis);
