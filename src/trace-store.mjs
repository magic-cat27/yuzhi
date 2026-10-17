import { filesAt } from '../public/trace.js';
import { agentError } from './agent-policy.mjs';
import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
const idPattern = /^[a-zA-Z0-9_-]{8,80}$/;
const eventTypes = new Set(['session_started','baseline_imported','workspace_opened','file_opened','file_created','code_edited','code_saved','chat_user','chat_demo','run_unavailable','terminal_command','project_exported','workspace_left']);
const fail = message => { const error = new Error(message); error.status = 400; throw error; };
export class TraceStore {
  constructor(directory) { this.directory=directory; this.pending=Promise.resolve(); }
  validId(id) { if (!idPattern.test(id)) fail('记录编号无效'); }
  async get(id) { this.validId(id); return JSON.parse(await readFile(path.join(this.directory, id+'.json'),'utf8')); }
  createAttempt(id,project,ownerId) {
    const task=this.pending.then(async()=>{
      try{
        const existing=await this.get(id);
        if(existing.ownerId!==ownerId||existing.projectId!==project.id)throw agentError(403,'作答请求编号已被使用');
        return existing;
      }catch(e){if(e.code!=='ENOENT')throw e;}
      const timestamp=new Date().toISOString();
      return this.writeBatch(id,{projectId:project.id,studentId:ownerId,events:[{id:'start_'+id,type:'session_started',actor:'system',timestamp,payload:{files:{...project.files},messages:[],note:'新的一次作答；之前的作答与轨迹保持独立。'}}]},ownerId);
    });
    this.pending=task.catch(()=>{});return task;
  }
  append(id, input, ownerId) {
    const task=this.pending.then(()=>this.writeBatch(id,input,ownerId));
    this.pending=task.catch(()=>{}); return task;
  }
  async writeBatch(id, input, ownerId) {
    this.validId(id);
    if (!input || !/^project[1-9][0-9]{0,5}$/.test(input.projectId) || !idPattern.test(input.studentId) || !Array.isArray(input.events) || !input.events.length || input.events.length>100) fail('轨迹格式无效');
    for (const e of input.events) {
      if (!e || !idPattern.test(e.id) || !eventTypes.has(e.type) || !['student','system'].includes(e.actor) || !Number.isFinite(Date.parse(e.timestamp)) || !e.payload || typeof e.payload!=='object' || Array.isArray(e.payload)) fail('事件格式无效');
    }
    await mkdir(this.directory,{recursive:true});
    let record;
    try { record=await this.get(id); } catch(e) { if(e.code!=='ENOENT')throw e; }
    if (ownerId && record && record.ownerId!==ownerId) throw Object.assign(new Error('无权修改其他账号或历史演示记录'),{status:403});
    if (record && (record.projectId!==input.projectId || record.studentId!==input.studentId)) fail('记录归属不匹配');
    if (!record && !['session_started','baseline_imported'].includes(input.events[0].type)) fail('记录缺少初始快照');
    if(!record){
      const names=(await readdir(this.directory)).filter(n=>/^[a-zA-Z0-9_-]{8,80}\.json$/.test(n));
      const previous=await Promise.all(names.map(n=>this.get(n.slice(0,-5))));
      const latest=Math.max(0,...previous.filter(r=>(r.ownerId||r.studentId)===(ownerId||input.studentId)&&r.projectId===input.projectId).map(r=>Date.parse(r.createdAt)));
      // Stable numbering even for rapid creation or a wall clock adjustment.
      record={id,projectId:input.projectId,studentId:input.studentId,...(ownerId?{ownerId}:{}),source:ownerId?'account':'local-preview',createdAt:new Date(Math.max(Date.now(),latest+1)).toISOString(),events:[]};
    }
    const known=new Map(record.events.map(e=>[e.id,e]));
    for (const e of input.events) {
      if(known.has(e.id)) {
        const old=known.get(e.id);
        if (old.type!==e.type || old.timestamp!==e.timestamp || old.actor!==e.actor || JSON.stringify(old.payload)!==JSON.stringify(e.payload)) fail('同一事件编号的内容不一致');
        continue;
      }
      if(record.ownerId){
        const files=filesAt(record);
        if(e.type==='code_edited'&&files[e.payload.file]!==e.payload.before)throw agentError(409,'这份作答的服务端文件已变化，请保留本地修改并重新同步，避免覆盖其他窗口的内容');
        if(e.type==='file_created'&&Object.hasOwn(files,e.payload.file))throw agentError(409,'文件已存在，请先同步工作区');
      }
      const event={id:e.id,type:e.type,actor:e.actor,timestamp:e.timestamp,payload:e.payload,sequence:record.events.length+1,receivedAt:new Date().toISOString()};
      record.events.push(event); known.set(event.id,event);
    }
    record.updatedAt=new Date().toISOString();
    const destination=path.join(this.directory,id+'.json');
    await writeFile(destination+'.tmp',JSON.stringify(record),'utf8');
    await rename(destination+'.tmp',destination);
    return {acceptedIds:input.events.map(e=>e.id),eventCount:record.events.length};
  }
  agentEvents(id,ownerId,events,changes=null,origin='agent') {
    const task=this.pending.then(async()=>{
      const record=await this.get(id);
      if(record.ownerId!==ownerId)throw agentError(403,'无权访问此项目');
      if(events.every(e=>record.events.some(old=>old.id===e.id)))return record;
      if(changes){
        const files=filesAt(record);
        for(const change of changes){
          const before=Object.hasOwn(files,change.path)?files[change.path]:null;
          if(before!==change.before)throw agentError(409,'文件已发生变化，请保留当前修改并让 AI 重新生成提案');
        }
      }
      for(const event of events)if(!record.events.some(old=>old.id===event.id))record.events.push({...event,origin,sequence:record.events.length+1,receivedAt:new Date().toISOString()});
      record.updatedAt=new Date().toISOString();
      const destination=path.join(this.directory,id+'.json');
      await writeFile(destination+'.tmp',JSON.stringify(record),'utf8');await rename(destination+'.tmp',destination);
      return record;
    });
    this.pending=task.catch(()=>{});return task;
  }
  async list() {
    await this.pending;
    let names;try{names=await readdir(this.directory);}catch(e){if(e.code==='ENOENT')return [];throw e;}
    const records=await Promise.all(names.filter(n=>/^[a-zA-Z0-9_-]{8,80}\.json$/.test(n)).map(n=>this.get(n.slice(0,-5))));
    const ordinals=new Map(),counts=new Map();
    for(const r of [...records].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))){const key=(r.ownerId||r.studentId)+':'+r.projectId;const n=(counts.get(key)||0)+1;counts.set(key,n);ordinals.set(r.id,n);}
    return records.map(r=>({id:r.id,attemptNumber:ordinals.get(r.id),ownerId:r.ownerId,projectId:r.projectId,studentId:r.studentId,createdAt:r.createdAt,updatedAt:r.updatedAt,source:r.source,eventCount:r.events.length,edits:r.events.filter(e=>e.type==='code_edited').length,aiEdits:r.events.filter(e=>e.type==='ai_changes_applied').length,messages:r.events.filter(e=>e.type==='chat_user').length,runs:r.events.filter(e=>e.type==='run_unavailable').length,imported:r.events[0]?.type==='baseline_imported'})).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  }
}
