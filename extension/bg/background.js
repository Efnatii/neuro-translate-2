/**
 * MV3 service-worker bootstrap for the background module.
 *
 * The bootstrap is intentionally thin: it only loads scripts in deterministic
 * dependency order and starts `NT.BackgroundApp`.
 *
 * No business logic, shared mutable state, or helper globals are defined here.
 * All orchestration (UI ports, runtime messages, leases, offscreen adoption,
 * persistent stores) belongs to `BackgroundApp` and its store classes.
 */
importScripts(
  '/core/nt-namespace.js',
  '/core/time.js',
  '/core/duration.js',
  '/core/store-base.js',
  '/core/redactor.js',
  '/core/event-types.js',
  '/core/event-factory.js',
  '/core/retry-loop.js',
  '/bg/rate-limiter.js',
  '/core/message-envelope.js',
  '/core/message-bus.js',
  '/core/ui-protocol.js',
  '/core/settings-store.js',
  '/bg/ui-port-hub.js',
  '/bg/install-guard.js',
  '/bg/migration-manager.js',
  '/bg/event-log-store.js',
  '/bg/tab-state-store.js',
  '/bg/inflight-request-store.js',
  '/bg/load-scheduler.js',
  '/bg/offscreen-executor.js',
  '/ai/capability-rank.js',
  '/ai/ai-common.js',
  '/ai/llm-client.js',
  '/ai/model-rate-limit-store.js',
  '/ai/model-benchmark-store.js',
  '/ai/model-performance-store.js',
  '/ai/ai-calls.js',
  '/ai/model-benchmarker.js',
  '/ai/model-selection.js',
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
