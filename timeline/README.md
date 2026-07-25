# X-Plane Timeline

X-Plane records a private Git snapshot whenever a file is saved, then lets you move through those changes as a horizontal code history.

Recording uses a private Git index and a hidden ref under `refs/x-plane/timeline/`. It does not move `HEAD`, check out another branch, or modify the repository's normal staging area.

## Horizontal Change Viewer

Click a save in the Development Timeline or run **X-Plane: Open Change Viewer**.

The viewer displays each recorded save as a column containing the actual Git patch for that save. Move left and right across the project history instead of repeatedly opening separate diff editors.

Controls include:

- Mouse wheel, horizontal wheel, trackpad, or click-and-drag scrolling.
- Left and Right Arrow keys to move one save at a time.
- Home and End to jump to the oldest or newest loaded save.
- Compact, Readable, and Wide column widths.
- Lazy patch loading for long timelines.
- Automatic synchronization with the play icon in the sidebar.
- **Open native diff** as an optional drill-down for any save.

The viewer supports saves that affect more than one file, although normal save-by-save use generally produces one main file change per column.

## Recording behavior

1. VS Code fires `onDidSaveTextDocument`.
2. X-Plane creates a temporary private Git index.
3. The private index starts from the previous timeline snapshot, or `HEAD` for the first save.
4. The current working tree is added to the private index.
5. `git write-tree`, `git commit-tree`, and `git update-ref` create and advance the hidden timeline.

New repositories with an unborn `HEAD` are supported through a private empty baseline commit. Nested repositories are excluded from their parent repository's snapshot and recorded independently. Line-ending safety warnings are disabled only for the private-index `git add` operation.

## Commands

- `X-Plane: Open Change Viewer`
- `X-Plane: Open Save Diff`
- `X-Plane: Refresh Timeline`
- `Previous Diff`
- `Next Diff`
- `X-Plane: Pause Recording`
- `X-Plane: Resume Recording`
- `X-Plane: Open Current Branch Timeline`

## Version 0.5.0

Adds the horizontal Change Viewer, lazy inline patch rendering, adjustable column widths, drag and wheel navigation, keyboard navigation, and synchronized sidebar position.


## 0.5.1 viewer refinements

- Cleaner movie-frame save cards
- Git patch metadata hidden by default
- Addition, deletion, hunk, and file summaries
- Clickable change-magnitude minimap
- Unchanged context lines rendered with reduced emphasis


## 0.5.2

Each patch hunk now includes a **Jump to line** action. It opens the current workspace file and places the cursor at the hunk location.


## 0.5.4

- Places each hunk jump action on a dedicated row above the rendered code.
- Jumping to a hunk now selects the added/replacement line range in the current workspace file.


### Accurate hunk jumping

Jump-to-hunk now searches the current workspace file for the actual added code and selects that block. Historical line numbers are used only as a fallback when later edits have shifted the file.
