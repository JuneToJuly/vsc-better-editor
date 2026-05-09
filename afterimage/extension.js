const vscode = require('vscode');

let pendingRegion = null;

function activate(context) {
  const EDIT_DEBOUNCE_DELAY = 1000;

  let pendingEditsByDocument = new Map();
  let editTimersByDocument = new Map();
  const RANGE_RADIUS = 3;
  const MAX_HISTORY = 200;
  const IDLE_DELAY = 500;
  const CHECK_INTERVAL = 250;
  const CLEANUP_INTERVAL = 60_000;

  const LOCATION_EXPIRE_AGE = 4 * 60 * 60 * 1000;
  const EDIT_EXPIRE_AGE = 5 * 60 * 1000;

  let recentRegions = [];
  let recentEdits = [];

  let documentSnapshots = new Map();

  let lastPos = null;
  let lastUri = null;
  let lastMoveTime = 0;
  let recordedSinceStop = false;

  // -------------------------------
  // Capture initial document snapshots
  for (const doc of vscode.workspace.textDocuments) {
    documentSnapshots.set(doc.uri.toString(), doc.getText());
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      documentSnapshots.set(doc.uri.toString(), doc.getText());
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument(doc => {
      documentSnapshots.delete(doc.uri.toString());
    })
  );

  // -------------------------------
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

      if (pendingRegion && lastPos) {
        const sameFile = uri === pendingRegion.uri;
        const sameLine = pos.line === pendingRegion.line;
        const horizontal = pos.character !== lastPos.character;

        if (sameFile && sameLine && horizontal) {
          recordRegion(
            editor.document,
            new vscode.Position(
              pendingRegion.line,
              pos.character
            ),
            recentRegions,
            false
          );
        }

        pendingRegion = null;
      }

      lastPos = pos;
      lastUri = uri;
      lastMoveTime = Date.now();
      recordedSinceStop = false;
      return;
    }

    const idle = Date.now() - lastMoveTime;

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
  // Track edits with before/after capture
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(event => {
      const doc = event.document;
      const uri = doc.uri.toString();

      const beforeText = documentSnapshots.get(uri) ?? '';

      if (!pendingEditsByDocument.has(uri)) {
        pendingEditsByDocument.set(uri, {
          doc,
          beforeText,
          changes: [],
          firstStartLine: null,
          lastEndLine: null,
          firstCharacter: 0
        });
      }

      const pending = pendingEditsByDocument.get(uri);

      for (const change of event.contentChanges) {
        const startLine = change.range.start.line;

        const changedLineCount = Math.max(
          1,
          change.text.split(/\r?\n/).length
        );

        const endLine = Math.min(
          doc.lineCount - 1,
          startLine + changedLineCount - 1
        );

        pending.changes.push(change);

        if (pending.firstStartLine === null || startLine < pending.firstStartLine) {
          pending.firstStartLine = startLine;
          pending.firstCharacter = change.range.start.character;
        }

        if (pending.lastEndLine === null || endLine > pending.lastEndLine) {
          pending.lastEndLine = endLine;
        }
      }

      documentSnapshots.set(uri, doc.getText());

      const existingTimer = editTimersByDocument.get(uri);
      if (existingTimer) clearTimeout(existingTimer);

      const timer = setTimeout(() => {
        const pending = pendingEditsByDocument.get(uri);
        if (!pending) return;

        const currentDoc = pending.doc;
        const currentText = currentDoc.getText();

        const startLine = pending.firstStartLine ?? 0;
        const endLine = pending.lastEndLine ?? startLine;

        const before = getChangedLineBlockFromSnapshot(
          pending.beforeText,
          startLine,
          endLine
        );

        const after = getChangedLineBlockFromSnapshot(
          currentText,
          startLine,
          endLine
        );

        const pos = new vscode.Position(
          startLine,
          pending.firstCharacter ?? 0
        );

        recordEditRegion(
          currentDoc,
          pos,
          recentEdits,
          before,
          after,
          startLine,
          endLine
        );

        pendingEditsByDocument.delete(uri);
        editTimersByDocument.delete(uri);

      }, EDIT_DEBOUNCE_DELAY);

      editTimersByDocument.set(uri, timer);
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
  function getTextFromSnapshot(text, range) {
    const lines = text.split(/\r?\n/);

    if (range.start.line === range.end.line) {
      const line = lines[range.start.line] ?? '';
      return line.slice(range.start.character, range.end.character);
    }

    const selected = [];

    for (let i = range.start.line; i <= range.end.line; i++) {
      const line = lines[i] ?? '';

      if (i === range.start.line) {
        selected.push(line.slice(range.start.character));
      } else if (i === range.end.line) {
        selected.push(line.slice(0, range.end.character));
      } else {
        selected.push(line);
      }
    }

    return selected.join('\n');
  }

function getChangedLineBlockFromSnapshot(text, startLine, endLine) {
  const lines = text.split(/\r?\n/);

  const safeStart = Math.max(0, startLine);
  const safeEnd = Math.min(lines.length - 1, endLine);

  const selected = [];

  for (let i = safeStart; i <= safeEnd; i++) {
    selected.push(lines[i] ?? '');
  }

  return selected.join('\n');
}

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
  function recordEditRegion(doc, pos, targetList, before, after, startOverride, endOverride) {
    const uri = doc.uri.toString();
    const center = pos.line;

    const start = startOverride ?? center;
    const end = endOverride ?? center;

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
      before,
      after,
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
      preview: r.lines,
      before: r.before,
      after: r.after,
      character: r.character
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

        const targetLine = message.line + Math.floor(message.windowSize / 2);

        const safeTargetLine = Math.min(
          editor.document.lineCount - 1,
          Math.max(0, targetLine)
        );

        const start = new vscode.Position(
          safeTargetLine,
          message.character ?? 0
        );

        const lineEnd = new vscode.Position(
          safeTargetLine,
          editor.document.lineAt(safeTargetLine).text.length
        );

        clearHighlights();

        editor.setDecorations(windowHighlight, [
          new vscode.Range(start, lineEnd)
        ]);

        editor.selection = new vscode.Selection(start, start);

        editor.revealRange(
          new vscode.Range(start, start),
          vscode.TextEditorRevealType.InCenter
        );
      }

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

          const safeTargetLine = Math.min(
            editor.document.lineCount - 1,
            Math.max(0, targetLine)
          );

          const pos = new vscode.Position(
            safeTargetLine,
            message.character ?? 0
          );

          editor.selection = new vscode.Selection(pos, pos);

          editor.revealRange(
            new vscode.Range(pos, pos),
            vscode.TextEditorRevealType.InCenter
          );
        }, 10);
      }

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
    function scrollIntoViewIfNeeded(el) {
      if (!el) return;

      const rect = el.getBoundingClientRect();

      if (rect.top < 0 || rect.bottom > window.innerHeight) {
        el.scrollIntoView({
          block: "center",
          behavior: "smooth"
        });
      }
    }

    function formatValue(value) {
      if (value === undefined || value === null || value.length === 0) {
        return '[empty]';
      }

      return value;
    }

    function renderDiff(div, r) {
      if (r.before === undefined && r.after === undefined) return;

      const diff = document.createElement('div');
      diff.style.margin = '6px 0';
      diff.style.padding = '6px';
      diff.style.background = '#111';
      diff.style.border = '1px solid #333';
      diff.style.borderRadius = '4px';

      const before = document.createElement('div');
      before.textContent = '- ' + formatValue(r.before);
      before.style.color = '#f48771';
      before.style.whiteSpace = 'pre-wrap';

      const after = document.createElement('div');
      after.textContent = '+ ' + formatValue(r.after);
      after.style.color = '#89d185';
      after.style.whiteSpace = 'pre-wrap';

      diff.appendChild(before);
      diff.appendChild(after);

      div.appendChild(diff);
    }

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

        renderDiff(div, r);

        const targetIndex = Math.floor(r.preview.length / 2);

        r.preview.forEach((line, idx) => {
          const l = document.createElement('div');

          l.textContent = (r.startLine + idx + 1) + '  ' + line;
          l.style.color = '#d4d4d4';
          l.style.padding = '1px 4px';
          l.style.whiteSpace = 'pre-wrap';

          if (idx === targetIndex) {
            l.style.background = '#264f78';
            l.style.color = '#ffffff';
            l.style.borderRadius = '3px';
          }

          div.appendChild(l);
        });

        div.onclick = () => open(i);
        root.appendChild(div);
      });
      const selectedEl = document.querySelectorAll('#results > div')[selected];
      scrollIntoViewIfNeeded(selectedEl);

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
        const text = [
          r.preview.join(' '),
          r.before ?? '',
          r.after ?? ''
        ].join(' ').toLowerCase();

        return text.includes(value);
      });

      selected = 0;
      render();
    }

    document.addEventListener('keydown', (e) => {

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
