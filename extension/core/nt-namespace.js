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
})(globalThis);
