const vscode=require('vscode');
const path=require('path');

class ReviewWebviewProvider{
 constructor(reviewState,isReviewed){this.reviewState=reviewState;this.isReviewed=isReviewed;this.view=null;this.filter='unresolved';this.showGeneral=true;}
 resolveWebviewView(view){
  this.view=view;view.webview.options={enableScripts:true};
  view.webview.onDidReceiveMessage(m=>{
   if(m.type==='openFile')vscode.commands.executeCommand('gitlabWorkbench.openReviewFile',Number(m.index));
   if(m.type==='openDiscussion'&&m.discussion)vscode.commands.executeCommand('gitlabWorkbench.openDiscussion',m.discussion);
   if(m.type==='openPending'&&m.note)vscode.commands.executeCommand('gitlabWorkbench.openPendingReviewComment',m.note);
   if(m.type==='resolve'&&m.discussion)vscode.commands.executeCommand('gitlabWorkbench.resolveDiscussion',m.discussion);
   if(m.type==='reply'&&m.discussion)vscode.commands.executeCommand('gitlabWorkbench.replyDiscussion',m.discussion);
   if(m.type==='toggleReviewed')vscode.commands.executeCommand('gitlabWorkbench.toggleReviewed',Number(m.index));
   if(m.type==='filter'){this.filter=m.value||'unresolved';this.refresh();}
   if(m.type==='toggleGeneral'){this.showGeneral=!this.showGeneral;this.refresh();}
  });
  this.refresh();
 }
 refresh(){if(this.view)this.view.webview.html=render(this.reviewState,this.isReviewed,this.filter,this.showGeneral);}
}
function render(review,isReviewed,filter='unresolved',showGeneral=true){
 const mr=review.mr;if(!mr)return page('<div class="empty">No active review.</div>');
 const all=review.discussions||[],pending=review.pending||[],files=mr.files||[];
 const done=files.filter(f=>isReviewed(mr,f[0])).length,unresolved=all.filter(d=>!d.resolved).length,resolved=all.filter(d=>d.resolved).length;
 let visible=filter==='all'?all:filter==='resolved'?all.filter(d=>d.resolved):all.filter(d=>!d.resolved);
 if(review.hideResolved)visible=visible.filter(d=>!d.resolved);
 let body=`<div class="summary"><div class="summary-title"><b>Review !${esc(mr.iid)}</b><span class="repo-name">${esc(mr.repoName||mr.repo||'')}</span></div><div class="stats"><span><b>${done}/${files.length}</b> files reviewed</span><span><b>${unresolved}</b> unresolved</span>${pending.length?`<span><b>${pending.length}</b> pending</span>`:''}</div></div>
 <div class="filters"><span class="filter-label">Show</span><button class="chip ${filter==='unresolved'?'selected':''}" data-filter="unresolved">Unresolved ${unresolved}</button><button class="chip ${filter==='resolved'?'selected':''}" data-filter="resolved">Resolved ${resolved}</button><button class="chip ${filter==='all'?'selected':''}" data-filter="all">All ${all.length}</button><button class="chip ${showGeneral?'selected':''}" data-general="1">General</button></div>`;
 if(pending.length)body+=section('Pending Review',`${pending.length} unpublished`,pending.map(n=>pendingCard(n)).join(''),'pending-section');
 const general=showGeneral?visible.filter(d=>!d.path):[];
 if(general.length)body+=section('Merge Request Discussion',`${general.filter(d=>!d.resolved).length} unresolved · ${general.filter(d=>d.resolved).length} resolved`,general.map(d=>discussionCard(d)).join(''));
 const groups=new Map();
 files.forEach((f,index)=>{const parts=f[0].split('/'),dir=parts.length>1?parts.slice(0,-1).join('/'):'(root)';if(!groups.has(dir))groups.set(dir,[]);groups.get(dir).push({f,index});});
 for(const [dir,items] of groups){
  const rd=items.filter(x=>isReviewed(mr,x.f[0])).length;
  body+=`<details open class="section"><summary><span class="chev"></span><span class="folder">▱</span><b>${esc(dir)}</b><span class="count">${rd}/${items.length}</span></summary><div class="section-body">${items.map(({f,index})=>fileCard(review,mr,f,index,isReviewed,visible)).join('')}</div></details>`;
 }
 return page(body);
}
function section(title,count,content,cls=''){return `<details open class="section ${cls}"><summary><span class="chev"></span><span class="section-icon">☵</span><b>${esc(title)}</b><span class="count">${esc(count)}</span></summary><div class="section-body">${content}</div></details>`;}
function fileCard(review,mr,f,index,isReviewed,discussions){
 const reviewed=isReviewed(mr,f[0]),active=review.index===index,ds=discussions.filter(d=>d.path===f[0]),unresolved=ds.filter(d=>!d.resolved).length;
 const payload=enc(index);
 return `<div class="file-card ${active?'active':''} ${reviewed?'reviewed':''}">
  <div class="file-head" data-open-file="${payload}"><span class="file-state">${reviewed?'✓':'○'}</span><b>${esc(path.basename(f[0]))}</b>${active?'<span class="badge current">Current</span>':''}</div>
  <div class="meta file-meta"><span>+${esc(f[1])} −${esc(f[2])}</span>${unresolved?`<span>💬 ${unresolved} unresolved</span>`:''}<button class="link" data-toggle-reviewed="${payload}">${reviewed?'Mark unreviewed':'Mark reviewed'}</button></div>
  ${ds.length?`<div class="threads">${ds.map(d=>discussionCard(d)).join('')}</div>`:''}
 </div>`;
}
function discussionCard(d){
 const first=d.notes?.[0]||{}, payload=enc(d), state=d.resolved?'Resolved':d.resolvable?'Unresolved':'General';
 return `<div class="thread ${d.resolved?'resolved':''}" data-open-discussion="${payload}">
   <div class="thread-top"><span class="thread-icon">${d.resolved?'✓':'▣'}</span><span class="thread-text">${esc(oneLine(first.body))}</span><span class="badge state ${d.resolved?'done':''}">${state}</span></div>
   <div class="meta">${esc(first.author||'Reviewer')}${d.line?`<span class="line">Line ${esc(d.line)}</span>`:''}${d.notes?.length>1?`<span>${d.notes.length} comments</span>`:''}</div>
   ${d.resolvable&&!d.resolved?`<div class="actions"><button data-reply="${payload}">Reply</button><button data-resolve="${payload}">Resolve</button></div>`:''}
  </div>`;
}
function pendingCard(n){const p=enc(n);return `<div class="thread pending-card" data-open-pending="${p}"><div class="thread-top"><span class="thread-icon">✎</span><span class="thread-text">${esc(oneLine(n.body))}</span><span class="badge pending">Pending</span></div><div class="meta">You${n.path?`<span>${esc(n.path)}${n.newLine||n.oldLine?`:${esc(n.newLine||n.oldLine)}`:''}</span>`:''}</div></div>`;}
function page(body){return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:5px 8px 20px;margin:0}
.summary{padding:8px 8px 9px;border-bottom:1px solid var(--vscode-panel-border);margin-bottom:6px}.summary-title{display:flex;align-items:baseline;gap:9px}.repo-name{color:var(--vscode-descriptionForeground);font-size:.91em}.stats{display:flex;gap:14px;margin-top:7px;color:var(--vscode-descriptionForeground);font-size:.9em}.stats b{color:var(--vscode-foreground)}.filters{display:flex;align-items:center;gap:5px;flex-wrap:wrap;padding:4px 7px 9px}.filter-label{color:var(--vscode-descriptionForeground);font-size:.86em;margin-right:2px}.chip{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-descriptionForeground);border:1px solid transparent;border-radius:10px;padding:2px 7px;font-size:.82em}.chip.selected{color:var(--vscode-badge-foreground);background:var(--vscode-badge-background);border-color:var(--vscode-focusBorder)}
details>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:7px;min-height:30px;user-select:none}summary::-webkit-details-marker{display:none}.chev:before{content:'›';display:inline-block;transform:rotate(90deg);color:var(--vscode-icon-foreground)}details:not([open])>summary .chev:before{transform:none}
.section{margin:5px 0 12px}.section-body{padding:2px 0 1px 12px;border-left:1px solid var(--vscode-tree-indentGuidesStroke)}.count,.muted{color:var(--vscode-descriptionForeground);font-size:.9em}.folder,.section-icon{color:var(--vscode-icon-foreground)}
.file-card{border:1px solid var(--vscode-panel-border);border-left:2px solid var(--vscode-panel-border);border-radius:4px;margin:6px 2px 9px;padding:7px 8px;background:var(--vscode-editor-background)}.file-card.active{border-left-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground)}.file-head{display:flex;align-items:center;gap:7px;cursor:pointer}.file-state{color:var(--vscode-icon-foreground)}.file-meta{padding-left:20px;margin-top:4px}
.threads{margin:8px -2px 0 18px}.thread{border-left:2px solid var(--vscode-focusBorder);padding:6px 8px;margin:5px 0;background:var(--vscode-sideBar-background);cursor:pointer}.thread.resolved{border-left-color:var(--vscode-panel-border);opacity:.56;padding-top:4px;padding-bottom:4px}.thread.resolved .meta{margin-top:2px}.pending-card{border-left-color:var(--vscode-charts-yellow)}
.thread-top{display:flex;align-items:center;gap:7px;min-width:0}.thread-text{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.thread-icon{color:var(--vscode-icon-foreground)}.meta{display:flex;gap:9px;align-items:center;color:var(--vscode-descriptionForeground);font-size:.88em;margin-top:4px}.line{color:var(--vscode-textLink-foreground)}
.badge{display:inline-block;padding:1px 6px;border-radius:9px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:.82em;white-space:nowrap}.badge.done{background:var(--vscode-toolbar-hoverBackground);color:var(--vscode-descriptionForeground)}.badge.pending{background:var(--vscode-editorWarning-background);color:var(--vscode-editorWarning-foreground)}.badge.current{margin-left:auto}
.actions{display:flex;gap:5px;margin-top:6px}button{font:inherit;color:var(--vscode-button-foreground);background:var(--vscode-button-background);border:0;border-radius:2px;padding:2px 7px;cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.link{background:transparent;color:var(--vscode-textLink-foreground);padding:0;margin-left:auto}.empty{padding:14px;color:var(--vscode-descriptionForeground)}
</style></head><body>${body}<script>
const vscode=acquireVsCodeApi();const dec=s=>JSON.parse(decodeURIComponent(s));
document.addEventListener('click',e=>{const el=e.target.closest('[data-open-file],[data-open-discussion],[data-open-pending],[data-toggle-reviewed],[data-resolve],[data-reply],[data-filter],[data-general]');if(!el)return;e.stopPropagation();if(el.dataset.filter)return vscode.postMessage({type:'filter',value:el.dataset.filter});if(el.dataset.general)return vscode.postMessage({type:'toggleGeneral'});
 if(el.dataset.toggleReviewed!==undefined)return vscode.postMessage({type:'toggleReviewed',index:dec(el.dataset.toggleReviewed)});
 if(el.dataset.resolve)return vscode.postMessage({type:'resolve',discussion:dec(el.dataset.resolve)});
 if(el.dataset.reply)return vscode.postMessage({type:'reply',discussion:dec(el.dataset.reply)});
 if(el.dataset.openFile!==undefined)return vscode.postMessage({type:'openFile',index:dec(el.dataset.openFile)});
 if(el.dataset.openDiscussion)return vscode.postMessage({type:'openDiscussion',discussion:dec(el.dataset.openDiscussion)});
 if(el.dataset.openPending)return vscode.postMessage({type:'openPending',note:dec(el.dataset.openPending)});
});</script></body></html>`;}
function oneLine(s){s=String(s||'').replace(/\s+/g,' ').trim();return s.length>70?s.slice(0,67)+'…':s;}
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function enc(v){return encodeURIComponent(JSON.stringify(v));}
module.exports={ReviewWebviewProvider};
