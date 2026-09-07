const assert = require('assert');
const resolver = require('../src/memberResolver');

let sig = resolver.parseDocumentSymbolMethod('trim()');
assert.strictEqual(sig.name, 'trim');
assert.deepStrictEqual(sig.params, []);

sig = resolver.parseDocumentSymbolMethod('add(E)');
assert.strictEqual(sig.name, 'add');
assert.strictEqual(sig.params.length, 1);
assert.strictEqual(sig.params[0].type, 'E');

sig = resolver.parseDocumentSymbolMethod('add(int index, E element)');
assert.strictEqual(sig.params.length, 2);
assert.strictEqual(sig.params[0].type, 'int');
assert.strictEqual(sig.params[0].name, 'index');
assert.strictEqual(sig.params[1].type, 'E');
assert.strictEqual(sig.params[1].name, 'element');

console.log('display signature tests passed');
