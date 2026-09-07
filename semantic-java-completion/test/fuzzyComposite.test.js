const assert = require('assert');
const semantic = require('../src/semantic');

const trim = {
  name: 'phase.trim()',
  matchName: 'trim',
  matchNames: ['phasetrim', 'phase.trim', 'trimphase', 'trim.phase']
};
const split = {
  name: 'phase.split(${1:regex}, ${2:limit})',
  matchName: 'split',
  matchNames: ['phasesplit', 'phase.split', 'splitphase', 'split.phase']
};

const trimMatch = semantic.completionMatch(trim, 'phtrim');
const splitMatch = semantic.completionMatch(split, 'phtrim');

assert(trimMatch.score >= 700,
  `phtrim should strongly match phase.trim(), got ${trimMatch.score}`);
assert(trimMatch.score > splitMatch.score,
  `phase.trim (${trimMatch.score}) should outrank phase.split (${splitMatch.score})`);

console.log('fuzzy composite tests passed');
