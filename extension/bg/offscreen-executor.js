/**
 * Backward-compatible alias for offscreen LLM executor.
 *
 * Historical modules construct `NT.OffscreenExecutor`; keep that API pointing
 * to `NT.OffscreenLlmExecutor`.
 */
(function initOffscreenExecutorAlias(global) {
  const NT = global.NT || (global.NT = {});
  if (NT.OffscreenLlmExecutor) {
    NT.OffscreenExecutor = NT.OffscreenLlmExecutor;
  }
})(globalThis);
