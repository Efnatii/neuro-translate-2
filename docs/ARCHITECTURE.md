# Neuro-Translate Architecture

## Scope
This document describes runtime architecture for the Edge MV3 extension:
- `BG` (service worker): scheduling, job lifecycle, orchestration, storage.
- `CS` (content scripts): DOM scan/classify/apply/highlights.
- `OFFSCREEN`: network streaming and request execution.
- `UI` (popup/debug): controls, status, diagnostics, patch rendering.

## Runtime Layers

### 1) Background (`extension/bg`)
- Owns translation jobs, stages, retries, and leases.
- Keeps scheduler queues (including multi-tab fairness and priorities).
- Routes commands from UI to orchestrator.
- Persists state to `storage.local` and IndexedDB-backed stores.
- Emits snapshot/patch/event streams for debug and popup.

Core modules:
- `translation-orchestrator.js`
- `job-runner.js`
- `scheduler.js`
- `translation-job-store.js`
- `migration-manager.js`

### 2) Content Script (`extension/content`)
- Scans document blocks with lightweight features.
- Classifies blocks deterministically (`DomClassifier`).
- Applies streaming deltas to DOM (`DomApplier`).
- Handles frame-aware and open shadow-root traversal.
- Supports compare mode via highlights engine with wrapper fallback.

Core modules:
- `dom-indexer.js`
- `dom-classifier.js`
- `dom-applier.js`
- `highlight-engine.js`
- `content-runtime.js`

### 3) Offscreen (`extension/offscreen` if present in build)
- Executes provider network calls and stream handling.
- Isolated from popup/content lifecycle.
- Reports structured deltas, errors, usage, and latency to BG.

### 4) UI (`extension/ui`)
- Popup: quick control panel, categories, credentials, run settings.
- Debug: deep diagnostics, event logs, compare inspector, export/copy.
- Uses snapshot + patch feed through `UiModule` and protocol contracts.

Core modules:
- `ui-module.js`
- `popup.js`
- `debug.js`
- `report-exporter.js`

## Message Protocols

### Envelope
All runtime messages use a typed envelope (`extension/core/message-envelope.js`):
- `type`: command/event identifier.
- `payload`: typed data.
- `meta`: transport metadata (tab/frame/document where relevant).

### Handshake and Capabilities
- Each content frame sends hello/caps.
- BG stores per-frame capabilities (apply delta, highlights support, shadow scan).
- UI uses this to show readiness and troubleshooting hints.

### Snapshot + Patch UI Sync
- UI connects via port handshake (`UiProtocol`).
- BG sends full snapshot first, then incremental patches.
- Debug/popup are state-driven renderers; no direct storage writes.

### Tool Calling Path
- Agent planning/execution uses tool manifest + policy.
- Tool calls are validated and routed by BG registry.
- Tool traces and reports are persisted in job `agentState`.

Related files:
- `extension/ai/tool-manifest.js`
- `extension/ai/agent-tool-registry.js`
- `extension/core/ui-protocol.js`
- `extension/core/translation-protocol.js`

## Job Lifecycle

Typical stage flow:
1. `preparing`: scan + classify + planning.
2. `awaiting_categories`: user/agent category selection is required.
3. `running`: batch translation/apply.
4. `completing`: finalize/report.
5. terminal: `done` / `failed` / `cancelled`.

Notes:
- Category selection is tool-driven and can be extended later without full rescan when DOM hash is stable.
- For DOM mismatch, classification is marked stale and reclassify is required.

## Leases, Retry, and Recovery
- Scheduler assigns leases to prevent duplicate concurrent runners.
- Retry metadata (`nextRetryAt`, error code, backoff) is persisted.
- Watchdog paths recover from missing inflight/offscreen state and can fail safely with explicit codes.
- Migration/recovery paths compact state and repair indexes on startup/update.

## Storage and Persistence
- `storage.local`: settings, jobs, inflight metadata, tab/session indexes.
- IndexedDB: translation memory and optional heavy artifacts.
- Compaction limits keep state below quota budget.
- All critical state is restart-safe (MV3 SW termination tolerant).

## Frames and Shadow DOM
- Scan/apply routes by `frameId`.
- Block ids are frame-aware (`f<frameId>:<localId>`).
- Open shadow roots are traversed; closed roots are treated as inaccessible.
- Debug shows skipped frames and reasons (permission/not injected/etc).

## Compare Rendering
- Preferred mode: CSS Custom Highlight API (no DOM structure rewrite).
- Fallback mode: wrapper-based rendering for safe nodes.
- Highlight updates are throttled/debounced for long streams.

## Diagnostics and Runbook Links
- Troubleshooting: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)
- Manual test checklist: [QA_CHECKLIST.md](./QA_CHECKLIST.md)
- Release flow: [RELEASE.md](./RELEASE.md)
