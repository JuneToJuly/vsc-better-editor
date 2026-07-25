const vscode = require('vscode');
const path = require('path');

const RANGE_RADIUS = 3;
const MAX_HISTORY = 30;
const MAX_TRAIL_EVENTS = 30;
const IDLE_DELAY = 1500;
const CHECK_INTERVAL = 250;
const CLEANUP_INTERVAL = 60_000;
const LOCATION_EXPIRE_AGE = 4 * 60 * 60 * 1000;
const GROUP_MERGE_DISTANCE = 5;

let recentLocations = [];
let visitTrail = [];
let nextLocationId = 1;
let nextVisitSequence = 1;
let lastPos = null;
let lastUri = null;
let lineEnteredTime = 0;
let movedHorizontallyOnLine = false;
let candidateDocument = null;
let cursorTimer = null;
let cleanupTimer = null;


async function clearAllHistory() {
  const choice = await vscode.window.showWarningMessage(
    'Clear all recent code locations and journey history?',
    { modal: true },
    'Clear All'
  );
  if (choice !== 'Clear All') return false;

  recentLocations = [];
  visitTrail = [];
  nextLocationId = 1;
  nextVisitSequence = 1;
  lastPos = null;
  lastUri = null;
  lineEnteredTime = 0;
  movedHorizontallyOnLine = false;
  candidateDocument = null;
  vscode.window.showInformationMessage('Cleared all recent code location history.');
  return true;
}

function activate(context) {
  cursorTimer = setInterval(trackActiveCursorLocation, CHECK_INTERVAL);
  cleanupTimer = setInterval(cleanupExpiredLocations, CLEANUP_INTERVAL);

  context.subscriptions.push(
    { dispose: () => clearInterval(cursorTimer) },
    { dispose: () => clearInterval(cleanupTimer) },
    vscode.commands.registerCommand('fileChangeHistory.showCurrentFileHistory', () =>
      showWebview(recentLocations, 'Recent Code Locations')
    ),
    vscode.commands.registerCommand('fileChangeHistory.clearCurrentFileHistory', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const uri = editor.document.uri.toString();
      const removedIds = new Set(recentLocations.filter(location => location.uri === uri).map(location => location.id));
      recentLocations = recentLocations.filter(location => location.uri !== uri);
      visitTrail = visitTrail.filter(visit => !removedIds.has(visit.locationId));
      vscode.window.showInformationMessage(`Cleared recent locations for ${path.basename(editor.document.fileName)}.`);
    }),
    vscode.commands.registerCommand('fileChangeHistory.clearAllHistory', clearAllHistory)
  );
}

function trackActiveCursorLocation() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return;

  const pos = editor.selection.active;
  const uri = editor.document.uri.toString();
  const now = Date.now();
  const changedEditorOrLine = !lastPos || !lastUri || uri !== lastUri || pos.line !== lastPos.line;

  if (changedEditorOrLine) {
    if (candidateDocument && lastPos && movedHorizontallyOnLine && now - lineEnteredTime >= IDLE_DELAY) {
      recordLocation(candidateDocument, lastPos);
    }

    lastPos = new vscode.Position(pos.line, pos.character);
    lastUri = uri;
    candidateDocument = editor.document;
    lineEnteredTime = now;
    movedHorizontallyOnLine = false;
    return;
  }

  if (pos.character !== lastPos.character) {
    movedHorizontallyOnLine = true;
    lastPos = new vscode.Position(pos.line, pos.character);
  }
}

function cleanupExpiredLocations() {
  const now = Date.now();
  recentLocations = recentLocations.filter(location => now - location.timestamp < LOCATION_EXPIRE_AGE);
  const validIds = new Set(recentLocations.map(location => location.id));
  visitTrail = visitTrail.filter(visit => validIds.has(visit.locationId));
}

function recordLocation(doc, pos) {
  const uri = doc.uri.toString();
  const line = pos.line;

  // Do not create consecutive journey events for the same file and line.
  // Horizontal movement may change the recorded column, but it is still the
  // same code location until the user visits another line.
  const previousVisit = visitTrail[visitTrail.length - 1];
  if (previousVisit && previousVisit.uri === uri && previousVisit.line === line) {
    return;
  }
  const startLine = Math.max(0, line - RANGE_RADIUS);
  const endLine = Math.min(doc.lineCount - 1, line + RANGE_RADIUS);

  const previewLines = [];
  for (let currentLine = startLine; currentLine <= endLine; currentLine++) {
    previewLines.push(doc.lineAt(currentLine).text);
  }

  const relativeFile = vscode.workspace.asRelativePath(doc.uri);
  const timestamp = Date.now();
  const entry = {
    id: `location-${nextLocationId++}`,
    uri,
    file: doc.fileName,
    fileName: path.basename(doc.fileName),
    relativeFile,
    directory: path.dirname(relativeFile),
    startLine,
    endLine,
    line,
    character: pos.character,
    previewLines,
    timestamp,
    visitCount: 1,
    visitSequences: [],
    lineCount: doc.lineCount
  };

  // Always preserve the immediately previous idle stop. Only merge this
  // location with an older nearby region, which keeps true navigation order
  // while still consolidating locations revisited later.
  const mergeIndex = recentLocations.findIndex((location, index) => {
    if (index === 0 || location.uri !== uri) return false;

    const lineDistance = Math.abs(location.line - line);
    if (lineDistance > GROUP_MERGE_DISTANCE) return false;

    // A different horizontal position on the same line is a distinct code
    // location. Only merge same-line entries when the cursor column matches.
    if (lineDistance === 0 && location.character !== pos.character) return false;

    return true;
  });

  if (mergeIndex >= 0) {
    const previous = recentLocations.splice(mergeIndex, 1)[0];
    entry.id = previous.id;
    entry.visitCount = (previous.visitCount || 1) + 1;
    entry.visitSequences = Array.isArray(previous.visitSequences) ? [...previous.visitSequences] : [];
  }

  const sequence = nextVisitSequence++;
  entry.visitSequences.push(sequence);
  visitTrail.push({
    sequence,
    locationId: entry.id,
    timestamp,
    uri,
    line,
    character: pos.character
  });
  if (visitTrail.length > MAX_TRAIL_EVENTS) {
    visitTrail = visitTrail.slice(-MAX_TRAIL_EVENTS);
  }

  recentLocations.unshift(entry);

  if (recentLocations.length > MAX_HISTORY) {
    recentLocations.length = MAX_HISTORY;
    const validIds = new Set(recentLocations.map(location => location.id));
    visitTrail = visitTrail.filter(visit => validIds.has(visit.locationId));
  }
}

async function showWebview(list, title) {
  if (!list.length) {
    vscode.window.showInformationMessage(`No ${title.toLowerCase()} yet.`);
    return;
  }

  const originalEditor = vscode.window.activeTextEditor;
  const originalColumn = originalEditor?.viewColumn || vscode.ViewColumn.One;

  const panel = vscode.window.createWebviewPanel(
    'recentLocations',
    title,
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  const activeUri = originalEditor?.document.uri.toString() || null;
  panel.webview.html = getHtml(list, visitTrail, title, activeUri);
  panel.reveal(vscode.ViewColumn.Active, false);

  panel.webview.onDidReceiveMessage(async message => {
    if (message.command === 'open') {
      const uri = vscode.Uri.parse(message.fullUri);
      panel.dispose();
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: originalColumn,
        preserveFocus: false,
        preview: false
      });
      const safeLine = Math.max(0, Math.min(message.line, doc.lineCount - 1));
      const safeCharacter = Math.max(0, Math.min(message.character || 0, doc.lineAt(safeLine).text.length));
      const pos = new vscode.Position(safeLine, safeCharacter);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      return;
    }

    if (message.command === 'clearAll') {
      const cleared = await clearAllHistory();
      if (cleared) panel.dispose();
      return;
    }

    if (message.command === 'close') {
      panel.dispose();
    }
  });

  panel.onDidDispose(() => {
  });
}

function getHtml(list, trail, title, activeUri) {
  const groups = groupByEditor(list);
  const serialized = JSON.stringify(groups).replace(/</g, '\\u003c');
  const serializedTrail = JSON.stringify(trail).replace(/</g, '\\u003c');
  const serializedLocations = JSON.stringify(list).replace(/</g, '\\u003c');

  return String.raw`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); }
  .toolbar { position: sticky; top: 0; z-index: 20; display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; gap: 14px; padding: 10px 14px; background: var(--vscode-editor-background); border-bottom: 1px solid var(--vscode-panel-border); }
  .title { font-size: 13px; font-weight: 700; }
  .summary { margin-left: 8px; color: var(--vscode-descriptionForeground); font-weight: 400; }
  .view-switch { display: flex; padding: 2px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; background: var(--vscode-input-background); }
  .view-button { border: 0; border-radius: 3px; padding: 4px 10px; color: var(--vscode-descriptionForeground); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
  .view-button:hover { color: var(--vscode-editor-foreground); }
  .view-button.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .clear-button { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 4px 8px; color: var(--vscode-descriptionForeground); background: transparent; font: inherit; font-size: 11px; cursor: pointer; }
  .clear-button:hover { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .hint { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }
  .search-wrap { display: none; min-width: 220px; }
  .search-wrap.visible { display: block; }
  .search-input { width: 100%; height: 26px; padding: 3px 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); outline: none; font: inherit; font-size: 11px; }
  .search-input:focus { border-color: var(--vscode-focusBorder); }
  #results { outline: none; padding-bottom: 20px; }

  .group { border-bottom: 1px solid var(--vscode-panel-border); }
  .group-header { position: sticky; top: 43px; z-index: 10; display: grid; grid-template-columns: 18px minmax(0, 1fr) 34px auto; gap: 10px; align-items: center; min-height: 66px; padding: 8px 14px; background: var(--vscode-sideBar-background); cursor: pointer; }
  .group-header:hover { background: var(--vscode-list-hoverBackground); }
  .chevron { color: var(--vscode-descriptionForeground); }
  .file-name { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-meta { margin-top: 2px; font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 10px; padding: 2px 6px; border-radius: 999px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); }
  .active-badge { margin-left: 7px; color: var(--vscode-textLink-foreground); font-size: 10px; }
  .file-minimap { position: relative; width: 24px; height: 48px; justify-self: center; cursor: default; }
  .file-minimap-track { position: absolute; left: 10px; top: 2px; bottom: 2px; width: 3px; border-radius: 999px; background: var(--vscode-editorIndentGuide-background1, var(--vscode-panel-border)); opacity: .9; }
  .file-minimap-dot { position: absolute; left: 6px; width: 11px; height: 11px; transform: translateY(-50%); border: 2px solid var(--vscode-sideBar-background); border-radius: 50%; background: var(--vscode-badge-background); cursor: pointer; transition: transform .12s ease, box-shadow .12s ease, opacity .12s ease; opacity: .8; }
  .file-minimap-dot:hover { transform: translateY(-50%) scale(1.35); opacity: 1; z-index: 3; }
  .file-minimap-dot.latest { background: var(--vscode-focusBorder); box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 35%, transparent); opacity: 1; }
  .file-minimap-dot.hot { width: 14px; height: 14px; left: 4.5px; }
  .file-minimap-range { position: absolute; left: 8px; width: 7px; min-height: 3px; border-radius: 999px; background: color-mix(in srgb, var(--vscode-badge-background) 45%, transparent); pointer-events: none; }

  .locations { padding: 3px 0 7px; }
  .group.collapsed .locations { display: none; }
  .location { display: grid; grid-template-columns: 38px minmax(0, 1fr) auto; gap: 9px; padding: 7px 14px 7px 18px; cursor: pointer; border-left: 2px solid transparent; }
  .location:hover, .journey-row:hover { background: var(--vscode-list-hoverBackground); }
  .location.selected, .journey-row.selected { background: color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 28%, transparent); color: var(--vscode-editor-foreground); border-left-color: var(--vscode-focusBorder); box-shadow: inset 0 1px 0 color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent), inset 0 -1px 0 color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent); }
  .location.selected .code-preview-line:not(.target), .journey-row.selected .code-preview-line:not(.target) { opacity: .42; }
  .location.selected .sequence-dot, .journey-row.selected .sequence-dot { box-shadow: 0 0 0 2px color-mix(in srgb, var(--vscode-focusBorder) 45%, transparent); }
  .line { font-family: var(--vscode-editor-font-family); color: var(--vscode-textLink-foreground); font-size: 11px; padding-top: 1px; }
  .preview { min-width: 0; }
  .code-context { min-width: 0; font-family: var(--vscode-editor-font-family); font-size: 11px; line-height: 1.45; }
  .code-preview-line { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 9px; min-width: 0; opacity: .34; }
  .code-preview-line + .code-preview-line { margin-top: 1px; }
  .code-preview-line.target { opacity: 1; font-weight: 650; }
  .code-preview-line.target .code-line-number { color: var(--vscode-textLink-foreground); }
  .code-preview-line.target .code-line-text { border-left: 2px solid var(--vscode-focusBorder); padding-left: 8px; }
  .cursor-block { display: inline-block; min-width: 0.62em; height: 1.15em; line-height: 1.15em; margin-bottom: -0.18em; border-radius: 1px; background: var(--vscode-editorCursor-foreground, var(--vscode-focusBorder)); color: var(--vscode-editor-background); box-shadow: 0 0 0 1px color-mix(in srgb, var(--vscode-editorCursor-foreground, var(--vscode-focusBorder)) 75%, transparent); text-align: center; vertical-align: baseline; }
  .code-line-number { color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
  .code-line-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; tab-size: 4; }
  .primary { font-family: var(--vscode-editor-font-family); overflow: hidden; text-overflow: ellipsis; white-space: pre; tab-size: 4; }
  .tok-keyword { color: var(--vscode-symbolIcon-keywordForeground, #c586c0); }
  .tok-string { color: var(--vscode-symbolIcon-stringForeground, #ce9178); }
  .tok-number { color: var(--vscode-symbolIcon-numberForeground, #b5cea8); }
  .tok-comment { color: var(--vscode-descriptionForeground); font-style: italic; }
  .tok-type { color: var(--vscode-symbolIcon-classForeground, #4ec9b0); }
  .tok-function { color: var(--vscode-symbolIcon-methodForeground, #dcdcaa); }
  .tok-operator { color: var(--vscode-editor-foreground); }
  .secondary { margin-top: 2px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
  .time { color: var(--vscode-descriptionForeground); font-size: 10px; white-space: nowrap; }

  .journey { padding: 8px 0 16px; }
  .journey-row { position: relative; display: grid; grid-template-columns: 92px minmax(145px, 0.55fr) minmax(0, 2fr) auto; gap: 10px; align-items: center; min-height: 58px; padding: 8px 14px 8px 10px; cursor: pointer; border-left: 2px solid transparent; }
  .journey-gutter { display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 7px; align-items: center; min-width: 0; }
  .sequence-dot { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 750; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); border: 2px solid var(--vscode-editor-background); }
  .journey-row.latest .sequence-dot { outline: 2px solid var(--vscode-focusBorder); }
  .gutter-state { min-width: 0; }
  .gutter-icon { display: block; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1; }
  .gutter-label { display: block; margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 8px; font-weight: 700; letter-spacing: .035em; line-height: 1.1; text-transform: uppercase; white-space: normal; }
  .transition-file-switch .gutter-icon, .transition-file-switch .gutter-label { color: var(--vscode-focusBorder); }
  .transition-same-file .gutter-icon, .transition-same-line .gutter-icon { color: var(--vscode-textLink-foreground); }
  .journey-file { min-width: 0; }
  .journey-file-name { font-weight: 650; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .journey-file-meta { margin-top: 3px; color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .journey-code { min-width: 0; }
  .journey-code .code-context { margin-top: 4px; font-size: 11px; }
  .journey-code .code-preview-line { opacity: .3; }
  .journey-code .code-preview-line.target { opacity: 1; font-size: 12px; }
  .journey-line { color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: 11px; }
  .journey-time { text-align: right; }
  .elapsed { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 9px; }
  .empty { padding: 30px; color: var(--vscode-descriptionForeground); text-align: center; }
</style>
</head>
<body>
  <div class="toolbar">
    <div class="title">${escapeHtml(title)} <span id="summary" class="summary"></span></div>
    <div id="search-wrap" class="search-wrap"><input id="search-input" class="search-input" type="text" placeholder="Filter locations…" aria-label="Filter recent locations"></div>
    <div class="view-switch" role="tablist" aria-label="Recent location view">
      <button id="grouped-button" class="view-button" type="button">Grouped</button>
      <button id="journey-button" class="view-button active" type="button">Journey</button>
    </div>
    <button id="clear-all-button" class="clear-button" type="button" title="Clear all recent locations">Clear All</button>
    <div class="hint">/ search · j older · k newer · v toggle · Enter open · Esc close</div>
  </div>
  <div id="results" tabindex="0"></div>
<script>
  const vscode = acquireVsCodeApi();
  const groups = ${serialized};
  const visitTrail = ${serializedTrail};
  const locations = ${serializedLocations};
  const locationById = new Map(locations.map(location => [location.id, location]));
  let mode = 'journey';
  let selected = 0;
  let flat = [];
  let query = '';

  function matchesLocation(location) {
    if (!query) return true;
    const haystack = [location.fileName, location.directory, location.relativeFile, String((location.line || 0) + 1), ...(Array.isArray(location.previewLines) ? location.previewLines : [])].join(' ').toLowerCase();
    return haystack.includes(query);
  }

  function setMode(nextMode) {
    mode = nextMode;
    selected = 0;
    document.getElementById('grouped-button').classList.toggle('active', mode === 'grouped');
    document.getElementById('journey-button').classList.toggle('active', mode === 'journey');
    render();
    document.getElementById('results').focus();
  }

  function rebuildFlat() {
    flat = [];
    if (mode === 'grouped') {
      groups.forEach((group, groupIndex) => {
        if (!group.collapsed) {
          group.locations.filter(matchesLocation).forEach((location, locationIndex) => flat.push({ groupIndex, locationIndex, location }));
        }
      });
    } else {
      [...visitTrail].reverse().forEach(visit => {
        const location = locationById.get(visit.locationId);
        if (location && matchesLocation(location)) flat.push({ visit, location });
      });
    }
    selected = Math.max(0, Math.min(selected, Math.max(0, flat.length - 1)));
  }

  function render() {
    rebuildFlat();
    const root = document.getElementById('results');
    root.innerHTML = '';
    document.getElementById('summary').textContent = mode === 'grouped'
      ? new Set(flat.map(item => item.location.uri)).size + ' editors · ' + flat.length + ' locations'
      : flat.length + ' accepted visits · newest first';

    if (mode === 'grouped') renderGrouped(root);
    else renderJourney(root);

  }

  function renderGrouped(root) {
    let flatIndex = 0;
    groups.forEach((group, groupIndex) => {
      const visibleLocations = group.locations.filter(matchesLocation);
      if (!visibleLocations.length) return;
      const section = document.createElement('section');
      section.className = 'group' + (group.collapsed ? ' collapsed' : '');

      const header = document.createElement('div');
      header.className = 'group-header';
      header.innerHTML = '<div class="chevron">' + (group.collapsed ? '▸' : '▾') + '</div>' +
        '<div><div class="file-name">' + escapeHtmlClient(group.fileName) + (group.uri === ${JSON.stringify(activeUri)} ? '<span class="active-badge">ACTIVE EDITOR</span>' : '') + '</div>' +
        '<div class="file-meta">' + escapeHtmlClient(group.directory) + '</div></div>' +
        renderFileMinimap({ ...group, locations: visibleLocations }) +
        '<div class="badge">' + visibleLocations.length + '</div>';
      header.onclick = () => { group.collapsed = !group.collapsed; render(); };
      header.querySelectorAll('.file-minimap-dot').forEach(dot => {
        dot.onclick = event => {
          event.stopPropagation();
          const location = locationById.get(dot.dataset.locationId);
          if (location) openLocation(location, null);
        };
        dot.onmouseenter = event => event.stopPropagation();
      });
      section.appendChild(header);

      const locationContainer = document.createElement('div');
      locationContainer.className = 'locations';
      visibleLocations.forEach(location => {
        const currentFlatIndex = flatIndex++;
        const row = document.createElement('div');
        row.className = 'location' + (currentFlatIndex === selected ? ' selected' : '');
        row.innerHTML = '<div class="line">' + (location.line + 1) + '</div>' +
          '<div class="preview">' + renderCodeContext(location, location.line, location.character) + '</div>' +
          '<div class="time">' + timeAgo(location.timestamp) + (location.visitCount > 1 ? ' · ' + location.visitCount + '×' : '') + '</div>';
        bindRow(row, currentFlatIndex, location, null);
        locationContainer.appendChild(row);
      });
      section.appendChild(locationContainer);
      root.appendChild(section);
    });
  }

  function renderFileMinimap(group) {
    const fileLineCount = Math.max(
      1,
      ...group.locations.map(location => Number(location.lineCount) || (location.endLine + 1) || (location.line + 1))
    );
    const latestTimestamp = Math.max(...group.locations.map(location => location.timestamp || 0));
    const dots = group.locations.map(location => {
      const ratio = fileLineCount <= 1 ? 0.5 : location.line / (fileLineCount - 1);
      const top = 4 + Math.max(0, Math.min(1, ratio)) * 40;
      const classes = [
        'file-minimap-dot',
        location.timestamp === latestTimestamp ? 'latest' : '',
        (location.visitCount || 1) >= 3 ? 'hot' : ''
      ].filter(Boolean).join(' ');
      const title = 'Line ' + (location.line + 1) +
        (location.visitCount > 1 ? ' · ' + location.visitCount + ' visits' : '') +
        ' · click to open';
      return '<span class="' + classes + '" data-location-id="' + escapeHtmlClient(location.id) +
        '" style="top:' + top.toFixed(1) + 'px" title="' + escapeHtmlClient(title) + '"></span>';
    }).join('');

    const visitedLines = group.locations.map(location => location.line);
    const minLine = Math.min(...visitedLines);
    const maxLine = Math.max(...visitedLines);
    const rangeTop = 4 + (fileLineCount <= 1 ? 0.5 : minLine / (fileLineCount - 1)) * 40;
    const rangeBottom = 4 + (fileLineCount <= 1 ? 0.5 : maxLine / (fileLineCount - 1)) * 40;
    const rangeHeight = Math.max(3, rangeBottom - rangeTop);

    return '<div class="file-minimap" title="Recent locations across ' + fileLineCount + ' lines">' +
      '<span class="file-minimap-track"></span>' +
      '<span class="file-minimap-range" style="top:' + rangeTop.toFixed(1) + 'px;height:' + rangeHeight.toFixed(1) + 'px"></span>' +
      dots + '</div>';
  }

  function renderJourney(root) {
    if (!flat.length) {
      root.innerHTML = '<div class="empty">No journey events yet.</div>';
      return;
    }

    const journey = document.createElement('div');
    journey.className = 'journey';
    flat.forEach((item, index) => {
      const { visit, location } = item;
      const newerVisit = index > 0 ? flat[index - 1].visit : null;
      const currentVisit = flat[0].visit;
      const transition = describeTransitionFromCurrent(currentVisit, visit, index);
      const transitionType = getTransitionTypeFromCurrent(currentVisit, visit, index);
      const elapsed = newerVisit ? formatElapsed(newerVisit.timestamp - visit.timestamp) + ' before newer visit' : 'current accepted location';
      const row = document.createElement('div');
      row.className = 'journey-row transition-' + transitionType + (index === selected ? ' selected' : '') + (index === 0 ? ' latest' : '');
      const gutter = getGutterInfo(transitionType, transition);
      row.innerHTML =
        '<div class="journey-gutter"><span class="sequence-dot">' + visit.sequence + '</span>' +
        '<span class="gutter-state"><span class="gutter-icon">' + gutter.icon + '</span><span class="gutter-label">' + escapeHtmlClient(gutter.label) + '</span></span></div>' +
        '<div class="journey-file"><div class="journey-file-name">' + escapeHtmlClient(location.fileName) + '</div>' +
        '<div class="journey-file-meta">' + escapeHtmlClient(location.directory) + '</div></div>' +
        '<div class="journey-code"><div class="journey-line">Line ' + (visit.line + 1) + ', column ' + (visit.character + 1) + '</div>' +
        renderCodeContext(location, visit.line, visit.character) + '</div>' +
        '<div class="journey-time"><div class="time">' + timeAgo(visit.timestamp) + '</div><div class="elapsed">' + elapsed + '</div></div>';
      bindRow(row, index, location, visit);
      journey.appendChild(row);
    });
    root.appendChild(journey);
  }


  function getGutterInfo(transitionType) {
    if (transitionType === 'current') return { icon: '●', label: 'Current' };
    if (transitionType === 'same-file') return { icon: '↓', label: 'Same file' };
    return { icon: '↗', label: 'File switch' };
  }

  function getTransitionTypeFromCurrent(currentVisit, visit, index) {
    if (index === 0) return 'current';
    return currentVisit.uri === visit.uri ? 'same-file' : 'file-switch';
  }

  function describeTransitionFromCurrent(currentVisit, visit, index) {
    if (index === 0) return 'current location';
    return currentVisit.uri === visit.uri ? 'same file' : 'switched file';
  }

  function bindRow(row, index, location, visit) {
    row.onmouseenter = () => {
      selected = index;
      document.querySelectorAll('.location, .journey-row').forEach((node, nodeIndex) => node.classList.toggle('selected', nodeIndex === selected));
    };
    row.onclick = () => openLocation(location, visit);
  }

  function openLocation(location, visit) {
    vscode.postMessage({
      command: 'open',
      fullUri: location.uri,
      line: visit ? visit.line : location.line,
      character: visit ? visit.character : (location.character || 0)
    });
  }

  function move(delta) {
    rebuildFlat();
    selected = Math.max(0, Math.min(selected + delta, flat.length - 1));
    render();
    document.querySelectorAll('.location, .journey-row')[selected]?.scrollIntoView({ block: 'nearest' });
  }

  function formatElapsed(milliseconds) {
    const seconds = Math.max(0, Math.round(milliseconds / 1000));
    if (seconds < 60) return seconds + 's after previous';
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return minutes + 'm' + (remainder ? ' ' + remainder + 's' : '') + ' after previous';
  }

  function timeAgo(timestamp) {
    const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
    if (seconds < 5) return 'now';
    if (seconds < 60) return seconds + 's';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + 'm';
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? hours + 'h' : Math.floor(hours / 24) + 'd';
  }

  function renderCodeContext(location, targetLine, targetCharacter) {
    const lines = Array.isArray(location.previewLines) ? location.previewLines : [];
    if (!lines.length) {
      return '<div class="code-context"><div class="code-preview-line target"><span class="code-line-number">' +
        (targetLine + 1) + '</span><span class="code-line-text"></span></div></div>';
    }

    const rendered = lines.map((text, index) => {
      const actualLine = location.startLine + index;
      const isTarget = actualLine === targetLine;
      const targetClass = isTarget ? ' target' : '';
      let displayed;
      if (isTarget) {
        const safeCharacter = Math.max(0, Math.min(Number(targetCharacter) || 0, text.length));
        const beforeCursor = text.slice(0, safeCharacter);
        const cursorCharacter = safeCharacter < text.length ? text[safeCharacter] : ' ';
        const afterCursor = safeCharacter < text.length ? text.slice(safeCharacter + 1) : '';
        const renderedCursorCharacter = /\s/.test(cursorCharacter) ? '&nbsp;' : escapeHtmlClient(cursorCharacter);
        displayed = highlightCode(beforeCursor, location.fileName) +
          '<span class="cursor-block" title="Last cursor position: column ' + (safeCharacter + 1) + '" aria-label="Last cursor position at column ' + (safeCharacter + 1) + '">' + renderedCursorCharacter + '</span>' +
          highlightCode(afterCursor, location.fileName);
      } else {
        displayed = text.length ? highlightCode(text, location.fileName) : '';
      }
      return '<div class="code-preview-line' + targetClass + '">' +
        '<span class="code-line-number">' + (actualLine + 1) + '</span>' +
        '<span class="code-line-text">' + displayed + '</span></div>';
    }).join('');

    return '<div class="code-context">' + rendered + '</div>';
  }

  function highlightCode(value, fileName) {
    const code = String(value);
    const extension = String(fileName || '').split('.').pop().toLowerCase();
    const javaLike = new Set(['java', 'js', 'jsx', 'ts', 'tsx', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'kt', 'kts', 'gradle']);
    const pythonLike = new Set(['py']);
    const keywords = pythonLike.has(extension)
      ? new Set(['and','as','assert','async','await','break','class','continue','def','del','elif','else','except','False','finally','for','from','global','if','import','in','is','lambda','None','nonlocal','not','or','pass','raise','return','True','try','while','with','yield'])
      : new Set(['abstract','assert','async','await','boolean','break','byte','case','catch','char','class','const','continue','default','delete','do','double','else','enum','export','extends','false','final','finally','float','for','from','function','if','implements','import','in','instanceof','int','interface','let','long','native','new','null','package','private','protected','public','record','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','true','try','typeof','var','void','volatile','while','with','yield']);
    if (!javaLike.has(extension) && !pythonLike.has(extension)) return escapeHtmlClient(code);

    let html = '';
    let index = 0;
    const append = (text, cls) => {
      const escaped = escapeHtmlClient(text);
      html += cls ? '<span class="' + cls + '">' + escaped + '</span>' : escaped;
    };

    while (index < code.length) {
      const ch = code[index];
      const next = code[index + 1];

      if ((ch === '/' && next === '/') || (pythonLike.has(extension) && ch === '#')) {
        append(code.slice(index), 'tok-comment');
        break;
      }

      if (ch === '"' || ch === "'") {
        const quote = ch;
        let end = index + 1;
        while (end < code.length) {
          if (code[end] === '\\') { end += 2; continue; }
          if (code[end] === quote) { end++; break; }
          end++;
        }
        append(code.slice(index, end), 'tok-string');
        index = end;
        continue;
      }

      if (/\d/.test(ch)) {
        let end = index + 1;
        while (end < code.length && /[\w.xX_]/.test(code[end])) end++;
        append(code.slice(index, end), 'tok-number');
        index = end;
        continue;
      }

      if (/[A-Za-z_$]/.test(ch)) {
        let end = index + 1;
        while (end < code.length && /[A-Za-z0-9_$]/.test(code[end])) end++;
        const word = code.slice(index, end);
        let cursor = end;
        while (cursor < code.length && /\s/.test(code[cursor])) cursor++;
        const previous = code.slice(0, index).trimEnd();
        const isType = /^[A-Z]/.test(word);
        const isFunction = code[cursor] === '(' && !keywords.has(word) && !/\b(new|class|interface|record)\s*$/.test(previous);
        append(word, keywords.has(word) ? 'tok-keyword' : isFunction ? 'tok-function' : isType ? 'tok-type' : '');
        index = end;
        continue;
      }

      if (/[=+\-*\/%!<>?:&|.^~]/.test(ch)) append(ch, 'tok-operator');
      else append(ch, '');
      index++;
    }
    return html;
  }

  function escapeHtmlClient(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  const searchWrap = document.getElementById('search-wrap');
  const searchInput = document.getElementById('search-input');
  function openSearch() {
    searchWrap.classList.add('visible');
    searchInput.focus();
    searchInput.select();
  }
  function closeSearch(clear) {
    searchWrap.classList.remove('visible');
    if (clear) { query = ''; searchInput.value = ''; render(); }
    document.getElementById('results').focus();
  }
  searchInput.addEventListener('input', () => { query = searchInput.value.trim().toLowerCase(); selected = 0; render(); });
  searchInput.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSearch(true); }
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); closeSearch(false); }
  });
  document.getElementById('grouped-button').onclick = () => setMode('grouped');
  document.getElementById('journey-button').onclick = () => setMode('journey');
  document.getElementById('clear-all-button').onclick = () => vscode.postMessage({ command: 'clearAll' });
  document.addEventListener('keydown', event => {
    if (event.target === searchInput) return;
    if (event.key === '/') { event.preventDefault(); openSearch(); return; }
    if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    if (event.key === 'v' || event.key === 'V' || event.key === 'Tab') {
      event.preventDefault();
      setMode(mode === 'grouped' ? 'journey' : 'grouped');
      return;
    }
    if (event.key === '1' || event.key === 'g' || event.key === 'G') { event.preventDefault(); setMode('grouped'); return; }
    if (event.key === '2' || event.key === 'J') { event.preventDefault(); setMode('journey'); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      const item = flat[selected];
      if (item) openLocation(item.location, item.visit || null);
    }
    if (event.key === 'Escape' || event.key === ';') { event.preventDefault(); vscode.postMessage({ command: 'close' }); }
  });

  window.onload = () => { document.getElementById('results').focus(); render(); };
</script>
</body>
</html>`;
}
function groupByEditor(list) {
  const groups = new Map();
  for (const location of list) {
    if (!groups.has(location.uri)) {
      groups.set(location.uri, {
        uri: location.uri,
        fileName: location.fileName || path.basename(location.file),
        directory: location.directory && location.directory !== '.' ? location.directory : location.relativeFile,
        latest: location.timestamp,
        collapsed: false,
        locations: []
      });
    }
    const group = groups.get(location.uri);
    group.latest = Math.max(group.latest, location.timestamp);
    group.locations.push(location);
  }
  return [...groups.values()]
    .map(group => ({ ...group, locations: group.locations.sort((a, b) => b.timestamp - a.timestamp) }))
    .sort((a, b) => b.latest - a.latest);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function deactivate() {
  if (cursorTimer) clearInterval(cursorTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
}

module.exports = { activate, deactivate };
