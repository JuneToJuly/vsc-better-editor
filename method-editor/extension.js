const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');

const METHOD_KINDS = new Set([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor
]);

class MethodFileSystemProvider {
  constructor(states) {
    this.states = states;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
  }

  watch() { return new vscode.Disposable(() => {}); }

  stat(uri) {
    const state = this.states.get(uri.toString());
    if (!state) throw vscode.FileSystemError.FileNotFound(uri);
    return {
      type: vscode.FileType.File,
      ctime: state.created,
      mtime: state.mtime,
      size: Buffer.byteLength(state.content)
    };
  }

  readDirectory() { return []; }
  createDirectory() {}

  readFile(uri) {
    const state = this.states.get(uri.toString());
    if (!state) throw vscode.FileSystemError.FileNotFound(uri);
    return Buffer.from(state.content, 'utf8');
  }

  writeFile(uri, content) {
    const state = this.states.get(uri.toString());
    if (!state) throw vscode.FileSystemError.FileNotFound(uri);
    state.content = Buffer.from(content).toString('utf8');
    state.mtime = Date.now();
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }

  delete(uri) { this.states.delete(uri.toString()); }

  rename(oldUri, newUri) {
    const state = this.states.get(oldUri.toString());
    if (!state) throw vscode.FileSystemError.FileNotFound(oldUri);
    this.states.delete(oldUri.toString());
    this.states.set(newUri.toString(), state);
  }

  fireChanged(uri) {
    this._emitter.fire([{ type: vscode.FileChangeType.Changed, uri }]);
  }
}

function flattenSymbols(symbols, out = []) {
  for (const symbol of symbols || []) {
    if (METHOD_KINDS.has(symbol.kind)) out.push(symbol);
    if (symbol.children?.length) flattenSymbols(symbol.children, out);
  }
  return out.sort((a, b) => a.range.start.compareTo(b.range.start));
}

function normalizeSymbolRange(symbol) {
  return symbol?.range || symbol?.location?.range;
}

function normalizeSymbol(symbol) {
  const range = normalizeSymbolRange(symbol);
  if (!range) return undefined;
  return {
    name: symbol.name,
    detail: symbol.detail || '',
    kind: symbol.kind,
    range,
    selectionRange: symbol.selectionRange || range,
    children: symbol.children || []
  };
}

function maskJavaNonCode(text) {
  const chars = text.split('');
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '/' && chars[i + 1] === '/') {
      chars[i++] = ' '; chars[i++] = ' ';
      while (i < chars.length && chars[i] !== '\n') chars[i++] = ' ';
      continue;
    }
    if (chars[i] === '/' && chars[i + 1] === '*') {
      chars[i++] = ' '; chars[i++] = ' ';
      while (i < chars.length) {
        if (chars[i] === '*' && chars[i + 1] === '/') {
          chars[i++] = ' '; chars[i++] = ' ';
          break;
        }
        if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
        i++;
      }
      continue;
    }
    if (chars[i] === '"' || chars[i] === "'") {
      const quote = chars[i];
      chars[i++] = ' ';
      while (i < chars.length) {
        if (chars[i] === '\\') {
          chars[i++] = ' ';
          if (i < chars.length && chars[i] !== '\n' && chars[i] !== '\r') chars[i++] = ' ';
          continue;
        }
        if (chars[i] === quote) { chars[i++] = ' '; break; }
        if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
        i++;
      }
      continue;
    }
    i++;
  }
  return chars.join('');
}

function getJavaFallbackMethods(document) {
  const text = document.getText();
  const masked = maskJavaNonCode(text);
  const methods = [];
  const controlWords = new Set(['if','for','while','switch','catch','synchronized','try','else','do','new']);

  for (let brace = 0; brace < masked.length; brace++) {
    if (masked[brace] !== '{') continue;

    let p = brace - 1;
    while (p >= 0 && /\s/.test(masked[p])) p--;
    if (p < 0 || masked[p] !== ')') continue;

    let depth = 1;
    let openParen = p - 1;
    for (; openParen >= 0; openParen--) {
      if (masked[openParen] === ')') depth++;
      else if (masked[openParen] === '(' && --depth === 0) break;
    }
    if (openParen < 0) continue;

    let nameEnd = openParen - 1;
    while (nameEnd >= 0 && /\s/.test(masked[nameEnd])) nameEnd--;
    let nameStart = nameEnd;
    while (nameStart >= 0 && /[A-Za-z0-9_$]/.test(masked[nameStart])) nameStart--;
    nameStart++;
    const name = masked.slice(nameStart, nameEnd + 1);
    if (!name || controlWords.has(name)) continue;

    // Reject calls/anonymous constructs: a declaration name should not be preceded by '.', '::', or 'new'.
    let before = nameStart - 1;
    while (before >= 0 && /\s/.test(masked[before])) before--;
    if (masked[before] === '.' || masked.slice(Math.max(0, before - 1), before + 1) === '::') continue;
    const prefix = masked.slice(Math.max(0, nameStart - 8), nameStart).trim();
    if (/\bnew\s*$/.test(prefix)) continue;

    // Find the matching method closing brace. Nested switch/if/lambda/class braces are naturally counted.
    let bdepth = 1;
    let endBrace = brace + 1;
    for (; endBrace < masked.length; endBrace++) {
      if (masked[endBrace] === '{') bdepth++;
      else if (masked[endBrace] === '}' && --bdepth === 0) break;
    }
    if (endBrace >= masked.length) continue;

    // Start at the beginning of the declaration line (including indentation/annotations on that line).
    let declStart = masked.lastIndexOf('\n', nameStart - 1) + 1;
    while (declStart > 0) {
      const prevLineEnd = declStart - 1;
      const prevLineStart = masked.lastIndexOf('\n', prevLineEnd - 1) + 1;
      const prevLine = masked.slice(prevLineStart, prevLineEnd).trim();
      if (!prevLine.startsWith('@')) break;
      declStart = prevLineStart;
    }

    methods.push({
      name,
      detail: '',
      kind: vscode.SymbolKind.Method,
      range: new vscode.Range(document.positionAt(declStart), document.positionAt(endBrace + 1)),
      selectionRange: new vscode.Range(document.positionAt(nameStart), document.positionAt(nameEnd + 1)),
      children: []
    });
    brace = endBrace;
  }
  return methods;
}

async function getMethods(document) {
  const rawSymbols = await vscode.commands.executeCommand(
    'vscode.executeDocumentSymbolProvider',
    document.uri
  );
  const providerMethods = flattenSymbols(rawSymbols || [])
    .map(normalizeSymbol)
    .filter(Boolean);

  if (document.languageId !== 'java') {
    return providerMethods.sort((a, b) => a.range.start.compareTo(b.range.start));
  }

  // JDT is the preferred source. The lexical fallback covers temporary parse errors
  // and constructs where the symbol provider omits a method while the file is being edited.
  const fallbackMethods = getJavaFallbackMethods(document);
  const merged = [...providerMethods];
  for (const fallback of fallbackMethods) {
    const duplicate = merged.some(method =>
      method.name === fallback.name &&
      Math.abs(method.range.start.line - fallback.range.start.line) <= 1
    );
    if (!duplicate) merged.push(fallback);
  }
  return merged.sort((a, b) => a.range.start.compareTo(b.range.start));
}

function containsPosition(range, position) {
  return range.contains(position) || range.end.isEqual(position);
}

function normalizeName(symbol) {
  return `${symbol.name}|${symbol.detail || ''}`;
}

function makeMethodUri(sourceUri, symbol) {
  const id = crypto.randomBytes(6).toString('hex');
  const ext = path.extname(sourceUri.fsPath || sourceUri.path) || '.txt';
  const safe = symbol.name.replace(/[^a-zA-Z0-9_$.-]+/g, '_').slice(0, 80) || 'method';
  return vscode.Uri.from({
    scheme: 'method',
    path: `/${safe}${ext}`,
    query: `id=${id}`
  });
}

function entryFromSymbol(sourceUri, symbol) {
  return {
    sourceUri,
    symbolName: symbol.name,
    symbolKey: normalizeName(symbol),
    lastStartLine: symbol.range.start.line
  };
}

async function findFreshSymbolForEntry(entry) {
  const doc = await vscode.workspace.openTextDocument(entry.sourceUri);
  const methods = await getMethods(doc);
  let candidates = methods.filter(method => normalizeName(method) === entry.symbolKey);
  if (!candidates.length) {
    candidates = methods.filter(method => method.name === entry.symbolName);
  }
  if (!candidates.length) return { doc, symbol: undefined, methods };

  candidates.sort((a, b) =>
    Math.abs(a.range.start.line - entry.lastStartLine) -
    Math.abs(b.range.start.line - entry.lastStartLine)
  );
  return { doc, symbol: candidates[0], methods };
}

async function activate(context) {
  const states = new Map();
  const sourceToVirtual = new Map();
  const provider = new MethodFileSystemProvider(states);

  let applyingSourceEdit = false;
  let applyingVirtualRefresh = false;
  let history = [];
  let historyIndex = -1;
  let sessionUri;
  let switchingMethod = false;

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('method', provider, { isCaseSensitive: true })
  );

  function resetHistory() {
    history = [];
    historyIndex = -1;
  }

  function pushHistory(sourceUri, symbol) {
    if (historyIndex < history.length - 1) {
      history = history.slice(0, historyIndex + 1);
    }
    const next = entryFromSymbol(sourceUri, symbol);
    const current = history[historyIndex];
    if (
      current &&
      current.sourceUri.toString() === next.sourceUri.toString() &&
      current.symbolKey === next.symbolKey &&
      current.lastStartLine === next.lastStartLine
    ) {
      return;
    }
    history.push(next);
    historyIndex = history.length - 1;
  }

  async function openSymbol(sourceDoc, symbol, options = {}) {
    const content = sourceDoc.getText(symbol.range);

    if (!sessionUri || !states.has(sessionUri.toString())) {
      const ext = path.extname(sourceDoc.uri.fsPath || sourceDoc.uri.path) || '.txt';
      sessionUri = vscode.Uri.from({
        scheme: 'method',
        path: `/Method-Editor${ext}`,
        query: `session=${crypto.randomBytes(6).toString('hex')}`
      });
      states.set(sessionUri.toString(), {
        sourceUri: sourceDoc.uri,
        symbolName: symbol.name,
        symbolKey: normalizeName(symbol),
        lastStartLine: symbol.range.start.line,
        content,
        languageId: sourceDoc.languageId,
        created: Date.now(),
        mtime: Date.now()
      });
      if (!sourceToVirtual.has(sourceDoc.uri.toString())) {
        sourceToVirtual.set(sourceDoc.uri.toString(), new Set());
      }
      sourceToVirtual.get(sourceDoc.uri.toString()).add(sessionUri.toString());

      if (options.recordHistory !== false) pushHistory(sourceDoc.uri, symbol);

      let methodDoc = await vscode.workspace.openTextDocument(sessionUri);
      if (methodDoc.languageId !== sourceDoc.languageId) {
        methodDoc = await vscode.languages.setTextDocumentLanguage(methodDoc, sourceDoc.languageId);
      }
      const editor = await vscode.window.showTextDocument(methodDoc, {
        preview: false,
        preserveFocus: false,
        viewColumn: options.viewColumn || vscode.ViewColumn.Active
      });
      editor.options = {
        ...editor.options,
        lineNumbers: 'on',
        minimap: { enabled: false },
        glyphMargin: false,
        folding: false
      };
      return editor;
    }

    const state = states.get(sessionUri.toString());
    const oldSourceKey = state.sourceUri.toString();
    const newSourceKey = sourceDoc.uri.toString();
    if (oldSourceKey !== newSourceKey) {
      sourceToVirtual.get(oldSourceKey)?.delete(sessionUri.toString());
      if (!sourceToVirtual.has(newSourceKey)) sourceToVirtual.set(newSourceKey, new Set());
      sourceToVirtual.get(newSourceKey).add(sessionUri.toString());
    }

    state.sourceUri = sourceDoc.uri;
    state.symbolName = symbol.name;
    state.symbolKey = normalizeName(symbol);
    state.lastStartLine = symbol.range.start.line;
    state.languageId = sourceDoc.languageId;
    state.content = content;
    state.mtime = Date.now();

    if (options.recordHistory !== false) pushHistory(sourceDoc.uri, symbol);

    let methodDoc = vscode.workspace.textDocuments.find(d => d.uri.toString() === sessionUri.toString());
    if (!methodDoc) methodDoc = await vscode.workspace.openTextDocument(sessionUri);
    if (methodDoc.languageId !== sourceDoc.languageId) {
      methodDoc = await vscode.languages.setTextDocumentLanguage(methodDoc, sourceDoc.languageId);
    }

    switchingMethod = true;
    try {
      const fullRange = new vscode.Range(
        methodDoc.positionAt(0),
        methodDoc.positionAt(methodDoc.getText().length)
      );
      const edit = new vscode.WorkspaceEdit();
      edit.replace(sessionUri, fullRange, content);
      await vscode.workspace.applyEdit(edit);
    } finally {
      switchingMethod = false;
    }

    const editor = vscode.window.activeTextEditor?.document.uri.toString() === sessionUri.toString()
      ? vscode.window.activeTextEditor
      : await vscode.window.showTextDocument(methodDoc, {
          preview: false,
          preserveFocus: false,
          viewColumn: options.viewColumn || vscode.ViewColumn.Active
        });

    editor.selection = new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0));
    editor.revealRange(new vscode.Range(0, 0, 0, 0), vscode.TextEditorRevealType.AtTop);
    return editor;
  }

  async function replaceCurrentMethod(sourceDoc, symbol, options = {}) {
    return openSymbol(sourceDoc, symbol, {
      viewColumn: vscode.window.activeTextEditor?.viewColumn || vscode.ViewColumn.Active,
      recordHistory: options.recordHistory !== false
    });
  }

  async function openMethodAtCursorInCurrentEditor(sourceDoc, symbol, options = {}) {
    return replaceCurrentMethod(sourceDoc, symbol, {
      recordHistory: options.recordHistory !== false
    });
  }

  async function getActiveMethodContext() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'method') return undefined;
    const state = states.get(editor.document.uri.toString());
    if (!state) return undefined;
    const fresh = await findFreshSymbolForEntry(state);
    if (!fresh.symbol) return undefined;
    return { editor, state, sourceDoc: fresh.doc, symbol: fresh.symbol };
  }

  async function enterMethodEditor() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    if (editor.document.uri.scheme === 'method') return;

    const methods = await getMethods(editor.document);
    if (!methods.length) {
      vscode.window.showInformationMessage('Method Editor: no methods found in this document.');
      return;
    }

    const position = editor.selection.active;
    const symbol = methods.find(method => containsPosition(method.range, position));
    if (!symbol) {
      vscode.window.showInformationMessage('Place the cursor inside a method first.');
      return;
    }

    resetHistory();
    await openSymbol(editor.document, symbol, { viewColumn: editor.viewColumn });
  }

  function sourcePositionForVirtualCursor(sourceDoc, symbol, virtualDoc, virtualPosition) {
    const methodStartOffset = sourceDoc.offsetAt(symbol.range.start);
    const cursorOffsetInsideMethod = virtualDoc.offsetAt(virtualPosition);
    return sourceDoc.positionAt(methodStartOffset + cursorOffsetInsideMethod);
  }

  function normalizeDefinition(definition) {
    if (!definition) return undefined;
    if (definition.targetUri) {
      return {
        uri: definition.targetUri,
        range: definition.targetSelectionRange || definition.targetRange
      };
    }
    if (definition.uri && definition.range) {
      return { uri: definition.uri, range: definition.range };
    }
    return undefined;
  }

  async function enterMethodAtCursor() {
    const context = await getActiveMethodContext();
    if (!context) {
      vscode.window.showInformationMessage('Enter Method Editor first.');
      return;
    }

    const sourcePosition = sourcePositionForVirtualCursor(
      context.sourceDoc,
      context.symbol,
      context.editor.document,
      context.editor.selection.active
    );

    const rawDefinitions = await vscode.commands.executeCommand(
      'vscode.executeDefinitionProvider',
      context.sourceDoc.uri,
      sourcePosition
    );
    const definitions = Array.isArray(rawDefinitions)
      ? rawDefinitions
      : rawDefinitions
        ? [rawDefinitions]
        : [];

    for (const raw of definitions) {
      const definition = normalizeDefinition(raw);
      if (!definition) continue;
      let targetDoc;
      try {
        targetDoc = await vscode.workspace.openTextDocument(definition.uri);
      } catch {
        continue;
      }
      const methods = await getMethods(targetDoc);
      const targetPosition = definition.range.start;
      const targetMethod = methods.find(method => containsPosition(method.range, targetPosition));
      if (!targetMethod) continue;

      const sameMethod =
        targetDoc.uri.toString() === context.sourceDoc.uri.toString() &&
        targetMethod.range.isEqual(context.symbol.range);
      if (sameMethod) continue;

      await openMethodAtCursorInCurrentEditor(targetDoc, targetMethod);
      return;
    }

    vscode.window.showInformationMessage('Method Editor: no method definition found at the cursor.');
  }

  async function navigateSibling(delta) {
    const context = await getActiveMethodContext();
    if (!context) return;
    const methods = await getMethods(context.sourceDoc);
    let index = methods.findIndex(method => method.range.isEqual(context.symbol.range));
    if (index < 0) {
      index = methods.findIndex(method => method.name === context.state.symbolName);
    }
    if (index < 0) return;

    const targetIndex = Math.max(0, Math.min(methods.length - 1, index + delta));
    if (targetIndex === index) return;
    await replaceCurrentMethod(context.sourceDoc, methods[targetIndex]);
  }

  async function navigateHistory(delta) {
    if (!history.length) return;
    const nextIndex = historyIndex + delta;
    if (nextIndex < 0 || nextIndex >= history.length) return;

    const target = history[nextIndex];
    const fresh = await findFreshSymbolForEntry(target);
    if (!fresh.symbol) {
      vscode.window.showWarningMessage(`Method Editor could not relocate ${target.symbolName}.`);
      return;
    }

    historyIndex = nextIndex;
    history[historyIndex] = entryFromSymbol(fresh.doc.uri, fresh.symbol);
    await replaceCurrentMethod(fresh.doc, fresh.symbol, { recordHistory: false });
  }

  async function pickMethod() {
    const context = await getActiveMethodContext();
    if (!context) return;
    const methods = await getMethods(context.sourceDoc);
    const picked = await vscode.window.showQuickPick(
      methods.map(method => ({
        label: `$(symbol-method) ${method.name}`,
        description: `line ${method.range.start.line + 1}`,
        method
      })),
      {
        placeHolder: `Open a method from ${path.basename(context.sourceDoc.uri.fsPath || context.sourceDoc.uri.path)}`,
        matchOnDescription: true
      }
    );
    if (picked) await replaceCurrentMethod(context.sourceDoc, picked.method);
  }

  async function exitMethodEditor() {
    const context = await getActiveMethodContext();
    if (!context) return;
    const viewColumn = context.editor.viewColumn;
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    const sourceEditor = await vscode.window.showTextDocument(context.sourceDoc, {
      preview: false,
      viewColumn
    });
    sourceEditor.selection = new vscode.Selection(context.symbol.range.start, context.symbol.range.start);
    sourceEditor.revealRange(context.symbol.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    resetHistory();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('methodEditor.enter', enterMethodEditor),
    vscode.commands.registerCommand('methodEditor.enterMethodAtCursor', enterMethodAtCursor),
    vscode.commands.registerCommand('methodEditor.back', () => navigateHistory(-1)),
    vscode.commands.registerCommand('methodEditor.forward', () => navigateHistory(1)),
    vscode.commands.registerCommand('methodEditor.nextMethod', () => navigateSibling(1)),
    vscode.commands.registerCommand('methodEditor.previousMethod', () => navigateSibling(-1)),
    vscode.commands.registerCommand('methodEditor.pickMethod', pickMethod),
    vscode.commands.registerCommand('methodEditor.exit', exitMethodEditor),
    // Compatibility aliases from 0.1.x.
    vscode.commands.registerCommand('methodEditor.openCurrentMethod', enterMethodEditor),
    vscode.commands.registerCommand('methodEditor.openSource', exitMethodEditor)
  );

  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(async event => {
    if (applyingSourceEdit || applyingVirtualRefresh || switchingMethod) return;

    if (event.document.uri.scheme === 'method') {
      const state = states.get(event.document.uri.toString());
      if (!state) return;
      const fresh = await findFreshSymbolForEntry(state);
      if (!fresh.symbol) return;

      const nextContent = event.document.getText();
      const edit = new vscode.WorkspaceEdit();
      edit.replace(state.sourceUri, fresh.symbol.range, nextContent);

      applyingSourceEdit = true;
      try {
        await vscode.workspace.applyEdit(edit);
        state.content = nextContent;
        state.lastStartLine = fresh.symbol.range.start.line;
        state.mtime = Date.now();
      } finally {
        applyingSourceEdit = false;
      }

      applyingVirtualRefresh = true;
      try {
        await event.document.save();
      } finally {
        applyingVirtualRefresh = false;
      }
      return;
    }

    const virtualUris = sourceToVirtual.get(event.document.uri.toString());
    if (!virtualUris?.size) return;

    for (const virtualKey of [...virtualUris]) {
      const state = states.get(virtualKey);
      if (!state) continue;
      const fresh = await findFreshSymbolForEntry(state);
      if (!fresh.symbol) continue;
      const nextContent = event.document.getText(fresh.symbol.range);
      if (nextContent === state.content) continue;
      state.content = nextContent;
      state.lastStartLine = fresh.symbol.range.start.line;
      state.mtime = Date.now();
      provider.fireChanged(vscode.Uri.parse(virtualKey));
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    if (document.uri.scheme !== 'method') return;
    const key = document.uri.toString();
    const state = states.get(key);
    if (!state) return;
    const set = sourceToVirtual.get(state.sourceUri.toString());
    set?.delete(key);
    if (set && set.size === 0) sourceToVirtual.delete(state.sourceUri.toString());
    states.delete(key);
    if (sessionUri?.toString() === key) sessionUri = undefined;
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
