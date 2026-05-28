const vscode = require("vscode");
const path = require("path");
const fs = require("fs");

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
    openTerminal(dir);
}

function openTerminal(cwd) {
    const terminal = vscode.window.createTerminal({
        name: path.basename(cwd),
        cwd
    });

    terminal.show();
}

function deactivate() {}

module.exports = {
    activate,
    deactivate
};