# Troubleshooting

## Fast Triage Order
1. Open popup and confirm current tab is the expected page.
2. Open debug page and check `Progress`, `Job`, and `Events (level=error)`.
3. Copy diagnostics from debug (`Copy diagnostics`) before retries.
4. Apply the scenario-specific steps below.

---

## Translation Does Not Start

## Symptoms
- Start button does nothing.
- Job never leaves `idle`/`preparing`.
- Popup stays on generic status without progress.

## Checks
1. Active tab and URL scope
- Confirm current page matches extension scope and host permissions.
- If page is a different origin/frame than expected, scan/apply may be skipped.

2. Content script injection/caps
- In debug, verify frame table (`Frames/Shadow DOM`) has injected/scanned frames.
- If frame is skipped with permission reason, grant needed host permission.

3. Category gate
- If status is `awaiting_categories`, translation is intentionally paused.
- Select categories in popup and start translation again.

4. Credentials/connectivity
- In popup credentials section, verify mode (`PROXY` or `BYOK`) is configured.
- Run connection test. If test fails, fix endpoint/token/key first.

5. Pipeline switch
- Ensure translation pipeline is enabled in popup settings.

## Common root causes
- No credentials configured.
- Proxy endpoint unavailable.
- Frame origin is not permitted.
- User did not confirm categories (`awaiting_categories`).

---

## Job Stuck in RUNNING

## Symptoms
- Status remains `running` for too long.
- No block progress and no new tool/activity events.

## Checks
1. Lease and retry state
- In debug `Job`, inspect `Lease` and `Retry` fields.
- Expired/missing lease can indicate stalled runner or restart race.

2. Offscreen state
- In debug `Job`, inspect `Offscreen` field.
- If offscreen worker is lost, request stream may stop.

3. Event log correlation
- Filter debug `Events` by `error` and review latest entries around stall time.
- Look for `INFLIGHT_LOST`, stream transport errors, or scheduler warnings.

4. Kick scheduler
- Use `Kick scheduler` in debug and observe if queue advances.

5. Recovery action
- If no forward progress after retries/watchdog, cancel and restart job.
- Keep copied diagnostics and event slice for bug report.

---

## Iframe/Shadow Content Is Not Translated

## Symptoms
- Main page text translates, iframe/shadow text remains original.

## Checks
1. Frame diagnostics
- In `Frames/Shadow DOM`, verify target frame has `injected=yes` and `scannedBlocksCount > 0`.
- If skipped due permission, extend permission scope for that origin.

2. About:blank/srcdoc behavior
- Ensure `all_frames`, `match_about_blank`, and origin fallback paths are active.

3. Shadow root type
- Open shadow roots are traversable.
- Closed shadow roots are not script-accessible by design.

4. DOM changed after scan
- If `classificationStale`/DOM hash mismatch appears, reclassify/rescan.

---

## Useful Debug Sections
- `Job`: stage, lease, retry, offscreen, last error.
- `Frames/Shadow DOM`: per-frame injected/scanned/skipped.
- `Classifier`: category summary and rule reasons.
- `Compare Rendering`: highlights support and fallback counters.
- `Events`: timeline-level failures and retries.

---

## What To Include In Bug Reports
1. Output from `Copy diagnostics`.
2. Approximate timestamp and page URL/origin.
3. Current mode (`PROXY`/`BYOK`) and connection test result.
4. Whether issue is reproducible after extension reload.
