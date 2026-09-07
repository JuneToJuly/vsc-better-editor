'use strict';

const postfix = require('./postfix');

function findCommandContext(text, cursorOffset) {
  if (!text || cursorOffset <= 1) return null;
  const before = text.slice(0, cursorOffset);
  const suffix = before.match(/\.\.([A-Za-z_$][\w$]*)?$/);
  if (!suffix) return null;

  const keyword = suffix[1] || '';
  const dotsOffset = cursorOffset - keyword.length - 2;
  const expressionEnd = dotsOffset;
  const expressionStart = postfix.findExpressionStart(text, expressionEnd);
  if (expressionStart == null || expressionStart >= expressionEnd) return null;

  const raw = text.slice(expressionStart, expressionEnd);
  const leadingTrim = raw.search(/\S/);
  const actualStart = expressionStart + Math.max(0, leadingTrim);
  const expression = text.slice(actualStart, expressionEnd).trim();
  if (!expression || !/[A-Za-z0-9_$)'"\]]$/.test(expression)) return null;

  return {
    expression,
    keyword,
    replaceStart: actualStart,
    replaceEnd: cursorOffset,
    dotsOffset
  };
}

function getCommands(ctx) {
  if (!ctx) return [];
  const prefix = (ctx.keyword || '').toLowerCase();
  const commands = [];

  for (const template of postfix.TEMPLATES) {
    if (template.kind === 'type' && !postfix.looksLikeTypeExpression(ctx.expression)) continue;
    for (const key of [template.key, ...template.aliases]) {
      if (prefix && !key.toLowerCase().startsWith(prefix)) continue;
      commands.push({
        key,
        label: key,
        detail: template.detail,
        group: 'Postfix',
        expand: () => template.expand({ expression: ctx.expression })
      });
    }
  }

  if (!prefix || 'field'.startsWith(prefix) || 'introducefield'.startsWith(prefix)) {
    commands.unshift({
      key: 'field',
      label: 'field',
      detail: 'Introduce expression as a class field',
      group: 'Refactor',
      action: 'introduceField',
      suggestedName: postfix.deriveVariableName(ctx.expression)
    });
  }

  if (!prefix || 'introduce'.startsWith(prefix) || 'var'.startsWith(prefix) || 'extract'.startsWith(prefix)) {
    commands.unshift({
      key: 'introduce',
      label: 'introduce',
      detail: 'Introduce expression as a local variable',
      group: 'Refactor',
      action: 'introduceVariable',
      suggestedName: postfix.deriveVariableName(ctx.expression)
    });
  }

  return commands;
}

module.exports = { findCommandContext, getCommands };
