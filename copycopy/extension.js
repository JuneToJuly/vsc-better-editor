const vscode = require('vscode');

let killRing = [];
let lastClipboard = "";
let pollingInterval;

let lastPasteRange = null;
let lastPasteEditor = null;
let cycleIndex = 0;


/**
 * ACTIVATE
 */
function activate(context) {

    const config = vscode.workspace.getConfiguration('copycopy');
    const maxEntries = config.get('maxEntries', 50);
    const pollInterval = config.get('pollInterval', 400);

    startClipboardWatcher(maxEntries, pollInterval);

    context.subscriptions.push(
        vscode.commands.registerCommand('copycopy.open', () => {
            openKillRingWebview(context);
        })
    );

    context.subscriptions.push({
        dispose: () => {
            if (pollingInterval) clearInterval(pollingInterval);
        }
    });
}

/**
 * CLIPBOARD WATCHER
 */
function startClipboardWatcher(maxEntries, pollRate) {
    pollingInterval = setInterval(async () => {
        try {
            const text = await vscode.env.clipboard.readText();

            if (!text || text === lastClipboard) return;

            lastClipboard = text;

            if (text.trim().length === 0) return;

            pushToRing(text, maxEntries);

        } catch (err) {
            console.error("Clipboard read failed:", err);
        }
    }, pollRate);
}

async function refreshClipboardNow() {
    try {
        const text = await vscode.env.clipboard.readText();

        if (text && text !== lastClipboard) {
            lastClipboard = text;
            pushToRing(text, 50);
        }
    } catch (err) {
        console.error(err);
    }
}

/**
 * KILL RING INSERT
 */
function pushToRing(text, maxEntries) {
    if (killRing[0] === text) return;

    killRing.unshift(text);

    if (killRing.length > maxEntries) {
        killRing.pop();
    }
}

/**                
 * WEBVIEW
 */
function openKillRingWebview(context) {
    refreshClipboardNow();
    const panel = vscode.window.createWebviewPanel(
        'copycopy',
        `Copy Copy (${killRing.length})`,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    panel.webview.html = getKillRingHtml(killRing);

    panel.reveal(vscode.ViewColumn.Active, false);

    panel.webview.onDidReceiveMessage(async (message) => {

        if (message.command === 'paste') {

            const editor = vscode.window.activeTextEditor;
            if (!editor) return;

            const index = message.index;
            const text = killRing[index];

            // 🔥 promote
            if (index !== 0) {
                killRing.splice(index, 1);
                killRing.unshift(text);
            }

            cycleIndex = 0;

            const position = editor.selection.active;
            const line = editor.document.lineAt(position.line);
            const insertPosition = line.range.end;

            const cleanText = text.replace(/^\n+/, '');
            const insertText = '\n' + cleanText;

            await editor.edit(editBuilder => {
                editBuilder.insert(insertPosition, insertText);
            });

            // 🔥 compute range of inserted text
            const start = new vscode.Position(position.line + 1, 0);
            const end = new vscode.Position(position.line + 1 + cleanText.split('\n').length - 1, cleanText.split('\n').slice(-1)[0].length);

            lastPasteRange = new vscode.Range(start, end);
            lastPasteEditor = editor;

            editor.selection = new vscode.Selection(start, start);
            editor.revealRange(lastPasteRange);
            panel.dispose();
        }
        if (message.command === 'close') {
            panel.dispose();
        }

        if (message.command === 'refresh') {
            panel.webview.html = getKillRingHtml(killRing);
        }
    });
}

/**
 * HTML UI
 */
function getKillRingHtml(entries) {
    return `
    <html>
    <head>
        <style>
            body {
                font-family: monospace;
                background: rgba(30,30,30,0.98);
                color: #ddd;
                padding: 10px;
            }

            input {
                width: 100%;
                padding: 6px;
                margin-bottom: 10px;
                background: #2a2a2a;
                color: #fff;
                border: 1px solid #444;
                display: none;
            }

            .entry {
                border: 1px solid #444;
                margin-bottom: 6px;
                padding: 6px;
                cursor: pointer;
                background: #1a1a1a;
                white-space: pre-wrap;
            }

            .entry.selected {
                background: #094771;
            }

            .index {
                color: #666;
                margin-right: 10px;
            }
        </style>
    </head>
    <body>

        <input id="filter" placeholder="Filter..." />
        <div id="results" tabindex="0"></div>

        <script>
            const vscode = acquireVsCodeApi();

            let raw = ${JSON.stringify(entries)};
            let filtered = [...raw];

            let selectedIndex = 0;
            let mode = 'nav';

            function render() {
                const container = document.getElementById('results');
                container.innerHTML = '';

                filtered.forEach((text, i) => {

                    const div = document.createElement('div');
                    div.className = 'entry' + (i === selectedIndex ? ' selected' : '');

                    const idx = document.createElement('span');
                    idx.className = 'index';
                    idx.textContent = '[' + i + ']';

                    const content = document.createElement('span');
                    content.textContent = truncate(text);

                    div.appendChild(idx);
                    div.appendChild(content);

                    div.onclick = () => paste(i);

                    container.appendChild(div);
                });

                scrollToSelection();
            }

            function truncate(text) {
                return text.length > 200 ? text.slice(0, 200) + '...' : text;
            }

            function paste(index) {
                vscode.postMessage({ command: 'paste', index });
            }

            function applyFilter(value) {
                value = value.toLowerCase();

                filtered = raw.filter(t => t.toLowerCase().includes(value));
                selectedIndex = 0;
                render();
            }

            function scrollToSelection() {
                const el = document.querySelector('.entry.selected');
                if (!el) return;

                const rect = el.getBoundingClientRect();
                if (rect.top < 0 || rect.bottom > window.innerHeight) {
                    el.scrollIntoView({ block: "center" });
                }
            }

            document.addEventListener('keydown', (e) => {

                if (mode === 'nav') {

                if (e.key === '/') {
                    e.preventDefault(); // 🔥 stop "/" from being typed

                    mode = 'filter';

                    const input = document.getElementById('filter');
                    input.value = '';   // 🔥 ensure clean start
                    input.style.display = 'block';
                    input.focus();

                    return;
                }

                    if (e.key === 'j') {
                        selectedIndex = Math.min(selectedIndex + 1, filtered.length - 1);
                        render();
                    }
                    else if (e.key === 'k') {
                        selectedIndex = Math.max(selectedIndex - 1, 0);
                        render();
                    }
                    else if (e.key === 'Enter') {
                        paste(selectedIndex);
                    }
                    else if (e.key === ';') {
                        vscode.postMessage({ command: 'close' });
                    }
                    else if (e.key === 'Escape') {
                        vscode.postMessage({ command: 'close' });
                    }
                }

                else if (mode === 'filter') {

                    if (e.key === ';') {
                        mode = 'nav';
                        const input = document.getElementById('filter');
                        input.blur();
                        input.style.display = 'none';
                    }
                }
            });

            document.getElementById('filter').addEventListener('input', (e) => {
                applyFilter(e.target.value);
            });

            window.onload = () => {
                document.getElementById('results').focus();
            };

            render();
        </script>

    </body>
    </html>
    `;
}

/**
 * CLEANUP
 */
function deactivate() {
    if (pollingInterval) clearInterval(pollingInterval);
}

module.exports = {
    activate,
    deactivate
};