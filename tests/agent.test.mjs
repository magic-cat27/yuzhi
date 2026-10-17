import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { AgentRuntime } from '../src/agent-runtime.mjs';
import { ExecutionService } from '../src/execution-service.mjs';
import { TraceStore } from '../src/trace-store.mjs';
import { projectPolicy,hashText,validFile } from '../src/agent-policy.mjs';
import { filesAt } from '../public/trace.js';
const root=new URL('..',import.meta.url).pathname;
const ev=(type,payload,actor='student')=>({id:crypto.randomUUID(),timestamp:new Date().toISOString(),type,payload,actor});
async function fixture(model,contextBytes){
  const directory=await mkdtemp('/tmp/yuzhi-agent-test-'),traces=new TraceStore(directory+'/traces');
  const id=crypto.randomUUID(),owner=crypto.randomUUID(),plan=ev('chat_user',{text:'先实现输入输出模块：读取一个整数 n，再用 printf 输出 n，main 返回 0。',file:'src/main.c'});
  await traces.append(id,{studentId:owner,projectId:'project3',events:[ev('session_started',{files:{'src/main.c':'int main(void) { return 0; }'},messages:[]},'system'),plan]},owner);
  const options={root,directory:directory+'/agent',traces,model,contextBytes};
  return {directory,traces,id,owner,plan,options,runtime:new AgentRuntime(options)};
}
const status=()=>({configured:true,model:'test-only'});
async function idle(f){await f.runtime.jobs.get(f.id);return f.runtime.status(f.id,f.owner);}
function proposalModel(getPlan){return {status,async call(messages){
  assert.match(messages[0].content,/【重点1】状态设计/);
  assert.ok(!messages[0].content.includes('[在此填入本实验的重点模块/任务]'));
  const plan=getPlan();return {role:'assistant',content:'已准备文件改动，请确认。',tool_calls:[{id:'call_1',type:'function',function:{name:'propose_changes',arguments:JSON.stringify({summary:'按你的输入输出规划修改主程序，并创建说明文件',plan_message_id:plan.id,plan_quote:plan.payload.text,changes:[{path:'src/main.c',base_hash:hashText('int main(void) { return 0; }'),content:'#include <stdio.h>\nint main(void) { int n; scanf("%d", &n); printf("%d", n); return 0; }'},{path:'tests/note.txt',base_hash:'new',content:'待学生运行测试'}]})}}]};}};}
test('approval survives restart; only owner can approve; applies exact files once with AI provenance',async()=>{
  let f;f=await fixture(proposalModel(()=>f.plan));
  try{
    await f.runtime.start(f.id,f.owner,f.plan.id);let state=await idle(f);
    assert.equal(state.status,'approval');assert.equal(filesAt(await f.traces.get(f.id))['tests/note.txt'],undefined);
    const proposal=state.proposal;
    await assert.rejects(f.runtime.decide(f.id,crypto.randomUUID(),proposal.id,true),/无权/);
    await assert.rejects(f.runtime.decide(f.id,f.owner,'wrong-id',true),/失效/);
    f.runtime.close();f.runtime=new AgentRuntime(f.options);
    state=await f.runtime.status(f.id,f.owner);assert.equal(state.proposal.id,proposal.id);
    await f.runtime.decide(f.id,f.owner,proposal.id,true);state=await idle(f);assert.equal(state.status,'idle');
    const record=await f.traces.get(f.id);assert.equal(filesAt(record)['tests/note.txt'],'待学生运行测试');
    assert.equal(record.events.filter(e=>e.type==='ai_changes_applied').length,1);
    assert.equal(record.events.find(e=>e.type==='ai_changes_applied').actor,'ai');
    await assert.rejects(f.runtime.decide(f.id,f.owner,proposal.id,true),/失效/);
    await f.runtime.start(f.id,f.owner,f.plan.id);assert.equal(f.runtime.jobs.size,0);
  }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});
test('rejection and file changes during approval never overwrite student code',async()=>{
  for(const changed of [false,true]){
    let f;f=await fixture(proposalModel(()=>f.plan));
    try{
      await f.runtime.start(f.id,f.owner,f.plan.id);const state=await idle(f);
      if(changed)await f.traces.append(f.id,{studentId:f.owner,projectId:'project3',events:[ev('code_edited',{file:'src/main.c',before:'int main(void) { return 0; }',after:'// student edit',changes:[]})]},f.owner);
      await f.runtime.decide(f.id,f.owner,state.proposal.id,changed);await idle(f);
      const record=await f.traces.get(f.id);
      assert.equal(record.events.filter(e=>e.type==='ai_changes_applied').length,0);
      assert.equal(filesAt(record)['src/main.c'],changed?'// student edit':'int main(void) { return 0; }');
      assert.equal(filesAt(record)['tests/note.txt'],undefined);
    }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
  }
});
test('compression keeps raw evidence and reloads private rules; history reads can recover original student plans',async()=>{
  let summaries=0;
  const model={status,async call(messages,options){
    assert.equal(options.ownerId,f.owner);
    if(!options.tools){summaries++;return {role:'assistant',content:'学生原始规划见消息编号，已讨论输入输出；未获得任何新文件修改许可。'};}
    assert.match(messages[0].content,/【重点1】状态设计/);assert.match(messages[0].content,/平台审批/);
    return {role:'assistant',content:'只解释当前代码，不修改文件。'.repeat(20)};
  }};
  const f=await fixture(model,1600);
  try{
    for(let i=0;i<7;i++){
      const message=ev('chat_user',{text:`第 ${i} 轮原始规划证据 `+'保持输入输出约束。'.repeat(40)});
      await f.traces.append(f.id,{studentId:f.owner,projectId:'project3',events:[message]},f.owner);
      await f.runtime.start(f.id,f.owner,message.id);await idle(f);
    }
    const record=await f.traces.get(f.id);assert.equal(record.events.filter(e=>e.type==='chat_user').length,8);assert.ok(summaries>0);
    assert.ok(record.events.some(e=>e.type==='ai_context_compacted'));
    const snapshot=await f.runtime.graph.getState(f.runtime.config(f.id,f.owner));assert.ok(snapshot.values.messages.length<14);
    assert.ok(f.runtime.db.prepare('SELECT count(*) AS n FROM agent_history').get().n>=14);
    assert.ok(record.events.some(e=>e.id===f.plan.id&&e.payload.text===f.plan.payload.text));
    assert.ok(!JSON.stringify(record).includes('【重点1】'));
    const historyRequest={role:'assistant',tool_calls:[{id:'retrieve_plan',function:{name:'read_history',arguments:JSON.stringify({query:f.plan.id})}}]};
    const retrieved=await f.runtime.tools({...snapshot.values,messages:[historyRequest]},f.runtime.config(f.id,f.owner));
    assert.equal(JSON.parse(retrieved.messages.at(-1).content)[0].text,f.plan.payload.text);
    const long=ev('chat_user',{text:'长规划'.repeat(1800)+'末尾关键约束'});
    await f.traces.append(f.id,{studentId:f.owner,projectId:'project3',events:[long]},f.owner);
    historyRequest.tool_calls[0].id='retrieve_tail';
    historyRequest.tool_calls[0].function.arguments=JSON.stringify({query:long.id,offset:4000});
    const tail=await f.runtime.tools({...snapshot.values,messages:[historyRequest]},f.runtime.config(f.id,f.owner));
    assert.equal(JSON.parse(tail.messages.at(-1).content)[0].text,long.payload.text.slice(4000));
  }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});
test('project-specific policy and virtual paths never expose another project or host filesystem',async()=>{
  const one=await projectPolicy(root,'project1'),two=await projectPolicy(root,'project2');
  assert.match(one,/红黑树（插入 \+ 删除）/);assert.ok(!one.includes('【重点1】斐波那契堆'));
  assert.match(two,/【重点1】斐波那契堆/);
  await assert.rejects(projectPolicy(root,'../../point/project1'),/无效/);
  for(const name of ['/etc/passwd','../secret','src/../../secret','.env','src/.key','src\\main.c'])assert.equal(validFile(name),false);
  assert.equal(validFile('src/main.c'),true);
});

test('AI executes an existing project through the execution service and receives the recorded result',async()=>{
  let count=0;
  const model={status,async call(messages){
    if(count++===0)return {role:'assistant',content:'运行已有程序。',tool_calls:[{id:'run_test',type:'function',function:{name:'run_project',arguments:JSON.stringify({mode:'c',stdin:'5\n'})}}]};
    const result=JSON.parse(messages.at(-1).content);assert.equal(result.stdout,'n=5\n');assert.equal(result.status,'succeeded');
    return {role:'assistant',content:'实际输出为 n=5，退出码为0。'};
  }};
  const f=await fixture(model);
  const execution=new ExecutionService({root,traces:f.traces,directory:f.directory+'/runs',sandbox:{health:async()=>({available:true}),execute:async()=>({exitCode:0,stdout:'n=5\n',stderr:'',artifacts:[]})}});
  f.runtime.execution=execution;
  try{await f.runtime.start(f.id,f.owner,f.plan.id);await idle(f);const record=await f.traces.get(f.id);assert.ok(record.events.some(e=>e.type==='execution_finished'&&e.actor==='ai'));assert.equal(filesAt(record)['src/main.c'],'int main(void) { return 0; }');}
  finally{execution.close();f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});

test('multiple plan messages and server-bound versions support small patches without copying hashes',async()=>{
  const f=await fixture({status,call:async()=>({role:'assistant',content:'unused'})});
  try{
    const second=ev('chat_user',{text:'先修改 main 的返回值，再创建说明文件。'});
    await f.traces.append(f.id,{studentId:f.owner,projectId:'project3',events:[second]},f.owner);
    const read={role:'assistant',tool_calls:[{id:'read',function:{name:'read_file',arguments:JSON.stringify({path:'src/main.c'})}}]};
    const state={runId:'patch-test',messages:[read]};
    const readResult=await f.runtime.tools(state,f.runtime.config(f.id,f.owner));
    const args={summary:'小范围修改',plan_message_ids:[f.plan.id,second.id],changes:[{path:'src/main.c',edits:[{old_text:'return 0;',new_text:'return 1;'}]},{path:'docs/note.txt',content:'说明'}]};
    const record=await f.traces.get(f.id),proposal=f.runtime.proposal(record,args,'patch',{...state,...readResult});
    assert.equal(proposal.changes[0].after,'int main(void) { return 1; }');
    assert.deepEqual(proposal.planMessageIds,[f.plan.id,second.id]);
    assert.ok(proposal.planQuote.includes(second.payload.text));
    assert.equal(filesAt(record)['docs/note.txt'],undefined);
    assert.throws(()=>f.runtime.proposal(record,{...args,plan_message_ids:['unknown']},'bad',readResult),/消息编号不存在/);
    const edited=ev('code_edited',{file:'src/main.c',before:filesAt(record)['src/main.c'],after:'student changed',changes:[]});
    await f.traces.append(f.id,{studentId:f.owner,projectId:'project3',events:[edited]},f.owner);
    assert.throws(()=>f.runtime.proposal({...record,events:[...record.events,{...edited,sequence:record.events.length+1}]},args,'stale',readResult),/读取后文件发生/);
  }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});

test('repeated invalid proposals stop after two attempts and raw failed code stays out of working context',async()=>{
  let calls=0;
  const f=await fixture({status,call:async()=>{calls++;return {role:'assistant',content:'准备改动',tool_calls:[{id:'invalid_'+calls,function:{name:'propose_changes',arguments:'{"content":"'+'x'.repeat(20000)}}]};}});
  try{
    await f.runtime.start(f.id,f.owner,f.plan.id);const info=await idle(f);
    assert.equal(calls,2);assert.equal(info.status,'idle');
    const snapshot=await f.runtime.graph.getState(f.runtime.config(f.id,f.owner));
    assert.ok(JSON.stringify(snapshot.values.messages).length<5000);
    assert.ok(f.runtime.db.prepare("SELECT content FROM agent_history WHERE content LIKE '%xxxxxxxxxx%' LIMIT 1").get());
    assert.equal((await f.traces.get(f.id)).events.filter(e=>e.type==='ai_context_compacted').length,0);
    assert.equal(filesAt(await f.traces.get(f.id))['src/main.c'],'int main(void) { return 0; }');
  }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});

test('compression leaves headroom, preserves latest plan and does not immediately repeat',async()=>{
  let calls=0;
  const f=await fixture({status,call:async()=>{calls++;return {role:'assistant',content:'学生规划保留在历史编号，需时读取原文。'};}},18000);
  try{
    const messages=[];
    for(let i=0;i<12;i++)messages.push({role:'user',content:'规划'+i+'甲'.repeat(600)},{role:'assistant',content:'说明'.repeat(300)});
    const initial={runId:'headroom',messages,summary:'',compactions:0};
    const result=await f.runtime.context(initial,f.runtime.config(f.id,f.owner));
    assert.equal(calls,1);assert.ok(Buffer.byteLength(JSON.stringify(result.messages))+Buffer.byteLength(result.summary)<9000);
    assert.deepEqual(result.messages.at(-2),messages.at(-2));
    await f.runtime.context({...initial,...result},f.runtime.config(f.id,f.owner));assert.equal(calls,1);
  }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});

test('live replies precede completion, never apply code and retain interrupted text as partial evidence',async()=>{
 let release;const gate=new Promise(r=>release=r);
 const f=await fixture({status,async call(messages,{onDelta}){onDelta({text:'这是尚未完成的回复'});onDelta({tool:true});await gate;throw Object.assign(Error('测试连接中断'),{status:502});}});
 const seen=[],off=f.runtime.subscribe(f.id,v=>seen.push(v));
 try{
  await f.runtime.start(f.id,f.owner,f.plan.id);
  for(let i=0;i<100&&!seen.some(v=>v?.text);i++)await new Promise(r=>setTimeout(r,5));
  assert.ok(seen.some(v=>v?.text==='这是尚未完成的回复'));
  assert.equal((await f.runtime.status(f.id,f.owner)).status,'running');
  assert.equal((await f.traces.get(f.id)).events.filter(e=>e.type==='ai_response').length,0);
  release();await idle(f);
  const record=await f.traces.get(f.id);
  assert.match(record.events.find(e=>e.type==='ai_response_partial').payload.text,/回复中断/);
  assert.equal(record.events.filter(e=>e.type==='ai_changes_applied').length,0);
  assert.equal(seen.at(-1),null);
 }finally{release();off();await f.runtime.jobs.get(f.id);f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});

test('fixed welcome is injected exactly once on every tutor request, outside compressed history',async()=>{
 const {assistantWelcome}=await import('../public/agent-welcome.js');
 const calls=[];const f=await fixture({status,async call(messages){calls.push(messages);return {role:'assistant',content:'请先说明你的整体思路。'};}});
 try{
  const state={messages:[{role:'user',content:'我准备开始作答。'}],summary:'此前的事实摘要',steps:0,runId:crypto.randomUUID(),messageId:f.plan.id};
  const config=f.runtime.config(f.id,f.owner);
  const next=await f.runtime.respond(state,config);
  await f.runtime.respond({...state,...next},config);
  assert.equal(calls.length,2);
  for(const messages of calls){assert.equal(messages.filter(m=>m.content===assistantWelcome).length,1);assert.deepEqual(messages[1],{role:'assistant',content:assistantWelcome});}
  assert.equal(next.messages.some(m=>m.content===assistantWelcome),false);
  assert.equal((await f.traces.get(f.id)).events.filter(e=>e.type==='chat_demo').length,0);
 }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});

test('experimental memory search is hidden and execution-blocked by default; opt-in remains read-only and owner-scoped',async()=>{
  const requests=[],model={status,async call(messages,options){requests.push(options.tools);return {role:'assistant',content:'继续讨论。'};}};
  const f=await fixture(model);let lookups=[];
  try{
    f.runtime.memories={async retrieve(...args){lookups.push(args);return [{id:'confirmed-memory',observation:'有范围的观察',eventIds:[f.plan.id]}];}};
    const state={runId:crypto.randomUUID(),messageId:f.plan.id,messages:[{role:'user',content:'测试'}],steps:0,summary:''};
    await f.runtime.respond(state,f.runtime.config(f.id,f.owner));
    assert.ok(!requests.at(-1).some(t=>t.function.name==='search_student_memory'));
    lookups=[];
    const invoke=async args=>f.runtime.tools({...state,runId:crypto.randomUUID(),messages:[{role:'assistant',tool_calls:[{id:crypto.randomUUID(),function:{name:'search_student_memory',arguments:JSON.stringify(args)}}]}]},f.runtime.config(f.id,f.owner));
    let output=await invoke({query:'边界验证'});assert.match(output.messages.at(-1).content,/当前已关闭/);assert.equal(lookups.length,0);
    f.runtime.close();f.runtime=new AgentRuntime({...f.options,memoryToolEnabled:true});
    f.runtime.memories={async retrieve(...args){lookups.push(args);return [{id:'confirmed-memory',observation:'有范围的观察',eventIds:[f.plan.id]}];}};
    await f.runtime.respond({...state,runId:crypto.randomUUID()},f.runtime.config(f.id,f.owner));assert.ok(requests.at(-1).some(t=>t.function.name==='search_student_memory'));
    lookups=[];output=await invoke({query:'边界验证',studentId:'someone-else'});assert.match(output.messages.at(-1).content,/不能指定账号/);assert.equal(lookups.length,0);
    output=await invoke({query:'   '});assert.match(output.messages.at(-1).content,/1–300/);assert.equal(lookups.length,0);
    output=await invoke({query:'边界验证'});const result=JSON.parse(output.messages.at(-1).content);assert.equal(result.experimental,true);assert.equal(result.items[0].id,'confirmed-memory');assert.deepEqual(lookups,[[f.owner,'project3','边界验证']]);
    assert.ok((await f.traces.get(f.id)).events.some(e=>e.type==='ai_tool'&&e.payload.tool==='search_student_memory'));
  }finally{f.runtime.close();await rm(f.directory,{recursive:true,force:true});}
});
