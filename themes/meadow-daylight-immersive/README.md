# Meadow Daylight Immersive

A refined countryside-inspired light theme with stronger editor/sidebar/panel separation, clearer syntax, softer focus states, and an optional illustrated UI layer.

## Install the theme

1. Install the included `.vsix` with **Extensions: Install from VSIX...**
2. Select **Meadow Daylight Immersive** from **Preferences: Color Theme**.
3. Reload VS Code if the theme does not appear immediately.

## Included layers

### Standard theme

Works normally in VS Code and provides:

- parchment editor surface
- sky-blue tabs
- sage Explorer and auxiliary bar
- warm terminal and bottom panel
- stronger active selections and borders
- detailed TextMate and semantic highlighting
- Git, diff, debugger, testing, terminal, widgets, menus, and command-center colors

### Recommended settings

Copy values from `immersive-layer/recommended-settings.json` into your VS Code settings.

### Optional rounded UI

`immersive-layer/apc-settings.json` contains a starting configuration for APC Customize UI++.

### Optional illustrated wallpaper

`immersive-layer/custom.css` and `meadow-wallpaper.png` provide the closest version to the concept art. This layer requires a third-party custom-CSS loader because normal VS Code themes cannot inject artwork or change component geometry.

Before enabling it, replace `__EXTENSION_PATH__` in `custom.css` with the absolute `file:///...` URI of the installed extension folder.

Custom CSS injection is unsupported by VS Code and may need to be re-enabled after updates.
