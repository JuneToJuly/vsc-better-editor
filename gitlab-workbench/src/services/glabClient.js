const cp = require('child_process');
const path = require('path');
const util = require('util');
const fs = require('fs/promises');
const crypto = require('crypto');
const execFile = util.promisify(cp.execFile);

class GlabClient {
 constructor(vscode,context){this.vscode=vscode;this.context=context;this.repos=new Map();this.reviewRepos=new Map();this.mrActivityCache=new Map();this.output=vscode.window.createOutputChannel('GitLab Workbench');}
 log(message){this.output.appendLine(message);}
 workspaceReviewRoot(){
  const folders=this.vscode.workspace.workspaceFolders||[];
  if(!folders.length)throw new Error('Open a VS Code workspace folder before starting a local review.');
  return path.join(folders[0].uri.fsPath,'.glw');
 }
 async run(args,cwd){
  const cfg=this.vscode.workspace.getConfiguration('gitlabWorkbench');
  const bin=cfg.get('glabPath','glab'),started=Date.now();
  const label=args[0]==='api'?`api ${args.find(x=>String(x).startsWith('projects/'))||''}`:args.slice(0,3).join(' ');
  try{
   const {stdout}=await execFile(bin,args,{cwd,env:{...process.env,GLAB_NO_PROMPT:'1',GLAB_PROMPT_DISABLED:'1'},maxBuffer:20*1024*1024,windowsHide:true});
   this.output.appendLine(`[perf] glab ${label} ${Date.now()-started}ms`);
   return stdout.trim();
  }catch(e){this.output.appendLine(`[perf] glab ${label} FAILED ${Date.now()-started}ms`);throw e;}
 }
 async status(){await this.run(['auth','status']); return {mode:'live',authenticated:true};}
 async api(host,endpoint,args=[],cwd){return this.run(['api','--hostname',host,endpoint,...args],cwd);}
 async managedProjects(){
  const values=this.vscode.workspace.getConfiguration('gitlabWorkbench').get('managedProjects',[])||[];
  return values.map(parseProjectUrl).filter(Boolean);
 }

 async discoverRepositories(){
  const roots=this.vscode.workspace.workspaceFolders||[];
  this.output.appendLine(`[discovery] workspace folders: ${roots.length}`);
  const candidates=new Set();
  for(const folder of roots){
   this.output.appendLine(`[discovery] scanning ${folder.uri.fsPath}`);
   for(const repoPath of await findGitRepositories(folder.uri.fsPath)) candidates.add(repoPath);
  }
  this.output.appendLine(`[discovery] git candidates: ${candidates.size}`);
  const found=[]; const seen=new Set(); this.repos.clear();
  for(const cwd of candidates){
   try{
    const top=(await this.git(['rev-parse','--show-toplevel'],cwd)).trim();
    const key=process.platform==='win32'?top.toLowerCase():top;
    if(seen.has(key))continue; seen.add(key);
    const remote=(await this.git(['remote','get-url','origin'],top).catch(()=>'' )).trim();
    if(!remote){this.output.appendLine(`[discovery] skip (no origin): ${top}`);continue;}
    let project='';
    try{
     const raw=await this.run(['repo','view','--output','json'],top);
     const obj=JSON.parse(raw||'{}'); project=pick(obj,'path_with_namespace','pathWithNamespace','fullPath','nameWithNamespace')||projectFromRemote(remote)||'';
    }catch(e){project=projectFromRemote(remote)||'';this.output.appendLine(`[discovery] repo view failed for ${top}: ${cleanError(e)}`);}
    const name=project?project.split('/').pop():path.basename(top);
    const id=project||top;
    const repo={id,name,project,cwd:top,remote};
    this.repos.set(id,repo); found.push(repo);
    this.output.appendLine(`[discovery] found ${project||name} @ ${top}`);
   }catch(e){this.output.appendLine(`[discovery] rejected ${cwd}: ${cleanError(e)}`);}
  }
  found.sort((a,b)=>a.name.localeCompare(b.name));
  this.output.appendLine(`[discovery] usable repositories: ${found.length}`);
  return found;
 }

 async projectList(){
  const cfg=this.vscode.workspace.getConfiguration('gitlabWorkbench');
  const local=cfg.get('discoverLocalRepositories',false)?await this.discoverRepositories():[];
  const managed=await this.managedProjects();const byKey=new Map();
  for(const r of managed)byKey.set(`${r.host}/${r.project}`.toLowerCase(),r);
  for(const r of local){const parsed=parseProjectUrl(r.remote);if(parsed){const key=`${parsed.host}/${parsed.project}`.toLowerCase();const existing=byKey.get(key);if(existing)existing.cwd=r.cwd;else byKey.set(key,{...parsed,cwd:r.cwd,source:'local'});}}
  const repos=[...byKey.values()];this.repos.clear();for(const r of repos){r.id=`${r.host}/${r.project}`;r.name=r.project.split('/').pop();this.repos.set(r.id,r);}return repos;
 }
 async listIssues(){
  const repos=await this.projectList();
  if(!repos.length)return [{kind:'status',repo:'__status__',repoName:'No managed GitLab projects',error:'Add a project URL with GitLab Workbench: Add Project.'}];
  const out=[];
  for(const repo of repos){try{
   this.output.appendLine(`[issue] ${repo.project}: querying ${repo.host}`);
   const endpoint=`projects/${encodeURIComponent(repo.project)}/issues?state=opened&per_page=100&order_by=updated_at&sort=desc`;
   const raw=await this.api(repo.host,endpoint,[],repo.cwd);const arr=raw?JSON.parse(raw):[];this.output.appendLine(`[issue] ${repo.project}: ${arr.length} open`);
   if(!arr.length)out.push({repo:repo.id,repoName:repo.name,kind:'empty'});for(const x of arr)out.push(this.normalizeIssue(x,repo));
  }catch(e){const error=cleanError(e);this.output.appendLine(`[issue] ${repo.project}: ERROR ${error}`);out.push({repo:repo.id,repoName:repo.name,error,kind:'error'});}}
  return out;
 }
 normalizeIssue(x,repo){return {repo:repo.id,repoName:repo.name,project:repo.project,host:repo.host,iid:Number(x.iid),title:x.title||'(untitled)',author:person(x.author),state:x.state||'opened',labels:Array.isArray(x.labels)?x.labels:[],assignees:(x.assignees||[]).map(a=>a.username||a.name).filter(Boolean),updated:x.updated_at||'',description:x.description||'',webUrl:x.web_url||'',commentCount:Number(x.user_notes_count||0)};}
 async getIssue(repoId,iid){const repo=await this.repo(repoId);const raw=await this.api(repo.host,`projects/${encodeURIComponent(repo.project)}/issues/${iid}`,[],repo.cwd);return this.normalizeIssue(JSON.parse(raw),repo);}
 async listIssueNotes(issue){const repo=await this.repo(issue.repo);const raw=await this.api(repo.host,`projects/${encodeURIComponent(repo.project)}/issues/${issue.iid}/notes?sort=asc&per_page=100`,[],repo.cwd);return (JSON.parse(raw)||[]).filter(n=>!n.system).map(n=>({id:String(n.id),author:person(n.author),body:n.body||'',created:n.created_at||''}));}
 async addIssueNote(issue,body){const repo=await this.repo(issue.repo);await this.api(repo.host,`projects/${encodeURIComponent(repo.project)}/issues/${issue.iid}/notes`,['--method','POST','-f',`body=${body}`],repo.cwd);return {message:'Comment added'};}
 async createIssue(repoId,data){const repo=await this.repo(repoId);const args=['--method','POST','-f',`title=${data.title}`];if(data.description)args.push('-f',`description=${data.description}`);if(data.assignee)args.push('-f',`assignee_ids=${await this.userId(repo,data.assignee)}`);const raw=await this.api(repo.host,`projects/${encodeURIComponent(repo.project)}/issues`,args,repo.cwd);return this.normalizeIssue(JSON.parse(raw),repo);}
 async updateIssue(issue,data){const repo=await this.repo(issue.repo);const args=['--method','PUT'];if(data.title!==undefined)args.push('-f',`title=${data.title}`);if(data.description!==undefined)args.push('-f',`description=${data.description}`);if(data.labels!==undefined)args.push('-f',`labels=${data.labels.join(',')}`);if(data.state_event)args.push('-f',`state_event=${data.state_event}`);if(data.assignees!==undefined){const ids=[];for(const u of data.assignees){if(u)ids.push(await this.userId(repo,u));}args.push('-f',`assignee_ids=${ids.join(',')}`);}const raw=await this.api(repo.host,`projects/${encodeURIComponent(repo.project)}/issues/${issue.iid}`,args,repo.cwd);return this.normalizeIssue(JSON.parse(raw),repo);}
 async userId(repo,username){const raw=await this.api(repo.host,`users?username=${encodeURIComponent(username)}`,[],repo.cwd);const users=JSON.parse(raw)||[];if(!users.length)throw new Error(`GitLab user not found: ${username}`);return users[0].id;}
 async currentUser(){const projects=await this.projectList();if(!projects.length)return null;const r=projects[0];const raw=await this.api(r.host,'user',[],r.cwd);const u=JSON.parse(raw);return u.username||u.name;}
 async listMergeRequests(){
  const cfg=this.vscode.workspace.getConfiguration('gitlabWorkbench');
  const local=cfg.get('discoverLocalRepositories',false)?await this.discoverRepositories():[];
  const managed=await this.managedProjects();
  const byKey=new Map();
  for(const r of managed){byKey.set(`${r.host}/${r.project}`.toLowerCase(),r);}
  for(const r of local){
   const parsed=parseProjectUrl(r.remote);
   if(parsed){const key=`${parsed.host}/${parsed.project}`.toLowerCase();const existing=byKey.get(key);if(existing)existing.cwd=r.cwd;else byKey.set(key,{...parsed,cwd:r.cwd,source:'local'});}
  }
  const repos=[...byKey.values()]; this.repos.clear();
  for(const r of repos){r.id=`${r.host}/${r.project}`;r.name=r.project.split('/').pop();this.repos.set(r.id,r);}
  if(!repos.length)return [{kind:'status',repo:'__status__',repoName:'No managed GitLab projects',error:'Add a project URL with GitLab Workbench: Add Project.'}];
  const out=[];
  for(const repo of repos){
   try{
    this.output.appendLine(`[mr] ${repo.project}: querying ${repo.host}${repo.cwd?` (local: ${repo.cwd})`:' (remote only)'}`);
    const endpoint=`projects/${encodeURIComponent(repo.project)}/merge_requests?state=opened&per_page=${this.vscode.workspace.getConfiguration('gitlabWorkbench').get('perPage',50)}`;
    const raw=await this.api(repo.host,endpoint,[],repo.cwd);const arr=raw?JSON.parse(raw):[];
    this.output.appendLine(`[mr] ${repo.project}: ${arr.length} open`);
    if(!arr.length)out.push({repo:repo.id,repoName:repo.name,kind:'empty'});
    const me=await this.currentUserForRepo(repo);
    const normalized=arr.map(x=>this.normalize(x,repo));
    const enriched=await Promise.all(normalized.map(mr=>this.enrichMergeRequestActivity(mr,repo,me)));
    out.push(...enriched);
   }catch(e){const error=cleanError(e);this.output.appendLine(`[mr] ${repo.project}: ERROR ${error}`);out.push({repo:repo.id,repoName:repo.name,error,kind:'error'});}
  }
  return out;
 }

 normalize(x,repo){
  const iid=Number(pick(x,'iid','Iid','internalId','number','id'));
  const pipelineObj=pick(x,'pipeline','headPipeline');
  const pipeline=(pipelineObj&&typeof pipelineObj==='object'?pick(pipelineObj,'status','Status'):pipelineObj)||pick(x,'pipeline_status','pipelineStatus')||'unknown';
  const approvalsRaw=pick(x,'approvals','approvedBy','approvalsRequired');
  const approvals=Array.isArray(approvalsRaw)?String(approvalsRaw.length):(approvalsRaw??'');
  return {
   repo:repo.id,repoName:repo.name,repoPath:repo.cwd,project:repo.project,host:repo.host,
   iid:Number.isFinite(iid)?iid:undefined,
   title:pick(x,'title','Title')||'(untitled)',
   author:person(pick(x,'author','Author')),
   reviewers:(pick(x,'reviewers','Reviewers')||[]).map(person).filter(Boolean),
   created:pick(x,'created_at','createdAt')||'',
   sha:pick(x,'sha','head_sha','headSha')||'',

   source:pick(x,'source_branch','sourceBranch','source_branch_name')||'',
   target:pick(x,'target_branch','targetBranch','target_branch_name')||'',
   pipeline:String(pipeline).toLowerCase(),approvals,
   conflicts:!!pick(x,'has_conflicts','hasConflicts','conflicts'),
   updated:pick(x,'updated_at','updatedAt')||'',description:pick(x,'description','Description')||'',
   webUrl:pick(x,'web_url','webUrl','url'),diffRefs:pick(x,'diff_refs','diffRefs')||null,files:[]
  };
 }


 async currentUserForRepo(repo){
  try{const raw=await this.api(repo.host,'user',[],repo.cwd);const u=JSON.parse(raw);return u.username||u.name||'';}catch{return '';}
 }
 async enrichMergeRequestActivity(mr,repo,me){
  mr.currentUser=me||'';mr.isReviewer=!!me&&(mr.reviewers||[]).some(x=>String(x).toLowerCase()===String(me).toLowerCase());
  if(!me)return mr;
  const key=`${repo.id}!${mr.iid}:${mr.sha||mr.updated||''}:${me}`;const cached=this.mrActivityCache.get(key);
  if(cached&&Date.now()-cached.at<60000)return {...mr,...cached.value};
  let value={hasMyComments:false,lastMyComment:'',changesSinceMyComment:0,lastCommit:''};
  try{
   const project=encodeURIComponent(repo.project);
   const [notesRaw,commitsRaw]=await Promise.all([
    this.api(repo.host,`projects/${project}/merge_requests/${mr.iid}/notes?per_page=100&sort=desc`,[],repo.cwd),
    this.api(repo.host,`projects/${project}/merge_requests/${mr.iid}/commits?per_page=100`,[],repo.cwd)
   ]);
   const notes=JSON.parse(notesRaw||'[]')||[];const commits=JSON.parse(commitsRaw||'[]')||[];
   const mine=notes.filter(n=>!n.system&&person(n.author).toLowerCase()===String(me).toLowerCase());
   const last=mine.map(n=>n.created_at).filter(Boolean).sort().pop()||'';
   const lastMs=last?Date.parse(last):0;
   const newer=lastMs?commits.filter(c=>Date.parse(c.committed_date||c.created_at||c.authored_date||0)>lastMs):[];
   value={hasMyComments:mine.length>0,lastMyComment:last,changesSinceMyComment:newer.length,lastCommit:(commits.map(c=>c.committed_date||c.created_at||'').filter(Boolean).sort().pop()||'')};
  }catch(e){this.output.appendLine(`[mr-activity] ${repo.project}!${mr.iid}: ${cleanError(e)}`);}
  this.mrActivityCache.set(key,{at:Date.now(),value});return {...mr,...value};
 }
 async listMergeRequestCommits(mr){
  const repo=await this.repo(mr.repo),project=encodeURIComponent(repo.project);
  try{const raw=await this.api(repo.host,`projects/${project}/merge_requests/${mr.iid}/commits?per_page=100`,[],repo.cwd);return (JSON.parse(raw||'[]')||[]).map(c=>({id:c.id||'',shortId:c.short_id||(c.id||'').slice(0,8),title:c.title||String(c.message||'Commit').split('\n')[0],author:c.author_name||c.committer_name||'',created:c.committed_date||c.created_at||c.authored_date||'',webUrl:c.web_url||''}));}
  catch(e){this.output.appendLine(`[mr-commits] ${repo.project}!${mr.iid}: ${cleanError(e)}`);return [];}
 }

 async getMergeReadiness(mr){
  const repo=await this.repo(mr.repo),project=encodeURIComponent(repo.project);
  const approvalsPromise=this.api(repo.host,`projects/${project}/merge_requests/${mr.iid}/approvals`,[],repo.cwd)
   .then(raw=>{const a=JSON.parse(raw);return {approved:Number(a.approvals_left!=null?Math.max(0,Number(a.approvals_required||0)-Number(a.approvals_left||0)):(a.approved_by||[]).length),required:Number(a.approvals_required||0),users:(a.approved_by||[]).map(x=>person(x.user||x))};})
   .catch(()=>({approved:0,required:0,users:[]}));
  const pipelinePromise=this.api(repo.host,`projects/${project}/merge_requests/${mr.iid}/pipelines?per_page=1`,[],repo.cwd)
   .then(raw=>(JSON.parse(raw)||[])[0]||null).catch(()=>null);
  const [approvals,pipeline]=await Promise.all([approvalsPromise,pipelinePromise]);
  let jobs=[];
  if(pipeline?.id)try{jobs=JSON.parse(await this.api(repo.host,`projects/${project}/pipelines/${pipeline.id}/jobs?per_page=100`,[],repo.cwd))||[];}catch{}
  return {approvals,pipeline,jobs};
 }
 async getMergeRequest(repoId,iid){
  const repo=await this.repo(repoId);
  const raw=await this.api(repo.host,`projects/${encodeURIComponent(repo.project)}/merge_requests/${iid}`,[],repo.cwd);
  const mr=this.normalize(JSON.parse(raw),repo);
  // Use the API for changed-file metadata; glab mr view does not consistently expose it.
  try{
   const project=await this.ensureProject(repo);
   const diffRaw=await this.api(repo.host,`projects/${encodeURIComponent(project)}/merge_requests/${iid}/diffs?per_page=100`,[],repo.cwd);
   const diffs=JSON.parse(diffRaw)||[];
   mr.files=diffs.map(d=>[d.new_path||d.old_path||'',countAdded(d.diff),countRemoved(d.diff),d]);
  }catch{}
  return mr;
 }

 async getFileVersions(mr,pathName){
  // Non-review callers retain the remote fallback. Active reviews use
  // getReviewFileVersions(), which reads directly from the local Git object store.
  const {f,project,host}=await this.projectPath(mr);
  let refs=mr.diffRefs;
  if(!refs){const raw=await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}`,[],f);const obj=JSON.parse(raw);refs=obj.diff_refs||obj.diffRefs;}
  if(!refs)throw new Error('GitLab did not return merge request diff refs.');
  const base=refs.base_sha||refs.baseSha;const head=refs.head_sha||refs.headSha;
  const encoded=encodeURIComponent(pathName);
  const read=async ref=>{try{return await this.api(host,`projects/${encodeURIComponent(project)}/repository/files/${encoded}/raw?ref=${encodeURIComponent(ref)}`,[],f);}catch{return ''}};
  return {base:await read(base),head:await read(head)};
 }
 async prepareReview(mr){
  const repo=await this.repo(mr.repo);
  let refs=mr.diffRefs;
  if(!refs){const raw=await this.api(repo.host,`projects/${encodeURIComponent(repo.project)}/merge_requests/${mr.iid}`,[],repo.cwd);const obj=JSON.parse(raw);refs=obj.diff_refs||obj.diffRefs;mr.diffRefs=refs;}
  if(!refs)throw new Error('GitLab did not return merge request diff refs.');
  const base=refs.base_sha||refs.baseSha,head=refs.head_sha||refs.headSha;
  if(!base||!head)throw new Error('GitLab did not return base/head commit SHAs for this review.');

  // Reviews use an ordinary workspace-local clone. This is intentionally simpler
  // than a bare repository + linked worktree and gives JDT/Fast Composite a real,
  // self-contained project directory to import.
  const root=this.workspaceReviewRoot();
  const safe=shortRepoKey(repo);
  const cloneDir=path.join(root,'r',safe,String(mr.iid));
  await fs.mkdir(path.dirname(cloneDir),{recursive:true});
  let exists=false;
  try{await fs.access(path.join(cloneDir,'.git'));exists=true;}catch{}
  if(!exists){
   await fs.rm(cloneDir,{recursive:true,force:true}).catch(()=>{});
   // Keep the v0.15.2 clone path deliberately unchanged.  This was the last
   // known-good implementation: glab repo clone into an ordinary workspace-local
   // repository.  The extra lines below are observation only; they do not alter
   // the clone command or its environment.
   this.output.appendLine(`[review-clone] cloning ${repo.host}/${repo.project} -> ${cloneDir}`);
   const cfg=this.vscode.workspace.getConfiguration('gitlabWorkbench');
   const bin=cfg.get('glabPath','glab');
   const cloneArgs=['repo','clone',repo.remote||repo.url||`https://${repo.host}/${repo.project}`,cloneDir,'--','--config','core.longpaths=true'];
   const cloneStarted=Date.now();
   this.output.appendLine(`[review-clone] exec begin bin=${bin} args=${JSON.stringify(cloneArgs)}`);
   try{
    const result=await execFile(bin,cloneArgs,{env:{...process.env,GITLAB_HOST:repo.host,GLAB_NO_PROMPT:'1',GLAB_PROMPT_DISABLED:'1',GIT_TERMINAL_PROMPT:'0'},maxBuffer:20*1024*1024,windowsHide:true,timeout:120000});
    this.output.appendLine(`[review-clone] exec returned after ${Date.now()-cloneStarted}ms stdout=${JSON.stringify((result.stdout||'').trim())} stderr=${JSON.stringify((result.stderr||'').trim())}`);
   }catch(e){
    this.output.appendLine(`[review-clone] exec ERROR after ${Date.now()-cloneStarted}ms code=${e?.code??'<none>'} signal=${e?.signal??'<none>'} killed=${!!e?.killed} stdout=${JSON.stringify((e?.stdout||'').trim())} stderr=${JSON.stringify((e?.stderr||'').trim())}`);
    throw e;
   }
   this.output.appendLine(`[review-clone] clone command complete; validating .git`);
   try{await fs.access(path.join(cloneDir,'.git'));this.output.appendLine('[review-clone] clone validation complete (.git present)');}
   catch(e){this.output.appendLine(`[review-clone] clone validation FAILED: ${cleanError(e)}`);throw e;}
  }else{
   this.output.appendLine(`[review-clone] reusing ${cloneDir}`);
  }

  // Refresh objects, then pin the working tree to the exact MR head. Fetch failure
  // is tolerated only when the required commits are already present locally.
  this.output.appendLine(`[review-clone] fetching ${repo.project}`);
  await this.git(['fetch','--quiet','--prune','origin'],cloneDir).catch(e=>this.output.appendLine(`[review-clone] fetch warning: ${cleanError(e)}`));
  if(!await this.hasObjects(cloneDir,base,head)){
   // Some GitLab MR commits are not reachable from normal branch refs. Ask for the
   // two exact objects as a fallback before failing the review.
   await this.git(['fetch','--quiet','origin',base,head],cloneDir).catch(()=>{});
  }
  if(!await this.hasObjects(cloneDir,base,head))throw new Error(`Review clone does not contain the MR base/head commits (${base.slice(0,8)} / ${head.slice(0,8)}).`);

  const current=await this.git(['rev-parse','HEAD'],cloneDir).then(x=>x.trim()).catch(()=>null);
  if(current!==head){
   this.output.appendLine(`[review-clone] checkout --detach ${head.slice(0,8)}`);
   await this.git(['checkout','--quiet','--detach','--force',head],cloneDir);
  }
  await this.git(['reset','--quiet','--hard',head],cloneDir);
  const session={gitDir:cloneDir,worktree:cloneDir,base,head,source:'workspace review clone',key:`${repo.host}/${repo.project}`.toLowerCase()};
  this.reviewRepos.set(`${mr.repo}!${mr.iid}`,session);
  this.output.appendLine(`[review-clone] ready ${repo.project}!${mr.iid}; base=${base.slice(0,8)} head=${head.slice(0,8)} path=${cloneDir}`);
  return session;
 }
 getReviewSession(mr){return this.reviewRepos.get(`${mr.repo}!${mr.iid}`);}
 async createCompositeReviewRoot(mr){
  this.output.appendLine(`[review-jdt] createCompositeReviewRoot begin project=${mr.repo} !${mr.iid}`);
  const session=this.getReviewSession(mr)||await this.prepareReview(mr);
  this.output.appendLine(`[review-jdt] review session worktree=${session.worktree}`);
  const repo=await this.repo(mr.repo);
  const root=this.workspaceReviewRoot();
  const safe=shortRepoKey(repo);
  const reviewRoot=path.join(root,'c',safe,String(mr.iid));
  await fs.mkdir(reviewRoot,{recursive:true});
  const wt=session.worktree.replace(/\\/g,'/').replace(/'/g,"\\'");
  // Fast Composite JDT only needs a composite settings file that includes the
  // reviewed build. Do not copy or infer the user's normal composite root.
  const body=`// Generated by GitLab Workbench for ${repo.project} !${mr.iid}\nincludeBuild('${wt}')\n`;
  const outPath=path.join(reviewRoot,'settings.gradle');
  await fs.writeFile(outPath,body,'utf8');
  await fs.writeFile(path.join(reviewRoot,'.gitlab-workbench-review.json'),JSON.stringify({mr:mr.iid,project:repo.project,worktree:session.worktree,head:session.head},null,2),'utf8');
  session.compositeRoot=reviewRoot;
  this.output.appendLine(`[review-jdt] generated minimal composite root ${reviewRoot}; includeBuild=${session.worktree}`);
  return {reviewRoot,worktree:session.worktree};
 }
 async hasObjects(gitDir,...shas){for(const sha of shas){try{await this.git(['cat-file','-e',`${sha}^{commit}`],gitDir);}catch{return false;}}return true;}
 async getReviewFileVersions(mr,file){
  const session=this.reviewRepos.get(`${mr.repo}!${mr.iid}`)||await this.prepareReview(mr);
  const info=Array.isArray(file)?(file[3]||{}):(file||{});
  const display=Array.isArray(file)?file[0]:(file.path||file.new_path||file.old_path);
  const oldPath=info.old_path||info.oldPath||display,newPath=info.new_path||info.newPath||display;
  const read=async(ref,p)=>{if(!p)return '';try{return await this.git(['show',`${ref}:${p}`],session.gitDir);}catch{return '';}};
  const [baseText,headText]=await Promise.all([read(session.base,oldPath),read(session.head,newPath)]);
  return {base:baseText,head:headText,source:session.source};
 }
 async checkout(mr){const r=await this.repo(mr.repo);if(!r.cwd)throw new Error('This project is not cloned locally. Clone or associate a local repository before checkout.');await this.run(['mr','checkout',String(mr.iid)],r.cwd);return {message:`Checked out ${r.name}!${mr.iid}`};}
 async approve(mr){
  const r=await this.repo(mr.repo);
  // Use glab's first-class MR approval command rather than calling the REST
  // endpoint ourselves. This preserves glab's own host/auth selection and is
  // the same path users get from `glab mr approve`.
  const repoTarget=`https://${r.host}/${r.project}`;
  this.output.appendLine(`[approve] ${r.project}!${mr.iid} host=${r.host} via=glab-mr-approve`);
  try{await this.run(['mr','approve',String(mr.iid),'--repo',repoTarget],r.cwd);}
  catch(e){this.output.appendLine(`[approve] ERROR ${cleanError(e)}`);throw e;}
  return {message:`Approved ${r.name}!${mr.iid}`};
 }
 async merge(mr){const r=await this.repo(mr.repo);await this.api(r.host,`projects/${encodeURIComponent(r.project)}/merge_requests/${mr.iid}/merge`,['--method','PUT'],r.cwd);return {message:`Merged ${r.name}!${mr.iid}`};}
 async projectPath(mr){const r=await this.repo(mr.repo);return {f:r.cwd,project:r.project,host:r.host};}
 async ensureProject(repo){
  if(repo.project)return repo.project;
  const raw=await this.run(['repo','view','--output','json'],repo.cwd);const obj=JSON.parse(raw||'{}');
  const project=pick(obj,'path_with_namespace','pathWithNamespace','fullPath','nameWithNamespace');
  if(!project)throw new Error('glab did not return the GitLab project path.'); repo.project=project;this.repos.set(repo.id,repo);return project;
 }
 async listDiscussions(mr){
  const {f,project,host}=await this.projectPath(mr);
  const raw=await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/discussions?per_page=100`,[],f);
  const all=JSON.parse(raw)||[];
  return all.filter(d=>d.notes?.some(n=>!n.system)).map(d=>{
   const visible=(d.notes||[]).filter(n=>!n.system);
   const positioned=visible.find(n=>n.position?.new_path||n.position?.old_path);
   const pos=positioned?.position;
   const anchor=visible.find(n=>n.resolvable)||positioned;
   return {id:String(d.id),path:pos?.new_path||pos?.old_path||null,oldPath:pos?.old_path||null,newPath:pos?.new_path||null,line:pos?Number(pos.new_line||pos.old_line||1):null,oldLine:pos?.old_line?Number(pos.old_line):null,newLine:pos?.new_line?Number(pos.new_line):null,side:pos?.new_line?'new':pos?.old_line?'old':null,positionHeadSha:pos?.head_sha||pos?.headSha||null,positionBaseSha:pos?.base_sha||pos?.baseSha||null,resolved:!!anchor?.resolved,resolvable:!!anchor?.resolvable,notes:visible.map(n=>({id:String(n.id),author:n.author?.name||n.author?.username||'Reviewer',body:n.body||'',created:n.created_at||''}))};
  }).filter(d=>d.notes.length);
 }
 async getFileAtRef(mr,pathName,ref){
  if(!pathName||!ref)return '';
  const {f,project,host}=await this.projectPath(mr);
  try{return await this.api(host,`projects/${encodeURIComponent(project)}/repository/files/${encodeURIComponent(pathName)}/raw?ref=${encodeURIComponent(ref)}`,[],f);}
  catch{return '';}
 }
 async addMergeRequestComment(mr,body){const {f,project,host}=await this.projectPath(mr);await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/discussions`,['--method','POST','-f',`body=${body}`],f);return {message:'Merge request comment added'};}
 async replyDiscussion(mr,id,body){const {f,project,host}=await this.projectPath(mr);await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/discussions/${id}/notes`,['--method','POST','-f',`body=${body}`],f);return {message:'Reply posted'};}
 async resolveDiscussion(mr,id,resolved=true){const {f,project,host}=await this.projectPath(mr);await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/discussions/${id}`,['--method','PUT','-f',`resolved=${resolved}`],f);return {message:resolved?'Discussion resolved':'Discussion reopened'};}
 async listDraftNotes(mr){
  const {f,project,host}=await this.projectPath(mr);const raw=await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/draft_notes`,[],f);
  const notes=(JSON.parse(raw||'[]')||[]).map(n=>({id:n.id,body:n.note||n.body||'',path:n.position?.new_path||n.position?.old_path||'',newLine:n.position?.new_line||null,oldLine:n.position?.old_line||null,position:n.position||null}));
  this.output.appendLine(`[review-draft] loaded ${notes.length} pending comment${notes.length===1?'':'s'} for ${repoLabel(mr)} !${mr.iid}`);
  return notes;
 }
 async addDraftReviewComment(mr,file,position,body){
  const {f,project,host}=await this.projectPath(mr),info=Array.isArray(file)?(file[3]||{}):(file||{}),newPath=info.new_path||info.newPath||(Array.isArray(file)?file[0]:file.path),oldPath=info.old_path||info.oldPath||newPath,pos=typeof position==='number'?{newLine:position}:position;
  const session=this.getReviewSession(mr)||await this.prepareReview(mr);const current=JSON.parse(await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}`,[],f)||'{}'),refs=current.diff_refs||{};
  if(refs.head_sha&&session.head&&refs.head_sha!==session.head)throw new Error('This merge request changed after the review diff was opened. Refresh/reopen the review before adding this comment.');
  const positionData={position_type:'text',base_sha:refs.base_sha||session.base,start_sha:refs.start_sha||session.base,head_sha:refs.head_sha||session.head,old_path:oldPath,new_path:newPath};
  if(pos.oldLine)positionData.old_line=Number(pos.oldLine);if(pos.newLine)positionData.new_line=Number(pos.newLine);

  // Important: glab's -f handling accepts these names but, on some glab/GitLab
  // combinations, Rails receives "position[...]" as literal flat keys. GitLab
  // then creates a perfectly valid *general* draft note with position=null.
  // Put the documented nested parameters in the query string instead. Rails
  // reliably decodes bracket notation there into the required position hash.
  const q=new URLSearchParams();q.set('note',body);
  for(const [k,v] of Object.entries(positionData))q.set(`position[${k}]`,String(v));
  const endpoint=`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/draft_notes?${q.toString()}`;
  this.output.appendLine(`[review-draft] POST positioned old=${oldPath}:${pos.oldLine||'-'} new=${newPath}:${pos.newLine||'-'}`);
  let created;
  try{created=JSON.parse(await this.api(host,endpoint,['--method','POST'],f)||'{}');}
  catch(e){this.output.appendLine(`[review-draft] POST ERROR ${cleanError(e)}`);throw e;}

  // Never silently accept an unpositioned draft: that is what caused line
  // comments to become "general" comments after the review was published.
  const rp=created.position;
  if(!rp?.new_path&&!rp?.old_path){
   if(created.id)await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/draft_notes/${created.id}`,['--method','DELETE'],f).catch(()=>{});
   throw new Error('GitLab created the draft without a diff position. The draft was removed instead of allowing it to become a general comment.');
  }
  if(pos.newLine&&!rp.new_line||pos.oldLine&&!rp.old_line){
   if(created.id)await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/draft_notes/${created.id}`,['--method','DELETE'],f).catch(()=>{});
   throw new Error(`GitLab did not preserve the selected diff line (requested old=${pos.oldLine||'-'}, new=${pos.newLine||'-'}). The invalid draft was removed.`);
  }
  this.output.appendLine(`[review-draft] VERIFIED id=${created.id} old=${rp.old_path||'-'}:${rp.old_line||'-'} new=${rp.new_path||'-'}:${rp.new_line||'-'}`);
  return created;
 }
 async submitReview(mr,{summary='',outcome='comment'}={}){
  const {f,project,host}=await this.projectPath(mr),args=['--method','POST'];if(summary)args.push('-f',`note=${summary}`);args.push('-f',`reviewer_state=${outcome==='request_changes'?'requested_changes':'reviewed'}`);
  await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/draft_notes/bulk_publish`,args,f);if(outcome==='approve')await this.approve(mr);
  return {message:outcome==='approve'?'Review submitted and merge request approved.':outcome==='request_changes'?'Review submitted with changes requested.':'Review submitted.'};
 }
 async discardReview(mr){const {f,project,host}=await this.projectPath(mr),drafts=await this.listDraftNotes(mr);for(const d of drafts)await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/draft_notes/${d.id}`,['--method','DELETE'],f);return {message:`Discarded ${drafts.length} pending review comment${drafts.length===1?'':'s'}.`};}
 async postReviewCommentNow(mr,file,position,body){
  const {f,project,host}=await this.projectPath(mr);
  const info=Array.isArray(file)?(file[3]||{}):(file||{});
  const newPath=info.new_path||info.newPath||(Array.isArray(file)?file[0]:file.path);
  const oldPath=info.old_path||info.oldPath||newPath;
  if(!newPath||!oldPath)throw new Error('Could not determine the GitLab old/new paths for this diff.');

  const pos=(typeof position==='number')?{kind:'added',newLine:position}:position;
  if(!pos?.newLine&&!pos?.oldLine)throw new Error('The selected editor line does not map to a GitLab diff position.');

  // A review window is pinned to a specific MR head. If somebody pushes while the
  // review is open, the editor is showing the old diff and GitLab's current diff
  // position may no longer accept those line numbers. Detect that explicitly.
  const session=this.getReviewSession(mr)||await this.prepareReview(mr);
  const currentRaw=await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}`,[],f);
  const current=JSON.parse(currentRaw||'{}');
  const currentRefs=current.diff_refs||current.diffRefs||{};
  const currentHead=currentRefs.head_sha||currentRefs.headSha;
  if(currentHead&&session.head&&currentHead!==session.head){
   throw new Error('This merge request changed after the review diff was opened. Refresh/reopen the review before adding this comment so the line maps to the latest diff.');
  }

  const refs=currentRefs.head_sha?currentRefs:(mr.diffRefs||{});
  const baseSha=refs.base_sha||refs.baseSha||session.base;
  const startSha=refs.start_sha||refs.startSha||baseSha;
  const headSha=refs.head_sha||refs.headSha||session.head;
  if(!baseSha||!startSha||!headSha)throw new Error('GitLab did not return the diff SHAs required for a positioned review comment.');

  // Do NOT use `glab mr note create --line` here. That command only exposes one
  // side of the line position and can reject valid context lines. GitLab's REST
  // API supports the full position object, including BOTH old_line and new_line
  // for unchanged context inside a diff hunk.
  const payload={
   body,
   position:{
    position_type:'text',
    base_sha:baseSha,
    start_sha:startSha,
    head_sha:headSha,
    old_path:oldPath,
    new_path:newPath
   }
  };
  if(pos.oldLine)payload.position.old_line=Number(pos.oldLine);
  if(pos.newLine)payload.position.new_line=Number(pos.newLine);

  const tmpDir=path.join(this.workspaceReviewRoot(),'tmp');
  await fs.mkdir(tmpDir,{recursive:true});
  const tmp=path.join(tmpDir,`review-comment-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
  await fs.writeFile(tmp,JSON.stringify(payload),'utf8');

  this.output.appendLine(`[review-comment] ${repoLabel(mr)} !${mr.iid}`);
  this.output.appendLine(`[review-comment] file old=${oldPath} new=${newPath} new_line=${pos.newLine||'-'} old_line=${pos.oldLine||'-'} kind=${pos.kind||'unknown'}`);
  this.output.appendLine(`[review-comment] refs base=${baseSha.slice(0,8)} start=${startSha.slice(0,8)} head=${headSha.slice(0,8)}`);

  let created;
  try{
   const raw=await this.api(host,`projects/${encodeURIComponent(project)}/merge_requests/${mr.iid}/discussions`,['--method','POST','--input',tmp],f);
   created=JSON.parse(raw||'{}');
  }catch(e){
   this.output.appendLine(`[review-comment] POST ERROR ${cleanError(e)}`);
   throw e;
  }finally{
   await fs.rm(tmp,{force:true}).catch(()=>{});
  }

  const note=(created.notes||[]).find(n=>!n.system&&n.body===body&&n.position);
  if(!note?.position)throw new Error('GitLab created the discussion without a diff position.');
  const rp=note.position;
  this.output.appendLine(`[review-comment] attached old_line=${rp.old_line||'-'} new_line=${rp.new_line||'-'} old_path=${rp.old_path||'-'} new_path=${rp.new_path||'-'}`);
  return created;
 }
 async repo(id){if(this.repos.has(id))return this.repos.get(id);await this.listMergeRequests();const r=this.repos.get(id);if(!r)throw new Error(`GitLab project not found: ${id}`);return r;}
 async git(args,cwd){const {stdout}=await execFile('git',['-c','core.longpaths=true','-C',cwd,...args],{env:{...process.env,GIT_TERMINAL_PROMPT:'0'},windowsHide:true,maxBuffer:2*1024*1024,timeout:60000});return stdout;}
 async gitDir(args,gitDir,timeout=60000){
  try{const {stdout,stderr}=await execFile('git',[`--git-dir=${gitDir}`,...args],{env:{...process.env,GIT_TERMINAL_PROMPT:'0'},windowsHide:true,maxBuffer:4*1024*1024,timeout});if(stderr?.trim())this.output.appendLine(`[git] ${stderr.trim()}`);return stdout;}
  catch(e){if(e.killed||e.signal==='SIGTERM')throw new Error(`Git command timed out after ${Math.round(timeout/1000)}s: git --git-dir=${gitDir} ${args.join(' ')}`);throw e;}
 }
}

function shortRepoKey(repo){
 const base=(repo.project||'repo').split('/').pop().replace(/[^a-z0-9_-]+/gi,'_').slice(0,16)||'repo';
 const hash=crypto.createHash('sha1').update(`${repo.host}/${repo.project}`).digest('hex').slice(0,8);
 return `${base}-${hash}`;
}
function repoLabel(mr){return mr.project||mr.repoName||mr.repo||'project';}

function pick(o,...keys){if(!o)return undefined;for(const k of keys)if(o[k]!==undefined&&o[k]!==null)return o[k];return undefined;}
function person(v){return typeof v==='string'?v:(v&&(v.username||v.name))||'';}
function cleanError(e){return String(e.stderr||e.message||e).trim().split(/\r?\n/).slice(0,3).join(' ');}
function countAdded(diff=''){return String(diff).split(/\r?\n/).filter(l=>l.startsWith('+')&&!l.startsWith('+++')).length;}
function countRemoved(diff=''){return String(diff).split(/\r?\n/).filter(l=>l.startsWith('-')&&!l.startsWith('---')).length;}
async function findGitRepositories(root){
 const found=[]; const skip=new Set(['node_modules','build','out','dist','target','.gradle','.idea','.vscode','.gitlab-workbench','.glw']);
 async function walk(dir,depth){
  if(depth>12)return;
  let entries;try{entries=await fs.readdir(dir,{withFileTypes:true});}catch{return;}
  if(entries.some(e=>e.name==='.git'))found.push(dir);
  for(const e of entries){
   if(!e.isDirectory()||skip.has(e.name)||e.name==='.git')continue;
   await walk(path.join(dir,e.name),depth+1);
  }
 }
 await walk(root,0); return found;
}
function projectFromRemote(remote=''){
 let s=String(remote).trim().replace(/\\/g,'/');
 const scp=s.match(/^[^@]+@[^:]+:(.+)$/); if(scp)s=scp[1];
 else {try{const u=new URL(s);s=u.pathname;}catch{}}
 return s.replace(/^\/+|\/+$/g,'').replace(/\.git$/,'')||'';
}
function parseProjectUrl(value=''){
 let raw=String(value).trim();if(!raw)return null;
 // Normalize identity independently from transport. `url` is a stable HTTPS
 // identity; `remote` preserves exactly what the user supplied for Git clones.
 const ssh=raw.match(/^(?:ssh:\/\/)?([^@\/]+)@([^:\/]+)(?::|\/)(.+)$/i);
 if(ssh){
  const project=ssh[3].replace(/\.git$/i,'').replace(/^\/+|\/+$/g,'');
  if(!ssh[2]||!project)return null;
  return {host:ssh[2],project,url:`https://${ssh[2]}/${project}`,remote:raw,protocol:'ssh',source:'managed'};
 }
 try{
  const u=new URL(raw);const project=u.pathname.replace(/^\/+|\/+$/g,'').replace(/\.git$/i,'');
  if(!u.hostname||!project)return null;
  const protocol=u.protocol==='ssh:'?'ssh':u.protocol.replace(':','').toLowerCase();
  return {host:u.hostname,project,url:`https://${u.host}/${project}`,remote:raw,protocol,source:'managed'};
 }catch{}
 return null;
}
function sameProjectUrl(a,b){const x=parseProjectUrl(a),y=parseProjectUrl(b);return !!x&&!!y&&x.host.toLowerCase()===y.host.toLowerCase()&&x.project.toLowerCase()===y.project.toLowerCase();}


async function firstExisting(paths){for(const p of paths){try{await fs.access(p);return p;}catch{}}return null;}
module.exports={GlabClient,parseProjectUrl,sameProjectUrl};
