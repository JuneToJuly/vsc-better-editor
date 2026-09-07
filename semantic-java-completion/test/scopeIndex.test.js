'use strict';
const assert = require('assert');
const scope = require('../src/scopeIndex');

const text = `class X {
  String field;
  void f(Request request) {
    String outer = "";
    if (true) {
      int hidden = 1;
    }
    try {
    } catch (RuntimeException failure) {
      getM
    }
  }
}`;
const cursor = text.indexOf('getM') + 4;
const names = scope.collectVisibleValues(text, cursor).map(x => x.name);
assert(names.includes('failure'), 'catch parameter should be visible');
assert(names.includes('request'), 'method parameter should be visible');
assert(names.includes('outer'), 'outer local should be visible');
assert(names.includes('field'), 'field should be visible');
assert(!names.includes('hidden'), 'closed sibling-block local must not be visible');
console.log('scopeIndex tests passed');

const chainText = `class Y {
  List<String> events;
  void f() {
    List<String> list = events.stream().filter(p -> true).map(p -> p).toList();
    add
  }
}`;
const chainCursor = chainText.indexOf('add') + 3;
const chainValues = scope.collectVisibleValues(chainText, chainCursor).map(x => x.name);
assert(chainValues.includes('list'), 'local declared from a chained/lambda initializer must stay visible as a graph root');
assert(chainValues.includes('events'), 'outer field must remain visible beside newer locals');

const rangeText = `class Z {
  List<String> events;
  void f(Request request) {
    List<String> before = events;
    if (true) {
      List<String> inner = events;
    }
    List<String> after = events;
    TARGET
  }
}`;
const rangeIndex = scope.buildDocumentIndex(rangeText);
const targetOffset = rangeText.indexOf('TARGET');
const rangeCtx = scope.valuesAtCursor(rangeIndex, rangeText, targetOffset);
assert(rangeCtx.method, 'method context should be indexed');
assert(rangeCtx.allValues.some(v => v.name === 'inner'), 'method index should retain inactive locals for prewarming');
assert(rangeCtx.visibleValues.some(v => v.name === 'after'), 'later active local should be visible at target');
assert(!rangeCtx.visibleValues.some(v => v.name === 'inner'), 'closed-block local should be disabled by cursor context');
assert(rangeCtx.visibleValues.some(v => v.name === 'events'), 'field should remain visible in method context');

// Regression: declaration index keeps a type-token anchor distinct from name token.
{
  const text = `class X { void m() { java.util.List<String> events = null; } }`;
  const idx = scope.buildDocumentIndex(text);
  const events = idx.declarations.find(x => x.name === 'events');
  assert(events);
  assert(Number.isFinite(events.typeOffset));
  assert.strictEqual(text.slice(events.typeOffset, events.typeOffset + 'java.util.List<String>'.length), 'java.util.List<String>');
  assert(events.typeOffset < events.nameOffset);
}
