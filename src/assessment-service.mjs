import { mkdir,readFile,writeFile,rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { agentError } from './agent-policy.mjs';
import { assessTrace,traceHash,normalizeTrace,validateAssessment,RUBRIC_VERSION,DIMENSIONS } from './process-assessment.mjs';

export class AssessmentService {
  constructor({root,directory,traces,model}){this.root=root;this.directory=directory;this.traces=traces;this.model=model;this.jobs=new Map();this.locks=new Map();this.queue=Promise.resolve();}
  serial(id,fn){const task=(this.locks.get(id)||Promise.resolve()).then(fn);this.locks.set(id,task.catch(()=>{}));return task;}
  file(id){this.traces.validId(id);return path.join(this.directory,id+'.json');}
  async load(id){try{return JSON.parse(await readFile(this.file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return {attempts:[]};throw e;}}
  async save(id,data){await mkdir(this.directory,{recursive:true,mode:0o700});const file=this.file(id),tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(data),{mode:0o600});await rename(tmp,file);}
  async recover(id,data){
    let changed=false;
    for(const a of data.attempts)if(['queued','running'].includes(a.status)&&!this.jobs.has(a.id)){a.status='failed';a.error='评价任务被服务重启中断，请重新生成；旧结果仍保留。';changed=true;}
    if(changed)await this.save(id,data);
    return data;
  }
  async status(id){return this.serial(id,async()=>{
    const raw=await this.traces.get(id),data=await this.recover(id,await this.load(id)),hash=traceHash(raw);
    return {dimensions:DIMENSIONS,sourceHash:hash,attempts:data.attempts.map(({source,...a})=>({...a,stale:a.sourceHash!==hash}))};
  });}
  async start(id,teacherId,{regenerate=false}={}){
    if(typeof regenerate!=='boolean')throw agentError(400,'重新生成参数无效');
    await this.serial(id,async()=>{
      const raw=await this.traces.get(id),data=await this.recover(id,await this.load(id)),hash=traceHash(raw);
      if(data.attempts.some(a=>['queued','running'].includes(a.status)))return;
      if(!regenerate&&data.attempts.some(a=>a.status==='completed'&&a.sourceHash===hash&&a.rubricVersion===RUBRIC_VERSION))return;
      if(data.attempts.length>=100)throw agentError(409,'本作答已达到 100 次评价上限，请保留现有评价并联系管理员');
      const source=normalizeTrace(raw),a={id:randomUUID(),status:'queued',createdAt:new Date().toISOString(),teacherId,sourceHash:hash,sourceEventCount:source.events.length,source,projectId:source.projectId,rubricVersion:RUBRIC_VERSION,model:this.model.status().model,progress:{phase:'queued',done:0,total:0},reviews:[]};
      data.attempts.push(a);
      await this.save(id,data);
      const task=this.queue.then(()=>this.run(id,a,teacherId));
      this.jobs.set(a.id,task);this.queue=task.catch(()=>{});
      task.finally(()=>this.jobs.delete(a.id)).catch(()=>{});
    });
    return this.status(id);
  }
  async update(id,jobId,patch){return this.serial(id,async()=>{const data=await this.load(id),a=data.attempts.find(a=>a.id===jobId);Object.assign(a,patch);await this.save(id,data);});}
  async run(id,a,teacherId){
    try{
      await this.update(id,a.id,{status:'running'});
      const problem=this.catalog?(await this.catalog.get(a.projectId)).problem:await readFile(path.join(this.root,'problem',a.projectId+'.txt'),'utf8');
      const result=await assessTrace({raw:a.source,problem,model:this.model,ownerId:teacherId,jobId:a.id,onProgress:progress=>this.update(id,a.id,{progress})});
      await this.update(id,a.id,{status:'completed',result,completedAt:new Date().toISOString(),progress:{phase:'completed'}});
    }catch(e){await this.update(id,a.id,{status:'failed',error:e.status?e.message:'评价处理失败，请重试；原始轨迹与旧结果仍保留。',completedAt:new Date().toISOString()});}
  }
  async review(id,teacherId,input){
    await this.serial(id,async()=>{
      const raw=await this.traces.get(id),data=await this.load(id),a=data.attempts.find(a=>a.id===input.attemptId);
      if(!a||a.status!=='completed')throw agentError(409,'请选择已完成的评价');
      if(a.sourceHash!==traceHash(raw))throw agentError(409,'轨迹已有变化，请重新评价后复核');
      const latest=a.reviews.at(-1)?.id||null;
      if(input.baseReviewId!==latest)throw agentError(409,'另一位教师已更新复核，请刷新后再保存');
      if(typeof input.note!=='string'||!input.note.trim()||input.note.length>3000)throw agentError(400,'请填写复核说明（最多 3000 字）');
      const base=a.reviews.at(-1)?.result||a.result;
      let result;
      try{result=validateAssessment({...base,hard:input.hard,soft:input.soft},a.source);}catch(e){throw agentError(400,e.message);}
      for(const key of Object.keys(DIMENSIONS))if(result.hard[key].score!==base.hard[key].score&&result.hard[key].reason===base.hard[key].reason)throw agentError(400,'修改分数时请同时修改该维度的理由，并核对软评价');
      a.reviews.push({id:randomUUID(),teacherId,createdAt:new Date().toISOString(),note:input.note.trim(),result});
      await this.save(id,data);
    });
    return this.status(id);
  }
  async close(){await this.queue;}
}
