import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createApp} from '../server.mjs';
import {AuthStore} from '../src/auth-store.mjs';
import {AgentRuntime} from '../src/agent-runtime.mjs';
import {TraceStore} from '../src/trace-store.mjs';
import {pointPlaceholder} from '../src/project-catalog.mjs';
const root=new URL('..',import.meta.url).pathname;
const credentials=username=>({username,name:username,password:'QA-project-password-2026'});

test('teacher publishes projects; student trial permissions, isolation, versions, CSRF and private points',async()=>{
 const dir=await mkdtemp('/tmp/yuzhi-studio-test-');const seed=new AuthStore(dir+'/auth'),token=seed.issueSetupToken();seed.close();
 const server=createApp({authDirectory:dir+'/auth',traceDirectory:dir+'/traces'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const request=async(url,session,body,extra={})=>{const r=await fetch(origin+url,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const login=async(path,body)=>{const r=await request(path,null,body);assert.equal(r.status,201);return {cookie:r.cookie,csrf:r.data.csrf,id:r.data.user.id};};
 try{
  const teacher=await login('/api/auth/setup-teacher',{...credentials('teacherqa'),token}),a=await login('/api/auth/register',credentials('studentqa')),b=await login('/api/auth/register',credentials('studentqb'));
  assert.equal((await request('/api/teacher/projects',a)).status,403);
  assert.equal((await request('/api/projects')).status,401);
  assert.equal((await request('/api/prompt-trials/project1',a)).status,403);
  assert.equal((await request('/api/teacher/prompt-trials',a,{enabled:true})).status,403);
  const definition={name:'<img src=x onerror=alert(1)>测试题',description:'整数输入输出',problem:'读取一个整数并输出。',points:'私密考点_SENTINEL',prompt:'教师规范_A\n'+pointPlaceholder,expectedVersion:0};
  assert.equal((await request('/api/teacher/projects',a,definition)).status,403);
  assert.equal((await request('/api/teacher/projects',teacher,definition,{'X-CSRF-Token':'bad'})).status,403);
  const added=await request('/api/teacher/projects',teacher,definition);assert.equal(added.status,200);assert.equal(added.data.id,'project4');
  const catalog=(await request('/api/projects',a)).data;assert.equal(catalog.length,4);assert.equal(catalog.at(-1).name,definition.name);assert.equal(catalog.at(-1).files['src/main.c'].includes('int main'),true);assert.equal(JSON.stringify(catalog).includes('SENTINEL'),false);assert.equal(JSON.stringify(catalog).includes('教师规范_A'),false);
  const attempt=crypto.randomUUID();assert.equal((await request('/api/attempts',a,{projectId:'project4',requestId:attempt})).status,201);
  const existing=(await request('/api/attempts/'+attempt,a)).data;
  assert.equal((await request('/api/teacher/projects/project4',teacher,{...definition,expectedVersion:1,name:'已更新题目'})).status,200);
  assert.equal((await request('/api/teacher/projects/project4',teacher,{...definition,expectedVersion:1})).status,409);
  assert.deepEqual((await request('/api/attempts/'+attempt,a)).data.files,existing.files);
  assert.equal((await request('/api/teacher/projects/project4',teacher)).data.history.length,2);
  const policy=(await request('/api/teacher/projects/project4/policy',teacher)).data.policy;assert.match(policy,/私密考点_SENTINEL/);assert.match(policy,/平台审批/);
  assert.equal((await request('/api/teacher/projects/project4/policy',a)).status,403);
  assert.equal((await request('/api/teacher/prompt-trials',teacher,{enabled:true})).data.enabled,true);
  const editable=(await request('/api/prompt-trials/project4',a)).data;assert.equal(editable.defaultBody,definition.prompt);assert.equal(JSON.stringify(editable).includes('SENTINEL'),false);
  const personal='个人规范_B\n'+pointPlaceholder;
  assert.equal((await request('/api/prompt-trials/project4',a,{body:personal,expectedVersion:0,ownerId:b.id})).status,200);
  assert.equal((await request('/api/prompt-trials/project4',b)).data.body,null);
  assert.equal((await request('/api/prompt-trials/project1',a)).data.body,null);
  assert.equal((await request('/api/prompt-trials/project4',a,{body:personal,expectedVersion:0})).status,409);
  assert.equal((await request('/api/prompt-trials/project4',a,{body:'no placeholder',expectedVersion:1})).status,400);
  assert.equal((await request('/api/prompt-trials/project4',a,{body:'x'.repeat(25000)+pointPlaceholder,expectedVersion:1})).status,400);
  assert.equal((await request('/api/prompt-trials/project4',a,{body:null,expectedVersion:1})).data.version,2);
  assert.equal((await request('/api/prompt-trials/project4',a)).data.history.length,2);
  await request('/api/teacher/prompt-trials',teacher,{enabled:false});
  assert.equal((await request('/api/prompt-trials/project4',a)).status,403);
  assert.equal((await request('/api/prompt-trials/project4',a,{body:personal,expectedVersion:2})).status,403);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('model uses personal policy, pins each run across edits/restart and returns to teacher defaults when disabled',async()=>{
 const directory=await mkdtemp('/tmp/yuzhi-policy-run-'),traces=new TraceStore(directory+'/traces'),owner=crypto.randomUUID(),id=crypto.randomUUID();
 const template={id:'project1',files:{'src/main.c':'int main(void){return 0;}'}};await traces.createAttempt(id,template,owner);
 const calls=[];const model={status:()=>({configured:true,model:'fake'}),async call(messages){calls.push(messages);return {role:'assistant',content:'已读取本轮规则。'};}};
 const options={root,directory:directory+'/agent',traces,model};let runtime=new AgentRuntime(options);
 try{
  runtime.promptTrials.configure(true,'teacher');
  await runtime.promptTrials.save(owner,'project1',{body:'个人规范_A\n'+pointPlaceholder,expectedVersion:0});
  const config=runtime.config(id,owner),state={runId:crypto.randomUUID(),messageId:crypto.randomUUID(),steps:0,messages:[{role:'user',content:'解释代码'}]};
  await runtime.respond(state,config);assert.match(calls.at(-1)[0].content,/个人规范_A/);assert.match(calls.at(-1)[0].content,/【重点1】红黑树/);assert.match(calls.at(-1)[0].content,/平台审批/);
  await runtime.promptTrials.save(owner,'project1',{body:'个人规范_B\n'+pointPlaceholder,expectedVersion:1});
  runtime.close();runtime=new AgentRuntime(options);
  await runtime.respond({...state,steps:1},config);assert.match(calls.at(-1)[0].content,/个人规范_A/);
  await runtime.respond({...state,runId:crypto.randomUUID()},config);assert.match(calls.at(-1)[0].content,/个人规范_B/);
  runtime.promptTrials.configure(false,'teacher');await runtime.respond({...state,runId:crypto.randomUUID()},config);assert.doesNotMatch(calls.at(-1)[0].content,/个人规范_[AB]/);
  const evidence=(await traces.get(id)).events.filter(e=>e.type==='ai_prompt_version');assert.equal(evidence.length,3);assert.equal(evidence[0].payload.version,1);assert.match(evidence[0].payload.body,/个人规范_A/);assert.equal(JSON.stringify(evidence).includes('【重点1】红黑树'),false);
 }finally{runtime.close();await rm(directory,{recursive:true,force:true});}
});
