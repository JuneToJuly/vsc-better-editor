const vscode = require("vscode");

const FLOW_STATE_KEY = "codeFlow.state";
const PREVIEW_RADIUS = 3;

let flowState = {
    activeFlow: "Default",
    promptEnabled: true,
    flows: {
        Default: []
    }
};

let replayState = {
    active: false,
    index: 0,
    panel: null,
    decoration: null
};

function activate(context) {
    flowState = context.workspaceState.get(FLOW_STATE_KEY, flowState);

    if (!flowState.flows) {
        flowState = {
            activeFlow: "Default",
            promptEnabled: true,
            flows: {
                Default: []
            }
        };
    }

    if (flowState.promptEnabled === undefined) {
        flowState.promptEnabled = true;
    }

    replayState.decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        backgroundColor: "rgba(255, 255, 0, 0.16)",
        border: "1px solid rgba(255, 255, 0, 0.45)"
    });

    context.subscriptions.push(replayState.decoration);

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.snap", () => snapSelection(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.show", () => showFlow(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.clear", () => clearFlow(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.createFlow", () => createFlow(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.switchFlow", () => switchFlow(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.exportFlow", () => exportCurrentFlow(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.togglePrompt", () => togglePrompt(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.replay", () => startReplay(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.replayNext", () => replayNext(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.replayPrevious", () => replayPrevious(context))
    );

    context.subscriptions.push(
        vscode.commands.registerCommand("codeFlow.stopReplay", () => stopReplay())
    );
}

function getActiveSnaps() {
    const name = flowState.activeFlow || "Default";

    if (!flowState.flows[name]) {
        flowState.flows[name] = [];
    }

    return flowState.flows[name];
}

async function saveState(context) {
    await context.workspaceState.update(FLOW_STATE_KEY, flowState);
}

async function togglePrompt(context) {
    flowState.promptEnabled = !flowState.promptEnabled;
    await saveState(context);

    vscode.window.showInformationMessage(
        `Code Flow prompt is now ${flowState.promptEnabled ? "ON" : "OFF"}.`
    );
}

async function snapSelection(context) {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.document.uri.scheme !== "file") {
        vscode.window.showWarningMessage("No active local file.");
        return;
    }

    const snaps = getActiveSnaps();
    const doc = editor.document;
    const selection = editor.selection;

    const startLine = selection.start.line;
    const endLine = selection.end.line;
    const character = selection.start.character;

    const selectedText = selection.isEmpty
        ? doc.lineAt(startLine).text.trim()
        : doc.getText(selection);

    let prompt = "";

    if (flowState.promptEnabled) {
        const result = await vscode.window.showInputBox({
            prompt: "Review note for this snap",
            placeHolder: "Example: This is where the request is serialized before sending."
        });

        if (result === undefined) {
            return;
        }

        prompt = result;
    }

    const previewStart = Math.max(0, startLine - PREVIEW_RADIUS);
    const previewEnd = Math.min(doc.lineCount - 1, endLine + PREVIEW_RADIUS);

    const previewLines = [];

    for (let i = previewStart; i <= previewEnd; i++) {
        previewLines.push({
            lineNumber: i,
            text: doc.lineAt(i).text
        });
    }

    const snap = {
        id: Date.now() + "-" + Math.random().toString(16).slice(2),
        order: snaps.length + 1,
        file: vscode.workspace.asRelativePath(doc.uri),
        fullUri: doc.uri.toString(),
        selectedText,
        prompt,
        previewLines,
        startLine,
        endLine,
        character,
        timestamp: Date.now()
    };

    snaps.push(snap);

    await saveState(context);

    vscode.window.showInformationMessage(
        `Snapped #${snap.order} to "${flowState.activeFlow}": ${singleLine(selectedText)}`
    );
}

async function createFlow(context) {
    const name = await vscode.window.showInputBox({
        prompt: "New code flow name",
        placeHolder: "Login Flow"
    });

    if (!name) return;

    if (flowState.flows[name]) {
        vscode.window.showWarningMessage(`Flow "${name}" already exists.`);
        return;
    }

    flowState.flows[name] = [];
    flowState.activeFlow = name;

    await saveState(context);

    vscode.window.showInformationMessage(`Created and switched to "${name}".`);
}

async function switchFlow(context) {
    const names = Object.keys(flowState.flows);

    if (names.length === 0) {
        vscode.window.showWarningMessage("No flows exist.");
        return;
    }

    const selected = await vscode.window.showQuickPick(names, {
        placeHolder: "Select code flow"
    });

    if (!selected) return;

    flowState.activeFlow = selected;
    await saveState(context);

    vscode.window.showInformationMessage(`Switched to "${selected}".`);
}

async function showFlow(context) {
    const snaps = getActiveSnaps();

    if (snaps.length === 0) {
        vscode.window.showInformationMessage(`Flow "${flowState.activeFlow}" has no snaps yet.`);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        "codeFlow",
        `Code Flow: ${flowState.activeFlow}`,
        vscode.ViewColumn.Beside,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getFlowHtml(flowState.activeFlow, snaps);

    panel.webview.onDidReceiveMessage(async message => {
        if (message.command === "open") {
            const snap = getActiveSnaps().find(s => s.id === message.id);
            if (!snap) return;

            await openSnapInEditor(snap);
        }

        if (message.command === "remove") {
            flowState.flows[flowState.activeFlow] =
                getActiveSnaps().filter(s => s.id !== message.id);

            renumberSnaps();
            await saveState(context);

            panel.webview.html = getFlowHtml(flowState.activeFlow, getActiveSnaps());
        }

        if (message.command === "clear") {
            getActiveSnaps().length = 0;
            await saveState(context);
            panel.dispose();
        }

        if (message.command === "export") {
            await exportCurrentFlow(context);
        }

        if (message.command === "replay") {
            await startReplay(context);
        }
    });
}

async function clearFlow(context) {
    getActiveSnaps().length = 0;
    await saveState(context);

    vscode.window.showInformationMessage(`Cleared flow "${flowState.activeFlow}".`);
}

async function exportCurrentFlow(context) {
    const flowName = flowState.activeFlow || "Default";
    const snaps = getActiveSnaps();

    if (snaps.length === 0) {
        vscode.window.showInformationMessage(`Flow "${flowName}" is empty.`);
        return;
    }

    const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(`${sanitizeFileName(flowName)}.md`),
        filters: {
            Markdown: ["md"],
            JSON: ["json"]
        }
    });

    if (!uri) return;

    const isJson = uri.fsPath.toLowerCase().endsWith(".json");

    const content = isJson
        ? JSON.stringify({ name: flowName, promptEnabled: flowState.promptEnabled, snaps }, null, 2)
        : buildMarkdownExport(flowName, snaps);

    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));

    vscode.window.showInformationMessage(`Exported "${flowName}".`);
}

async function startReplay(context) {
    const snaps = getActiveSnaps();

    if (snaps.length === 0) {
        vscode.window.showInformationMessage(`Flow "${flowState.activeFlow}" has no snaps yet.`);
        return;
    }

    replayState.active = true;
    replayState.index = 0;

    if (!replayState.panel) {
        replayState.panel = vscode.window.createWebviewPanel(
            "codeFlowReplay",
            `Replay: ${flowState.activeFlow}`,
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        replayState.panel.onDidDispose(() => {
            replayState.panel = null;
            clearReplayHighlight();
            replayState.active = false;
        });

        replayState.panel.webview.onDidReceiveMessage(async message => {
            if (message.command === "next") {
                await replayNext(context);
            }

            if (message.command === "previous") {
                await replayPrevious(context);
            }

            if (message.command === "stop") {
                stopReplay();
            }

            if (message.command === "open") {
                const snap = getActiveSnaps()[replayState.index];
                if (snap) {
                    await openSnapInEditor(snap, true);
                }
            }
        });
    }

    await openReplaySnap(context, replayState.index);
}

async function replayNext(context) {
    if (!replayState.active) {
        await startReplay(context);
        return;
    }

    const snaps = getActiveSnaps();

    if (replayState.index >= snaps.length - 1) {
        vscode.window.showInformationMessage("Already at the last snap.");
        return;
    }

    replayState.index += 1;
    await openReplaySnap(context, replayState.index);
}

async function replayPrevious(context) {
    if (!replayState.active) {
        await startReplay(context);
        return;
    }

    if (replayState.index <= 0) {
        vscode.window.showInformationMessage("Already at the first snap.");
        return;
    }

    replayState.index -= 1;
    await openReplaySnap(context, replayState.index);
}

async function openReplaySnap(context, index) {
    const snaps = getActiveSnaps();
    const snap = snaps[index];

    if (!snap) return;

    await openSnapInEditor(snap, true);

    if (replayState.panel) {
        replayState.panel.webview.html = getReplayHtml(
            flowState.activeFlow,
            snap,
            index,
            snaps.length
        );

        replayState.panel.reveal(vscode.ViewColumn.Beside, true);
    }
}

function stopReplay() {
    replayState.active = false;
    replayState.index = 0;

    clearReplayHighlight();

    if (replayState.panel) {
        replayState.panel.dispose();
        replayState.panel = null;
    }

    vscode.window.showInformationMessage("Code Flow replay stopped.");
}

async function openSnapInEditor(snap, highlight = false) {
    const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(snap.fullUri)
    );

    const editor = await vscode.window.showTextDocument(doc, {
        preview: false,
        viewColumn: vscode.ViewColumn.One
    });

    const safeStartLine = Math.min(
        editor.document.lineCount - 1,
        Math.max(0, snap.startLine)
    );

    const safeEndLine = Math.min(
        editor.document.lineCount - 1,
        Math.max(safeStartLine, snap.endLine)
    );

    const safeCharacter = Math.min(
        editor.document.lineAt(safeStartLine).text.length,
        Math.max(0, snap.character || 0)
    );

    const start = new vscode.Position(safeStartLine, safeCharacter);
    const end = new vscode.Position(
        safeEndLine,
        editor.document.lineAt(safeEndLine).text.length
    );

    editor.selection = new vscode.Selection(start, start);

    editor.revealRange(
        new vscode.Range(start, end),
        vscode.TextEditorRevealType.InCenter
    );

    if (highlight) {
        clearReplayHighlight();

        const highlightStart = new vscode.Position(safeStartLine, 0);
        const highlightEnd = new vscode.Position(
            safeEndLine,
            editor.document.lineAt(safeEndLine).text.length
        );

        editor.setDecorations(replayState.decoration, [
            new vscode.Range(highlightStart, highlightEnd)
        ]);
    }
}

function clearReplayHighlight() {
    if (!replayState.decoration) return;

    vscode.window.visibleTextEditors.forEach(editor => {
        editor.setDecorations(replayState.decoration, []);
    });
}

function renumberSnaps() {
    getActiveSnaps().forEach((snap, index) => {
        snap.order = index + 1;
    });
}

function escapeMermaidLabel(value) {
    return String(value)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\r?\n/g, " ");
}

function buildMarkdownExport(flowName, snaps) {
    return `# ${flowName}

\`\`\`mermaid
flowchart TD
${snaps.map((snap, index) => {
        const node = `N${index}`;
        const label = escapeMermaidLabel(
            `${index + 1}. ${snap.file}:${snap.startLine + 1}`
        );

        if (index === 0) {
            return `${node}["${label}"]`;
        }

        return `N${index - 1} --> ${node}
${node}["${label}"]`;
    }).join("\n")}
\`\`\`

${snaps.map((snap, index) => {
        return `## ${index + 1}. ${snap.file}:${snap.startLine + 1}

${snap.prompt ? `**Review Note:** ${snap.prompt}\n\n` : ""}\`\`\`java
${snap.selectedText || ""}
\`\`\`
`;
    }).join("\n---\n\n")}`;
}

function getFlowHtml(flowName, snaps) {
    return `
<!DOCTYPE html>
<html>
<head>
<style>
    body {
        font-family: var(--vscode-font-family);
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        padding: 14px;
    }

    h2 {
        margin-top: 0;
    }

    button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 5px 8px;
        cursor: pointer;
        margin-right: 6px;
        margin-bottom: 10px;
    }

    .snap {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        padding: 10px;
        margin-bottom: 12px;
        background: var(--vscode-sideBar-background);
    }

    .header {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 8px;
    }

    .title {
        color: var(--vscode-textLink-foreground);
        font-weight: bold;
    }

    .meta {
        opacity: 0.75;
        font-size: 12px;
        margin-bottom: 8px;
    }

    .prompt {
        border-left: 3px solid var(--vscode-textLink-foreground);
        padding: 6px 8px;
        margin-bottom: 8px;
        background: var(--vscode-textCodeBlock-background);
        white-space: pre-wrap;
    }

    .selected {
        background: var(--vscode-editor-selectionBackground);
        padding: 6px;
        border-radius: 4px;
        white-space: pre-wrap;
        margin-bottom: 8px;
    }

    .preview {
        background: var(--vscode-textCodeBlock-background);
        padding: 8px;
        border-radius: 4px;
        overflow-x: auto;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
    }

    .line {
        white-space: pre;
    }

    .target {
        background: rgba(255, 255, 0, 0.15);
    }

    .arrow {
        text-align: center;
        opacity: 0.6;
        margin: -4px 0 8px 0;
        font-size: 18px;
    }
</style>
</head>
<body>
    <h2>Code Flow: ${escapeHtml(flowName)}</h2>

    <button onclick="exportFlow()">Export</button>
    <button onclick="startReplay()">Replay</button>
    <button onclick="clearFlow()">Clear Flow</button>

    ${snaps.map((snap, index) => renderSnap(snap, index, snaps.length)).join("")}

<script>
    const vscode = acquireVsCodeApi();

    function openSnap(id) {
        vscode.postMessage({ command: "open", id });
    }

    function removeSnap(id) {
        vscode.postMessage({ command: "remove", id });
    }

    function clearFlow() {
        vscode.postMessage({ command: "clear" });
    }

    function exportFlow() {
        vscode.postMessage({ command: "export" });
    }

    function startReplay() {
        vscode.postMessage({ command: "replay" });
    }
</script>
</body>
</html>`;
}

function getReplayHtml(flowName, snap, index, total) {
    return `
<!DOCTYPE html>
<html>
<head>
<style>
    body {
        font-family: var(--vscode-font-family);
        background: var(--vscode-editor-background);
        color: var(--vscode-editor-foreground);
        padding: 14px;
    }

    h2 {
        margin-top: 0;
    }

    button {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border: none;
        padding: 6px 10px;
        cursor: pointer;
        margin-right: 6px;
        margin-bottom: 10px;
    }

    button:disabled {
        opacity: 0.45;
        cursor: default;
    }

    .card {
        border: 1px solid var(--vscode-panel-border);
        border-radius: 6px;
        padding: 12px;
        background: var(--vscode-sideBar-background);
    }

    .step {
        opacity: 0.75;
        font-size: 12px;
        margin-bottom: 8px;
    }

    .file {
        color: var(--vscode-textLink-foreground);
        font-weight: bold;
        margin-bottom: 8px;
    }

    .prompt {
        border-left: 3px solid var(--vscode-textLink-foreground);
        padding: 8px 10px;
        margin-bottom: 10px;
        background: var(--vscode-textCodeBlock-background);
        white-space: pre-wrap;
    }

    .selected {
        background: var(--vscode-editor-selectionBackground);
        padding: 8px;
        border-radius: 4px;
        white-space: pre-wrap;
        margin-bottom: 10px;
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
    }

    .hint {
        opacity: 0.7;
        font-size: 12px;
        margin-top: 10px;
    }
</style>
</head>
<body>
    <h2>Replay: ${escapeHtml(flowName)}</h2>

    <div class="card">
        <div class="step">Step ${index + 1} of ${total}</div>

        <div class="file">
            ${escapeHtml(snap.file)}:${snap.startLine + 1}
        </div>

        ${snap.prompt ? `<div class="prompt">${escapeHtml(snap.prompt)}</div>` : ""}

        <div class="selected">${escapeHtml(snap.selectedText || "[empty selection]")}</div>

        <button onclick="previous()" ${index === 0 ? "disabled" : ""}>Previous</button>
        <button onclick="next()" ${index >= total - 1 ? "disabled" : ""}>Next</button>
        <button onclick="openCurrent()">Open</button>
        <button onclick="stop()">Stop</button>

        <div class="hint">
            Commands also available: Code Flow: Replay Next, Replay Previous, Stop Replay.
        </div>
    </div>

<script>
    const vscode = acquireVsCodeApi();

    function next() {
        vscode.postMessage({ command: "next" });
    }

    function previous() {
        vscode.postMessage({ command: "previous" });
    }

    function openCurrent() {
        vscode.postMessage({ command: "open" });
    }

    function stop() {
        vscode.postMessage({ command: "stop" });
    }
</script>
</body>
</html>`;
}

function renderSnap(snap, index, total) {
    return `
<div class="snap">
    <div class="header">
        <div class="title">#${snap.order} — ${escapeHtml(snap.file)}</div>
        <div>
            <button onclick="openSnap('${snap.id}')">Open</button>
            <button onclick="removeSnap('${snap.id}')">Remove</button>
        </div>
    </div>

    <div class="meta">
        Lines ${snap.startLine + 1}-${snap.endLine + 1}
    </div>

    ${snap.prompt ? `<div class="prompt">${escapeHtml(snap.prompt)}</div>` : ""}

    <div class="selected">${escapeHtml(snap.selectedText || "[empty selection]")}</div>

    <div class="preview">
        ${snap.previewLines.map(line => renderPreviewLine(line, snap)).join("")}
    </div>
</div>

${index < total - 1 ? `<div class="arrow">↓</div>` : ""}`;
}

function renderPreviewLine(line, snap) {
    const isTarget =
        line.lineNumber >= snap.startLine &&
        line.lineNumber <= snap.endLine;

    return `
<div class="line ${isTarget ? "target" : ""}">
${String(line.lineNumber + 1).padStart(4, " ")}  ${escapeHtml(line.text)}
</div>`;
}

function sanitizeFileName(name) {
    return String(name).replace(/[<>:"/\\|?*]+/g, "_");
}

function singleLine(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function deactivate() {
    clearReplayHighlight();

    if (replayState.panel) {
        replayState.panel.dispose();
        replayState.panel = null;
    }

    if (replayState.decoration) {
        replayState.decoration.dispose();
    }
}

module.exports = {
    activate,
    deactivate
};