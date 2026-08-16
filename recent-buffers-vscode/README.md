# Recent Buffers

A small VS Code extension that treats files like buffers instead of tabs.

## Behavior

- `Ctrl+E` (`Cmd+E` on macOS) opens **Recent Buffers**.
- Files remain in history after their editor is closed.
- Each buffer remembers its most recent cursor/selection.
- The current file is excluded from the initial result list, so `Ctrl+E`, `Enter` switches to the previous buffer.
- Typing filters recent buffers first.
- If the typed query has no recent match, the picker automatically searches files in the active workspace folder (the "project").
- Press `Tab` while the picker is open to search all workspace folders.
- Press `Tab` again to return to the recent/project behavior.
- Selected files always open in the active editor group.

## Tab-free setup

Run **Recent Buffers: Apply Single-Viewport Settings** once to set:

```json
"workbench.editor.showTabs": "none",
"workbench.editor.enablePreview": false
```

This intentionally does not create or manage editor groups.

## Commands

- `Recent Buffers: Show`
- `Recent Buffers: Expand Search Scope`
- `Recent Buffers: Apply Single-Viewport Settings`
- `Recent Buffers: Clear History`


## Previous Buffer

Use **Recent Buffers: Previous Buffer** (`recentBuffers.previousBuffer`) to immediately switch to the most recently visited file other than the current file. Repeating the command toggles between the last two files. Bind it to any shortcut you prefer in Keyboard Shortcuts.
