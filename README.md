# neuro-translate-2

## Extension file layout rules

- New AI files must be placed only in `extension/ai`.
- UI files must be placed only in `extension/ui`.
- Core shared files must be placed only in `extension/core`.
- Background orchestration files must be placed only in `extension/bg`.
- Content scripts must be placed only in `extension/content`.
- Do not create files in `extension/` root except `extension/manifest.json`.

## Edge install (canonical path)

1. Open `edge://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the folder: `.../neuro-translate-2/extension`.

`extension/manifest.json` is the only canonical manifest for this project.

## If Edge says “Файл манифеста отсутствует”

You selected the wrong folder. Load **`/extension`** (not repository root).
