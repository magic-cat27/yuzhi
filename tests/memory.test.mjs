import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {TraceStore} from '../src/trace-store.mjs';
import {AssessmentService} from '../src/assessment-service.mjs';
import {normalizeTrace,traceHash} from '../src/process-assessment.mjs';
import {StudentMemory} from '../src/student-memory.mjs';
import {AgentRuntime} from '../src/agent-runtime.mjs';
import {AuthStore} from '../src/auth-store.mjs';
import {createApp} from '../server.mjs';
const root=new URL('..',import.meta.url).pathname;
const item=()=>({type:'support',topic:'黑高与边界验证',observation:'在红黑树任务中，经提示后提出单节点测试，尚无运行证据。',assistance:'AI 提出了黑高定义，学生随后提出测试。',suggestion:'请学生先预测边界输入的结果。',nextCheck:'能否解释新案例并完成验证。',eventIds:['event-student','event-ai-help'],supersedes:[]});
const model=()=>({calls:[],status:()=>({model:'test-model'}),async call(messages,options){this.calls.push({messages,options});return {content:JSON.stringify({items:[item()],limitations:['单次任务观察，仍需后续核验']})};}});
async function seed(traces,assessments,owner,id=randomUUID()){
 const timestamp=new Date().toISOString();
 await traces.append(id,{projectId:'project3',studentId:owner,events:[{id:'event-start',actor:'system',type:'session_started',timestamp,payload:{files:{'src/main.c':'int main(){}'}}}]},owner);
 await traces.agentEvents(id,owner,[{id:'event-ai-help',actor:'ai',type:'ai_response',timestamp,payload:{text:'请注意黑高定义。'}}]);
 await traces.append(id,{projectId:'project3',studentId:owner,events:[{id:'event-student',actor:'student',type:'chat_user',timestamp,payload:{text:'我采用黑高定义，先预测单节点树的输出再运行。'}}]},owner);
 const raw=await traces.get(id),a={id:randomUUID(),status:'completed',reviews:[],createdAt:timestamp,source:normalizeTrace(raw),sourceHash:traceHash(raw),sourceEventCount:3,projectId:'project3',result:{soft:{text:'提出测试，待验证',event_ids:['event-student','event-ai-help']},episodes:[],hard:{planning:{score:2,reason:'提出测试',event_ids:['event-student']}}}};
 await assessments.save(id,{attempts:[a]});return {id,a};
}
async function fixture(){const dir=await mkdtemp('/tmp/yuzhi-memory-'),traces=new TraceStore(dir+'/traces'),m=model(),assessments=new AssessmentService({root,directory:dir+'/assessments',traces,model:m}),owner=randomUUID(),source=await seed(traces,assessments,owner),memory=new StudentMemory({directory:dir+'/memory',traces,assessments,model:m});return {dir,traces,m,assessments,owner,...source,memory};}
const finish=async f=>{await f.memory.queue;};
const approve=(i,extra={})=>({...i,action:'approve',note:'已核对原始证据',...extra});

test('memory candidates are evidence-backed, deduplicated and isolated; only teacher-confirmed items are recalled',async()=>{
 const f=await fixture();try{
  await Promise.all([f.memory.generate(f.owner,f.id,'teacher'),f.memory.generate(f.owner,f.id,'teacher')]);await finish(f);
  let state=await f.memory.status(f.owner);assert.equal(state.items.length,1);assert.equal(f.m.calls.length,1);assert.equal(f.m.calls[0].options.ownerId,'teacher');assert.equal(f.m.calls[0].options.tools,undefined);
  assert.deepEqual(await f.memory.retrieve(f.owner,'project3','黑高'),[]);
  let i=state.items[0];await f.memory.review(f.owner,i.id,'teacher',approve(i));
  const recalled=await f.memory.retrieve(f.owner,'project3','黑高');assert.equal(recalled.length,1);assert.match(recalled[0].assistance,/AI/);
  assert.deepEqual(await f.memory.retrieve(randomUUID(),'project3','黑高'),[]);
  await assert.rejects(f.memory.generate(randomUUID(),f.id,'teacher'),/不属于/);
  await assert.rejects(f.memory.review(f.owner,i.id,'teacher',approve(i)),/已被更新/);
  i=(await f.memory.status(f.owner)).items[0];await f.memory.review(f.owner,i.id,'teacher',{version:i.version,action:'disable',note:'暂不适用'});
  assert.deepEqual(await f.memory.retrieve(f.owner,'project3','黑高'),[]);assert.equal((await f.memory.status(f.owner)).items[0].history.length,2);
 }finally{await f.memory.close();await rm(f.dir,{recursive:true,force:true});}
});

test('source review changes invalidate memory; continued student activity preserves historical observations',async()=>{
 const f=await fixture();try{
  await f.memory.generate(f.owner,f.id,'teacher');await finish(f);let i=(await f.memory.status(f.owner)).items[0];await f.memory.review(f.owner,i.id,'teacher',approve(i));
  await f.traces.append(f.id,{projectId:'project3',studentId:f.owner,events:[{id:'event-new-data',actor:'student',type:'chat_user',timestamp:new Date().toISOString(),payload:{text:'新的问题'}}]},f.owner);
  assert.equal((await f.memory.retrieve(f.owner,'project3','黑高')).length,1);
  f.a.reviews.push({id:randomUUID(),result:f.a.result});await f.assessments.save(f.id,{attempts:[f.a]});
  assert.equal((await f.memory.status(f.owner)).items[0].sourceChanged,true);assert.deepEqual(await f.memory.retrieve(f.owner,'project3','黑高'),[]);
  i=(await f.memory.status(f.owner)).items[0];await assert.rejects(f.memory.review(f.owner,i.id,'teacher',approve(i)),/已修订/);
  await f.memory.generate(f.owner,f.id,'teacher');await finish(f);assert.equal((await f.memory.status(f.owner)).items.length,2);
 }finally{await f.memory.close();await rm(f.dir,{recursive:true,force:true});}
});

test('new evidence can supersede a confirmed memory while preserving history; unrelated source IDs are rejected',async()=>{
 const f=await fixture();try{
  await f.memory.generate(f.owner,f.id,'teacher');await finish(f);const old=(await f.memory.status(f.owner)).items[0];await f.memory.review(f.owner,old.id,'teacher',approve(old));
  const next=await seed(f.traces,f.assessments,f.owner);f.m.call=async()=>({content:JSON.stringify({items:[{...item(),observation:'在新任务中独立提出边界测试，仍需检验迁移。',supersedes:[old.id]}],limitations:[]})});
  await f.memory.generate(f.owner,next.id,'teacher');await finish(f);const newer=(await f.memory.status(f.owner)).items.find(i=>i.traceId===next.id);await f.memory.review(f.owner,newer.id,'teacher',approve(newer));
  assert.equal((await f.memory.status(f.owner)).items.find(i=>i.id===old.id).status,'superseded');assert.equal((await f.memory.retrieve(f.owner,'project3','黑高')).length,1);
  const invalid=await seed(f.traces,f.assessments,f.owner);f.m.call=async()=>({content:JSON.stringify({items:[{...item(),eventIds:['invented-id']}],limitations:[]})});await f.memory.generate(f.owner,invalid.id,'teacher');await finish(f);assert.equal((await f.memory.status(f.owner)).batches[0].status,'failed');
 }finally{await f.memory.close();await rm(f.dir,{recursive:true,force:true});}
});

test('memory survives restart and enters tutor context with provenance, never as a system instruction',async()=>{
 const f=await fixture();let runtime;try{
  await f.memory.generate(f.owner,f.id,'teacher');await finish(f);const i=(await f.memory.status(f.owner)).items[0];await f.memory.review(f.owner,i.id,'teacher',approve(i));await f.memory.close();
  f.memory=new StudentMemory({directory:f.dir+'/memory',traces:f.traces,assessments:f.assessments,model:f.m});
  const requests=[],tutor={status:()=>({model:'fake'}),call:async(messages)=>{requests.push(messages);return {role:'assistant',content:'请预测一个边界输入的结果。'};}};
  runtime=new AgentRuntime({root,traces:f.traces,directory:f.dir+'/agent',model:tutor});runtime.memories=f.memory;
  const state={runId:randomUUID(),messageId:'event-student',messages:[{role:'user',content:'黑高怎么验证？'}],steps:0,summary:''};
  await runtime.respond(state,runtime.config(f.id,f.owner));
  const memory=requests[0].find(m=>m.content?.includes('"observation"'));assert.equal(memory.role,'user');assert.match(memory.content,/event-student/);
  const audit=runtime.db.prepare("SELECT content FROM agent_history").all().map(r=>JSON.parse(r.content));assert.ok(audit.some(v=>v.kind==='student_memory_context'));
  const active=(await f.memory.status(f.owner)).items[0];await f.memory.review(f.owner,active.id,'teacher',{action:'disable',version:active.version,note:'停止使用'});
  await runtime.respond({...state,runId:randomUUID()},runtime.config(f.id,f.owner));assert.ok(!requests[1].some(m=>m.content?.includes('"observation"')));
 }finally{runtime?.close();await f.memory.close();await rm(f.dir,{recursive:true,force:true});}
});

test('memory HTTP API rejects students and CSRF failures, supports teacher review and export',async()=>{
 const dir=await mkdtemp('/tmp/yuzhi-memory-http-');let server;
 try{
  const auth=new AuthStore(dir+'/auth'),teacher=await auth.register({username:'teacher',name:'老师',password:'test-password-123',token:auth.issueSetupToken()},true),student=await auth.register({username:'student',name:'学生',password:'test-password-123'}),ts=auth.createSession(teacher),ss=auth.createSession(student);auth.close();
  const traces=new TraceStore(dir+'/traces'),m=model(),assessments=new AssessmentService({root,directory:dir+'/assessments',traces,model:m}),{id}=await seed(traces,assessments,student.id);
  server=createApp({authDirectory:dir+'/auth',traceDirectory:dir+'/traces',agentModel:m,memoryModel:m});await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,base=`/api/teacher/students/${student.id}/memory`;
  const req=async(route,session,body,csrf)=>{const r=await fetch(origin+route,{method:body?'POST':'GET',headers:{Origin:origin,...(session?{Cookie:'yuzhi_session='+session.token,'X-CSRF-Token':csrf??session.csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
  assert.equal((await req(base,null)).status,401);assert.equal((await req(base,ss)).status,403);assert.equal((await req(base,ss,{traceId:id})).status,403);assert.equal((await req(base,ts,{traceId:id},'bad')).status,403);
  assert.equal((await req(base,ts,{traceId:id})).status,202);
  let state;for(let n=0;n<100;n++){state=(await req(base,ts)).data;if(state.items.length)break;await new Promise(r=>setTimeout(r,10));}
  const i=state.items[0];assert.ok(i);assert.equal((await req(base+'/'+i.id,ts,approve(i))).status,200);assert.equal((await req(base+'/export',ts)).data.items[0].status,'active');assert.equal((await req(base+'/export',ss)).status,403);
  const records=(await req('/api/teacher/records?view=assessments',ts)).data;assert.equal(records[0].assessment.status,'completed');
 }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
