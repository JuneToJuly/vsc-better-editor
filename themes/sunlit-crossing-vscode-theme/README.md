# Sunlit Crossing

A light VS Code theme inspired by a warm countryside railway painting.

The UI uses:
- forest and olive greens
- railway-crossing gold
- sky blue
- warm ivory
- soft cream panels

The syntax palette adds:
- vivid blue keywords
- cyan-blue types
- strong green strings
- orange numbers
- red-orange annotations and exceptions
- warm brown-gray comments

## Install

Extract this folder into your VS Code extensions directory:

- Windows: `%USERPROFILE%\.vscode\extensions\sunlit-crossing-theme-1.0.0`
- macOS/Linux: `~/.vscode/extensions/sunlit-crossing-theme-1.0.0`

Restart VS Code, run **Preferences: Color Theme**, and select **Sunlit Crossing**.

## Package as a VSIX

Install the VS Code extension packaging tool:

```bash
npm install -g @vscode/vsce
```

Then run this inside the extension folder:

```bash
vsce package
```
