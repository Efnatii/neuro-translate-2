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
    SET_SETTINGS: 'SET_SETTINGS',
    APPLY_AUTOTUNE_PROPOSAL: 'APPLY_AUTOTUNE_PROPOSAL',
    REJECT_AUTOTUNE_PROPOSAL: 'REJECT_AUTOTUNE_PROPOSAL',
    RESET_AUTOTUNE_OVERRIDES: 'RESET_AUTOTUNE_OVERRIDES',
    REQUEST_PROOFREAD_SCOPE: 'REQUEST_PROOFREAD_SCOPE',
    REQUEST_BLOCK_ACTION: 'REQUEST_BLOCK_ACTION',
    RETRY_FAILED_BLOCKS: 'RETRY_FAILED_BLOCKS',
    ERASE_TRANSLATION_MEMORY: 'ERASE_TRANSLATION_MEMORY',
    BENCHMARK_SELECTED_MODELS: 'BENCHMARK_SELECTED_MODELS',
    CLEAR_EVENT_LOG: 'CLEAR_EVENT_LOG',
    EVENT_LOG_PAGE: 'EVENT_LOG_PAGE',
    KICK_SCHEDULER: 'KICK_SCHEDULER',
    SET_PAUSE_OTHER_TABS: 'SET_PAUSE_OTHER_TABS',
    SET_CONNECTION_MODE: 'SET_CONNECTION_MODE',
    SAVE_BYOK_KEY: 'SAVE_BYOK_KEY',
    CLEAR_BYOK_KEY: 'CLEAR_BYOK_KEY',
    SAVE_PROXY_CONFIG: 'SAVE_PROXY_CONFIG',
    CLEAR_PROXY_CONFIG: 'CLEAR_PROXY_CONFIG',
    BG_TEST_CONNECTION: 'BG_TEST_CONNECTION',
    BG_TEST_SET_PROXY_CONFIG: 'BG_TEST_SET_PROXY_CONFIG',
    BG_TEST_RELOAD_EXTENSION: 'BG_TEST_RELOAD_EXTENSION',
    BG_TEST_GET_LOGS: 'BG_TEST_GET_LOGS',
    RUN_SECURITY_AUDIT: 'RUN_SECURITY_AUDIT'
  });

  const UiProtocol = Object.freeze({
    UI_HELLO: 'ui:hello',
    UI_SNAPSHOT: 'ui:snapshot',
    UI_SUBSCRIBE: 'ui:subscribe',
    UI_PATCH: 'ui:patch',
    UI_COMMAND: 'ui:command',
    UI_SETTINGS_RESULT: 'ui:settings:result',
    UI_EVENT_LOG_PAGE: Commands.EVENT_LOG_PAGE,
    UI_EVENT_LOG_PAGE_RESULT: 'ui:event-log:page-result',
    Commands
  });

  global.NT.UiProtocol = UiProtocol;
})(globalThis);
