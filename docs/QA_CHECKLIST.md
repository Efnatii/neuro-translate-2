# QA Checklist (Manual, Edge)

## Environment
- Edge (stable channel), extension loaded unpacked.
- Test pages available (simple, big DOM, iframe, shadow DOM).
- Credentials configured (Proxy or BYOK) and connection test is green.

## Core Flow
- [ ] Open test page and click `Translate`.
- [ ] Verify stage flow: `preparing -> awaiting_categories -> running -> done`.
- [ ] Confirm categories are shown only after planning.
- [ ] Start with recommended categories only; progress increases and blocks complete.

## Streaming and Apply
- [ ] During run, verify status/progress updates continuously (no long UI freeze).
- [ ] Check compare mode on/off switch works and translated text is applied.
- [ ] Confirm no obvious DOM breakage while streaming.

## Cancel and Resume
- [ ] Start translation, then click `Cancel`.
- [ ] Confirm status becomes `cancelled` and no further deltas are applied.
- [ ] Start again and verify new run proceeds normally.

## Reload / Restart Robustness
- [ ] While job is active, reload extension runtime and reopen popup/debug.
- [ ] Confirm job does not remain stuck forever without lease progress.
- [ ] Confirm either safe recovery or explicit terminal error with reason.

## Memory / Cache
- [ ] Translate page, reload same page, verify memory restore path triggers.
- [ ] Confirm restore stats are visible and only matching blocks are restored.
- [ ] Erase page memory and verify restore is no longer used.

## Multi-Tab Scheduling
- [ ] Start translation in tab A and tab B.
- [ ] Verify scheduler queues both and progress is observable per tab.
- [ ] Use `Pause other tabs` in debug and confirm priority shift.

## Frames and Shadow DOM
- [ ] On iframe test page, verify iframe text is scanned and translated.
- [ ] On shadow test page, verify open shadow-root text is scanned/applied.
- [ ] In debug, verify skipped frames include reason when permission is missing.

## Compare Rendering
- [ ] In highlight-supported browser path, compare mode uses highlights (no wrapper marks injected).
- [ ] If fallback is forced, verify wrappers apply only to safe nodes.

## Diagnostics and Reporting
- [ ] Click `Copy diagnostics` in debug and verify clipboard contains redacted JSON.
- [ ] In popup, click `Почему не стартует?` and verify debug opens to troubleshooting section.
- [ ] Export report JSON/HTML and verify files are generated.

## Exit Criteria
- [ ] No blocking regression in start/stream/cancel/restart.
- [ ] No critical errors in event log for happy path.
- [ ] Diagnostics and troubleshooting paths are usable for support.
