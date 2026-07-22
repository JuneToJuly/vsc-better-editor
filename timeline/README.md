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
