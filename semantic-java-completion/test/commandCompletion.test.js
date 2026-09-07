'use strict';
const assert = require('assert');
const c = require('../src/commandCompletion');

let ctx = c.findCommandContext('customer..', 'customer..'.length);
assert(ctx);
assert.strictEqual(ctx.expression, 'customer');
let cmds = c.getCommands(ctx);
assert(cmds.some(x => x.key === 'introduce'));
assert(cmds.some(x => x.key === 'out'));
assert(cmds.some(x => x.key === 'var'));

ctx = c.findCommandContext('order.getCustomer()..int', 'order.getCustomer()..int'.length);
assert(ctx);
assert.strictEqual(ctx.expression, 'order.getCustomer()');
cmds = c.getCommands(ctx);
assert.strictEqual(cmds[0].key, 'introduce');
assert.strictEqual(cmds[0].suggestedName, 'customer');

ctx = c.findCommandContext('Customer..n', 'Customer..n'.length);
cmds = c.getCommands(ctx);
assert(cmds.some(x => x.key === 'new'));

console.log('command completion tests passed');
