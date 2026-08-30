const vscode=require('vscode');
const path=require('path');
const {DemoClient}=require('./services/demoClient');
const {GlabClient}=require('./services/glabClient');
const {MrTreeProvider}=require('./providers/mrTree');
const {MrWebviewProvider}=require('./providers/mrWebview');
const {IssueTreeProvider}=require('./providers/issueTree');
const {ReviewTreeProvider}=require('./providers/reviewTree');
let demoClient,liveClient,tree,mrWebview,issueTree,reviewTree,commentController,extensionContext; let review={mr:null,index:0,discussions:[],viewColumn:undefined,worktree:undefined,compositeRoot:undefined,pending:[]}; let reviewComments=[];
function activate(context){
 extensionContext=context;
 demoClient=new DemoClient(); liveClient=new GlabClient(vscode,context); commentController=vscode.comments.createCommentController('gitlabWorkbench.reviewComments','GitLab Review Comments'); context.subscriptions.push(commentController); const client=()=>vscode.workspace.getConfiguration('gitlabWorkbench').get('demoMode',true)?demoClient:liveClient;
 tree=new MrTreeProvider(client); mrWebview=new MrWebviewProvider(client); context.subscriptions.push(vscode.window.registerWebviewViewProvider('gitlabWorkbench.mergeRequests',mrWebview,{webviewOptions:{retainContextWhenHidden:true}}));
 issueTree=new IssueTreeProvider(client); context.subscriptions.push(vscode.window.registerTreeDataProvider('gitlabWorkbench.issues',issueTree));
 reviewTree=new ReviewTreeProvider(review,(mr,path)=>isReviewed(mr,path)); context.subscriptions.push(vscode.window.registerTreeDataProvider('gitlabWorkbench.reviewExplorer',reviewTree));
 const cmd=(name,fn)=>context.subscriptions.push(vscode.commands.registerCommand(name,fn));
 cmd('gitlabWorkbench.refresh',()=>{tree.refresh();mrWebview?.refresh();issueTree.refresh();});
 cmd('gitlabWorkbench.showOutput',()=>liveClient.output.show(true));
 cmd('gitlabWorkbench.addProject',async()=>{
  const value=await vscode.window.showInputBox({title:'Add GitLab Project',prompt:'Paste a GitLab project URL',placeHolder:'https://gitlab.com/group/project',ignoreFocusOut:true});if(!value)return;
  let u;try{u=new URL(value.trim());}catch{vscode.window.showErrorMessage('Enter a valid GitLab project URL, for example https://gitlab.com/group/project');return;}
  const project=u.pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/,'');if(!u.hostname||!project){vscode.window.showErrorMessage('The URL must include a GitLab host and project path.');return;}
  const canonical=`${u.protocol}//${u.host}/${project}`;const c=vscode.workspace.getConfiguration('gitlabWorkbench');const current=c.get('managedProjects',[])||[];
  if(current.some(x=>String(x).replace(/\.git$/,'').replace(/\/$/,'')===canonical)){vscode.window.showInformationMessage('That GitLab project is already managed.');return;}
  await c.update('managedProjects',[...current,canonical],vscode.ConfigurationTarget.Global);tree.refresh();issueTree.refresh();vscode.window.showInformationMessage(`Added GitLab project: ${project}`);
 });
 cmd('gitlabWorkbench.removeProject',async()=>{
  const c=vscode.workspace.getConfiguration('gitlabWorkbench');const current=c.get('managedProjects',[])||[];if(!current.length){vscode.window.showInformationMessage('No managed GitLab projects.');return;}
  const pick=await vscode.window.showQuickPick(current.map(url=>({label:url.replace(/^https?:\/\//,''),description:url,url})),{placeHolder:'Remove managed GitLab project'});if(!pick)return;
  await c.update('managedProjects',current.filter(x=>x!==pick.url),vscode.ConfigurationTarget.Global);tree.refresh();issueTree.refresh();vscode.window.showInformationMessage(`Removed ${pick.label}`);
 });
 cmd('gitlabWorkbench.manageProjects',async()=>{
  const c=vscode.workspace.getConfiguration('gitlabWorkbench');const current=c.get('managedProjects',[])||[];
  const choice=await vscode.window.showQuickPick([{label:'$(add) Add Project',action:'add'},{label:'$(trash) Remove Project',action:'remove'},...current.map(url=>({label:`$(repo) ${url.replace(/^https?:\/\//,'')}`,description:'Managed GitLab project'}))],{placeHolder:`${current.length} managed GitLab project${current.length===1?'':'s'}`});
  if(choice?.action==='add')vscode.commands.executeCommand('gitlabWorkbench.addProject');else if(choice?.action==='remove')vscode.commands.executeCommand('gitlabWorkbench.removeProject');
 });
 cmd('gitlabWorkbench.cloneManagedProjects',async()=>{
  const cfg=vscode.workspace.getConfiguration('gitlabWorkbench');const current=cfg.get('managedProjects',[])||[];
  if(!current.length){vscode.window.showInformationMessage('No managed GitLab projects.');return;}
  const picks=await vscode.window.showQuickPick(current.map(url=>{const clean=String(url).replace(/\.git$/,'').replace(/\/$/,'');const name=clean.split('/').pop();return {label:`$(repo) ${name}`,description:clean.replace(/^https?:\/\//,''),url,name,picked:false};}),{title:'Clone Managed Projects',placeHolder:'Select one or more managed projects to clone',canPickMany:true,ignoreFocusOut:true});
  if(!picks||!picks.length)return;
  const destPick=await vscode.window.showOpenDialog({title:`Clone ${picks.length} managed project${picks.length===1?'':'s'} into…`,canSelectFolders:true,canSelectFiles:false,canSelectMany:false,openLabel:'Clone Here'});
  if(!destPick?.length)return;const root=destPick[0].fsPath;const c=client();let ok=0,skipped=0,failed=[];
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:'Cloning managed GitLab projects',cancellable:false},async progress=>{
   for(let n=0;n<picks.length;n++){const p=picks[n],target=require('path').join(root,p.name);progress.report({message:`${n+1}/${picks.length} ${p.name}`,increment:100/picks.length});
    if(require('fs').existsSync(target)){skipped++;continue;}
    try{await c.run(['repo','clone',p.url,target]);ok++;}catch(e){failed.push(`${p.name}: ${String(e.stderr||e.message||e).trim().split(/\r?\n/).slice(-1)[0]}`);}
   }
  });
  if(failed.length){c.output.show(true);failed.forEach(x=>c.log(`[managed-clone] ${x}`));vscode.window.showWarningMessage(`Cloned ${ok}; skipped ${skipped}; ${failed.length} failed. See GitLab Workbench output.`);}
  else vscode.window.showInformationMessage(`Cloned ${ok} managed project${ok===1?'':'s'}${skipped?`; skipped ${skipped} existing folder${skipped===1?'':'s'}`:''} into ${root}.`);
 });
 cmd('gitlabWorkbench.toggleDemo',async()=>{const c=vscode.workspace.getConfiguration('gitlabWorkbench');const next=!c.get('demoMode',true);await c.update('demoMode',next,vscode.ConfigurationTarget.Global);tree.refresh();issueTree.refresh();vscode.window.showInformationMessage(`GitLab Workbench: ${next?'Demo':'Live'} mode`);});
 cmd('gitlabWorkbench.openDashboard',async()=>openDashboard(client));
 cmd('gitlabWorkbench.openMr',mr=>openMr(client,mr));
 cmd('gitlabWorkbench.openIssue',issue=>openIssue(client,issue));
 cmd('gitlabWorkbench.newIssue',()=>newIssue(client));
 cmd('gitlabWorkbench.issueFilter',()=>chooseIssueFilter(client));
 cmd('gitlabWorkbench.issueSearch',()=>searchIssues());
 cmd('gitlabWorkbench.issueViewMode',()=>chooseIssueViewMode());
 cmd('gitlabWorkbench.manageTrackedAssignees',()=>manageTrackedAssignees());
 cmd('gitlabWorkbench.toggleUnassigned',()=>toggleUnassigned());
 cmd('gitlabWorkbench.checkoutMr',mr=>action(client,mr,'checkout'));
 cmd('gitlabWorkbench.approveMr',mr=>action(client,mr,'approve'));
 cmd('gitlabWorkbench.mergeMr',mr=>action(client,mr,'merge'));
 cmd('gitlabWorkbench.openDiff',async(mr,file)=>openDemoDiff(mr,file));
 cmd('gitlabWorkbench.demoScenario',chooseScenario);
 cmd('gitlabWorkbench.reviewMr',mr=>startReview(client,mr));
 cmd('gitlabWorkbench.nextChange',()=>moveReview(1));
 cmd('gitlabWorkbench.previousChange',()=>moveReview(-1));
 cmd('gitlabWorkbench.markReviewed',markReviewed);
 cmd('gitlabWorkbench.addReviewComment',()=>addReviewComment(client));
 cmd('gitlabWorkbench.submitReview',()=>submitReview(client));
 cmd('gitlabWorkbench.discardReview',()=>discardPendingReview(client));
 cmd('gitlabWorkbench.nextUnresolved',()=>nextUnresolved());
 cmd('gitlabWorkbench.openDiscussion',d=>openDiscussion(d));
 cmd('gitlabWorkbench.openPendingReviewComment',n=>openPendingReviewComment(n));
 cmd('gitlabWorkbench.replyDiscussion',d=>replyDiscussion(client,d));
 cmd('gitlabWorkbench.resolveDiscussion',d=>resolveDiscussion(client,d));
 cmd('gitlabWorkbench.openReviewFile',async index=>{if(!review.mr)return;review.index=Number(index);reviewTree.refresh();await showReviewFile();});
 cmd('gitlabWorkbench.toggleReviewed',async index=>{if(!review.mr)return;const f=review.mr.files[Number(index)];if(!f)return;await setReviewed(review.mr,f[0],!isReviewed(review.mr,f[0]));reviewTree.refresh();tree.refresh();});
 cmd('gitlabWorkbench.prepareJavaReview',()=>prepareJavaReview());
 cmd('gitlabWorkbench.switchJavaReviewRoot',()=>switchJavaReviewRoot());
 cmd('gitlabWorkbench.finishReview',async()=>{if(!review.mr)return;await vscode.commands.executeCommand('setContext','gitlabWorkbench.reviewActive',false);clearRenderedComments();review.mr=null;review.index=0;review.discussions=[];review.pending=[];review.worktree=undefined;review.compositeRoot=undefined;reviewTree.refresh();vscode.window.showInformationMessage('Review session finished. Fast Composite JDT root is left unchanged; switch back when you are ready.');});
 context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e=>{if(e.affectsConfiguration('gitlabWorkbench')){tree.refresh();mrWebview?.refresh();issueTree.refresh();}}));
}
async function action(client,mr,method){try{const r=await client()[method](mr);vscode.window.showInformationMessage(r.message);tree.refresh();mrWebview?.refresh();}catch(e){vscode.window.showErrorMessage(String(e.stderr||e.message||e));}}
async function openDashboard(client){const p=vscode.window.createWebviewPanel('gitlabWorkbenchDashboard','GitLab Workbench',currentEditorColumn(),{enableScripts:true}); let mrs=[];try{mrs=await client().listMergeRequests();}catch(e){p.webview.html=page('GitLab Workbench',`<div class="error">${esc(e.message)}</div>`);return;}const failed=mrs.filter(x=>x.pipeline==='failed').length;const running=mrs.filter(x=>x.pipeline==='running').length;p.webview.html=page('GitLab Workbench',`<div class="hero"><div><h1>GitLab Workbench</h1><p>${isDemo()?'DEMO DATA — safe to explore':'LIVE — powered by glab'}</p></div><button data-cmd="refresh">Refresh</button></div><div class="stats"><b>${mrs.length}</b> open MRs <b>${failed}</b> failed pipelines <b>${running}</b> running</div>${mrs.map(card).join('')}`);p.webview.onDidReceiveMessage(async m=>{if(m.command==='open'){const mr=mrs.find(x=>x.repo===m.repo&&x.iid===m.iid);openMr(client,mr);}if(m.command==='refresh'){p.dispose();openDashboard(client);}});}
async function openIssue(client,issue){
 let current=issue;let editing=false;try{current=await client().getIssue(issue.repo,issue.iid)||issue;}catch{}
 const p=vscode.window.createWebviewPanel('gitlabWorkbenchIssue',`#${issue.iid} ${issue.title}`,currentEditorColumn(),{enableScripts:true,retainContextWhenHidden:true});
 async function render(){try{current=await client().getIssue(current.repo,current.iid)||current;}catch{}let notes=[];try{notes=await client().listIssueNotes(current);}catch{}
  const state=String(current.state||'opened').toLowerCase(),assigned=current.assignees||[],labels=current.labels||[],workflow=issueWorkflow(current),repo=esc(current.repoName||current.repo),author=esc(current.author||'unknown');
  const comments=notes.map(n=>`<div class="event"><div class="avatar">${initials(n.author)}</div><div class="eventbody"><div class="meta"><b>${esc(n.author)}</b><span>${esc(relativeTime(n.created))}</span></div><div class="bubble">${formatBody(n.body)}</div></div></div>`).join('')||'<div class="empty">No comments yet.</div>';
  const mainContent=editing?`<div class="issue-editor"><div class="editor-head"><b>Edit issue #${current.iid}</b><span class="muted">Ctrl+Enter to save · Esc to cancel</span></div><label>Title</label><input id="edit-title" class="edit-input" value="${esc(current.title)}"><div class="editor-tabs"><button class="link active-tab" data-edit-tab="write">Write</button><button class="link" data-edit-tab="preview">Preview</button></div><textarea id="edit-description" class="edit-description" placeholder="Add a description using GitLab Markdown…">${esc(current.description||'')}</textarea><div id="edit-preview" class="edit-preview" hidden></div><div class="editor-grid"><div><label>Assignees</label><input id="edit-assignees" class="edit-input" value="${esc(assigned.join(', '))}" placeholder="username, username"><small>Comma-separated GitLab usernames</small></div><div><label>Labels</label><input id="edit-labels" class="edit-input" value="${esc(labels.join(', '))}" placeholder="bug, backend"><small>Comma-separated labels</small></div></div><div class="editor-actions"><button data-issue-action="cancel-edit">Cancel</button><button class="primary" data-issue-action="save-edit">Save changes</button></div></div>`:`<div class="event"><div class="avatar">${initials(current.author)}</div><div class="eventbody"><div class="meta"><b>${author}</b><span>opened this issue</span></div><div class="bubble desc">${formatBody(current.description||'No description provided.')}</div></div></div>${comments}<div class="composer"><b>Add a comment</b><textarea id="issue-comment" placeholder="Leave a comment…"></textarea><div class="composerfoot"><span>GitLab Markdown supported · Ctrl+Enter to submit</span><button class="primary" data-issue-action="submit-comment">Comment</button></div></div>`;
  p.webview.html=issuePage(`<header><div class="topbar"><div class="eyebrow">${repo} · Issue #${current.iid}</div><div><button data-issue-action="refresh">↻ Refresh</button>${current.webUrl?`<button data-issue-url="${esc(current.webUrl)}">Open in GitLab ↗</button>`:''}</div></div><div class="title"><h1>${esc(current.title)}</h1><span class="state ${state}">${state==='closed'?'CLOSED':'OPEN'}</span></div><div class="sub"><b>${author}</b> opened this issue · ${notes.length} comment${notes.length===1?'':'s'}${current.updated?` · updated ${esc(relativeTime(current.updated))}`:''}</div></header><div class="layout"><main>${mainContent}</main><aside><section><div class="sidehead">Status</div><b>● ${esc(workflow)}</b></section><section><div class="sidehead">Assignees ${editing?'':'<button class="link" data-issue-action="assign">Edit</button>'}</div>${assigned.length?assigned.map(x=>`<span class="chip">@${esc(x)}</span>`).join(''):'<span class="muted">Unassigned</span>'}</section><section><div class="sidehead">Labels</div>${labels.length?labels.map(x=>`<span class="chip">${esc(x)}</span>`).join(''):'<span class="muted">No labels</span>'}</section><section><div class="sidehead">Project</div>${repo}</section><section class="actions">${editing?'':`<button data-issue-action="edit">Edit issue</button><button data-issue-action="state">${state==='closed'?'Reopen issue':'Close issue'}</button>`}</section></aside></div>`);}
 p.webview.onDidReceiveMessage(async m=>{try{if(m.issueUrl){await vscode.env.openExternal(vscode.Uri.parse(m.issueUrl));return;}if(m.issueAction==='refresh'){await render();issueTree.refresh();return;}if(m.issueAction==='submit-comment'){const body=String(m.body||'').trim();if(body){await client().addIssueNote(current,body);await render();issueTree.refresh();}}else if(m.issueAction==='edit'){editing=true;await render();}else if(m.issueAction==='cancel-edit'){editing=false;await render();}else if(m.issueAction==='save-edit'){const title=String(m.title||'').trim();if(!title){vscode.window.showWarningMessage('Issue title cannot be empty.');return;}const assignees=String(m.assignees||'').split(',').map(x=>x.trim().replace(/^@/,'')).filter(Boolean);const labels=String(m.labels||'').split(',').map(x=>x.trim()).filter(Boolean);current=await client().updateIssue(current,{title,description:String(m.description||''),assignees,labels})||current;editing=false;issueTree.refresh();await render();}else if(m.issueAction==='assign'){const value=await vscode.window.showInputBox({title:`Assignees for #${current.iid}`,prompt:'Comma-separated GitLab usernames. Leave empty to unassign.',value:(current.assignees||[]).join(', '),ignoreFocusOut:true});if(value===undefined)return;current=await client().updateIssue(current,{assignees:value.split(',').map(x=>x.trim().replace(/^@/,'')).filter(Boolean)})||current;issueTree.refresh();await render();}else if(m.issueAction==='state'){current=await client().updateIssue(current,{state_event:current.state==='closed'?'reopen':'close'})||current;issueTree.refresh();await render();}}catch(e){vscode.window.showErrorMessage(`Issue action failed: ${String(e.stderr||e.message||e)}`);}});await render();
}

async function newIssue(client){
 let projects=[];try{projects=await client().projectList();}catch(e){vscode.window.showErrorMessage(`Could not load projects: ${e.message||e}`);return;}if(!projects.length){vscode.window.showWarningMessage('Add a managed GitLab project first.');return;}
 const pick=await vscode.window.showQuickPick(projects.map(r=>({label:r.name||r.project,description:r.project,id:r.id})),{placeHolder:'Create issue in which project?'});if(!pick)return;
 const title=await vscode.window.showInputBox({title:'New GitLab Issue',prompt:`${pick.description}`,placeHolder:'Issue title',ignoreFocusOut:true});if(!title)return;
 const description=await vscode.window.showInputBox({title:'Issue description',placeHolder:'Optional description',ignoreFocusOut:true});if(description===undefined)return;
 const assignee=await vscode.window.showInputBox({title:'Assign issue',prompt:'Optional GitLab username',placeHolder:'username',ignoreFocusOut:true});if(assignee===undefined)return;
 try{const created=await client().createIssue(pick.id,{title,description,assignee:assignee.trim().replace(/^@/,'')});issueTree.refresh();vscode.window.showInformationMessage(`Created #${created.iid} ${created.title}`);openIssue(client,created);}catch(e){vscode.window.showErrorMessage(`Could not create issue: ${String(e.stderr||e.message||e)}`);}
}

async function searchIssues(){
 const value=await vscode.window.showInputBox({title:'Search Issues',prompt:'Filter issues. Space-separated terms are ANDed.',value:issueTree.search||'',placeHolder:'pricing blocked sarah',ignoreFocusOut:true});
 if(value===undefined)return;issueTree.setSearch(value);
}
function currentEditorColumn(){return vscode.window.activeTextEditor?.viewColumn || vscode.window.tabGroups.activeTabGroup?.viewColumn || vscode.ViewColumn.Active;}

async function chooseIssueViewMode(){
 const pick=await vscode.window.showQuickPick([
  {label:'$(organization) People Board',description:'Person → status → tasks',mode:'board'},
  {label:'$(repo) Projects',description:'Project → issues',mode:'projects'}
 ],{placeHolder:`Issue view · currently ${issueTree.mode==='board'?'People Board':'Projects'}`});
 if(!pick)return;issueTree.setMode(pick.mode);vscode.window.showInformationMessage(`Issues view: ${pick.mode==='board'?'People Board':'Projects'}`);
}
async function chooseIssueFilter(client){
 const tracked=vscode.workspace.getConfiguration('gitlabWorkbench').get('trackedAssignees',[])||[];let me=null;try{me=await client().currentUser();}catch{}
 const items=[{label:'$(list-flat) All Issues',filter:{type:'all',label:'All'}},{label:'$(person) Mine',description:me?`@${me}`:'Current GitLab user',filter:me?{type:'user',username:me,label:'Mine'}:{type:'all',label:'All'}},{label:'$(circle-slash) Unassigned',filter:{type:'unassigned',label:'Unassigned'}},...tracked.map(u=>({label:`$(person) @${u}`,description:'Tracked assignee',filter:{type:'user',username:u,label:`@${u}`}})),{label:'$(gear) Manage Tracked Assignees…',manage:true}];
 const pick=await vscode.window.showQuickPick(items,{placeHolder:`Issue filter · currently ${issueTree.filter.label}`});if(!pick)return;if(pick.manage){await manageTrackedAssignees();return chooseIssueFilter(client);}issueTree.setFilter(pick.filter);
}
async function manageTrackedAssignees(){
 const cfg=vscode.workspace.getConfiguration('gitlabWorkbench');
 const current=(cfg.get('trackedAssignees',[])||[]).map(String);
 let issues=[],mrs=[];try{const c=client();issues=(await c.listIssues()).filter(i=>!i.kind);mrs=(await c.listMergeRequests()).filter(m=>!m.kind&&!m.error);}catch{}
 const names=[];const add=n=>{n=String(n||'').trim().replace(/^@/,'');if(n&&!names.some(x=>x.toLowerCase()===n.toLowerCase()))names.push(n);};
 current.forEach(add);issues.forEach(i=>(i.assignees||[]).forEach(add));mrs.forEach(m=>add(m.author));
 const picked=new Map(current.map(x=>[x.toLowerCase(),x]));
 while(true){
  const picks=[
   {label:'$(person-add) Add GitLab user…',description:'Add a username that is not currently discovered',alwaysShow:true,addUser:true},
   ...names.sort((a,b)=>a.localeCompare(b)).map(name=>({label:`@${name}`,description:'GitLab user',username:name,picked:picked.has(name.toLowerCase())}))
  ];
  const selected=await vscode.window.showQuickPick(picks,{title:'People Board · Manage People',placeHolder:'Select people to show, or choose Add GitLab user…',canPickMany:true,ignoreFocusOut:true});
  if(selected===undefined)return;
  // Preserve selections made in this picker before handling Add User.
  const chosen=selected.filter(x=>x.username).map(x=>x.username);
  picked.clear();chosen.forEach(x=>picked.set(x.toLowerCase(),x));
  if(selected.some(x=>x.addUser)){
   const username=await vscode.window.showInputBox({title:'People Board · Add GitLab User',prompt:'GitLab username',placeHolder:'username',ignoreFocusOut:true,validateInput:v=>String(v||'').trim().replace(/^@/,'')?'': 'Enter a GitLab username'});
   if(username===undefined)continue;
   const clean=String(username).trim().replace(/^@/,'');add(clean);picked.set(clean.toLowerCase(),clean);continue;
  }
  await cfg.update('trackedAssignees',[...picked.values()],vscode.ConfigurationTarget.Global);
  await cfg.update('peopleBoard.peopleConfigured',true,vscode.ConfigurationTarget.Global);
  issueTree.refresh();
  vscode.window.showInformationMessage(`People Board: showing ${picked.size} tracked ${picked.size===1?'person':'people'}.`);
  return;
 }
}
async function toggleUnassigned(){
 const cfg=vscode.workspace.getConfiguration('gitlabWorkbench');const next=!cfg.get('peopleBoard.showUnassigned',true);
 await cfg.update('peopleBoard.showUnassigned',next,vscode.ConfigurationTarget.Global);issueTree.refresh();
 vscode.window.showInformationMessage(`People Board: unassigned work ${next?'shown':'hidden'}.`);
}
async function openMr(client,mr){
 let full=mr;let discussions=[];let activeTab='conversation';let readiness={approvals:{approved:0,required:0},pipeline:null,jobs:[]};
 const p=vscode.window.createWebviewPanel('gitlabWorkbenchMr',`!${mr.iid} ${mr.title}`,currentEditorColumn(),{enableScripts:true,retainContextWhenHidden:true});
 async function render(tab=activeTab){
  activeTab=tab;
  try{full=await client().getMergeRequest(mr.repo,mr.iid)||full;}catch{}
  try{discussions=await client().listDiscussions(full)||[];}catch{discussions=full.discussions||[];} try{readiness=await client().getMergeReadiness(full)||readiness;}catch{}
  const general=discussions.filter(d=>!d.path), positioned=discussions.filter(d=>d.path), unresolved=positioned.filter(d=>!d.resolved).length;
  const notes=general.reduce((n,d)=>n+(d.notes?.length||0),0);
  const conversation=general.length?general.map(d=>renderConversationThread(d)).join(''):'<div class="empty-state"><b>No conversation yet</b><span>General merge request comments will appear here.</span></div>';
  const files=(full.files||[]).map((f,i)=>{const threads=positioned.filter(d=>d.path===f[0]||d.newPath===f[3]?.new_path||d.oldPath===f[3]?.old_path);const open=threads.filter(d=>!d.resolved).length;return `<button class="file-row" data-file="${i}"><span class="file-icon">▧</span><span class="file-name"><code>${esc(f[0])}</code>${threads.length?`<small>${threads.length} thread${threads.length===1?'':'s'}${open?` · ${open} unresolved`:''}</small>`:''}</span><span class="diffstat"><b>+${f[1]}</b><i>−${f[2]}</i></span><span class="chevron">›</span></button>`}).join('')||'<div class="empty-state"><b>No changed files</b><span>GitLab did not return any file changes for this merge request.</span></div>';
  const desc=full.description?formatText(full.description):'<span class="muted"><i>No description provided.</i></span>';
  const pipeline=String(readiness.pipeline?.status||full.pipeline||'unknown').toLowerCase();const pipeClass=pipeline==='success'?'ok':pipeline==='failed'?'danger':'neutral';
  const ap=readiness.approvals||{approved:0,required:0};const approvalOk=!ap.required||ap.approved>=ap.required;const ready=!full.conflicts&&pipeline==='success'&&approvalOk&&unresolved===0;
  const jobs=(readiness.jobs||[]).map(j=>`<button class="job-row" data-url="${esc(j.web_url||'')}"><span>${j.status==='success'?'✓':j.status==='failed'?'✗':j.status==='running'?'◌':'○'} <b>${esc(j.name)}</b><small>${esc(j.stage||'')}</small></span><span class="${j.status==='failed'?'danger':j.status==='success'?'ok':'neutral'}">${esc(j.status||'unknown')}${j.duration?` · ${Math.round(j.duration)}s`:''}</span></button>`).join('')||'<div class="muted">No pipeline jobs available.</div>';
  p.webview.html=mrPage(`!${full.iid} ${full.title}`,`
  <header class="mr-header"><div class="top-actions"><div class="eyebrow">${esc(full.repoName||full.repo||'GitLab project')} · Merge request !${full.iid}</div><div><button class="ghost" data-mr-action="refresh">↻ Refresh</button><button class="ghost" data-url="${esc(full.webUrl||'')}">Open in GitLab ↗</button></div></div><div class="title-row"><h1>${esc(full.title)}</h1><span class="state-pill">OPEN</span></div><div class="merge-line"><b>${esc(full.author||'unknown')}</b> wants to merge <code>${esc(full.source||'—')}</code><span>→</span><code>${esc(full.target||'—')}</code></div></header>
  <nav class="tabs"><button class="tab ${activeTab==='conversation'?'active':''}" data-tab="conversation">Conversation <span>${notes}</span></button><button class="tab ${activeTab==='changes'?'active':''}" data-tab="changes">Files changed <span>${(full.files||[]).length}</span></button></nav>
  <div class="mr-layout"><main>
   <section class="tab-panel ${activeTab==='conversation'?'show':''}">
    <article class="description-card"><div class="card-head"><div class="avatar">${initials(full.author)}</div><div><b>${esc(full.author||'Author')}</b><small>opened this merge request</small></div></div><div class="description-body">${desc}</div></article>
    <div class="timeline">${conversation}</div>
    <section class="composer"><div class="composer-head"><b>Add a comment</b><span>General merge request discussion</span></div><textarea id="mr-comment" rows="5" placeholder="Leave a comment…"></textarea><div class="composer-footer"><span>Markdown supported</span><button class="primary" data-mr-action="comment">Comment</button></div></section>
   </section>
   <section class="tab-panel ${activeTab==='changes'?'show':''}">
    <div class="changes-head"><div><h2>Files changed</h2><span>${positioned.length} review thread${positioned.length===1?'':'s'} · ${unresolved} unresolved</span></div><button class="primary" data-action="review">Start review</button></div><div class="file-list">${files}</div>
   </section>
  </main><aside>
   <section class="merge-box"><div class="merge-status"><span class="status-dot ${ready?'ok':'danger'}"></span><div><b>${ready?'Ready to merge':'Merge blocked'}</b><small>${ready?'All known merge requirements are satisfied':'Resolve the blocking checks below'}</small></div></div><div class="checks"><div><span>${pipeline==='success'?'✓':'✗'} Pipeline</span><b class="${pipeClass}">${esc(pipeline)}</b></div><div><span>${approvalOk?'✓':'✗'} Approvals</span><b>${ap.approved}/${ap.required||0}</b></div><div><span>${unresolved===0?'✓':'✗'} Discussions</span><b>${unresolved} unresolved</b></div><div><span>${!full.conflicts?'✓':'✗'} Conflicts</span><b class="${full.conflicts?'danger':'ok'}">${full.conflicts?'conflicts':'none'}</b></div></div><button class="primary wide" data-action="review">Review changes</button></section><section class="meta"><h3>Pipeline ${readiness.pipeline?.id?'#'+readiness.pipeline.id:''}</h3><div class="jobs">${jobs}</div>${readiness.pipeline?.web_url?`<button class="secondary wide" data-url="${esc(readiness.pipeline.web_url)}">Open pipeline in GitLab ↗</button>`:''}</section>
   <section class="meta"><h3>Review</h3><div class="meta-row"><span>Author</span><b>${esc(full.author||'—')}</b></div><div class="meta-row"><span>Source</span><code>${esc(full.source||'—')}</code></div><div class="meta-row"><span>Target</span><code>${esc(full.target||'—')}</code></div></section>
   <section class="meta"><h3>Actions</h3><button class="secondary wide" data-action="checkout">Checkout locally</button><button class="secondary wide" data-action="approve">Approve</button><button class="secondary wide" data-action="merge">Merge</button></section>
  </aside></div>`);
 }
 p.webview.onDidReceiveMessage(async m=>{
  if(m.url){await vscode.env.openExternal(vscode.Uri.parse(m.url));return;}if(m.mrAction==='refresh'){await render(activeTab);tree.refresh();return;}if(m.tab){await render(m.tab);return;}if(m.action==='review'){await startReview(client,full);return;}if(m.action){await action(client,full,m.action);await render(activeTab);return;}if(Number.isInteger(m.file)){await openDemoDiff(full,full.files[m.file]);return;}
  if(m.mrAction==='comment'){const body=String(m.body||'').trim();if(!body)return;try{await client().addMergeRequestComment(full,body);await render('conversation');}catch(e){vscode.window.showErrorMessage(`Could not add merge request comment: ${String(e.stderr||e.message||e)}`);}return;}
  if(m.replyDiscussion){const d=discussions.find(x=>String(x.id)===String(m.replyDiscussion));if(!d)return;const body=await vscode.window.showInputBox({title:`Reply to ${d.notes?.[0]?.author||'discussion'}`,placeHolder:'Reply…',ignoreFocusOut:true});if(!body)return;try{await client().replyDiscussion(full,d.id,body);await render('conversation');}catch(e){vscode.window.showErrorMessage(`Could not reply: ${String(e.stderr||e.message||e)}`);}return;}
 });await render();
}
function initials(name){return esc(String(name||'?').split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]).join('').toUpperCase()||'?');}
function renderConversationThread(d){const notes=d.notes||[];if(!notes.length)return '';const first=notes[0];const replies=notes.slice(1).map(n=>`<div class="reply"><div class="avatar small">${initials(n.author)}</div><div class="reply-content"><div class="reply-head"><b>${esc(n.author||'Reviewer')}</b><small>${friendlyTime(n.created)}</small></div><div class="prose">${formatText(n.body)}</div></div></div>`).join('');return `<article class="thread"><div class="thread-main"><div class="avatar">${initials(first.author)}</div><div class="thread-content"><div class="thread-head"><b>${esc(first.author||'Reviewer')}</b><small>${friendlyTime(first.created)}</small></div><div class="prose">${formatText(first.body)}</div>${replies}<button class="reply-button" data-reply-discussion="${esc(d.id)}">Reply</button></div></div></article>`;}
function friendlyTime(value){if(!value)return '';const d=new Date(value);if(Number.isNaN(d.getTime()))return esc(value);const delta=Date.now()-d.getTime(),m=Math.floor(delta/60000);if(m<1)return 'just now';if(m<60)return `${m}m ago`;const h=Math.floor(m/60);if(h<24)return `${h}h ago`;const days=Math.floor(h/24);if(days<7)return `${days}d ago`;return d.toLocaleDateString();}
function formatText(value){return esc(value||'').replace(/\n/g,'<br>');}
function mrPage(title,body){return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font-family:var(--vscode-font-family);padding:0 32px 56px;max-width:1380px;margin:auto;color:var(--vscode-foreground);font-size:13px;line-height:1.45}button,textarea{font:inherit}button{cursor:pointer}.mr-header{padding:30px 0 18px}.eyebrow{font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:8px}.title-row{display:flex;align-items:center;gap:12px}.title-row h1{font-size:26px;line-height:1.2;margin:0;font-weight:650;letter-spacing:-.3px}.state-pill{border:1px solid var(--vscode-testing-iconPassed);color:var(--vscode-testing-iconPassed);border-radius:999px;padding:3px 9px;font-size:10px;font-weight:700}.merge-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-top:10px;color:var(--vscode-descriptionForeground)}code{background:var(--vscode-textCodeBlock-background);padding:2px 6px;border-radius:4px;color:var(--vscode-textPreformat-foreground)}.tabs{display:flex;gap:22px;border-bottom:1px solid var(--vscode-panel-border)}.tab{border:0;background:none;color:var(--vscode-descriptionForeground);padding:12px 1px 11px;border-bottom:2px solid transparent}.tab.active{color:var(--vscode-foreground);border-bottom-color:var(--vscode-focusBorder);font-weight:650}.tab span{margin-left:5px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);padding:1px 6px;border-radius:999px;font-size:11px}.mr-layout{display:grid;grid-template-columns:minmax(0,1fr) 285px;gap:30px;padding-top:24px}.tab-panel{display:none}.tab-panel.show{display:block}.description-card,.composer,.merge-box{border:1px solid var(--vscode-panel-border);border-radius:8px;background:var(--vscode-editor-background)}.card-head{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--vscode-panel-border)}.card-head>div:last-child{display:flex;gap:8px;align-items:baseline}.card-head small,.thread-head small,.reply-head small{color:var(--vscode-descriptionForeground)}.avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:10px;font-weight:700;flex:0 0 auto}.avatar.small{width:24px;height:24px;font-size:9px}.description-body{padding:18px;min-height:70px}.timeline{position:relative;margin:18px 0}.timeline:before{content:"";position:absolute;left:14px;top:-18px;bottom:-18px;width:1px;background:var(--vscode-panel-border)}.thread{position:relative;margin:0 0 16px}.thread-main{display:flex;gap:12px}.thread-content{min-width:0;flex:1;border:1px solid var(--vscode-panel-border);border-radius:8px;overflow:hidden;background:var(--vscode-editor-background)}.thread-head,.reply-head{display:flex;justify-content:space-between;gap:12px;align-items:center}.thread-head{padding:10px 13px;background:var(--vscode-editor-inactiveSelectionBackground);border-bottom:1px solid var(--vscode-panel-border)}.prose{padding:14px;line-height:1.6}.reply{display:flex;gap:10px;padding:12px 14px;border-top:1px solid var(--vscode-panel-border)}.reply-content{min-width:0;flex:1}.reply .prose{padding:7px 0 0}.reply-button{border:0;border-top:1px solid var(--vscode-panel-border);width:100%;text-align:left;background:none;color:var(--vscode-textLink-foreground);padding:8px 13px}.composer{margin-top:22px;overflow:hidden}.composer-head{display:flex;justify-content:space-between;padding:11px 13px;border-bottom:1px solid var(--vscode-panel-border)}.composer-head span,.composer-footer{color:var(--vscode-descriptionForeground)}textarea{display:block;width:calc(100% - 24px);margin:12px;resize:vertical;min-height:100px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;padding:11px}.composer-footer{display:flex;justify-content:space-between;align-items:center;padding:0 12px 12px}.primary,.secondary{border-radius:5px;padding:8px 12px}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:1px solid var(--vscode-button-border,transparent)}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-button-border,transparent)}.wide{width:100%}.merge-box{padding:14px}.merge-status{display:flex;gap:10px;align-items:flex-start}.merge-status>div{display:flex;flex-direction:column}.merge-status small{color:var(--vscode-descriptionForeground);margin-top:2px}.status-dot{width:10px;height:10px;border-radius:50%;margin-top:5px;background:var(--vscode-descriptionForeground)}.status-dot.ok{background:var(--vscode-testing-iconPassed)}.status-dot.danger{background:var(--vscode-testing-iconFailed)}.checks{margin:14px 0;border-top:1px solid var(--vscode-panel-border);border-bottom:1px solid var(--vscode-panel-border)}.checks>div,.meta-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0}.checks span,.meta-row span{color:var(--vscode-descriptionForeground)}.ok{color:var(--vscode-testing-iconPassed)}.danger{color:var(--vscode-testing-iconFailed)}.neutral{color:var(--vscode-descriptionForeground)}.meta{padding:16px 2px;border-bottom:1px solid var(--vscode-panel-border)}.meta h3{font-size:12px;color:var(--vscode-descriptionForeground);margin:0 0 7px}.meta .wide{margin-top:7px;text-align:left}.changes-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.changes-head h2{font-size:18px;margin:0}.changes-head span{color:var(--vscode-descriptionForeground)}.file-list{border:1px solid var(--vscode-panel-border);border-radius:8px;overflow:hidden}.file-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto 20px;align-items:center;width:100%;border:0;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);color:var(--vscode-foreground);padding:11px 12px;text-align:left}.file-row:last-child{border-bottom:0}.file-row:hover{background:var(--vscode-list-hoverBackground)}.file-icon,.chevron{color:var(--vscode-descriptionForeground)}.file-name{display:flex;flex-direction:column;gap:3px;min-width:0}.file-name code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:none;padding:0}.file-name small{color:var(--vscode-descriptionForeground)}.diffstat{display:flex;gap:8px}.diffstat b{color:var(--vscode-testing-iconPassed)}.diffstat i{font-style:normal;color:var(--vscode-testing-iconFailed)}.empty-state{display:flex;flex-direction:column;align-items:center;gap:4px;padding:28px;border:1px dashed var(--vscode-panel-border);border-radius:8px;color:var(--vscode-descriptionForeground)}.muted{color:var(--vscode-descriptionForeground)}.top-actions{display:flex;justify-content:space-between;align-items:center;gap:12px}.ghost{border:0;background:none;color:var(--vscode-textLink-foreground);padding:5px 8px}.job-row{width:100%;display:flex;justify-content:space-between;gap:8px;text-align:left;border:0;border-top:1px solid var(--vscode-panel-border);background:none;color:var(--vscode-foreground);padding:8px 0}.job-row span:first-child{display:flex;gap:6px;align-items:center}.job-row small{color:var(--vscode-descriptionForeground)}
@media(max-width:850px){body{padding-left:18px;padding-right:18px}.mr-layout{grid-template-columns:1fr}.mr-layout aside{order:-1}.timeline:before{display:none}}
</style></head><body>${body}<script>const vscode=acquireVsCodeApi();document.querySelectorAll('[data-url]').forEach(x=>x.addEventListener('click',()=>{if(x.dataset.url)vscode.postMessage({url:x.dataset.url})}));document.querySelectorAll('[data-tab]').forEach(x=>x.addEventListener('click',()=>vscode.postMessage({tab:x.dataset.tab})));document.querySelectorAll('[data-action]').forEach(x=>x.addEventListener('click',()=>vscode.postMessage({action:x.dataset.action})));document.querySelectorAll('[data-file]').forEach(x=>x.addEventListener('click',()=>vscode.postMessage({file:Number(x.dataset.file)})));document.querySelectorAll('[data-reply-discussion]').forEach(x=>x.addEventListener('click',()=>vscode.postMessage({replyDiscussion:x.dataset.replyDiscussion})));document.querySelector('[data-mr-action="comment"]')?.addEventListener('click',()=>{const t=document.querySelector('#mr-comment');const body=t?.value?.trim();if(body)vscode.postMessage({mrAction:'comment',body});});</script></body></html>`;}

async function chooseScenario(){
 const items=[['Feedback on My MR — 4 review threads','feedback'],['Normal Development','normal'],['Heavy Activity — 30 MRs','heavy'],['Review Backlog','review'],['Pipeline Disaster','pipelines'],['Merge Conflicts','conflicts'],['Large Program — 120 MRs / 30 repos','large']];
 const pick=await vscode.window.showQuickPick(items.map(([label,value])=>({label,value})),{placeHolder:'Choose deterministic GitLab demo data'}); if(!pick)return;
 demoClient.setScenario(pick.value); tree.refresh(); vscode.window.showInformationMessage(`Demo scenario: ${pick.label}`);
}
async function startReview(client,mr){
 liveClient?.log?.(`[review-flow] Start Review invoked repo=${mr?.repo||'<unknown>'} iid=${mr?.iid||'<unknown>'}`);
 let full=await client().getMergeRequest(mr.repo,mr.iid)||mr; if(!(full.files||[]).length){vscode.window.showWarningMessage('No changed files available for this merge request.');return;}
 review.viewColumn=vscode.window.activeTextEditor?.viewColumn || vscode.window.tabGroups.activeTabGroup?.viewColumn || vscode.ViewColumn.Active;
 if(!isDemo()){
  await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Preparing local review for !${full.iid}`,cancellable:false},async progress=>{
   progress.report({message:'Preparing workspace-local review clone…'});liveClient.log('[review-flow] stage=clone begin');const session=await liveClient.prepareReview(full);review.worktree=session.worktree;liveClient.log(`[review-flow] stage=clone complete worktree=${session.worktree}`);
   progress.report({message:'Loading review discussions…'});liveClient.log('[review-flow] stage=discussions begin');review.discussions=await loadDiscussions(client,full);review.pending=await loadDraftNotes(client,full);liveClient.log(`[review-flow] stage=discussions complete count=${review.discussions.length} pending=${review.pending.length}`);
  });
 }else {review.discussions=await loadDiscussions(client,full);review.pending=await loadDraftNotes(client,full);}
 review.mr=full; review.index=0; clearRenderedComments(); reviewTree.refresh(); await vscode.commands.executeCommand('setContext','gitlabWorkbench.reviewActive',true);
 // Composite/JDT preparation is optional. Standard reviews only use the local checkout.
 if(!isDemo() && vscode.workspace.getConfiguration('gitlabWorkbench').get('prepareCompositeRootOnStart',false)){
  liveClient.log('[review-flow] stage=java-root begin (enabled)');
  try{await prepareJavaReview({automatic:true});liveClient.log(`[review-flow] stage=java-root returned compositeRoot=${review.compositeRoot||'<none>'}`);}
  catch(e){vscode.window.showWarningMessage(`Local review is ready, but the Java review root could not be prepared: ${String(e.stderr||e.message||e)}`);}
 }else if(!isDemo()) liveClient.log('[review-flow] stage=java-root skipped (standard checkout mode)');
 liveClient?.log?.('[review-flow] stage=open-first-file begin');await showReviewFile();liveClient?.log?.('[review-flow] stage=open-first-file complete'); await vscode.commands.executeCommand('gitlabWorkbench.reviewExplorer.focus');liveClient?.log?.('[review-flow] Start Review complete');
}
async function moveReview(delta){if(!review.mr)return;review.index=(review.index+delta+review.mr.files.length)%review.mr.files.length;reviewTree.refresh();await showReviewFile();}
async function showReviewFile(){const f=review.mr.files[review.index];await openDemoDiff(review.mr,f);await renderDiscussionThreads(f);vscode.window.setStatusBarMessage(`MR !${review.mr.iid} review: ${review.index+1}/${review.mr.files.length} · ${f[0]} · F7 next · Shift+F7 previous`,5000);}
async function markReviewed(){if(!review.mr)return;const f=review.mr.files[review.index];if(!f)return;await setReviewed(review.mr,f[0],true);vscode.window.showInformationMessage(`Reviewed ${f[0]} (${review.index+1}/${review.mr.files.length})`);tree.refresh();reviewTree.refresh();if(review.index<review.mr.files.length-1){review.index++;reviewTree.refresh();await showReviewFile();}else{vscode.window.showInformationMessage('All changed files reviewed.');}}
function reviewVersion(mr){const r=mr?.diffRefs||{};return r.head_sha||r.headSha||mr?.sha||mr?.headSha||'current';}
function reviewStateKey(mr,pathName){return `reviewed:${mr?.repo||''}!${mr?.iid||''}@${reviewVersion(mr)}:${pathName}`;}
function isReviewed(mr,pathName){if(isDemo())return demoClient.isReviewed(mr,pathName);return extensionContext?.workspaceState.get(reviewStateKey(mr,pathName),false)===true;}
async function setReviewed(mr,pathName,value){if(isDemo()){demoClient.markReviewed(mr,pathName,value);return;}if(!extensionContext)return;await extensionContext.workspaceState.update(reviewStateKey(mr,pathName),value?true:undefined);}

async function loadDiscussions(client,mr){try{return await client().listDiscussions(mr)||[];}catch{return mr.discussions||[];}}
async function loadDraftNotes(client,mr){try{return await client().listDraftNotes(mr)||[];}catch{return [];}}
function clearRenderedComments(){for(const t of reviewComments){try{t.dispose();}catch{}}reviewComments=[];}
async function renderDiscussionThreads(file){
 clearRenderedComments(); if(!review.mr)return; const editor=vscode.window.activeTextEditor;if(!editor)return;
 for(const p of (review.pending||[]).filter(x=>x.path===file[0]||x.path===file[3]?.new_path||x.path===file[3]?.old_path)){const target=p.newLine||p.oldLine||1,line=Math.max(0,Math.min(editor.document.lineCount-1,target-1)),c={body:p.body,mode:vscode.CommentMode.Preview,author:{name:'You · Pending'}};const t=commentController.createCommentThread(editor.document.uri,new vscode.Range(line,0,line,0),[c]);t.label='Pending review comment · not published';t.canReply=false;t.collapsibleState=vscode.CommentThreadCollapsibleState.Expanded;reviewComments.push(t);}
 for(const d of review.discussions.filter(x=>x.path===file[0]||x.newPath===file[3]?.new_path||x.oldPath===file[3]?.old_path)){const target=d.newLine||d.line||1;const line=Math.max(0,Math.min(editor.document.lineCount-1,target-1));const comments=d.notes.map(n=>({body:n.body,mode:vscode.CommentMode.Preview,author:{name:n.author}}));const t=commentController.createCommentThread(editor.document.uri,new vscode.Range(line,0,line,0),comments);t.label=d.resolved?'Resolved review thread':`${d.notes.length} comment${d.notes.length===1?'':'s'} · ${d.notes[0]?.author||'Reviewer'} · line ${target}`;t.contextValue=d.resolved?'gitlabResolvedDiscussion':'gitlabDiscussion';t.canReply=false;t.collapsibleState=vscode.CommentThreadCollapsibleState.Expanded;reviewComments.push(t);}
}
async function openDiscussion(d){if(!review.mr)return;const i=review.mr.files.findIndex(f=>f[0]===d.path);if(i>=0){review.index=i;reviewTree.refresh();await showReviewFile();const ed=vscode.window.activeTextEditor;if(ed){const line=Math.max(0,Math.min(ed.document.lineCount-1,(d.line||1)-1));ed.selection=new vscode.Selection(line,0,line,0);ed.revealRange(new vscode.Range(line,0,line,0),vscode.TextEditorRevealType.InCenter);}}}
async function nextUnresolved(){const ds=review.discussions.filter(d=>!d.resolved);if(!ds.length){vscode.window.showInformationMessage('No unresolved review comments.');return;}const current=review.mr?.files[review.index]?.[0];let i=ds.findIndex(d=>d.path===current);const d=ds[(i+1)%ds.length];await openDiscussion(d);}
async function openPendingReviewComment(note){
 if(!review.mr||!note)return;
 const path=note.path||note.position?.new_path||note.position?.old_path;
 const files=review.mr.files||[];
 const index=files.findIndex(f=>f[0]===path||f[3]?.new_path===path||f[3]?.old_path===path);
 if(index<0){vscode.window.showWarningMessage(`The pending review comment refers to ${path}, which is not in the currently loaded diff.`);return;}
 review.index=index;reviewTree.refresh();await showReviewFile();
 const line=Number(note.newLine||note.oldLine||1);
 const editor=vscode.window.activeTextEditor;
 if(editor&&line>0){
  const target=Math.max(0,Math.min(editor.document.lineCount-1,line-1));
  const pos=new vscode.Position(target,0);
  editor.selection=new vscode.Selection(pos,pos);
  editor.revealRange(new vscode.Range(pos,pos),vscode.TextEditorRevealType.InCenterIfOutsideViewport);
 }
}
function discussionFromCommandArg(arg){
 // Commands invoked from a TreeView context/inline menu receive the tree element,
 // while commands invoked directly may receive the discussion itself.
 if(!arg)return undefined;
 if(arg.discussion)return arg.discussion;
 if(arg.notes && arg.id)return arg;
 return undefined;
}
async function replyDiscussion(client,arg){
 const d=discussionFromCommandArg(arg);
 if(!d){vscode.window.showWarningMessage('Could not determine which GitLab review thread to reply to.');return;}
 const first=d.notes?.[0];
 const body=await vscode.window.showInputBox({title:`Reply to ${first?.author||'reviewer'}`,prompt:`${d.path}:${d.line}`,placeHolder:'Reply…',ignoreFocusOut:true});
 if(!body)return;
 try{await client().replyDiscussion(review.mr,d.id,body);review.discussions=await loadDiscussions(client,review.mr);review.pending=await loadDraftNotes(client,review.mr);reviewTree.refresh();await showReviewFile();vscode.window.showInformationMessage('Reply posted to review thread.');}
 catch(e){vscode.window.showErrorMessage(`Could not reply to review comment: ${String(e.stderr||e.message||e)}`);}
}
async function resolveDiscussion(client,arg){
 const d=discussionFromCommandArg(arg);
 if(!d){vscode.window.showWarningMessage('Could not determine which GitLab review thread to resolve.');return;}
 try{await client().resolveDiscussion(review.mr,d.id,true);review.discussions=await loadDiscussions(client,review.mr);review.pending=await loadDraftNotes(client,review.mr);reviewTree.refresh();await showReviewFile();vscode.window.showInformationMessage('Review thread resolved.');}
 catch(e){vscode.window.showErrorMessage(`Could not resolve review comment: ${String(e.stderr||e.message||e)}`);}
}
async function addReviewComment(client){
 if(!review.mr){vscode.window.showWarningMessage('Start a merge request review first.');return;}
 const editor=vscode.window.activeTextEditor;
 if(!editor){vscode.window.showWarningMessage('Place the cursor on a review diff line first.');return;}
 const session=liveClient?.getReviewSession?.(review.mr);const isVirtualHead=editor.document.uri.scheme==='gitlab-workbench'&&editor.document.uri.path.includes('/head/');const isWorktreeHead=!isDemo()&&session?.worktree&&editor.document.uri.scheme==='file'&&path.resolve(editor.document.uri.fsPath).startsWith(path.resolve(session.worktree)+path.sep);
 if(!isVirtualHead&&!isWorktreeHead){vscode.window.showWarningMessage('Place the cursor on the changed (right-hand) side of the review diff.');return;}
 const file=review.mr.files[review.index]; const line=editor.selection.active.line;
 const body=await vscode.window.showInputBox({title:`Comment on ${file[0]}:${line+1}`,prompt:'Added to your pending GitLab review; it is published only when you Submit Review',placeHolder:'Review comment…',ignoreFocusOut:true});
 if(!body)return;
 try{
  if(!isDemo()){
   const patch=file[3]?.diff||'';
   const position=mapNewLineToGitLabPosition(patch,line+1);
   if(!position){vscode.window.showWarningMessage(`Line ${line+1} is not part of a GitLab MR diff hunk. Choose a line that is inside one of the GitLab diff hunks.`);return;}
   await client().addDraftReviewComment(review.mr,file,position,body);
   review.pending=await loadDraftNotes(client,review.mr);
   reviewTree.refresh();await renderDiscussionThreads(file);
  }else{
   const author={name:'You (demo)'};const c={body,mode:vscode.CommentMode.Preview,author};const thread=commentController.createCommentThread(editor.document.uri,new vscode.Range(line,0,line,0),[c]);thread.label=`MR !${review.mr.iid} review comment`;thread.canReply=false;reviewComments.push(thread);
  }
  vscode.window.showInformationMessage(isDemo()?`Demo review comment added at ${file[0]}:${line+1}`:`Pending review comment added at ${file[0]}:${line+1}`);
 }catch(e){vscode.window.showErrorMessage(`Could not add pending review comment: ${String(e.stderr||e.message||e)}`);}
}


async function submitReview(client){
 if(!review.mr)return;review.pending=await loadDraftNotes(client,review.mr);const count=review.pending.length;
 const outcome=await vscode.window.showQuickPick([{label:'$(check) Approve',description:'Publish comments and approve',value:'approve'},{label:'$(comment-discussion) Comment',description:'Publish comments without approval',value:'comment'},{label:'$(error) Request Changes',description:'Publish comments and block for changes',value:'request_changes'}],{title:`Submit Review · ${count} pending comment${count===1?'':'s'}`,placeHolder:'Choose review outcome',ignoreFocusOut:true});if(!outcome)return;
 const summary=await vscode.window.showInputBox({title:'Review Summary',prompt:'Optional summary published with the review',placeHolder:'Summary (optional)…',ignoreFocusOut:true});if(summary===undefined)return;
 try{const result=await client().submitReview(review.mr,{summary,outcome:outcome.value});review.pending=[];review.discussions=await loadDiscussions(client,review.mr);review.pending=await loadDraftNotes(client,review.mr);reviewTree.refresh();await showReviewFile();tree.refresh();mrWebview?.refresh();vscode.window.showInformationMessage(result.message);}catch(err){vscode.window.showErrorMessage(`Could not submit review: ${String(err.stderr||err.message||err)}`);}
}
async function discardPendingReview(client){
 if(!review.mr)return;review.pending=await loadDraftNotes(client,review.mr);if(!review.pending.length){vscode.window.showInformationMessage('There are no pending review comments.');return;}
 const yes=await vscode.window.showWarningMessage(`Discard ${review.pending.length} unpublished review comment${review.pending.length===1?'':'s'}?`,{modal:true},'Discard Review');if(yes!=='Discard Review')return;
 try{const result=await client().discardReview(review.mr);review.pending=[];reviewTree.refresh();await showReviewFile();vscode.window.showInformationMessage(result.message);}catch(err){vscode.window.showErrorMessage(`Could not discard review: ${String(err.stderr||err.message||err)}`);}
}

function mapNewLineToGitLabPosition(diff,targetNewLine){
 let oldLine=0,newLine=0,inHunk=false;
 for(const raw of String(diff||'').split(/\r?\n/)){
  const m=raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if(m){oldLine=Number(m[1]);newLine=Number(m[2]);inHunk=true;continue;}
  if(!inHunk||raw.startsWith('+++')||raw.startsWith('---')||raw.startsWith('\\ No newline'))continue;
  if(raw.startsWith('+')){if(newLine===targetNewLine)return {kind:'added',newLine};newLine++;continue;}
  if(raw.startsWith('-')){oldLine++;continue;}
  // Context lines must send BOTH old_line and new_line to GitLab.
  if(raw.startsWith(' ')){if(newLine===targetNewLine)return {kind:'context',oldLine,newLine};oldLine++;newLine++;}
 }
 return null;
}

async function openDemoDiff(mr,file){
 if(!file)return;ensureTextProvider();
 const token=encodeURIComponent(`${mr.repo}|${mr.iid}|${file[0]}`);
 const left=vscode.Uri.parse(`gitlab-workbench:/base/${token}/${encodeURIComponent(file[0])}`);
 let right=vscode.Uri.parse(`gitlab-workbench:/head/${token}/${encodeURIComponent(file[0])}`);
 if(!isDemo()){
  try{
   const v=await liveClient.getReviewFileVersions(mr,file);virtualText.set(left.toString(),v.base);
   const session=liveClient.getReviewSession(mr);
   const info=file[3]||{};const newPath=info.new_path||info.newPath||file[0];
   if(session?.worktree&&newPath){right=vscode.Uri.file(path.join(session.worktree,...String(newPath).split('/')));}
   else virtualText.set(right.toString(),v.head);
  }catch(e){vscode.window.showErrorMessage(`Could not load GitLab diff contents: ${String(e.stderr||e.message||e)}`);return;}
 }
 await vscode.commands.executeCommand('vscode.diff',left,right,`${file[0]} (!${mr.iid})`,{preview:false,preserveFocus:false,viewColumn:review.viewColumn || vscode.ViewColumn.Active});
 // VS Code's diff API does not expose renderSideBySide per invocation. When the user
 // wants unified review diffs and their normal setting is side-by-side, toggle only the
 // active diff editor after opening it.
 const unified=vscode.workspace.getConfiguration('gitlabWorkbench').get('unifiedDiff',true);
 const sideBySide=vscode.workspace.getConfiguration('diffEditor').get('renderSideBySide',true);
 if(unified && sideBySide){
  try{await vscode.commands.executeCommand('toggle.diff.renderSideBySide');}
  catch(e){liveClient?.log?.(`[review-diff] could not toggle unified diff: ${String(e?.message||e)}`);}
 }
}
async function prepareJavaReview(options={}){
 if(!review.mr||isDemo()){vscode.window.showWarningMessage('Start a live merge request review first.');return;}
 liveClient.log(`[review-jdt] prepare begin automatic=${!!options.automatic} mr=${review.mr.repo}!${review.mr.iid}`);
 try{
  liveClient.log('[review-jdt] generating minimal review composite root');
  const made=await liveClient.createCompositeReviewRoot(review.mr);review.compositeRoot=made.reviewRoot;
  liveClient.log(`[review-jdt] generated root=${made.reviewRoot}`);
  const choice=options.automatic?'Add/Switch in Fast Composite JDT':await vscode.window.showInformationMessage(`Java review root ready: ${made.reviewRoot}`, 'Add/Switch in Fast Composite JDT','Copy Path');
  liveClient.log(`[review-jdt] next action=${choice||'<none>'}`);
  if(choice==='Copy Path'){await vscode.env.clipboard.writeText(made.reviewRoot);liveClient.log('[review-jdt] copied review root path');vscode.window.showInformationMessage('Review composite root path copied.');}
  if(choice==='Add/Switch in Fast Composite JDT'){
   liveClient.log('[review-jdt] querying registered VS Code commands');
   const commands=await vscode.commands.getCommands(true);
   liveClient.log(`[review-jdt] fastCompositeJdt.addRoot registered=${commands.includes('fastCompositeJdt.addRoot')}`);
   if(!commands.includes('fastCompositeJdt.addRoot')){liveClient.output.show(true);vscode.window.showWarningMessage('Fast Composite JDT is not installed/active. The review clone and generated composite root are ready.');return;}
   await vscode.env.clipboard.writeText(made.reviewRoot);liveClient.log(`[review-jdt] copied generated root=${made.reviewRoot}`);
   vscode.window.showInformationMessage('Review root path copied. Select this generated folder in Fast Composite JDT: Add Composite Root, then choose “Add and switch”.');
   liveClient.log('[review-jdt] invoking fastCompositeJdt.addRoot');
   await vscode.commands.executeCommand('fastCompositeJdt.addRoot');
   liveClient.log('[review-jdt] fastCompositeJdt.addRoot returned');
  }
  liveClient.log('[review-jdt] prepare complete');
 }catch(e){
  liveClient.log(`[review-jdt] ERROR ${String(e?.stack||e?.stderr||e?.message||e)}`);liveClient.output.show(true);vscode.window.showErrorMessage(`Could not prepare Java review root: ${String(e.stderr||e.message||e)}`);
 }
}

async function switchJavaReviewRoot(){
 const commands=await vscode.commands.getCommands(true);if(!commands.includes('fastCompositeJdt.switchRoot')){vscode.window.showWarningMessage('Fast Composite JDT is not installed/active.');return;}
 await vscode.commands.executeCommand('fastCompositeJdt.switchRoot');
}
let providerRegistered=false;const virtualText=new Map();function ensureTextProvider(){if(providerRegistered)return;providerRegistered=true;vscode.workspace.registerTextDocumentContentProvider('gitlab-workbench',{provideTextDocumentContent(uri){const cached=virtualText.get(uri.toString());if(cached!==undefined)return cached;const base=uri.path.includes('/base/');return `// GitLab Workbench demo ${base?'BASE':'HEAD'}\n\npublic class Demo {\n    public String pricing() {\n        ${base?'return "old";':'return "new customer pricing";'}\n    }\n}\n`;}});}
function card(m){return `<div class="card" data-repo="${esc(m.repo)}" data-iid="${m.iid}"><div><b>${esc(m.repo)} !${m.iid}</b><h3>${esc(m.title||m.error)}</h3><small>${esc(m.source||'')} → ${esc(m.target||'')}</small></div><div>${status(m.pipeline)}</div></div>`;}
function status(s){return `<span class="${s==='failed'?'bad':s==='success'?'good':'warn'}">${esc(s||'unknown')}</span>`;}
function relativeTime(v){if(!v||v==='now')return 'just now';const t=Date.parse(v);if(!Number.isFinite(t))return String(v);const m=Math.floor(Math.max(0,Date.now()-t)/60000);if(m<1)return 'just now';if(m<60)return `${m}m ago`;const h=Math.floor(m/60);if(h<24)return `${h}h ago`;const d=Math.floor(h/24);if(d<30)return `${d}d ago`;return `${Math.floor(d/30)}mo ago`;}
function initials(n){const p=String(n||'?').trim().split(/\s+/);return esc((p.length>1?p[0][0]+p[p.length-1][0]:p[0].slice(0,2)).toUpperCase());}
function formatBody(x){return esc(x||'').replace(/\n/g,'<br>');}
function issueWorkflow(i){const l=(i.labels||[]).map(x=>String(x).toLowerCase()),has=(...x)=>l.some(v=>x.some(y=>v===y||v.includes(y)));if(String(i.state).toLowerCase()==='closed')return 'Closed';if(has('blocked','waiting'))return 'Blocked';if(has('in progress','in-progress','wip','doing'))return 'In Progress';if(has('review','in review'))return 'Review';if(has('todo','backlog','ready'))return 'To Do';return 'Open / Unclassified';}
function issuePage(body){return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:30px;margin:0}header,.layout{max-width:1160px;margin:auto}.topbar{display:flex;justify-content:space-between;align-items:center;gap:12px}.eyebrow{opacity:.6;font-size:12px}.title{display:flex;gap:14px;align-items:center}.title h1{margin:7px 0;font-size:26px}.sub{opacity:.7}.state{border:1px solid var(--vscode-panel-border);border-radius:99px;padding:4px 9px;font-size:11px}.layout{display:grid;grid-template-columns:minmax(0,850px) 240px;gap:32px;margin-top:28px}.event{display:grid;grid-template-columns:38px 1fr;gap:12px;margin-bottom:18px}.avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);font-size:11px;font-weight:bold}.meta{display:flex;gap:8px;font-size:12px;margin:2px 0 7px}.meta span,.muted{opacity:.6}.bubble,.composer{border:1px solid var(--vscode-panel-border);border-radius:7px}.bubble{padding:15px;line-height:1.55}.desc{min-height:64px}.empty{margin:10px 0 24px 50px;opacity:.6}.composer{margin:28px 0 0 50px;overflow:hidden}.composer>b{display:block;padding:10px 12px;background:var(--vscode-sideBar-background)}textarea{width:100%;min-height:130px;border:0;border-top:1px solid var(--vscode-panel-border);padding:12px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit;outline:0}.composerfoot{display:flex;justify-content:space-between;align-items:center;padding:9px 10px;font-size:11px;border-top:1px solid var(--vscode-panel-border)}button{padding:6px 10px;border-radius:4px;border:1px solid var(--vscode-button-border,transparent);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}aside section{font-size:12px;padding-bottom:16px;margin-bottom:16px;border-bottom:1px solid var(--vscode-panel-border)}.sidehead{font-weight:bold;opacity:.7;margin-bottom:7px;display:flex;justify-content:space-between}.link{border:0;background:none;color:var(--vscode-textLink-foreground);padding:0}.chip{display:inline-block;border:1px solid var(--vscode-panel-border);border-radius:99px;padding:2px 7px;margin:2px}.actions button{display:block;width:100%;margin:6px 0;text-align:left}.issue-editor{border:1px solid var(--vscode-panel-border);border-radius:8px;overflow:hidden}.editor-head{display:flex;justify-content:space-between;padding:12px 14px;background:var(--vscode-sideBar-background)}.issue-editor label{display:block;font-weight:bold;font-size:12px;margin:14px 14px 6px}.edit-input{width:calc(100% - 28px);margin:0 14px;padding:9px 10px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}.editor-tabs{display:flex;gap:12px;padding:14px 14px 0}.active-tab{font-weight:bold;text-decoration:underline}.edit-description{min-height:260px;border:1px solid var(--vscode-panel-border);margin:8px 14px;width:calc(100% - 28px);border-radius:4px}.edit-preview{min-height:260px;border:1px solid var(--vscode-panel-border);margin:8px 14px;padding:14px;border-radius:4px;white-space:pre-wrap;line-height:1.55}.editor-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.editor-grid small{display:block;margin:5px 14px 0;opacity:.6}.editor-actions{display:flex;justify-content:flex-end;gap:8px;padding:14px;border-top:1px solid var(--vscode-panel-border);margin-top:14px}@media(max-width:800px){.layout{grid-template-columns:1fr}.composer{margin-left:0}}</style></head><body>${body}<script>const vscode=acquireVsCodeApi();document.querySelectorAll('[data-issue-url]').forEach(x=>x.onclick=()=>vscode.postMessage({issueUrl:x.dataset.issueUrl}));document.querySelectorAll('[data-issue-action]').forEach(x=>x.onclick=()=>{const a=x.dataset.issueAction;if(a==='submit-comment')vscode.postMessage({issueAction:a,body:document.getElementById('issue-comment')?.value||''});else if(a==='save-edit')vscode.postMessage({issueAction:a,title:document.getElementById('edit-title')?.value||'',description:document.getElementById('edit-description')?.value||'',assignees:document.getElementById('edit-assignees')?.value||'',labels:document.getElementById('edit-labels')?.value||''});else vscode.postMessage({issueAction:a})});document.getElementById('issue-comment')?.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();document.querySelector('[data-issue-action="submit-comment"]')?.click()}});const editDesc=document.getElementById('edit-description');const editPreview=document.getElementById('edit-preview');document.querySelectorAll('[data-edit-tab]').forEach(b=>b.onclick=()=>{const preview=b.dataset.editTab==='preview';editDesc.hidden=preview;editPreview.hidden=!preview;if(preview)editPreview.textContent=editDesc.value||'Nothing to preview.';document.querySelectorAll('[data-edit-tab]').forEach(x=>x.classList.toggle('active-tab',x===b))});document.addEventListener('keydown',e=>{if(!document.getElementById('edit-title'))return;if(e.key==='Escape'){e.preventDefault();vscode.postMessage({issueAction:'cancel-edit'})}else if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();document.querySelector('[data-issue-action="save-edit"]')?.click()}});</script></body></html>`;}

function page(title,body){return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:var(--vscode-font-family);padding:24px;max-width:1050px;margin:auto;color:var(--vscode-foreground)}h1{margin:0}.hero,.card,.file{display:flex;justify-content:space-between;align-items:center}.hero{margin-bottom:20px}.stats{padding:14px;background:var(--vscode-editor-inactiveSelectionBackground);border-radius:8px;margin:12px 0 20px}.card,.file{padding:14px;border:1px solid var(--vscode-panel-border);border-radius:8px;margin:8px 0;cursor:pointer}.card:hover,.file:hover{background:var(--vscode-list-hoverBackground)}button{padding:7px 13px;margin-right:7px}.good{color:var(--vscode-testing-iconPassed)}.bad{color:var(--vscode-testing-iconFailed)}.warn{color:var(--vscode-editorWarning-foreground)}.pill{border:1px solid var(--vscode-panel-border);padding:5px 10px;border-radius:99px}.actions{margin:15px 0}.comment{padding:12px 0;border-top:1px solid var(--vscode-panel-border)}.comment p{margin-bottom:0}.muted{opacity:.7}small{opacity:.7}</style></head><body>${body}<script>const vscode=acquireVsCodeApi();document.querySelectorAll('.card').forEach(x=>x.onclick=()=>vscode.postMessage({command:'open',repo:x.dataset.repo,iid:Number(x.dataset.iid)}));document.querySelectorAll('[data-action]').forEach(x=>x.onclick=()=>vscode.postMessage({action:x.dataset.action}));document.querySelectorAll('[data-file]').forEach(x=>x.onclick=()=>vscode.postMessage({file:Number(x.dataset.file)}));document.querySelector('[data-cmd="refresh"]')?.addEventListener('click',()=>vscode.postMessage({command:'refresh'}));document.querySelectorAll('[data-issue-url]').forEach(x=>x.onclick=()=>vscode.postMessage({issueUrl:x.dataset.issueUrl}));document.querySelectorAll('[data-issue-action]').forEach(x=>x.onclick=()=>vscode.postMessage({issueAction:x.dataset.issueAction}));</script></body></html>`;}
function isDemo(){return vscode.workspace.getConfiguration('gitlabWorkbench').get('demoMode',true);}function esc(x){return String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function deactivate(){}
module.exports={activate,deactivate};
