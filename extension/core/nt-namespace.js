/**
 * Root namespace bootstrap for all extension modules.
 *
 * This file creates a single global `NT` object and pre-initializes internal
 * buckets used by module-private classes: `NT.Internal.ai` and `NT.Internal.bg`.
 *
 * Contracts:
 * - no other global symbols are introduced;
 * - files may safely attach public facades to `NT.*`;
 * - internal implementation classes must attach only to `NT.Internal.*`.
 *
 * It does not load scripts, run business logic, or access browser/network APIs.
 */
(function initNtNamespace(global) {
  if (!global.NT) {
    Object.defineProperty(global, 'NT', {
      value: {},
      writable: false,
      enumerable: false,
      configurable: false
    });
  }

  if (!global.NT.Const) {
    global.NT.Const = Object.freeze({});
  }

  global.NT.Internal = global.NT.Internal || {};
  global.NT.Internal.ai = global.NT.Internal.ai || {};
  global.NT.Internal.bg = global.NT.Internal.bg || {};

})(globalThis);
