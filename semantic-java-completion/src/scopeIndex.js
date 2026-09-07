'use strict';

const semantic = require('./semantic');
const INVALID_DECL_TYPES = new Set(['class','interface','record','enum','package','import','return','throw','new','extends','implements','void']);

function braceInfo(text) {
  const clean = semantic.stripCommentsAndStrings ? semantic.stripCommentsAndStrings(text) : text;
  const chains = new Array(clean.length + 1);
  const stack = [];
  const blocks = new Map();
  let nextId = 1;
  chains[0] = [];
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      const id = nextId++;
      stack.push(id);
      blocks.set(id, { id, open: i, close: clean.length });
    } else if (ch === '}') {
      const id = stack.pop();
      if (id && blocks.has(id)) blocks.get(id).close = i;
    }
    chains[i + 1] = stack.slice();
  }
  return { clean, chains, blocks };
}

function braceChains(text) { return braceInfo(text).chains; }

function isPrefix(prefix, full) {
  if (prefix.length > full.length) return false;
  for (let i = 0; i < prefix.length; i++) if (prefix[i] !== full[i]) return false;
  return true;
}

function findMatchingBrace(clean, open) {
  let depth = 0;
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++;
    else if (clean[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return clean.length;
}

function findMethodRegions(text) {
  const clean = semantic.stripCommentsAndStrings(text);
  const method = /(?:(?:public|protected|private|static|final|synchronized|native|abstract|default|strictfp)\s+)*(?:<[^>{}]+>\s*)?([A-Za-z_$][\w$.]*(?:\s*<[^;={}\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\(([^;{}]*)\)\s*(?:throws\s+[^\{]+)?\s*\{/g;
  const regions = [];
  let m;
  while ((m = method.exec(clean))) {
    const open = clean.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const close = findMatchingBrace(clean, open);
    regions.push({
      name: m[2], returnType: semantic.normalizeType(m[1]),
      headerStart: m.index, bodyStart: open, bodyEnd: close,
      paramsStart: clean.indexOf('(', m.index), paramsEnd: clean.lastIndexOf(')', open)
    });
  }
  return regions;
}

function lineNumberAt(text, offset) {
  return (text.slice(0, Math.max(0, offset)).match(/\n/g) || []).length;
}

function collectRawDeclarations(text, info) {
  const clean = info.clean;
  const out = [];
  const seenAt = new Set();
  const decl = /(?:^|[;{}(),\n])\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|volatile|transient)\s+)*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;={}()\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*(?=[=;,:){])/g;
  let m;
  while ((m = decl.exec(clean))) {
    const type = semantic.normalizeType(m[1]);
    const name = m[2];
    if (!type || !name || INVALID_DECL_TYPES.has(type)) continue;
    const local = m[0].lastIndexOf(name);
    const nameOffset = local >= 0 ? m.index + local : m.index;
    const typeLocal = m[0].indexOf(m[1]);
    const typeOffset = typeLocal >= 0 ? m.index + typeLocal : m.index;
    const key = `${nameOffset}:${name}`;
    if (seenAt.has(key)) continue;
    seenAt.add(key);
    out.push({ name, type, kind: 'variable', offset: m.index, nameOffset, typeOffset, declarationLine: lineNumberAt(text, nameOffset) });
  }

  // Explicit fields catch annotations/modifier-heavy declarations the general scanner misses.
  const field = /(?:^|\n)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|volatile|transient)\s+)+([A-Za-z_$][\w$.]*(?:\s*<[^;={}\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/g;
  while ((m = field.exec(clean))) {
    const type = semantic.normalizeType(m[1]);
    const name = m[2];
    if (!type || !name || INVALID_DECL_TYPES.has(type)) continue;
    const local = m[0].lastIndexOf(name);
    const nameOffset = local >= 0 ? m.index + local : m.index;
    const typeLocal = m[0].indexOf(m[1]);
    const typeOffset = typeLocal >= 0 ? m.index + typeLocal : m.index;
    const key = `${nameOffset}:${name}`;
    if (seenAt.has(key)) continue;
    seenAt.add(key);
    out.push({ name, type, kind: 'field', offset: m.index, nameOffset, typeOffset, declarationLine: lineNumberAt(text, nameOffset) });
  }
  return out;
}

function containingMethod(methods, offset, includeHeader = true) {
  return methods.find(m => offset >= (includeHeader ? m.headerStart : m.bodyStart) && offset <= m.bodyEnd) || null;
}

function nearestBlockEnd(info, offset, fallback) {
  const chain = info.chains[Math.max(0, Math.min(offset, info.chains.length - 1))] || [];
  const id = chain[chain.length - 1];
  return id && info.blocks.get(id) ? info.blocks.get(id).close : fallback;
}

function parameterScope(method, declarationOffset) {
  return method && declarationOffset >= method.paramsStart && declarationOffset <= method.paramsEnd;
}

function catchOrLoopBodyScope(text, info, decl) {
  // Parameters declared in catch/for headers sit just before the block they govern.
  const from = Math.max(0, decl.offset - 80);
  const to = Math.min(text.length, decl.nameOffset + 180);
  const around = info.clean.slice(from, to);
  const relName = decl.nameOffset - from;
  const beforeName = around.slice(0, relName);
  if (!/(?:\bcatch\s*\([^)]*|\bfor\s*\([^;)]*)$/.test(beforeName)) return null;
  const openRel = around.indexOf('{', relName);
  if (openRel < 0) return null;
  const open = from + openRel;
  const close = findMatchingBrace(info.clean, open);
  return { start: open + 1, end: close };
}

function buildDocumentIndex(text, options = {}) {
  const includeFields = options.includeFields !== false;
  const info = braceInfo(text);
  const methods = findMethodRegions(text);
  const declarations = collectRawDeclarations(text, info);
  const fields = [];

  for (const d of declarations) {
    const method = containingMethod(methods, d.nameOffset, true);
    if (method && parameterScope(method, d.nameOffset)) {
      d.kind = 'variable';
      d.scopeStart = method.bodyStart + 1;
      d.scopeEnd = method.bodyEnd;
      d.methodStart = method.headerStart;
      continue;
    }

    if (method && d.nameOffset >= method.bodyStart && d.nameOffset <= method.bodyEnd) {
      d.kind = 'variable';
      const special = catchOrLoopBodyScope(text, info, d);
      d.scopeStart = d.nameOffset;
      d.scopeEnd = special ? special.end : nearestBlockEnd(info, d.nameOffset, method.bodyEnd);
      d.methodStart = method.headerStart;
      continue;
    }

    // Header declarations for catch/for blocks are not inside a method body according
    // to the brace chain at their token. Attach them to the containing method/block.
    const special = catchOrLoopBodyScope(text, info, d);
    const enclosing = methods.find(m => d.nameOffset >= m.bodyStart && d.nameOffset <= m.bodyEnd);
    if (special && enclosing) {
      d.kind = 'variable';
      d.scopeStart = special.start;
      d.scopeEnd = special.end;
      d.methodStart = enclosing.headerStart;
      continue;
    }

    if (includeFields) {
      d.kind = 'field';
      d.scopeStart = 0;
      d.scopeEnd = text.length;
      fields.push(d);
    } else {
      d.disabled = true;
    }
  }

  for (const method of methods) {
    method.key = `${method.headerStart}:${method.bodyEnd}`;
    method.values = declarations.filter(d => !d.disabled && (d.kind === 'field' || d.methodStart === method.headerStart));
  }

  return { textLength: text.length, methods, fields, declarations };
}

function contextAt(index, cursorOffset) {
  const method = index.methods.find(m => cursorOffset >= m.bodyStart && cursorOffset <= m.bodyEnd) || null;
  const allValues = method ? method.values : index.fields;
  const byName = new Map();
  for (const value of allValues) {
    if (cursorOffset < (value.scopeStart ?? 0) || cursorOffset > (value.scopeEnd ?? index.textLength)) continue;
    if (value.kind !== 'field' && value.nameOffset > cursorOffset) continue;
    const prev = byName.get(value.name);
    if (!prev || value.nameOffset > prev.nameOffset) byName.set(value.name, value);
  }
  const cursorLine = 0; // lineDistance is filled by valuesAtCursor where source text is available.
  return { method, methodKey: method ? method.key : 'file', allValues, visibleValues: [...byName.values()], cursorLine };
}

function valuesAtCursor(index, text, cursorOffset) {
  const ctx = contextAt(index, cursorOffset);
  const cursorLine = lineNumberAt(text, cursorOffset);
  ctx.visibleValues = ctx.visibleValues.map(v => ({ ...v, lineDistance: Math.abs(cursorLine - v.declarationLine) }));
  ctx.allValues = ctx.allValues.map(v => ({ ...v, lineDistance: Math.abs(cursorLine - v.declarationLine) }));
  return ctx;
}

function collectVisibleValues(text, cursorOffset, options = {}) {
  const index = buildDocumentIndex(text, options);
  return valuesAtCursor(index, text, cursorOffset).visibleValues.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'variable' ? -1 : 1;
    if ((a.lineDistance || 0) !== (b.lineDistance || 0)) return (a.lineDistance || 0) - (b.lineDistance || 0);
    return b.nameOffset - a.nameOffset;
  });
}

module.exports = { collectVisibleValues, braceChains, isPrefix, buildDocumentIndex, valuesAtCursor, findMethodRegions };
