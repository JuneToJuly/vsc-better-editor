const assert = require('assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'memberResolver.js'), 'utf8');

assert(
  src.includes('Do not synthesize receiver fields from DocumentSymbol at all.'),
  'DocumentSymbol field fallback should stay disabled'
);
assert(
  /else if \(symbolKindIsField\(child\.kind\)\) \{[\s\S]*?continue;[\s\S]*?\}/.test(src),
  'field-like JDT symbols should be ignored'
);

console.log('document symbol field tests passed');
