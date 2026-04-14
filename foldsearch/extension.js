async function waitForFoldsToFinish(editor, timeoutMs = 2000) {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  let lastTop = editor.visibleRanges[0]?.start.line ?? 0;
  let stableCount = 0;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(50); // poll every 50ms
    const currentTop = editor.visibleRanges[0]?.start.line ?? 0;

    if (currentTop === lastTop) {
      stableCount++;
      // consider it settled if the visible range hasn't changed for ~250ms
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

function lineMatchesAnyTerm(line, terms) {
  return terms.some(t => line.toLowerCase().includes(t.toLowerCase()));
}

function lineMatchesAllTerm(line, terms) {
  return terms.every(t => line.toLowerCase().includes(t.toLowerCase()));
}

async function frameMutator() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  foldNonMatching(editor, lastSearchTerm, 'mutator')
}

async function frameAccessor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  foldNonMatching(editor, lastSearchTerm, 'accessor')
}

async function foldNonMatching(editor, searchTerm, mode = 'any') {
  const doc = editor.document;
  const lines = doc.getText().split('\n');
  visibleLines.clear();

  // --- Remember caret line before folds begin ---
  const oldCaretLine = editor.selection.active.line;

  // Build fold blocks
  const blocks = [];
  vscode.window.setStatusBarMessage(`FoldSearch: active for "${searchTerm}"`, 3000);
  const terms = Array.isArray(searchTerm)
  ? searchTerm
  : searchTerm.split(/[,\s]+/).filter(Boolean);

  vscode.window.setStatusBarMessage(`FoldSearch: active for "${terms}"`, 3000);

  let blockStart = null;
  for (let i = 0; i < lines.length; i++) {
    if(mode != 'any')
      match = lineMatchesAllTerm(lines[i], terms) && classifyVariableUsage(lines[i], terms) == mode;
    else
      match = lineMatchesAllTerm(lines[i], terms)
    if (match) visibleLines.add(i);
    // if (match) visibleLines.add(i);
    if (!match && blockStart === null) blockStart = i;
    else if (match && blockStart !== null) {
      blocks.push([blockStart, i - 1]);
      blockStart = null;
    }
  }

  if (blockStart !== null) blocks.push([blockStart, lines.length - 1]);

  // --- Create folds ---
  for (const [startLine, endLine] of blocks) {
    const foldStartLine = Math.max(0, startLine - 1);
    const prevLine = lines[foldStartLine];
    const foldStartCol = prevLine ? prevLine.length : 0;
    const startPos = new vscode.Position(foldStartLine, foldStartCol);
    const endPos = new vscode.Position(endLine, lines[endLine].length);
    editor.selection = new vscode.Selection(startPos, endPos);
    await vscode.commands.executeCommand('editor.createFoldingRangeFromSelection');
    await vscode.commands.executeCommand('editor.fold');
  }

  // --- Wait until folding animations fully settle ---
  await waitForFoldsToFinish(editor);

  // --- Find the visible line nearest the original caret ---
  const visible = [...visibleLines].sort((a, b) => a - b);
  let targetLine = visible[0] ?? 0;
  for (const l of visible) {
    if (Math.abs(l - oldCaretLine) < Math.abs(targetLine - oldCaretLine))
      targetLine = l;
  }

  // --- Delay restore until after final internal scroll ---
  await new Promise(resolve => setTimeout(resolve, 50));
  await vscode.commands.executeCommand('revealLine', {
    lineNumber: targetLine,
    at: 'center'
  });

  const pos = new vscode.Position(targetLine, 0);
  editor.selection = new vscode.Selection(pos, pos);

  try {
    await vscode.commands.executeCommand('extension.vim_escape');
  } catch {}

  foldMode = true;
  await vscode.commands.executeCommand('setContext', 'foldsearch.active', true);
  vscode.window.setStatusBarMessage(`FoldSearch: active for "${searchTerm}"`, 3000);
}


async function lastSearch() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const term = await vscode.window.showInputBox({
    prompt: 'Fold all lines NOT containing this term:',
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
    prompt: 'Fold all lines NOT containing this term:'
  });
  if (!term) return;
  lastSearchTerm = term;
  await foldNonMatching(editor, term);
}

async function toggleFoldSearch() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  if (foldMode) {
    await vscode.commands.executeCommand('editor.unfoldAll');
    foldMode = false;
    vscode.commands.executeCommand('setContext', 'foldsearch.active', false);
    vscode.window.setStatusBarMessage('FoldSearch: off', 2000);
  } else if (lastSearchTerm) {
    await foldNonMatching(editor, lastSearchTerm);
  } else {
    vscode.window.showInformationMessage('No previous FoldSearch. Run FoldSearch: Search first.');
  }
}

function classifyVariableUsage(line, term) {
  // We don't have usage with more than one var
  if (term.length > 1) return 'any';

  const varName = term[0];
  const trimmed = line.trim();

  // skip comments and empty lines
  if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed === '') return null;

  // --- basic pattern helpers ---
  const leftSideMutate = new RegExp(`\\b${varName}\\b\\s*=`);
  const dotUsage = new RegExp(`\\b${varName}\\b\\s*\\.`);

  const rightSideAccess = new RegExp(`=\\s*[^;]*\\b${varName}\\b`);
  const inParenAccess = new RegExp(`\\(.*\\b${varName}\\b.*\\)`);

  // --- MUTATOR: assignment on left side of '='
  if (leftSideMutate.test(line)) return 'mutator';

  // --- MUTATOR: var.method() but only if NOT on RHS of assignment ---
  if (dotUsage.test(line) && !rightSideAccess.test(line)) {
    // also avoid things like `return obj.method();`
    if (!/return\s+.*\b${varName}\b\s*\./.test(line)) {
      return 'mutator';
    }
  }

  // --- ACCESSOR: appears on RHS of assignment or inside parentheses ---
  if (rightSideAccess.test(line) || inParenAccess.test(line)) return 'accessor';

  // fallback
  return 'any';
}

function moveDownVisible() {
  if (!foldMode) return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const line = editor.selection.active.line;
  const col = editor.selection.active.character; // preserve current column

  const next = [...visibleLines].find(l => l > line);
  if (next === undefined) return;

  const pos = new vscode.Position(next, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

function moveUpVisible() {
  if (!foldMode) 
    return;
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;

  const line = editor.selection.active.line;
  const col = editor.selection.active.character; // preserve current column

  const prev = [...visibleLines].reverse().find(l => l < line);
  if (prev === undefined) return;

  const pos = new vscode.Position(prev, col);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos));
}

/** Activate FoldSearch with the current word under cursor (handles folds) */
async function foldSearchCurrentWord() {
  vscode.window.showInformationMessage('Fold at current');
  const editor = vscode.window.activeTextEditor;
  if (!editor) return;
  const doc = editor.document;
  let pos = editor.selection.active;

  // Manually extract the word from the line text
  const lineText = doc.lineAt(pos.line).text;
  if (!lineText || !lineText.trim()) {
    vscode.window.showInformationMessage('No word under cursor (folded or blank line).');
    return;
  }

  vscode.window.showInformationMessage('Found word: "${foundWord}"');

  // find word boundaries using regex
  const match = /[A-Za-z0-9_]+/g;
  let foundWord = null;
  for (const m of lineText.matchAll(match)) {
    const start = m.index;
    const end = start + m[0].length;
    if (pos.character >= start && pos.character <= end) {
      foundWord = m[0];
      break;
    }
  }

  if (!foundWord) {
    vscode.window.showInformationMessage('No word detected under cursor.');
    return;
  }

  const word = foundWord;
  const prevSearch = lastSearchTerm;
  lastSearchTerm = word;

  // If we already have FoldSearch active for this word, toggle off
  if (foldMode && word === prevSearch) {
    await vscode.commands.executeCommand('editor.unfoldAll');
    foldMode = false;
    await vscode.commands.executeCommand('setContext', 'foldsearchActive', false);
    vscode.window.setStatusBarMessage(`FoldSearch toggled off for "${word}"`, 2000);
    return;
  }

  // If active with different term, clear first
  if (foldMode && word !== prevSearch) {
    await vscode.commands.executeCommand('editor.unfoldAll');
  }
  await foldNonMatching(editor, word);
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand('foldsearch.search', runSearch),
    vscode.commands.registerCommand('foldsearch.accessor', frameAccessor),
    vscode.commands.registerCommand('foldsearch.mutator', frameMutator),
    vscode.commands.registerCommand('foldsearch.last', lastSearch),
    vscode.commands.registerCommand('foldsearch.toggle', toggleFoldSearch),
    vscode.commands.registerCommand('foldsearch.word', foldSearchCurrentWord),
    vscode.commands.registerCommand('foldsearch.down', moveDownVisible),
    vscode.commands.registerCommand('foldsearch.up', moveUpVisible)
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
