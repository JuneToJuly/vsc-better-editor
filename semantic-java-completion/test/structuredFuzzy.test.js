const assert = require('assert');
const semantic = require('../src/semantic');

function structured(root, member, q) {
  let best = -1;
  for (let i = 1; i < q.length; i++) {
    const left=q.slice(0,i), right=q.slice(i);
    const rs=semantic.fuzzyNameScore(root,left), ms=semantic.fuzzyNameScore(member,right);
    if (rs < 450 || ms < 450) continue;
    let score=rs+ms;
    if (root.toLowerCase().startsWith(left.toLowerCase())) score += 180;
    if (member.toLowerCase().startsWith(right.toLowerCase())) score += 220;
    score += Math.min(120,right.length*18);
    best=Math.max(best,score);
  }
  return best;
}

assert(structured('phase','trim','ptri') > 0);
assert(structured('phase','trim','ptri') > structured('phase','stripTrailing','ptri'));
assert(structured('failure','setStackTrace','failse') > 0);
assert(structured('repository','save','reposave') > 0);
console.log('structured fuzzy tests passed');
