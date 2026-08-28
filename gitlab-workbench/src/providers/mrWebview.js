const vscode=require('vscode');

class MrWebviewProvider {
 constructor(clientFactory){this.clientFactory=clientFactory;this.view=null;}
 resolveWebviewView(view){
  this.view=view;view.webview.options={enableScripts:true};
  view.webview.onDidReceiveMessage(m=>{
   if(m.type==='open'&&m.mr)vscode.commands.executeCommand('gitlabWorkbench.openMr',m.mr);
   if(m.type==='review'&&m.mr)vscode.commands.executeCommand('gitlabWorkbench.reviewMr',m.mr);
  });
  this.refresh();
 }
 async refresh(){
  if(!this.view)return;
  this.view.webview.html=loading();
  try{this.view.webview.html=render(await this.clientFactory().listMergeRequests());}
  catch(e){this.view.webview.html=page(`<div class="empty">Unable to load merge requests<br><small>${esc(String(e.message||e))}</small></div>`);}
 }
}
function render(all){
 const mrs=all.filter(x=>!x.kind),special=all.filter(x=>x.kind==='error');
 const reviews=mrs.filter(m=>m.isReviewer||m.hasMyComments);
 const reviewIds=new Set(reviews.map(key));
 const other=mrs.filter(m=>!reviewIds.has(key(m)));
 const groups=group(other),reviewGroups=group(reviews);
 let html='';
 if(reviews.length){
  const changed=reviews.filter(m=>Number(m.changesSinceMyComment||0)>0).length;
  html+=`<details open class="section"><summary><span class="chev"></span><span class="eye">◉</span><b>My Reviews</b><span class="badge">${reviews.length} open</span>${changed?`<span class="badge changed">${changed} changed</span>`:''}</summary>
   <div class="section-body">${[...reviewGroups.values()].map(project).join('')}</div></details>`;
 }
 for(const g of groups.values())html+=project(g);
 if(!mrs.length&&!special.length)html='<div class="empty">No open merge requests.</div>';
 if(special.length)html+=special.map(x=>`<div class="empty">${esc(x.error||x.repoName||'GitLab query failed')}</div>`).join('');
 return page(html);
}
function group(items){const m=new Map();for(const mr of items){const k=mr.repo||mr.repoName||'Project';if(!m.has(k))m.set(k,{name:mr.repoName||k,items:[]});m.get(k).items.push(mr);}return m;}
function project(g){return `<details open class="project"><summary><span class="chev"></span><span class="repo">▣</span><b>${esc(g.name)}</b><span class="badge">${g.items.length} open</span></summary><div class="cards">${g.items.map(card).join('')}</div></details>`;}
function card(mr){
 const changed=Number(mr.changesSinceMyComment||0),age=ageText(mr.created);
 const cls=changed?'warn':mr.pipeline==='failed'?'bad':'normal';
 const icon=changed?'↻':mr.pipeline==='failed'?'×':(mr.isReviewer||mr.hasMyComments)?'◉':'⑂';
 const activity=changed?`${changed} new commit${changed===1?'':'s'} since your last comment`:mr.hasMyComments?'No commits since your last comment':mr.isReviewer?'Review requested from you':'Open merge request (not requested from you)';
 const pipeline=mr.pipeline==='failed'?`<span class="pipeline badtext">⊗ Pipeline failed</span>`:mr.pipeline==='running'?`<span class="pipeline">◌ Pipeline running</span>`:mr.pipeline==='success'?`<span class="pipeline good">✓ Pipeline passed</span>`:'';
 const payload=encodeURIComponent(JSON.stringify(mr));
 return `<div class="card ${cls}" data-mr="${payload}">
   <div class="title-row"><span class="status">${icon}</span><b>!${esc(mr.iid)} &nbsp; ${esc(mr.title)}</b></div>
   <div class="meta"><span>◉&nbsp; ${esc(mr.author||'unknown')}</span><span>▣&nbsp; ${esc(mr.repoName||mr.repo||'')}</span>${age?`<span>▦&nbsp; ${age} old</span>`:''}</div>
   <div class="activity"><span>${changed?'↻':'✓'}&nbsp; ${esc(activity)}</span>${pipeline}</div>
  </div>`;
}
function page(body){return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:4px 8px 18px;margin:0}
details>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:7px;min-height:28px;user-select:none}summary::-webkit-details-marker{display:none}.chev:before{content:'›';display:inline-block;transform:rotate(90deg);color:var(--vscode-icon-foreground)}details:not([open])>.project>summary .chev:before,details:not([open])>summary .chev:before{transform:none}
.section{margin-bottom:10px}.section>summary{font-size:1.02em}.section-body{padding-left:12px;border-left:1px solid var(--vscode-tree-indentGuidesStroke)}
.project{margin:4px 0 12px}.project>summary{padding:2px 2px}.repo,.eye{color:var(--vscode-icon-foreground)}.badge{font-size:.88em;color:var(--vscode-descriptionForeground);background:var(--vscode-badge-background);padding:1px 6px;border-radius:9px;margin-left:3px}.badge.changed{color:var(--vscode-list-warningForeground)}
.cards{display:flex;flex-direction:column;gap:4px;margin:3px 0 0 18px}.card{border:1px solid var(--vscode-panel-border);border-left:3px solid var(--vscode-focusBorder);border-radius:4px;padding:7px 9px;cursor:pointer;background:var(--vscode-editor-background)}.card:hover{background:var(--vscode-list-hoverBackground)}.card.warn{border-left-color:var(--vscode-list-warningForeground)}.card.bad{border-left-color:var(--vscode-list-errorForeground)}
.title-row{display:flex;gap:8px;align-items:flex-start;line-height:1.35}.title-row b{font-weight:600}.status{width:16px;text-align:center;color:var(--vscode-textLink-foreground);font-size:1.05em}.warn .status{color:var(--vscode-list-warningForeground)}.bad .status{color:var(--vscode-list-errorForeground)}
.meta{display:flex;flex-wrap:wrap;gap:7px 13px;margin:5px 0 0 24px;color:var(--vscode-descriptionForeground)}.activity{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 14px;margin:5px 0 0 24px}.warn .activity>span:first-child{color:var(--vscode-list-warningForeground);font-weight:600}.pipeline{color:var(--vscode-descriptionForeground)}.pipeline.good{color:var(--vscode-testing-iconPassed)}.pipeline.badtext{color:var(--vscode-list-errorForeground);font-weight:600}
.empty{padding:18px;color:var(--vscode-descriptionForeground);text-align:center}
</style></head><body>${body}<script>
const vscode=acquireVsCodeApi();
document.querySelectorAll('.card').forEach(c=>c.addEventListener('click',()=>{try{vscode.postMessage({type:'open',mr:JSON.parse(decodeURIComponent(c.dataset.mr))})}catch{}}));
</script></body></html>`}
function loading(){return page('<div class="empty">Loading merge requests…</div>')}
function key(m){return `${m.repo||''}!${m.iid}`}
function ageText(v){const ms=Date.parse(v||'');if(!Number.isFinite(ms))return '';const d=Date.now()-ms;if(d<0)return '';const h=Math.floor(d/3600000);if(h<1)return `${Math.max(1,Math.floor(d/60000))}m`;if(h<24)return `${h}h`;return `${Math.floor(h/24)}d`}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
module.exports={MrWebviewProvider};
