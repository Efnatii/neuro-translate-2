/**
 * MV3 service-worker bootstrap for the background module.
 *
 * Role:
 * - Load namespace and runtime classes in deterministic order, then start
 *   `NT.BackgroundApp`.
 *
 * Public contract:
 * - This file only defines bootstrap sequencing; it does not expose business
 *   helpers or mutable globals.
 *
 * Dependencies:
 * - Core utilities, background orchestration classes, and AI runtime modules.
 *
 * Side effects:
 * - Executes `importScripts(...)` and starts background app startup flow.
 */
importScripts(
  '../core/nt-namespace.js',
  '../ai/model-selection-policy.js',
  '../core/agent-settings-policy.js',
  '../core/time.js',
  '../core/duration.js',
  '../core/chrome-local-store-base.js',
  '../core/perf-profiler.js',
  '../core/redaction.js',
  '../core/safe-logger.js',
  '../core/json-schema-validator.js',
  '../core/settings-store.js',
  '../core/model-selection.js',
  '../core/event-types.js',
  '../core/event-factory.js',
  '../core/retry-loop.js',
  '../core/retry-policy.js',
  '../core/url-normalizer.js',
  '../core/dom-signature.js',
  '../core/message-envelope.js',
  '../core/ui-protocol.js',
  '../core/translation-protocol.js',
  '../core/translation-types.js',
  '../core/runtime-paths.js',
  './ui-port-hub.js',
  './event-log-store.js',
  './tab-state-store.js',
  './translation-job-store.js',
  './translation-page-cache-store.js',
  './translation-memory-store.js',
  './inflight-request-store.js',
  './migration-manager.js',
  './tab-session-manager.js',
  './job-queue.js',
  './credentials-store.js',
  './credentials-provider.js',
  './security-audit.js',
  './rate-limit-budget-store.js',
  './scheduler.js',
  './job-runner.js',
  './translation-orchestrator.js',
  './offscreen-llm-executor.js',
  './offscreen-executor.js',
  '../ai/capability-rank.js',
  '../ai/ai-common.js',
  '../ai/ai-runtime-base.js',
  '../ai/ai-load-scheduler.js',
  '../ai/model-chooser.js',
  '../ai/llm-client.js',
  '../ai/model-rate-limit-store.js',
  '../ai/model-benchmark-store.js',
  '../ai/model-performance-store.js',
  '../ai/ai-calls.js',
  '../ai/translation-agent.js',
  '../ai/tool-manifest.js',
  '../ai/tool-policy.js',
  '../ai/run-settings.js',
  '../ai/run-settings-validator.js',
  '../ai/tool-execution-engine.js',
  '../ai/agent-tool-registry.js',
  '../ai/agent-runner.js',
  '../ai/translation-call.js',
  '../ai/model-benchmarker.js',
  '../ai/llm-engine.js',
  '../ai/ai-module.js',
  './background-app.js'
);

(() => {
  const NT = globalThis.NT || {};
  const requiredConstructors = [
    'SettingsStore',
    'EventLogStore',
    'TabStateStore',
    'TranslationJobStore',
    'InflightRequestStore',
    'MigrationManager',
    'UiPortHub',
    'TranslationOrchestrator',
    'BackgroundApp'
  ];
  const missingConstructors = requiredConstructors.filter((name) => typeof NT[name] !== 'function');
  if (missingConstructors.length) {
    const errorMessage = `[NT][BOOT] Missing constructors: ${missingConstructors.join(', ')}. Check importScripts order/paths.`;
    if (globalThis.console && typeof globalThis.console.error === 'function') {
      globalThis.console.error(errorMessage);
    }
    throw new Error(errorMessage);
  }

  (async () => {
    const app = new NT.BackgroundApp({
      chromeApi: globalThis.chrome,
      fetchFn: globalThis.fetch
    });
    await app.start();
    if (globalThis.console && typeof globalThis.console.info === 'function') {
      globalThis.console.info('[NT][BOOT] Фоновый сервис запущен');
    }
  })().catch((error) => {
    const message = error && error.message ? error.message : String(error || 'unknown');
    if (globalThis.console && typeof globalThis.console.error === 'function') {
      globalThis.console.error(`[NT][BOOT] Startup failed: ${message}`);
    }
    throw error;
  });
})();
