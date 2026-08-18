'use strict';

const vscode = require('vscode');

const HISTORY_KEY = 'recentBuffers.history.v2';
let activePanel;
let searchRequestId = 0;
const fileSearchCache = new Map();
let fileSearchGeneration = 0;
let disposed = false;

function activate(context) {
  const history = new HistoryStore(context);

  const captureEditor = (editor) => {
    if (!editor || !isNavigableDocument(editor.document)) return;
    history.touch(editor.document.uri, editor.selection);
  };

  captureEditor(vscode.window.activeTextEditor);

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(captureEditor),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.textEditor !== vscode.window.activeTextEditor || !isNavigableDocument(e.textEditor.document)) return;
      history.touch(e.textEditor.document.uri, e.selections[0]);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(invalidateFileCaches),
    vscode.workspace.onDidCreateFiles(invalidateFileCaches),
    vscode.workspace.onDidDeleteFiles(invalidateFileCaches),
    vscode.workspace.onDidRenameFiles(invalidateFileCaches),
    vscode.commands.registerCommand('recentBuffers.show', () => showRecentBuffers(context, history)),
    vscode.commands.registerCommand('recentBuffers.previousBuffer', () => openPreviousBuffer(history)),
    vscode.commands.registerCommand('recentBuffers.moveDown', () => {
      if (activePanel) activePanel.webview.postMessage({ type: 'moveSelection', delta: 1 });
    }),
    vscode.commands.registerCommand('recentBuffers.moveUp', () => {
      if (activePanel) activePanel.webview.postMessage({ type: 'moveSelection', delta: -1 });
    }),
    vscode.commands.registerCommand('recentBuffers.applySingleViewportSettings', applySingleViewportSettings),
    vscode.commands.registerCommand('recentBuffers.clearHistory', async () => {
      await history.clear();
      if (activePanel) await sendState(activePanel, history, '');
      vscode.window.setStatusBarMessage('Recent Buffers history cleared.', 2500);
    }),
    { dispose: () => { disposed = true; closePanel(); } }
  );
}

function deactivate() {
  disposed = true;
  closePanel();
}

function isNavigableDocument(document) {
  return document.uri.scheme === 'file' || document.uri.scheme === 'vscode-remote';
}

class HistoryStore {
  constructor(context) {
    this.context = context;
    this.entries = new Map();
    const saved = context.workspaceState.get(HISTORY_KEY, context.workspaceState.get('recentBuffers.history.v1', []));
    for (const item of saved || []) if (item?.uri) this.entries.set(item.uri, item);
    this.persistTimer = undefined;
  }

  touch(uri, selection) {
    const key = uri.toString();
    const now = Date.now();
    const previous = this.entries.get(key);
    const entry = {
      uri: key,
      lastVisited: now,
      visitCount: (previous?.visitCount || 0) + (previous?.lastVisited && now - previous.lastVisited < 750 ? 0 : 1),
      selection: selection ? serializeSelection(selection) : previous?.selection
    };
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.trim();
    this.schedulePersist();
  }

  get(uri) { return this.entries.get(uri.toString()); }
  list() { return [...this.entries.values()].sort((a, b) => b.lastVisited - a.lastVisited); }

  async remove(uriString) {
    this.entries.delete(uriString);
    await this.persist();
  }

  async clear() {
    this.entries.clear();
    await this.persist();
  }

  trim() {
    const max = vscode.workspace.getConfiguration('recentBuffers').get('maxHistory', 1000);
    if (this.entries.size <= max) return;
    const sorted = this.list();
    this.entries.clear();
    for (const item of sorted.slice(0, max)) this.entries.set(item.uri, item);
  }

  schedulePersist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), 300);
  }

  async persist() {
    clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.context.workspaceState.update(HISTORY_KEY, this.list());
  }
}

function serializeSelection(selection) {
  return {
    anchor: { line: selection.anchor.line, character: selection.anchor.character },
    active: { line: selection.active.line, character: selection.active.character }
  };
}

function deserializeSelection(value) {
  if (!value?.anchor || !value?.active) return undefined;
  return new vscode.Selection(value.anchor.line, value.anchor.character, value.active.line, value.active.character);
}

async function showRecentBuffers(context, history) {
  if (activePanel) {
    activePanel.reveal(activePanel.viewColumn, true);
    activePanel.webview.postMessage({ type: 'focusSearch' });
    return;
  }

  const sourceEditor = vscode.window.activeTextEditor;
  const sourceColumn = sourceEditor?.viewColumn || vscode.ViewColumn.Active;
  const sourceUri = sourceEditor?.document.uri.toString();
  const panel = vscode.window.createWebviewPanel(
    'recentBuffers.navigator',
    'Recent Buffers',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel = panel;
  await vscode.commands.executeCommand('setContext', 'recentBuffers.active', true);
  panel.webview.html = getWebviewHtml(panel.webview);
  // Match the opening pattern used by Recent Code Locations. In the user's
  // editor setup this is handled by the modal-editor presentation rather than
  // being left as a normal editor tab.
  panel.reveal(vscode.ViewColumn.Active, false);

  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = undefined;
      void vscode.commands.executeCommand('setContext', 'recentBuffers.active', false);
    }
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (panel !== activePanel || disposed) return;
    switch (message?.type) {
      case 'ready':
        panel.webview.postMessage({ type: 'focusSearch' });
        await sendState(panel, history, '', ++searchRequestId, sourceUri);
        panel.webview.postMessage({ type: 'focusSearch' });
        setTimeout(() => {
          if (activePanel === panel) panel.webview.postMessage({ type: 'focusSearch' });
        }, 25);
        setTimeout(() => {
          if (activePanel === panel) panel.webview.postMessage({ type: 'focusSearch' });
        }, 75);
        break;
      case 'search':
        await sendState(panel, history, String(message.query || ''), undefined, sourceUri);
        break;
      case 'open':
        if (message.uri) {
          const uri = vscode.Uri.parse(message.uri);
          panel.dispose();
          await openBuffer(uri, history, sourceColumn);
        }
        break;
      case 'forget':
        if (message.uri) {
          await history.remove(message.uri);
          await sendState(panel, history, String(message.query || ''), undefined, sourceUri);
        }
        break;
      case 'close':
        panel.dispose();
        break;
    }
  });
}

async function sendState(panel, history, query, requestId = ++searchRequestId, sourceUri) {
  if (!panel || panel !== activePanel) return;
  const q = query.trim();
  const generation = ++fileSearchGeneration;
  const recentRows = buildRecentRows(history, q, sourceUri).map(row => ({ ...row, section: 'recent' }));
  let fileRows = [];
  let searchedAllFiles = false;
  const minChars = vscode.workspace.getConfiguration('recentBuffers').get('fileSearchMinChars', 2);

  if (q.length >= minChars) {
    searchedAllFiles = true;
    const files = await searchFiles(q);
    if (!activePanel || panel !== activePanel || generation !== fileSearchGeneration) return;
    const recentUris = new Set(recentRows.map(row => row.uri));
    fileRows = buildFileRows(files, q, history)
      .filter(row => !recentUris.has(row.uri))
      .map(row => ({ ...row, section: 'files' }));
  }

  if (!activePanel || panel !== activePanel) return;
  if (requestId !== searchRequestId) return;
  panel.webview.postMessage({
    type: 'state',
    query,
    requestId,
    rows: [...recentRows, ...fileRows],
    recentMatchCount: recentRows.length,
    fileMatchCount: fileRows.length,
    searchedAllFiles,
    fileSearchMinChars: minChars
  });
}

function buildRecentRows(history, query, sourceUri) {
  const currentUri = sourceUri || vscode.window.activeTextEditor?.document.uri.toString();
  const now = Date.now();
  const scored = [];
  for (const entry of history.list()) {
    if (entry.uri === currentUri) continue;
    const uri = vscode.Uri.parse(entry.uri);
    const label = basename(uri.path);
    const path = relativeDisplayPath(uri);
    const score = query ? fuzzyScore(query, `${label} ${path}`) : 1;
    if (score < 0) continue;
    scored.push({ entry, uri, label, path, score });
  }
  if (query) scored.sort((a, b) => b.score - a.score || b.entry.lastVisited - a.entry.lastVisited);
  return scored.slice(0, 250).map(({ entry, uri, label, path }) => ({
    uri: uri.toString(),
    label,
    path,
    location: formatLocation(entry.selection),
    age: formatAge(now - entry.lastVisited),
    visits: entry.visitCount || 1,
    kind: fileKind(label),
    recent: true
  }));
}

function buildFileRows(files, query, history) {
  const currentUri = vscode.window.activeTextEditor?.document.uri.toString();
  const scored = [];
  for (const uri of files) {
    if (uri.toString() === currentUri) continue;
    const label = basename(uri.path);
    const path = relativeDisplayPath(uri);
    const score = query ? fuzzyScore(query, `${label} ${path}`) : 0;
    if (query && score < 0) continue;
    const recent = history.get(uri);
    scored.push({ uri, label, path, score, recent });
  }
  scored.sort((a, b) => b.score - a.score || (b.recent?.lastVisited || 0) - (a.recent?.lastVisited || 0) || a.label.localeCompare(b.label));
  return scored.slice(0, 350).map(({ uri, label, path, recent }) => ({
    uri: uri.toString(),
    label,
    path,
    location: recent ? formatLocation(recent.selection) : '',
    age: recent ? formatAge(Date.now() - recent.lastVisited) : '',
    visits: recent?.visitCount || 0,
    kind: fileKind(label),
    recent: !!recent
  }));
}

async function openPreviousBuffer(history) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isNavigableDocument(editor.document)) {
    vscode.window.showInformationMessage('Recent Buffers: no active file to switch from.');
    return;
  }

  const currentUri = editor.document.uri.toString();
  // Capture the exact location being left so repeated use becomes a true
  // two-file toggle: A -> B -> A -> B.
  history.touch(editor.document.uri, editor.selection);

  const previous = history.list().find(entry => entry.uri !== currentUri);
  if (!previous) {
    vscode.window.showInformationMessage('Recent Buffers: no previous buffer yet.');
    return;
  }

  await openBuffer(vscode.Uri.parse(previous.uri), history, editor.viewColumn || vscode.ViewColumn.Active);
}

async function openBuffer(uri, history, viewColumn) {
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    const entry = history.get(uri);
    const restore = vscode.workspace.getConfiguration('recentBuffers').get('restoreSelection', true);
    let selection = restore ? deserializeSelection(entry?.selection) : undefined;
    if (selection) selection = clampSelection(selection, document);
    const editor = await vscode.window.showTextDocument(document, {
      viewColumn: viewColumn || vscode.ViewColumn.Active,
      preserveFocus: false,
      preview: false,
      selection
    });
    if (selection) {
      editor.selection = selection;
      editor.revealRange(new vscode.Range(selection.active, selection.active), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    history.touch(uri, editor.selection);
  } catch (error) {
    vscode.window.showErrorMessage(`Recent Buffers could not open ${uri.fsPath || uri.toString()}: ${error.message || error}`);
  }
}

function clampSelection(selection, document) {
  const clamp = (p) => {
    const line = Math.max(0, Math.min(p.line, Math.max(0, document.lineCount - 1)));
    const maxChar = document.lineAt(line).text.length;
    return new vscode.Position(line, Math.max(0, Math.min(p.character, maxChar)));
  };
  return new vscode.Selection(clamp(selection.anchor), clamp(selection.active));
}

async function searchFiles(query) {
  const normalized = query.trim();
  if (!normalized) return [];
  const key = normalized.toLowerCase();
  const cached = fileSearchCache.get(key);
  if (cached) return cached;

  const config = vscode.workspace.getConfiguration('recentBuffers');
  const resultLimit = config.get('fileSearchResultLimit', 200);
  const exclude = config.get('exclude');

  // VS Code's findFiles is glob-based, while Recent Buffers uses our fuzzy
  // score over "filename + path". A strict glob can therefore discard files
  // that the fuzzy matcher would accept (for example filename text followed
  // by workspace/path text). Discover a bounded candidate pool
  // progressively, then let buildFileRows apply the exact same fuzzyScore.
  const candidateLimit = Math.max(resultLimit * 3, 400);
  const probes = buildCandidateQueries(normalized);
  const seen = new Map();

  for (const probe of probes) {
    const remaining = candidateLimit - seen.size;
    if (remaining <= 0) break;
    const found = await vscode.workspace.findFiles(buildSearchGlob(probe), exclude, remaining);
    for (const uri of found) {
      seen.set(uri.toString(), uri);
      if (seen.size >= candidateLimit) break;
    }

    // Once the exact/long probe gives us a useful candidate set, don't keep
    // broadening unless it is sparse. This keeps large workspaces cheap.
    if (seen.size >= Math.min(resultLimit, 80)) break;
  }

  const files = [...seen.values()];
  fileSearchCache.set(key, files);
  while (fileSearchCache.size > 50) {
    fileSearchCache.delete(fileSearchCache.keys().next().value);
  }
  return files;
}

function buildCandidateQueries(query) {
  const compact = [...query].filter(ch => !/\s/.test(ch)).join('');
  if (!compact) return [];

  const probes = [compact];

  // Progressively remove trailing context. This lets a query such as
  // "build.gradleian" discover build.gradle candidates first; fuzzyScore then
  // checks the complete query against "build.gradle ians/build.gradle".
  const lengths = [
    Math.floor(compact.length * 0.80),
    Math.floor(compact.length * 0.65),
    Math.floor(compact.length * 0.50)
  ];

  // If a recognizable filename extension is present, keep the filename-sized
  // prefix as an especially useful discovery probe.
  const extensionMatch = compact.match(/^(.+?\.(?:java|gradle|kts|json|ya?ml|xml|md|js|ts|properties))/i);
  if (extensionMatch) probes.push(extensionMatch[1]);

  for (const len of lengths) {
    if (len >= 2) probes.push(compact.slice(0, len));
  }

  // Preserve order while removing duplicates.
  return [...new Set(probes)];
}

function buildSearchGlob(query) {
  const chars = [...query].filter(ch => !/\s/.test(ch));
  const pieces = chars.map(ch => {
    if (/[a-z]/i.test(ch)) {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper ? escapeGlobChar(ch) : `[${lower}${upper}]`;
    }
    return escapeGlobChar(ch);
  });
  return `**/*${pieces.join('*')}*`;
}

function escapeGlobChar(ch) {
  if (ch === '[') return '[[]';
  if (ch === ']') return '[]]';
  if ('*?{}!'.includes(ch)) return `\\${ch}`;
  return ch;
}

function invalidateFileCaches() {
  fileSearchCache.clear();
  fileSearchGeneration += 1;
}

function fuzzyScore(query, candidate) {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  if (!q) return 0;
  const direct = c.indexOf(q);
  if (direct >= 0) return 10000 - direct * 3 - (c.length - q.length) * 0.01;
  let qi = 0, score = 0, streak = 0, first = -1;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c[i] !== q[qi]) { streak = 0; continue; }
    if (first < 0) first = i;
    streak += 1;
    score += 12 + streak * 6;
    if (i === 0 || '/\\_- .'.includes(c[i - 1])) score += 20;
    qi += 1;
  }
  if (qi !== q.length) return -1;
  return score - first * 0.5 - (c.length - q.length) * 0.02;
}

function relativeDisplayPath(uri) {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return uri.fsPath || uri.path;
  const rel = vscode.workspace.asRelativePath(uri, false);
  return (vscode.workspace.workspaceFolders?.length || 0) > 1 ? `${folder.name}/${rel}` : rel;
}

function basename(path) {
  const normalized = path.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized;
}

function formatAge(ms) {
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))} sec ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} hr ago`;
  return `${Math.floor(ms / 86_400_000)} d ago`;
}

function formatLocation(selection) {
  if (!selection?.active) return '';
  return `${selection.active.line + 1}:${selection.active.character + 1}`;
}

function fileKind(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.java')) return 'java';
  if (lower.endsWith('.gradle') || lower.endsWith('.gradle.kts')) return 'gradle';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) return 'yaml';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.xml')) return 'xml';
  if (lower.endsWith('.js') || lower.endsWith('.ts')) return 'script';
  return 'file';
}

async function applySingleViewportSettings() {
  const config = vscode.workspace.getConfiguration('workbench.editor');
  const target = vscode.ConfigurationTarget.Global;
  await config.update('showTabs', 'none', target);
  await config.update('enablePreview', false, target);
  await vscode.commands.executeCommand('workbench.action.closeEditorsInOtherGroups').then(undefined, () => {});
  vscode.window.showInformationMessage('Recent Buffers: tabs are hidden and preview editors are disabled.');
}

function closePanel() {
  if (activePanel) activePanel.dispose();
  activePanel = undefined;
}

function getWebviewHtml(webview) {
  const nonce = String(Date.now());
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Recent Buffers</title>
<style>
  * { box-sizing: border-box; }
  html, body { height:100%; margin:0; }
  body { font-family: var(--vscode-font-family); font-size:var(--vscode-font-size,13px); color: var(--vscode-foreground); background: var(--vscode-editor-background); overflow:hidden; }
  .stage { height:100%; width:100%; display:flex; padding:0; background:var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); }
  .shell { width:100%; height:100%; max-height:none; display:flex; flex-direction:column; background:var(--vscode-quickInput-background, var(--vscode-editorWidget-background)); border:0; border-radius:0; overflow:hidden; box-shadow:none; }
  .header { padding:12px 16px 8px; border-bottom:1px solid var(--vscode-widget-border, #ffffff18); }
  .titleRow { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
  .title { font-size:18px; font-weight:650; letter-spacing:.1px; }
  .close { border:0; background:transparent; color:var(--vscode-foreground); opacity:.72; font-size:22px; line-height:1; cursor:pointer; padding:2px 6px; border-radius:4px; }
  .close:hover { background:var(--vscode-toolbar-hoverBackground); opacity:1; }
  .searchWrap { position:relative; }
  .search { width:100%; height:40px; padding:0 96px 0 13px; font-family:var(--vscode-font-family); font-size:14px; line-height:1.4; color:var(--vscode-input-foreground); background:var(--vscode-input-background); border:1px solid var(--vscode-focusBorder); outline:none; border-radius:5px; }
  .shortcut { position:absolute; right:8px; top:6px; color:var(--vscode-descriptionForeground); border:1px solid var(--vscode-widget-border, #ffffff24); border-radius:5px; padding:3px 8px; font-size:12px; background:var(--vscode-keybindingLabel-background, #ffffff0b); }
  .tabs { display:flex; gap:26px; padding:0 18px; border-bottom:1px solid var(--vscode-widget-border, #ffffff18); }
  .tab { appearance:none; border:0; border-bottom:2px solid transparent; background:transparent; color:var(--vscode-descriptionForeground); padding:12px 4px 10px; font:inherit; font-size:14px; cursor:pointer; }
  .tab.active { color:var(--vscode-foreground); border-bottom-color:var(--vscode-focusBorder); }
  .tab .ico { margin-right:7px; }
  .notice { display:none; padding:8px 18px; font-size:12px; color:var(--vscode-descriptionForeground); border-bottom:1px solid var(--vscode-widget-border, #ffffff12); }
  .notice.show { display:block; }
  .content { min-height:0; flex:1 1 auto; overflow:hidden; padding:4px 0; display:flex; flex-direction:row; }
  .resultSection { min-width:0; min-height:0; display:flex; flex-direction:column; }
  .resultSection.recentOnly { flex:1 1 50%; min-width:0; }
  .resultSection.recentWithFiles { flex:1 1 50%; min-width:0; }
  .resultSection.filesSection { flex:1 1 50%; min-width:0; border-left:1px solid var(--vscode-widget-border, #ffffff18); }
  .sectionHeader { flex:0 0 auto; display:flex; align-items:center; justify-content:space-between; padding:5px 12px 6px; color:var(--vscode-descriptionForeground); font-size:12px; font-weight:650; letter-spacing:.5px; text-transform:uppercase; }
  .sectionRows { min-height:0; overflow:auto; padding-bottom:3px; scrollbar-gutter:stable; }
  .resultSection .row { grid-template-columns:minmax(190px, 275px) minmax(95px, 1fr) 48px 52px 46px 18px; gap:5px; margin:0 4px; padding-left:10px; padding-right:6px; }
  @media (max-width:1150px) {
    .resultSection .row { grid-template-columns:minmax(180px,1.35fr) minmax(90px,.85fr) 48px 18px; }
    .resultSection .age, .resultSection .visits { display:none; }
  }
  .row { position:relative; display:grid; grid-template-columns:minmax(220px, 280px) minmax(260px, 1fr) 76px 88px 78px 28px; align-items:center; gap:10px; min-height:42px; padding:2px 10px 2px 14px; margin:0 8px; border-radius:5px; cursor:pointer; }
  .row:hover { background:var(--vscode-list-hoverBackground); }
  .row.active { background:color-mix(in srgb, var(--vscode-list-activeSelectionBackground) 74%, transparent); color:var(--vscode-list-activeSelectionForeground); }
  .row::before { content:''; position:absolute; left:0; top:5px; bottom:5px; width:3px; border-radius:2px; background:transparent; }
  .row.active::before { background:var(--vscode-focusBorder, var(--vscode-list-activeSelectionForeground)); }
  .name { display:flex; align-items:center; gap:8px; min-width:0; font-size:13px; line-height:1.35; font-weight:600; color:var(--vscode-foreground); }
  .row.active .name { color:var(--vscode-list-activeSelectionForeground); }
  .fileIcon { width:16px; text-align:center; font-weight:700; flex:0 0 16px; }
  .java { color:#e76f51; } .gradle { color:#72b7b2; } .json { color:#e5c07b; } .yaml { color:#61afef; } .markdown { color:#61afef; } .script { color:#e5c07b; } .xml { color:#d19a66; } .file { color:var(--vscode-descriptionForeground); }
  .filename, .path { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .filename { min-width:0; }
  .path { color:var(--vscode-descriptionForeground); font-size:11.5px; line-height:1.35; direction:rtl; text-align:left; unicode-bidi:plaintext; }
  .pathInner { direction:ltr; unicode-bidi:plaintext; }
  .meta { color:var(--vscode-descriptionForeground); font-size:11px; }
  .position { font-family:var(--vscode-editor-font-family, monospace); font-size:11px; color:var(--vscode-foreground); opacity:.9; }
  .row.active .path, .row.active .meta { color:color-mix(in srgb, var(--vscode-list-activeSelectionForeground) 72%, transparent); }
  .location::before { content:'⌖ '; opacity:.8; }
  .forget { opacity:0; border:0; background:transparent; color:inherit; cursor:pointer; border-radius:4px; font-size:16px; padding:4px; }
  .row:hover .forget, .row.active .forget { opacity:.68; }
  .forget:hover { opacity:1 !important; background:#ffffff16; }
  .empty { padding:24px 16px 30px; text-align:center; color:var(--vscode-descriptionForeground); }
  .compactEmpty { opacity:.9; }
  .empty strong { display:block; color:var(--vscode-foreground); margin-bottom:7px; font-size:14px; }
  .footer { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 12px 8px; border-top:1px solid var(--vscode-widget-border, #ffffff18); color:var(--vscode-descriptionForeground); font-size:12px; }
  .keys { display:flex; flex-wrap:wrap; gap:12px; }
  kbd { font:inherit; color:var(--vscode-foreground); background:var(--vscode-keybindingLabel-background, #ffffff0d); border:1px solid var(--vscode-keybindingLabel-border, #ffffff22); border-bottom-color:var(--vscode-keybindingLabel-bottomBorder, #ffffff35); border-radius:4px; padding:2px 6px; margin-right:5px; }
  @media (max-width:850px) { .row { grid-template-columns:minmax(190px,1fr) minmax(160px,1.2fr) 82px 28px; } .age,.visits { display:none; } }
</style>
</head>
<body>
<div class="stage">
  <main class="shell">
    <div class="header">
      <div class="titleRow"><div class="title">Recent Buffers</div><button class="close" id="close" title="Close">×</button></div>
      <div class="searchWrap"><input id="search" class="search" autocomplete="off" spellcheck="false" autofocus placeholder="Search recent buffers and files..."><span class="shortcut">Ctrl+E</span></div>
    </div>
    <div class="notice" id="notice"></div>
    <section class="content" id="content"></section>
    <footer class="footer"><div class="keys"><span><kbd>Tab</kbd>jump to All Files</span><span><kbd>Ctrl+J / Ctrl+K</kbd>move</span><span><kbd>Enter</kbd>open</span><span><kbd>Esc</kbd>cancel</span></div><div>Recent first · files search after 2 characters</div></footer>
  </main>
</div>
<script nonce="${nonce}">
(() => {
  const vscode = acquireVsCodeApi();
  const search = document.getElementById('search');
  const content = document.getElementById('content');
  const notice = document.getElementById('notice');
  let latestRequestId = 0;
  let state = { query:'', rows:[], recentMatchCount:0, fileMatchCount:0, searchedAllFiles:false, fileSearchMinChars:2 };
  let selected = 0;
  let timer;

  const iconFor = kind => ({java:'☕',gradle:'↝',json:'{}',yaml:'◇',markdown:'M',script:'JS',xml:'<>',file:'•'}[kind] || '•');
  const escapeHtml = s => String(s ?? '').replace(/[&<>\"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));

  function request() {
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type:'search', query:search.value }), 120);
  }

  function render() {
    notice.className = 'notice';
    notice.textContent = '';
    selected = Math.max(0, Math.min(selected, state.rows.length - 1));

    const query = search.value.trim();
    const recent = [];
    const files = [];
    state.rows.forEach((row, index) => {
      (row.section === 'files' ? files : recent).push({ row, index });
    });

    function renderRow(entry) {
      const r = entry.row;
      const i = entry.index;
      return '<div class="row ' + (i===selected?'active':'') + '" data-index="' + i + '">' +
        '<div class="name"><span class="fileIcon ' + escapeHtml(r.kind) + '">' + escapeHtml(iconFor(r.kind)) + '</span><span class="filename">' + escapeHtml(r.label) + '</span></div>' +
        '<div class="path" title="' + escapeHtml(r.path) + '"><span class="pathInner">' + escapeHtml(r.path) + '</span></div>' +
        '<div class="meta location">' + escapeHtml(r.location || '—') + '</div>' +
        '<div class="meta age">' + escapeHtml(r.age || '') + '</div>' +
        '<div class="meta visits">' + (r.visits ? escapeHtml(r.visits + (r.visits === 1 ? ' visit' : ' visits')) : '') + '</div>' +
        '<button class="forget" title="Forget from history" data-forget="' + i + '">' + (r.recent ? '×' : '') + '</button>' +
      '</div>';
    }

    let recentBody;
    if (recent.length) {
      recentBody = recent.map(renderRow).join('');
    } else {
      const recentHint = query ? 'No recent buffers matched this search.' : 'Open a few files and they will appear here.';
      recentBody = '<div class="empty"><strong>No recent matches</strong>' + escapeHtml(recentHint) + '</div>';
    }

    let filesBody;
    if (files.length) {
      filesBody = files.map(renderRow).join('');
    } else if (!query || query.length < state.fileSearchMinChars) {
      filesBody = '<div class="empty compactEmpty"><strong>All Files</strong>Type at least ' + state.fileSearchMinChars + ' characters to search the workspace.</div>';
    } else {
      filesBody = '<div class="empty compactEmpty"><strong>No additional files</strong>No non-recent workspace files matched this search.</div>';
    }

    content.innerHTML =
      '<div class="resultSection recentWithFiles" data-section="recent">' +
        '<div class="sectionHeader"><span>Recent Buffers</span><span>' + recent.length + ' items</span></div>' +
        '<div class="sectionRows">' + recentBody + '</div>' +
      '</div>' +
      '<div class="resultSection filesSection" data-section="files">' +
        '<div class="sectionHeader"><span>All Files</span><span>' + files.length + ' items</span></div>' +
        '<div class="sectionRows">' + filesBody + '</div>' +
      '</div>';

    const active = content.querySelector('.row.active');
    active?.scrollIntoView({ block:'nearest' });
  }

  function openSelected() {
    const row = state.rows[selected];
    if (row) vscode.postMessage({ type:'open', uri:row.uri });
  }

  search.addEventListener('input', () => { selected = 0; request(); });
  function moveSelection(delta) {
    if (!state.rows.length) return;
    selected = (selected + delta + state.rows.length) % state.rows.length;
    render();
  }

  function jumpToAllFiles() {
    const index = state.rows.findIndex(row => row.section === 'files');
    if (index >= 0) {
      selected = index;
      render();
      const filesPane = content.querySelector('[data-section="files"] .sectionRows');
      if (filesPane) filesPane.scrollTop = 0;
      content.querySelector('[data-section="files"] .row.active')?.scrollIntoView({ block:'nearest' });
    }
  }

  search.addEventListener('keydown', e => {
    const key = e.key.toLowerCase();
    if (e.key === 'Tab') { e.preventDefault(); jumpToAllFiles(); }
    else if ((e.ctrlKey || e.metaKey) && key === 'j') { e.preventDefault(); e.stopPropagation(); moveSelection(1); }
    else if ((e.ctrlKey || e.metaKey) && key === 'k') { e.preventDefault(); e.stopPropagation(); moveSelection(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); openSelected(); }
    else if (e.key === 'Escape') { e.preventDefault(); vscode.postMessage({type:'close'}); }
  });
  document.getElementById('close').addEventListener('click', () => vscode.postMessage({type:'close'}));
  content.addEventListener('mousemove', e => {
    const row = e.target.closest('.row'); if (!row) return; const i=Number(row.dataset.index); if (i!==selected) { selected=i; render(); }
  });
  content.addEventListener('click', e => {
    const forget = e.target.closest('[data-forget]');
    if (forget) { e.stopPropagation(); const row=state.rows[Number(forget.dataset.forget)]; if(row?.recent) vscode.postMessage({type:'forget',uri:row.uri,query:search.value}); return; }
    const row = e.target.closest('.row'); if (row) { selected=Number(row.dataset.index); openSelected(); }
  });

  window.addEventListener('message', e => {
    const m=e.data;
    if (m.type==='state') { state=m;render(); }
    else if (m.type==='focusSearch') {
      claimSearchFocus();
    }
    else if (m.type==='moveSelection') {
      moveSelection(Number(m.delta) < 0 ? -1 : 1);
      search.focus();
    }
  });

  function claimSearchFocus() {
    try {
      search.focus({ preventScroll:true });
      const end = search.value.length;
      search.setSelectionRange(end, end);
    } catch (_) {
      try { search.focus(); } catch (_) {}
    }
  }

  // Do not wait for a timer before the input becomes usable. VS Code can
  // display the panel before the old 20 ms callback ran, which meant very
  // fast typing could still go to the editor behind the webview.
  claimSearchFocus();
  requestAnimationFrame(claimSearchFocus);
  requestAnimationFrame(() => requestAnimationFrame(claimSearchFocus));
  setTimeout(claimSearchFocus, 0);
  setTimeout(claimSearchFocus, 20);
  setTimeout(claimSearchFocus, 60);

  window.addEventListener('focus', claimSearchFocus);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) claimSearchFocus();
  });

  vscode.postMessage({type:'ready'});
})();
</script>
</body>
</html>`;
}

module.exports = { activate, deactivate, _test: { fuzzyScore, formatAge, basename, fileKind } };
