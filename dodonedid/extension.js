const vscode = require("vscode");
const path = require("path");

function activate(context) {
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "javaValueHider.hideValueCreation",
            generateActionViewFile
        ),
        vscode.commands.registerCommand(
            "javaValueHider.showAll",
            openOriginalFile
        ),
        vscode.commands.registerCommand(
            "javaValueHider.cleanupActionViews",
            cleanupActionViews
        )
    );
}

async function generateActionViewFile() {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.document.languageId !== "java") {
        vscode.window.showWarningMessage("Open a Java file first.");
        return;
    }

    const doc = editor.document;
    const actionViewText = buildActionViewFile(doc);

    const originalPath = doc.uri.fsPath;
    const parsed = path.parse(originalPath);

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(doc.uri);

    if (!workspaceFolder) {
        vscode.window.showWarningMessage("File is not inside a workspace.");
        return;
    }

    const relativeDir = path.relative(workspaceFolder.uri.fsPath, parsed.dir);
    const outputDir = vscode.Uri.joinPath(
        workspaceFolder.uri,
        ".action-view",
        relativeDir
    );

    await vscode.workspace.fs.createDirectory(outputDir);

    const outputUri = vscode.Uri.joinPath(
        outputDir,
        `${parsed.name}.action-view.java`
    );

    await vscode.workspace.fs.writeFile(
        outputUri,
        Buffer.from(actionViewText, "utf8")
    );

    const actionDoc = await vscode.workspace.openTextDocument(outputUri);

    await vscode.window.showTextDocument(actionDoc, {
        preview: false,
        viewColumn: vscode.ViewColumn.Beside
    });

    vscode.window.showInformationMessage(
        `Generated ${parsed.name}.action-view.java`
    );
}

async function openOriginalFile() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const currentPath = editor.document.uri.fsPath;

    if (!currentPath.endsWith(".action-view.java")) {
        vscode.window.showInformationMessage("Current file is not an action-view file.");
        return;
    }

    const originalPath = currentPath.replace(".action-view.java", ".java");
    const originalUri = vscode.Uri.file(originalPath);

    const doc = await vscode.workspace.openTextDocument(originalUri);

    await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.One
    });
}

function buildActionViewFile(doc) {
    const lines = doc.getText().split(/\r?\n/);
    const output = [];

    output.push("// ACTION VIEW");
    output.push(`// Source: ${doc.uri.fsPath}`);
    output.push("// Shows method signatures, branches, and action calls.");
    output.push("");

    for (const line of lines) {
        if (shouldKeepLineInActionView(line)) {
            output.push(line);
        }
    }

    return output.join("\n");
}
function containsMethodCall(text) {
    return /\b[A-Za-z_][A-Za-z0-9_.$]*\s*\(/.test(text);
}

function shouldKeepLineInActionView(line) {
    const trimmed = line.trim();

    if (!trimmed) return false;
    if (trimmed.startsWith("//")) return false;
    if (trimmed.startsWith("*")) return false;

    if (looksLikeMethodSignature(trimmed)) {
        return true;
    }

    if (isPrintOrLogNoise(trimmed)) {
        return false;
    }

    if (looksLikeBranch(trimmed)) {
        return true;
    }

    if (/\bnew\b/.test(trimmed)) {
        return false;
    }

    if (containsMethodCall(trimmed)) {
        return true;
    }

    return false;
}

function looksLikeMethodSignature(text) {
    const trimmed = text.replace(/\s+/g, " ").trim();

    if (!trimmed.includes("(")) return false;
    if (!trimmed.includes(")")) return false;

    if (/^(if|for|while|switch|catch|else|new|return|throw)\b/.test(trimmed)) {
        return false;
    }

    if (trimmed.includes("->")) {
        return false;
    }

    return /\b(public|private|protected)\s+[\w<>\[\].?,\s]+\s+[A-Za-z_][A-Za-z0-9_]*\s*\([^)]*\)\s*\{?/.test(trimmed);
}

function looksLikeBranch(text) {
    return /^(if|else if|while|for|switch|catch|try|else)\b/.test(text);
}

function isPrintOrLogNoise(text) {
    return text.includes("System.out.print")
        || text.includes("System.err.print")
        || text.includes("printStackTrace");
}

function isValueAssignmentLine(text) {
    return /^[A-Za-z_][A-Za-z0-9_.$<>\[\]? ,]*\s+[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)
        || /^var\s+[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text)
        || /^(this\.)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(text);
}

function looksLikeStandaloneMethodCall(text) {
    if (!text.endsWith(";") && !text.endsWith("{") && !text.includes("->")) {
        return false;
    }

    return /^[A-Za-z_][A-Za-z0-9_.$]*\s*\.\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(text);
}
async function cleanupActionViews() {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

    if (!workspaceFolder) {
        vscode.window.showWarningMessage("No workspace folder found.");
        return;
    }

    const actionViewDir = vscode.Uri.joinPath(
        workspaceFolder.uri,
        ".action-view"
    );

    const answer = await vscode.window.showWarningMessage(
        "Delete all generated action-view files?",
        { modal: true },
        "Delete"
    );

    if (answer !== "Delete") {
        return;
    }
for (const tabGroup of vscode.window.tabGroups.all) {
    const tabsToClose = tabGroup.tabs.filter(tab => {
        return tab.input?.uri?.fsPath?.endsWith(".action-view.java");
    });

    if (tabsToClose.length > 0) {
        await vscode.window.tabGroups.close(tabsToClose);
    }
}

    try {
        await vscode.workspace.fs.delete(actionViewDir, {
            recursive: true,
            useTrash: false
        });

        vscode.window.showInformationMessage("Deleted .action-view folder.");
    } catch {
        vscode.window.showInformationMessage("No .action-view folder found.");
    }


}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};