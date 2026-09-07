'use strict';

const postfix = require('./postfix');

function normalizeSelection(documentText, selectionStart, selectionEnd) {
  if (selectionStart == null || selectionEnd == null || selectionEnd <= selectionStart) return null;
  const raw = documentText.slice(selectionStart, selectionEnd);
  const expression = raw.trim();
  if (!expression || /[;{}\n\r]/.test(expression)) return null;

  const leading = raw.search(/\S/);
  const trailing = (raw.match(/\s*$/) || [''])[0].length;
  const actualStart = selectionStart + Math.max(0, leading);
  const actualEnd = selectionEnd - trailing;
  if (actualEnd <= actualStart) return null;
  return { expression, actualStart, actualEnd };
}

function statementLocation(documentText, offset) {
  const statementStart = findStatementStart(documentText, offset);
  let statementAnchor = statementStart;
  while (statementAnchor < documentText.length && /\s/.test(documentText[statementAnchor])) statementAnchor++;
  if (statementAnchor > offset) statementAnchor = offset;
  const lineStart = documentText.lastIndexOf('\n', statementAnchor - 1) + 1;
  const lineEndIndex = documentText.indexOf('\n', statementAnchor);
  const lineEnd = lineEndIndex < 0 ? documentText.length : lineEndIndex;
  const lineText = documentText.slice(lineStart, lineEnd);
  const indent = (lineText.match(/^\s*/) || [''])[0];
  return { lineStart, indent };
}

function buildIntroduceVariableEdit(documentText, selectionStart, selectionEnd, options = {}) {
  const sel = normalizeSelection(documentText, selectionStart, selectionEnd);
  if (!sel) return null;

  const name = options.name || postfix.deriveVariableName(sel.expression) || 'value';
  const type = options.type || 'var';
  const statement = statementLocation(documentText, sel.actualStart);

  return {
    expression: sel.expression,
    name,
    type,
    declarationOffset: statement.lineStart,
    declarationText: `${statement.indent}${type} ${name} = ${sel.expression};\n`,
    replaceStart: sel.actualStart,
    replaceEnd: sel.actualEnd,
    replacementText: name
  };
}

function buildIntroduceFieldEdit(documentText, selectionStart, selectionEnd, options = {}) {
  const sel = normalizeSelection(documentText, selectionStart, selectionEnd);
  if (!sel) return null;
  const type = (options.type || '').trim();
  if (!type || type === 'var') return null;

  const owner = findEnclosingFieldOwner(documentText, sel.actualStart);
  if (!owner) return null;

  const name = options.name || postfix.deriveVariableName(sel.expression) || 'value';
  const statement = statementLocation(documentText, sel.actualStart);
  const memberIndent = inferMemberIndent(documentText, owner);
  const declaration = fieldInsertion(documentText, owner, memberIndent, `private ${type} ${name};`);

  return {
    expression: sel.expression,
    name,
    type,
    fieldDeclarationOffset: declaration.offset,
    fieldDeclarationText: declaration.text,
    assignmentOffset: statement.lineStart,
    assignmentText: `${statement.indent}this.${name} = ${sel.expression};\n`,
    replaceStart: sel.actualStart,
    replaceEnd: sel.actualEnd,
    replacementText: `this.${name}`
  };
}

function findStatementStart(text, offset) {
  let paren = 0, bracket = 0;
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') paren++;
    else if (ch === '(') {
      if (paren > 0) paren--;
    } else if (ch === ']') bracket++;
    else if (ch === '[') {
      if (bracket > 0) bracket--;
    }
    if (paren || bracket) continue;
    if (ch === ';' || ch === '{' || ch === '}') return i + 1;
  }
  return 0;
}

// Cursor introduce intentionally expands only to the RIGHT of the token under
// the caret. It does not walk backward into a receiver, binary expression, or
// containing invocation. On `failure|getClass().getSimpleName()` the choices
// are `failure`, `failure.getClass()`, and the full forward member chain.
function findExpressionRangesAtCursor(text, cursorOffset) {
  if (!text || cursorOffset < 0 || cursorOffset > text.length) return [];
  let probe = cursorOffset;
  if (probe === text.length || !/[A-Za-z0-9_$]/.test(text[probe] || '')) probe--;
  if (probe < 0 || !/[A-Za-z0-9_$]/.test(text[probe])) return [];

  let start = probe;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) start--;
  let baseEnd = probe + 1;
  while (baseEnd < text.length && /[A-Za-z0-9_$]/.test(text[baseEnd])) baseEnd++;

  const ranges = [];
  const add = end => {
    if (end <= start) return;
    const expression = text.slice(start, end).trim();
    if (!isBalancedExpression(expression) || !isPlausibleIntroduceExpression(expression)) return;
    const key = `${start}:${end}`;
    if (!ranges.some(r => `${r.start}:${r.end}` === key)) ranges.push({ start, end, expression });
  };

  add(baseEnd);
  let end = consumeCallOrIndex(text, baseEnd);
  if (end !== baseEnd) add(end);

  while (end < text.length) {
    let p = end;
    while (p < text.length && /\s/.test(text[p]) && text[p] !== '\n' && text[p] !== '\r') p++;
    if (text[p] === '.') {
      p++;
      while (p < text.length && /\s/.test(text[p])) p++;
      if (!/[A-Za-z_$]/.test(text[p] || '')) break;
      p++;
      while (p < text.length && /[A-Za-z0-9_$]/.test(text[p])) p++;
      const memberEnd = p;
      const consumed = consumeCallOrIndex(text, memberEnd);
      end = consumed;
      // A method name immediately followed by '(' is not a standalone value;
      // add the call, not `receiver.method`.
      if (consumed !== memberEnd || text[memberEnd] !== '(') add(end);
      continue;
    }
    if (text[p] === '[') {
      const close = consumeBalanced(text, p, '[', ']');
      if (close < 0) break;
      end = close;
      add(end);
      continue;
    }
    break;
  }

  return ranges;
}

function consumeCallOrIndex(text, from) {
  let end = from;
  while (end < text.length) {
    let p = end;
    while (p < text.length && /\s/.test(text[p]) && text[p] !== '\n' && text[p] !== '\r') p++;
    if (text[p] === '(') {
      const close = consumeBalanced(text, p, '(', ')');
      if (close < 0) return end;
      end = close;
      continue;
    }
    if (text[p] === '[') {
      const close = consumeBalanced(text, p, '[', ']');
      if (close < 0) return end;
      end = close;
      continue;
    }
    return end;
  }
  return end;
}

function consumeBalanced(text, openOffset, openChar, closeChar) {
  let depth = 0;
  let quote = '';
  for (let i = openOffset; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

function findEnclosingFieldOwner(text, offset) {
  const typePattern = /\b(class|enum)\s+([A-Za-z_$][\w$]*)[^;{}]*\{/g;
  let m;
  let best = null;
  while ((m = typePattern.exec(text))) {
    const open = text.indexOf('{', m.index);
    if (open < 0 || open >= offset) continue;
    const close = consumeBalanced(text, open, '{', '}');
    if (close < 0 || close <= offset) continue;
    if (!best || open > best.open) best = { kind: m[1], name: m[2], open, close };
  }
  return best;
}

function inferMemberIndent(text, owner) {
  const ownerLineStart = text.lastIndexOf('\n', owner.open) + 1;
  const ownerLine = text.slice(ownerLineStart, owner.open);
  const ownerIndent = (ownerLine.match(/^\s*/) || [''])[0];
  const after = text.slice(owner.open + 1, Math.min(text.length, owner.open + 1000));
  const lineMatch = after.match(/\n([ \t]+)\S/);
  if (lineMatch && lineMatch[1].length > ownerIndent.length) return lineMatch[1];
  return ownerIndent + '    ';
}

function fieldInsertion(text, owner, indent, declaration) {
  const newline = text.indexOf('\n', owner.open);
  if (newline >= 0 && newline < owner.close) {
    return { offset: newline + 1, text: `${indent}${declaration}\n` };
  }
  return { offset: owner.open + 1, text: `\n${indent}${declaration}\n` };
}

function isBalancedExpression(s) {
  let p = 0, b = 0;
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const prev = i > 0 ? s[i - 1] : '';
    if (quote) {
      if (ch === quote && prev !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') p++;
    else if (ch === ')') { if (--p < 0) return false; }
    else if (ch === '[') b++;
    else if (ch === ']') { if (--b < 0) return false; }
  }
  return !quote && p === 0 && b === 0;
}

function hasTopLevelAssignmentOrComma(s) {
  let p = 0, b = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') p++;
    else if (ch === ')') p--;
    else if (ch === '[') b++;
    else if (ch === ']') b--;
    else if (p === 0 && b === 0 && ch === ',') return true;
    else if (p === 0 && b === 0 && ch === '=' && s[i - 1] !== '=' && s[i + 1] !== '=') return true;
  }
  return false;
}

function isPlausibleIntroduceExpression(expr) {
  const s = expr.trim();
  if (!s || /[;{}\n\r]/.test(s)) return false;
  if (/^(return|throw|if|while|for|switch|case|new\s*$)\b/.test(s)) return false;
  if (hasTopLevelAssignmentOrComma(s)) return false;
  return /[A-Za-z0-9_$)\]"']$/.test(s);
}

module.exports = {
  buildIntroduceVariableEdit,
  buildIntroduceFieldEdit,
  findExpressionRangesAtCursor,
  isPlausibleIntroduceExpression,
  findEnclosingFieldOwner
};
