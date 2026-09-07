
'use strict';
const fs=require('fs'),vm=require('vm'),source=fs.readFileSync('./extension.js','utf8');
const funcs=['fileMatchScore','tokenizeQuery','fuzzyFieldScore','betterFuzzyState','semanticBoundary','isLower','isUpper','isLetter','isDigit'];
const consts=['FUZZY_CHAR_SCORE','FUZZY_CONSECUTIVE_BONUS','FUZZY_BOUNDARY_BONUS','FUZZY_FIRST_BOUNDARY_BONUS','FUZZY_GAP_OPEN_PENALTY','FUZZY_GAP_EXTEND_PENALTY','FUZZY_SPAN_PENALTY'];
function fn(n){let s=source.indexOf(`function ${n}(`),b=source.indexOf('{',s),d=0,e=b;if(s<0)throw Error('missing '+n);for(;e<source.length;e++){if(source[e]==='{')d++;else if(source[e]==='}'&&--d===0){e++;break}}return source.slice(s,e)}
let pieces=consts.map(n=>source.match(new RegExp(`const ${n} = [^;]+;`))[0]).concat(funcs.map(fn));
pieces.push('this.s=fuzzyFieldScore;this.f=fileMatchScore;this.boundary=semanticBoundary;');
const x={};vm.createContext(x);vm.runInContext(pieces.join('\n'),x);
const s=x.s,f=x.f;
const yes=(q,c)=>{if(s(q,c)<0)throw Error(`${q} should match ${c}`)};
const no=(q,c)=>{if(s(q,c)>=0)throw Error(`${q} should not match ${c}`)};
const gt=(q,a,b,m)=>{if(!(s(q,a)>s(q,b)))throw Error(`${m}: ${s(q,a)} <= ${s(q,b)}`)};
yes('owf','OrderWorkflow');
// "wfo" also occurs in OrderWorkflow in order (w@5, f@9, o@11), so the
// literal ordered-subsequence contract requires it to match. Use a genuinely
// out-of-order sequence for the negative invariant.
yes('wfo','OrderWorkflow');
no('fwo','OrderWorkflow');
gt('workflow','workflow','work_some_flow','consecutive');
for(const [v,i] of [['Order',0],['a/b',2],['a\\b',2],['a-b',2],['a_b',2],['a.b',2],['a b',2],['orderWorkflow',5],['file2',4],['2file',1]])if(!x.boundary(v,i))throw Error(`boundary ${v}@${i}`);
gt('abcdef','abcxxxxdef','axbxcxdxexf','gap opening');
gt('abc','a_bc','a___b___c','span');
if(!(f('owf','OrderWorkflow.java','src/x')>f('owf','Misc.java','src/order/workflow/Misc.java')))throw Error('primary field');
if(f('order inventory','OrderWorkflow.java','services/order/OrderWorkflow.java')>=0)throw Error('AND semantics');
if(!source.includes('a.label.localeCompare(b.label)'))throw Error('stable tie-break');
console.log('FUZZY MATCH CONTRACT checks passed.');
