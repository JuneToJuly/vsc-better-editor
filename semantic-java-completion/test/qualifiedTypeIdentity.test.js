const assert = require('assert');
const resolver = require('../src/memberResolver');

function doc(text) { return { getText: () => text }; }

assert.strictEqual(
  resolver.importedQualifiedType(doc('package example.order; class X {}'), 'String'),
  'java.lang.String'
);
assert.strictEqual(
  resolver.qualifiedTypeIdentity(doc('package example.order; class X {}'), 'String'),
  'java.lang.String'
);
assert.strictEqual(
  resolver.qualifiedTypeIdentity(doc('package example.order;\nimport java.util.List;\nclass X {}'), 'List<String>'),
  'java.util.List<String>'
);
assert.strictEqual(
  resolver.qualifiedTypeIdentity(doc('package example.order; class X {}'), 'OrderRepository'),
  'example.order.OrderRepository'
);

const wrongString = `
package some.other;
public class String {
  public void setRight(Object r) {}
}
`;
assert.deepStrictEqual(
  resolver.parseTypeSource(wrongString, 'java.lang.String', {allowPackage:false,allowProtected:false,allowPrivate:false}).members,
  [],
  'a same-simple-name class from another package must be rejected'
);

console.log('qualified type identity tests passed');
