async function waitForFoldsToFinish(editor, timeoutMs = 2000) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let lastTop = editor.visibleRanges[0]?.start.line ?? 0;
  let stableCount = 0;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(50);
    const currentTop = editor.visibleRanges[0]?.start.line ?? 0;

    if (currentTop === lastTop) {
      stableCount++;
      if (stableCount >= 5) break;
    } else {
      stableCount = 0;
      lastTop = currentTop;
    }
  }
}

const vscode = require('vscode');

let visibleLines = new Set();
let foldMode = false;
let lastSearchTerm = '';
let searchScope = 'document'; // 'document' | 'method'

function parseQuery(searchTerm) {
  const raw = Array.isArray(searchTerm) ? searchTerm.join(' ') : String(searchTerm ?? '');

  // '~' separates OR groups. Whitespace (and the legacy comma separator)
  // separates AND terms within each group.
  return raw
    .split('~')
    .map(group => group.split(/[,\s]+/).filter(Boolean))
    .filter(group => group.length > 0);
}

function lineMatchesQuery(line, queryGroups) {
  const lowerLine = line.toLowerCase();
  return queryGroups.some(group =>
    group.every(term => lowerLine.includes(term.toLowerCase()))
  );
}

function flattenQueryTerms(queryGroups) {
  return queryGroups.flat();
}

function isMethodLikeSymbol(symbol) {
  return symbol.kind === vscode.SymbolKind.Method ||
    symbol.kind === vscode.SymbolKind.Function ||
    symbol.kind === vscode.SymbolKind.Constructor;
}

function collectContainingMethodSymbols(symbols, position, result = []) {
  for (const symbol of symbols ?? []) {
    if (!symbol.range?.contains(position)) continue;

    if (isMethodLikeSymbol(symbol)) {
      result.push(symbol);
    }

    if (Array.isArray(symbol.children) && symbol.children.length > 0) {
      collectContainingMethodSymbols(symbol.children, position, result);
    }
  }
  return result;
}

async function getSearchRange(editor) {
  const doc = editor.document;

  if (searchScope === 'document') {
    return {
      startLine: 0,
      endLine: Math.max(0, doc.lineCount - 1),
      label: 'document'
    };
  }

  let symbols;
  try {
    symbols = await vscode.commands.executeCommand(
      'vscode.executeDocumentSymbolProvider',
      doc.uri
    );
  } catch {
    symbols = undefined;
  }

  if (!Array.isArray(symbols)) {
    vscode.window.showInformationMessage(
      'FoldSearch: method-only mode requires document symbols for this file.'
    );
    return null;
  }

  const cursor = editor.selection.active;
  const containing = collectContainingMethodSymbols(symbols, cursor);

  if (containing.length === 0) {
    vscode.window.showInformationMessage(
      'FoldSearch: cursor is not inside a method or function.'
    );
    return null;
  }

  // Prefer the narrowest enclosing method/function when symbols are nested.
  containing.sort((a, b) => {
    const aSpan = a.range.end.line - a.range.start.line;
    const bSpan = b.range.end.line - b.range.start.line;
    if (aSpan !== bSpan) return aSpan - bSpan;
    return a.range.end.character - a.range.start.character -
      (b.range.end.character - b.range.start.character);
  });

  const symbol = containing[0];
  return {
    startLine: symbol.range.start.line,
    endLine: symbol.range.end.line,
    label: symbol.name || 'method'
  };
}

async function frameMutator() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  await foldNonMatching(editor, lastSearchTerm, 'mutator');
}

async function frameAccessor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  await foldNonMatching(editor, lastSearchTerm, 'accessor');
}

async function foldNonMatching(editor, searchTerm, mode = 'any') {
  const doc = editor.document;
  const lines = doc.getText().split('\n');
  const queryGroups = parseQuery(searchTerm);

  if (queryGroups.length === 0) return;

  const range = await getSearchRange(editor);
  if (!range) return;

  visibleLines.clear();

  const oldCaretLine = editor.selection.active.line;
  const blocks = [];
  const usageTerms = flattenQueryTerms(queryGroups);

  // Build blocks exactly the same way for document and method scope.
  // Method-only mode changes only whether a line is eligible to match:
  // lines outside the enclosing method are ordinary non-matches. This keeps
  // folding behavior identical to normal Fold Search instead of introducing
  // a second, incompatible outside-method folding implementation.
  let blockStart = null;
  for (let i = 0; i < lines.length; i++) {
    const inScope = searchScope === 'document' ||
      (i >= range.startLine && i <= range.endLine);
    const queryMatch = inScope && lineMatchesQuery(lines[i], queryGroups);
    const match = mode !== 'any'
      ? queryMatch && classifyVariableUsage(lines[i], usageTerms) === mode
      : queryMatch;

    if (match) visibleLines.add(i);

    if (!match && blockStart === null) {
      blockStart = i;
    } else if (match && blockStart !== null) {
      blocks.push([blockStart, i - 1]);
      blockStart = null;
    }
  }

  if (blockStart !== null) blocks.push([blockStart, lines.length - 1]);

  // This is intentionally the original Fold Search folding algorithm.
  // Every contiguous non-matching block uses the previous line as its fold
  // anchor, regardless of whether the non-match is inside or outside a method.
  for (const [startLine, endLine] of blocks) {
    const foldStartLine = Math.max(0, startLine - 1);
    const prevLine = lines[foldStartLine];
    const foldStartCol = prevLine ? prevLine.length : 0;
    const startPos = new vscode.Position(foldStartLine, foldStartCol);
    const endPos = new vscode.Position(endLine, lines[endLine].length);

    if (startPos.line === endPos.line) continue;

    editor.selection = new vscode.Selection(startPos, endPos);
    await vscode.commands.executeCommand('editor.createFoldingRangeFromSelection');
    await vscode.commands.executeCommand('editor.fold');
  }

  await waitForFoldsToFinish(editor);

  const visible = [...visibleLines].sort((a, b) => a - b);
  if (visible.length > 0) {
    let targetLine = visible[0];
    for (const line of visible) {
      if (Math.abs(line - oldCaretLine) < Math.abs(targetLine - oldCaretLine)) {
        targetLine = line;
      }
    }

    await new Promise(resolve => setTimeout(resolve, 50));
    await vscode.commands.executeCommand('revealLine', {
      lineNumber: targetLine,
      at: 'center'
    });

    const pos = new vscode.Position(targetLine, 0);
    editor.selection = new vscode.Selection(pos, pos);
  } else {
    // Keep the caret inside the active method rather than unexpectedly jumping
    // to line 0 when a method-scoped query has no matches.
    const targetLine = Math.min(Math.max(oldCaretLine, range.startLine), range.endLine);
    const targetCol = Math.min(
      editor.selection.active.character,
      lines[targetLine]?.length ?? 0
    );
    const pos = new vscode.Position(targetLine, targetCol);
    editor.selection = new vscode.Selection(pos, pos);
  }

  try {
    await vscode.commands.executeCommand('extension.vim_escape');
  } catch {}

  foldMode = true;
  await vscode.commands.executeCommand('setContext', 'foldsearch.active', true);
  await vscode.commands.executeCommand(
    'setContext',
    'foldsearch.methodOnly',
    searchScope === 'method'
  );

  const scopeLabel = searchScope === 'method' ? `method: ${range.label}` : 'document';
  vscode.window.setStatusBarMessage(
    `FoldSearch [${scopeLabel}]: active for "${searchTerm}"`,
    3000
  );
}

async function lastSearch() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const term = await vscode.window.showInputBox({
    prompt: 'Fold all lines not matching query (~ = OR, whitespace = AND):',
    value: lastSearchTerm
  });
  if (!term) return;

  lastSearchTerm = term;
  await foldNonMatching(editor, term);
}

async function runSearch() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const term = await vscode.window.showInputBox({
    prompt: 'Fold all lines not matching query (~ = OR, whitespace = AND):',
    value: lastSearchTerm
  });
  if (!term) return;

  lastSearchTerm = term;
  await foldNonMatching(editor, term);
}

async function toggleSearchScope() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const nextScope = searchScope === 'document' ? 'method' : 'document';

  // Validate method scope before changing anything. This prevents a cursor
  // outside a method from silently falling back to document-wide behavior.
  if (nextScope === 'method') {
    const previousScope = searchScope;
    searchScope = 'method';
    const range = await getSearchRange(editor);
    if (!range) {
      searchScope = previousScope;
      return;
    }
  } else {
    searchScope = nextScope;
  }

  searchScope = nextScope;
  await vscode.commands.executeCommand(
    'setContext',
    'foldsearch.methodOnly',
    searchScope === 'method'
  );

  if (foldMode) {
    await vscode.commands.executeCommand('editor.unfoldAll');
    foldMode = false;
    await vscode.commands.executeCommand('setContext', 'foldsearch.active', false);

    if (lastSearchTerm) {
      await foldNonMatching(editor, lastSearchTerm);
      return;
    }
  }

  vscode.window.setStatusBarMessage(
    `FoldSearch scope: ${searchScope === 'method' ? 'method only' : 'document'}`,
    2000
  );
}

async function toggleFoldSearch() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (foldMode) {
    await vscode.commands.executeCommand('editor.unfoldAll');
    foldMode = false;
    await vscode.commands.executeCommand('setContext', 'foldsearch.active', false);
    vscode.window.setStatusBarMessage('FoldSearch: off', 2000);
  } else if (lastSearchTerm) {
    await foldNonMatching(editor, lastSearchTerm);
  } else {
    vscode.window.showInformationMessage('No previous FoldSearch. Run FoldSearch: Search first.');
  }
}

function classifyVariableUsage(line, terms) {
  // Accessor/mutator classification is only meaningful for one variable.
  if (terms.length !== 1) return 'any';

  const varName = terms[0];
  const trimmed = line.trim();

  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed === '') return null;

  const escapedVarName = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const leftSideMutate = new RegExp(`\\b${escapedVarName}\\b\\s*=`);
  const dotUsage = new RegExp(`\\b${escapedVarName}\\b\\s*\\.`);
  const rightSideAccess = new RegExp(`=\\s*[^;]*\\b${escapedVarName}\\b`);
  const inParenAccess = new RegExp(`\\(.*\\b${escapedVarName}\\b.*\\)`);

  if (leftSideMutate.test(line)) return 'mutator';

  if (dotUsage.test(line) && !rightSideAccess.test(line)) {
    const returnDotUsage = new RegExp(`return\\s+.*\\b${escapedVarName}\\b\\s*\\.`);
    if (!returnDotUsage.test(line)) return 'mutator';
  }

  if (rightSideAccess.test(line) || inParenAccess.test(line)) return 'accessor';

  return 'any';
}

function moveDownVisible() {
  if (!foldMode) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const line = editor.selection.active.line;
  const col = editor.selection.active.character;
  const next = [...visibleLines].sort((a, b) => a - b).find(l => l > line);
  if (next === undefined) return;

  const targetCol = Math.min(col, editor.document.lineAt(next).text.length);
  const pos = new vscode.Position(next, targetCol);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

function moveUpVisible() {
  if (!foldMode) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const line = editor.selection.active.line;
  const col = editor.selection.active.character;
  const prev = [...visibleLines].sort((a, b) => b - a).find(l => l < line);
  if (prev === undefined) return;

  const targetCol = Math.min(col, editor.document.lineAt(prev).text.length);
  const pos = new vscode.Position(prev, targetCol);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

/** Activate FoldSearch with the current word under cursor (handles folds). */
async function foldSearchCurrentWord() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const doc = editor.document;
  const pos = editor.selection.active;
  const lineText = doc.lineAt(pos.line).text;

  if (!lineText || !lineText.trim()) {
    vscode.window.showInformationMessage('No word under cursor (folded or blank line).');
    return;
  }

  const match = /[A-Za-z0-9_]+/g;
  let foundWord = null;
  for (const item of lineText.matchAll(match)) {
    const start = item.index;
    const end = start + item[0].length;
    if (pos.character >= start && pos.character <= end) {
      foundWord = item[0];
      break;
    }
  }

  if (!foundWord) {
    vscode.window.showInformationMessage('No word detected under cursor.');
    return;
  }

  const prevSearch = lastSearchTerm;
  lastSearchTerm = foundWord;

  if (foldMode && foundWord === prevSearch) {
    await vscode.commands.executeCommand('editor.unfoldAll');
    foldMode = false;
    await vscode.commands.executeCommand('setContext', 'foldsearch.active', false);
    vscode.window.setStatusBarMessage(`FoldSearch toggled off for "${foundWord}"`, 2000);
    return;
  }

  if (foldMode && foundWord !== prevSearch) {
    await vscode.commands.executeCommand('editor.unfoldAll');
  }

  await foldNonMatching(editor, foundWord);
}

function activate(context) {
  vscode.commands.executeCommand('setContext', 'foldsearch.methodOnly', false);

  context.subscriptions.push(
    vscode.commands.registerCommand('foldsearch.search', runSearch),
    vscode.commands.registerCommand('foldsearch.accessor', frameAccessor),
    vscode.commands.registerCommand('foldsearch.mutator', frameMutator),
    vscode.commands.registerCommand('foldsearch.last', lastSearch),
    vscode.commands.registerCommand('foldsearch.toggle', toggleFoldSearch),
    vscode.commands.registerCommand('foldsearch.toggleScope', toggleSearchScope),
    vscode.commands.registerCommand('foldsearch.word', foldSearchCurrentWord),
    vscode.commands.registerCommand('foldsearch.down', moveDownVisible),
    vscode.commands.registerCommand('foldsearch.up', moveUpVisible)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
