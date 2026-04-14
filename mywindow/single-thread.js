const vscode = require('vscode');

function activate(context) {
    config = vscode.workspace.getConfiguration('windowSearch');
    windowSize = Math.max(1, config.get('windowSize', 5));
    const termColor = config.get('termHighlightColor', 'rgba(255, 200, 0, 0.6)');
    const windowColor = config.get('windowHighlightColor', 'rgba(255, 255, 0, 0.15)');
    const windowBorder = config.get('windowHighlightBorder', '1px solid rgba(255,255,0,0.4)');
    const disposable = vscode.commands.registerCommand('windowSearch.run', async function () {
        config = vscode.workspace.getConfiguration('windowSearch');
        windowSize = Math.max(1, config.get('windowSize', 5));
        const termHighlight = vscode.window.createTextEditorDecorationType({
            backgroundColor: termColor,
            color: '#000',
            borderRadius: '2px'
        });
        const windowHighlight = vscode.window.createTextEditorDecorationType({
            isWholeLine: true,
            backgroundColor: windowColor,
            border: windowBorder
        });
        // 🔥 Capture original editor group BEFORE modal opens
        const originalColumn = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : vscode.ViewColumn.One;

        // 1. Input terms
        const input = await vscode.window.showInputBox({
            prompt: 'Enter search terms (space separated)',
            placeHolder: 'camera rotation'
        });

        if (!input) return;

        const terms = input
            .split(/\s+/)
            .map(t => t.trim().toLowerCase())
            .filter(t => t.length > 0);

        if (terms.length === 0) return;

        // // 2. Window size
        // const windowSizeInput = await vscode.window.showInputBox({
        //     prompt: 'Window size (lines)',
        //     value: '5'
        // });

        // const windowSize = Math.max(1, parseInt(windowSizeInput || '5'));

        // 3. Find files

        const includePattern = config.get('include', '**/*.{java,kt}');
        const excludePattern = config.get('exclude', '**/{node_modules,.git,build,out}/**');

        const files = await vscode.workspace.findFiles(
            includePattern,
            excludePattern
        );

        const results = [];

        // 4. Scan files
        for (const file of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                const lines = doc.getText().split(/\r?\n/);

                for (let i = 0; i <= lines.length - windowSize;) {

                    const windowLines = lines.slice(i, i + windowSize);
                    const windowText = windowLines.join(' ').toLowerCase();

                    const matchesAll = terms.every(term => windowText.includes(term));

                    if (matchesAll) {
                        results.push({
                            file: file.fsPath,
                            startLine: i,
                            preview: windowLines
                        });

                        i += windowSize;
                    } else {
                        i++;
                    }
                }

            } catch (err) {
                console.error(err);
            }
        }

        if (results.length === 0) {
            vscode.window.showInformationMessage('No matches found.');
        }

        // 5. Create webview
        const panel = vscode.window.createWebviewPanel(
            'windowSearch',
            `Window Search (${windowSize}) [${includePattern}]`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        panel.webview.html = getHtml(results, terms);

        // 🔥 Force focus
        panel.reveal(vscode.ViewColumn.Active, false);
        let lastEditor = null;
        let lastFile = null;
        let lastLine = null;
        // 6. Handle messages
        panel.webview.onDidReceiveMessage(async (message) => {
            if (message.command === 'newSearch') {
                panel.dispose();
                lastEditor = null;
                lastFile = null;
                lastLine = null;

                vscode.window.visibleTextEditors.forEach(e => {
                    e.setDecorations(windowHighlight, []);
                    e.setDecorations(termHighlight, []);
                });

                setTimeout(() => {
                    vscode.commands.executeCommand('windowSearch.run');
                }, 10);
            }

            if (message.command === 'preview') {

                const uri = vscode.Uri.file(message.file);

                let editor;

                // 🔥 REUSE editor if same file
                if (lastEditor && lastFile === message.file) {
                    editor = lastEditor;
                } else {
                    const doc = await vscode.workspace.openTextDocument(uri);

                    editor = await vscode.window.showTextDocument(doc, {
                        viewColumn: originalColumn,
                        preserveFocus: true,
                        preview: true
                    });

                    lastEditor = editor;
                    lastFile = message.file;
                }

                // 🔥 Skip if exact same line
                if (lastLine === message.line) {
                    return;
                }

                lastLine = message.line;

                const start = new vscode.Position(message.line, 0);
                const end = new vscode.Position(message.line + message.windowSize - 1, 0);

                // Window highlight
                editor.setDecorations(windowHighlight, [
                    new vscode.Range(start, end)
                ]);

                // Term highlight
                const ranges = findTermRanges(editor.document, message.line, message.windowSize, message.terms);
                editor.setDecorations(termHighlight, ranges);

                // Move cursor
                editor.selection = new vscode.Selection(start, start);

                editor.revealRange(
                    new vscode.Range(start, start),
                    vscode.TextEditorRevealType.InCenter
                );
            }

            if (message.command === 'open') {

                lastEditor = null;
                lastFile = null;
                lastLine = null;
                const uri = vscode.Uri.file(message.file);

                panel.dispose();

                setTimeout(async () => {
                    const doc = await vscode.workspace.openTextDocument(uri);

                    const editor = await vscode.window.showTextDocument(doc, {
                        viewColumn: originalColumn,
                        preserveFocus: false,
                        preview: false
                    });

                    const start = new vscode.Position(message.line, 0);
                    const end = new vscode.Position(message.line + message.windowSize, 0);

                    setTimeout(() => {
                        editor.setDecorations(windowHighlight, []);
                        editor.setDecorations(termHighlight, []);
                    }, 100);

                    const position = new vscode.Position(message.line, 0);

                    editor.selection = new vscode.Selection(position, position);

                    editor.revealRange(
                        new vscode.Range(position, position),
                        vscode.TextEditorRevealType.InCenter
                    );
                }, 10);
            }

            if (message.command === 'close') {
                lastEditor = null;
                lastFile = null;
                lastLine = null;
                vscode.window.visibleTextEditors.forEach(e => {
                    e.setDecorations(windowHighlight, []);
                    e.setDecorations(termHighlight, []);
                });
                panel.dispose();
            }
        });
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(
        vscode.commands.registerCommand('windowSearch.setWindowSize', async () => {

            const config = vscode.workspace.getConfiguration('windowSearch');
            const current = config.get('windowSize', 5);

            const input = await vscode.window.showInputBox({
                prompt: 'Set Window Size',
                value: String(current),
                validateInput: (value) => {
                    const num = parseInt(value);
                    if (isNaN(num) || num < 1) {
                        return 'Enter a number >= 1';
                    }
                    return null;
                }
            });

            if (!input) return;

            const newSize = Math.max(1, parseInt(input));

            await config.update('windowSize', newSize, vscode.ConfigurationTarget.Global);

            // 🔥 run search immediately
            vscode.commands.executeCommand('windowSearch.run');
        })
    );
    context.subscriptions.push(
        vscode.commands.registerCommand('windowSearch.increaseWindow', async () => {
            const config = vscode.workspace.getConfiguration('windowSearch');
            const current = config.get('windowSize', 5);

            await config.update('windowSize', current + 5, vscode.ConfigurationTarget.Global);

            vscode.commands.executeCommand('windowSearch.run');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('windowSearch.decreaseWindow', async () => {
            const config = vscode.workspace.getConfiguration('windowSearch');
            const current = config.get('windowSize', 5);

            const next = Math.max(1, current - 5);

            await config.update('windowSize', next, vscode.ConfigurationTarget.Global);

            vscode.commands.executeCommand('windowSearch.run');
        })
    );
}
// 🔥 Term finder
function findTermRanges(doc, startLine, windowSize, terms) {
    const ranges = [];
    const lowerTerms = terms.map(t => t.toLowerCase());

    for (let i = 0; i < windowSize; i++) {
        const lineNum = startLine + i;
        const line = doc.lineAt(lineNum).text;
        const lower = line.toLowerCase();

        lowerTerms.forEach(term => {
            let idx = 0;
            while (true) {
                const found = lower.indexOf(term, idx);
                if (found === -1) break;

                ranges.push(new vscode.Range(
                    new vscode.Position(lineNum, found),
                    new vscode.Position(lineNum, found + term.length)
                ));

                idx = found + term.length;
            }
        });
    }

    return ranges;
}

function getHtml(results, terms) {

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

            .file {
                margin-bottom: 20px;
            }

            .file-header {
                color: #4fc1ff;
                font-weight: bold;
                margin-bottom: 6px;
            }
.result {
    border-top: 2px solid #4fc1ff;
    border-bottom: 2px solid #4fc1ff;
}
.result {
    border: 1px solid #444;
    margin-bottom: 10px;
    padding: 6px;
    cursor: pointer;
    background: #1a1a1a;
}

.result::before {
    content: "WINDOW";
    display: block;
    font-size: 10px;
    color: #888;
    margin-bottom: 4px;
}

            .selected {
                background: #094771;
            }

            .line {
                white-space: pre;
            }

            .highlight {
                background: #dcdcaa;
                color: #000;
                font-weight: bold;
            }
        </style>
    </head>
    <body>

        <input id="filter" placeholder="Filter..." />

        <div id="results" tabindex="0"></div>

        <script>
            let previewTimer = null;
            const vscode = acquireVsCodeApi();

            let rawResults = ${JSON.stringify(results)};
            let terms = ${JSON.stringify(terms)};
            let filtered = [...rawResults];

            let selectedIndex = 0;
            let flatList = [];
            let mode = 'nav';

            function highlight(text) {
                let result = text;
                for (const term of terms) {
                    const regex = new RegExp("(" + term + ")", "gi");
                    result = result.replace(regex, '<span class="highlight">$1</span>');
                }
                return result;
            }

            function groupByFile(results) {
                const map = {};
                for (const r of results) {
                    if (!map[r.file]) map[r.file] = [];
                    map[r.file].push(r);
                }
                return map;
            }

            function scrollIntoViewIfNeeded(el) {
                if (!el) return;
                const rect = el.getBoundingClientRect();

                if (rect.top < 0 || rect.bottom > window.innerHeight) {
                    el.scrollIntoView({ block: "center", behavior: "smooth" });
                }
            }

            function render() {

                const container = document.getElementById('results');
                container.innerHTML = '';
                flatList = [];

                const grouped = groupByFile(filtered);

                Object.keys(grouped).forEach(file => {

                    const fileDiv = document.createElement('div');
                    fileDiv.className = 'file';

                    const header = document.createElement('div');
                    header.className = 'file-header';
                    header.textContent = file;

                    fileDiv.appendChild(header);

                    grouped[file].forEach((r) => {

                        const index = flatList.length;
                        flatList.push(r);

                        const div = document.createElement('div');
                        div.className = 'result' + (index === selectedIndex ? ' selected' : '');

r.preview.forEach((line, i) => {
    const lineDiv = document.createElement('div');
    lineDiv.className = 'line';

    const lineNumber = document.createElement('span');
    lineNumber.style.color = '#666';
    lineNumber.style.marginRight = '10px';
    lineNumber.textContent = (r.startLine + i + 1);

    const content = document.createElement('span');
    content.innerHTML = highlight(line);

    lineDiv.appendChild(lineNumber);
    lineDiv.appendChild(content);

    div.appendChild(lineDiv);
});

                        div.onclick = () => open(index);

                        fileDiv.appendChild(div);
                    });

                    container.appendChild(fileDiv);
                });

                const selectedEl = document.querySelector('.result.selected');
                scrollIntoViewIfNeeded(selectedEl);

                // 🔥 Preview current selection
                if (flatList[selectedIndex]) {
                    const r = flatList[selectedIndex];
vscode.postMessage({
    command: 'preview',
    file: r.file,
    line: r.startLine,
    windowSize: r.preview.length,
  terms: terms
});
                }
            }

            function open(index) {
                const r = flatList[index];
vscode.postMessage({
    command: 'open',
    file: r.file,
    line: r.startLine,
    windowSize: r.preview.length,
  terms: terms
});
            }

            function applyFilter(value) {
                value = value.toLowerCase();

                filtered = rawResults.filter(r => {
                    const text = r.preview.join(' ').toLowerCase();
                    return text.includes(value);
                });

                selectedIndex = 0;
                render();
            }

            document.addEventListener('keydown', (e) => {

                if (mode === 'nav') {

                if (e.key === ';') {
                    e.preventDefault();
                    vscode.postMessage({ command: 'newSearch' });
                    return;
                }

                    if (e.key === '/') {
                        e.preventDefault();
                        mode = 'filter';
                        const input = document.getElementById('filter');
                        input.style.display = 'block';
                        input.focus();
                        return;
                    }

                    if (e.key === 'j') {
                        selectedIndex = Math.min(selectedIndex + 1, flatList.length - 1);
                        render();
                    }
                    else if (e.key === 'k') {
                        selectedIndex = Math.max(selectedIndex - 1, 0);
                        render();
                    }
                    else if (e.key === 'Enter') {
                        open(selectedIndex);
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

            // 🔥 Focus fix (yours + correct)
            window.onload = () => {
                document.getElementById('results').focus();
            };

            render();
        </script>

    </body>
    </html>
    `;
}

function deactivate() { }

module.exports = {
    activate,
    deactivate
};