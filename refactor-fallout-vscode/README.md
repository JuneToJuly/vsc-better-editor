# Refactor Fallout

JavaScript-only VS Code extension for turning compiler diagnostics into repair sessions.

## Run

1. Open this folder in VS Code.
2. Press `F5`.
3. In the Extension Development Host run `Refactor Fallout: Open Mural`.

There is no TypeScript, compile step, generated `out/` directory, or npm dependency required for the extension runtime.

## Source

- `src/extension.js` — extension activation, repair sessions, mural UI, quick-fix handling
- `src/diagnostics.js` — diagnostic grouping and built-in explanations
- `src/model.js` — small diagnostic helpers

All code editing/navigation is performed in normal VS Code editor tabs. The mural is only the repair control surface.

## Warnings
Use **Warnings On/Off** in the mural toolbar. Errors are always included. When enabled, warnings are included in groups and Repair All. The setting is saved per workspace.
