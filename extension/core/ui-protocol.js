/**
 * Shared UI protocol constants for runtime envelope messaging.
 *
 * The protocol defines message types exchanged between popup/debug clients and
 * background hub over unstable MV3 runtime ports. It keeps handshake, snapshot,
 * subscribe, patch, and command channels explicit and consistent.
 *
 * Event-log paging is modeled as command + patch-result to avoid adding a
 * second transport path while still supporting request-scoped responses.
 */
(function initUiProtocol(global) {
  const Commands = Object.freeze({
    START_TRANSLATION: 'START_TRANSLATION',
    CANCEL_TRANSLATION: 'CANCEL_TRANSLATION',
    CLEAR_TRANSLATION_DATA: 'CLEAR_TRANSLATION_DATA',
    SET_TRANSLATION_CATEGORIES: 'SET_TRANSLATION_CATEGORIES',
    SET_TRANSLATION_VISIBILITY: 'SET_TRANSLATION_VISIBILITY',
    RETRY_FAILED_BLOCKS: 'RETRY_FAILED_BLOCKS',
    BENCHMARK_SELECTED_MODELS: 'BENCHMARK_SELECTED_MODELS',
    CLEAR_EVENT_LOG: 'CLEAR_EVENT_LOG',
    EVENT_LOG_PAGE: 'EVENT_LOG_PAGE'
  });

  const UiProtocol = Object.freeze({
    UI_HELLO: 'ui:hello',
    UI_SNAPSHOT: 'ui:snapshot',
    UI_SUBSCRIBE: 'ui:subscribe',
    UI_PATCH: 'ui:patch',
    UI_COMMAND: 'ui:command',
    UI_EVENT_LOG_PAGE: Commands.EVENT_LOG_PAGE,
    UI_EVENT_LOG_PAGE_RESULT: 'ui:event-log:page-result',
    Commands
  });

  global.NT.UiProtocol = UiProtocol;
})(globalThis);
