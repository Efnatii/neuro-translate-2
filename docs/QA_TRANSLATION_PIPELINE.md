# QA Translation Pipeline (Edge/Chromium, 10 minutes)

This checklist validates the end-to-end translation pipeline in manual smoke mode.

## Quick commands

- Mock suite: `npm run test:e2e:mock`
- Real smoke subset (C1/C3/C5): `npm run test:e2e:real`
- Real full e2e: `npm run test:e2e:real:all`
- Real external smoke (fimfiction, opt-in): `TEST_REAL_FIMFICTION=1 npm run test:e2e:real:fimfiction`
- Fast pipeline unit/integration checks: `npm run test:unit:pipeline`

1. Open a page with visible content and click `Перевести` in popup.
2. Confirm categories are hidden during scan/pre-analysis and planning.
3. Open debug and verify planning trace includes:
   - `agent.plan.set_taxonomy`
   - `agent.plan.set_pipeline`
   - `agent.plan.request_finish_analysis` with `ok=true`
4. Wait for `awaiting_categories`, select categories, and click start for selected categories.
5. Confirm streaming is visible on page before final `DONE`.
6. Toggle `Оригинал` / `Перевод` / `Сравнение` and verify page remains stable.
7. Click `Отменить` during stream and confirm status becomes `CANCELLED` (or equivalent cancel state).
8. Start translation again, reload tab mid-stream, and verify job recovers (no permanent `RUNNING`).
9. Close popup while translation is active, reopen popup/debug, and verify state/progress persisted.
10. Reopen the same page and verify memory restore is used (fewer/no new LLM calls when cache hits).

## Expected diagnostics in debug

- Job status transitions: `preparing -> planning -> awaiting_categories -> running -> done` (or explicit cancel/fail).
- Tool trace includes planning and execution tools.
- Patch history and checklist are populated.
- No secrets are shown in exports (tokens/keys/authorization must be redacted).

