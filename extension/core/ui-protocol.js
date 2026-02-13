/**
 * Shared UI protocol constants for runtime envelope messaging.
 *
 * Constants define handshake and patch stream channels plus command names used
 * by UI controllers and background command handlers.
 *
 * Contracts:
 * - handshake messages are transported as envelopes;
 * - command payload shape is `{ name, payload }`;
 * - command responses are transported by `MessageBus`.
 */
(function initUiProtocol(global) {
  const UiProtocol = Object.freeze({
    UI_HELLO: 'ui:hello',
    UI_SNAPSHOT: 'ui:snapshot',
    UI_SUBSCRIBE: 'ui:subscribe',
    UI_PATCH: 'ui:patch',
    UI_COMMAND: 'ui:command',
    CMD_SETTINGS_PATCH: 'SETTINGS_PATCH',
    CMD_GET_API_KEY: 'GET_API_KEY',
    CMD_BENCHMARK_SELECTED: 'BENCHMARK_SELECTED_MODELS',
    CMD_CLEAR_EVENT_LOG: 'CLEAR_EVENT_LOG',
    CMD_LOAD_OLDER_EVENTS: 'LOAD_OLDER_EVENTS'
  });

  global.NT.UiProtocol = UiProtocol;
})(globalThis);
