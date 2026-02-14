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
  '/core/nt-namespace.js',
  '/ai/model-selection-policy.js',
  '/core/time.js',
  '/core/duration.js',
  '/core/chrome-local-store-base.js',
  '/core/model-selection.js',
  '/core/event-types.js',
  '/core/event-factory.js',
  '/core/retry-loop.js',
  '/core/message-envelope.js',
  '/core/ui-protocol.js',
  '/bg/ui-port-hub.js',
  '/bg/event-log-store.js',
  '/bg/tab-state-store.js',
  '/bg/inflight-request-store.js',
  '/bg/offscreen-executor.js',
  '/ai/capability-rank.js',
  '/ai/ai-common.js',
  '/ai/ai-runtime-base.js',
  '/ai/ai-load-scheduler.js',
  '/ai/llm-client.js',
  '/ai/model-rate-limit-store.js',
  '/ai/model-benchmark-store.js',
  '/ai/model-performance-store.js',
  '/ai/ai-calls.js',
  '/ai/model-benchmarker.js',
  '/ai/llm-engine.js',
  '/ai/ai-module.js',
  '/bg/background-app.js'
);

(async () => {
  const app = new globalThis.NT.BackgroundApp({
    chromeApi: globalThis.chrome,
    fetchFn: globalThis.fetch
  });
  await app.start();
})();
