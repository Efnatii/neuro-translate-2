(function initUiProtocol(global) {
  const UiProtocol = Object.freeze({
    UI_HELLO: 'ui:hello',
    UI_SNAPSHOT: 'ui:snapshot',
    UI_SUBSCRIBE: 'ui:subscribe',
    UI_PATCH: 'ui:patch',
    UI_COMMAND: 'ui:command'
  });

  global.NT.UiProtocol = UiProtocol;
})(globalThis);
