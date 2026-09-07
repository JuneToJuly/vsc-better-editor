'use strict';
const assert = require('assert');
const resolver = require('../src/memberResolver');

let parsed = resolver.parseTypeSource(`
class Parent { String inherited() { return ""; } }
class OrderRequest extends BaseRequest {
  java.util.List<OrderLine> lines() { return null; }
  String customerId;
}
`, 'OrderRequest');
assert(parsed.members.some(m => m.name === 'lines' && m.type.includes('List<OrderLine>')));
assert(parsed.members.some(m => m.name === 'customerId'));
assert(parsed.parents.some(p => p.includes('BaseRequest')));

parsed = resolver.parseTypeSource(`record Request(String customerId, java.util.List<OrderLine> lines) {}`, 'Request');
assert(parsed.members.some(m => m.name === 'lines' && m.call === '()'));

// External class accessibility: semantic completion must not leak implementation members.
{
  const source = `package java.lang;
    public class Demo {
      public int visible() { return 1; }
      protected int protectedValue() { return 2; }
      int packageValue() { return 3; }
      private int hidden() { return 4; }
      public int publicField;
      protected int protectedField;
      int packageField;
      private int privateField;
    }`;
  const external = resolver.parseTypeSource(source, 'java.lang.Demo', { allowPackage: false, allowProtected: false });
  assert(external.members.some(m => m.name === 'visible'));
  assert(external.members.some(m => m.name === 'publicField'));
  assert(!external.members.some(m => m.name === 'protectedValue'));
  assert(!external.members.some(m => m.name === 'packageValue'));
  assert(!external.members.some(m => m.name === 'hidden'));
  assert(!external.members.some(m => m.name === 'protectedField'));
  assert(!external.members.some(m => m.name === 'packageField'));
  assert(!external.members.some(m => m.name === 'privateField'));

  const samePackage = resolver.parseTypeSource(source, 'java.lang.Demo', { allowPackage: true, allowProtected: true });
  assert(samePackage.members.some(m => m.name === 'protectedValue'));
  assert(samePackage.members.some(m => m.name === 'packageValue'));
  assert(!samePackage.members.some(m => m.name === 'hidden'));
}

// Interface methods without an explicit public modifier are public by language rule.
{
  const source = `package java.util; public interface Tiny<E> { E get(); private E hidden() { return null; } }`;
  const parsed = resolver.parseTypeSource(source, 'java.util.Tiny', {});
  assert(parsed.members.some(m => m.name === 'get'));
  assert(!parsed.members.some(m => m.name === 'hidden'));
}

console.log('memberResolver tests passed');

parsed = resolver.parseTypeSource(`
class Repository {
  OrderReceipt save(String status, Money total, List<String> events) { return null; }
}
`, 'Repository');
const save = parsed.members.find(m => m.name === 'save');
assert(save && save.arity === 3 && save.isSnippet);
assert.deepStrictEqual(save.paramTypes, ['String', 'Money', 'List<String>']);
assert(save.call.includes('${1:status}') && save.call.includes('${3:events}'));


// Generic member types come from the real declaration and are specialized to the
// receiver type. This replaces the old handwritten List/Stream API tables.
parsed = resolver.parseTypeSource(`
public interface MiniList<E> extends Iterable<E> {
  boolean add(E value);
  void clear();
  MiniStream<E> stream();
}
`, 'MiniList<String>');
const genericAdd = parsed.members.find(m => m.name === 'add');
const genericClear = parsed.members.find(m => m.name === 'clear');
const genericStream = parsed.members.find(m => m.name === 'stream');
assert(genericAdd && genericAdd.paramTypes[0] === 'String');
assert(genericClear && genericClear.type === 'void');
assert(genericStream && genericStream.type === 'MiniStream<String>');
assert(parsed.parents.some(p => p === 'Iterable<String>'));

parsed = resolver.parseTypeSource(`
class SecretBox {
  private String hidden;
  private String secret() { return hidden; }
  public String visible() { return hidden; }
}
`, 'SecretBox');
assert(!parsed.members.some(m => m.name === 'hidden'), 'private field must not leak from another receiver type');
assert(!parsed.members.some(m => m.name === 'secret'), 'private method must not leak from another receiver type');
assert(parsed.members.some(m => m.name === 'visible'), 'public method should remain visible');

parsed = resolver.parseTypeSource(`
class SecretBox {
  private String hidden;
  private String secret() { return hidden; }
}
`, 'SecretBox', { allowPrivate: true });
assert(parsed.members.some(m => m.name === 'hidden'), 'private field should be available when access is explicitly allowed');
assert(parsed.members.some(m => m.name === 'secret'), 'private method should be available when access is explicitly allowed');


const patterns = resolver.candidateJavaFilePatterns('example.order.OrderRepository');
assert(patterns.includes('**/OrderRepository.java'));

const observed = resolver.observedMembersForReceiver(`
OrderReceipt receipt = repository.save("ACCEPTED", price.total(), events);
repository.findById(id);
`, 'repository');
const observedSave = observed.find(m => m.name === 'save');
assert(observedSave, 'observed receiver call should discover save');
assert(observedSave.arity === 3 && observedSave.isSnippet);
assert(observedSave.type === 'OrderReceipt', 'assignment should infer observed return type');
assert(observedSave.call.includes('${1:"ACCEPTED"}') && observedSave.call.includes('${3:events}'));

// Resolved member identity must ignore parameter names/snippet text while keeping
// true overloads distinct.
const removeO = { kind: 'method', name: 'remove', arity: 1, paramTypes: ['java.lang.Object'], type: 'boolean', call: '(${1:o})' };
const removeItem = { kind: 'method', name: 'remove', arity: 1, paramTypes: ['Object'], type: 'boolean', call: '(${1:item})' };
const removeIndex = { kind: 'method', name: 'remove', arity: 1, paramTypes: ['int'], type: 'String', call: '(${1:index})' };
assert.strictEqual(resolver.resolvedMemberIdentityKey(removeO), resolver.resolvedMemberIdentityKey(removeItem));
assert.notStrictEqual(resolver.resolvedMemberIdentityKey(removeO), resolver.resolvedMemberIdentityKey(removeIndex));

// Never parse an arbitrary same-file type when the requested type is absent.
parsed = resolver.parseTypeSource(`
package wrong.pkg;
class List { void filter(int l, int elem) {} }
`, 'java.util.List<String>');
assert.deepStrictEqual(parsed.members, [], 'wrong simple-name type must not be accepted for java.util.List');

const fakeCurrentDoc = {
  getText() { return `package example.order;\nimport java.util.List;\nimport example.repo.OrderRepository;\nclass X {}`; }
};
assert.strictEqual(resolver.importedQualifiedType(fakeCurrentDoc, 'List<String>'), 'java.util.List');
assert.strictEqual(resolver.importedQualifiedType(fakeCurrentDoc, 'OrderRepository'), 'example.repo.OrderRepository');
assert.strictEqual(resolver.documentDeclaresQualifiedType({ getText(){ return 'package example.repo; class OrderRepository {}'; } }, 'OrderRepository', 'example.repo.OrderRepository'), true);
assert.strictEqual(resolver.documentDeclaresQualifiedType({ getText(){ return 'package other; class OrderRepository {}'; } }, 'OrderRepository', 'example.repo.OrderRepository'), false);

// Regression: a simple-name List must not accept a different package when the
// requested identity is java.util.List.
{
  const wrong = `package example.fake; public class List { public void filter(int l, int elem) {} }`;
  const parsedWrong = resolver.parseTypeSource(wrong, 'java.util.List<String>');
  assert.strictEqual(parsedWrong.members.length, 0);
}

// Static members are metadata on the type, but must be identifiable so the
// receiver graph can exclude impossible/noisy instance chains such as events.of().
parsed = resolver.parseTypeSource(`
interface MiniList<E> {
  static <E> MiniList<E> of(E e) { return null; }
  MiniStream<E> stream();
}
`, 'MiniList<String>');
const staticOf = parsed.members.find(m => m.name === 'of');
const instanceStream = parsed.members.find(m => m.name === 'stream');
assert(staticOf && staticOf.isStatic === true, 'static methods must be marked');
assert(instanceStream && !instanceStream.isStatic, 'instance methods must not be marked static');

// An observed call that is only an intermediate link in a larger chain must not
// inherit the type of the final assignment.
const observedChain = resolver.observedMembersForReceiver(`
List<String> list = events.stream().filter(p -> true).map(p -> p).toList();
`, 'events');
const observedStream = observedChain.find(m => m.name === 'stream');
assert(observedStream, 'observed chain should still discover stream()');
assert.strictEqual(observedStream.type, '', 'intermediate observed call must not inherit final assignment type');

// Type qualification at an anchored JDK/dependency source must use that source's
// imports/package rather than the original user document's package.
const fakeDoc = text => ({ getText: () => text });
assert.strictEqual(
  resolver.importedQualifiedType(fakeDoc('package example.order;'), 'SequencedCollection<String>'),
  'example.order.SequencedCollection'
);
assert.strictEqual(
  resolver.importedQualifiedType(fakeDoc('package java.util;'), 'SequencedCollection<String>'),
  'java.util.SequencedCollection'
);
assert.strictEqual(
  resolver.importedQualifiedType(fakeDoc('package java.util;\nimport java.util.stream.Stream;'), 'Stream<String>'),
  'java.util.stream.Stream'
);
