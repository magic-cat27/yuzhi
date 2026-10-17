import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AuthStore } from '../src/auth-store.mjs';
import { createApp } from '../server.mjs';

const credentials=(username)=>({username,name:'测试 '+username,password:'Testing-long-password-123'});
test('invitation-only registration rejects bypass and atomically consumes one-use invites',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'yuzhi-invite-'));
  let store=new AuthStore(dir,{inviteOnly:true});
  try{
    await assert.rejects(store.register({...credentials('uninvited'),role:'teacher'}),/邀请码/);
    const code=store.issueInvite();
    const attempts=await Promise.allSettled(['first','second'].map(username=>store.register({...credentials(username),inviteCode:code})));
    assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
    const user=attempts.find(result=>result.status==='fulfilled').value;
    assert.equal(user.role,'student');
    store.close();store=new AuthStore(dir,{inviteOnly:true});
    assert.equal(store.validInvite(code),false);
    await assert.rejects(store.register({...credentials('third'),inviteCode:code}),/邀请码/);
    assert.equal((await store.login(credentials(user.username))).id,user.id);
    const teacher=await store.register({...credentials('teacher'),token:store.issueSetupToken()},true);
    assert.equal(teacher.role,'teacher');
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});
test('password hashing, fixed student role, persisted sessions, expiry and one-use teacher setup',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'yuzhi-auth-unit-'));
  let store=new AuthStore(dir);
  try{
    const student=await store.register({...credentials('alice'),role:'teacher'});
    assert.equal(student.role,'student');
    const row=store.db.prepare('SELECT * FROM users').get();
    assert.notEqual(row.password_hash,credentials('alice').password);assert.equal(row.password_hash.length,128);
    await assert.rejects(store.login({...credentials('alice'),password:'incorrect-password'}),/用户名或密码/);
    assert.equal((await store.login(credentials('ALICE'))).id,student.id);
    await assert.rejects(store.register(credentials('Alice')),/已被使用/);
    const session=store.createSession(student);
    store.close();store=new AuthStore(dir);
    assert.equal(store.session(session.token).user.id,student.id);
    store.db.prepare('UPDATE sessions SET expires_at=0').run();assert.equal(store.session(session.token),null);
    const oldToken=store.issueSetupToken(),token=store.issueSetupToken();assert.equal(store.validSetup(oldToken),false);
    await assert.rejects(store.register({...credentials('owner'),token:'fake'},true),/初始化链接/);
    const results=await Promise.allSettled(['owner','other_owner'].map(username=>store.register({...credentials(username),token},true)));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal(store.hasTeacher(),true);assert.equal(store.validSetup(token),false);
    assert.throws(()=>store.issueSetupToken(),/已创建/);
    const next=store.createSession(student);store.logout(next.token);assert.equal(store.session(next.token),null);
    store.throttle('test',1);assert.throws(()=>store.throttle('test',1),/次数过多/);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test('HTTP registration, role authorization, CSRF, ownership, logout and secure deployment cookie',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'yuzhi-auth-http-'));
  const options={authDirectory:path.join(dir,'auth'),traceDirectory:path.join(dir,'traces'),executionSandbox:{health:async()=>({available:true}),execute:async()=>({exitCode:0,stdout:'test run',stderr:'',artifacts:[{name:'test.csv',data:Buffer.from('n,v\n1,2\n').toString('base64')}]})}};
  const seed=new AuthStore(options.authDirectory), setupToken=seed.issueSetupToken();seed.close();
  const server=createApp(options);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(url,session,body,extra={}) {
    const response=await fetch(origin+url,{method:body?'POST':'GET',headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};
  }
  try{
    assert.equal((await request('/api/teacher/records')).status,401);
    assert.equal((await request('/api/auth/me')).body.user,null);
    assert.equal((await request('/api/auth/register',null,credentials('alice'),{Origin:'https://other.example'})).status,403);
    const result=await request('/api/auth/register',null,{...credentials('alice'),role:'teacher'});
    assert.equal(result.status,201);assert.equal(result.body.user.role,'student');
    assert.match(result.headers.get('set-cookie'),/HttpOnly/);assert.match(result.headers.get('set-cookie'),/SameSite=Lax/);
    assert.ok(!JSON.stringify(result.body).includes('password'));
    const alice={cookie:result.cookie,csrf:result.body.csrf}, aliceId=result.body.user.id;
    assert.equal((await request('/api/teacher/records',alice)).status,403);
    assert.equal((await request('/api/teacher/ai-settings',alice)).status,403);
    assert.equal((await request('/api/teacher/ai-settings',alice,{apiKey:'fake-key-student-attempt'})).status,403);
    assert.equal((await request('/api/problems/project1',alice)).status,200);
    const id=crypto.randomUUID(),event={id:crypto.randomUUID(),type:'session_started',actor:'system',timestamp:new Date().toISOString(),payload:{files:{'src/main.c':'int main(void) {}'}}};
    const trace={studentId:aliceId,projectId:'project1',events:[event]};
    assert.equal((await request(`/api/traces/${id}/events`,alice,trace,{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await request(`/api/traces/${id}/events`,alice,trace)).status,200);
    assert.equal((await request(`/api/traces/${id}/events`,alice,{...trace,events:[{...event,id:crypto.randomUUID(),type:'ai_changes_applied',actor:'ai',payload:{changes:[]}}]})).status,400);
    const bobResult=await request('/api/auth/register',null,credentials('bob'));
    const bob={cookie:bobResult.cookie,csrf:bobResult.body.csrf};
    assert.equal((await request(`/api/traces/${id}/events`,bob,trace)).status,403);
    assert.equal((await request(`/api/traces/${id}/events`,bob,{...trace,studentId:bobResult.body.user.id})).status,403);
    assert.equal((await request(`/api/teacher/records/${id}/export`,bob)).status,403);
    assert.equal((await request(`/api/agent/${id}`,bob)).status,403);
    assert.equal((await request(`/api/agent/${id}/stream`,bob)).status,403);
    assert.equal((await request(`/api/agent/${id}/stream`)).status,401);
    assert.equal((await request(`/api/agent/${id}/decision`,bob,{proposalId:'fake',approved:true})).status,403);
    assert.equal((await request(`/api/agent/${id}`,alice)).status,200);
    assert.equal((await request(`/api/execution/${id}`,bob,{mode:'c'})).status,403);
    assert.equal((await request(`/api/execution/${id}`,bob)).status,403);
    assert.equal((await request(`/api/execution/${id}`,alice,{mode:'c'},{'X-CSRF-Token':'wrong'})).status,403);
    const started=await request(`/api/execution/${id}`,alice,{mode:'c'});assert.equal(started.status,202);
    let run;
    for(let i=0;i<30;i++){run=(await request(`/api/runs/${started.body.id}`,alice)).body;if(run.status!=='running')break;await new Promise(resolve=>setTimeout(resolve,10));}
    assert.equal(run.status,'succeeded');
    assert.equal((await request(`/api/runs/${run.id}`,bob)).status,403);
    assert.equal((await request(`/api/runs/${run.id}/cancel`,bob,{})).status,403);
    const artifactURL=`/api/runs/${run.id}/artifacts/${run.artifacts[0].id}`;
    assert.equal((await request(artifactURL,bob)).status,403);
    const download=await fetch(origin+artifactURL,{headers:{Cookie:alice.cookie}});
    assert.equal(download.headers.get('content-type'),'text/csv');assert.match(download.headers.get('content-disposition'),/attachment/);
    assert.equal(await download.text(),'n,v\n1,2\n');

    assert.equal((await request('/point/project3_考点.txt',alice)).status,404);
    assert.equal((await request('/prompt/AGENTS.md',alice)).status,404);
    assert.equal((await request('/api/auth/setup-teacher',null,{...credentials('owner'),token:'invalid'})).status,403);
    const ownerResult=await request('/api/auth/setup-teacher',null,{...credentials('owner'),token:setupToken});
    assert.equal(ownerResult.status,201);assert.equal(ownerResult.body.user.role,'teacher');
    const owner={cookie:ownerResult.cookie,csrf:ownerResult.body.csrf};
    const setting=await request('/api/teacher/ai-settings',owner,{apiKey:'test-only-key-do-not-call'});
    assert.equal(setting.status,200);assert.ok(!JSON.stringify(setting.body).includes('test-only-key'));
    assert.equal((await request('/api/teacher/ai-settings',owner)).body.configured,true);
    const records=await request('/api/teacher/records',owner);
    assert.equal(records.status,200);assert.equal(records.body[0].student.username,'alice');
    const record=await request(`/api/teacher/records/${id}/export`,owner);
    assert.equal(record.status,200);assert.equal(record.body.ownerId,aliceId);assert.equal(record.body.events.length,3);assert.equal(record.body.events.at(-1).type,'execution_finished');
    assert.equal((await request(`/api/runs/${run.id}`,owner)).status,200);
    assert.equal((await request('/api/auth/setup-teacher',null,{...credentials('owner2'),token:setupToken})).status,403);
    assert.equal((await request('/api/auth/logout',alice,{})).status,200);
    assert.equal((await request('/api/auth/me',alice)).body.user,null);
    assert.equal((await request(`/api/traces/${id}/events`,alice,trace)).status,401);
    const login=await request('/api/auth/login',null,credentials('alice'));assert.equal(login.status,200);assert.notEqual(login.cookie,alice.cookie);
    assert.equal((await request('/api/auth/login',null,{...credentials('alice'),password:'wrong'})).status,401);
    assert.equal((await request('/data/auth/accounts.sqlite')).status,404);
    assert.equal((await request('/.env')).status,404);
    assert.throws(()=>createApp({...options,production:true,origin:'http://example.test'}),/HTTPS/);
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('HTTPS deployment sets host-only Secure cookies and enforces configured origin',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'yuzhi-auth-secure-'));
  const server=createApp({authDirectory:dir+'/auth',traceDirectory:dir+'/traces',production:true,origin:'https://assessment.example.com'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const response=await fetch(`http://127.0.0.1:${server.address().port}/api/auth/register`,{method:'POST',headers:{Origin:'https://assessment.example.com','Content-Type':'application/json'},body:JSON.stringify(credentials('https_user'))});
    assert.equal(response.status,201);
    assert.match(response.headers.get('set-cookie'),/^__Host-yuzhi_session=/);
    assert.match(response.headers.get('set-cookie'),/; Secure/);
    assert.ok(!response.headers.get('set-cookie').includes('Domain='));
    assert.equal(response.headers.get('strict-transport-security'),'max-age=31536000');
  }finally{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
