'use strict';

let vscodeApi;
function vscode() {
  if (!vscodeApi) vscodeApi = require('vscode');
  return vscodeApi;
}
const semantic = require('./semantic');

const cache = new Map();
const inflight = new Map();

const JAVA_LANG_IMPLICIT = new Set([
  'String','Object','Class','System','Math','Thread','Runnable',
  'Throwable','Exception','RuntimeException','Error',
  'Boolean','Byte','Short','Integer','Long','Float','Double','Character',
  'Number','Void','StringBuilder','StringBuffer','CharSequence',
  'Enum','Iterable','Comparable','AutoCloseable','Record'
]);

function qualifiedTypeIdentity(document, typeName) {
  const normalized = semantic.normalizeType(typeName || '');
  if (!normalized) return '';
  const base = normalized.replace(/<.*$/, '').replace(/\[\]$/, '');
  const suffix = normalized.slice(base.length);

  if (base.includes('.')) return normalized;

  const simple = splitTypeName(base);
  const explicit = importedQualifiedType(document, base);
  if (explicit) return `${explicit}${suffix}`;

  if (JAVA_LANG_IMPLICIT.has(simple)) return `java.lang.${simple}${suffix}`;

  return normalized;
}

function splitTypeName(type) {
  const canonical = semantic.canonicalType(type || '');
  const raw = canonical.replace(/<.*$/, '').replace(/\[\]$/, '');
  const parts = raw.split('.');
  return parts[parts.length - 1] || raw;
}

function findMatchingBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1;
}


function maskNestedTypeBody(body) {
  let depth = 0;
  let out = '';
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) { escaped = false; out += depth === 0 ? ch : (ch === '\n' ? '\n' : ' '); continue; }
      if (ch === '\\') { escaped = true; out += depth === 0 ? ch : ' '; continue; }
      if (ch === quote) inString = false;
      out += depth === 0 ? ch : (ch === '\n' ? '\n' : ' ');
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += depth === 0 ? ch : ' '; continue; }
    if (ch === '{') {
      out += depth === 0 ? ch : ' ';
      depth++;
      continue;
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1);
      out += depth === 0 ? ch : ' ';
      continue;
    }
    out += depth === 0 ? ch : (ch === '\n' ? '\n' : ' ');
  }
  return out;
}

function isMemberAccessible(modifiers, typeKind, options = {}) {
  const mods = String(modifiers || '');
  if (/\bpublic\b/.test(mods)) return true;
  if (/\bprivate\b/.test(mods)) return !!options.allowPrivate;
  // Keep parseTypeSource backwards-compatible for direct/tests callers, while
  // resolveTypeMembers passes explicit accessibility flags for real completion.
  const explicitPackage = Object.prototype.hasOwnProperty.call(options, 'allowPackage');
  const explicitProtected = Object.prototype.hasOwnProperty.call(options, 'allowProtected');
  if (/\bprotected\b/.test(mods)) {
    return explicitProtected ? !!options.allowProtected : (explicitPackage ? !!options.allowPackage : true);
  }
  // Interface members are implicitly public unless explicitly private.
  if (typeKind === 'interface') return true;
  // Class/record/enum members with no access modifier are package-private.
  return explicitPackage ? !!options.allowPackage : true;
}

function parseTypeSource(text, requestedType, options = {}) {
  const wanted = splitTypeName(requestedType);
  const clean = text;
  const requestedCanonical = semantic.normalizeType(requestedType || '').replace(/<.*$/, '').replace(/\[\]$/, '');
  if (requestedCanonical.includes('.')) {
    const pkg = packageNameOf(clean);
    const actualFqn = `${pkg ? pkg + '.' : ''}${wanted}`;
    if (pkg && actualFqn !== requestedCanonical) return { members: [], parents: [], parentRefs: [] };
  }
  const typeRe = /\b(class|interface|record|enum)\s+([A-Za-z_$][\w$]*)(?:\s*<[^>{}]+>)?(?:\s+extends\s+([A-Za-z_$][\w$.,<> ?&]*))?(?:\s+implements\s+[^\{]+)?\s*(\([^)]*\))?\s*\{/g;
  let match;
  let chosen = null;
  while ((match = typeRe.exec(clean))) {
    if (match[2] === wanted) { chosen = match; break; }
  }
  // Never parse an arbitrary first type when the requested type is absent. A
  // wrong type poisons the workspace index and creates impossible graph edges.
  if (!chosen) return { members: [], parents: [], parentRefs: [] };

  const open = clean.indexOf('{', chosen.index);
  const typeMap = genericTypeMap(clean, chosen, open, requestedType);
  const close = findMatchingBrace(clean, open);
  const body = clean.slice(open + 1, close);
  const topLevelBody = maskNestedTypeBody(body);
  const members = [];
  const seen = new Set();

  // Record components are public zero-arg accessors.
  if (chosen[1] === 'record') {
    const headerStart = clean.indexOf('(', chosen.index);
    const headerEnd = headerStart >= 0 ? clean.indexOf(')', headerStart) : -1;
    if (headerStart >= 0 && headerEnd > headerStart) {
      for (const p of semantic.parseMethodParameters(clean.slice(headerStart + 1, headerEnd))) {
        if (!p.name || !p.type) continue;
        const componentType = substituteType(p.type, typeMap);
        const key = `${p.name}():${componentType}`;
        if (!seen.has(key)) {
          seen.add(key);
          members.push({ name: p.name, call: '()', type: componentType, kind: 'method', arity: 0, paramTypes: [] });
        }
      }
    }
  }

  // Methods. This intentionally accepts declarations from JDT source/decompiled views.
  const methodRe = /(?:^|[;{}\n])\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*((?:(?:public|protected|private|static|final|abstract|synchronized|native|default|strictfp)\s+)*)(?:<[^>]+>\s*)?([A-Za-z_$][\w$.[\]<>?, ?&]*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+[^;{]+)?\s*(?:\{|;)/g;
  let m;
  while ((m = methodRe.exec(topLevelBody))) {
    const modifiers = m[1] || '';
    if (!isMemberAccessible(modifiers, chosen[1], options)) continue;
    const returnType = substituteType(m[2], typeMap);
    const name = m[3];
    if (!returnType || returnType === wanted || name === wanted) continue; // constructors
    const params = semantic.parseMethodParameters(m[4]).map(p => ({ ...p, type: substituteType(p.type, typeMap) }));
    const key = `${name}(${params.map(p => p.type).join(',')}):${returnType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({ name, call: params.length ? `(${params.map((p, i) => `\${${i + 1}:${p.name || 'arg'}}`).join(', ')})` : '()', type: returnType, kind: 'method', arity: params.length, paramTypes: params.map(p => p.type), paramNames: params.map(p => p.name || ''), isSnippet: params.length > 0, isStatic: /\bstatic\b/.test(modifiers), typeOffset: open + 1 + m.index + Math.max(0, m[0].indexOf(m[2])) });
  }

  // Public/package fields can be useful too, though methods are preferred.
  const fieldRe = /(?:^|[;{}\n])\s*((?:(?:public|protected|private|static|final|volatile|transient)\s+)*)(([A-Za-z_$][\w$.[\]<>?, ?&]*))\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/g;
  while ((m = fieldRe.exec(topLevelBody))) {
    const modifiers = m[1] || '';
    if (!isMemberAccessible(modifiers, chosen[1], options)) continue;
    const type = substituteType(m[2], typeMap);
    const name = m[4];
    const key = `${name}:${type}`;
    if (!type || seen.has(key)) continue;
    seen.add(key);
    members.push({ name, call: '', type, kind: 'field', arity: 0, isStatic: /\bstatic\b/.test(modifiers), typeOffset: open + 1 + m.index + Math.max(0, m[0].indexOf(m[2])) });
  }

  const parents = [];
  const parentRefs = [];
  if (chosen[3]) {
    const header = clean.slice(chosen.index, open);
    for (const p of semantic.splitTopLevel(chosen[3].replace(/\s*&\s*/g, ','), ',')) {
      const rawParent = semantic.normalizeType(p);
      const cleanParent = substituteType(rawParent, typeMap);
      if (!cleanParent) continue;
      parents.push(cleanParent);
      const simpleParent = splitTypeName(rawParent);
      const rel = simpleParent ? header.search(new RegExp(`\\b${escapeRegExp(simpleParent)}\\b`)) : -1;
      parentRefs.push({ type: cleanParent, typeOffset: rel >= 0 ? chosen.index + rel : undefined });
    }
  }
  return { members, parents, parentRefs };
}


function packageNameOf(text) {
  const m = String(text || '').match(/^\s*package\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*;/m);
  return m ? m[1] : '';
}

function importedQualifiedType(document, typeName) {
  if (!document) return '';
  const simple = splitTypeName(typeName);
  const canonical = semantic.canonicalType(typeName || '').replace(/<.*$/, '').replace(/\[\]$/, '');
  if (canonical.includes('.')) return canonical;
  const text = document.getText();
  const exact = new RegExp(`^\\s*import\\s+([A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\.${escapeRegExp(simple)})\\s*;`, 'm').exec(text);
  if (exact) return exact[1];
  // java.lang is implicitly imported by every Java source file. Treat those
  // names as fully qualified so an unrelated class with the same simple name
  // can never enter or poison the type cache.
  if (JAVA_LANG_IMPLICIT.has(simple)) return `java.lang.${simple}`;

  // Same-package project types are unambiguous. Wildcard imports remain JDT's
  // responsibility because resolving those without classpath knowledge is unsafe.
  const pkg = packageNameOf(text);
  if (pkg) return `${pkg}.${simple}`;
  return '';
}

function documentDeclaresQualifiedType(document, typeName, expectedFqn = '') {
  if (!document) return false;
  const simple = splitTypeName(typeName);
  const text = document.getText();
  if (!new RegExp(`\\b(?:class|interface|record|enum)\\s+${escapeRegExp(simple)}\\b`).test(text)) return false;
  if (!expectedFqn) return true;
  const pkg = packageNameOf(text);
  return `${pkg ? pkg + '.' : ''}${simple}` === expectedFqn;
}

function candidateJavaFilePatterns(typeName) {
  const simple = splitTypeName(typeName);
  return simple ? [`**/${simple}.java`] : [];
}

async function workspaceTypeDocuments(typeName, currentDocument, token) {
  const simple = splitTypeName(typeName);
  const docs = [];
  const expectedFqn =
    importedQualifiedType(currentDocument, typeName) ||
    qualifiedTypeIdentity(currentDocument, typeName).replace(/<.*$/, '').replace(/\[\]$/, '');
  const addDoc = doc => {
    if (!doc) return;
    if (expectedFqn) {
      if (!documentDeclaresQualifiedType(doc, typeName, expectedFqn)) return;
    } else if (!documentDeclaresQualifiedType(doc, typeName)) {
      return;
    }
    if (!docs.some(d => d.uri.toString() === doc.uri.toString())) docs.push(doc);
  };

  addDoc(currentDocument);

  if (expectedFqn) {
    try {
      for (const pattern of candidateJavaFilePatterns(typeName)) {
        const uris = await vscode().workspace.findFiles(pattern, '**/{build,target,.gradle,node_modules}/**', 16);
        if (token?.isCancellationRequested) return docs;
        for (const uri of uris || []) {
          try { addDoc(await vscode().workspace.openTextDocument(uri)); } catch (_) {}
        }
      }
    } catch (_) {}
  }

  try {
    const symbols = await vscode().commands.executeCommand('vscode.executeWorkspaceSymbolProvider', simple);
    if (token?.isCancellationRequested) return docs;
    for (const symbol of symbols || []) {
      if (symbol.name !== simple || !symbol.location?.uri) continue;
      try { addDoc(await vscode().workspace.openTextDocument(symbol.location.uri)); } catch (_) {}
      if (docs.length >= 8) break;
    }
  } catch (_) {}
  return docs;
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingParen(text, open) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function inferObservedReturnType(text, callStart, callEnd) {
  // Only infer an assignment type when this observed call is the complete RHS.
  // An intermediate chain such as:
  //   List<String> x = events.stream().filter(...).toList();
  // does NOT mean events.stream() returns List<String>. Treating it that way
  // poisons the reachability graph and turns Stream operations into List ops.
  if (!Number.isFinite(callEnd) || callEnd < callStart) return '';
  const semi = text.indexOf(';', callEnd + 1);
  if (semi < 0) return '';
  const tail = text.slice(callEnd + 1, semi).trim();
  if (tail) return '';
  const from = Math.max(0, text.lastIndexOf('\n', callStart) + 1);
  const before = text.slice(from, callStart);
  const m = before.match(/(?:^|[;{}])\s*([A-Za-z_$][\w$.[\]<>?, ?&]*)\s+[A-Za-z_$][\w$]*\s*=\s*$/);
  return m ? semantic.normalizeType(m[1]) : '';
}

function observedMembersForReceiver(text, receiverExpression) {
  const receiver = String(receiverExpression || '').trim();
  if (!receiver || !/^[A-Za-z_$][\w$]*$/.test(receiver)) return [];
  const re = new RegExp(`\\b${escapeRegExp(receiver)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const open = text.indexOf('(', m.index + m[0].length - 1);
    const close = findMatchingParen(text, open);
    if (open < 0 || close < 0) continue;
    const argsText = text.slice(open + 1, close);
    const args = semantic.splitTopLevel(argsText, ',').map(x => x.trim()).filter(Boolean);
    const call = args.length
      ? `(${args.map((arg, i) => `\${${i + 1}:${arg || `arg${i + 1}`}}`).join(', ')})`
      : '()';
    const type = inferObservedReturnType(text, m.index, close) || '';
    const key = `${name}:${args.length}:${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, call, type, kind: 'method', arity: args.length, observedArgs: args, isSnippet: args.length > 0, observed: true });
  }
  return out;
}

function genericArguments(type) {
  const n = semantic.normalizeType(type || '');
  const open = n.indexOf('<');
  const close = n.lastIndexOf('>');
  if (open < 0 || close <= open) return [];
  return semantic.splitTopLevel(n.slice(open + 1, close), ',').map(semantic.normalizeType);
}

function declaredTypeParameters(text, chosen, openBrace) {
  const header = text.slice(chosen.index, openBrace);
  const name = chosen[2];
  const m = header.match(new RegExp(`\\b${escapeRegExp(name)}\\s*<([^>{}]+)>`));
  if (!m) return [];
  return semantic.splitTopLevel(m[1], ',').map(part => {
    const x = part.trim().replace(/^@[^ ]+\s+/, '');
    const n = x.match(/^([A-Za-z_$][\\w$]*)/);
    return n ? n[1] : '';
  }).filter(Boolean);
}

function genericTypeMap(text, chosen, openBrace, requestedType) {
  const formals = declaredTypeParameters(text, chosen, openBrace);
  const actuals = genericArguments(requestedType);
  const out = new Map();
  for (let i = 0; i < formals.length; i++) {
    if (actuals[i]) out.set(formals[i], actuals[i]);
  }
  return out;
}

function substituteType(type, mapping) {
  let out = semantic.normalizeType(type || '');
  if (!out || !mapping?.size) return out;
  // Repeat because one mapped type can itself mention another formal.
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (const [formal, actual] of mapping) {
      const next = out.replace(new RegExp(`\\b${escapeRegExp(formal)}\\b`, 'g'), actual);
      if (next !== out) { out = next; changed = true; }
    }
    if (!changed) break;
  }
  return semantic.normalizeType(out);
}

async function typeDefinitionDocuments(document, anchorOffset, requestedType, token, anchorUri) {
  let anchorDocument = document;
  if (anchorUri) {
    try { anchorDocument = await vscode().workspace.openTextDocument(vscode().Uri.parse(anchorUri)); } catch (_) {}
  }
  if (!anchorDocument || !Number.isFinite(anchorOffset)) return [];
  const docs = [];
  const simple = splitTypeName(requestedType);
  const expectedFqn =
    importedQualifiedType(anchorDocument, requestedType) ||
    importedQualifiedType(document, requestedType) ||
    qualifiedTypeIdentity(anchorDocument, requestedType).replace(/<.*$/, '').replace(/\[\]$/, '');
  const position = anchorDocument.positionAt(Math.max(0, anchorOffset));

  // When the anchor is literally a return-type token such as Stream<E>, the
  // ordinary definition provider is the correct navigation primitive. Type
  // definition is still useful when the anchor is an expression/variable, so
  // try both in that order and merge unique documents.
  for (const command of ['vscode.executeDefinitionProvider', 'vscode.executeTypeDefinitionProvider']) {
    try {
      const locations = await vscode().commands.executeCommand(command, anchorDocument.uri, position);
      for (const loc of locations || []) {
        if (token?.isCancellationRequested) break;
        const uri = loc?.uri || loc?.targetUri;
        if (!uri) continue;
        try {
          const doc = await vscode().workspace.openTextDocument(uri);
          const declares = !simple || documentDeclaresQualifiedType(doc, requestedType, expectedFqn);
          if (declares && !docs.some(d => d.uri.toString() === doc.uri.toString())) docs.push(doc);
        } catch (_) {}
      }
    } catch (_) {}
    if (docs.length) break;
  }
  return docs;
}

function resolvedMemberIdentityKey(member) {
  if (!member) return '';
  if (member.kind === 'method') {
    const params = Array.isArray(member.paramTypes)
      ? member.paramTypes.map(t => semantic.canonicalType(t || ''))
      : [];
    // Java overload identity is name + parameter types. Parameter names, return
    // types and snippet placeholder text are not part of a method signature.
    if (params.length || member.arity === 0) return `method:${member.name}(${params.join(',')})`;
    // Defensive fallback for non-parser/legacy members that lack parameter types.
    return `method:${member.name}#${member.arity ?? ''}:${semantic.canonicalType(member.type || '')}`;
  }
  return `${member.kind || 'field'}:${member.name}:${semantic.canonicalType(member.type || '')}`;
}


function symbolKindIsMethod(kind) {
  const S = vscode().SymbolKind;
  return kind === S.Method || kind === S.Function || kind === S.Constructor;
}

function symbolKindIsField(kind) {
  const S = vscode().SymbolKind;
  return kind === S.Field || kind === S.Property || kind === S.Variable || kind === S.Constant;
}

async function documentSymbolMembers(doc, requestedType, token, accessOptions = {}) {
  if (!doc) return [];
  let symbols = [];
  try {
    symbols = await vscode().commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri) || [];
  } catch (_) {
    return [];
  }
  if (token?.isCancellationRequested) return [];

  const wanted = splitTypeName(requestedType);
  let typeSymbol = null;

  const visit = list => {
    for (const sym of list || []) {
      if (!sym) continue;
      if (sym.name === wanted && Array.isArray(sym.children)) {
        typeSymbol = sym;
        return true;
      }
      if (Array.isArray(sym.children) && visit(sym.children)) return true;
    }
    return false;
  };
  visit(symbols);
  if (!typeSymbol || !Array.isArray(typeSymbol.children)) return [];

  const out = [];
  const seen = new Set();
  for (const child of typeSymbol.children) {
    if (token?.isCancellationRequested) break;
    if (!child?.name) continue;

    const rawName = String(child.name);
    const name = rawName.replace(/\s*\(.*$/, '').trim();
    if (!name || name === wanted) continue;

    // Document symbols include implementation details too. Recover the access
    // modifiers from the declaration text and apply the same Java visibility
    // rules as the source parser before admitting the symbol into the API index.
    let declarationText = '';
    try {
      // DocumentSymbol.range is inconsistent across Java/JDT source and
      // decompiled views: sometimes it spans the declaration/body, sometimes
      // effectively only the symbol. Inspect a small source window around the
      // symbol line so explicit access modifiers are actually visible.
      const rangeStart = child.selectionRange?.start || child.range?.start;
      if (rangeStart && typeof doc.lineAt === 'function') {
        const fromLine = Math.max(0, rangeStart.line - 2);
        const toLine = Math.min(doc.lineCount - 1, rangeStart.line + 1);
        const parts = [];
        for (let ln = fromLine; ln <= toLine; ln++) parts.push(doc.lineAt(ln).text);
        declarationText = parts.join('\n');
      }
      if (!declarationText && child.range) declarationText = doc.getText(child.range);
    } catch (_) {}

    // Only the actual Java access modifier matters here. Other modifiers are
    // irrelevant to accessibility. A missing access modifier on an external
    // class means package-private, while interface members remain implicitly public.
    const accessMatch = String(declarationText || '').match(/\b(public|protected|private)\b/);
    const modifiers = accessMatch ? accessMatch[1] : '';
    const typeKind = typeSymbol.kind === vscode().SymbolKind.Interface ? 'interface' : 'class';
    if (!isMemberAccessible(modifiers, typeKind, accessOptions)) continue;

    if (symbolKindIsMethod(child.kind)) {
      // JDT document symbols don't consistently expose parameter types through
      // VS Code, but they do give us the authoritative callable member names.
      // Use a generic call shape; overloads are collapsed later at the UI layer.
      const hasParens = /\(/.test(rawName);
      const call = hasParens ? '(${1:arg})' : '()';
      const key = `method:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        call,
        type: '',
        kind: 'method',
        arity: hasParens ? 1 : 0,
        paramTypes: [],
        paramNames: [],
        isSnippet: hasParens,
        isStatic: false,
        sourceUri: doc.uri.toString(),
        fromDocumentSymbol: true
      });
    } else if (symbolKindIsField(child.kind)) {
      const key = `field:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        call: '',
        type: '',
        kind: 'field',
        arity: 0,
        isStatic: false,
        sourceUri: doc.uri.toString(),
        fromDocumentSymbol: true
      });
    }
  }
  return out;
}

async function resolveTypeMembers(document, type, token, depth = 0, visiting = new Set(), options = {}) {
  const normalized = semantic.normalizeType(type);
  if (!normalized || depth > 4) return [];
  let workspaceKey = 'global';
  try {
    const folder = document?.uri ? vscode().workspace.getWorkspaceFolder(document.uri) : null;
    workspaceKey = folder?.uri?.toString() || 'global';
  } catch (_) {}
  const resolutionDocument = (() => {
    if (options.anchorUri) {
      try {
        const uri = vscode().Uri.parse(options.anchorUri);
        for (const doc of vscode().workspace.textDocuments || []) {
          if (doc.uri.toString() === uri.toString()) return doc;
        }
      } catch (_) {}
    }
    return document;
  })();
  const qualifiedIdentity = qualifiedTypeIdentity(resolutionDocument, normalized);
  const key = `${workspaceKey}|${qualifiedIdentity || normalized}`;
  const cached = cache.get(key);
  // Positive member resolutions are stable and safe to reuse. An empty resolution
  // is context-sensitive: a later graph hop may carry an exact source anchor
  // (for example the Stream<E> token in List.stream()) that can resolve the type
  // even when an earlier global lookup could not. Never let an unanchored empty
  // cache entry suppress a better anchored retry.
  if (cached && (cached.length > 0 || (!Number.isFinite(options.anchorOffset) && !options.anchorUri))) return cached;
  // Check recursive ancestry before sharing an in-flight promise; otherwise an
  // inheritance cycle A -> B -> A can wait on its own unresolved promise.
  if (visiting.has(normalized)) return [];
  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    visiting.add(normalized);
    const all = [];
  const seen = new Set();
  const add = m => {
    const k = resolvedMemberIdentityKey(m);
    if (!seen.has(k)) { seen.add(k); all.push(m); }
  };

  // Resolve from the Java language tooling first. If this type came from a concrete
  // in-scope value, type-definition is the most precise route because JDT already
  // knows the project's classpath, JRE, accessibility, and source attachments.
  const docs = [];
  const addDoc = doc => { if (doc && !docs.some(d => d.uri.toString() === doc.uri.toString())) docs.push(doc); };
  for (const doc of await typeDefinitionDocuments(document, options.anchorOffset, normalized, token, options.anchorUri)) addDoc(doc);
  // Recursive graph hops carry a source anchor (e.g. SequencedCollection<E> in
  // java.util.List, Stream<E> in java.util.Collection). Workspace-symbol fallback
  // must qualify the requested type in that anchor document's package/import
  // context, not in the user's original source file.
  let resolutionContextDocument = document;
  if (options.anchorUri) {
    try { resolutionContextDocument = await vscode().workspace.openTextDocument(vscode().Uri.parse(options.anchorUri)); } catch (_) {}
  }
  for (const doc of await workspaceTypeDocuments(normalized, resolutionContextDocument, token)) addDoc(doc);
  const parents = new Map();
  const simpleRequested = splitTypeName(normalized);
  for (const doc of docs) {
    if (token?.isCancellationRequested) break;
    const sameDocument = !!document && doc.uri.toString() === document.uri.toString();
    const declaresRequestedType = sameDocument && new RegExp(`\\b(?:class|interface|record|enum)\\s+${simpleRequested}\\b`).test(doc.getText());
    const callerPackage = document ? packageNameOf(document.getText()) : '';
    const declaringPackage = packageNameOf(doc.getText());
    const samePackage = !!callerPackage && callerPackage === declaringPackage;
    const parsed = parseTypeSource(doc.getText(), normalized, {
      allowPrivate: declaresRequestedType,
      allowPackage: declaresRequestedType || samePackage,
      allowProtected: declaresRequestedType || samePackage
    });

    // JDT/document symbols are authoritative for member presence. This matters
    // especially for JDK/decompiled source where our declaration regex may only
    // recognize a subset of methods (e.g. String.trim()).
    const symbolMembers = await documentSymbolMembers(doc, normalized, token, {
      allowPrivate: declaresRequestedType,
      allowPackage: declaresRequestedType || samePackage,
      allowProtected: declaresRequestedType || samePackage
    });
    const parsedByName = new Map();
    for (const m of parsed.members || []) {
      if (!parsedByName.has(`${m.kind}:${m.name}`)) parsedByName.set(`${m.kind}:${m.name}`, m);
      add({ ...m, sourceUri: doc.uri.toString() });
    }
    for (const sm of symbolMembers) {
      const parsedMember = parsedByName.get(`${sm.kind}:${sm.name}`);
      // Keep parsed signature/return-type data when available, but use the
      // symbol result to guarantee the member exists in the API.
      add({ ...sm, ...(parsedMember || {}), sourceUri: doc.uri.toString() });
    }

    for (const ref of parsed.parentRefs || parsed.parents.map(type => ({ type }))) {
      if (!parents.has(ref.type)) parents.set(ref.type, { ...ref, sourceUri: doc.uri.toString() });
    }
  }

  for (const [parent, ref] of parents) {
    const inherited = await resolveTypeMembers(document, parent, token, depth + 1, visiting, { anchorOffset: ref.typeOffset, anchorUri: ref.sourceUri });
    inherited.forEach(add);
  }

    // Cache successful resolutions always. Cache empty global resolutions too, but
    // do not overwrite a successful entry and do not let an anchored failure poison
    // the type globally. Anchored retries are specifically how recursive graph hops
    // recover JDK/dependency types from their declaration tokens.
    if (all.length > 0 || (!Number.isFinite(options.anchorOffset) && !options.anchorUri)) cache.set(key, all);
    return all;
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

function invalidateSourceUri(uri) {
  const target = String(uri || '');
  if (!target) return;
  for (const [key, members] of [...cache.entries()]) {
    if ((members || []).some(m => String(m.sourceUri || '') === target)) cache.delete(key);
  }
}

function clearCache() { cache.clear(); inflight.clear(); }

module.exports = { resolveTypeMembers, parseTypeSource, isMemberAccessible, splitTypeName, candidateJavaFilePatterns, observedMembersForReceiver, clearCache, invalidateSourceUri, genericArguments, substituteType, typeDefinitionDocuments, resolvedMemberIdentityKey, packageNameOf, importedQualifiedType, documentDeclaresQualifiedType, qualifiedTypeIdentity, documentSymbolMembers };
