# Method Editor

Method Editor leaves normal VS Code file navigation alone until you explicitly enter a focused method-only editing mode.

## Workflow

1. Navigate files normally.
2. Put the cursor anywhere inside a method.
3. Run **Method Editor: Enter Method Editor** (`Ctrl+Alt+M`).
4. The editor now contains only that method and remains editable.
5. Put the cursor on a method call and press `Ctrl+Enter`.
6. The called method opens in a **new editor pane to the right**. The caller stays visible.
7. Repeat `Ctrl+Enter` to grow the method workspace as you follow the code.
8. Use `Alt+Left` / `Alt+Right` to walk the method history.
9. Use `Ctrl+Alt+Enter` to exit the active method back to its real source file.

## Navigation

- `Ctrl+Alt+M` — Enter Method Editor from a normal file
- `Ctrl+Enter` — Open called method in a new editor pane
- `Alt+Left` — Back through method history
- `Alt+Right` — Forward through method history
- `Alt+[` — Previous method in the current file
- `Alt+]` — Next method in the current file
- `Ctrl+Shift+M` — Pick a method in the current file
- `Ctrl+Alt+Enter` — Exit the active Method Editor to source

Edits in every method-only document are mirrored into the original source document as you type.

Method discovery uses the active language's VS Code document-symbol provider. Following a call maps the cursor back to the original source document and uses that language's definition provider, including Java/JDT.


## 0.7.0 behavior

Method Mode now uses a single editor surface. Ctrl+Enter replaces the current method with the called method; Alt+Left / Alt+Right navigates method history. No editor groups or splits are created.
