'use strict';
const assert = require('assert');
const i = require('../src/introduce');

const source = `void run() {\n    submit(order.getCustomer());\n}`;
const start = source.indexOf('order.getCustomer()');
const end = start + 'order.getCustomer()'.length;
const edit = i.buildIntroduceVariableEdit(source, start, end);
assert(edit);
assert.strictEqual(edit.name, 'customer');
assert.strictEqual(edit.declarationText, '    var customer = order.getCustomer();\n');
assert.strictEqual(edit.replacementText, 'customer');
assert.strictEqual(edit.declarationOffset, source.indexOf('    submit'));

// Cursor expansion is intentionally forward-only. Starting on `failure` must
// never walk left into the string concatenation or outward into events.add(...).
const forwardSource = `class T {\n    void run() {\n        events.add("failed:" + failure.getClass().getSimpleName());\n    }\n}`;
const failureCursor = forwardSource.indexOf('failure') + 2;
const forward = i.findExpressionRangesAtCursor(forwardSource, failureCursor).map(r => r.expression);
assert.deepStrictEqual(forward, [
  'failure',
  'failure.getClass()',
  'failure.getClass().getSimpleName()'
]);
assert(!forward.some(x => x.includes('"failed:"')));
assert(!forward.some(x => x.startsWith('events.add')));

const requestSource = `void run() {\n    reserveAll(request.lines(), reservations);\n}`;
const requestCursor = requestSource.indexOf('request') + 2;
const requestRanges = i.findExpressionRangesAtCursor(requestSource, requestCursor).map(r => r.expression);
assert.deepStrictEqual(requestRanges, ['request', 'request.lines()']);

const fieldSource = `final class OrderWorkflow {\n    void run(RuntimeException failure) {\n        events.add(failure.getMessage());\n    }\n}`;
const fs = fieldSource.indexOf('failure.getMessage()');
const fe = fs + 'failure.getMessage()'.length;
const field = i.buildIntroduceFieldEdit(fieldSource, fs, fe, { name: 'message', type: 'String' });
assert(field);
assert.strictEqual(field.fieldDeclarationText, '    private String message;\n');
assert.strictEqual(field.assignmentText, '        this.message = failure.getMessage();\n');
assert.strictEqual(field.replacementText, 'this.message');
assert.strictEqual(field.fieldDeclarationOffset, fieldSource.indexOf('\n') + 1);

console.log('introduce tests passed');
