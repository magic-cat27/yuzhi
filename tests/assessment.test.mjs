import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm,readFile,writeFile } from 'node:fs/promises';
import { normalizeTrace,evidenceChunks,validateAssessment,assessTrace,traceHash,DIMENSIONS } from '../src/process-assessment.mjs';
import { AssessmentService } from '../src/assessment-service.mjs';
import { TraceStore } from '../src/trace-store.mjs';
import { AuthStore } from '../src/auth-store.mjs';
import { createApp } from '../server.mjs';

const root=new URL('..',import.meta.url).pathname;
const event=(id,type,payload,actor='student')=>({id,type,payload,actor,timestamp:'2026-10-16T01:00:00Z'});
const raw=()=>({projectId:'project3',events:[event('event-system','session_started',{files:{'main.c':'int main(){}'}},'system'),event('event-ai-first','ai_response',{text:'你可以记录根颜色与黑高。'},'ai'),event('event-student','chat_user',{text:'我采用你提出的根颜色与黑高，先测试单节点树。'})]});
const episode=()=>({title:'采用 AI 提示并提出验证',event_ids:['event-ai-first','event-student'],student_contribution:'提出单节点测试',ai_help:'AI 先提出状态维度',verification:'只有测试意图，没有运行证据',outcome:'待实际验证',attribution:'assisted'});
const assessment=()=>({episodes:[episode()],hard:Object.fromEntries(Object.keys(DIMENSIONS).map(k=>[k,{score:k==='verification'?null:2,reason:'有部分行为证据，但设计受到 AI 提示影响。',event_ids:['event-student','event-ai-first']}])),soft:{text:'你采用了 AI 提出的状态设计，并提出单节点测试。尚无运行证据；下一步请先写出预期再实际运行。',event_ids:['event-student','event-ai-first']},limitations:['尚无运行证据']});
const model=()=>({calls:[],status:()=>({configured:true,model:'fixture-model'}),async call(messages,options){this.calls.push({messages,options});return {content:JSON.stringify(options.cacheKey.includes(':extract:')?{episodes:[episode()]}:assessment())};}});

test('lossless chunks retain raw event tails and identifiers; duplicate ids rejected',()=>{
  const trace=raw();trace.events.push(event('long-event','code_edited',{before:'旧'.repeat(5000),after:'新'.repeat(5000)+'END'}));
  const chunks=evidenceChunks(trace,2000),parts=chunks.flat().filter(p=>p.id==='long-event');
  assert.ok(parts.length>1);assert.deepEqual(JSON.parse(parts.map(p=>p.payload_part).join('')),trace.events.at(-1).payload);
  assert.ok(chunks.every(c=>Buffer.byteLength(JSON.stringify(c))<2300));
  trace.events.push(trace.events[0]);assert.throws(()=>normalizeTrace(trace),/重复/);
});
test('hard scores use weights, missing evidence remains null, invalid citations and AI-only scores fail',()=>{
  const a=assessment(),r=validateAssessment(a,raw());assert.equal(r.total,null);assert.equal(r.coverageWeight,80);
  a.hard.verification.score=4;assert.equal(validateAssessment(a,raw()).total,60);
  a.hard.planning.score=5;assert.throws(()=>validateAssessment(a,raw()),/0–4/);a.hard.planning.score=2;
  a.hard.planning.event_ids=['event-ai-first'];assert.throws(()=>validateAssessment(a,raw()),/学生行为/);
  a.hard.planning.event_ids=['fabricated'];assert.throws(()=>validateAssessment(a,raw()),/证据引用/);
});
test('legacy experimental traces normalize and empty activity gets no model score or call',async()=>{
  const trace={events:[{event_id:1,role:'student',text:'计划'},{event_id:2,role:'tutor',text:'回复'}]};
  assert.equal(normalizeTrace(trace).events[0].id,'1');assert.equal(normalizeTrace(trace).projectId,'project3');
  const m=model(),r=await assessTrace({raw:{projectId:'project1',events:[event('start-only','session_started',{})]},model:m});
  assert.equal(r.total,null);assert.equal(r.coverageWeight,0);assert.equal(m.calls.length,0);
});
test('pipeline separates extraction and synthesis, attributes help and charges requesting teacher',async()=>{
  const m=model(),progress=[];
  const r=await assessTrace({raw:raw(),problem:'红黑树计数',model:m,ownerId:'teacher-1',jobId:'job-1',onProgress:async p=>progress.push(p)});
  assert.equal(m.calls.length,2);assert.ok(m.calls.every(c=>c.options.ownerId==='teacher-1'&&!c.options.tools));
  assert.equal(r.episodes[0].attribution,'assisted');assert.equal(r.hard.verification.score,null);
  assert.match(m.calls[1].messages[1].content,/event-ai-first/);assert.equal(progress.at(-1).phase,'synthesizing');
  const bad=model();bad.call=async()=>({content:'invalid JSON'});await assert.rejects(assessTrace({raw:raw(),model:bad,jobId:'bad'}),/有效 JSON/);
});
async function fixture(){
  const dir=await mkdtemp('/tmp/yuzhi-assessment-'),traces=new TraceStore(dir+'/traces'),id=crypto.randomUUID(),owner=crypto.randomUUID();
  await seedTrace(traces,id,owner);
  const m=model(),service=new AssessmentService({root,directory:dir+'/assessments',traces,model:m});
  return {dir,traces,id,owner,m,service};
}
async function seedTrace(traces,id,owner){
  const events=raw().events;
  await traces.append(id,{projectId:'project3',studentId:owner,events:[events[0]]},owner);
  await traces.agentEvents(id,owner,[events[1]]);
  await traces.append(id,{projectId:'project3',studentId:owner,events:[events[2]]},owner);
}
test('jobs deduplicate, persist versions and reviews, reject stale/conflicting review and preserve prior result on failure',async()=>{
  const f=await fixture();
  try{
    await Promise.all([f.service.start(f.id,'teacher'),f.service.start(f.id,'teacher')]);await f.service.close();
    let state=await f.service.status(f.id);assert.equal(state.attempts.length,1);assert.equal(state.attempts[0].status,'completed');assert.equal(f.m.calls.length,2);assert.equal(state.attempts[0].source,undefined);
    await f.service.start(f.id,'teacher');assert.equal(f.m.calls.length,2);
    const a=state.attempts[0],input={attemptId:a.id,baseReviewId:null,note:'确认来源归因与证据不足',hard:a.result.hard,soft:a.result.soft};
    state=await f.service.review(f.id,'teacher',input);assert.equal(state.attempts[0].reviews.length,1);
    await assert.rejects(f.service.review(f.id,'teacher',input),/另一位教师/);
    const edited=structuredClone(input);edited.baseReviewId=state.attempts[0].reviews[0].id;edited.hard.planning.score=3;
    await assert.rejects(f.service.review(f.id,'teacher',edited),/同时修改/);
    await f.traces.append(f.id,{projectId:'project3',studentId:f.owner,events:[event('new-event','chat_user',{text:'补充验证'})]},f.owner);
    assert.equal((await f.service.status(f.id)).attempts[0].stale,true);
    await assert.rejects(f.service.review(f.id,'teacher',edited),/轨迹已有变化/);
    f.m.call=async()=>{throw Error('secret-provider-body');};await f.service.start(f.id,'teacher');await f.service.close();
    state=await f.service.status(f.id);assert.equal(state.attempts.length,2);assert.equal(state.attempts[1].status,'failed');assert.ok(!JSON.stringify(state).includes('secret-provider-body'));assert.equal(state.attempts[0].reviews.length,1);
    const file=f.dir+'/assessments/'+f.id+'.json',saved=JSON.parse(await readFile(file,'utf8'));saved.attempts[1].status='running';await writeFile(file,JSON.stringify(saved));
    assert.match((await f.service.status(f.id)).attempts[1].error,/服务重启/);
  }finally{await f.service.close();await rm(f.dir,{recursive:true,force:true});}
});
test('teacher assessment HTTP endpoints require teacher role and CSRF; student trace is unchanged',async()=>{
  const dir=await mkdtemp('/tmp/yuzhi-assessment-http-');let server;
  try{
    const seed=new AuthStore(dir+'/auth'),token=seed.issueSetupToken();seed.close();
    server=createApp({authDirectory:dir+'/auth',traceDirectory:dir+'/traces',agentModel:model(),assessmentModel:model()});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
    const req=async(url,s,body,csrf)=>{const r=await fetch(origin+url,{method:body?'POST':'GET',headers:{Origin:origin,...(s?{Cookie:s.cookie,'X-CSRF-Token':csrf??s.csrf}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
    const credentials=name=>({username:name,name,password:'test-assessment-password-123'});
    const t=await req('/api/auth/setup-teacher',null,{...credentials('teacher'),token}),teacher={cookie:t.cookie,csrf:t.value.csrf};
    const s=await req('/api/auth/register',null,credentials('student')),student={cookie:s.cookie,csrf:s.value.csrf};
    const traces=new TraceStore(dir+'/traces'),id=crypto.randomUUID();await seedTrace(traces,id,s.value.user.id);
    const before=traceHash(await traces.get(id)),url=`/api/teacher/records/${id}/assessment`;
    assert.equal((await req(url)).status,401);assert.equal((await req(url,student)).status,403);assert.equal((await req(url,student,{})).status,403);assert.equal((await req(url,teacher,{},'bad')).status,403);
    assert.equal((await req(url,teacher,{})).status,202);
    let state;for(let i=0;i<100;i++){state=(await req(url,teacher)).value;if(state.attempts[0]?.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(state.attempts[0].status,'completed');assert.equal(state.attempts[0].result.total,null);assert.equal((await req(url+'/export',student)).status,403);
    const a=state.attempts[0];assert.equal((await req(url+'/review',teacher,{attemptId:a.id,baseReviewId:null,hard:a.result.hard,soft:a.result.soft,note:'证据核对完成'})).status,200);
    assert.equal(traceHash(await traces.get(id)),before);
  }finally{if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
