const vscode=require('vscode');
class MrTreeProvider{
 constructor(clientFactory){this.clientFactory=clientFactory;this._onDidChangeTreeData=new vscode.EventEmitter();this.onDidChangeTreeData=this._onDidChangeTreeData.event;}
 refresh(){this._onDidChangeTreeData.fire();}
 async getChildren(element){
  if(!element){
   const all=await this.clientFactory().listMergeRequests();
   const real=all.filter(m=>!m.kind);
   const reviewing=real.filter(m=>m.isReviewer||m.hasMyComments).sort(reviewSort);
   const rest=real.filter(m=>!(m.isReviewer||m.hasMyComments));
   const roots=[];
   if(reviewing.length)roots.push({kind:'reviewing',items:reviewing});
   const groups=new Map();
   for(const mr of rest){const key=mr.repo;if(!groups.has(key))groups.set(key,{repo:key,name:mr.repoName||key,items:[]});groups.get(key).items.push(mr);}
   roots.push(...[...groups.values()].map(g=>({kind:'repo',...g})));
   for(const special of all.filter(m=>m.kind))roots.push(special.kind==='status'?{kind:'status',mr:special}:special.kind==='error'?{kind:'error',mr:special}:special.kind==='empty'?{kind:'emptyRepo',mr:special}:special);
   return roots;
  }
  if(element.kind==='reviewing')return element.items.map(mr=>({kind:'mr',mr}));
  if(element.kind==='repo')return element.items.map(mr=>({kind:'mr',mr}));
  if(element.kind==='mr')return [{kind:'mrMeta',mr:element.mr},{kind:'mrActivity',mr:element.mr}];
  return [];
 }
 getTreeItem(el){
  if(el.kind==='reviewing'){const changed=el.items.filter(x=>x.changesSinceMyComment>0).length;const t=new vscode.TreeItem('My Reviews',vscode.TreeItemCollapsibleState.Expanded);t.description=`${el.items.length} open${changed?` · ${changed} changed`:''}`;t.tooltip='Open merge requests where you are a reviewer or have left comments. They remain here until merged/closed.';t.iconPath=new vscode.ThemeIcon('eye');return t;}
  if(el.kind==='repo'){const t=new vscode.TreeItem(el.name,vscode.TreeItemCollapsibleState.Expanded);t.description=`${el.items.length} open`;t.tooltip=el.repo;t.iconPath=new vscode.ThemeIcon('repo');return t;}
  if(el.kind==='emptyRepo'||el.kind==='empty'){const t=new vscode.TreeItem(`${el.mr.repoName||''} · No open merge requests`.replace(/^ · /,''),vscode.TreeItemCollapsibleState.None);t.iconPath=new vscode.ThemeIcon('check');return t;}
  if(el.kind==='status'){const t=new vscode.TreeItem(el.mr.repoName||'GitLab Workbench status',vscode.TreeItemCollapsibleState.None);t.description='status';t.tooltip=el.mr.error||'';t.iconPath=new vscode.ThemeIcon('info');return t;}
  if(el.kind==='error'){const t=new vscode.TreeItem('GitLab query failed',vscode.TreeItemCollapsibleState.None);t.description='error';t.tooltip=el.mr.error;t.iconPath=new vscode.ThemeIcon('error');return t;}
  if(el.kind==='mrMeta'){
   const mr=el.mr,age=ageText(mr.created);
   const t=new vscode.TreeItem([mr.author||'unknown',mr.repoName||mr.repo,age?`${age} old`:''].filter(Boolean).join('  ·  '),vscode.TreeItemCollapsibleState.None);
   t.iconPath=new vscode.ThemeIcon('account');t.contextValue='mrMeta';
   t.command={command:'gitlabWorkbench.openMr',title:'Open MR',arguments:[mr]};return t;
  }
  if(el.kind==='mrActivity'){
   const mr=el.mr,changed=Number(mr.changesSinceMyComment||0);
   const label=changed?`${changed} new commit${changed===1?'':'s'} since your last comment`:mr.hasMyComments?'No commits since your last comment':mr.isReviewer?'Review requested':'Open merge request';
   const t=new vscode.TreeItem(label,vscode.TreeItemCollapsibleState.None);
   const failed=mr.pipeline==='failed';
   t.iconPath=new vscode.ThemeIcon(changed?'sync':failed?'error':mr.hasMyComments?'pass':'eye',new vscode.ThemeColor(changed?'list.warningForeground':failed?'list.errorForeground':'descriptionForeground'));
   t.description=failed?'pipeline failed':mr.pipeline==='running'?'pipeline running':'';
   t.contextValue='mrActivity';t.command={command:'gitlabWorkbench.openMr',title:'Open MR',arguments:[mr]};return t;
  }
  const mr=el.mr;const age=ageText(mr.created);const changed=Number(mr.changesSinceMyComment||0);
  const t=new vscode.TreeItem(`!${mr.iid}  ${mr.title}`,vscode.TreeItemCollapsibleState.Expanded);
  t.tooltip=[`${mr.repoName||mr.repo} !${mr.iid}`,`Submitted by: ${mr.author||'unknown'}`,age?`Open: ${age}`:'',mr.isReviewer?'You are a reviewer':'',mr.hasMyComments?`Your last comment: ${relative(mr.lastMyComment)}`:'',changed?`${changed} commit${changed===1?'':'s'} since your last comment`:'No commits since your last comment',`Pipeline: ${mr.pipeline||'unknown'}`,`${mr.source} → ${mr.target}`].filter(Boolean).join('\n');
  const icon=changed?'sync':mr.pipeline==='failed'?'error':(mr.isReviewer||mr.hasMyComments)?'eye':'git-pull-request';
  const color=changed?'list.warningForeground':mr.pipeline==='failed'?'list.errorForeground':undefined;
  t.iconPath=new vscode.ThemeIcon(icon,color?new vscode.ThemeColor(color):undefined);
  t.contextValue='mr';t.command={command:'gitlabWorkbench.openMr',title:'Open MR',arguments:[mr]};return t;
 }
}
function reviewSort(a,b){const ac=Number(a.changesSinceMyComment||0)>0,bc=Number(b.changesSinceMyComment||0)>0;if(ac!==bc)return ac?-1:1;return Date.parse(a.updated||0)-Date.parse(b.updated||0);}
function ageText(v){const ms=Date.parse(v||'');if(!Number.isFinite(ms))return '';const d=Date.now()-ms;if(d<0)return '';const h=Math.floor(d/3600000);if(h<1)return `${Math.max(1,Math.floor(d/60000))}m`;if(h<24)return `${h}h`;const days=Math.floor(h/24);return `${days}d`;}
function relative(v){const a=ageText(v);return a?`${a} ago`:v||'';}
function symbol(s){return s==='success'?'✓':s==='failed'?'✕':s==='running'?'◌':'•';}
module.exports={MrTreeProvider};
