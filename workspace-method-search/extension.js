'use strict';

const vscode = require('vscode');

let activePanel;
let disposed = false;
let indexLoaded = false;
let indexBuildPromise;
let indexGeneration = 0;
let searchRequestId = 0;
let lastQuery = '';
let symbolIndex = new Map(); // uri string -> method rows
let indexedFileUris = new Set();
let fileSignatures = new Map(); // uri string -> size:mtime fingerprint for branch/external-change reconciliation
let changeTimers = new Map();
let refreshTokens = new Map(); // uri string -> monotonically increasing refresh id
let indexStats = { files: 0, indexedFiles: 0, methods: 0, failedFiles: 0, building: false };

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('workspaceMethodSearch.open', () => showMethodSearch()),
    vscode.commands.registerCommand('workspaceMethodSearch.moveDown', () => {
      if (activePanel) activePanel.webview.postMessage({ type: 'moveSelection', delta: 1 });
    }),
    vscode.commands.registerCommand('workspaceMethodSearch.moveUp', () => {
      if (activePanel) activePanel.webview.postMessage({ type: 'moveSelection', delta: -1 });
    }),
    vscode.commands.registerCommand('workspaceMethodSearch.rebuildIndex', async () => {
      invalidateIndex();
      await ensureIndex(true);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => rebuildIfLoaded()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('files.exclude') ||
        e.affectsConfiguration('search.exclude') ||
        e.affectsConfiguration('workspaceMethodSearch.include') ||
        e.affectsConfiguration('workspaceMethodSearch.exclude') ||
        e.affectsConfiguration('workspaceMethodSearch.includeKinds') ||
        e.affectsConfiguration('workspaceMethodSearch.maxFiles') ||
        e.affectsConfiguration('workspaceMethodSearch.indexConcurrency')
      ) {
        rebuildIfLoaded();
      }
    }),
    vscode.workspace.onDidCreateFiles((e) => { if (indexLoaded) void addFiles(e.files); }),
    vscode.workspace.onDidDeleteFiles((e) => { if (indexLoaded) removeFiles(e.files); }),
    vscode.workspace.onDidRenameFiles((e) => { if (indexLoaded) void renameFiles(e.files); }),
    vscode.workspace.onDidSaveTextDocument((d) => { if (indexLoaded) scheduleDocumentRefresh(d, 0); }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (indexLoaded && e.contentChanges.length) scheduleDocumentRefresh(e.document, 350);
    }),
    { dispose: () => { disposed = true; closePanel(); clearChangeTimers(); } }
  );
}

function deactivate() {
  disposed = true;
  closePanel();
  clearChangeTimers();
}

function clearChangeTimers() {
  for (const timer of changeTimers.values()) clearTimeout(timer);
  changeTimers.clear();
  refreshTokens.clear();
}

function invalidateIndex() {
  indexGeneration++;
  indexLoaded = false;
}

function rebuildIfLoaded() {
  if (!indexLoaded && !indexBuildPromise) return;
  invalidateIndex();
  void ensureIndex(false).catch(logError);
}

async function ensureIndex(showStatus = false) {
  if (indexLoaded && !indexStats.building) return flattenIndex();
  if (indexBuildPromise) return indexBuildPromise;
  const generation = indexGeneration;
  indexBuildPromise = buildIndex(generation, showStatus).finally(() => {
    indexBuildPromise = undefined;
  });
  return indexBuildPromise;
}

async function buildIndex(generation, showStatus) {
  const config = vscode.workspace.getConfiguration('workspaceMethodSearch');
  const include = config.get('include', '**/*.{java,kt,kts,js,jsx,mjs,cjs,ts,tsx,py,cs,cpp,cc,cxx,c,h,hpp,hh,hxx,go,rs,rb,php,swift}');
  const exclude = buildExcludeGlob(config.get('exclude', []));
  const maxFiles = config.get('maxFiles', 20000);
  const concurrency = Math.max(1, Math.min(32, config.get('indexConcurrency', 8)));

  const nextIndex = new Map();
  const nextUris = new Set();
  const nextSignatures = new Map();
  indexStats = { files: 0, indexedFiles: 0, methods: 0, failedFiles: 0, building: true };
  postIndexStatus();

  let uris;
  try {
    uris = await vscode.workspace.findFiles(include, exclude || undefined, maxFiles);
  } catch (error) {
    indexStats.building = false;
    postIndexStatus(`Failed to enumerate workspace files: ${error.message}`);
    throw error;
  }

  if (generation !== indexGeneration) return flattenIndex();
  uris = uris.filter(isSourceUri);
  indexStats.files = uris.length;
  postIndexStatus();

  let next = 0;
  let lastUiUpdate = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= uris.length || generation !== indexGeneration || disposed) return;
      const uri = uris[i];
      const key = uri.toString();
      nextUris.add(key);
      try {
        const rows = await indexUri(uri);
        nextIndex.set(key, rows);
        const signature = await getFileSignature(uri);
        if (signature) nextSignatures.set(key, signature);
        indexStats.methods += rows.length;
        indexStats.indexedFiles++;
      } catch (error) {
        nextIndex.set(key, []);
        indexStats.failedFiles++;
        console.warn('[workspace-method-search] unable to index', uri.fsPath, error);
      }

      const now = Date.now();
      if (activePanel && now - lastUiUpdate > 120) {
        lastUiUpdate = now;
        postIndexStatus();
        const partial = flattenMap(nextIndex);
        void sendState(activePanel, partial, undefined, { preserveSelection: true });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, uris.length)) }, worker));
  if (generation !== indexGeneration) return flattenIndex();

  symbolIndex = nextIndex;
  indexedFileUris = nextUris;
  fileSignatures = nextSignatures;
  indexLoaded = true;
  indexStats.building = false;
  indexStats.methods = flattenIndex().length;
  postIndexStatus();
  if (activePanel) await sendState(activePanel, flattenIndex(), undefined, { preserveSelection: true });

  if (showStatus) {
    vscode.window.setStatusBarMessage(
      `Workspace Method Search: indexed ${indexStats.methods} methods from ${indexStats.indexedFiles} files`,
      3500
    );
  }
  return flattenIndex();
}

async function indexUri(uri) {
  const document = await vscode.workspace.openTextDocument(uri);
  const raw = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
  return Array.isArray(raw) ? extractSymbolsFromDocument(uri, raw) : [];
}

function scheduleDocumentRefresh(document, delay) {
  if (!document || !isSourceUri(document.uri)) return;
  const key = document.uri.toString();
  clearTimeout(changeTimers.get(key));
  changeTimers.set(key, setTimeout(() => {
    changeTimers.delete(key);
    void refreshDocument(document).catch(logError);
  }, delay));
}

async function refreshDocument(document, options = {}) {
  if (!indexLoaded || !document || !isSourceUri(document.uri)) return false;
  const key = document.uri.toString();
  const token = (refreshTokens.get(key) || 0) + 1;
  refreshTokens.set(key, token);
  const version = document.version;
  const retries = Math.max(0, Number(options.retries ?? 1));

  let rows = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);

    // A newer edit/refresh request won the race. Never let this older response
    // overwrite the index for a newer document state.
    if (refreshTokens.get(key) !== token || document.version !== version) return false;

    rows = Array.isArray(raw) ? extractSymbolsFromDocument(document.uri, raw) : [];
    const previous = symbolIndex.get(key) || [];

    // JDT can briefly return an empty/partial tree while reconciling an edited
    // document. Retry before replacing a known-good entry.
    const suspiciousDrop = previous.length > 0 && rows.length < previous.length && document.isDirty;
    if (!suspiciousDrop || attempt === retries) break;
    await delay(80 * (attempt + 1));
  }

  if (refreshTokens.get(key) !== token || document.version !== version) return false;

  // Do not clobber a known-good dirty-document index with an empty transient
  // result. The next edit/save/open refresh will try again.
  const previous = symbolIndex.get(key) || [];
  if (document.isDirty && previous.length > 0 && rows.length === 0) return false;

  symbolIndex.set(key, rows);
  indexedFileUris.add(key);
  const signature = await getFileSignature(document.uri);
  if (signature) fileSignatures.set(key, signature);
  updateMethodCount();
  if (activePanel && options.notify !== false) await sendState(activePanel, flattenIndex(), undefined, { preserveSelection: true });
  return true;
}

async function refreshOpenDocuments(preferredDocument) {
  if (!indexLoaded) return;
  const docs = vscode.workspace.textDocuments.filter(d => isSourceUri(d.uri));
  const ordered = [];
  if (preferredDocument && isSourceUri(preferredDocument.uri)) ordered.push(preferredDocument);
  for (const doc of docs) if (!ordered.some(d => d.uri.toString() === doc.uri.toString())) ordered.push(doc);

  // Refresh the file the user was looking at first so its methods are correct
  // before the search UI renders. The remaining open files are cheap and keep
  // the incremental cache honest.
  if (ordered[0]) await refreshDocument(ordered[0], { retries: 2, notify: false });
  await Promise.all(ordered.slice(1).map(doc => refreshDocument(doc, { retries: 1, notify: false })));
  if (activePanel) await sendState(activePanel, flattenIndex(), undefined, { preserveSelection: true });
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function addFiles(files) {
  for (const uri of files) {
    if (!isSourceUri(uri)) continue;
    try {
      const key = uri.toString();
      symbolIndex.set(key, await indexUri(uri));
      indexedFileUris.add(key);
      const signature = await getFileSignature(uri);
      if (signature) fileSignatures.set(key, signature);
    } catch (error) {
      console.warn('[workspace-method-search] unable to index created file', uri.fsPath, error);
    }
  }
  updateMethodCount();
  if (activePanel) await sendState(activePanel, flattenIndex(), undefined, { preserveSelection: true });
}

function removeFiles(files) {
  let changed = false;
  for (const uri of files) {
    const key = uri.toString();
    if (symbolIndex.delete(key)) changed = true;
    indexedFileUris.delete(key);
    fileSignatures.delete(key);
  }
  if (changed) {
    updateMethodCount();
    if (activePanel) void sendState(activePanel, flattenIndex(), undefined, { preserveSelection: true });
  }
}

async function renameFiles(entries) {
  removeFiles(entries.map(e => e.oldUri));
  await addFiles(entries.map(e => e.newUri));
}

async function enumerateIncludedSourceUris() {
  const config = vscode.workspace.getConfiguration('workspaceMethodSearch');
  const include = config.get('include', '**/*.{java,kt,kts,js,jsx,mjs,cjs,ts,tsx,py,cs,cpp,cc,cxx,c,h,hpp,hh,hxx,go,rs,rb,php,swift}');
  const exclude = buildExcludeGlob(config.get('exclude', []));
  const maxFiles = config.get('maxFiles', 20000);
  const uris = await vscode.workspace.findFiles(include, exclude || undefined, maxFiles);
  return uris.filter(isSourceUri);
}

async function getFileSignature(uri) {
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return `${stat.size}:${stat.mtime}`;
  } catch (_) {
    return undefined;
  }
}

function findOpenDocument(uri) {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
}

async function reconcileWorkspaceIndex() {
  if (!indexLoaded || indexStats.building) return;

  const uris = await enumerateIncludedSourceUris();
  const current = new Map(uris.map(uri => [uri.toString(), uri]));
  let changed = false;

  // Branch switches and include/exclude changes can remove many files without
  // producing reliable per-file extension events. Remove anything no longer in
  // the currently included workspace set.
  for (const key of [...indexedFileUris]) {
    if (current.has(key)) continue;
    symbolIndex.delete(key);
    indexedFileUris.delete(key);
    fileSignatures.delete(key);
    changed = true;
  }

  const concurrency = Math.max(1, Math.min(32, vscode.workspace.getConfiguration('workspaceMethodSearch').get('indexConcurrency', 8)));
  let next = 0;
  const work = uris;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= work.length || disposed) return;
      const uri = work[i];
      const key = uri.toString();
      const signature = await getFileSignature(uri);
      const isNew = !indexedFileUris.has(key);
      const changedOnDisk = !!signature && fileSignatures.get(key) !== signature;
      if (!isNew && !changedOnDisk) continue;

      try {
        const open = findOpenDocument(uri);
        if (open) {
          await refreshDocument(open, { retries: 2, notify: false });
        } else {
          symbolIndex.set(key, await indexUri(uri));
          indexedFileUris.add(key);
          if (signature) fileSignatures.set(key, signature);
        }
        changed = true;
      } catch (error) {
        console.warn('[workspace-method-search] unable to reconcile', uri.fsPath, error);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, work.length)) }, worker));
  if (changed) {
    updateMethodCount();
    if (activePanel) await sendState(activePanel, flattenIndex(), undefined, { preserveSelection: true });
  }
}

function updateMethodCount() {
  indexStats.files = indexedFileUris.size;
  indexStats.indexedFiles = indexedFileUris.size;
  indexStats.methods = flattenIndex().length;
  postIndexStatus();
}

function flattenIndex() { return flattenMap(symbolIndex); }
function flattenMap(map) {
  const rows = [];
  for (const values of map.values()) rows.push(...values);
  return dedupeSymbols(rows);
}

async function showMethodSearch() {
  if (activePanel) {
    if (indexLoaded) {
      try { await reconcileWorkspaceIndex(); }
      catch (error) { console.warn('[workspace-method-search] unable to reconcile workspace index', error); }
    }
    activePanel.reveal(activePanel.viewColumn, true);
    activePanel.webview.postMessage({ type: 'focusSearch' });
    return;
  }

  const sourceEditor = vscode.window.activeTextEditor;

  // Reconcile the cached file set and fingerprints on every invocation. This
  // catches git branch checkouts and external workspace changes even when VS
  // Code did not emit reliable create/delete/change events for every file.
  if (indexLoaded) {
    try { await reconcileWorkspaceIndex(); }
    catch (error) { console.warn('[workspace-method-search] unable to reconcile workspace index', error); }
  }

  // The active source file is the most likely place for a just-added/edited
  // method. Reconcile it before showing cached search results.
  if (indexLoaded && sourceEditor?.document && isSourceUri(sourceEditor.document.uri)) {
    try { await refreshOpenDocuments(sourceEditor.document); }
    catch (error) { console.warn('[workspace-method-search] unable to refresh open documents', error); }
  }
  const sourceColumn = sourceEditor?.viewColumn || vscode.ViewColumn.Active;
  const panel = vscode.window.createWebviewPanel(
    'workspaceMethodSearch.navigator',
    'Workspace Methods',
    vscode.ViewColumn.Active,
    { enableScripts: true, retainContextWhenHidden: true }
  );
  activePanel = panel;
  await vscode.commands.executeCommand('setContext', 'workspaceMethodSearch.active', true);
  panel.webview.html = getWebviewHtml();
  panel.reveal(vscode.ViewColumn.Active, false);

  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = undefined;
      void vscode.commands.executeCommand('setContext', 'workspaceMethodSearch.active', false);
    }
  });

  panel.webview.onDidReceiveMessage(async (message) => {
    if (panel !== activePanel || disposed) return;
    switch (message?.type) {
      case 'ready':
        panel.webview.postMessage({ type: 'focusSearch' });
        postIndexStatus();
        await sendState(panel, flattenIndex(), '', { requestId: ++searchRequestId, preserveSelection: true });
        if (!indexLoaded && !indexStats.building) void ensureIndex(false).catch(logError);
        refocus(panel);
        break;
      case 'search':
        await sendState(panel, flattenIndex(), String(message.query || ''));
        break;
      case 'open': {
        const row = currentRankedRow(String(message.query || ''), Number(message.index));
        if (!row) return;
        panel.dispose();
        await openSymbol(row, sourceColumn);
        break;
      }
      case 'close':
        panel.dispose();
        break;
    }
  });
}

function refocus(panel) {
  for (const ms of [0, 20, 60]) {
    setTimeout(() => { if (activePanel === panel) panel.webview.postMessage({ type: 'focusSearch' }); }, ms);
  }
}

async function sendState(panel, symbols, query, options = {}) {
  if (!panel || panel !== activePanel) return;
  if (typeof query === 'string') lastQuery = query;
  const normalizedQuery = typeof query === 'string' ? query : lastQuery;
  const requestId = options.requestId ?? ++searchRequestId;
  const preserveSelection = options.preserveSelection === true;
  const maxResults = vscode.workspace.getConfiguration('workspaceMethodSearch').get('maxResults', 250);
  const ranked = rankSymbols(symbols, normalizedQuery.trim(), maxResults);
  if (requestId !== searchRequestId && !preserveSelection) return;
  panel.webview.postMessage({
    type: 'state',
    query: normalizedQuery,
    requestId,
    rows: ranked.map(({ item }) => item),
    totalIndexed: symbols.length,
    building: indexStats.building
  });
}

function currentRankedRow(query, index) {
  const maxResults = vscode.workspace.getConfiguration('workspaceMethodSearch').get('maxResults', 250);
  const ranked = rankSymbols(flattenIndex(), String(query || '').trim(), maxResults);
  if (!ranked.length) return undefined;
  const safe = Math.max(0, Math.min(Number.isFinite(index) ? index : 0, ranked.length - 1));
  return ranked[safe].item;
}

async function openSymbol(item, viewColumn) {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.uri));
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: false,
    viewColumn
  });
  const position = new vscode.Position(item.line - 1, item.character || 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

function postIndexStatus(errorText = '') {
  if (!activePanel) return;
  activePanel.webview.postMessage({ type: 'indexStatus', ...indexStats, error: errorText });
}

function buildExcludeGlob(extraExcludes) {
  const patterns = [
    '**/node_modules/**', '**/.git/**', '**/.gradle/**', '**/build/**', '**/dist/**',
    '**/out/**', '**/target/**', '**/.idea/**', '**/.vscode/**'
  ];
  const fileExcludes = vscode.workspace.getConfiguration('files').get('exclude', {});
  const searchExcludes = vscode.workspace.getConfiguration('search').get('exclude', {});
  for (const [glob, enabled] of Object.entries(fileExcludes || {})) if (enabled === true) patterns.push(glob);
  for (const [glob, enabled] of Object.entries(searchExcludes || {})) if (enabled === true) patterns.push(glob);
  if (Array.isArray(extraExcludes)) patterns.push(...extraExcludes.filter(Boolean));
  const unique = [...new Set(patterns)];
  return unique.length === 1 ? unique[0] : `{${unique.join(',')}}`;
}

function isSourceUri(uri) {
  if (!uri || uri.scheme !== 'file') return false;
  const p = uri.fsPath.toLowerCase().replace(/\\/g, '/');
  if (p.includes('/.git/') || p.includes('/node_modules/') || p.includes('/.gradle/')) return false;
  const ext = p.slice(p.lastIndexOf('.'));
  return new Set(['.java','.kt','.kts','.js','.jsx','.mjs','.cjs','.ts','.tsx','.py','.cs','.cpp','.cc','.cxx','.c','.h','.hpp','.hh','.hxx','.go','.rs','.rb','.php','.swift']).has(ext);
}

function extractSymbolsFromDocument(uri, symbols) {
  const results = [];
  function walk(symbol, containers) {
    if (!symbol) return;
    if (symbol.range && symbol.selectionRange) {
      const nextContainers = isContainerKind(symbol.kind) ? [...containers, symbol.name] : containers;
      if (isIncludedKind(symbol.kind)) results.push(normalizeSymbol(uri, symbol, containers));
      if (Array.isArray(symbol.children)) for (const child of symbol.children) walk(child, nextContainers);
      return;
    }
    if (symbol.location?.uri && isIncludedKind(symbol.kind)) {
      const r = symbol.location.range;
      results.push(makeRow(symbol.location.uri, symbol.name || '', symbol.containerName || '', '', r));
    }
  }
  for (const symbol of symbols) walk(symbol, []);
  return results;
}

function isContainerKind(kind) {
  return kind === vscode.SymbolKind.Class || kind === vscode.SymbolKind.Interface ||
    kind === vscode.SymbolKind.Struct || kind === vscode.SymbolKind.Enum ||
    kind === vscode.SymbolKind.Namespace || kind === vscode.SymbolKind.Module ||
    kind === vscode.SymbolKind.Object;
}

function isIncludedKind(kind) {
  const kinds = new Set(vscode.workspace.getConfiguration('workspaceMethodSearch')
    .get('includeKinds', ['method','function','constructor']).map(v => String(v).toLowerCase()));
  return (kind === vscode.SymbolKind.Method && kinds.has('method')) ||
    (kind === vscode.SymbolKind.Function && kinds.has('function')) ||
    (kind === vscode.SymbolKind.Constructor && kinds.has('constructor'));
}

function normalizeSymbol(uri, symbol, containers) {
  return makeRow(uri, symbol.name || '', containers.join('.'), symbol.detail || '', symbol.selectionRange || symbol.range);
}

function makeRow(uri, methodName, containerName, detail, range) {
  const qualifiedName = containerName ? `${containerName}.${methodName}` : methodName;
  const relativePath = relativeDisplayPath(uri);
  const filename = basename(uri.path);
  const bareMethodName = extractBareMethodName(methodName);
  const parameterTypes = extractParameterSearchText(methodName);
  return {
    uri: uri.toString(), methodName, bareMethodName, containerName, qualifiedName, detail,
    relativePath, filename, parameterTypes,
    line: range.start.line + 1, character: range.start.character,

    // Deliberately keep the searchable fields explicit. JDT symbol.detail is
    // presentation metadata and can contain text that is not visible in the row;
    // it must never make an unrelated method eligible for a search result.
    searchMethod: bareMethodName,
    searchSignature: methodName,
    searchContainer: containerName,
    searchParameters: parameterTypes,
    searchPath: `${filename} ${relativePath}`
  };
}

function extractBareMethodName(methodName) {
  const text = String(methodName || '').trim();
  const paren = text.indexOf('(');
  return (paren >= 0 ? text.slice(0, paren) : text).trim();
}

function extractParameterSearchText(methodName) {
  const text = String(methodName || '');
  const open = text.indexOf('(');
  if (open < 0) return '';
  const close = text.lastIndexOf(')');
  if (close <= open) return '';
  return text.slice(open + 1, close).trim();
}

function dedupeSymbols(symbols) {
  const seen = new Set(), result = [];
  for (const item of symbols) {
    const key = `${item.uri}|${item.line}|${item.character}|${item.methodName}`;
    if (!seen.has(key)) { seen.add(key); result.push(item); }
  }
  return result;
}

function rankSymbols(symbols, query, maxResults) {
  if (!query) {
    return symbols.slice().sort(defaultSymbolOrder).slice(0, maxResults).map(item => ({ item, score: 0, tier: 0 }));
  }

  const terms = query.split(/\s+/).filter(Boolean);
  const results = [];

  for (const item of symbols) {
    let total = 0;
    let weakestTier = 4;
    let matched = true;
    let hasMethodNameMatch = false;

    for (const term of terms) {
      const match = bestFieldMatch(term, item);
      if (!match) { matched = false; break; }
      if (match.field === 'method') hasMethodNameMatch = true;
      total += match.score;
      weakestTier = Math.min(weakestTier, match.tier);
    }

    // A workspace-method search must actually identify the method. Secondary
    // fields may refine a result (e.g. "ord save"), but class/signature/path
    // matches alone are never sufficient to make an unrelated method eligible.
    if (!matched || !hasMethodNameMatch) continue;

    // Tier is sorted before score. Therefore a method-name match can never be
    // displaced by a stronger class/parameter/path-only fuzzy score.
    results.push({
      item,
      tier: weakestTier,
      score: total + exactnessBonus(query, item)
    });
  }

  results.sort((a,b) =>
    b.tier - a.tier ||
    b.score - a.score ||
    defaultSymbolOrder(a.item,b.item));
  return results.slice(0, maxResults);
}

function bestFieldMatch(term, item) {
  const method = fuzzyFieldScore(term, item.searchMethod);
  if (method >= 0) return { field: 'method', tier: 4, score: method + methodMatchBonus(term, item.bareMethodName) };

  // Signature is intentionally below the bare method name. This permits a
  // parameter-like query to match text present in the symbol label without
  // allowing it to outrank an actual method-name match.
  const signature = fuzzyFieldScore(term, item.searchSignature);
  if (signature >= 0) return { field: 'signature', tier: 3, score: signature };

  const container = fuzzyFieldScore(term, item.searchContainer);
  if (container >= 0) return { field: 'container', tier: 2, score: container };

  const parameters = fuzzyFieldScore(term, item.searchParameters);
  if (parameters >= 0) return { field: 'parameters', tier: 1, score: parameters };

  const path = fuzzyFieldScore(term, item.searchPath);
  if (path >= 0) return { field: 'path', tier: 0, score: path };

  return null;
}

function methodMatchBonus(query, methodName) {
  const q = String(query || '').toLowerCase();
  const method = String(methodName || '').toLowerCase();
  if (!q || !method) return 0;
  if (method === q) return 5000;
  if (method.startsWith(q)) return 1800;
  return 0;
}

function defaultSymbolOrder(a,b) {
  return a.methodName.localeCompare(b.methodName) || a.containerName.localeCompare(b.containerName) ||
    a.relativePath.localeCompare(b.relativePath) || a.line - b.line;
}

function exactnessBonus(query,item) {
  const q = String(query || '').trim().toLowerCase();
  const method = String(item.bareMethodName || '').toLowerCase();
  const qualified = item.containerName ? `${item.containerName}.${item.bareMethodName}`.toLowerCase() : method;
  if(method===q) return 8000;
  if(qualified===q) return 6000;
  if(method.startsWith(q)) return 2500;
  if(qualified.startsWith(q)) return 1600;
  return 0;
}

// Same scorer contract/implementation used by Recent Buffers.
const FUZZY_CHAR_SCORE = 100;
const FUZZY_CONSECUTIVE_BONUS = 85;
const FUZZY_BOUNDARY_BONUS = 70;
const FUZZY_FIRST_BOUNDARY_BONUS = 180;
const FUZZY_GAP_OPEN_PENALTY = 65;
const FUZZY_GAP_EXTEND_PENALTY = 12;
const FUZZY_SPAN_PENALTY = 4;

function fuzzyFieldScore(query, candidate) {
  if (!query || !candidate) return -1;
  const q=query.toLowerCase(), c=candidate.toLowerCase();
  let previous=new Map();
  for(let ci=0;ci<candidate.length;ci++) {
    if(c[ci]!==q[0]) continue;
    previous.set(ci,{score:FUZZY_CHAR_SCORE+(semanticBoundary(candidate,ci)?FUZZY_FIRST_BOUNDARY_BONUS:0),first:ci,last:ci,gaps:0,gapOpens:0});
  }
  if(!previous.size) return -1;
  for(let qi=1;qi<q.length;qi++) {
    const current=new Map();
    for(let ci=0;ci<candidate.length;ci++) {
      if(c[ci]!==q[qi]) continue;
      let best=null;
      for(const [pi,state] of previous) {
        if(pi>=ci) continue;
        const gapLength=ci-pi-1;
        let score=state.score+FUZZY_CHAR_SCORE, gaps=state.gaps, gapOpens=state.gapOpens;
        if(gapLength===0) score+=FUZZY_CONSECUTIVE_BONUS;
        else { gapOpens++; gaps+=gapLength; score-=FUZZY_GAP_OPEN_PENALTY; score-=Math.max(0,gapLength-1)*FUZZY_GAP_EXTEND_PENALTY; }
        if(semanticBoundary(candidate,ci)) score+=FUZZY_BOUNDARY_BONUS;
        const next={score,first:state.first,last:ci,gaps,gapOpens};
        if(betterFuzzyState(next,best)) best=next;
      }
      if(best) current.set(ci,best);
    }
    if(!current.size) return -1;
    previous=current;
  }
  let best=null;
  for(const state of previous.values()) {
    const span=state.last-state.first+1;
    const finalized={...state,score:state.score-Math.max(0,span-q.length)*FUZZY_SPAN_PENALTY};
    if(betterFuzzyState(finalized,best)) best=finalized;
  }
  return best?best.score:-1;
}
function betterFuzzyState(a,b){if(!b)return true;if(a.score!==b.score)return a.score>b.score;const as=a.last-a.first+1,bs=b.last-b.first+1;if(as!==bs)return as<bs;if(a.gapOpens!==b.gapOpens)return a.gapOpens<b.gapOpens;if(a.gaps!==b.gaps)return a.gaps<b.gaps;if(a.first!==b.first)return a.first<b.first;return a.last<b.last;}
function semanticBoundary(candidate,index){if(index===0)return true;const p=candidate[index-1],c=candidate[index];if('/\\-_. \t\r\n'.includes(p))return true;if(isLower(p)&&isUpper(c))return true;if(isLetter(p)&&isDigit(c))return true;if(isDigit(p)&&isLetter(c))return true;return false;}
function isLower(ch){return ch>='a'&&ch<='z';} function isUpper(ch){return ch>='A'&&ch<='Z';} function isLetter(ch){return isLower(ch)||isUpper(ch);} function isDigit(ch){return ch>='0'&&ch<='9';}

function relativeDisplayPath(uri) {
  const folder=vscode.workspace.getWorkspaceFolder(uri);
  if(!folder) return uri.fsPath||uri.path;
  const rel=vscode.workspace.asRelativePath(uri,false);
  return (vscode.workspace.workspaceFolders?.length||0)>1?`${folder.name}/${rel}`:rel;
}
function basename(p){const normalized=p.replace(/\\/g,'/');return normalized.slice(normalized.lastIndexOf('/')+1)||normalized;}
function closePanel(){if(activePanel)activePanel.dispose();activePanel=undefined;}

function getWebviewHtml() {
  const nonce=String(Date.now());
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';"><title>Workspace Methods</title>
<style>
*{box-sizing:border-box}html,body{height:100%;margin:0}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size,13px);color:var(--vscode-foreground);background:var(--vscode-editor-background);overflow:hidden}.stage{height:100%;width:100%;display:flex;padding:0;background:var(--vscode-quickInput-background,var(--vscode-editorWidget-background))}.shell{width:100%;height:100%;display:flex;flex-direction:column;background:var(--vscode-quickInput-background,var(--vscode-editorWidget-background));border:0;overflow:hidden}.header{padding:12px 16px 8px;border-bottom:1px solid var(--vscode-widget-border,#ffffff18)}.titleRow{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.title{font-size:18px;font-weight:650;letter-spacing:.1px}.close{border:0;background:transparent;color:var(--vscode-foreground);opacity:.72;font-size:22px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:4px}.close:hover{background:var(--vscode-toolbar-hoverBackground);opacity:1}.searchWrap{position:relative}.search{width:100%;height:40px;padding:0 96px 0 13px;font-family:var(--vscode-font-family);font-size:14px;line-height:1.4;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-focusBorder);outline:none;border-radius:5px}.shortcut{position:absolute;right:8px;top:6px;color:var(--vscode-descriptionForeground);border:1px solid var(--vscode-widget-border,#ffffff24);border-radius:5px;padding:3px 8px;font-size:12px;background:var(--vscode-keybindingLabel-background,#ffffff0b)}.notice{display:none;padding:8px 18px;font-size:12px;color:var(--vscode-descriptionForeground);border-bottom:1px solid var(--vscode-widget-border,#ffffff12)}.notice.show{display:block}.content{min-height:0;flex:1 1 auto;overflow:auto;padding:4px 0;scrollbar-gutter:stable}.sectionHeader{display:flex;align-items:center;justify-content:space-between;padding:7px 16px 6px;color:var(--vscode-descriptionForeground);font-size:12px;font-weight:650;letter-spacing:.5px;text-transform:uppercase}.row{position:relative;display:grid;grid-template-columns:minmax(260px,380px) minmax(220px,1fr) 80px;align-items:center;gap:10px;min-height:42px;padding:2px 12px 2px 14px;margin:0 8px;border-radius:5px;cursor:pointer}.row:hover{background:var(--vscode-list-hoverBackground)}.row.active{background:color-mix(in srgb,var(--vscode-list-activeSelectionBackground) 74%,transparent);color:var(--vscode-list-activeSelectionForeground)}.row::before{content:'';position:absolute;left:0;top:5px;bottom:5px;width:3px;border-radius:2px;background:transparent}.row.active::before{background:var(--vscode-focusBorder,var(--vscode-list-activeSelectionForeground))}.name{display:flex;align-items:center;gap:8px;min-width:0;font-size:13px;line-height:1.35;font-weight:600}.methodIcon{width:16px;text-align:center;flex:0 0 16px;color:var(--vscode-symbolIcon-methodForeground,var(--vscode-descriptionForeground))}.method,.path,.detail{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.detail{font-weight:400;color:var(--vscode-descriptionForeground);margin-left:6px;font-size:11.5px}.path{color:var(--vscode-descriptionForeground);font-size:11.5px;direction:rtl;text-align:left;unicode-bidi:plaintext}.pathInner{direction:ltr;unicode-bidi:plaintext}.location{font-family:var(--vscode-editor-font-family,monospace);font-size:11px;color:var(--vscode-foreground);opacity:.9}.location::before{content:'⌖ ';opacity:.8}.row.active .path,.row.active .detail{color:color-mix(in srgb,var(--vscode-list-activeSelectionForeground) 72%,transparent)}.empty{padding:44px 16px;text-align:center;color:var(--vscode-descriptionForeground)}.empty strong{display:block;color:var(--vscode-foreground);margin-bottom:7px;font-size:14px}.footer{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 12px 8px;border-top:1px solid var(--vscode-widget-border,#ffffff18);color:var(--vscode-descriptionForeground);font-size:12px}.keys{display:flex;flex-wrap:wrap;gap:12px}kbd{font:inherit;color:var(--vscode-foreground);background:var(--vscode-keybindingLabel-background,#ffffff0d);border:1px solid var(--vscode-keybindingLabel-border,#ffffff22);border-bottom-color:var(--vscode-keybindingLabel-bottomBorder,#ffffff35);border-radius:4px;padding:2px 6px;margin-right:5px}@media(max-width:850px){.row{grid-template-columns:minmax(210px,1fr) minmax(150px,1fr) 70px}.detail{display:none}}
</style></head><body><div class="stage"><main class="shell"><div class="header"><div class="titleRow"><div class="title">Workspace Methods</div><button class="close" id="close" title="Close">×</button></div><div class="searchWrap"><input id="search" class="search" autocomplete="off" spellcheck="false" autofocus placeholder="Search methods, classes, or paths..."><span class="shortcut">Ctrl+Shift+M</span></div></div><div class="notice" id="notice"></div><section class="content" id="content"></section><footer class="footer"><div class="keys"><span><kbd>Ctrl+J / Ctrl+K</kbd>move</span><span><kbd>Enter</kbd>open</span><span><kbd>Esc</kbd>cancel</span></div><div id="status">Method index loads on first use</div></footer></main></div>
<script nonce="${nonce}">(()=>{const vscode=acquireVsCodeApi(),search=document.getElementById('search'),content=document.getElementById('content'),notice=document.getElementById('notice'),status=document.getElementById('status');let state={query:'',rows:[],totalIndexed:0,building:false},selected=0,timer;
const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));
function request(){clearTimeout(timer);timer=setTimeout(()=>vscode.postMessage({type:'search',query:search.value}),80)}
function render(){selected=Math.max(0,Math.min(selected,state.rows.length-1));const count=state.rows.length;let body;if(count){body='<div class="sectionHeader"><span>Methods</span><span>'+count+' items</span></div>'+state.rows.map((r,i)=>'<div class="row '+(i===selected?'active':'')+'" data-index="'+i+'"><div class="name"><span class="methodIcon">ƒ</span><span class="method">'+esc(r.qualifiedName||r.methodName)+(r.detail?'<span class="detail">'+esc(r.detail)+'</span>':'')+'</span></div><div class="path" title="'+esc(r.relativePath)+'"><span class="pathInner">'+esc(r.relativePath)+'</span></div><div class="location">'+esc(r.line)+'</div></div>').join('')}else{body='<div class="empty"><strong>'+(state.building?'Indexing workspace methods…':'No matching methods')+'</strong>'+(state.building?'Results will appear as source files are indexed.':'Try a method name, class name, or path.')+'</div>'}content.innerHTML=body;content.querySelector('.row.active')?.scrollIntoView({block:'nearest'});}
function moveSelection(delta){if(!state.rows.length)return;selected=(selected+delta+state.rows.length)%state.rows.length;render()}
function openSelected(){if(state.rows[selected])vscode.postMessage({type:'open',query:search.value,index:selected})}
search.addEventListener('input',()=>{selected=0;request()});search.addEventListener('keydown',e=>{const key=e.key.toLowerCase();if((e.ctrlKey||e.metaKey)&&key==='j'){e.preventDefault();e.stopPropagation();moveSelection(1)}else if((e.ctrlKey||e.metaKey)&&key==='k'){e.preventDefault();e.stopPropagation();moveSelection(-1)}else if(e.key==='ArrowDown'){e.preventDefault();moveSelection(1)}else if(e.key==='ArrowUp'){e.preventDefault();moveSelection(-1)}else if(e.key==='Enter'){e.preventDefault();openSelected()}else if(e.key==='Escape'){e.preventDefault();vscode.postMessage({type:'close'})}});document.getElementById('close').addEventListener('click',()=>vscode.postMessage({type:'close'}));content.addEventListener('mousemove',e=>{const row=e.target.closest('.row');if(!row)return;const i=Number(row.dataset.index);if(i!==selected){selected=i;render()}});content.addEventListener('click',e=>{const row=e.target.closest('.row');if(row){selected=Number(row.dataset.index);openSelected()}});
window.addEventListener('message',e=>{const m=e.data;if(m.type==='state'){state={...state,...m};if(document.activeElement!==search&&typeof m.query==='string')search.value=m.query;render()}else if(m.type==='indexStatus'){state.building=!!m.building;notice.className='notice';if(m.error){notice.textContent=m.error;notice.className='notice show'}status.textContent=m.building?'Indexing '+m.indexedFiles+' / '+m.files+' files · '+m.methods+' methods':m.methods+' methods · '+m.indexedFiles+' files indexed';render()}else if(m.type==='focusSearch')claimFocus();else if(m.type==='moveSelection'){moveSelection(Number(m.delta)<0?-1:1);claimFocus()}});
function claimFocus(){try{search.focus({preventScroll:true});const end=search.value.length;search.setSelectionRange(end,end)}catch(_){try{search.focus()}catch(_){}}}claimFocus();requestAnimationFrame(claimFocus);requestAnimationFrame(()=>requestAnimationFrame(claimFocus));setTimeout(claimFocus,0);setTimeout(claimFocus,20);setTimeout(claimFocus,60);window.addEventListener('focus',claimFocus);document.addEventListener('visibilitychange',()=>{if(!document.hidden)claimFocus()});vscode.postMessage({type:'ready'});})();</script></body></html>`;
}

function logError(error){console.error('[workspace-method-search]',error);vscode.window.showErrorMessage(`Workspace Method Search: ${error?.message||error}`);}
module.exports={activate,deactivate,_test:{fuzzyFieldScore,rankSymbols}};
