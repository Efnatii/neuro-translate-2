# Agent Execution Plan

Last updated: 2026-02-22

## Source of Truth
- Requirements file: `ПОДРОБНОСТИ РЕАЛИЗАЦИИ ИИ АГЕНТА ПЕРЕВОДЧИКА.md`

## Working Rules For This Task
- Re-read requirements and this plan before each major implementation block.
- Integrate changes into existing architecture (`extension/ai`, `extension/bg`, `extension/content`, `extension/ui`), do not layer duplicate pipelines.
- Keep feature flags/settings backward compatible.
- Run checks after each major block and at the end.

## Implementation Roadmap
1. Baseline context alignment and gap mapping
Status: completed

2. Add translator agent core
Status: completed
Scope:
- Agent system prompt and report format contract
- Tooling abstraction (page analysis, glossary, plan, audit, anti-repeat, context compression)
- Profiles and auto tool configuration

3. Integrate agent into translation orchestration
Status: completed
Scope:
- Planning phase after scan
- Agent-driven batch strategy
- Streaming status updates for popup/debug
- Resume-safe persistent state

4. Add translated page memory cache
Status: completed
Scope:
- Persistent cache store for translated pages
- Fast-path apply from cache on repeated pages
- Invalidation rules by page signature + target language

5. Extend UI and protocol
Status: completed
Scope:
- Popup: profile, categories, concise agent status, clear data action
- Debug: checklist/tool history/reports/diff snapshots
- UI command for data wipe + cache cleanup

6. Tests and verification
Status: completed
Scope:
- Update existing tests and add new test coverage for agent/cache behavior
- Run smoke + contract + orchestrator + related tests

## Verification Notes
- `node tools/test-translation-contracts.js` PASS
- `node tools/test-translation-orchestrator.js` PASS
- `node tools/test-translation-agent.js` PASS
- `node tools/test-translation-call.js` PASS
- `node tools/test-translation-cancel-abort.js` PASS
- `node tools/test-translation-page-cache.js` PASS
- `node tools/test-background-selection-routing.js` PASS
- `node tools/test-model-chooser.js` PASS
- `node tools/test-llm-client-offscreen-abort.js` PASS
- `node tools/test-background-tab-lifecycle.js` PASS
- `node tools/test-dom-applier.js` PASS
- `node tools/smoke-check.js` PASS
- `node tools/check-path-regressions.js` PASS
- `node tools/lint-no-direct-storage.js` PASS
- `node tools/validate-manifest.js` PASS

## Recheck Addendum (2026-02-22)
- Restored-original flow before each new job start:
  prevents rescanning already translated DOM when user reruns translation for new categories.
- Added intra-job API optimization:
  repeated source fragments in later batches are translated from in-job memory cache without extra LLM calls.
- Added profile/route-aware model policy:
  translation requests now derive effective model selection from agent profile and batch route (`fast`/`strong`) while still respecting selected model list.
- Added test coverage for new behavior:
  - `tools/test-translation-orchestrator.js` now checks restart restore order, clear-data reset, and duplicate-text call reduction.
  - `tools/test-background-selection-routing.js` validates profile/route model policy mapping.

## Point-by-Point Recheck (2026-02-22)
- Point 1 (agent architecture + system prompt + tool interaction): completed
- Point 2 (flexible tools + auto mode + profiles): completed
- Point 3 (expected translator-agent pipeline): completed
- Verified integration chain:
  `translation-orchestrator` -> `translation-agent` -> `translation-call` -> content runtime (`dom-indexer`/`dom-applier`).
- Hardening applied for system prompt delivery:
  `translation-call` now sends structured Responses API input with explicit `system` and `user` messages instead of embedding system prompt into one plain text block.
- Added regression test:
  `tools/test-translation-call.js` validates structured input with and without system prompt.
- Added real auto tool resolution:
  `translation-agent` now resolves each `auto` tool into effective `on/off` using page/category/reuse stats and profile style, and stores both requested and effective tool config in agent state.
- Added actual tool impact on execution:
  `categorySelector=off` now bypasses category filtering (fallback to all detected categories),
  `modelRouter` now controls per-batch route hints and can fully disable route forcing,
  report writing now obeys `reportWriter` mode.
- Added snapshot/debug transparency:
  UI snapshot now exposes `toolConfig`, `toolConfigRequested`, and `toolAutoDecisions`.
- Added API-level cancellation for in-flight translation calls:
  orchestrator now creates per-job `AbortController`, passes `signal` into `translation-call`/LLM request path, aborts on cancel/clear/fail, and avoids re-marking cancelled jobs as failed.
- Added popup debug-entry shortcut from status area:
  clicking (or keyboard Enter/Space on) compact status/agent status now opens debug page.
- Added concise agent activity digest in popup:
  popup status now includes compact latest report/tool/checklist hint in one line for quick “what agent is doing” visibility.
- Added cancellation regression test:
  `tools/test-translation-cancel-abort.js` verifies signal abort and preserved `cancelled` state without failed-block pollution.
- Closed offscreen cancellation gap for point 3:
  `llm-client` now races `signal` vs offscreen request and sends `OFFSCREEN_ABORT` by `requestId`;
  `offscreen-host` now aborts in-flight fetch via per-request `AbortController`.
- Added offscreen abort regression test:
  `tools/test-llm-client-offscreen-abort.js` verifies pre-abort and in-flight abort behavior with `AbortError` surface.
- Point 4 (integration into existing architecture): completed
  no parallel/duplicate pipeline introduced; existing chain extended in-place
  (`background-app` -> `translation-orchestrator` -> `translation-agent`/`translation-call` -> content runtime).
- Point 5 (verify changes): completed
  reran full regression pack after each resilience hardening block.
- Point 6 (Edge stability + restart recovery + translated page memory): completed
  added restart tab recovery by URL remap when original tab id is gone,
  deterministic failover when recovery is impossible,
  tab-close lifecycle cancellation hook in background,
  and direct-fetch fallback when offscreen API is unavailable.
- Added restart/tab recovery regression coverage:
  `tools/test-translation-orchestrator.js` now validates replacement-tab recovery and missing-tab failover (`TAB_UNAVAILABLE_AFTER_RESTART`).
- Added background lifecycle regression coverage:
  `tools/test-background-tab-lifecycle.js` validates automatic cancellation on `tabs.onRemoved`.
- Added Edge/offscreen fallback coverage:
  `tools/test-llm-client-offscreen-abort.js` now validates direct-fetch fallback when offscreen transport is unavailable.
- Added translated-page memory regression coverage:
  `tools/test-translation-page-cache.js` validates that repeated translation of the same page signature is restored from cache without extra LLM calls.
- Point 7 (agent must not self-stop + periodic audits + anti-repeat checks): completed
  orchestrator now triggers mandatory audit tool calls on each processing loop,
  anti-repeat baseline guard is enforced even when explicit `antiRepeatGuard=off`,
  and batch builder keeps emitting work while pending blocks exist.
- Point 8 (do not impose unnecessary agent restrictions): completed
  planner prompt no longer hard-codes narrow ranges for style/batch/passes,
  and plan merge clamps were widened (`batchSize` up to 48, `proofreadingPasses` up to 20).
- Point 9 (context overflow handling via tool calls + audit/checklist marks): completed
  context compression now supports mandatory tool invocation path,
  runs automatically before batch-context assembly under pressure,
  and writes checklist/audit-aware compressed summaries with tool-call trace.
- Added point 7-9 regression coverage:
  `tools/test-translation-agent.js` now validates mandatory audit/compression tool behavior,
  anti-repeat baseline when tool mode is off, non-stopping batch emission with pending work,
  and planner prompt without hard-coded narrow limits.

## Point-by-Point Recheck (continued, 2026-02-22)
- Point 10 (proper report/response formatting): completed
  `translation-call` now normalizes model response payloads and report schema
  (`summary/quality/notes`) with deterministic fallbacks;
  `translation-agent` now stores sanitized report entries with stable `formatVersion`.
- Point 11 (single unified model list + selected-only usage): completed
  `background-app` now sanitizes `translationModelList` strictly against AI registry,
  self-heals invalid storage state, and restores a deterministic default model list
  when the selection becomes empty/invalid.
- Point 12 (flexible settings): completed
  added `translationApiCacheEnabled` end-to-end setting
  (storage defaults/public snapshot, popup toggle, background watch/read path).
- Point 13 (optimizations and caching): completed
  added translation API response cache in `translation-call` (TTL + bounded LRU),
  and connected runtime flag propagation through orchestrator (`apiCacheEnabled` per job).

### Additional verification for points 10-13
- `node tools/test-translation-call.js` PASS
- `node tools/test-translation-agent.js` PASS
- `node tools/test-background-selection-routing.js` PASS
- `node tools/test-translation-orchestrator.js` PASS

## Point 3 Deep Recheck (2026-02-22)
- Revalidated full point-3 pipeline end-to-end:
  start button -> scan/bindings -> agent planning -> batch translation stream ->
  popup concise status/debug deep state -> visibility toggle -> cancel/clear APIs.
- Closed gap for planned proofreading passes:
  `proofreadingPasses` from agent plan now executes real post-translation proofread
  batches in orchestrator (streamed through the same BG/CS apply-ack loop).
- Added dedicated regression:
  `tools/test-translation-proofreading.js` validates that proofread pass runs after
  main translation, applies to DOM stream, and persists final polished text.

## Correction Pass (2026-02-22, deferred category selection)
- Moved category choice to post-planning stage:
  scan now ends in `awaiting_categories`; translation starts only after explicit category submit.
- Removed static category checklist/settings block from popup runtime flow:
  popup now renders dynamic category chooser only when planning is complete.
- Added future category expansion without full restart:
  after partial completion, job can stay active in `done` state and accept additional categories.
- Hardened cache behavior for category-aware flow:
  page cache is persisted/restored only for full-category coverage of a page signature.
- Revalidated end-to-end checks:
  orchestrator/page-cache/cancel/proofreading + regression pack are green.

## Correction Pass (2026-02-22, flexible agent tuning)
- Added explicit advanced agent settings in popup:
  - thinking/planning overrides (style, batch size, proofread passes, parallelism)
  - planner controls (temperature, max output tokens)
  - optimization/runtime controls (audit intervals, compression threshold/limit/cooldown)
  - existing tool-mode and cache controls remain editable.
- Added visual profile-impact preview in popup:
  shows effective values and how profile defaults change after user overrides.
- Wired `translationAgentTuning` end-to-end:
  settings defaults/public snapshot/UI patches/background watch/orchestrator settings read.
- Applied tuning in real agent execution:
  planner request params, resolved profile overrides, audit cadence, and context-compression thresholds now use configured values.
- Added regression coverage:
  `tools/test-translation-agent.js` validates tuning overrides and preview helper behavior.

## Correction Pass (2026-02-22, no hidden agent limits)
- Removed hard-coded global scheduler RPM/TPM budget bootstrap (`60/60000`):
  `background-app` now instantiates `AiLoadScheduler` without fixed caps.
- Updated `AiLoadScheduler` budget mode:
  if RPM/TPM caps are not explicitly provided, scheduler runs in uncapped mode and only applies server-driven backoff (`retryAfter` / 429 cooldown behavior).
- Removed hidden upper clamps in agent tuning and execution:
  `translation-agent` no longer enforces upper bounds for:
  - `maxBatchSizeOverride`
  - `proofreadingPassesOverride`
  - planner token cap override
  - runtime audit/compression tuning values.
- Removed hidden upper clamps in orchestrator execution:
  `translation-orchestrator` no longer caps planned proofreading passes at 20 and proofread batch size at 24.
- Synced popup controls with unrestricted tuning:
  removed restrictive HTML `max` bounds and JS normalization caps in advanced agent settings.
- Added dedicated regression:
  `tools/test-ai-load-scheduler.js` validates:
  - no hidden RPM/TPM throttling in default scheduler mode
  - preserved server backoff handling after rate-limit signals.
- Expanded agent regressions:
  `tools/test-translation-agent.js` now validates:
  - large batch/proofreading overrides are preserved
  - mandatory audit interval is no longer implicitly capped by regular audit interval.

## Correction Pass (2026-02-22, model-priority migration + RU UI clarity)
- Moved model-priority settings into agent settings:
  added `translationAgentModelPolicy` with `mode/speed/preference/allowRouteOverride`
  and wired it through `settings-store` -> `ui-module` -> `background-app`.
- Preserved backward compatibility:
  popup mirrors policy into legacy `modelSelection`, and background falls back to
  legacy selection when agent policy is absent.
- Agent/runtime now uses policy directly:
  background model-selection resolver applies policy before profile/route logic;
  fixed mode blocks profile bias; route override can be disabled.
- Added policy awareness to agent context:
  `translation-agent` now stores/exposes model policy in agent state/snapshot,
  and `translation-call` suppresses route forcing when override is disabled.
- UI clarity/UX updates (kept existing visual style):
  popup got reorganized collapsible blocks, new quick-status chips, and moved
  model policy controls under agent section.
- Full popup/debug RU localization and explanatory tooltips:
  translated labels/messages and added `title` hints on key controls/sections.
- Verification:
  - `node tools/test-background-selection-routing.js` PASS
  - `node tools/test-translation-agent.js` PASS
  - `node tools/test-translation-call.js` PASS
  - `node tools/test-translation-orchestrator.js` PASS
  - `node tools/test-translation-contracts.js` PASS

## Correction Pass (2026-02-22, all agent actions through tools)
- Added unified tool execution layer in `translation-agent`:
  - `_executeToolSync` / `_executeToolAsync`
  - per-action tool execution trace (`toolExecutionTrace`)
  - normalized mode resolution + disabled/forced execution handling.
- Introduced system tool key `workflowController`:
  all agent state transitions/checklist/report lifecycle mutations are routed
  through tool invocation path (including phase changes, finalize, fail flow).
- Routed planning/runtime operations through tool executor:
  page analysis, category selection, glossary build, planner call,
  model routing, anti-repeat ordering checkpoints, audits, context compression.
- Added report-write tool wrapper:
  `_appendReportViaTool` enforces report creation through `reportWriter` tool.
- Exposed tool execution trace in UI snapshot and debug page:
  debug now has dedicated "Трасса инструментов" section.
- Verification:
  - `node tools/test-translation-agent.js` PASS
  - `node tools/test-translation-orchestrator.js` PASS
  - `node tools/test-translation-call.js` PASS
  - `node tools/test-background-selection-routing.js` PASS
  - `node tools/test-translation-contracts.js` PASS

## Correction Pass (2026-02-22, popup model pricing visibility)
- Popup model list now shows per-model total price:
  `Σ 1M` = `inputPrice + outputPrice` for each registry model entry.
- Added selected-model aggregate price summary in popup:
  sum of `Σ 1M` across currently selected models.
- Added price tooltip details:
  input/output/cached-input prices per 1M tokens for each model row.
- Verification:
  - `node --check extension/ui/popup.js` PASS
  - `node tools/test-translation-contracts.js` PASS

## Correction Pass (2026-02-22, popup total UI rethink in B/W flat style)
- Fully redesigned popup structure into clear step-based blocks:
  - Step 1: translation control + live status
  - Step 2: API access + model set
  - Step 3: agent behavior/model policy + profile impact preview
  - Step 4: planning + optimization tuning
  - Step 5: tools + cache controls
- Preserved all runtime bindings:
  no `data-action`, `data-field`, or `data-section` selectors removed.
- Kept strict monochrome flat visual language while improving hierarchy:
  stronger panel framing, unified details layout, explicit step labels,
  clearer action buttons with text labels, denser status card.
- Preserved model pricing visibility:
  per-model and selected-total `Σ 1M` pricing remains visible in models block.
- Verification:
  - `node --check extension/ui/popup.js` PASS
  - `node tools/smoke-check.js` PASS
  - `node tools/test-translation-contracts.js` PASS

## Correction Pass (2026-02-22, prompt caching on supported selected models)
- Added model-aware prompt caching in AI request path:
  - `LlmEngine` now marks whether the chosen model supports prompt caching
    based on registry (`cachedInputPrice` presence).
  - For `translation_*` requests, `LlmEngine` now generates deterministic
    prompt cache keys scoped by task + job + chosen model.
  - Generated key is passed to transport meta as `promptCacheKey`.
- Wired prompt cache key into Responses payload:
  - `LlmClient.generateResponseRaw` now maps `meta.promptCacheKey` to
    `payload.prompt_cache_key` (with safe normalization).
  - Optional `meta.promptCacheRetention` normalization support added
    (`in-memory` / `24h`) for future use.
- Added regression coverage:
  - `tools/test-llm-engine-prompt-cache.js`
    validates key generation rules:
    translation-only, stable per job, and disabled for unsupported models.
  - `tools/test-llm-client-offscreen-abort.js`
    validates `prompt_cache_key` is propagated into Responses request body.
- Verification:
  - `node --check extension/ai/llm-engine.js` PASS
  - `node --check extension/ai/llm-client.js` PASS
  - `node tools/test-llm-client-offscreen-abort.js` PASS
  - `node tools/test-llm-engine-prompt-cache.js` PASS
  - `node tools/test-translation-call.js` PASS
  - `node tools/test-translation-contracts.js` PASS
  - `node tools/smoke-check.js` PASS

## Correction Pass (2026-02-22, popup actions usability: start + merge cancel/clear + visibility icon state)
- Fixed non-working `Перевести` flow:
  - popup no longer hard-blocks start button by local `translationPipelineEnabled=false`.
  - on start click, popup now auto-enables pipeline setting in UI state/storage patch.
  - background additionally auto-enables `translationPipelineEnabled` before
    handling `START_TRANSLATION`, preventing `PIPELINE_DISABLED` rejects.
- Merged `Отмена` + `Стереть` into one action button:
  - removed separate cancel button from popup action row.
  - retained single combined command path via `CLEAR_TRANSLATION_DATA`
    (which already cancels active job and clears translation data).
- Improved original/translation toggle clarity:
  - toggle button now has dynamic text label (`Показать оригинал` / `Показать перевод`)
    and explicit visual state with changing icon + button state styling.
- Verification:
  - `node --check extension/ui/popup.js` PASS
  - `node --check extension/bg/background-app.js` PASS
  - `node tools/test-background-selection-routing.js` PASS
  - `node tools/test-translation-orchestrator.js` PASS
  - `node tools/test-translation-contracts.js` PASS
  - `node tools/smoke-check.js` PASS

## Correction Pass (2026-02-22, popup: more settings + more statuses)
- Expanded popup settings visibility with new explicit block:
  `Режим запуска и категории`.
  - Added `translationPipelineEnabled` toggle in UI.
  - Added base category strategy selector:
    `all/content/interface/meta/custom`.
  - Added editable custom category matrix in popup settings
    (with disabled preview for non-custom modes).
- Expanded live runtime status in popup:
  - Added foldout `Расширенный статус` with metric rows:
    job id, pipeline state, progress, block counters, active batch,
    agent phase/profile, plan summary, category counts/mode,
    audits/checklist counters, tool trace/log counts, reports/diff,
    context compression/glossary and update timestamp.
  - Added compact runtime trace line (latest message/report/tool/audit/step).
- Expanded mini-status chips so profile impact is easier to read at a glance:
  pipeline state, category mode, tool mode distribution,
  planner parameters, audit cadence and context limits.
- Updated start button behavior to respect explicit pipeline toggle:
  when pipeline is off, launch remains disabled until user enables it.
- Verification:
  - `node tools/test-translation-agent.js` PASS
  - `node tools/test-translation-orchestrator.js` PASS
  - `node tools/smoke-check.js` PASS
  - `node tools/check-path-regressions.js` PASS
  - `node tools/lint-no-direct-storage.js` PASS
  - `node tools/validate-manifest.js` PASS
  - `node -e "const fs=require('fs'); new Function(fs.readFileSync('extension/ui/popup.js','utf8')); console.log('PASS: popup.js parse');"` PASS

## Hotfix (2026-02-22, translate button no-op regression)
- Fixed popup start regression where `Перевести` did nothing when local
  `translationPipelineEnabled=false`.
- Behavior restored:
  on click, popup auto-enables pipeline and continues launch command flow.
- Kept explicit pipeline toggle for visibility, but removed hard UI lock that
  blocked translation start from user perspective.
- Verification:
  - `node -e "const fs=require('fs'); new Function(fs.readFileSync('extension/ui/popup.js','utf8')); console.log('PASS: popup.js parse');"` PASS
  - `node tools/test-translation-orchestrator.js` PASS
  - `node tools/test-translation-contracts.js` PASS
  - `node tools/smoke-check.js` PASS

## Redesign v3 (2026-02-22, popup tabs + persistent top)
- Reworked popup IA into 3 tabs:
  `Управление` / `Агент` / `Модели и кэш`.
- Added persistent top strip with:
  `status-text`, `agent-status`, status chips, progress and core actions
  (`Перевести`, `Отменить и стереть`, `Оригинал/перевод`).
- Removed old step-based visual flow from popup UI.
- Added tab state persistence:
  new setting key `translationPopupActiveTab` with values
  `control | agent | models`.
- Added tab behavior in popup controller:
  tab switching with ARIA state sync and local settings persistence.
- Added forced tab priority:
  when job status is `awaiting_categories`, effective active tab is `control`.
- Kept all existing working `data-action`, `data-field`, `data-section`
  contracts used by `popup.js`; only tab-specific selectors were added.
- Verification:
  - `node --check extension/ui/popup.js` PASS
  - `node --check extension/ui/ui-module.js` PASS
  - `node --check extension/core/settings-store.js` PASS
  - `node --check extension/bg/background-app.js` PASS
  - `node tools/smoke-check.js` PASS
  - `node tools/test-translation-contracts.js` PASS
  - `node tools/test-translation-orchestrator.js` PASS
  - `node tools/test-background-selection-routing.js` PASS

## Hotfix (2026-02-22, runtime connection + SettingsStore + null number inputs)
- Fixed background bootstrap regression:
  `extension/bg/background.js` now imports `../core/settings-store.js`
  before `background-app`, preventing `NT.SettingsStore is not a constructor`
  in service worker startup.
- Fixed popup numeric-input rendering bug:
  nullable tuning overrides no longer write literal `"null"` into
  `type=number` fields (`batch size`, `proofread passes`).
- Reduced noisy `runtime.lastError` in UI fallback command path:
  `UiModule.sendUiCommand` now consumes `chrome.runtime.lastError` callback
  in fire-and-forget `runtime.sendMessage`.
- Verification:
  - `node --check extension/bg/background.js` PASS
  - `node --check extension/ui/popup.js` PASS
  - `node --check extension/ui/ui-module.js` PASS
  - `node tools/smoke-check.js` PASS
  - `node tools/test-translation-contracts.js` PASS
  - `node tools/test-translation-orchestrator.js` PASS
  - `node tools/test-background-selection-routing.js` PASS
