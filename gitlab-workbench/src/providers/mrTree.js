const vscode=require('vscode');
class MrTreeProvider{
 constructor(clientFactory){this.clientFactory=clientFactory;this._onDidChangeTreeData=new vscode.EventEmitter();this.onDidChangeTreeData=this._onDidChangeTreeData.event;}
 refresh(){this._onDidChangeTreeData.fire();}
 async getChildren(element){
  if(!element){const mrs=await this.clientFactory().listMergeRequests();const groups=new Map();for(const mr of mrs){const key=mr.repo;if(!groups.has(key))groups.set(key,{repo:key,name:mr.repoName||key,items:[]});groups.get(key).items.push(mr);}return [...groups.values()].map(g=>({kind:'repo',repo:g.repo,name:g.name,items:g.items}));}
  if(element.kind==='repo')return element.items.map(mr=>mr.kind==='error'?{kind:'error',mr}:mr.kind==='empty'?{kind:'empty',mr}:mr.kind==='status'?{kind:'status',mr}:{kind:'mr',mr});return [];
 }
 getTreeItem(el){
  if(el.kind==='repo'){const good=el.items.filter(x=>!x.kind);const t=new vscode.TreeItem(el.name,vscode.TreeItemCollapsibleState.Expanded);t.description=`${good.length} open`;t.tooltip=el.repo;t.iconPath=new vscode.ThemeIcon('repo');return t;}
  if(el.kind==='empty'){const t=new vscode.TreeItem('No open merge requests',vscode.TreeItemCollapsibleState.None);t.iconPath=new vscode.ThemeIcon('check');return t;}
  if(el.kind==='status'){const t=new vscode.TreeItem(el.mr.repoName||'GitLab Workbench status',vscode.TreeItemCollapsibleState.None);t.description='status';t.tooltip=el.mr.error||'';t.iconPath=new vscode.ThemeIcon('info');return t;}
  if(el.kind==='error'){const t=new vscode.TreeItem('GitLab query failed',vscode.TreeItemCollapsibleState.None);t.description='error';t.tooltip=el.mr.error;t.iconPath=new vscode.ThemeIcon('error');return t;}
  const mr=el.mr;const t=new vscode.TreeItem(`!${mr.iid}  ${mr.title}`,vscode.TreeItemCollapsibleState.None);t.description=[mr.author?`by ${mr.author}`:'by unknown',`${symbol(mr.pipeline)} ${mr.pipeline}`,mr.approvals||''].filter(Boolean).join('  ·  ');t.tooltip=`${mr.repoName||mr.repo}\nSubmitted by: ${mr.author||'unknown'}\n${mr.source} → ${mr.target}`;t.iconPath=new vscode.ThemeIcon(mr.pipeline==='failed'?'error':mr.pipeline==='running'?'sync~spin':'git-pull-request');t.command={command:'gitlabWorkbench.openMr',title:'Open MR',arguments:[mr]};return t;
 }
}
function symbol(s){return s==='success'?'✓':s==='failed'?'✕':s==='running'?'◌':'•';}
module.exports={MrTreeProvider};
