## 0.3.6

- All Files now uses bounded progressive candidate discovery followed by the same fuzzy `filename + path` scoring as Recent Buffers.
- Fixes searches where part of the query matches the filename and later characters match the workspace/path context.
- Candidate discovery stays bounded; the extension still does not preload the entire workspace.
- Rebalanced side-by-side columns to give filenames/class names substantially more visible width.
- Tightened line/age/visit metadata columns to preserve space for filenames.

## 0.3.5

- The file active when Recent Buffers opens is now excluded from the Recent Buffers pane for that invocation.
- Added `Recent Buffers: Previous Buffer` (`recentBuffers.previousBuffer`).
- Previous Buffer restores the saved cursor location and repeated use toggles between the last two files.
- No default keybinding is assigned to Previous Buffer so it does not override an existing VS Code shortcut.

## 0.3.4

- Fixed initial keystrokes sometimes being lost immediately after opening Recent Buffers.
- The search input now uses native autofocus and claims focus immediately during webview startup.
- Focus is reinforced on the first animation frames and when VS Code reports the webview ready/visible.
- Refocusing preserves the caret at the end of the current query.

## 0.3.3

- The two-pane layout is now permanent: Recent Buffers always stays on the left and All Files always stays on the right.
- Removed the width jump when All Files gains or loses results.
- All Files shows a lightweight search hint before the minimum query length is reached.
- Reduced row height, gaps, header padding, search height, and footer padding to fit more files vertically.

## 0.3.2

- Recent Buffers and All Files now render side-by-side.
- Both panes use the full result height and scroll independently.
- Tab still jumps to the first All Files result.

## 0.3.1

- Split search results into independently scrollable Recent Buffers and All Files panes when file results exist.
- All Files is now always visible instead of being pushed below a long recent-buffer list.
- Recent uses roughly 42% of the result area and All Files uses the remaining space.
- Tab jumps to the first visible All Files result and scrolls that pane to the top.
- Keyboard navigation continues across both sections as one result sequence.

## 0.3.0

- Improved typography and visual hierarchy for result rows.
- Filenames are stronger; paths and metadata are quieter.
- Line/column uses the editor monospace font.
- Rows are slightly taller with tighter column spacing.
- Selected rows use a subtler background plus a left accent bar.
- Long paths preserve the useful trailing portion.

## 0.2.9

- Fixed fast typing being overwritten by older async search responses.
- The search input is now owned entirely by the webview while typing; result updates never write query text back into the input.
- Added request IDs so stale search results are ignored deterministically.

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
