import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createApp} from '../server.mjs';
import {restoreAttempt} from '../public/workspace-state.js';

test('attempts remain independent, idempotent, owner-only and restorable after restart',async()=>{
 const dir=await mkdtemp('/tmp/yuzhi-attempts-');
 const options={authDirectory:dir+'/auth',traceDirectory:dir+'/traces'};
 let server=createApp(options);
 const listen=async()=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;};
 let origin=await listen();
 const request=async(path,session,body)=>{
  const response=await fetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});
  return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
 };
 try{
  const register=async username=>{const r=await request('/api/auth/register',null,{username,name:username,password:'Test-only-long-password'});return {cookie:r.cookie,csrf:r.data.csrf,id:r.data.user.id};};
  const a=await register('alice'),b=await register('bob'),first=crypto.randomUUID(),second=crypto.randomUUID();
  assert.equal((await request('/api/attempts',a,{projectId:'project1',requestId:first})).status,201);
  assert.equal((await request('/api/attempts',a,{projectId:'project1',requestId:first})).status,201);
  const record=(await request('/api/attempts/'+first,a)).data;
  const before=record.files['src/main.c'];
  const edit={id:crypto.randomUUID(),timestamp:new Date().toISOString(),actor:'student',type:'code_edited',payload:{file:'src/main.c',before,after:'// first attempt',changes:[]}};
  assert.equal((await request(`/api/traces/${first}/events`,a,{studentId:a.id,projectId:'project1',events:[edit]})).status,200);
  await request('/api/attempts',a,{projectId:'project1',requestId:second});
  const rows=(await request('/api/attempts?projectId=project1',a)).data;
  assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.attemptNumber).sort(),[1,2]);
  assert.equal((await request('/api/attempts/'+second,a)).data.files['src/main.c'],before);
  assert.equal((await request('/api/attempts/'+first,b)).status,403);
  assert.equal((await request('/api/attempts',b,{projectId:'project1',requestId:first})).status,403);
  assert.equal((await request('/api/attempts?projectId=project1',b)).data.length,0);
  const stale={...edit,id:crypto.randomUUID(),payload:{...edit.payload,after:'stale overwrite'}};
  assert.equal((await request(`/api/traces/${first}/events`,a,{studentId:a.id,projectId:'project1',events:[stale]})).status,409);
  await new Promise(r=>server.close(r));server=createApp(options);origin=await listen();
  const recovered=(await request('/api/attempts/'+first,a)).data;
  assert.equal(restoreAttempt(recovered).files['src/main.c'],'// first attempt');
  assert.equal(recovered.attemptNumber,1);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
