const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'memberResolver.js'), 'utf8');

assert(
  src.includes('Do not synthesize receiver fields from DocumentSymbol at all.'),
  'DocumentSymbol fields must remain disabled'
);
assert(
  !src.includes("if (!/\\\\bpublic\\\\b/.test(String(fieldLine || ''))) continue;"),
  'the old line-based public-field heuristic must not return'
);

console.log('symbol field visibility tests passed');
