/**
 * Shared JSDoc typedefs for translation pipeline contracts.
 *
 * @typedef {Object} TranslationBlock
 * @property {string} blockId Stable block id in the page snapshot.
 * @property {string} originalText Source text captured from DOM.
 * @property {string} [translatedText] Latest translated text, when available.
 * @property {string} [pathHint] CSS-like path hint used for diagnostics.
 * @property {string} [category] Classified category (main_content|headings|navigation|ui_controls|tables|code|captions|footer|legal|ads|unknown).
 * @property {Object} [features] Lightweight DOM-derived features used by deterministic classifier.
 *
 * @typedef {Object} TranslationBatch
 * @property {string} batchId Deterministic batch id within a job.
 * @property {string} jobId Translation job id.
 * @property {number} index Zero-based batch index.
 * @property {TranslationBlock[]} blocks Blocks included in the batch.
 *
 * @typedef {Object} TranslationError
 * @property {string} code Stable error code.
 * @property {string} message Human-readable message.
 * @property {number|null} [status] Optional HTTP/runtime status.
 * @property {number|null} [retryAfterMs] Optional retry hint.
 *
 * @typedef {Object} TranslationStatus
 * @property {string} status idle|preparing|planning|awaiting_categories|running|completing|done|failed|cancelled.
 * @property {number} progress Integer 0..100.
 * @property {number} total Total block count for the job.
 * @property {number} completed Completed block count.
 * @property {number} failedBlocksCount Failed block count.
 * @property {string} message UI-facing status message.
 * @property {string[]} [selectedCategories] Selected translation categories.
 * @property {string[]} [availableCategories] Categories available on the page after classifier/planning.
 * @property {Object|null} [classification] Latest classifier snapshot.
 * @property {Object|null} [agentState] Agent diagnostics snapshot for debug UI.
 * @property {TranslationError|null} lastError Last observed terminal/runtime error.
 *
 * @typedef {Object} TranslationSettings
 * @property {boolean} translationPipelineEnabled Global safety switch.
 * @property {string[]} translationModelList Allowed model specs.
 * @property {boolean} translationApiCacheEnabled Enables response cache for repeated translation batches.
 * @property {Object} [translationAgentTuning] Optional overrides for planner/audit/compression behavior.
 * @property {{mode:('auto'|'fixed'), speed:boolean, preference:(null|'smartest'|'cheapest'), allowRouteOverride:boolean}} [translationAgentModelPolicy]
 * @property {{speed:boolean, preference:(null|'smartest'|'cheapest')}} modelSelection
 *
 * @typedef {Object} TranslationJob
 * @property {string} id Job id.
 * @property {number} tabId Browser tab id.
 * @property {string} status idle|preparing|planning|awaiting_categories|running|completing|done|failed|cancelled.
 * @property {number} createdAt Unix timestamp ms.
 * @property {number} updatedAt Unix timestamp ms.
 * @property {number|null} leaseUntilTs Lease timestamp for stale-job recovery.
 * @property {number} totalBlocks Total blocks discovered for this job.
 * @property {number} completedBlocks Completed blocks count.
 * @property {string[]} pendingBlockIds Remaining block ids to process.
 * @property {string[]} failedBlockIds Block ids that failed in terminal attempt.
 * @property {Object.<string, TranslationBlock>} blocksById Block snapshot by id.
 * @property {Object|null} [agentState] Agent state and planning diagnostics.
 * @property {string[]} [selectedCategories] Effective categories for this job.
 * @property {string[]} [availableCategories] Available categories discovered by classifier.
 * @property {Object|null} [classification] Persisted classifier result {classifierVersion,domHash,byBlockId,summary,ts}.
 * @property {string|null} [pageSignature] Page signature used for cache matching.
 * @property {TranslationError|null} lastError Last job-level error.
 * @property {string} message UI-facing status text.
 */
(function initTranslationTypes(global) {
  const NT = global.NT || (global.NT = {});
  NT.TranslationTypes = NT.TranslationTypes || {};
})(globalThis);
