'use strict';

const IDENT = /^[A-Za-z_$][\w$]*$/;

const TEMPLATES = [
  { key: 'new', aliases: [], label: '.new', detail: 'Create a new instance', kind: 'type', expand: ctx => `new ${ctx.expression}(\${1})\${0}` },
  { key: 'out', aliases: ['sout'], label: '.out', detail: 'Print expression with System.out.println', kind: 'expression', expand: ctx => `System.out.println(${ctx.expression});\${0}` },
  { key: 'var', aliases: [], label: '.var', detail: 'Introduce a local var', kind: 'expression', expand: ctx => `var \${1:${deriveVariableName(ctx.expression)}} = ${ctx.expression};\${0}` },
  { key: 'return', aliases: [], label: '.return', detail: 'Return expression', kind: 'expression', expand: ctx => `return ${ctx.expression};\${0}` },
  { key: 'throw', aliases: [], label: '.throw', detail: 'Throw expression', kind: 'expression', expand: ctx => `throw ${ctx.expression};\${0}` },
  { key: 'if', aliases: [], label: '.if', detail: 'Wrap expression in if', kind: 'expression', expand: ctx => `if (${ctx.expression}) {\n\t\${0}\n}` },
  { key: 'while', aliases: [], label: '.while', detail: 'Wrap expression in while', kind: 'expression', expand: ctx => `while (${ctx.expression}) {\n\t\${0}\n}` },
  { key: 'not', aliases: ['neg'], label: '.not', detail: 'Negate expression', kind: 'expression', expand: ctx => `!(${ctx.expression})\${0}` },
  { key: 'null', aliases: [], label: '.null', detail: 'Check expression for null', kind: 'expression', expand: ctx => `${ctx.expression} == null\${0}` },
  { key: 'nn', aliases: ['notnull'], label: '.nn', detail: 'Check expression for non-null', kind: 'expression', expand: ctx => `${ctx.expression} != null\${0}` },
  { key: 'for', aliases: ['foreach'], label: '.for', detail: 'Enhanced for loop', kind: 'expression', expand: ctx => `for (var \${1:item} : ${ctx.expression}) {\n\t\${0}\n}` },
  { key: 'fori', aliases: [], label: '.fori', detail: 'Indexed for loop using expression length/size', kind: 'expression', expand: ctx => indexedLoopSnippet(ctx.expression) },
  { key: 'optional', aliases: ['opt'], label: '.optional', detail: 'Wrap with Optional.ofNullable', kind: 'expression', expand: ctx => `Optional.ofNullable(${ctx.expression})\${0}` },
  { key: 'requireNonNull', aliases: ['nonnull'], label: '.requireNonNull', detail: 'Wrap with Objects.requireNonNull', kind: 'expression', expand: ctx => `Objects.requireNonNull(${ctx.expression})\${0}` }
];

function findPostfixContext(text, cursorOffset) {
  if (!text || cursorOffset <= 0) return null;
  const before = text.slice(0, cursorOffset);
  const suffix = before.match(/\.([A-Za-z_$][\w$]*)?$/);
  if (!suffix) return null;

  const keyword = suffix[1] || '';
  const dotOffset = cursorOffset - keyword.length - 1;
  const expressionEnd = dotOffset;
  const expressionStart = findExpressionStart(text, expressionEnd);
  if (expressionStart == null || expressionStart >= expressionEnd) return null;

  const expression = text.slice(expressionStart, expressionEnd).trim();
  if (!expression || !isPlausibleExpression(expression)) return null;

  const leadingTrim = text.slice(expressionStart, expressionEnd).search(/\S/);
  const actualStart = expressionStart + Math.max(0, leadingTrim);

  return {
    expression,
    expressionStart: actualStart,
    expressionEnd,
    dotOffset,
    keyword,
    replaceStart: actualStart,
    replaceEnd: cursorOffset
  };
}

function findExpressionStart(text, end) {
  let i = end - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let inString = false;
  let quote = '';

  for (; i >= 0; i--) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : '';

    if (inString) {
      if (ch === quote && prev !== '\\') inString = false;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === ')') { paren++; continue; }
    if (ch === ']') { bracket++; continue; }
    if (ch === '}') { brace++; continue; }
    if (ch === '(') {
      if (paren > 0) { paren--; continue; }
      return i + 1;
    }
    if (ch === '[') {
      if (bracket > 0) { bracket--; continue; }
      return i + 1;
    }
    if (ch === '{') {
      if (brace > 0) { brace--; continue; }
      return i + 1;
    }

    if (paren || bracket || brace) continue;

    if (ch === ';' || ch === ',' || ch === '=' || ch === '\n' || ch === '\r' || ch === '{' || ch === '}') {
      return i + 1;
    }

    // Stop after Java control-flow/operator boundaries, but preserve dotted/member chains.
    if (ch === ':' || ch === '?' || ch === '&' || ch === '|' || ch === '+' || ch === '*' || ch === '%' || ch === '!') {
      return i + 1;
    }
    if (ch === '-' && prev !== '>') return i + 1;
    if (ch === '<' || ch === '>') return i + 1;
  }
  return 0;
}

function isPlausibleExpression(expression) {
  const s = expression.trim();
  if (!s) return false;
  if (/^(return|throw|case|package|import)\b/.test(s)) return false;
  if (/;/.test(s)) return false;
  return /[A-Za-z0-9_$)'"\]]$/.test(s);
}

function templateMatches(prefix, template) {
  const p = (prefix || '').toLowerCase();
  if (!p) return true;
  return [template.key, ...template.aliases].some(k => k.toLowerCase().startsWith(p));
}

function getTemplatesForContext(ctx) {
  if (!ctx) return [];
  return TEMPLATES.filter(t => {
    if (!templateMatches(ctx.keyword, t)) return false;
    if (t.kind === 'type') return looksLikeTypeExpression(ctx.expression);
    return true;
  });
}

function looksLikeTypeExpression(expression) {
  const s = expression.trim();
  if (!s || /[()\[\]"']/g.test(s)) return false;
  const parts = s.split('.');
  if (!parts.every(p => IDENT.test(p))) return false;
  const last = parts[parts.length - 1];
  return /^[A-Z_$]/.test(last);
}

function deriveVariableName(expression) {
  let s = expression.trim();
  s = s.replace(/^\([^)]*\)\s*/, '');

  let m = s.match(/\.([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*$/);
  if (!m) m = s.match(/^([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*$/);
  if (m) {
    let name = m[1];
    if (/^get[A-Z]/.test(name)) name = name.slice(3);
    else if (/^is[A-Z]/.test(name)) name = name.slice(2);
    else if (/^find[A-Z]/.test(name)) name = name.slice(4);
    else if (/^create[A-Z]/.test(name)) name = name.slice(6);
    else if (/^load[A-Z]/.test(name)) name = name.slice(4);
    name = decapitalize(name);
    return sanitizeName(name) || 'value';
  }

  m = s.match(/\.([A-Za-z_$][\w$]*)$/) || s.match(/^([A-Za-z_$][\w$]*)$/);
  if (m) return sanitizeName(decapitalize(m[1])) || 'value';

  m = s.match(/new\s+([A-Za-z_$][\w$]*)/);
  if (m) return sanitizeName(decapitalize(m[1])) || 'value';
  return 'value';
}

function decapitalize(name) {
  if (!name) return name;
  if (name.length > 1 && /^[A-Z]{2}/.test(name)) return name.toLowerCase();
  return name[0].toLowerCase() + name.slice(1);
}

function sanitizeName(name) {
  if (!name || !IDENT.test(name)) return '';
  const reserved = new Set(['class','var','new','return','throw','if','for','while','null','true','false','this','super']);
  return reserved.has(name) ? `${name}Value` : name;
}

function indexedLoopSnippet(expression) {
  // We cannot know array-vs-collection cheaply without another JDT round trip.
  // size() is the most useful default; the second choice is a snippet placeholder so arrays are one edit away.
  return `for (int \${1:i} = 0; \${1:i} < ${expression}.\${2:size()}; \${1:i}++) {\n\t\${0}\n}`;
}

module.exports = {
  TEMPLATES,
  findPostfixContext,
  findExpressionStart,
  getTemplatesForContext,
  looksLikeTypeExpression,
  deriveVariableName,
  indexedLoopSnippet
};
