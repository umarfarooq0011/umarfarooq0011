const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFile}=require('node:child_process');
const {promisify}=require('node:util');
const execFileAsync=promisify(execFile);
const {collectGithub}=require('./collect-github.cjs');
const {collectGitlab}=require('./collect-gitlab.cjs');
const {renderGithub,renderGitlab,updateReadme}=require('./render-graphs.cjs');
const ROOT=path.resolve(__dirname,'..');
const REPO='repos/umarfarooq0011/umarfarooq0011';
const ALLOWED=new Set([
  'README.md',
  ...['light','dark'].flatMap(theme=>[
    `assets/statistics/automotivedms-contributions-${theme}.svg`,
    `assets/statistics/github-contributions-${theme}.svg`,
    `assets/statistics/repository-languages-${theme}.svg`,
    `assets/statistics/repository-languages-mobile-${theme}.svg`
  ])
]);
function currentDate(now=new Date()){
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Karachi',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
function blobSha(content){
  const bytes=Buffer.from(content,'utf8');
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function changedEntries(files,tree){
  const current=new Map(tree.map(item=>[item.path,item.sha]));
  return Object.entries(files).filter(([name,content])=>{
    if(!ALLOWED.has(name)) throw new Error('Publication attempted outside the graph allowlist');
    if(name.endsWith('.svg')&&(/<script|<foreignObject|\bon\w+\s*=|https?:\/\/(?!www\.w3\.org\/2000\/svg)/i.test(content)||!content.startsWith('<svg '))) throw new Error('Unsafe SVG rejected');
    return current.get(name)!==blobSha(content);
  }).map(([name,content])=>({path:name,mode:'100644',type:'blob',content}));
}
async function ghApi(endpoint,body){
  const env={...process.env,GH_PROMPT_DISABLED:'1',GH_PAGER:'cat'};
  delete env.GH_DEBUG;
  let inputFile;
  const args=['api',endpoint,'--hostname','github.com'];
  if(body){
    const dir=path.join(ROOT,'api-requests');
    fs.mkdirSync(dir,{recursive:true});
    inputFile=path.join(dir,`automation-${process.pid}-${crypto.randomUUID()}.json`);
    fs.writeFileSync(inputFile,JSON.stringify(body));
    args.push('--method',endpoint.includes('/git/refs/')?'PATCH':'POST','--input',inputFile);
  }
  try{
    const gh=process.platform==='win32'?'C:/Program Files/GitHub CLI/gh.exe':'gh';
    const result=await execFileAsync(gh,args,{env,windowsHide:true,timeout:60000,maxBuffer:12*1024*1024});
    return JSON.parse(result.stdout);
  }catch(error){
    const status=String(error.stderr||'').match(/\b(?:HTTP |status )(\d{3})\b/);
    const safe=new Error(`GitHub publication API failed${status?` (HTTP ${status[1]})`:''}`);
    safe.httpStatus=status?Number(status[1]):undefined;
    throw safe;
  }finally{
    if(inputFile&&fs.existsSync(inputFile)) fs.unlinkSync(inputFile);
  }
}
async function publishGraphs(graphFiles,data,api=ghApi){
  if(process.env.GITHUB_ACTIONS==='true'){
    if(process.env.GITHUB_REPOSITORY!=='umarfarooq0011/umarfarooq0011') throw new Error('Unexpected Actions repository; publication stopped');
    const repository=await api(REPO);
    if(repository.full_name!=='umarfarooq0011/umarfarooq0011'||repository.permissions?.push!==true) throw new Error('Actions token cannot publish to the expected profile repository');
  }else{
    const viewer=await api('user');
    if(viewer.login!=='umarfarooq0011') throw new Error('Wrong GitHub account; publication stopped');
  }
  for(let attempt=0;attempt<3;attempt++){
    const ref=await api(`${REPO}/git/ref/heads/main`);
    const parent=await api(`${REPO}/git/commits/${ref.object.sha}`);
    const tree=await api(`${REPO}/git/trees/${parent.tree.sha}?recursive=1`);
    if(tree.truncated) throw new Error('Incomplete remote tree; publication stopped');
    const readmeEntry=tree.tree.find(item=>item.path==='README.md'&&item.type==='blob');
    if(!readmeEntry) throw new Error('Remote README missing; publication stopped');
    const blob=await api(`${REPO}/git/blobs/${readmeEntry.sha}`);
    if(blob.encoding!=='base64') throw new Error('Unexpected README encoding');
    const remoteReadme=Buffer.from(blob.content,'base64').toString('utf8');
    const readme=updateReadme(remoteReadme,data);
    const files={...graphFiles,'README.md':readme};
    const entries=changedEntries(files,tree.tree);
    if(!entries.length) return {published:false,changedPaths:[],readme};
    const newTree=await api(`${REPO}/git/trees`,{base_tree:parent.tree.sha,tree:entries});
    const identity={name:'Profile Graphs Automation',email:'profile-graphs-automation@users.noreply.github.com'};
    const commit=await api(`${REPO}/git/commits`,{
      message:'Refresh profile contribution and language graphs',
      tree:newTree.sha,parents:[ref.object.sha],author:identity,committer:identity
    });
    try{
      await api(`${REPO}/git/refs/heads/main`,{sha:commit.sha,force:false});
    }catch(error){
      if((error.httpStatus===409||error.httpStatus===422)&&attempt<2) continue;
      throw error;
    }
    const verify=await api(`${REPO}/git/ref/heads/main`);
    if(verify.object.sha!==commit.sha) throw new Error('Profile changed during verification; retry on next refresh');
    return {published:true,commit:commit.sha,changedPaths:entries.map(e=>e.path),readme};
  }
  throw new Error('Profile kept changing; retry on next refresh');
}
function acquireLock(){
  const lock=path.join(ROOT,'.refresh-profile.lock');
  const guard=path.join(ROOT,'.refresh-profile.guard');
  const token=crypto.randomUUID();
  function releaseOwned(file){
    if(fs.existsSync(file)&&JSON.parse(fs.readFileSync(file,'utf8')).token===token) fs.unlinkSync(file);
  }
  try{
    const fd=fs.openSync(guard,'wx');
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));
    fs.closeSync(fd);
  }catch(error){
    if(error.code!=='EEXIST') throw error;
    let owner;
    try{owner=JSON.parse(fs.readFileSync(guard,'utf8'));}catch{throw new Error('Unrecognized refresh guard; inspect before removing it');}
    if(!Number.isInteger(owner.pid)||owner.pid<=0) throw new Error('Invalid refresh guard');
    try{process.kill(owner.pid,0);return null;}catch(error){
      if(error.code!=='ESRCH') return null;
      throw new Error('Stale refresh guard; inspect before removing it');
    }
  }
  function create(){
    const fd=fs.openSync(lock,'wx');
    fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token}));
    fs.closeSync(fd);
    return ()=>releaseOwned(lock);
  }
  try{
    try{return create();}catch(error){
      if(error.code!=='EEXIST') throw error;
      let owner;
      try{owner=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw new Error('Unrecognized refresh lock; inspect before removing it');}
      if(!Number.isInteger(owner.pid)||owner.pid<=0) throw new Error('Invalid refresh lock');
      try{process.kill(owner.pid,0);return null;}catch(error){
        if(error.code!=='ESRCH') return null;
      }
      fs.unlinkSync(lock);
      return create();
    }
  }finally{releaseOwned(guard);}
}
async function refresh({publish=false,snapshotDate=currentDate()}={}){
  const release=acquireLock();
  if(!release) return {status:'already-running',published:false};
  try{
    const results=await Promise.allSettled([
      collectGithub({username:'umarfarooq0011',snapshotDate}),
      collectGitlab({projectId:47888297,exactAuthorName:'umar Awan',snapshotDate,expectedUsername:'Umarfarooq1122'})
    ]);
    const data={},files={},errors=[];
    const specs=[
      ['github','github.json',renderGithub],
      ['gitlab','automotivedms-dev-live.json',renderGitlab]
    ];
    for(let i=0;i<results.length;i++){
      const [source,cache,render]=specs[i],result=results[i];
      if(result.status==='rejected'){errors.push(`${source}: collection failed; existing graph retained`);continue;}
      try{
        const rendered=render(result.value);
        const dir=path.join(ROOT,'contribution-data');
        fs.mkdirSync(dir,{recursive:true});
        fs.writeFileSync(path.join(dir,cache),JSON.stringify(result.value,null,2)+'\n');
        data[source]=result.value;
        Object.assign(files,rendered);
      }catch{errors.push(`${source}: data validation failed; existing graph retained`);}
    }
    if(!Object.keys(files).length) throw new Error('Both data sources failed; nothing published');
    let result;
    if(publish){
      result=await publishGraphs(files,data);
    }else{
      const source=fs.readFileSync(path.join(ROOT,'README.md'),'utf8');
      result={published:false,preview:true,changedPaths:Object.keys(files),readme:updateReadme(source,data)};
    }
    for(const [name,content] of Object.entries(files)){
      fs.mkdirSync(path.dirname(path.join(ROOT,name)),{recursive:true});
      fs.writeFileSync(path.join(ROOT,name),content);
    }
    fs.writeFileSync(path.join(ROOT,'README.md'),result.readme);
    const status={
      status:errors.length?'partial':'ok',published:result.published,preview:!!result.preview,
      commit:result.commit,changedPaths:result.changedPaths,
      github:data.github?{contributions:data.github.calendar.totalContributions,languageRepositories:data.github.repositories.languageRepositoryCount}:null,
      gitlab:data.gitlab?{commits:data.gitlab.period_non_merge_commits,activeDays:data.gitlab.active_dates_in_period}:null,
      errors
    };
    fs.writeFileSync(path.join(ROOT,'.refresh-profile-status.json'),JSON.stringify({...status,checkedAt:new Date().toISOString()},null,2)+'\n');
    return status;
  }finally{release();}
}
if(require.main===module){
  const args=process.argv.slice(2);
  if(args.some(arg=>arg!=='--publish')){
    console.error('Only --publish is supported. Without it, a local preview is generated.');
    process.exitCode=1;
  }else refresh({publish:args.includes('--publish')}).then(result=>{
    console.log(JSON.stringify(result));
    if(result.status==='partial') process.exitCode=2;
  }).catch(()=>{console.error('Profile refresh did not complete. Check account authentication, README markers, and the last published commit before retrying.');process.exitCode=1;});
}
module.exports={refresh,publishGraphs,changedEntries,blobSha,currentDate,acquireLock,ALLOWED};
