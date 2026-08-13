## 0.2.8

- Ctrl+J / Ctrl+K are now VS Code extension-level keybindings while Recent Buffers is active.
- Prevents VS Code's normal workbench/editor Ctrl+J/Ctrl+K commands from stealing focus.
- Keeps the Recent Buffers search field focused while navigating results.

## 0.2.7

- Tab jumps directly to the first All Files result.
- Ctrl+J and Ctrl+K navigate down/up through results while the search input keeps focus.
- Arrow-key navigation remains supported.

## 0.2.6

- Removed the Recent / All Files tabs; search is now one unified recent-first list.
- Opening Recent Buffers no longer enumerates workspace files.
- Workspace file search starts only after the configured minimum query length (2 characters by default).
- File search is bounded to 200 results by default instead of caching up to 15,000 workspace paths.
- Matching recent buffers stay above workspace file matches.
- Added a small per-query result cache and stale-search protection.

## 0.2.5

- Simplified navigation to two scopes: Recent and All Files.
- A typed query with no recent match automatically searches all workspace files.
- Tab now toggles directly between Recent and All Files.
- Removed the Project/Workspace distinction and its duplicate configuration.

# Changelog

## 0.2.4

- Removed the inner card/modal framing from the Recent Buffers webview.
- The Recent Buffers UI now fills the entire modal-editor window.
- Removed the extra gray backdrop, border radius, outer border, and drop shadow.
- The results list now expands to use all remaining vertical space.

## 0.2.3

- Restored the rich Recent Buffers webview UI.
- Opens the webview using the same active-column + reveal pattern as Recent Code Locations so modal-editor setups can present it as a modal overlay.
- Preserves Recent / Project / Workspace navigation and remembered cursor restoration.

# Change Log

## 0.1.0

- Initial Recent Buffers implementation.
- Persistent recent-file history independent of open editors.
- Cursor and selection restoration.
- Recent -> project fallback -> workspace search with Tab.
- Single active editor-group opening.
- Optional single-viewport VS Code settings command.
