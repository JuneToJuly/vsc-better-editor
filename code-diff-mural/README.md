# Code Diff Mural

A pan-and-zoom VS Code mural for comparing source changes between any two Git branches, commits, or tags.

## 0.0.11

- Compare any two Git revisions instead of always comparing against the checked-out working tree.
- The target side defaults to the current checked-out branch/HEAD and can be changed from the toolbar.
- The base picker excludes the currently selected target, and the target picker excludes the selected base.
- Auto Layout now resets package positions in place and refits the mural instead of reloading the webview.
- Open File opens the target-side source. If the target is the checked-out HEAD, it opens the real workspace file; otherwise it opens a read-only Git snapshot.
- Open Diff compares the selected base and target snapshots.

## Navigation

- Mouse wheel: zoom
- Shift + mouse wheel: pan
- Space + drag / middle drag: free pan
- Drag package headers: manually arrange packages
- Auto Layout: restore automatic package placement
- Double click change: open target file
- Right click change: open file or side-by-side diff
