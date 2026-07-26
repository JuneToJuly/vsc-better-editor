# Visual Bookmarks

A basic-JavaScript VS Code extension that places bookmarks in a stable landmark-based visual map.

## Current prototype

- The map opens as a maximized, modal-like editor overlay and restores the layout when closed.
- The cursor always begins at the center.
- Arrow keys and `HJKL` navigate spatially with a fading travel trail.
- `Tab` and `Shift+Tab` cycle through every currently visible marker.
- Press `/` or `Ctrl+F` to search. The filter temporarily hides markers that do not match a label, filename, nearby code, color, shape, landmark, or direction.
- `Enter` leaves search mode and selects the first visible match.
- `Esc` clears the active search first; pressing it again closes the map.
- Landmark/color chords jump directly to a visual region:
  - `T B` — tree, blue
  - `R B` — rocket, blue
  - `C G` — castle, green
  - `W P` — whale, purple
  - `M O` — moon, orange
- Repeat the same chord to cycle when several bookmarks share that landmark and color.
- `Home` returns to the map center.
- `Enter` opens the selected bookmark, and `Delete` removes it.

Landmark keys are `R` rocket, `T` tree, `C` castle, `W` whale, and `M` moon. Color keys are `B` blue, `R` red, `Y` yellow, `G` green, `P` purple, and `O` orange.

## Run

1. Open this folder in VS Code.
2. Press `F5` to launch an Extension Development Host.
3. Open a workspace.
4. Press `Ctrl+Alt+B` to add a bookmark.
5. Press `Ctrl+Alt+M` to open the map.
