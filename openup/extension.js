const vscode = require("vscode");
const path = require("path");

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "openTerminalAtFile.activeFile",
            openTerminalAtActiveFileDirectory
        )
    );
}

async function openTerminalAtActiveFileDirectory() {
    const editor = vscode.window.activeTextEditor;

    if (!editor) {
        vscode.window.showWarningMessage("No active editor found.");
        return;
    }

    const fileUri = editor.document.uri;

    if (fileUri.scheme !== "file") {
        vscode.window.showWarningMessage("Active editor is not a local file.");
        return;
    }

    const dir = path.dirname(fileUri.fsPath);
    cdTerminal(dir);
}

function cdTerminal(cwd) {
    let terminal = vscode.window.activeTerminal;

    if (!terminal) {
        terminal = vscode.window.createTerminal({
            name: path.basename(cwd),
            cwd
        });

        terminal.show();
        return;
    }

    terminal.show();

    const safePath = quotePathForShell(cwd);
    terminal.sendText(`cd ${safePath}`);
}

function quotePathForShell(filePath) {
    if (process.platform === "win32") {
        return `"${filePath.replace(/"/g, '\\"')}"`;
    }

    return `'${filePath.replace(/'/g, `'\\''`)}'`;
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};
