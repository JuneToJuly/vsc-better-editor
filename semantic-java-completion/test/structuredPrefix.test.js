const assert = require('assert');
const fs = require('fs');
const path = require('path');

const extensionSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'extension.js'), 'utf8');

assert(extensionSource.includes('if (!root.startsWith(left)) continue;'));
assert(extensionSource.includes('if (!member.startsWith(right)) continue;'));
assert(!extensionSource.includes('const rs = semantic.fuzzyNameScore(root, left)'));
assert(!extensionSource.includes('const ms = semantic.fuzzyNameScore(member, right)'));

console.log('structured prefix scorer tests passed');
