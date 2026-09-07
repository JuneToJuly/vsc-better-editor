'use strict';

const assert = require('assert');
const p = require('../src/postfix');

function ctx(source) {
  return p.findPostfixContext(source, source.length);
}

let c = ctx('customer.out');
assert(c);
assert.strictEqual(c.expression, 'customer');
assert.strictEqual(c.keyword, 'out');
assert(p.getTemplatesForContext(c).some(t => t.key === 'out'));

c = ctx('order.getCustomer().var');
assert(c);
assert.strictEqual(c.expression, 'order.getCustomer()');
assert.strictEqual(p.deriveVariableName(c.expression), 'customer');

c = ctx('Customer.new');
assert(c);
assert(p.getTemplatesForContext(c).some(t => t.key === 'new'));

c = ctx('customer.new');
assert(c);
assert(!p.getTemplatesForContext(c).some(t => t.key === 'new'));

c = ctx('items.fo');
const keys = p.getTemplatesForContext(c).map(t => t.key);
assert(keys.includes('for'));
assert(keys.includes('fori'));

c = ctx('service.findAccount().nn');
assert(c);
assert.strictEqual(c.expression, 'service.findAccount()');
assert.strictEqual(p.deriveVariableName('service.findAccount()'), 'account');

c = ctx('request.isValid().if');
assert(c);
assert.strictEqual(c.expression, 'request.isValid()');

assert.strictEqual(p.deriveVariableName('getCustomer()'), 'customer');
assert.strictEqual(p.deriveVariableName('loadUser()'), 'user');
assert.strictEqual(p.deriveVariableName('foo.bar'), 'bar');

console.log('postfix tests passed');
