const vscode = require('vscode');
const crypto = require('crypto');

const STORAGE_KEY = 'visualBookmarks.items';
const COLORS = ['blue', 'red', 'yellow', 'green', 'purple', 'orange'];
const SHAPES = ['circle', 'square', 'diamond', 'triangle', 'hexagon'];
const LANDMARKS = [
  { id: 'rocket', name: 'rocket', icon: '🚀' },
  { id: 'tree', name: 'tree', icon: '🌳' },
  { id: 'castle', name: 'castle', icon: '🏰' },
  { id: 'whale', name: 'whale', icon: '🐋' },
  { id: 'moon', name: 'moon', icon: '🌙' }
];
const LANDMARK_SLOTS = [
  { x: 0, y: 72, direction: 'below' }, { x: 54, y: 32, direction: 'lower-right of' },
  { x: -58, y: 24, direction: 'lower-left of' }, { x: 66, y: -20, direction: 'to the right of' },
  { x: -68, y: -18, direction: 'to the left of' }, { x: 18, y: -66, direction: 'above' },
  { x: 88, y: 64, direction: 'far below-right of' }, { x: -88, y: 62, direction: 'far below-left of' }
];

let bookmarkDecoration;
let contextRef;
let activeMapPanel = null;
let mapGroupWasToggled = false;

function activate(context) {
  contextRef = context;

  bookmarkDecoration = vscode.window.createTextEditorDecorationType({
    gutterIconPath: context.asAbsolutePath('bookmark.svg'),
    gutterIconSize: 'contain',
    overviewRulerColor: new vscode.ThemeColor('editorInfo.foreground'),
    overviewRulerLane: vscode.OverviewRulerLane.Right
  });

  context.subscriptions.push(
    bookmarkDecoration,
    vscode.commands.registerCommand('visualBookmarks.add', addBookmark),
    vscode.commands.registerCommand('visualBookmarks.remove', removeBookmarkAtCursor),
    vscode.commands.registerCommand('visualBookmarks.openMap', openVisualMap),
    vscode.commands.registerCommand('visualBookmarks.clearFile', clearCurrentFile),
    vscode.window.onDidChangeActiveTextEditor(updateDecorations),
    vscode.workspace.onDidChangeTextDocument(handleDocumentChange),
    vscode.workspace.onDidRenameFiles(handleRenameFiles)
  );

  updateDecorations(vscode.window.activeTextEditor);
}

function deactivate() {}

function getBookmarks() {
  return contextRef.workspaceState.get(STORAGE_KEY, []);
}

async function saveBookmarks(bookmarks) {
  await contextRef.workspaceState.update(STORAGE_KEY, bookmarks);
  updateDecorations(vscode.window.activeTextEditor);
}

async function addBookmark() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a file before adding a bookmark.');
    return;
  }

  const document = editor.document;
  const position = editor.selection.active;
  const lineText = document.lineAt(position.line).text;
  const bookmarks = ensureVisualLayouts(getBookmarks());
  const uri = document.uri.toString();
  const duplicateIndex = bookmarks.findIndex(item => item.uri === uri && item.line === position.line);
  const existing = duplicateIndex >= 0 ? bookmarks[duplicateIndex] : null;
  const visual = existing ? {
    color: existing.color,
    shape: existing.shape,
    landmarkId: existing.landmarkId,
    offsetX: existing.offsetX,
    offsetY: existing.offsetY,
    direction: existing.direction
  } : chooseLandmarkVisual(bookmarks);

  const bookmark = {
    id: existing ? existing.id : crypto.randomUUID(), uri,
    line: position.line, column: position.character,
    label: existing ? (existing.label || '') : '',
    ...visual, lineText,
    contextBefore: getContext(document, position.line - 2, position.line - 1),
    contextAfter: getContext(document, position.line + 1, position.line + 2),
    createdAt: existing ? existing.createdAt : Date.now(), updatedAt: Date.now()
  };

  if (duplicateIndex >= 0) bookmarks[duplicateIndex] = bookmark;
  else bookmarks.push(bookmark);
  await saveBookmarks(bookmarks);

  const landmark = LANDMARKS.find(item => item.id === bookmark.landmarkId) || LANDMARKS[0];
  const verb = duplicateIndex >= 0 ? 'Updated' : 'Created';
  const action = await vscode.window.showInformationMessage(
    `${verb} ${bookmark.color} ${bookmark.shape} bookmark ${bookmark.direction} the ${landmark.name} ${landmark.icon}.`,
    'Add label'
  );
  if (action === 'Add label') {
    const label = await vscode.window.showInputBox({ prompt: 'Bookmark label', placeHolder: lineText.trim().slice(0, 80), value: bookmark.label });
    if (label !== undefined) {
      bookmark.label = label.trim(); bookmark.updatedAt = Date.now();
      const index = bookmarks.findIndex(item => item.id === bookmark.id);
      if (index >= 0) bookmarks[index] = bookmark;
      await saveBookmarks(bookmarks);
    }
  }
}

function chooseLandmarkVisual(bookmarks) {
  const visual = chooseVisual(bookmarks);
  const counts = new Map(LANDMARKS.map(item => [item.id, 0]));
  for (const bookmark of bookmarks) counts.set(bookmark.landmarkId, (counts.get(bookmark.landmarkId) || 0) + 1);
  const minimum = Math.min(...counts.values());
  const candidates = LANDMARKS.filter(item => counts.get(item.id) === minimum);
  const landmark = candidates[bookmarks.length % candidates.length];
  const used = bookmarks.filter(item => item.landmarkId === landmark.id).length;
  const slot = LANDMARK_SLOTS[used % LANDMARK_SLOTS.length];
  const ring = Math.floor(used / LANDMARK_SLOTS.length);
  const scale = 1 + ring * 0.42;
  return { ...visual, landmarkId: landmark.id, offsetX: Math.round(slot.x * scale), offsetY: Math.round(slot.y * scale), direction: slot.direction };
}

function ensureVisualLayouts(bookmarks) {
  const migrated = [];
  for (const bookmark of bookmarks) {
    if (bookmark.landmarkId && Number.isFinite(bookmark.offsetX) && Number.isFinite(bookmark.offsetY)) migrated.push(bookmark);
    else migrated.push({ ...bookmark, ...chooseLandmarkVisual(migrated), color: bookmark.color || chooseVisual(migrated).color, shape: bookmark.shape || shapeFromId(bookmark.id) });
  }
  return migrated;
}

function chooseVisual(bookmarks) {
  const combinations = [];
  for (const color of COLORS) {
    for (const shape of SHAPES) combinations.push({ color, shape });
  }

  const usage = new Map(combinations.map(combo => [`${combo.color}:${combo.shape}`, 0]));
  for (const bookmark of bookmarks) {
    const key = `${bookmark.color}:${bookmark.shape}`;
    if (usage.has(key)) usage.set(key, usage.get(key) + 1);
  }

  let minimum = Infinity;
  for (const count of usage.values()) minimum = Math.min(minimum, count);
  const candidates = combinations.filter(combo => usage.get(`${combo.color}:${combo.shape}`) === minimum);
  return candidates[bookmarks.length % candidates.length];
}

async function removeBookmarkAtCursor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const uri = editor.document.uri.toString();
  const line = editor.selection.active.line;
  const bookmarks = getBookmarks();
  const next = bookmarks.filter(item => !(item.uri === uri && item.line === line));

  if (next.length === bookmarks.length) {
    vscode.window.showInformationMessage('There is no bookmark on this line.');
    return;
  }

  await saveBookmarks(next);
}

async function clearCurrentFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const answer = await vscode.window.showWarningMessage(
    'Clear all visual bookmarks in this file?',
    { modal: true },
    'Clear'
  );

  if (answer !== 'Clear') return;

  const uri = editor.document.uri.toString();
  await saveBookmarks(getBookmarks().filter(item => item.uri !== uri));
}

function updateDecorations(editor) {
  if (!editor) return;

  const uri = editor.document.uri.toString();
  const ranges = getBookmarks()
    .filter(item => item.uri === uri && item.line < editor.document.lineCount)
    .map(item => ({
      range: new vscode.Range(item.line, 0, item.line, 0),
      hoverMessage: new vscode.MarkdownString(
        `**${item.label || 'Visual bookmark'}**  \n${capitalize(item.color)} ${capitalize(item.shape || 'circle')}  \nLine ${item.line + 1}`
      )
    }));

  editor.setDecorations(bookmarkDecoration, ranges);
}

async function openVisualMap() {
  const originalBookmarks = getBookmarks();
  const allBookmarks = ensureVisualLayouts(originalBookmarks);
  if (JSON.stringify(allBookmarks) !== JSON.stringify(originalBookmarks)) await saveBookmarks(allBookmarks);

  if (!allBookmarks.length) {
    vscode.window.showInformationMessage('No visual bookmarks have been created yet.');
    return;
  }

  const enriched = await enrichBookmarks(allBookmarks);
  if (activeMapPanel) {
    activeMapPanel.reveal(vscode.ViewColumn.Active, false);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'visualBookmarks.map',
    'Visual Bookmarks — Workspace',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activeMapPanel = panel;

  // VS Code does not expose custom modal webviews. Maximizing the active editor
  // group gives the map a modal-like, temporary takeover without moving it into
  // a separate side-by-side tab.
  try {
    await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup');
    mapGroupWasToggled = true;
  } catch {
    mapGroupWasToggled = false;
  }

  panel.webview.html = getWebviewHtml(enriched, 'Workspace');

  panel.onDidDispose(async () => {
    activeMapPanel = null;
    if (mapGroupWasToggled) {
      mapGroupWasToggled = false;
      try { await vscode.commands.executeCommand('workbench.action.toggleMaximizeEditorGroup'); } catch {}
    }
  });

  panel.webview.onDidReceiveMessage(async message => {
    if (message.type === 'open') {
      await openBookmark(message.id, panel);
    } else if (message.type === 'delete') {
      const next = getBookmarks().filter(item => item.id !== message.id);
      await saveBookmarks(next);
      panel.webview.postMessage({ type: 'removed', id: message.id });
    } else if (message.type === 'close') {
      panel.dispose();
    }
  });
}

async function enrichBookmarks(bookmarks) {
  const enriched = [];

  for (const bookmark of bookmarks) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(bookmark.uri));
      const resolved = resolveBookmark(document, bookmark);
      enriched.push({
        ...bookmark,
        shape: bookmark.shape || shapeFromId(bookmark.id),
        line: resolved.line,
        lineCount: document.lineCount,
        relativePath: vscode.workspace.asRelativePath(document.uri),
        preview: document.lineAt(resolved.line).text.trim().slice(0, 110),
        displaced: resolved.displaced
      });
    } catch {
      enriched.push({
        ...bookmark,
        shape: bookmark.shape || shapeFromId(bookmark.id),
        lineCount: Math.max(bookmark.line + 1, 1),
        relativePath: bookmark.uri,
        preview: bookmark.lineText.trim().slice(0, 110),
        displaced: true
      });
    }
  }

  return enriched.sort((a, b) => {
    if (a.relativePath !== b.relativePath) return a.relativePath.localeCompare(b.relativePath);
    return a.line - b.line;
  });
}

async function openBookmark(id, panel) {
  const bookmarks = getBookmarks();
  const index = bookmarks.findIndex(item => item.id === id);
  if (index < 0) return;

  const bookmark = bookmarks[index];

  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(bookmark.uri));
    const resolved = resolveBookmark(document, bookmark);

    if (resolved.line !== bookmark.line) {
      bookmarks[index] = {
        ...bookmark,
        line: resolved.line,
        lineText: document.lineAt(resolved.line).text,
        updatedAt: Date.now()
      };
      await saveBookmarks(bookmarks);
    }

    if (panel) panel.dispose();
    await new Promise(resolve => setTimeout(resolve, 40));

    const targetEditor = await vscode.window.showTextDocument(document, {
      viewColumn: vscode.ViewColumn.One,
      preserveFocus: false,
      preview: false
    });

    const position = new vscode.Position(resolved.line, Math.min(bookmark.column || 0, document.lineAt(resolved.line).text.length));
    targetEditor.selection = new vscode.Selection(position, position);
    targetEditor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    vscode.window.showErrorMessage(`Unable to open bookmark: ${error.message}`);
  }
}

function resolveBookmark(document, bookmark) {
  const originalLine = clamp(bookmark.line, 0, document.lineCount - 1);

  if (document.lineAt(originalLine).text === bookmark.lineText) {
    return { line: originalLine, displaced: false };
  }

  const nearbyStart = Math.max(0, originalLine - 50);
  const nearbyEnd = Math.min(document.lineCount - 1, originalLine + 50);

  for (let line = nearbyStart; line <= nearbyEnd; line++) {
    if (document.lineAt(line).text === bookmark.lineText) {
      return { line, displaced: line !== bookmark.line };
    }
  }

  const target = bookmark.lineText.trim();
  if (target) {
    for (let line = 0; line < document.lineCount; line++) {
      if (document.lineAt(line).text.trim() === target) {
        return { line, displaced: true };
      }
    }
  }

  return { line: originalLine, displaced: true };
}

function handleDocumentChange(event) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) return;
  updateDecorations(editor);
}

async function handleRenameFiles(event) {
  const replacements = new Map(event.files.map(file => [file.oldUri.toString(), file.newUri.toString()]));
  const bookmarks = getBookmarks();
  let changed = false;

  const next = bookmarks.map(bookmark => {
    const uri = replacements.get(bookmark.uri);
    if (!uri) return bookmark;
    changed = true;
    return { ...bookmark, uri, updatedAt: Date.now() };
  });

  if (changed) await saveBookmarks(next);
}

function shapeFromId(id) {
  const text = String(id || '');
  let hash = 0;
  for (let index = 0; index < text.length; index++) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return SHAPES[Math.abs(hash) % SHAPES.length];
}

function getContext(document, start, end) {
  const result = [];
  for (let line = Math.max(0, start); line <= Math.min(document.lineCount - 1, end); line++) {
    result.push(document.lineAt(line).text);
  }
  return result;
}

function getWebviewHtml(bookmarks, titleSuffix) {
  const nonce = crypto.randomBytes(16).toString('hex');
  const safeData = JSON.stringify(bookmarks).replace(/</g, '\\u003c');
  const safeLandmarks = JSON.stringify(LANDMARKS).replace(/</g, '\\u003c');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>Visual Bookmarks</title><style>
:root{color-scheme:light dark;--border:var(--vscode-panel-border);--muted:var(--vscode-descriptionForeground);--focus:var(--vscode-focusBorder)}*{box-sizing:border-box}body{margin:0;padding:16px;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-font-family);overflow:hidden}header{display:flex;justify-content:space-between;align-items:end;gap:18px;margin-bottom:10px}h1{font-size:18px;margin:0}.subtitle,.help{font-size:12px;color:var(--muted)}#layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:12px;height:calc(100vh - 76px)}#viewport{position:relative;border:1px solid var(--border);border-radius:12px;overflow:auto;outline:none;background:color-mix(in srgb,var(--vscode-sideBar-background) 72%,var(--vscode-editor-background))}#map{position:relative;min-width:900px;min-height:620px;height:100%;isolation:isolate;background-image:radial-gradient(circle at center,color-mix(in srgb,var(--vscode-editor-foreground) 7%,transparent) 1px,transparent 1px);background-size:28px 28px}.landmark{position:absolute;transform:translate(-50%,-50%);font-size:64px;line-height:1;filter:drop-shadow(0 5px 5px rgba(0,0,0,.25));user-select:none}.landmark-label{position:absolute;top:72px;left:50%;transform:translateX(-50%);font-size:11px;font-weight:700;color:var(--muted);white-space:nowrap}.marker{position:absolute;width:17px;height:17px;padding:0;border:2px solid color-mix(in srgb,var(--vscode-editor-background) 78%,transparent);background:var(--c);transform:translate(-50%,-50%);cursor:pointer;filter:drop-shadow(0 2px 3px rgba(0,0,0,.4));z-index:5}.circle{border-radius:50%}.square{border-radius:2px}.diamond{transform:translate(-50%,-50%) rotate(45deg)}.triangle{clip-path:polygon(50% 0,100% 100%,0 100%)}.hexagon{clip-path:polygon(25% 6%,75% 6%,100% 50%,75% 94%,25% 94%,0 50%)}.marker.selected{width:25px;height:25px;box-shadow:0 0 0 3px var(--focus),0 0 0 8px color-mix(in srgb,var(--focus) 28%,transparent);z-index:9}.selection-ring{position:absolute;width:46px;height:46px;border:2px solid var(--focus);border-radius:50%;transform:translate(-50%,-50%);pointer-events:none;z-index:8;animation:cursorPulse 1.05s ease-in-out infinite}.selection-ring:before,.selection-ring:after{content:'';position:absolute;background:var(--focus);opacity:.75}.selection-ring:before{left:50%;top:-9px;width:2px;height:62px;transform:translateX(-50%)}.selection-ring:after{top:50%;left:-9px;height:2px;width:62px;transform:translateY(-50%)}#trailLayer{position:absolute;inset:0;overflow:visible;pointer-events:none;z-index:7}.travel-trail{fill:none;stroke:var(--focus);stroke-width:5;stroke-linecap:round;filter:drop-shadow(0 0 5px var(--focus));stroke-dasharray:10 8;animation:trailFade .9s ease-out forwards}@keyframes cursorPulse{0%,100%{transform:translate(-50%,-50%) scale(.9);opacity:.65}50%{transform:translate(-50%,-50%) scale(1.12);opacity:1}}@keyframes trailFade{0%{opacity:1;stroke-width:6;stroke-dashoffset:18}65%{opacity:.55;stroke-width:4}100%{opacity:0;stroke-width:1;stroke-dashoffset:0}}.marker.displaced{opacity:.55}.marker.filtered-out{display:none}#commandHud{position:absolute;left:50%;top:14px;transform:translateX(-50%);z-index:20;min-width:280px;max-width:70%;padding:8px 12px;border:1px solid var(--focus);border-radius:8px;background:var(--vscode-editorWidget-background);box-shadow:0 8px 24px rgba(0,0,0,.28);font-size:12px;text-align:center;opacity:0;pointer-events:none;transition:opacity .12s}.hud-visible{opacity:1!important}.hud-key{font-family:var(--vscode-editor-font-family);font-weight:700}.search-active{outline:2px solid color-mix(in srgb,var(--focus) 72%,transparent);outline-offset:-2px}#details{border:1px solid var(--border);border-radius:12px;padding:16px;background:var(--vscode-editorWidget-background);overflow:auto}#details h2{font-size:16px;margin:0 0 10px}.identity{font-size:13px;font-weight:700;margin-bottom:12px}.code{padding:11px;border-radius:7px;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family);font-size:12px;white-space:pre-wrap;overflow-wrap:anywhere}.meta{font-size:11px;color:var(--muted);line-height:1.55;margin-top:10px}@media(max-width:850px){#layout{grid-template-columns:1fr}#details{display:none}}
</style></head><body><header><div><h1>Visual Bookmarks</h1><div class="subtitle">${escapeHtml(titleSuffix)} landmark map · landmarks and existing bookmarks never move</div></div><div class="help">↑↓←→ or HJKL · / searches · landmark+color jumps (T B, R B) · Tab cycles · Esc clears/closes</div></header><div id="layout"><div id="viewport" tabindex="0"><div id="commandHud"></div><div id="map"></div></div><aside id="details"></aside></div><script nonce="${nonce}">
const vscode=acquireVsCodeApi();let bookmarks=${safeData};const landmarks=${safeLandmarks};let selectedIndex=-1;const viewport=document.getElementById('viewport'),map=document.getElementById('map'),details=document.getElementById('details');const colors={blue:'#4da3ff',red:'#ff5c5c',yellow:'#e9c84a',green:'#52c878',purple:'#b889ff',orange:'#ff9f43',gray:'#9aa0a6'};const anchors={rocket:[.18,.20],tree:[.75,.18],castle:[.48,.50],whale:[.18,.78],moon:[.78,.78]};let positions=[];let trailLayer=null;let searchText='';let searchMode=false;let chordPrefix='';let chordTimer=null;let lastChord='';let hudTimer=null;const hud=document.getElementById('commandHud');const landmarkKeys={r:'rocket',t:'tree',c:'castle',w:'whale',m:'moon'};const colorKeys={b:'blue',r:'red',y:'yellow',g:'green',p:'purple',o:'orange'};
function render(){map.innerHTML='';positions=[];const w=Math.max(900,viewport.clientWidth),h=Math.max(620,viewport.clientHeight);map.style.width=w+'px';map.style.height=h+'px';trailLayer=document.createElementNS('http://www.w3.org/2000/svg','svg');trailLayer.setAttribute('id','trailLayer');trailLayer.setAttribute('width',w);trailLayer.setAttribute('height',h);trailLayer.setAttribute('viewBox','0 0 '+w+' '+h);map.appendChild(trailLayer);for(const lm of landmarks){const a=anchors[lm.id];const el=document.createElement('div');el.className='landmark';el.style.left=(a[0]*w)+'px';el.style.top=(a[1]*h)+'px';el.innerHTML='<span>'+lm.icon+'</span><span class="landmark-label">'+esc(lm.name)+'</span>';map.appendChild(el)}bookmarks.forEach((b,i)=>{const a=anchors[b.landmarkId]||anchors.rocket;const x=a[0]*w+(b.offsetX||0),y=a[1]*h+(b.offsetY||0);const visible=matchesSearch(b);positions[i]=visible?{x,y}:null;const m=document.createElement('button');m.className='marker '+(b.shape||'circle')+(selectedIndex>=0&&i===selectedIndex?' selected':'')+(b.displaced?' displaced':'')+(visible?'':' filtered-out');m.style.left=x+'px';m.style.top=y+'px';m.style.setProperty('--c',colors[b.color]||colors.blue);m.title=(b.label||shortName(b.relativePath))+' · '+b.direction+' the '+b.landmarkId;m.onclick=()=>select(i);m.ondblclick=openSelected;map.appendChild(m)});if(selectedIndex>=0&&!positions[selectedIndex])selectedIndex=-1;viewport.classList.toggle('search-active',searchMode||!!searchText);drawCursor();updateDetails();updateHud()}
function searchableText(b){return [b.label,b.relativePath,b.preview,b.lineText,b.color,b.shape,b.landmarkId,b.direction].filter(Boolean).join(' ').toLowerCase()}function matchesSearch(b){return !searchText||searchableText(b).includes(searchText.toLowerCase())}function visibleIndexes(){return bookmarks.map((_,i)=>i).filter(i=>positions[i])}function centerPoint(){return {x:parseFloat(map.style.width)/2,y:parseFloat(map.style.height)/2}}function currentPoint(){return selectedIndex>=0&&positions[selectedIndex]?positions[selectedIndex]:centerPoint()}function drawCursor(){const p=currentPoint();if(!p)return;const ring=document.createElement('div');ring.className='selection-ring';ring.style.left=p.x+'px';ring.style.top=p.y+'px';map.appendChild(ring)}
function drawTrail(from,to){if(!from||!to||!trailLayer)return;const path=document.createElementNS('http://www.w3.org/2000/svg','path');const bend=Math.max(28,Math.min(90,Math.hypot(to.x-from.x,to.y-from.y)*.22));const mx=(from.x+to.x)/2,my=(from.y+to.y)/2-bend;path.setAttribute('d','M '+from.x+' '+from.y+' Q '+mx+' '+my+' '+to.x+' '+to.y);path.setAttribute('class','travel-trail');trailLayer.appendChild(path);setTimeout(()=>path.remove(),950)}
function select(i){if(!bookmarks.length||!positions[i])return;const old={...currentPoint()};selectedIndex=Math.max(0,Math.min(i,bookmarks.length-1));render();const next={...currentPoint()};drawTrail(old,next);map.querySelector('.selected')?.scrollIntoView({block:'nearest',inline:'nearest',behavior:'smooth'});viewport.focus({preventScroll:true})}function returnToCenter(){const old={...currentPoint()};selectedIndex=-1;render();const next={...currentPoint()};drawTrail(old,next);viewport.scrollTo({left:Math.max(0,next.x-viewport.clientWidth/2),top:Math.max(0,next.y-viewport.clientHeight/2),behavior:'smooth'});viewport.focus({preventScroll:true})}function updateDetails(){if(selectedIndex<0){const count=visibleIndexes().length;details.innerHTML='<h2>Map center</h2><div class="identity">'+(searchText?'Search: '+esc(searchText):'Choose a direction')+'</div><div class="meta">'+count+' of '+bookmarks.length+' markers visible.<br><br>Press <b>/</b> to search labels, files, code, colors, shapes, or landmarks. Type a landmark key followed by a color key—for example <b>T B</b> for tree blue or <b>R B</b> for rocket blue.</div>';return}const b=bookmarks[selectedIndex];if(!b){details.innerHTML='<div class="meta">No bookmarks.</div>';return}const lm=landmarks.find(x=>x.id===b.landmarkId)||landmarks[0];details.innerHTML='<h2>'+esc(b.label||shortName(b.relativePath))+'</h2><div class="identity">'+esc(cap(b.color)+' '+cap(b.shape)+' · '+b.direction+' the '+lm.name+' '+lm.icon)+'</div><div class="code">'+esc(b.preview||b.lineText||'')+'</div><div class="meta">'+esc(b.relativePath)+'<br>Line '+(b.line+1)+(b.displaced?'<br>Approximate code location':'')+'<br><br>This visual position is permanent unless the bookmark is deleted.</div>'}function move(dxWanted,dyWanted){if(!bookmarks.length)return;const c=currentPoint();let best=-1,score=Infinity;positions.forEach((p,i)=>{if(!p||i===selectedIndex)return;const dx=p.x-c.x,dy=p.y-c.y;const projection=dx*dxWanted+dy*dyWanted;if(projection<=1)return;const perpendicular=Math.abs(dx*dyWanted-dy*dxWanted);const distance=Math.hypot(dx,dy);const anglePenalty=perpendicular/Math.max(projection,1);const s=distance+perpendicular*.55+anglePenalty*90;if(s<score){score=s;best=i}});if(best<0){let extreme=-Infinity;positions.forEach((p,i)=>{if(!p||i===selectedIndex)return;const value=p.x*dxWanted+p.y*dyWanted;if(value>extreme){extreme=value;best=i}})}if(best>=0)select(best)}function cycle(step){const visible=visibleIndexes();if(!visible.length)return;let pos=visible.indexOf(selectedIndex);if(pos<0)pos=step>0?-1:0;const next=visible[(pos+step+visible.length)%visible.length];select(next)}
function showHud(html,persistent=false){clearTimeout(hudTimer);hud.innerHTML=html;hud.classList.add('hud-visible');if(!persistent)hudTimer=setTimeout(()=>hud.classList.remove('hud-visible'),1100)}
function updateHud(){if(searchMode){showHud('<span class="hud-key">Search:</span> '+esc(searchText)+'▌',true)}else if(chordPrefix){const landmark=landmarkKeys[chordPrefix];showHud('<span class="hud-key">'+chordPrefix.toUpperCase()+'</span> = '+cap(landmark)+' · choose color: B blue, R red, Y yellow, G green, P purple, O orange',true)}else if(searchText){showHud('<span class="hud-key">Filter:</span> '+esc(searchText)+' · Esc clears',true)}else{hud.classList.remove('hud-visible')}}
function applySearch(){render();const visible=visibleIndexes();if(visible.length===1)select(visible[0])}
function clearSearch(){searchText='';searchMode=false;render();showHud('Search cleared')}
function startChord(key){chordPrefix=key;clearTimeout(chordTimer);chordTimer=setTimeout(()=>{chordPrefix='';updateHud()},1600);updateHud()}
function finishChord(colorKey){const landmark=landmarkKeys[chordPrefix],color=colorKeys[colorKey];if(!landmark||!color)return false;clearTimeout(chordTimer);const chord=chordPrefix+colorKey;chordPrefix='';searchMode=false;searchText='';render();const matches=bookmarks.map((b,i)=>({b,i})).filter(x=>x.b.landmarkId===landmark&&x.b.color===color).map(x=>x.i);if(!matches.length){showHud('No '+color+' bookmark near the '+landmark);return true}let next=matches[0];if(lastChord===chord&&matches.includes(selectedIndex)){next=matches[(matches.indexOf(selectedIndex)+1)%matches.length]}lastChord=chord;select(next);showHud(cap(landmark)+' · '+cap(color)+' ('+matches.length+' match'+(matches.length===1?'':'es')+')');return true}
function openSelected(){const b=bookmarks[selectedIndex];if(b)vscode.postMessage({type:'open',id:b.id})}function remove(){const b=bookmarks[selectedIndex];if(b)vscode.postMessage({type:'delete',id:b.id})}document.addEventListener('keydown',e=>{const k=e.key.toLowerCase();if(searchMode){if(k==='escape'){e.preventDefault();clearSearch()}else if(k==='enter'){e.preventDefault();searchMode=false;updateHud();const visible=visibleIndexes();if(visible.length)select(visible[0])}else if(k==='backspace'){e.preventDefault();searchText=searchText.slice(0,-1);applySearch()}else if(e.key.length===1&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();searchText+=e.key;applySearch()}return}if(chordPrefix&&colorKeys[k]){e.preventDefault();finishChord(k);return}if(k==='/'||((e.ctrlKey||e.metaKey)&&k==='f')){e.preventDefault();searchMode=true;searchText='';updateHud();return}if(landmarkKeys[k]&&!e.ctrlKey&&!e.metaKey&&!e.altKey){e.preventDefault();startChord(k);return}if(k==='arrowup'||k==='k'){e.preventDefault();move(0,-1)}else if(k==='arrowdown'||k==='j'){e.preventDefault();move(0,1)}else if(k==='arrowleft'||k==='h'){e.preventDefault();move(-1,0)}else if(k==='arrowright'||k==='l'){e.preventDefault();move(1,0)}else if(k==='tab'){e.preventDefault();cycle(e.shiftKey?-1:1)}else if(k==='home'){e.preventDefault();returnToCenter()}else if(k==='enter'){e.preventDefault();openSelected()}else if(k==='delete'){e.preventDefault();remove()}else if(k==='backspace'&&searchText){e.preventDefault();searchText=searchText.slice(0,-1);applySearch()}else if(k==='escape'){e.preventDefault();if(chordPrefix){chordPrefix='';updateHud()}else if(searchText){clearSearch()}else vscode.postMessage({type:'close'})}});window.addEventListener('message',e=>{if(e.data.type==='removed'){const removedIndex=bookmarks.findIndex(x=>x.id===e.data.id);bookmarks=bookmarks.filter(x=>x.id!==e.data.id);if(!bookmarks.length||selectedIndex===removedIndex)selectedIndex=-1;else if(removedIndex>=0&&removedIndex<selectedIndex)selectedIndex--;render()}});window.addEventListener('resize',()=>{const wasCenter=selectedIndex<0;render();if(wasCenter){const p=centerPoint();viewport.scrollTo(Math.max(0,p.x-viewport.clientWidth/2),Math.max(0,p.y-viewport.clientHeight/2))}});function shortName(p){return String(p||'').split(/[\\/]/).pop()||p}function cap(v){v=String(v||'');return v.charAt(0).toUpperCase()+v.slice(1)}function esc(v){return String(v||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;')}render();const start=centerPoint();viewport.scrollTo(Math.max(0,start.x-viewport.clientWidth/2),Math.max(0,start.y-viewport.clientHeight/2));viewport.focus();
</script></body></html>`;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

module.exports = { activate, deactivate };
