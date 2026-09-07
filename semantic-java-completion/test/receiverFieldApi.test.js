const assert = require('assert');
const resolver = require('../src/memberResolver');

const src = `
package example.inventory;
public class Holder {
  private int privateField;
  protected int protectedField;
  int packageField;
  public int publicField;
}
`;

const parsed = resolver.parseTypeSource(src, 'example.inventory.Holder', {
  allowPrivate: true,
  allowPackage: true,
  allowProtected: true
});

// Parser remains semantically complete; completion filtering happens later.
assert(parsed.members.some(m => m.name === 'privateField' && m.isPublic === false));
assert(parsed.members.some(m => m.name === 'protectedField' && m.isPublic === false));
assert(parsed.members.some(m => m.name === 'packageField' && m.isPublic === false));
assert(parsed.members.some(m => m.name === 'publicField' && m.isPublic === true));

console.log('receiver field API metadata tests passed');
