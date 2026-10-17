import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {WebSocket} from 'ws';
import {createApp} from '../server.mjs';
import {connectAgentLive} from '../public/agent-live.js';

test('WebSocket authenticates owner and origin, emits intermediate text before completion, reconnects and preserves one final reply',async()=>{
 const directory=await mkdtemp('/tmp/yuzhi-ws-test-');let release,started,emit;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const model={status:()=>({configured:true,model:'test'}),async call(messages,{onDelta}){emit=onDelta;onDelta({text:'第一段'});started();await gate;return {role:'assistant',content:'第一段第二段'};}};
 const server=createApp({authDirectory:directory+'/auth',traceDirectory:directory+'/traces',agentModel:model});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`,wsOrigin=origin.replace('http','ws'),opened=[];
 const request=async(path,session,body)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const register=async username=>{const r=await request('/api/auth/register',null,{username,name:username,password:'Test-stream-password-2026'});return {cookie:r.cookie,csrf:r.data.csrf,id:r.data.user.id};};
 const connect=(path,session,site=origin)=>{const ws=new WebSocket(wsOrigin+path,{headers:{Origin:site,...(session?{Cookie:session.cookie}:{})}});opened.push(ws);return ws;};
 const rejected=ws=>new Promise((resolve,reject)=>{ws.on('unexpected-response',(_,r)=>{resolve(r.statusCode);r.resume();ws.terminate();});ws.on('open',()=>reject(Error('unexpected open')));ws.on('error',()=>{});});
 const stream=ws=>{const frames=[];ws.on('message',data=>frames.push(JSON.parse(data)));return {frames,async until(check){for(let i=0;i<150;i++){const found=frames.find(check);if(found!==undefined)return found;await new Promise(r=>setTimeout(r,10));}throw Error('Expected live frame missing');}};};
 try{
  const owner=await register('wsowner'),other=await register('wsother'),id=crypto.randomUUID(),path=`/api/agent/${id}/live`;
  await request('/api/attempts',owner,{projectId:'project1',requestId:id});
  assert.equal(await rejected(connect(path,null)),401);assert.equal(await rejected(connect(path,other)),403);assert.equal(await rejected(connect(path,owner,'https://foreign.test')),403);
  const first=connect(path,owner),a=stream(first);await a.until(v=>v===null);
  const event={id:crypto.randomUUID(),type:'chat_user',actor:'student',timestamp:new Date().toISOString(),payload:{text:'解释已有代码'}};
  await request(`/api/traces/${id}/events`,owner,{projectId:'project1',studentId:owner.id,events:[event]});await request(`/api/agent/${id}/message`,owner,{messageId:event.id});await ready;
  assert.equal((await a.until(v=>v?.text==='第一段')).text,'第一段');
  assert.equal((await request('/api/attempts/'+id,owner)).data.events.some(e=>e.type==='ai_response'),false);
  emit({text:'第二段'});await a.until(v=>v?.text==='第一段第二段');
  assert.equal((await request(path,owner)).data.text,'第一段第二段');assert.equal((await request(path,other)).status,403);
  first.close();const second=connect(path,owner),b=stream(second);await b.until(v=>v?.text==='第一段第二段');release();await b.until(v=>v===null);
  const record=(await request('/api/attempts/'+id,owner)).data;assert.equal(record.events.filter(e=>e.type==='ai_response').length,1);
 }finally{release();for(const ws of opened)ws.terminate();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});

test('client fallback cannot overwrite newer socket text with a stale HTTP snapshot; close stops delivery',async()=>{
 let ws,finish;const values=[];class FakeSocket{constructor(){ws=this;this.readyState=0;}close(){this.readyState=3;this.onclose?.();}}
 const connection=connectAgentLive({url:'ws://test/live',Socket:FakeSocket,onValue:v=>values.push(v),onStatus:()=>{},fetchSnapshot:()=>new Promise(r=>finish=r)});
 ws.readyState=1;ws.onopen();ws.onmessage({data:JSON.stringify({text:'正在生成'})});finish(null);await new Promise(r=>setTimeout(r,0));assert.deepEqual(values,[{text:'正在生成'}]);connection.close();ws.onmessage({data:JSON.stringify({text:'late'})});assert.equal(values.length,1);
});
