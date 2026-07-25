const vscode = require('vscode');
const { spawn } = require('child_process');
const path = require('path');

let pendingSearchMode = 'window';
let pendingPreviousSearchMode = null;
let pendingSearchInput = null;
const lastSearches = {
    window: null,
    singleLine: null
};

function activate(context) {
    config = vscode.workspace.getConfiguration('windowSearch');
    windowSize = Math.max(1, config.get('windowSize', 5));
    const disposable = vscode.commands.registerCommand('windowSearch.run', async function () {
        const searchMode = pendingSearchMode;
        const previousSearch = pendingPreviousSearchMode === searchMode
            ? lastSearches[searchMode]
            : null;
        pendingSearchMode = 'window';
        pendingPreviousSearchMode = null;
        const isSingleLineSearch = searchMode === 'singleLine';

        config = vscode.workspace.getConfiguration('windowSearch');
        windowSize = previousSearch
            ? previousSearch.windowSize
            : (isSingleLineSearch
                ? 1
                : Math.max(1, config.get('windowSize', 5)));
        //  Capture original editor group BEFORE modal opens
        const activeEditorAtSearchStart = vscode.window.activeTextEditor;
        const originalColumn = activeEditorAtSearchStart
            ? activeEditorAtSearchStart.viewColumn
            : vscode.ViewColumn.One;
        const currentFile = activeEditorAtSearchStart
            ? activeEditorAtSearchStart.document.uri.fsPath
            : '';

        // 1. Input terms, unless reopening the previous result set.
        let input;
        let terms;

        if (previousSearch) {
            input = previousSearch.input;
            terms = previousSearch.terms;
        } else {
            input = pendingSearchInput;
            pendingSearchInput = null;

            if (!input) {
                input = await vscode.window.showInputBox({
                    prompt: isSingleLineSearch
                        ? 'Search for text on a single line across the project'
                        : 'Enter search terms (space separated)',
                    placeHolder: isSingleLineSearch
                        ? 'customerRepository.findById'
                        : 'camera rotation'
                });
            }

            if (!input) return;

            terms = input
                .split(/\s+/)
                .map(t => t.trim().toLowerCase())
                .filter(t => t.length > 0);

            if (terms.length === 0) return;
        }

        // // 2. Window size
        // const windowSizeInput = await vscode.window.showInputBox({
        //     prompt: 'Window size (lines)',
        //     value: '5'
        // });

        // const windowSize = Math.max(1, parseInt(windowSizeInput || '5'));

        // 3. Find files

        const includePattern = previousSearch
            ? previousSearch.includePattern
            : config.get('include', '**/*.{java,kt}');
        const excludePatterns = previousSearch
            ? previousSearch.excludePatterns
            : buildExcludePatterns(config);

        const results = previousSearch
            ? previousSearch.results
            : (isSingleLineSearch
                ? await runSingleLineRipgrep(terms, includePattern, excludePatterns)
                : await runRipgrep(terms, windowSize, includePattern, excludePatterns));

        if (!previousSearch) {
            lastSearches[searchMode] = {
                input,
                terms,
                windowSize,
                includePattern,
                excludePatterns,
                results
            };
        }

        // Group matches by file
        if (results.length === 0) {
            vscode.window.showInformationMessage('No matches found.');
        }

        // 5. Create webview
        const panel = vscode.window.createWebviewPanel(
            'windowSearch',
            isSingleLineSearch
                ? `Project Line Search [${includePattern}]`
                : `Window Search (${windowSize}) [${includePattern}]`,
            vscode.ViewColumn.Active,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const previewEditorDefault = config.get('previewEditor', false);

        panel.webview.html = getHtml(
            results,
            terms,
            isSingleLineSearch ? 'LINE' : 'WINDOW',
            vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '',
            previewEditorDefault,
            currentFile
        );

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

                setTimeout(() => {
                    vscode.commands.executeCommand(
                        isSingleLineSearch
                            ? 'windowSearch.singleLineSearch'
                            : 'windowSearch.run'
                    );
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
                panel.dispose();
            }
        });
    });


    context.subscriptions.push(
        vscode.commands.registerCommand('windowSearch.singleLineSearch', async () => {
            pendingSearchMode = 'singleLine';
            await vscode.commands.executeCommand('windowSearch.run');
        })
    );


    context.subscriptions.push(
        vscode.commands.registerCommand('windowSearch.searchUnderCursor', async () => {
            const editor = vscode.window.activeTextEditor;

            if (!editor) {
                vscode.window.showInformationMessage('Open a text editor before searching under the cursor.');
                return;
            }

            let searchText = editor.document.getText(editor.selection).trim();

            if (!searchText) {
                const position = editor.selection.active;
                const wordRange = editor.document.getWordRangeAtPosition(
                    position,
                    /[-\w.$]+/
                );

                if (wordRange) {
                    searchText = editor.document.getText(wordRange).trim();
                }
            }

            if (!searchText) {
                vscode.window.showInformationMessage('No searchable text is selected or under the cursor.');
                return;
            }

            pendingSearchMode = 'singleLine';
            pendingPreviousSearchMode = null;
            pendingSearchInput = searchText;
            await vscode.commands.executeCommand('windowSearch.run');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('windowSearch.showPreviousWindowSearch', async () => {
            if (!lastSearches.window) {
                vscode.window.showInformationMessage('No previous Window Search is available.');
                return;
            }

            pendingSearchMode = 'window';
            pendingPreviousSearchMode = 'window';
            await vscode.commands.executeCommand('windowSearch.run');
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('windowSearch.showPreviousLineSearch', async () => {
            if (!lastSearches.singleLine) {
                vscode.window.showInformationMessage('No previous Project Line Search is available.');
                return;
            }

            pendingSearchMode = 'singleLine';
            pendingPreviousSearchMode = 'singleLine';
            await vscode.commands.executeCommand('windowSearch.run');
        })
    );

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
function getWindowSearchHtml(results, terms, resultLabel = 'WINDOW', workspaceRoot = '') {
    const isLineSearch = resultLabel === 'LINE';
    const searchTitle = isLineSearch ? 'Project Line Search' : 'Window Search';

    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            :root {
                --panel-bg: var(--vscode-editor-background);
                --surface: color-mix(in srgb, var(--vscode-editor-background) 94%, white 6%);
                --surface-strong: color-mix(in srgb, var(--vscode-editor-background) 88%, white 12%);
                --hover: var(--vscode-list-hoverBackground, rgba(127,127,127,.10));
                --border: var(--vscode-panel-border, rgba(127,127,127,.22));
                --muted: var(--vscode-descriptionForeground);
                --accent: var(--vscode-textLink-foreground);
                --selection: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 38%, transparent);
                --selection-border: var(--vscode-focusBorder, var(--accent));
                --code-font: var(--vscode-editor-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
                --ui-font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
            }

            * { box-sizing: border-box; }
            html, body { height: 100%; margin: 0; overflow: hidden; }

            body {
                display: grid;
                grid-template-rows: auto 1fr auto;
                background: var(--panel-bg);
                color: var(--vscode-foreground);
                font-family: var(--ui-font);
                font-size: 13px;
            }

            .toolbar {
                display: flex;
                align-items: center;
                gap: 12px;
                min-height: 50px;
                padding: 8px 14px;
                border-bottom: 1px solid var(--border);
                background: var(--surface);
            }

            .query {
                min-width: 0;
                flex: 1;
                display: flex;
                align-items: baseline;
                gap: 10px;
            }

            .query-title {
                max-width: 52vw;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 15px;
                font-weight: 650;
            }

            .query-meta { color: var(--muted); white-space: nowrap; }

            .toolbar-actions { display: flex; align-items: center; gap: 6px; }

            button, input {
                height: 30px;
                border: 1px solid var(--vscode-input-border, var(--border));
                border-radius: 4px;
                font: inherit;
            }

            button {
                padding: 0 10px;
                background: var(--vscode-button-secondaryBackground, var(--surface-strong));
                color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
                cursor: pointer;
            }
            button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--hover)); }

            #filter {
                display: none;
                width: min(360px, 34vw);
                padding: 0 9px;
                outline: none;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
            }
            #filter:focus { border-color: var(--vscode-focusBorder); }

            #results { overflow: auto; outline: none; scroll-padding: 66px 0; }
            .empty { padding: 48px 24px; text-align: center; color: var(--muted); }

            .file { border-bottom: 1px solid var(--border); }
            .file.collapsed .file-results { display: none; }

            .file-header {
                position: sticky;
                top: 0;
                z-index: 3;
                display: grid;
                grid-template-columns: 18px minmax(0, 1fr) auto;
                align-items: center;
                gap: 8px;
                min-height: 44px;
                padding: 5px 14px;
                border-bottom: 1px solid var(--border);
                background: color-mix(in srgb, var(--panel-bg) 96%, white 4%);
                cursor: pointer;
                user-select: none;
            }
            .file-header:hover { background: var(--surface); }

            .chevron { color: var(--muted); font-size: 11px; transition: transform .12s ease; }
            .file.collapsed .chevron { transform: rotate(-90deg); }

            .file-copy { min-width: 0; }
            .file-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: var(--accent);
                font-weight: 650;
                line-height: 1.25;
            }
            .file-dir {
                margin-top: 1px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: var(--muted);
                font-size: 11px;
            }

            .match-count {
                padding: 2px 7px;
                border: 1px solid var(--border);
                border-radius: 999px;
                color: var(--muted);
                background: var(--surface);
                font-size: 11px;
                white-space: nowrap;
            }

            .result {
                position: relative;
                display: grid;
                grid-template-columns: 68px minmax(0, 1fr);
                min-height: 40px;
                border-bottom: 1px solid color-mix(in srgb, var(--border) 72%, transparent);
                cursor: pointer;
            }
            .result:hover { background: var(--hover); }
            .result.selected { background: var(--selection); }
            .result.selected::before {
                content: '';
                position: absolute;
                left: 0; top: 0; bottom: 0;
                width: 3px;
                background: var(--selection-border);
            }

            .line-number {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                padding: 0 12px 0 8px;
                border-right: 1px solid var(--border);
                color: var(--accent);
                font-family: var(--code-font);
                font-variant-numeric: tabular-nums;
                user-select: none;
            }

            .preview { min-width: 0; padding: 7px 14px; overflow: hidden; }
            .line {
                min-height: 24px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: pre;
                color: var(--vscode-editor-foreground);
                font-family: var(--code-font);
                font-size: var(--vscode-editor-font-size, 14px);
                line-height: 24px;
            }
            .context-line { opacity: .58; }

            .highlight {
                padding: 0 1px;
                border-radius: 2px;
                background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,220,121,.35));
                color: inherit;
                box-shadow: inset 0 0 0 1px var(--vscode-editor-findMatchHighlightBorder, transparent);
                font-weight: 700;
            }

            .footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
                min-height: 30px;
                padding: 4px 12px;
                border-top: 1px solid var(--border);
                background: var(--surface);
                color: var(--muted);
                font-size: 11px;
            }
            .hints { display: flex; gap: 12px; flex-wrap: wrap; }
            .hint { white-space: nowrap; }
            kbd {
                padding: 1px 4px;
                margin-right: 3px;
                border: 1px solid var(--border);
                border-radius: 3px;
                background: var(--surface-strong);
                color: var(--vscode-foreground);
                font: inherit;
            }

            @media (max-width: 720px) {
                .toolbar { align-items: stretch; flex-direction: column; }
                .query-title { max-width: 100%; }
                .toolbar-actions { width: 100%; }
                #filter { width: 100%; flex: 1; }
                .result { grid-template-columns: 54px minmax(0, 1fr); }
                .footer > span:last-child { display: none; }
            }
        </style>
    </head>
    <body>
        <header class="toolbar">
            <div class="query">
                <span class="query-title" id="queryTitle"></span>
                <span class="query-meta" id="queryMeta"></span>
            </div>
            <div class="toolbar-actions">
                <input id="filter" type="text" placeholder="Filter results…" />
                <button id="filterButton" type="button">Filter</button>
                <button id="newSearchButton" type="button">New search</button>
            </div>
        </header>

        <main id="results" tabindex="0" aria-label="${searchTitle} results"></main>

        <footer class="footer">
            <div class="hints">
                <span class="hint"><kbd>J/K</kbd>Navigate</span>
                <span class="hint"><kbd>Enter</kbd>Open</span>
                <span class="hint"><kbd>H/L</kbd>Collapse/expand</span>
                <span class="hint"><kbd>/</kbd>Filter</span>
                <span class="hint"><kbd>;</kbd>New search</span>
                <span class="hint"><kbd>Esc</kbd>Close</span>
            </div>
            <span>${isLineSearch ? 'One-line project search' : 'Multi-line window search'}</span>
        </footer>

        <script>
            const vscode = acquireVsCodeApi();
            const sourceResults = ${JSON.stringify(results)};
            const terms = ${JSON.stringify(terms)};
            const workspaceRoot = ${JSON.stringify(workspaceRoot)};
            const resultLabel = ${JSON.stringify(resultLabel)};
            const isWindowSearch = resultLabel === 'WINDOW';
            let mode = 'nav';
            let filterValue = '';
            let selectedIndex = 0;
            let flatList = [];
            const collapsedFiles = new Set();

            const resultsElement = document.getElementById('results');
            const filterElement = document.getElementById('filter');
            const queryTitleElement = document.getElementById('queryTitle');
            const queryMetaElement = document.getElementById('queryMeta');
            queryTitleElement.textContent = terms.join(' ');

            const backslash = String.fromCharCode(92);

            function normalizeSlashes(value) {
                return String(value).split(backslash).join('/');
            }

            function canonicalPath(value) {
                return normalizeSlashes(value).toLowerCase();
            }

            function dedupeResults(items) {
                const seen = new Set();
                const output = [];
                for (const item of items) {
                    const key = canonicalPath(item.file) + ':' + item.startLine + ':' + item.preview.join('\\n');
                    if (seen.has(key)) continue;
                    seen.add(key);
                    output.push(item);
                }
                return output;
            }

            const rawResults = dedupeResults(sourceResults);

            function escapeHtml(value) {
                return String(value)
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;')
                    .replaceAll('"', '&quot;')
                    .replaceAll("'", '&#039;');
            }

            function escapeRegExp(value) {
                const specialCharacters = '^$.*+?()[]{}|';
                return String(value)
                    .split('')
                    .map(character => specialCharacters.includes(character) || character === backslash
                        ? backslash + character
                        : character)
                    .join('');
            }

            function highlight(text) {
                let result = escapeHtml(text);
                for (const term of terms) {
                    if (!term) continue;
                    const escaped = escapeRegExp(escapeHtml(term));
                    result = result.replace(new RegExp('(' + escaped + ')', 'gi'), '<span class="highlight">$1</span>');
                }
                return result;
            }

            function relativeParts(file) {
                const normalizedFile = normalizeSlashes(file);
                const rootWithSlashes = normalizeSlashes(workspaceRoot);
                const normalizedRoot = rootWithSlashes.endsWith('/')
                    ? rootWithSlashes.slice(0, -1)
                    : rootWithSlashes;
                let relative = normalizedRoot && canonicalPath(normalizedFile).startsWith(canonicalPath(normalizedRoot) + '/')
                    ? normalizedFile.slice(normalizedRoot.length + 1)
                    : normalizedFile;
                const pieces = relative.split('/');
                return {
                    name: pieces.pop() || relative,
                    dir: pieces.join('/') || '.'
                };
            }

            function visibleResults() {
                const needle = filterValue.trim().toLowerCase();
                if (!needle) return rawResults;
                return rawResults.filter(result =>
                    result.file.toLowerCase().includes(needle) ||
                    result.preview.join(' ').toLowerCase().includes(needle)
                );
            }

            function groupByFile(items) {
                const groups = new Map();
                for (const item of items) {
                    const key = canonicalPath(item.file);
                    if (!groups.has(key)) groups.set(key, { file: item.file, results: [] });
                    groups.get(key).results.push(item);
                }
                return groups;
            }

            function updateSummary(items, groups) {
                const label = ${JSON.stringify(isLineSearch ? 'results' : 'windows')};
                queryMetaElement.textContent = items.length + ' ' + label + ' · ' + groups.size + ' files';
            }

            function render() {
                const items = visibleResults();
                const groups = groupByFile(items);
                updateSummary(items, groups);
                resultsElement.innerHTML = '';
                flatList = [];

                if (!items.length) {
                    const empty = document.createElement('div');
                    empty.className = 'empty';
                    empty.textContent = 'No results match the current filter.';
                    resultsElement.appendChild(empty);
                    return;
                }

                for (const [key, group] of groups) {
                    const fileSection = document.createElement('section');
                    fileSection.className = 'file' + (collapsedFiles.has(key) ? ' collapsed' : '');
                    fileSection.dataset.fileKey = key;

                    const header = document.createElement('div');
                    header.className = 'file-header';
                    header.title = group.file;

                    const chevron = document.createElement('span');
                    chevron.className = 'chevron';
                    chevron.textContent = '▼';

                    const parts = relativeParts(group.file);
                    const copy = document.createElement('div');
                    copy.className = 'file-copy';
                    const name = document.createElement('div');
                    name.className = 'file-name';
                    name.textContent = parts.name;
                    const dir = document.createElement('div');
                    dir.className = 'file-dir';
                    dir.textContent = parts.dir;
                    copy.append(name, dir);

                    const count = document.createElement('span');
                    count.className = 'match-count';
                    count.textContent = group.results.length + (group.results.length === 1 ? ' match' : ' matches');
                    header.append(chevron, copy, count);
                    header.addEventListener('click', () => toggleFile(key));
                    fileSection.appendChild(header);

                    const rows = document.createElement('div');
                    rows.className = 'file-results';

                    for (const result of group.results) {
                        const index = flatList.length;
                        flatList.push({ ...result, fileKey: key });

                        const row = document.createElement('article');
                        row.className = 'result' + (index === selectedIndex ? ' selected' : '');
                        row.dataset.index = String(index);

                        const number = document.createElement('div');
                        number.className = 'line-number';
                        number.textContent = String(result.startLine + 1);

                        const preview = document.createElement('div');
                        preview.className = 'preview';
                        result.preview.forEach((line, offset) => {
                            const lineDiv = document.createElement('div');
                            const center = Math.floor(result.preview.length / 2);
                            lineDiv.className = 'line' + (result.preview.length === 1 || offset === center ? '' : ' context-line');
                            lineDiv.innerHTML = highlight(line);
                            preview.appendChild(lineDiv);
                        });

                        row.append(number, preview);
                        row.addEventListener('click', () => open(index));
                        row.addEventListener('mouseenter', () => {
                            selectedIndex = index;
                            updateSelection(false);
                        });
                        rows.appendChild(row);
                    }

                    fileSection.appendChild(rows);
                    resultsElement.appendChild(fileSection);
                }

                selectedIndex = Math.min(selectedIndex, Math.max(0, flatList.length - 1));
                ensureSelectedFileExpanded();
                updateSelection(true);
            }

            function toggleFile(key, collapse) {
                const shouldCollapse = collapse === undefined ? !collapsedFiles.has(key) : collapse;
                if (shouldCollapse) collapsedFiles.add(key); else collapsedFiles.delete(key);
                render();
            }

            function ensureSelectedFileExpanded() {
                const selected = flatList[selectedIndex];
                if (selected && collapsedFiles.has(selected.fileKey)) collapsedFiles.delete(selected.fileKey);
            }

            function updateSelection(shouldPreview = true) {
                document.querySelectorAll('.result').forEach(element =>
                    element.classList.toggle('selected', Number(element.dataset.index) === selectedIndex)
                );
                const element = document.querySelector('.result.selected');
                if (element) element.scrollIntoView({ block: 'nearest' });
                if (shouldPreview && flatList[selectedIndex]) {
                    const result = flatList[selectedIndex];
                    vscode.postMessage({
                        command: 'preview', file: result.file, line: result.startLine,
                        windowSize: result.preview.length, terms
                    });
                }
            }

            function moveSelection(delta) {
                if (!flatList.length) return;
                selectedIndex = Math.max(0, Math.min(flatList.length - 1, selectedIndex + delta));
                const selected = flatList[selectedIndex];
                if (collapsedFiles.has(selected.fileKey)) {
                    collapsedFiles.delete(selected.fileKey);
                    render();
                } else {
                    updateSelection(true);
                }
            }

            function open(index) {
                const result = flatList[index];
                if (!result) return;
                vscode.postMessage({
                    command: 'open', file: result.file, line: result.startLine,
                    windowSize: result.preview.length, terms
                });
            }

            function enterFilterMode() {
                mode = 'filter';
                filterElement.style.display = 'block';
                filterElement.focus();
                filterElement.select();
            }

            function leaveFilterMode() {
                mode = 'nav';
                filterElement.blur();
                resultsElement.focus();
            }

            document.getElementById('filterButton').addEventListener('click', enterFilterMode);
            document.getElementById('newSearchButton').addEventListener('click', () => vscode.postMessage({ command: 'newSearch' }));
            filterElement.addEventListener('input', event => {
                filterValue = event.target.value;
                selectedIndex = 0;
                render();
            });

            document.addEventListener('keydown', event => {
                if (mode === 'filter') {
                    if (event.key === 'Escape' || event.key === 'Enter') {
                        event.preventDefault();
                        leaveFilterMode();
                    }
                    return;
                }

                if (event.key === 'j' || event.key === 'ArrowDown') {
                    event.preventDefault(); moveSelection(1);
                } else if (event.key === 'k' || event.key === 'ArrowUp') {
                    event.preventDefault(); moveSelection(-1);
                } else if (event.key === 'h' || event.key === 'ArrowLeft') {
                    event.preventDefault();
                    const selected = flatList[selectedIndex];
                    if (selected) toggleFile(selected.fileKey, true);
                } else if (event.key === 'l' || event.key === 'ArrowRight') {
                    event.preventDefault();
                    const selected = flatList[selectedIndex];
                    if (selected) toggleFile(selected.fileKey, false);
                } else if (event.key === 'Enter') {
                    event.preventDefault(); open(selectedIndex);
                } else if (event.key === '/') {
                    event.preventDefault(); enterFilterMode();
                } else if (event.key === ';') {
                    event.preventDefault(); vscode.postMessage({ command: 'newSearch' });
                } else if (event.key === 'Escape') {
                    event.preventDefault(); vscode.postMessage({ command: 'close' });
                }
            });

            window.addEventListener('load', () => {
                resultsElement.focus();
                render();
            });
        </script>
    </body>
    </html>
    `;
}

function getHtml(results, terms, resultLabel = 'WINDOW', workspaceRoot = '', previewEditorDefault = false, currentFile = '') {
    return getLineSearchHtml(results, terms, workspaceRoot, resultLabel, previewEditorDefault, currentFile);
}

function getLineSearchHtml(results, terms, workspaceRoot = '', resultLabel = 'LINE', previewEditorDefault = false, currentFile = '') {
    return `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
            :root {
                --bg: var(--vscode-editor-background);
                --surface: var(--vscode-sideBar-background, var(--vscode-editor-background));
                --surface-2: var(--vscode-editorWidget-background, var(--surface));
                --border: var(--vscode-panel-border, rgba(127,127,127,.25));
                --muted: var(--vscode-descriptionForeground);
                --accent: var(--vscode-textLink-foreground);
                --hover: var(--vscode-list-hoverBackground, rgba(127,127,127,.10));
                --selected: var(--vscode-list-activeSelectionBackground, rgba(40,90,160,.35));
                --selected-fg: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
                --focus: var(--vscode-focusBorder, var(--accent));
                --code-font: var(--vscode-editor-font-family, Consolas, monospace);
                --ui-font: var(--vscode-font-family, "Segoe UI", sans-serif);
            }
            * { box-sizing: border-box; }
            html, body { height: 100%; margin: 0; overflow: hidden; }
            body {
                display: grid;
                grid-template-rows: auto 1fr auto;
                background: var(--bg);
                color: var(--vscode-foreground);
                font-family: var(--ui-font);
                font-size: 13px;
            }
            .toolbar {
                display: flex;
                align-items: center;
                gap: 10px;
                min-height: 54px;
                padding: 9px 12px;
                border-bottom: 1px solid var(--border);
                background: var(--surface-2);
            }
            .search-box {
                display: flex;
                align-items: center;
                gap: 8px;
                flex: 1;
                min-width: 220px;
                height: 34px;
                padding: 0 10px;
                border: 1px solid var(--vscode-input-border, var(--border));
                border-radius: 5px;
                background: var(--vscode-input-background);
            }
            .search-icon { color: var(--muted); font-size: 17px; }
            .query { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
            .summary { color: var(--muted); white-space: nowrap; }
            .actions { display: flex; gap: 6px; }
            button, input {
                height: 32px;
                border: 1px solid var(--vscode-input-border, var(--border));
                border-radius: 4px;
                font: inherit;
            }
            button {
                padding: 0 11px;
                background: var(--vscode-button-secondaryBackground, var(--surface));
                color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
                cursor: pointer;
            }
            button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--hover)); }
            #filter {
                display: none;
                width: min(320px, 28vw);
                padding: 0 9px;
                outline: none;
                background: var(--vscode-input-background);
                color: var(--vscode-input-foreground);
            }
            #filter:focus { border-color: var(--focus); }
            .workspace {
                min-height: 0;
                display: grid;
                grid-template-columns: minmax(250px, 32%) 1fr;
            }
            .files-pane {
                min-width: 0;
                display: grid;
                grid-template-rows: auto 1fr;
                border-right: 1px solid var(--border);
                background: var(--surface);
            }
            .pane-heading {
                display: flex;
                align-items: center;
                justify-content: space-between;
                min-height: 38px;
                padding: 0 12px;
                border-bottom: 1px solid var(--border);
                color: var(--muted);
                font-size: 12px;
            }
            #fileList { overflow: auto; outline: none; padding: 4px 0 10px; }
            .file-item {
                position: relative;
                display: grid;
                grid-template-columns: 22px minmax(0, 1fr) auto;
                align-items: center;
                gap: 8px;
                min-height: 49px;
                padding: 5px 10px 5px 12px;
                cursor: pointer;
            }
            .file-item:hover { background: var(--hover); }
            .file-item.selected { background: var(--selected); color: var(--selected-fg); }
            .file-item.selected::before {
                content: '';
                position: absolute;
                left: 0; top: 0; bottom: 0;
                width: 3px;
                background: var(--focus);
            }
            .file-icon { color: var(--muted); font-size: 15px; text-align: center; }
            .file-copy { min-width: 0; }
            .file-name {
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-weight: 600;
            }
            .file-path {
                margin-top: 2px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: var(--muted);
                font-size: 11px;
            }
            .badge {
                min-width: 24px;
                padding: 2px 7px;
                border-radius: 999px;
                background: color-mix(in srgb, var(--vscode-badge-background) 75%, transparent);
                color: var(--vscode-badge-foreground, var(--vscode-foreground));
                text-align: center;
                font-size: 11px;
            }
            .matches-pane {
                min-width: 0;
                display: grid;
                grid-template-rows: auto 1fr;
                background: var(--bg);
            }
            .active-file-header {
                display: grid;
                grid-template-columns: 22px minmax(0,1fr) auto;
                align-items: center;
                gap: 9px;
                min-height: 58px;
                padding: 8px 14px;
                border-bottom: 1px solid var(--border);
                background: var(--surface-2);
            }
            .active-name { font-size: 15px; font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .active-path { margin-top: 2px; color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            #matchList { overflow: auto; outline: none; padding: 8px 0 20px; }
            .match-row {
                position: relative;
                display: grid;
                grid-template-columns: 70px minmax(0,1fr);
                min-height: 42px;
                border-bottom: 1px solid color-mix(in srgb, var(--border) 62%, transparent);
                cursor: pointer;
            }
            .match-row:hover { background: var(--hover); }
            .match-row.selected { background: color-mix(in srgb, var(--selected) 58%, transparent); }
            .match-row.selected::before {
                content: '';
                position: absolute;
                left: 0; top: 0; bottom: 0;
                width: 3px;
                background: var(--focus);
            }
            .line-number {
                display: flex;
                align-items: center;
                justify-content: flex-end;
                padding: 0 13px 0 8px;
                border-right: 1px solid var(--border);
                color: var(--accent);
                font-family: var(--code-font);
                font-variant-numeric: tabular-nums;
                user-select: none;
            }
            .code-line {
                min-width: 0;
                padding: 9px 14px;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: pre;
                color: var(--vscode-editor-foreground);
                font-family: var(--code-font);
                font-size: var(--vscode-editor-font-size, 14px);
                line-height: 23px;
            }
            .match-row.window-result {
                display: block;
                min-height: 0;
                padding: 5px 0;
            }
            .window-code-row {
                display: grid;
                grid-template-columns: 70px minmax(0,1fr);
                min-height: 30px;
            }
            .window-code-row .line-number {
                align-items: flex-start;
                padding-top: 5px;
            }
            .window-code-row .code-line {
                padding-top: 4px;
                padding-bottom: 4px;
                line-height: 22px;
            }
            .syntax-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
            .syntax-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
            .syntax-comment { color: var(--vscode-descriptionForeground); font-style: italic; }
            .syntax-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
            .syntax-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
            .syntax-annotation { color: var(--vscode-symbolIcon-functionForeground, #dcdcaa); }
            .syntax-tag { color: var(--vscode-symbolIcon-keywordForeground, #569cd6); }
            .highlight {
                padding: 0 1px;
                border: 1px solid var(--vscode-editor-findMatchHighlightBorder, transparent);
                border-radius: 2px;
                background: var(--vscode-editor-findMatchHighlightBackground, rgba(234,191,71,.35));
                color: inherit;
            }
            .empty { padding: 48px 20px; text-align: center; color: var(--muted); }
            .footer {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 16px;
                min-height: 34px;
                padding: 5px 10px;
                border-top: 1px solid var(--border);
                background: var(--surface-2);
                color: var(--muted);
                font-size: 11px;
            }
            .hints { display: flex; align-items: center; gap: 13px; min-width: 0; overflow: hidden; }
            .hint { white-space: nowrap; }
            .preview-toggle {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                height: 30px;
                padding: 0 8px;
                border: 1px solid var(--vscode-input-border, var(--border));
                border-radius: 4px;
                color: var(--vscode-foreground);
                background: var(--surface);
                cursor: pointer;
                user-select: none;
                white-space: nowrap;
            }
            .preview-toggle:hover { background: var(--hover); }
            .preview-toggle input { width: 14px; height: 14px; margin: 0; }
            kbd {
                margin-right: 4px;
                padding: 1px 5px;
                border: 1px solid var(--border);
                border-radius: 3px;
                background: var(--surface);
                color: var(--vscode-foreground);
                font: inherit;
            }
            @media (max-width: 760px) {
                .workspace { grid-template-columns: minmax(190px, 40%) 1fr; }
                .summary { display: none; }
                .actions button { padding: 0 8px; }
                .match-row { grid-template-columns: 52px minmax(0,1fr); }
                .footer > span:last-child { display: none; }
            }
        </style>
    </head>
    <body>
        <header class="toolbar">
            <div class="search-box">
                <span class="search-icon">⌕</span>
                <span class="query" id="query"></span>
            </div>
            <span class="summary" id="summary"></span>
            <div class="actions">
                <input id="filter" type="text" placeholder="Filter files or matches…" />
                <label class="preview-toggle" title="Open and center the editor while selecting results">
                    <input id="previewToggle" type="checkbox" />
                    <span>Preview editor</span>
                </label>
                <button id="filterButton" type="button">Filter</button>
                <button id="newSearchButton" type="button">New search</button>
            </div>
        </header>
        <main class="workspace">
            <section class="files-pane">
                <div class="pane-heading"><span id="fileHeading">Files</span><span>Sort: path</span></div>
                <div id="fileList" tabindex="0" aria-label="Files containing matches"></div>
            </section>
            <section class="matches-pane">
                <header class="active-file-header" id="activeHeader"></header>
                <div id="matchList" tabindex="0" aria-label="Matches in selected file"></div>
            </section>
        </main>
        <footer class="footer">
            <div class="hints">
                <span class="hint"><kbd>J/K</kbd>Match</span>
                <span class="hint"><kbd>Shift+J/K</kbd>File</span>
                <span class="hint"><kbd>Enter</kbd>Open</span>
                <span class="hint"><kbd>/</kbd>Filter</span>
                <span class="hint"><kbd>;</kbd>New search</span>
                <span class="hint"><kbd>Esc</kbd>Close</span>
            </div>
            <span id="searchDescription"></span>
        </footer>
        <script>
            const vscode = acquireVsCodeApi();
            const sourceResults = ${JSON.stringify(results)};
            const terms = ${JSON.stringify(terms)};
            const workspaceRoot = ${JSON.stringify(workspaceRoot)};
            const currentFile = ${JSON.stringify(currentFile)};
            const isWindowSearch = ${JSON.stringify(resultLabel === 'WINDOW')};
            const backslash = String.fromCharCode(92);
            let filterValue = '';
            let mode = 'nav';
            let selectedFileIndex = 0;
            let selectedMatchIndex = 0;
            let groups = [];

            const fileList = document.getElementById('fileList');
            const matchList = document.getElementById('matchList');
            const activeHeader = document.getElementById('activeHeader');
            const filterInput = document.getElementById('filter');
            const previewToggle = document.getElementById('previewToggle');
            const savedState = vscode.getState() || {};
            const configuredPreviewEditor = ${JSON.stringify(previewEditorDefault)};
            let previewEditor = typeof savedState.previewEditor === 'boolean'
                ? savedState.previewEditor
                : configuredPreviewEditor;
            previewToggle.checked = previewEditor;
            document.getElementById('query').textContent = terms.join(' ');
            document.getElementById('searchDescription').textContent = isWindowSearch
                ? 'All search terms must appear within the configured line window'
                : 'All search terms must appear on the same line';

            function normalize(value) { return String(value).split(backslash).join('/'); }
            function keyPath(value) { return normalize(value).toLowerCase(); }
            function escapeHtml(value) {
                return String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');
            }
            function escapeRegExp(value) {
                const special = '^$.*+?()[]{}|';
                return String(value).split('').map(ch => special.includes(ch) || ch === backslash ? backslash + ch : ch).join('');
            }
            function applySearchHighlights(value) {
                let output = escapeHtml(value);
                for (const term of terms) {
                    if (!term) continue;
                    output = output.replace(new RegExp('(' + escapeRegExp(escapeHtml(term)) + ')', 'gi'), '<span class="highlight">$1</span>');
                }
                return output;
            }
            function extensionOf(file) {
                const name = normalize(file).split('/').pop() || '';
                const dot = name.lastIndexOf('.');
                return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
            }
            function languageInfo(file) {
                const ext = extensionOf(file);
                const slashComment = new Set(['java','kt','kts','js','jsx','ts','tsx','c','h','cpp','cc','cxx','hpp','cs','go','rs','swift','scala','groovy']);
                const hashComment = new Set(['py','rb','sh','bash','zsh','yaml','yml','toml','properties']);
                const sqlComment = new Set(['sql']);
                const keywords = {
                    java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public record return short static strictfp super switch synchronized this throw throws transient try var void volatile while true false null',
                    kt: 'as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam where actual annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg',
                    js: 'async await break case catch class const continue debugger default delete do else export extends false finally for from function get if import in instanceof let new null of return set static super switch this throw true try typeof undefined var void while with yield',
                    ts: 'abstract any as asserts async await bigint boolean break case catch class const constructor continue debugger declare default delete do else enum export extends false finally for from function get if implements import in infer instanceof interface is keyof let module namespace never new null number object of private protected public readonly require return set static string super switch symbol this throw true try type typeof undefined unique unknown var void while with yield',
                    py: 'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield',
                    c: 'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while true false null',
                    cpp: 'alignas alignof and and_eq asm atomic_cancel atomic_commit atomic_noexcept auto bitand bitor bool break case catch char class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not nullptr operator or private protected public reflexpr register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch synchronized template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor',
                    cs: 'abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while async await var dynamic',
                    go: 'break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var true false nil',
                    rs: 'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn',
                    sql: 'select from where insert update delete into values join inner left right full outer on as and or not null is distinct group by order having limit offset union all create alter drop table view index primary key foreign references constraint case when then else end true false',
                    json: 'true false null'
                };
                const key = ext === 'kts' ? 'kt' : ext === 'jsx' ? 'js' : ext === 'tsx' ? 'ts' : ['h','cc','cxx','hpp'].includes(ext) ? 'cpp' : ext;
                return {
                    ext,
                    lineComment: slashComment.has(ext) ? '//' : hashComment.has(ext) ? '#' : sqlComment.has(ext) ? '--' : '',
                    keywords: new Set((keywords[key] || '').split(' ').filter(Boolean)),
                    markup: ['xml','html','htm','svg','xhtml'].includes(ext)
                };
            }
            function isIdentifierStart(ch) { return !!ch && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '$'); }
            function isIdentifierPart(ch) { return isIdentifierStart(ch) || (ch >= '0' && ch <= '9'); }
            function syntaxHighlight(value, file) {
                const text = String(value);
                const info = languageInfo(file);
                const parts = [];
                const push = (segment, className = '') => {
                    if (!segment) return;
                    const html = applySearchHighlights(segment);
                    parts.push(className ? '<span class="' + className + '">' + html + '</span>' : html);
                };
                if (info.markup) {
                    let cursor = 0;
                    while (cursor < text.length) {
                        const open = text.indexOf('<', cursor);
                        if (open < 0) { push(text.slice(cursor)); break; }
                        push(text.slice(cursor, open));
                        const close = text.indexOf('>', open + 1);
                        if (close < 0) { push(text.slice(open), 'syntax-tag'); break; }
                        push(text.slice(open, close + 1), 'syntax-tag');
                        cursor = close + 1;
                    }
                    return parts.join('');
                }
                let i = 0;
                while (i < text.length) {
                    if (info.lineComment && text.startsWith(info.lineComment, i)) {
                        push(text.slice(i), 'syntax-comment');
                        break;
                    }
                    if (text.startsWith('//', i) || text.startsWith('/*', i)) {
                        const end = text.startsWith('/*', i) ? text.indexOf('*/', i + 2) : -1;
                        if (end >= 0) { push(text.slice(i, end + 2), 'syntax-comment'); i = end + 2; continue; }
                        push(text.slice(i), 'syntax-comment');
                        break;
                    }
                    const ch = text[i];
                    if (ch === '"' || ch === "'" || ch.charCodeAt(0) === 96) {
                        const quote = ch;
                        let j = i + 1;
                        while (j < text.length) {
                            if (text[j] === backslash) { j += 2; continue; }
                            if (text[j] === quote) { j++; break; }
                            j++;
                        }
                        push(text.slice(i, j), 'syntax-string');
                        i = j;
                        continue;
                    }
                    if (ch === '@' && isIdentifierStart(text[i + 1])) {
                        let j = i + 2;
                        while (j < text.length && isIdentifierPart(text[j])) j++;
                        push(text.slice(i, j), 'syntax-annotation');
                        i = j;
                        continue;
                    }
                    if (ch >= '0' && ch <= '9') {
                        let j = i + 1;
                        while (j < text.length && ((text[j] >= '0' && text[j] <= '9') || '.xXabcdefABCDEF_'.includes(text[j]))) j++;
                        push(text.slice(i, j), 'syntax-number');
                        i = j;
                        continue;
                    }
                    if (isIdentifierStart(ch)) {
                        let j = i + 1;
                        while (j < text.length && isIdentifierPart(text[j])) j++;
                        const word = text.slice(i, j);
                        let className = info.keywords.has(word) ? 'syntax-keyword' : '';
                        if (!className && word[0] >= 'A' && word[0] <= 'Z') className = 'syntax-type';
                        push(word, className);
                        i = j;
                        continue;
                    }
                    let j = i + 1;
                    while (j < text.length && !isIdentifierStart(text[j]) && !(text[j] >= '0' && text[j] <= '9') && !(text[j] === '"' || text[j] === "'" || text[j].charCodeAt(0) === 96 || text[j] === '@') && !(info.lineComment && text.startsWith(info.lineComment, j)) && !text.startsWith('//', j) && !text.startsWith('/*', j)) j++;
                    push(text.slice(i, j));
                    i = j;
                }
                return parts.join('');
            }
            function relativeParts(file) {
                const normalizedFile = normalize(file);
                let root = normalize(workspaceRoot);
                if (root.endsWith('/')) root = root.slice(0, -1);
                const relative = root && keyPath(normalizedFile).startsWith(keyPath(root) + '/')
                    ? normalizedFile.slice(root.length + 1)
                    : normalizedFile;
                const pieces = relative.split('/');
                return { name: pieces.pop() || relative, path: pieces.join('/') || '.' };
            }
            function rebuildGroups() {
                const needle = filterValue.trim().toLowerCase();
                const map = new Map();
                const seen = new Set();
                for (const item of sourceResults) {
                    const dedupeKey = keyPath(item.file) + ':' + item.startLine + ':' + item.preview.join('\\n');
                    if (seen.has(dedupeKey)) continue;
                    seen.add(dedupeKey);
                    const searchable = (item.file + ' ' + item.preview.join(' ')).toLowerCase();
                    if (needle && !searchable.includes(needle)) continue;
                    const key = keyPath(item.file);
                    if (!map.has(key)) map.set(key, { key, file: item.file, matches: [] });
                    map.get(key).matches.push(item);
                }
                const currentFileKey = keyPath(currentFile);
                groups = Array.from(map.values()).sort((a, b) => {
                    const aIsCurrent = currentFileKey && keyPath(a.file) === currentFileKey;
                    const bIsCurrent = currentFileKey && keyPath(b.file) === currentFileKey;
                    if (aIsCurrent !== bIsCurrent) return aIsCurrent ? -1 : 1;
                    return normalize(a.file).localeCompare(normalize(b.file));
                });
                for (const group of groups) group.matches.sort((a,b) => a.startLine - b.startLine);
                selectedFileIndex = Math.max(0, Math.min(selectedFileIndex, Math.max(0, groups.length - 1)));
                const active = groups[selectedFileIndex];
                selectedMatchIndex = Math.max(0, Math.min(selectedMatchIndex, Math.max(0, (active?.matches.length || 1) - 1)));
            }
            function render() {
                rebuildGroups();
                const totalMatches = groups.reduce((sum, group) => sum + group.matches.length, 0);
                document.getElementById('summary').textContent = groups.length + ' files  •  ' + totalMatches + (isWindowSearch ? ' windows' : ' matches');
                document.getElementById('fileHeading').textContent = groups.length + (groups.length === 1 ? ' file' : ' files');
                renderFiles();
                renderMatches(true);
            }
            function renderFiles() {
                fileList.innerHTML = '';
                if (!groups.length) {
                    fileList.innerHTML = '<div class="empty">No files match the filter.</div>';
                    return;
                }
                groups.forEach((group, index) => {
                    const parts = relativeParts(group.file);
                    const item = document.createElement('div');
                    item.className = 'file-item' + (index === selectedFileIndex ? ' selected' : '');
                    item.dataset.index = String(index);
                    item.title = group.file;
                    item.innerHTML = '<span class="file-icon">▧</span><div class="file-copy"><div class="file-name">' + escapeHtml(parts.name) + '</div><div class="file-path">' + escapeHtml(parts.path) + '</div></div><span class="badge">' + group.matches.length + '</span>';
                    item.addEventListener('click', () => selectFile(index));
                    fileList.appendChild(item);
                });
                const selected = fileList.querySelector('.file-item.selected');
                if (selected) selected.scrollIntoView({ block: 'nearest' });
            }
            function renderMatches(previewSelection) {
                activeHeader.innerHTML = '';
                matchList.innerHTML = '';
                const group = groups[selectedFileIndex];
                if (!group) {
                    activeHeader.innerHTML = '<div></div><div><div class="active-name">No results</div><div class="active-path">Change the filter or start a new search.</div></div>';
                    matchList.innerHTML = '<div class="empty">No matching lines.</div>';
                    return;
                }
                const parts = relativeParts(group.file);
                activeHeader.innerHTML = '<span class="file-icon">▧</span><div><div class="active-name">' + escapeHtml(parts.name) + '</div><div class="active-path">' + escapeHtml(parts.path) + '</div></div><span class="badge">' + group.matches.length + (isWindowSearch ? (group.matches.length === 1 ? ' window' : ' windows') : (group.matches.length === 1 ? ' match' : ' matches')) + '</span>';
                group.matches.forEach((match, index) => {
                    const row = document.createElement('div');
                    row.className = 'match-row' + (isWindowSearch ? ' window-result' : '') + (index === selectedMatchIndex ? ' selected' : '');
                    row.dataset.index = String(index);
                    if (isWindowSearch) {
                        row.innerHTML = match.preview.map((line, lineOffset) =>
                            '<div class="window-code-row"><div class="line-number">' + (match.startLine + lineOffset + 1) + '</div><div class="code-line">' + syntaxHighlight(line || '', group.file) + '</div></div>'
                        ).join('');
                    } else {
                        row.innerHTML = '<div class="line-number">' + (match.startLine + 1) + '</div><div class="code-line">' + syntaxHighlight(match.preview[0] || '', group.file) + '</div>';
                    }
                    row.addEventListener('click', () => openMatch(index));
                    row.addEventListener('mouseenter', () => { selectedMatchIndex = index; updateMatchSelection(false); });
                    matchList.appendChild(row);
                });
                updateMatchSelection(previewSelection);
            }
            function selectFile(index) {
                selectedFileIndex = index;
                selectedMatchIndex = 0;
                renderFiles();
                renderMatches(true);
            }
            function moveFile(delta) {
                if (!groups.length) return;
                selectedFileIndex = Math.max(0, Math.min(groups.length - 1, selectedFileIndex + delta));
                selectedMatchIndex = 0;
                renderFiles();
                renderMatches(true);
            }
            function moveMatch(delta) {
                const group = groups[selectedFileIndex];
                if (!group) return;
                const next = selectedMatchIndex + delta;
                if (next < 0 && selectedFileIndex > 0) {
                    selectedFileIndex--;
                    selectedMatchIndex = groups[selectedFileIndex].matches.length - 1;
                    renderFiles(); renderMatches(true); return;
                }
                if (next >= group.matches.length && selectedFileIndex < groups.length - 1) {
                    selectedFileIndex++;
                    selectedMatchIndex = 0;
                    renderFiles(); renderMatches(true); return;
                }
                selectedMatchIndex = Math.max(0, Math.min(group.matches.length - 1, next));
                updateMatchSelection(true);
            }
            function updateMatchSelection(previewSelection) {
                matchList.querySelectorAll('.match-row').forEach(el => el.classList.toggle('selected', Number(el.dataset.index) === selectedMatchIndex));
                const selected = matchList.querySelector('.match-row.selected');
                if (selected) selected.scrollIntoView({ block: 'nearest' });
                if (previewSelection) previewCurrent();
            }
            function currentMatch() { return groups[selectedFileIndex]?.matches[selectedMatchIndex]; }
            function previewCurrent() {
                if (!previewEditor) return;
                const match = currentMatch();
                if (!match) return;
                vscode.postMessage({ command: 'preview', file: match.file, line: match.startLine, windowSize: match.preview.length, terms });
            }
            function openMatch(index = selectedMatchIndex) {
                selectedMatchIndex = index;
                const match = currentMatch();
                if (!match) return;
                vscode.postMessage({ command: 'open', file: match.file, line: match.startLine, windowSize: match.preview.length, terms });
            }
            function enterFilter() { mode = 'filter'; filterInput.style.display = 'block'; filterInput.focus(); filterInput.select(); }
            function leaveFilter() { mode = 'nav'; filterInput.blur(); matchList.focus(); }

            document.getElementById('filterButton').addEventListener('click', enterFilter);
            previewToggle.addEventListener('change', () => {
                previewEditor = previewToggle.checked;
                vscode.setState({ ...savedState, previewEditor });
                if (previewEditor) previewCurrent();
            });
            document.getElementById('newSearchButton').addEventListener('click', () => vscode.postMessage({ command: 'newSearch' }));
            filterInput.addEventListener('input', event => { filterValue = event.target.value; selectedFileIndex = 0; selectedMatchIndex = 0; render(); });
            document.addEventListener('keydown', event => {
                if (mode === 'filter') {
                    if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); leaveFilter(); }
                    return;
                }
                if (event.shiftKey && (event.key === 'J' || event.key === 'ArrowDown')) { event.preventDefault(); moveFile(1); }
                else if (event.shiftKey && (event.key === 'K' || event.key === 'ArrowUp')) { event.preventDefault(); moveFile(-1); }
                else if (!event.shiftKey && (event.key === 'j' || event.key === 'ArrowDown')) { event.preventDefault(); moveMatch(1); }
                else if (!event.shiftKey && (event.key === 'k' || event.key === 'ArrowUp')) { event.preventDefault(); moveMatch(-1); }
                else if (event.key === 'Enter') { event.preventDefault(); openMatch(); }
                else if (event.key === '/') { event.preventDefault(); enterFilter(); }
                else if (event.key === ';') { event.preventDefault(); vscode.postMessage({ command: 'newSearch' }); }
                else if (event.key === 'Escape') { event.preventDefault(); vscode.postMessage({ command: 'close' }); }
            });
            window.addEventListener('load', () => { matchList.focus(); render(); });
        </script>
    </body>
    </html>`;
}

function escapeRegex(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function runSingleLineRipgrep(terms, includePattern, excludePatterns = []) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) throw new Error('No workspace folder');

    const normalizedTerms = terms
        .map(term => String(term).trim().toLowerCase())
        .filter(Boolean);

    if (normalizedTerms.length === 0) return [];

    // Let ripgrep narrow the project using the first term, then enforce
    // same-line AND semantics for every remaining term.
    const anchorTerm = normalizedTerms[0];

    return new Promise((resolve, reject) => {
        const args = [
            '--json',
            '--ignore-case',
            '--fixed-strings',
            anchorTerm
        ];

        if (includePattern) {
            args.push('--glob', includePattern);
        }

        for (const pattern of excludePatterns) {
            args.push('--glob', `!${pattern}`);
        }

        args.push('.');

        const rg = spawn('rg', args, { cwd: workspaceFolder });
        let buffer = '';
        let stderrBuffer = '';

        rg.stdout.on('data', chunk => buffer += chunk.toString());
        rg.stderr.on('data', chunk => stderrBuffer += chunk.toString());
        rg.on('error', reject);

        rg.on('close', code => {
            if (stderrBuffer) {
                console.warn(stderrBuffer);
            }

            if (code !== 0 && code !== 1) {
                reject(new Error(stderrBuffer || `ripgrep exited with code ${code}`));
                return;
            }

            const results = [];

            for (const line of buffer.split('\n')) {
                if (!line.trim()) continue;

                try {
                    const obj = JSON.parse(line);
                    if (obj.type !== 'match') continue;

                    const lineText = obj.data.lines.text.replace(/\r?\n$/, '');
                    const lowerLine = lineText.toLowerCase();

                    if (!normalizedTerms.every(term => lowerLine.includes(term))) {
                        continue;
                    }

                    const file = path.resolve(
                        workspaceFolder,
                        obj.data.path.text
                    );

                    results.push({
                        file,
                        startLine: obj.data.line_number - 1,
                        preview: [lineText]
                    });
                } catch {
                    // Ignore malformed ripgrep JSON records.
                }
            }

            resolve(results);
        });
    });
}

async function runRipgrep(
    terms,
    windowSize,
    includePattern,
    excludePatterns = []
) {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceFolder) throw new Error('No workspace folder');

    let candidateFiles = null;
    const fileMap = new Map();

    for (const term of terms) {
        const termMatches = await runRipgrepForTerm(
            workspaceFolder,
            term,
            candidateFiles,
            includePattern,
            excludePatterns
        );

        const matchedFiles = new Set(termMatches.keys());

        if (candidateFiles === null) {
            candidateFiles = matchedFiles;
        } else {
            candidateFiles = new Set(
                [...candidateFiles].filter(file => matchedFiles.has(file))
            );
        }

        for (const [file, lines] of termMatches.entries()) {
            if (!candidateFiles.has(file)) continue;

            if (!fileMap.has(file)) fileMap.set(file, []);

            for (const line of lines) {
                fileMap.get(file).push({
                    line,
                    term
                });
            }
        }

        if (candidateFiles.size === 0) {
            return [];
        }
    }

    const results = [];

    for (const [file, matches] of fileMap.entries()) {
        if (!candidateFiles.has(file)) continue;

        const doc = await vscode.workspace.openTextDocument(file);
        const allLines = doc.getText().split(/\r?\n/);

        matches.sort((a, b) => a.line - b.line);

        const candidateWindows = [];

        for (const match of matches) {
            const start = Math.max(0, match.line - Math.floor(windowSize / 2));
            const end = Math.min(allLines.length, start + windowSize);

            const coveredTerms = new Set();

            for (const m of matches) {
                if (m.line >= start && m.line < end) {
                    coveredTerms.add(m.term);
                }
            }

            if (coveredTerms.size === terms.length) {
                candidateWindows.push({ start, end });
            }
        }

        candidateWindows.sort((a, b) => a.start - b.start);

        const merged = [];

        for (const win of candidateWindows) {
            if (merged.length === 0) {
                merged.push({ ...win });
                continue;
            }

            const last = merged[merged.length - 1];

            if (win.start <= last.end) {
                last.end = Math.max(last.end, win.end);
            } else {
                merged.push({ ...win });
            }
        }

        for (const win of merged) {
            results.push({
                file,
                startLine: win.start,
                preview: allLines.slice(win.start, win.end)
            });
        }
    }

    return results;
}

function runRipgrepForTerm(
    workspaceFolder,
    term,
    candidateFiles,
    includePattern,
    excludePatterns = []
) {
    return new Promise((resolve, reject) => {
        const args = [
            '--json',
            '--ignore-case',
            escapeRegex(term)
        ];

        if (includePattern) {
            args.push('--glob');
            args.push(includePattern);
        }

        for (const pattern of excludePatterns) {
            args.push('--glob');
            args.push(`!${pattern}`);
        }

        if (candidateFiles && candidateFiles.size > 0) {
            for (const file of candidateFiles) {
                args.push(path.relative(workspaceFolder, file));
            }
        } else {
            args.push('.');
        }

        const rg = spawn('rg', args, { cwd: workspaceFolder });

        let buffer = '';
        let stderrBuffer = '';

        rg.stdout.on('data', chunk => buffer += chunk.toString());
        rg.stderr.on('data', chunk => stderrBuffer += chunk.toString());
        rg.on('error', reject);

        rg.on('close', () => {
            if (stderrBuffer) {
                console.warn(stderrBuffer);
            }

            const matchesByFile = new Map();

            for (const line of buffer.split('\n')) {
                if (!line.trim()) continue;

                try {
                    const obj = JSON.parse(line);

                    if (obj.type !== 'match') continue;

                    const file = path.resolve(
                        workspaceFolder,
                        obj.data.path.text
                    );

                    const lineNum = obj.data.line_number - 1;

                    if (!matchesByFile.has(file)) {
                        matchesByFile.set(file, []);
                    }

                    matchesByFile.get(file).push(lineNum);
                } catch {
                    // ignore malformed rg json lines
                }
            }

            resolve(matchesByFile);
        });
    });
}
function buildExcludePatterns(config) {
    const patterns = [];

    const extensionExclude =
        config.get('exclude', '**/{node_modules,.git,build,out}/**');

    if (extensionExclude) {
        patterns.push(extensionExclude);
    }

    const workspaceConfig = vscode.workspace.getConfiguration();

    const searchExclude =
        workspaceConfig.get('search.exclude', {});

    const filesExclude =
        workspaceConfig.get('files.exclude', {});

    for (const [glob, enabled] of Object.entries(searchExclude)) {
        if (enabled === true) {
            patterns.push(glob);
        }
    }

    for (const [glob, enabled] of Object.entries(filesExclude)) {
        if (enabled === true) {
            patterns.push(glob);
        }
    }

    return [...new Set(patterns)];
}


function deactivate() { }

module.exports = {
    activate,
    deactivate
};