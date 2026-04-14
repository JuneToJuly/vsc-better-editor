const vscode = require('vscode');
let pendingRegion = null;
function activate(context) {
  const RANGE_RADIUS = 3;
  const MAX_HISTORY = 200;
  const IDLE_DELAY = 500;
  const CHECK_INTERVAL = 250;
  const CLEANUP_INTERVAL = 60_000;

  const LOCATION_EXPIRE_AGE = 4 * 60 * 60 * 1000;
  const EDIT_EXPIRE_AGE = 5 * 60 * 1000;

  let recentRegions = [];
  let recentEdits = [];

  let lastPos = null;
  let lastUri = null;
  let lastMoveTime = 0;
  let recordedSinceStop = false;

  // -------------------------------
  // Track idle cursor positions
  // Track idle cursor positions with horizontal confirm
  setInterval(() => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const pos = editor.selection.active;
    const uri = editor.document.uri.toString();

    const moved =
      !lastPos || !lastUri ||
      uri !== lastUri ||
      pos.line !== lastPos.line ||
      pos.character !== lastPos.character;

    if (moved) {

      // 🔥 If we had a pending region, decide what to do
      if (pendingRegion && lastPos) {

        const sameFile = uri === pendingRegion.uri;
        const sameLine = pos.line === pendingRegion.line;
        const horizontal = pos.character !== lastPos.character;

        if (sameFile && sameLine && horizontal) {
          // ✅ Confirm intent → record normally
          recordRegion(
            editor.document,
            new vscode.Position(
              pendingRegion.line,
              pos.character   // 🔥 use CURRENT cursor (after move)
            ),
            recentRegions,
            false
          );
        }

        // ❌ Any other movement cancels it
        pendingRegion = null;
      }

      lastPos = pos;
      lastUri = uri;
      lastMoveTime = Date.now();
      recordedSinceStop = false;
      return;
    }

    const idle = Date.now() - lastMoveTime;

    // 🔥 Mark candidate ONLY (do not record yet)
    if (idle > IDLE_DELAY && !pendingRegion) {
      pendingRegion = {
        uri,
        line: pos.line,
        character: pos.character
      };
    }

  }, CHECK_INTERVAL);
  // -------------------------------
  // Cleanup old entries
  setInterval(() => {
    const now = Date.now();
    recentRegions = recentRegions.filter(r => now - r.updated < LOCATION_EXPIRE_AGE);
    recentEdits = recentEdits.filter(r => now - r.updated < EDIT_EXPIRE_AGE);
  }, CLEANUP_INTERVAL);

  // -------------------------------
  // Track edits
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const doc = event.document;

      for (const change of event.contentChanges) {
        const startLine = change.range.start.line;
        const endLine = change.range.end.line;
        const pos = new vscode.Position(startLine, 0);

        recordRegion(doc, pos, recentEdits, true, startLine, endLine);
      }
    })
  );

  // -------------------------------
  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('recentChunks.show', () =>
      showWebview(recentRegions, 'Recent Code Locations')
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('recentEdits.show', () =>
      showWebview(recentEdits, 'Recent Edit Locations')
    )
  );

  // -------------------------------
  function recordRegion(doc, pos, targetList, isEdit = false, startOverride, endOverride) {
    const uri = doc.uri.toString();
    const center = pos.line;

    const last = targetList.find(r => r.uri === uri);
    if (last && center >= last.start && center <= last.end) return;

    let start, end;

    if (isEdit) {
      start = startOverride ?? center;
      end = endOverride ?? center;
    } else {
      start = Math.max(0, center - RANGE_RADIUS);
      end = Math.min(doc.lineCount - 1, center + RANGE_RADIUS);
    }

    const lines = [];
    for (let i = start; i <= end; i++) {
      try { lines.push(doc.lineAt(i).text); } catch { break; }
    }

    targetList.unshift({
      uri,
      file: vscode.workspace.asRelativePath(doc.uri),
      start,
      end,
      lines,
      character: pos.character,
      updated: Date.now()
    });

    targetList.sort((a, b) => b.updated - a.updated);
    if (targetList.length > MAX_HISTORY) targetList.pop();
  }

  // -------------------------------
  function mapToWindowResults(list) {
    return list.map(r => ({
      file: r.file,
      fullUri: r.uri,
      startLine: r.start,
      preview: r.lines
    }));
  }

  // -------------------------------
  async function showWebview(list, title) {
    if (!list.length) {
      vscode.window.showInformationMessage(`No ${title.toLowerCase()} yet.`);
      return;
    }

    const results = mapToWindowResults(list);

    const originalEditor = vscode.window.activeTextEditor;
    const originalColumn = originalEditor
      ? originalEditor.viewColumn
      : vscode.ViewColumn.One;

    const originalLocation = originalEditor
      ? {
        uri: originalEditor.document.uri.toString(),
        position: originalEditor.selection.active,
        viewColumn: originalEditor.viewColumn
      }
      : null;

    const windowHighlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: 'rgba(255, 255, 0, 0.15)',
      border: '1px solid rgba(255,255,0,0.4)'
    });

    function clearHighlights() {
      vscode.window.visibleTextEditors.forEach(e => {
        e.setDecorations(windowHighlight, []);
      });
    }

    async function restoreOriginalLocation() {
      if (!originalLocation) return;

      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.parse(originalLocation.uri)
      );

      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: originalLocation.viewColumn,
        preserveFocus: false,
        preview: false
      });

      editor.selection = new vscode.Selection(
        originalLocation.position,
        originalLocation.position
      );

      editor.revealRange(
        new vscode.Range(originalLocation.position, originalLocation.position),
        vscode.TextEditorRevealType.InCenter
      );
    }

    const panel = vscode.window.createWebviewPanel(
      'recentLocations',
      title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    panel.webview.html = getHtml(results);

    panel.reveal(vscode.ViewColumn.Active, false);

    let lastEditor = null;
    let lastFile = null;
    let lastLine = null;

    panel.webview.onDidReceiveMessage(async (message) => {

      // -------------------------
      // PREVIEW
      if (message.command === 'preview') {
        const uri = vscode.Uri.parse(message.fullUri);

        let editor;

        if (lastEditor && lastFile === message.fullUri) {
          editor = lastEditor;
        } else {
          const doc = await vscode.workspace.openTextDocument(uri);

          editor = await vscode.window.showTextDocument(doc, {
            viewColumn: originalColumn,
            preserveFocus: true,
            preview: true
          });

          lastEditor = editor;
          lastFile = message.fullUri;
        }

        if (lastLine === message.line) return;
        lastLine = message.line;

        const lineStart = new vscode.Position(message.line, 0);
        const targetLine = message.line + Math.floor(message.windowSize / 2);

        const start = new vscode.Position(
          targetLine,
          message.character ?? 0
        );
        const lineEnd = new vscode.Position(
          message.line,
          editor.document.lineAt(message.line).text.length
        );

        clearHighlights();

        editor.setDecorations(windowHighlight, [
          new vscode.Range(start, lineEnd)
        ]);

        clearHighlights();

        editor.selection = new vscode.Selection(start, start);

        editor.revealRange(
          new vscode.Range(start, start),
          vscode.TextEditorRevealType.InCenter
        );
      }

      // -------------------------
      // OPEN (commit)
      if (message.command === 'open') {
        clearHighlights();

        lastEditor = null;
        lastFile = null;
        lastLine = null;

        const uri = vscode.Uri.parse(message.fullUri);

        panel.dispose();

        setTimeout(async () => {
          const doc = await vscode.workspace.openTextDocument(uri);

          const editor = await vscode.window.showTextDocument(doc, {
            viewColumn: originalColumn,
            preserveFocus: false,
            preview: false
          });

          const targetLine = message.line + Math.floor(message.windowSize / 2);
          const pos = new vscode.Position(
            targetLine,
            message.character ?? 0
          );

          editor.selection = new vscode.Selection(pos, pos);


          editor.revealRange(
            new vscode.Range(pos, pos),
            vscode.TextEditorRevealType.InCenter
          );
        }, 10);
      }

      // -------------------------
      // CLOSE (escape)
      if (message.command === 'close') {
        clearHighlights();
        await restoreOriginalLocation();
        panel.dispose();
      }
    });
  }

  // -------------------------------
  function getHtml(results) {
    return `
  <html>
  <body style="background:#1e1e1e;color:#ddd;font-family:monospace;">

  <input id="filter" placeholder="Filter..." 
         style="display:none;width:100%;margin-bottom:8px;background:#2a2a2a;color:#fff;border:1px solid #444;padding:6px;" />

  <div id="results" tabindex="0"></div>

  <script>
    const vscode = acquireVsCodeApi();

    let raw = ${JSON.stringify(results)};
    let filtered = [...raw];

    let selected = 0;
    let mode = 'nav';

    function render() {
      const root = document.getElementById('results');
      root.innerHTML = '';

      filtered.forEach((r, i) => {
        const div = document.createElement('div');

        div.style.padding = '8px';
        div.style.marginBottom = '10px';
        div.style.border = i === selected ? '1px solid #3a4a58' : '1px solid #2a2a2a';
        div.style.background = i === selected ? '#1f2a33' : '#181818';

        if (i === selected) {
          div.style.boxShadow = '0 0 0 1px #007acc inset';
        }

        const header = document.createElement('div');
        header.textContent = r.file + ':' + (r.startLine + 1);
        header.style.color = '#4FC1FF';
        header.style.opacity = '0.9';
        header.style.marginBottom = '4px';

        div.appendChild(header);

        const targetIndex = Math.floor(r.preview.length / 2);

        r.preview.forEach((line, idx) => {
          const l = document.createElement('div');

          l.textContent = (r.startLine + idx + 1) + '  ' + line;
          l.style.color = '#d4d4d4';
          l.style.padding = '1px 4px';

          if (idx === targetIndex) {
            l.style.background = '#264f78';   // VSCode selection blue
            l.style.color = '#ffffff';
            l.style.borderRadius = '3px';
          }

          div.appendChild(l);
        });

        div.onclick = () => open(i);
        root.appendChild(div);
      });

      preview();
    }

    function preview() {
      const r = filtered[selected];
      if (!r) return;

      vscode.postMessage({
        command: 'preview',
        fullUri: r.fullUri,
        line: r.startLine,
        character: r.character,
        windowSize: r.preview.length
      });
    }

    function open(i) {
      const r = filtered[i];
      vscode.postMessage({
        command: 'open',
        fullUri: r.fullUri,
        line: r.startLine,
        character: r.character,
        windowSize: r.preview.length
      });
    }

    function applyFilter(value) {
      value = value.toLowerCase();

      filtered = raw.filter(r => {
        const text = r.preview.join(' ').toLowerCase();
        return text.includes(value);
      });

      selected = 0;
      render();
    }

    document.addEventListener('keydown', (e) => {

      // NAV MODE
      if (mode === 'nav') {

        if (e.key === '/') {
          e.preventDefault();
          mode = 'filter';

          const input = document.getElementById('filter');
          input.style.display = 'block';
          input.focus();
          return;
        }

        if (e.key === 'j') {
          selected = Math.min(selected + 1, filtered.length - 1);
          render();
        }

        if (e.key === 'k') {
          selected = Math.max(selected - 1, 0);
          render();
        }

        if (e.key === 'Enter') {
          open(selected);
        }

        if (e.key === 'Escape' || e.key === ';') {
          vscode.postMessage({ command: 'close' });
        }
      }

      // FILTER MODE
      else if (mode === 'filter') {

        if (e.key === ';') {
          mode = 'nav';

          const input = document.getElementById('filter');
          input.blur();
          input.style.display = 'none';
        }
      }
    });

    document.getElementById('filter').addEventListener('input', e => {
      applyFilter(e.target.value);
    });

    window.onload = () => {
      document.getElementById('results').focus();
      render();
    };
  </script>

  </body>
  </html>
  `;
  }
}

function deactivate() { }

module.exports = {
  activate,
  deactivate
};