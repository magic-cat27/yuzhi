import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {createApp} from '../server.mjs';
test('authenticated SSE delivers live reply, reconnects to current draft and disconnect does not cancel task',async()=>{
 const directory=await mkdtemp('/tmp/yuzhi-stream-http-');let release,started;
 const gate=new Promise(r=>release=r),ready=new Promise(r=>started=r);
 const model={status:()=>({configured:true,model:'test'}),async call(messages,{onDelta}){onDelta({text:'实时文字'});started();await gate;return {role:'assistant',content:'实时文字，已完成'};}};
 const server=createApp({authDirectory:directory+'/auth',traceDirectory:directory+'/traces',agentModel:model});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,session,body)=>{const r=await fetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const first=new AbortController(),second=new AbortController();
 try{
  const login=await request('/api/auth/register',null,{username:'streamtester',name:'流式测试',password:'Test-stream-password-2026'}),session={cookie:login.cookie,csrf:login.data.csrf};
  const id=crypto.randomUUID();await request('/api/attempts',session,{projectId:'project1',requestId:id});
  const event={id:crypto.randomUUID(),type:'chat_user',actor:'student',timestamp:new Date().toISOString(),payload:{text:'解释已有代码'}};
  await request(`/api/traces/${id}/events`,session,{projectId:'project1',studentId:login.data.user.id,events:[event]});
  await request(`/api/agent/${id}/message`,session,{messageId:event.id});await ready;
  async function connect(controller){const r=await fetch(origin+`/api/agent/${id}/stream`,{headers:{Cookie:session.cookie},signal:controller.signal});assert.match(r.headers.get('content-type'),/text\/event-stream/);const reader=r.body.getReader();let text='';while(!text.includes('实时文字')){const part=await reader.read();assert.equal(part.done,false);text+=new TextDecoder().decode(part.value);}return text;}
  assert.match(await connect(first),/实时文字/);first.abort();
  assert.match(await connect(second),/实时文字/);second.abort();release();
  let record;
  for(let i=0;i<100;i++){record=(await request('/api/attempts/'+id,session)).data;if(record.events.some(e=>e.type==='ai_response'))break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(record.events.filter(e=>e.type==='ai_response').length,1);
  assert.equal(record.events.find(e=>e.type==='ai_response').payload.text,'实时文字，已完成');
 }finally{release();first.abort();second.abort();await new Promise(r=>server.close(r));await rm(directory,{recursive:true,force:true});}
});
