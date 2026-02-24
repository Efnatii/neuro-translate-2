# Release Guide (Edge Add-ons)

## Prerequisites
- Node.js and npm installed.
- Edge extension loaded and local e2e environment available.
- Valid OpenAI/proxy test setup for smoke scenarios.

## Release Steps
1. Install dependencies:
   - `npm ci`
2. Run manifest security audit:
   - `npm run lint:manifest`
3. Build release ZIP:
   - `npm run build:zip`
4. Run quick smoke subset:
   - `npm run smoke:edge`
5. Run full e2e before final publication:
   - `npm run test:e2e`
6. Upload ZIP from `dist/` to Edge Partner Center.

## Smoke Checklist
- `proxy/BYOK` paths still work in popup/debug flows.
- Redaction output remains enabled in debug/export report.
- No remote executable code:
  - no remote `<script src=...>` in extension pages
  - no remote `importScripts(...)`
  - CSP script-src limited to packaged code (`'self'`)
- `lint:manifest` passes without critical findings.
- `smoke:edge` is green.

## Packaging Notes
- `build:zip` writes `extension/buildInfo.json` with:
  - extension version
  - git SHA
  - build timestamp
- ZIP output naming:
  - `neuro-translate-edge-mv3-<version>.zip`
