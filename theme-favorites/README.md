# Theme Favorites

A small JavaScript VS Code extension for rapidly reviewing installed color themes and keeping only the ones you like.

## Review workflow

Run **Theme Favorites: Review All Installed Themes** (`Ctrl+Alt+T`).

The extension discovers color themes contributed by installed extensions (including built-in themes), applies them one at a time to the real VS Code workbench, and keeps the review picker open.

For each preview choose:

- **Favorite & Next** — saves the current theme and immediately previews the next one.
- **Skip & Next** — moves on without favoriting.
- **Previous Theme** — moves backward.
- **Done — Keep This Theme** — exits and leaves the currently previewed theme active.
- **Esc** — cancels review and restores the theme that was active before review started.

## Favorite navigation

- `Ctrl+Alt+]` — next favorite
- `Ctrl+Alt+[` — previous favorite
- **Theme Favorites: Switch to Favorite Theme** — picker containing only favorites; moving the highlight previews each theme live, **Enter** keeps it, and **Esc** restores the theme you started with
- **Theme Favorites: Remove Favorites** — bulk-remove favorites
- **Theme Favorites: Toggle Current Theme Favorite** — add/remove the currently active theme manually

Favorites are stored in VS Code global extension state, so they follow you across workspaces in the same VS Code profile.

## Portable theme bundles

### Export Favorite Theme Bundle
Run **Theme Favorites: Export Favorite Theme Bundle**.

This creates a `.vsthemes` bundle containing:
- your favorite theme list
- theme IDs, labels, UI theme types, and original extension IDs
- the actual files from the extensions that provide those favorite themes

The provider files are included so theme JSON files that use relative includes or companion files continue to work on another machine.

### Import Theme Bundle
Run **Theme Favorites: Import Theme Bundle** and select the `.vsthemes` file.

Theme Favorites creates a local, inert theme-pack extension containing only theme contributions, restores the exported favorites, and offers to reload VS Code. The original theme extensions do not have to be installed on the destination machine.

Imported provider code is not activated by the generated pack; the pack contributes only the exported themes.
