const assert = require('assert');
const semantic = require('../src/semantic');

const setStack = {
  name: 'failure.setStackTrace(${1:stackTrace})',
  matchName: 'setStackTrace',
  matchNames: [
    'failuresetStackTrace',
    'failure.setStackTrace',
    'setStackTracefailure',
    'setStackTrace.failure'
  ]
};

const falseCandidate = {
  name: 'reservations.stream().false',
  matchName: 'false',
  matchNames: ['reservationsfalse']
};

const wanted = semantic.completionMatch(setStack, 'failse');
const noise = semantic.completionMatch(falseCandidate, 'failse');

assert(wanted.score >= 0, 'failse should match failure.setStackTrace');
assert(wanted.score > noise.score,
  `failure.setStackTrace (${wanted.score}) should outrank false (${noise.score})`);
assert(semantic.fuzzyNameScore('getMessage', 'getmes') >= 0,
  'getmes should fuzzy-match getMessage');
assert(semantic.fuzzyNameScore('setStackTrace', 'zzzzz') < 0,
  'unrelated text should not match setStackTrace');

console.log('fuzzy terminal/composite tests passed');
