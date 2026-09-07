'use strict';

const JAVA_KEYWORDS = new Set([
  'abstract','assert','boolean','break','byte','case','catch','char','class','const','continue',
  'default','do','double','else','enum','extends','final','finally','float','for','goto','if',
  'implements','import','instanceof','int','interface','long','native','new','package','private',
  'protected','public','return','short','static','strictfp','super','switch','synchronized','this',
  'throw','throws','transient','try','void','volatile','while','var','record','sealed','permits',
  'non-sealed','yield'
]);

function normalizeType(type) {
  if (!type) return '';
  return String(type)
    .replace(/@[\w.]+(?:\([^)]*\))?\s*/g, '')
    .replace(/\b(final|volatile|transient)\b\s*/g, '')
    .replace(/\?\s+extends\s+/g, '')
    .replace(/\?\s+super\s+/g, '')
    .replace(/\.\.\./g, '[]')
    .replace(/\s+/g, '')
    .trim();
}

function simpleType(type) {
  const n = normalizeType(type);
  if (!n) return '';
  const generic = n.indexOf('<');
  const raw = generic >= 0 ? n.slice(0, generic) : n;
  const arraySuffix = raw.endsWith('[]') ? '[]' : '';
  const base = arraySuffix ? raw.slice(0, -2) : raw;
  const dot = base.lastIndexOf('.');
  return (dot >= 0 ? base.slice(dot + 1) : base) + arraySuffix;
}

function canonicalType(type) {
  const n = normalizeType(type);
  if (!n) return '';
  // Keep the generic structure, but remove package qualification from every type
  // token so java.util.List<com.acme.OrderLine> and List<OrderLine> compare equal.
  return n.replace(/(?:[A-Za-z_$][\w$]*\.)+([A-Za-z_$][\w$]*)/g, '$1');
}

function hasGenericArguments(type) {
  const n = normalizeType(type);
  return n.includes('<') && n.endsWith('>');
}

function typeCompatibility(candidateType, expectedType) {
  const c = normalizeType(candidateType);
  const e = normalizeType(expectedType);
  if (!c || !e) return 0;
  if (c === e) return 1;

  const cc = canonicalType(c);
  const ce = canonicalType(e);
  if (cc === ce) return 0.98;

  // Generic Java types are invariant unless we can prove otherwise. The old
  // simple-name comparison incorrectly treated List<OrderLine> as compatible
  // with List<Reservation>; for intent completion a false positive is worse
  // than omitting a suggestion.
  if (hasGenericArguments(c) || hasGenericArguments(e)) {
    return 0;
  }

  // Pragmatic matches we can establish without implementing a Java type system.
  const boxed = {
    boolean: 'Boolean', byte: 'Byte', short: 'Short', int: 'Integer', long: 'Long',
    float: 'Float', double: 'Double', char: 'Character'
  };
  if (boxed[c] === simpleType(e) || boxed[e] === simpleType(c)) return 0.92;
  if (ce === 'Object') return 0.55;
  return 0;
}


function findDeclaredValueType(text, name, cursorOffset) {
  if (!name || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
  const candidates = collectCandidates(text, cursorOffset == null ? text.length : cursorOffset, {
    includeFields: true,
    includeMethods: false,
    includeConstruction: false
  });
  const matches = candidates.filter(c => c.name === name && c.type);
  if (!matches.length) return null;
  matches.sort((a, b) => b.offset - a.offset);
  return matches[0].type || null;
}

function fuzzyNameScore(name, query) {
  const rawName = String(name || '');
  const rawQuery = String(query || '');
  if (!rawQuery) return -1;
  const n = rawName.toLowerCase();
  const q = rawQuery.toLowerCase();

  if (n === q) return 1000;
  if (n.startsWith(q)) return 900 - Math.min(120, n.length - q.length);

  // Strong substring match, but below a true prefix.
  const substring = n.indexOf(q);
  if (substring >= 0) return 760 - Math.min(160, substring * 12 + (n.length - q.length));

  // Camel/word initials: getLocalizedMessage -> glm.
  const initials = rawName
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter(Boolean)
    .map(part => part[0].toLowerCase())
    .join('');
  if (initials && initials.startsWith(q)) return 720 - Math.min(100, initials.length - q.length);

  // Ordered subsequence with bonuses for adjacency and word/camel boundaries, and
  // penalties for gaps. This makes gtmsg / gmes / getme useful intent queries.
  let qi = 0;
  let score = 500;
  let last = -1;
  for (let i = 0; i < rawName.length && qi < rawQuery.length; i++) {
    if (rawName[i].toLowerCase() !== rawQuery[qi].toLowerCase()) continue;
    if (last >= 0) {
      const gap = i - last - 1;
      score -= Math.min(90, gap * 9);
      if (gap === 0) score += 24;
    }
    const boundary = i === 0 || /[^A-Za-z0-9]/.test(rawName[i - 1]) || (/[a-z0-9]/.test(rawName[i - 1]) && /[A-Z]/.test(rawName[i]));
    if (boundary) score += 28;
    if (rawName[i] === rawQuery[qi]) score += 4;
    last = i;
    qi++;
  }
  if (qi === rawQuery.length) return Math.max(1, score - Math.max(0, rawName.length - rawQuery.length));

  // Small typo tolerance via bounded Levenshtein against the leading portion and
  // full member name. Avoid broad junk by accepting only very small distances.
  const lev = (a, b, max) => {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({length:b.length+1}, (_,i)=>i);
    for (let i=1;i<=a.length;i++) {
      const cur=[i]; let rowMin=i;
      for (let j=1;j<=b.length;j++) {
        const v=Math.min(cur[j-1]+1, prev[j]+1, prev[j-1]+(a[i-1]===b[j-1]?0:1));
        cur[j]=v; rowMin=Math.min(rowMin,v);
      }
      if (rowMin>max) return max+1;
      prev=cur;
    }
    return prev[b.length];
  };
  const d = Math.min(lev(q, n.slice(0, Math.max(q.length, Math.min(n.length, q.length + 2))), 2), lev(q, n, 2));
  if (d <= 1) return 360 - d * 80;
  if (d === 2 && q.length >= 5) return 220;
  return -1;
}

function memberNameScore(name, prefix) {
  return fuzzyNameScore(name, prefix);
}

function identifierPrefix(textBeforeCursor) {
  const m = textBeforeCursor.match(/[A-Za-z_$][\w$]*$/);
  return m ? m[0] : '';
}

function completionMatch(candidate, query) {
  if (!query) return { score: 0, target: String(candidate?.matchName || candidate?.name || ''), primaryScore: 0, compositeScore: 0 };

  const primary = String(candidate?.matchName || candidate?.name || '').trim();
  const aliases = [];
  const addAlias = value => {
    const v = String(value || '').trim();
    if (v && v !== primary && !aliases.includes(v)) aliases.push(v);
  };
  for (const value of candidate?.matchNames || []) addAlias(value);
  addAlias(candidate?.name);

  // Developers frequently type receiver+member intent (`reposave`,
  // `fraureasons`). Keep those aliases, but make them secondary to matching the
  // terminal member name itself. This prevents broad receiver text from beating
  // an actual `save()` when the query is simply `save`.
  for (const value of [...aliases]) {
    addAlias(value
      .replace(/\$\{\d+:[^}]*\}/g, '')
      .replace(/\([^)]*\)/g, '')
      .replace(/[^A-Za-z0-9_$]/g, ''));
  }

  const primaryScore = primary ? fuzzyNameScore(primary, query) : -1;
  let compositeScore = -1;
  let compositeTarget = '';
  for (const target of aliases) {
    const score = fuzzyNameScore(target, query);
    if (score > compositeScore) {
      compositeScore = score;
      compositeTarget = target;
    }
  }

  if (primaryScore >= 0) {
    // A strong receiver+member shorthand can be much more intentional than a
    // weak typo-only terminal match. Example:
    //   phtrim -> phase.trim()
    // `trim` alone only weakly typo-matches `phtrim`, while `phase.trim`
    // strongly matches the user's receiver+operation intent.
    if (compositeScore >= 500 && primaryScore < 500 && compositeScore >= primaryScore + 120) {
      return {
        score: compositeScore + 140,
        target: compositeTarget,
        primaryScore,
        compositeScore
      };
    }

    // Exact/prefix/subsequence terminal matches remain the strongest signal.
    const primaryBonus = primaryScore >= 500 ? 320 : 0;
    return {
      score: primaryScore + primaryBonus + Math.max(0, compositeScore >= 0 ? Math.min(80, compositeScore - primaryScore) : 0),
      target: primary,
      primaryScore,
      compositeScore
    };
  }
  if (compositeScore >= 0) {
    // A strong receiver+member fuzzy match is a first-class intent signal.
    // Weak composite matches remain secondary to a direct member-name match.
    const compositeBonus = compositeScore >= 500 ? 120 : -120;
    return { score: Math.max(1, compositeScore + compositeBonus), target: compositeTarget, primaryScore, compositeScore };
  }
  return { score: -1, target: '', primaryScore, compositeScore };
}

function completionMatchScore(candidate, query) {
  return completionMatch(candidate, query).score;
}

function nameScore(nameOrCandidate, prefix, parameterName) {
  const candidate = typeof nameOrCandidate === 'string'
    ? { name: nameOrCandidate, matchName: nameOrCandidate }
    : (nameOrCandidate || {});
  const primary = String(candidate.matchName || candidate.name || '');
  const n = primary.toLowerCase();
  const expected = (parameterName || '').toLowerCase();
  let score = 0;
  if (prefix) {
    const fuzzy = completionMatchScore(candidate, prefix);
    if (fuzzy < 0) return -1000;
    score += Math.round(fuzzy * 0.35);
  }
  if (expected) {
    if (n === expected) score += 180;
    else if (n.endsWith(expected) || expected.endsWith(n)) score += 85;
    else if (n.includes(expected) || expected.includes(n)) score += 45;
  }
  return score;
}

function stripCommentsAndStrings(text) {
  // Preserve newlines/positions well enough for local declaration scanning.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length))
    .replace(/"(?:\\.|[^"\\])*"/g, m => ' '.repeat(m.length))
    .replace(/'(?:\\.|[^'\\])'/g, m => ' '.repeat(m.length));
}

function collectCandidates(text, cursorOffset, options = {}) {
  const includeFields = options.includeFields !== false;
  const includeMethods = options.includeMethods !== false;
  const before = stripCommentsAndStrings(text.slice(0, cursorOffset));
  const candidates = [];
  const seen = new Map();

  // Captures normal Java declarations and parameters: Type name, Foo<Bar> name, Foo[] name.
  const decl = /(?:^|[;{}(),\n])\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|volatile|transient)\s+)*([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*(?:\s*<[^;={}()\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*(?=[=;,:){])/g;
  let m;
  while ((m = decl.exec(before))) {
    const type = normalizeType(m[1]);
    const name = m[2];
    if (!type || JAVA_KEYWORDS.has(type) || JAVA_KEYWORDS.has(name)) continue;
    const offset = m.index;
    const lineDistance = before.slice(offset).split('\n').length - 1;
    const localNameAt = m[0].lastIndexOf(name);
    const candidate = { name, type, kind: 'variable', offset, nameOffset: localNameAt >= 0 ? m.index + localNameAt : offset, lineDistance };
    const prev = seen.get(name);
    if (!prev || offset > prev.offset) seen.set(name, candidate);
  }

  // Fields can be missed by the delimiter above when modifiers/annotations are complex.
  if (includeFields) {
    const field = /(?:^|\n)\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:public|protected|private|static|final|volatile|transient)\s+)+([A-Za-z_$][\w$.]*(?:\s*<[^;={}\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/g;
    while ((m = field.exec(before))) {
      const type = normalizeType(m[1]);
      const name = m[2];
      if (!type || JAVA_KEYWORDS.has(name)) continue;
      const fieldNameAt = m[0].lastIndexOf(name);
      const candidate = { name, type, kind: 'field', offset: m.index, nameOffset: fieldNameAt >= 0 ? m.index + fieldNameAt : m.index, lineDistance: before.slice(m.index).split('\n').length - 1 };
      const prev = seen.get(name);
      if (!prev || candidate.offset > prev.offset) seen.set(name, candidate);
    }
  }

  for (const value of seen.values()) candidates.push(value);

  if (includeMethods) {
    // Methods in the current source are useful *expressions*, not just names. Include
    // parameterized methods as snippets so expected-type completion can offer calls
    // that actually produce the value required at the cursor.
    const allSource = stripCommentsAndStrings(text);
    const method = /(?:^|\n)\s*(?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\s+)*([A-Za-z_$][\w$.]*(?:\s*<[^;={}\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+[^\{]+)?\s*\{/g;
    while ((m = method.exec(allSource))) {
      const type = normalizeType(m[1]);
      const methodName = m[2];
      if (!type || type === 'void' || JAVA_KEYWORDS.has(methodName)) continue;
      const params = parseMethodParameters(m[3]);
      const argSnippet = params.map((p, i) => `\${${i + 1}:${p.name || 'arg'}}`).join(', ');
      const display = `${methodName}(${params.map(p => p.name || simpleType(p.type)).join(', ')})`;
      candidates.push({
        name: display,
        matchName: methodName,
        insertText: `${methodName}(${argSnippet})`,
        isSnippet: params.length > 0,
        type,
        kind: 'method',
        offset: m.index,
        lineDistance: Math.abs((text.slice(0, cursorOffset).match(/\n/g) || []).length - (text.slice(0, m.index).match(/\n/g) || []).length)
      });
    }
  }

  if (options.includeConstruction !== false && options.expectedType) {
    const t = simpleType(options.expectedType);
    if (t && /^[A-Z_$]/.test(t) && !t.endsWith('[]')) {
      candidates.push({
        name: `new ${t}()`,
        matchName: t,
        insertText: `new ${t}(\${1})`,
        isSnippet: true,
        type: options.expectedType,
        kind: 'constructor',
        offset: cursorOffset,
        lineDistance: 0
      });
    }
  }

  return candidates;
}

function parseMethodParameters(body) {
  if (!body || !body.trim()) return [];
  return splitTopLevel(body, ',').map(raw => {
    const cleaned = raw.replace(/@[\w.]+(?:\([^)]*\))?\s*/g, '').replace(/\bfinal\b\s*/g, '').trim();
    const match = cleaned.match(/^(.+?)\s+([A-Za-z_$][\w$]*)$/);
    return match ? { type: normalizeType(match[1]), name: match[2] } : { type: normalizeType(cleaned), name: '' };
  });
}

function rankCandidates(candidates, context) {
  const expectedType = context.expectedType || '';
  const prefix = context.prefix || '';
  const parameterName = context.parameterName || '';

  return candidates.map(c => {
    const compatibility = typeCompatibility(c.type, expectedType);
    if (!compatibility) return null;
    const ns = nameScore(c, prefix, parameterName);
    if (ns < 0) return null;
    let score = compatibility * 1000 + ns;
    if (c.kind === 'variable') score += 120;
    else if (c.kind === 'field') score += 75;
    else if (c.kind === 'method') score += 45;
    else if (c.kind === 'receiverMethod') score += 65;
    else if (c.kind === 'receiverField') score += 55;
    else if (c.kind === 'constructor') score += 10;
    score += Math.max(0, 80 - Math.min(80, c.lineDistance || 0));
    return { ...c, compatibility, score };
  }).filter(Boolean).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

function parseSignatureParameter(signatureLabel, activeParameter) {
  if (!signatureLabel || activeParameter == null || activeParameter < 0) return null;
  const open = signatureLabel.indexOf('(');
  const close = signatureLabel.lastIndexOf(')');
  if (open < 0 || close <= open) return null;
  const body = signatureLabel.slice(open + 1, close);
  const params = splitTopLevel(body, ',');
  const raw = (params[activeParameter] || '').trim();
  if (!raw) return null;
  const cleaned = raw.replace(/@[\w.]+(?:\([^)]*\))?\s*/g, '').replace(/\bfinal\b\s*/g, '').trim();
  const match = cleaned.match(/^(.+?)\s+([A-Za-z_$][\w$]*)$/);
  if (match) return { type: normalizeType(match[1]), name: match[2], raw };
  return { type: normalizeType(cleaned), name: '', raw };
}

function splitTopLevel(text, delimiter) {
  const out = [];
  let start = 0;
  let angle = 0, paren = 0, bracket = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '<') angle++;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    else if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    else if (ch === delimiter && angle === 0 && paren === 0 && bracket === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function inferExpectedTypeFromText(text, cursorOffset) {
  const before = text.slice(0, cursorOffset);
  const line = before.slice(before.lastIndexOf('\n') + 1);

  // Type name = <cursor>
  let m = line.match(/(?:^|[;{}])\s*([A-Za-z_$][\w$.]*(?:\s*<[^;=]+>)?(?:\s*\[\s*\])*)\s+[A-Za-z_$][\w$]*\s*=\s*[^;]*$/);
  if (m) return { expectedType: normalizeType(m[1]), source: 'assignment' };

  // return <cursor> inside a normal Java method. This makes expected-expression
  // ranking useful for return values even when signature help is irrelevant.
  if (/\breturn\s+[^;]*$/.test(line)) {
    const returnType = findEnclosingMethodReturnType(text, cursorOffset);
    if (returnType && returnType !== 'void') return { expectedType: returnType, source: 'return' };
  }

  return null;
}

function findEnclosingMethodReturnType(text, cursorOffset) {
  const clean = stripCommentsAndStrings(text.slice(0, cursorOffset));
  const method = /(?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\s+)*([A-Za-z_$][\w$.]*(?:\s*<[^;={}\n]+>)?(?:\s*\[\s*\])*)\s+[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*(?:throws\s+[^\{]+)?\s*\{/g;
  let match;
  let best = null;
  while ((match = method.exec(clean))) {
    const brace = clean.indexOf('{', match.index);
    if (brace < 0) continue;
    let depth = 0;
    for (let i = brace; i < clean.length; i++) {
      if (clean[i] === '{') depth++;
      else if (clean[i] === '}') depth--;
    }
    if (depth > 0) best = normalizeType(match[1]);
  }
  return best;
}


function findMatching(text, openIndex, openChar, closeChar) {
  let depth = 0;
  let inString = false;
  let quote = '';
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';
    if (inString) {
      if (ch === quote && prev !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; continue; }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function findTypeRegion(source, typeName) {
  const clean = stripCommentsAndStrings(source);
  const escaped = String(typeName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return null;
  const re = new RegExp('\\b(class|interface|record|enum)\\s+' + escaped + '\\b', 'g');
  const m = re.exec(clean);
  if (!m) return null;
  const kind = m[1];
  const headerStart = m.index;
  const brace = clean.indexOf('{', re.lastIndex);
  if (brace < 0) return null;
  const end = findMatching(clean, brace, '{', '}');
  if (end < 0) return null;
  return { kind, headerStart, headerEnd: brace, bodyStart: brace + 1, bodyEnd: end };
}

function collectTypeMembers(source, typeName) {
  const region = findTypeRegion(source, typeName);
  if (!region) return [];
  const members = [];
  const seen = new Set();

  if (region.kind === 'record') {
    const header = source.slice(region.headerStart, region.headerEnd);
    const nameAt = header.indexOf(typeName);
    const open = header.indexOf('(', nameAt + typeName.length);
    if (open >= 0) {
      const close = findMatching(header, open, '(', ')');
      if (close > open) {
        for (const p of parseMethodParameters(header.slice(open + 1, close))) {
          if (!p.name || !p.type) continue;
          const key = `${p.name}()`;
          if (!seen.has(key)) {
            seen.add(key);
            members.push({ name: p.name, type: p.type, kind: 'method', call: '()', recordComponent: true });
          }
        }
      }
    }
  }

  const body = stripCommentsAndStrings(source.slice(region.bodyStart, region.bodyEnd));
  const method = /(?:^|\n)\s*((?:(?:public|protected|private|static|final|synchronized|native|abstract|default)\s+)*)(([A-Za-z_$][\w$.]*)(?:\s*<[^;={}\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  let m;
  while ((m = method.exec(body))) {
    const modifiers = m[1] || '';
    if (/\bprivate\b/.test(modifiers)) continue;
    const returnType = normalizeType(m[2]);
    const name = m[4];
    const params = parseMethodParameters(m[5]);
    if (!returnType || returnType === 'void' || !name || JAVA_KEYWORDS.has(name)) continue;
    // Receiver traversal intentionally uses zero-argument members only. These are
    // safe expressions to inject and keep recursive exploration bounded/predictable.
    if (params.length !== 0) continue;
    const key = `${name}()`;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({ name, type: returnType, kind: 'method', call: '()' });
  }

  const field = /(?:^|\n)\s*((?:(?:public|protected|static|final|volatile|transient)\s+)+)([A-Za-z_$][\w$.]*(?:\s*<[^;={}\n]+>)?(?:\s*\[\s*\])*)\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/g;
  while ((m = field.exec(body))) {
    const type = normalizeType(m[2]);
    const name = m[3];
    if (!type || !name || JAVA_KEYWORDS.has(name)) continue;
    const key = name;
    if (seen.has(key)) continue;
    seen.add(key);
    members.push({ name, type, kind: 'field', call: '' });
  }
  return members;
}


function collectDirectSuperTypes(source, typeName) {
  const region = findTypeRegion(source, typeName);
  if (!region) return [];
  const header = source.slice(region.headerStart, region.headerEnd);
  const out = [];
  const ext = header.match(/\bextends\s+([A-Za-z_$][\w$.]*(?:\s*<[^>{}]+>)?)/);
  if (ext) out.push(normalizeType(ext[1]));
  const impl = header.match(/\bimplements\s+([^{}]+)$/);
  if (impl) {
    for (const part of splitTopLevel(impl[1], ',')) {
      const t = normalizeType(part);
      if (t) out.push(t);
    }
  }
  return out;
}

function isTraversableType(type) {
  const t = simpleType(type);
  if (!t || t.endsWith('[]')) return false;
  return !new Set(['boolean','byte','short','int','long','float','double','char','Boolean','Byte','Short','Integer','Long','Float','Double','Character','String','Object','Class']).has(t);
}

module.exports = {
  stripCommentsAndStrings,
  normalizeType,
  simpleType,
  canonicalType,
  typeCompatibility,
  identifierPrefix,
  findDeclaredValueType,
  memberNameScore,
  fuzzyNameScore,
  completionMatchScore,
  completionMatch,
  collectCandidates,
  rankCandidates,
  parseSignatureParameter,
  splitTopLevel,
  inferExpectedTypeFromText,
  parseMethodParameters,
  findEnclosingMethodReturnType,
  collectTypeMembers,
  collectDirectSuperTypes,
  findTypeRegion,
  isTraversableType
};
