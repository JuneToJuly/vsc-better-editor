# X-Plane Timeline

Walk through your development one save at a time.

X-Plane records a private Git commit whenever a file is saved. It uses a private Git index and a hidden ref under `refs/x-plane/timeline/`, so recording does not check out another branch, move `HEAD`, or change the normal staging area.

## How recording works

1. VS Code fires `onDidSaveTextDocument`.
2. X-Plane creates a temporary private Git index.
3. The private index starts from the previous timeline commit, or from `HEAD` for the first save.
4. The working tree is added to that private index.
5. `git write-tree` creates the repository snapshot.
6. `git commit-tree` creates a commit whose parent is the previous timeline commit.
7. `git update-ref` advances `refs/x-plane/timeline/<branch>`.

The checked-out branch and `.git/index` are never changed.

## Walking through history

Open the X-Plane timeline and click a recorded save. X-Plane opens the incremental change in VS Code's native diff editor.

While an X-Plane diff is active, the editor title provides:

- **Previous Diff** to open the preceding save.
- **Next Diff** to open the following save.

The unavailable action is hidden at the beginning or end of the loaded timeline. There is no replay webview, slider, autoplay, or playback-speed state.

## Newly initialized repositories

X-Plane also records repositories whose current branch does not have its first normal Git commit yet. It creates a private empty baseline commit beneath the X-Plane timeline ref so the first save has a usable diff. This does not create a commit on the checked-out branch or change `HEAD` or `.git/index`.

## Commands

- `X-Plane: Refresh Timeline`
- `X-Plane: Open Save Diff`
- `Previous Diff`
- `Next Diff`
- `X-Plane: Pause Recording`
- `X-Plane: Resume Recording`
- `X-Plane: Open Current Branch Timeline`

## Peek and modal diff navigation

When VS Code displays an X-Plane diff in a peek or modal editor, Previous Diff and Next Diff are shown as CodeLens actions at the top of the current-save side. Full editor tabs also retain their editor-title buttons.


## Line-ending handling

Timeline snapshots honor Git's configured line-ending conversion, but disable `core.safecrlf` only for the extension's private-index `git add`. This prevents LF/CRLF safety warnings from blocking a save snapshot. The working files and normal Git index are not modified.

## Nested repositories

X-Plane records each Git repository independently. When one repository is located inside another repository's working tree, the parent snapshot excludes that nested repository. This prevents Git from trying to stage the nested repository as a gitlink, including when the nested repository has not made its first commit yet.

## Synchronized timeline selection

When a save diff opens, X-Plane selects the matching save in the Development Timeline tree. Previous Diff and Next Diff keep that selection synchronized, so the sidebar always shows the current replay position.


## Version 0.4.6

Timeline navigation now preserves tree-item identity while refreshing, allowing Previous Diff and Next Diff to reliably reveal and select the matching save in the X-Plane sidebar.

## Timeline selection synchronization

The active replay save is selected and marked as `current` in the timeline whenever a diff is opened or Previous Diff / Next Diff is used.
