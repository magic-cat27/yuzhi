import {projectDatasets} from './project-datasets.mjs';
import {mkdir,readFile,writeFile,rename,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {ExecutionSandbox} from './execution-sandbox.mjs';
import {filesAt} from '../public/trace.js';
import {agentError,hashText,validFile} from './agent-policy.mjs';
const MAX_SNAPSHOT=2*1024*1024;
const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function prepareRun(files,input){
  if(!files||Object.keys(files).length>200)throw agentError(413,'项目最多支持 200 个文件');
  let size=0;
  for(const [name,value] of Object.entries(files)){
    if(!validFile(name)||typeof value!=='string'||['artifacts','artifacts/'].some(p=>name===p||name.startsWith('artifacts/')))throw agentError(400,'项目文件路径无效；artifacts 目录专用于运行产物');
    size+=Buffer.byteLength(value);
  }
  if(size>MAX_SNAPSHOT)throw agentError(413,'本次源码快照超过 2 MB');
  if(typeof input.stdin!=='undefined'&&(typeof input.stdin!=='string'||Buffer.byteLength(input.stdin)>65536))throw agentError(400,'标准输入最多 64 KB');
  const timeout=input.timeout??60;if(!Number.isInteger(timeout)||timeout<1||timeout>60)throw agentError(400,'运行时间应为 1–60 秒');
  let command;
  if(input.mode==='c'){
    if(files['CMakeLists.txt'])command='cmake -S . -B /tmp/build && cmake --build /tmp/build -j2 && /tmp/build/main';
    else{
      const sources=Object.keys(files).filter(f=>f.endsWith('.c'));if(!sources.length)throw agentError(400,'项目中没有 C 源文件');
      command=`gcc -std=c11 -Wall -Wextra -O2 -I include ${sources.map(quote).join(' ')} -lm -o /tmp/main && /tmp/main`;
    }
  }else if(input.mode==='python'){
    if(!validFile(input.file)||!input.file.endsWith('.py')||!Object.hasOwn(files,input.file))throw agentError(400,'请先打开要运行的 Python 文件');
    command='python3 '+quote(input.file);
  }else if(input.mode==='command'){
    if(typeof input.command!=='string'||!input.command.trim()||input.command.length>4000||input.command.includes('\0'))throw agentError(400,'请输入 1–4000 字的命令');
    command=input.command.trim();
  }else throw agentError(400,'运行方式无效');
  return {command,stdin:input.stdin||'',timeout,files,inputs:[]};
}
export class ExecutionService{
  constructor({root,directory,traces,sandbox}){this.root=root;this.directory=directory;this.traces=traces;this.sandbox=sandbox||new ExecutionSandbox(root);this.index=null;this.indexLoad=null;this.jobs=new Map();this.liveRuns=new Set();this.recoveries=new Map();this.activeOwners=new Set();}
  async save(run){
    await mkdir(this.directory,{recursive:true,mode:0o700});
    const {files,...metadata}=run;
    if(files){
      const snapshots=path.join(this.directory,'snapshots');await mkdir(snapshots,{recursive:true,mode:0o700});
      await writeFile(path.join(snapshots,run.id+'.json'),JSON.stringify(files),{mode:0o600,flag:'wx'}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    }
    const file=path.join(this.directory,run.id+'.json');await writeFile(file+'.tmp',JSON.stringify(metadata),{mode:0o600});await rename(file+'.tmp',file);
    this.index?.set(run.id,metadata);
  }
  async source(id,user){const run=await this.authorized(id,user);return run.files||JSON.parse(await readFile(path.join(this.directory,'snapshots',id+'.json'),'utf8'));}

  async read(id){if(!validId(id))throw agentError(400,'运行编号无效');return JSON.parse(await readFile(path.join(this.directory,id+'.json'),'utf8'));}
  async authorized(id,user){const run=await this.read(id);if(run.ownerId!==user.id&&user.role!=='teacher')throw agentError(403,'无权访问这次运行');return run;}
  async records(){
    if(!this.index){
      this.index=new Map();
      this.indexLoad=(async()=>{let names;try{names=await readdir(this.directory);}catch(e){if(e.code==='ENOENT')return;throw e;}
        for(const name of names.filter(n=>/^[a-f0-9-]{36}\.json$/.test(n))){const run=await this.read(name.slice(0,-5));if(!this.index.has(run.id))this.index.set(run.id,run);}
      })();
    }
    await this.indexLoad;return [...this.index.values()];
  }

  publicRun(run){const {files,inputs,...view}=run;return view;}
  async list(traceId,user){const record=await this.traces.get(traceId);if(record.ownerId!==user.id&&user.role!=='teacher')throw agentError(403,'无权查看运行');return (await this.records()).filter(r=>r.traceId===traceId).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)).slice(0,20).map(r=>this.publicRun(r));}
  async get(id,user){
    let run=await this.authorized(id,user);
    if(run.status==='running'&&!this.liveRuns.has(id)){
      if(!this.recoveries.has(id))this.recoveries.set(id,(async()=>{run={...run,status:'interrupted',reason:'server_restart',finishedAt:new Date().toISOString(),stderr:'服务重启中断了本次运行，请重新运行。'};await this.save(run);await this.finishEvent(run);return run;})());
      run=await this.recoveries.get(id);
    }
    return this.publicRun(run);
  }

  async artifact(id,artifactId,user){const run=await this.authorized(id,user),item=run.artifacts?.find(a=>a.id===artifactId);if(!item)throw agentError(404,'运行产物不存在');return {item,data:await readFile(path.join(this.directory,'artifacts',item.id))};}
  async start(traceId,ownerId,input,actor='student',requestKey=null){
    const record=await this.traces.get(traceId);if(record.ownerId!==ownerId)throw agentError(403,'无权运行其他账号的项目');
    if(requestKey){const old=(await this.records()).find(r=>r.ownerId===ownerId&&r.traceId===traceId&&r.requestKey===requestKey);if(old)return this.get(old.id,{id:ownerId});}
    if(this.activeOwners.has(ownerId))throw agentError(409,'你已有一个运行任务，请等待完成或停止');
    if(this.activeOwners.size>=2)throw agentError(429,'两个运行位置都在使用中，请稍后再试');
    const request=prepareRun(filesAt(record),input),id=randomUUID();request.projectId=record.projectId;this.activeOwners.add(ownerId);this.liveRuns.add(id);
    try{
      const health=await this.sandbox.health();if(!health.available)throw agentError(503,health.message);
      const all=(await this.records()).filter(r=>r.ownerId===ownerId);
      if(all.length>=200)throw agentError(429,'此测试账号已达到 200 次运行记录上限，请联系教师归档');
      let prior;
      if(input.inputRunId){prior=await this.authorized(input.inputRunId,{id:ownerId});if(prior.traceId!==traceId)throw agentError(400,'输入产物必须来自当前项目');}
      else prior=all.filter(r=>r.traceId===traceId&&r.status!=='running'&&r.artifacts?.length).sort((a,b)=>b.startedAt.localeCompare(a.startedAt))[0];
      if(prior)for(const item of prior.artifacts)request.inputs.push({name:item.name,data:(await this.artifact(prior.id,item.id,{id:ownerId})).data.toString('base64')});
      const datasets=await projectDatasets(this.root,record.projectId);
      const run={id,traceId,ownerId,actor,requestKey,datasets:datasets?.files||[],mode:input.mode,command:request.command,stdin:request.stdin,timeout:request.timeout,sourceSequence:record.events.at(-1)?.sequence||0,sourceHash:hashText(JSON.stringify(request.files)),files:request.files,inputRunId:prior?.id||null,status:'running',startedAt:new Date().toISOString(),stdout:'',stderr:'',artifacts:[]};
      await this.save(run);
      await this.traces.agentEvents(traceId,ownerId,[{id:'run_'+id+'_start',type:'execution_started',actor,timestamp:run.startedAt,payload:{runId:id,command:run.command,stdin:run.stdin,sourceSequence:run.sourceSequence,sourceHash:run.sourceHash,inputRunId:run.inputRunId}}],null,'runner');
      const controller=new AbortController();
      const promise=this.perform(run,request,controller.signal,all).finally(()=>{this.jobs.delete(id);this.liveRuns.delete(id);this.activeOwners.delete(ownerId);});
      promise.catch(()=>{});this.jobs.set(id,{promise,controller});return this.publicRun(run);
    }catch(error){this.liveRuns.delete(id);this.activeOwners.delete(ownerId);throw error;}
  }
  async perform(run,request,signal,all){
    try{
      const result=await this.sandbox.execute(request,signal);
      run.finishedAt=new Date().toISOString();run.durationMs=Date.parse(run.finishedAt)-Date.parse(run.startedAt);
      run.stdout=String(result.stdout||'').slice(0,131072);run.stderr=String(result.stderr||'').slice(0,131072);run.exitCode=result.exitCode;run.reason=result.reason||null;
      run.status=result.reason==='cancelled'?'cancelled':result.reason==='timeout'?'timeout':result.reason?'error':result.exitCode===0?'succeeded':'failed';
      let stored=all.reduce((n,r)=>n+(r.artifacts||[]).reduce((s,a)=>s+a.size,0),0),bytes=0;
      await mkdir(path.join(this.directory,'artifacts'),{recursive:true,mode:0o700});
      for(const a of result.artifacts.slice(0,20)){
        if(!validFile(a.name)||a.name.length>160||typeof a.data!=='string'||a.data.length>2800000)continue;
        const data=Buffer.from(a.data,'base64');if(data.length>2097152||bytes+data.length>4194304||stored+data.length>67108864){run.stderr+='\n部分产物超过保存额度，未保留。';continue;}
        const ext=path.extname(a.name).toLowerCase();let mime={'.csv':'text/csv','.txt':'text/plain','.json':'application/json','.pdf':'application/pdf','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg'}[ext];if(!mime)continue;
        if(mime==='image/png'&&!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))mime='application/octet-stream';
        if(mime==='image/jpeg'&&!(data[0]===255&&data[1]===216&&data[2]===255))mime='application/octet-stream';
        const item={id:randomUUID(),name:a.name,size:data.length,mime,sha256:hashText(data)};await writeFile(path.join(this.directory,'artifacts',item.id),data,{mode:0o600});run.artifacts.push(item);bytes+=data.length;stored+=data.length;
      }
      if(result.skipped)run.stderr+='\n部分产物超过单次保存限制，未保留。';
    }catch{run.status='error';run.reason='execution_service_error';run.stderr='运行服务未能完成，源码快照已保留。';run.finishedAt=new Date().toISOString();}
    await this.save(run);await this.finishEvent(run);return this.publicRun(run);
  }
  async finishEvent(run){await this.traces.agentEvents(run.traceId,run.ownerId,[{id:'run_'+run.id+'_finish',type:'execution_finished',actor:run.actor,timestamp:run.finishedAt,payload:{runId:run.id,command:run.command,status:run.status,exitCode:run.exitCode??null,reason:run.reason,durationMs:run.durationMs,stdout:run.stdout,stderr:run.stderr,sourceSequence:run.sourceSequence,sourceHash:run.sourceHash,artifacts:run.artifacts}}],null,'runner');}
  async cancel(id,ownerId){await this.authorized(id,{id:ownerId});this.jobs.get(id)?.controller.abort();return {ok:true};}
  async wait(id,user){const job=this.jobs.get(id);if(job)await job.promise;return this.get(id,user);}
  close(){for(const job of this.jobs.values())job.controller.abort();}
}
