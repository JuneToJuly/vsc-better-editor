'use strict';
const assert = require('assert');
const s = require('../src/semantic');

assert.deepStrictEqual(
  s.parseSignatureParameter('submit(Order order, Customer customer, List<String> tags)', 1),
  { type: 'Customer', name: 'customer', raw: 'Customer customer' }
);

assert.strictEqual(s.typeCompatibility('com.foo.Customer', 'Customer'), 0.98);
assert.strictEqual(s.identifierPrefix('submit(order, cus'), 'cus');

const code = `class Demo {
  private Customer fallbackCustomer;
  Customer activeCustomer() { return null; }
  void run(Order order, Customer customer) {
    Customer currentCustomer = customer;
    submit(order, cur);
  }
}`;
const cursor = code.indexOf('cur);') + 3;
const candidates = s.collectCandidates(code, cursor, { includeFields: true, includeMethods: true });
const ranked = s.rankCandidates(candidates, { expectedType: 'Customer', parameterName: 'customer', prefix: 'cur' });
assert.strictEqual(ranked[0].name, 'currentCustomer');

const assignment = 'Customer target = cus';
assert.deepStrictEqual(s.inferExpectedTypeFromText(assignment, assignment.length), { expectedType: 'Customer', source: 'assignment' });

console.log('semantic tests passed');


const richer = `class Demo {
  Customer loadCustomer(String id) { return null; }
  void run() {
    Customer x = lo;
  }
}`;
const richerCursor = richer.indexOf('lo;') + 2;
const richerCandidates = s.collectCandidates(richer, richerCursor, { includeMethods: true, expectedType: 'Customer', includeConstruction: true });
const richerRanked = s.rankCandidates(richerCandidates, { expectedType: 'Customer', prefix: 'lo' });
assert(richerRanked.some(c => c.matchName === 'loadCustomer' && c.isSnippet));

const returnCode = `class Demo {
  Customer current() {
    return cus
  }
}`;
const returnCursor = returnCode.indexOf('cus') + 3;
assert.deepStrictEqual(s.inferExpectedTypeFromText(returnCode, returnCursor), { expectedType: 'Customer', source: 'return' });

const recordSource = `package demo;
public record OrderRequest(String customerId, List<OrderLine> lines) {
  public List<OrderLine> copiedLines() { return lines; }
  private List<OrderLine> hiddenLines() { return lines; }
}`;
const members = s.collectTypeMembers(recordSource, 'OrderRequest');
assert(members.some(m => m.name === 'lines' && m.type === 'List<OrderLine>' && m.call === '()'));
assert(members.some(m => m.name === 'copiedLines' && m.type === 'List<OrderLine>' && m.call === '()'));
assert(!members.some(m => m.name === 'hiddenLines'));
assert.strictEqual(s.typeCompatibility('List<OrderLine>', 'List<OrderLine>'), 1);

// Generic intent matching must not confuse different generic arguments.
assert.strictEqual(s.typeCompatibility('List<OrderLine>', 'List<InventoryLedger.Reservation>'), 0);
assert.strictEqual(
  s.typeCompatibility('java.util.List<com.acme.OrderLine>', 'List<OrderLine>'),
  0.98
);
assert.strictEqual(
  s.typeCompatibility('List<example.inventory.InventoryLedger.Reservation>', 'List<Reservation>'),
  0.98
);

const fieldSource = `final class OrderWorkflow {
  OrderReceipt place(OrderRequest request, CustomerProfile customer) {
    customer.customerId();
    return null;
  }
}`;
const customerUse = fieldSource.indexOf('customer.customerId') + 'customer'.length;
assert.strictEqual(s.findDeclaredValueType(fieldSource, 'customer', customerUse), 'CustomerProfile');
assert(s.memberNameScore('getMessage', 'getMes') > s.memberNameScore('getLocalizedMessage', 'getMes'));
assert.strictEqual(s.memberNameScore('rollback', 'getMes'), -1);

const inheritanceSource = `class Child extends Parent implements Runnable {}`;
assert.deepStrictEqual(s.collectDirectSuperTypes(inheritanceSource, 'Child'), ['Parent', 'Runnable']);

// Receiver + member fuzzy intent: developers often type the semantic phrase
// rather than the literal member name.
assert(s.completionMatchScore({
  name: 'fraud.reasons()',
  matchName: 'reasons',
  matchNames: ['fraudreasons']
}, 'fraureasons') > 0);
assert(s.completionMatchScore({
  name: 'repository.save(${1:status}, ${2:total}, ${3:events})',
  matchName: 'save',
  matchNames: ['repositorysave']
}, 'reposave') > 0);

const semanticPhraseRanked = s.rankCandidates([{
  name: 'fraud.reasons()',
  matchName: 'reasons',
  matchNames: ['fraudreasons'],
  type: 'List<String>',
  kind: 'receiverMethod',
  lineDistance: 0
}], { expectedType: 'List<String>', prefix: 'fraureasons' });
assert.strictEqual(semanticPhraseRanked.length, 1);

// Direct terminal-member matches must dominate receiver/composite-only fuzzy matches.
const directSave = s.completionMatch({ name: 'repository.save()', matchName: 'save', matchNames: ['repositorysave'] }, 'save');
const looseSave = s.completionMatch({ name: 'customer.audit().add()', matchName: 'add', matchNames: ['customeradd', 'customerauditadd'] }, 'save');
assert(directSave.score > 1000, 'direct save member should score very highly');
assert.strictEqual(directSave.target, 'save');
assert.strictEqual(looseSave.score, -1, 'unrelated terminal member must not survive a save query');

const phraseSave = s.completionMatch({ name: 'repository.save()', matchName: 'save', matchNames: ['repositorysave'] }, 'reposave');
assert(phraseSave.score > 0, 'receiver+member shorthand should still work');
