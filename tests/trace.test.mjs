import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {TraceStore} from '../src/trace-store.mjs';
import {textChange, filesAt} from '../public/trace.js';
const event=(type,payload={})=>({id:crypto.randomUUID(),type,payload,actor:'student',timestamp:new Date().toISOString()});
const request=events=>({projectId:'project1',studentId:'student-test-123',events});
test('edits including undo, multiline replacement, and Unicode replay exactly',()=>{
  const versions=['','int main(void) {}','int main(void) {\n    // 中文🙂\n}','int main(void) {}',''];
  let text=versions[0];
  for(const after of versions.slice(1)){
    const c=textChange(text,after);assert.equal(text.slice(c.offset,c.offset+c.removed.length),c.removed);
    text=text.slice(0,c.offset)+c.inserted+text.slice(c.offset+c.removed.length);assert.equal(text,after);
  }
});
test('server persists across restart and deduplicates retry without duplicating events',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'yuzhi-trace-test-'));
  try{
    const store=new TraceStore(dir),id=crypto.randomUUID();
    const start=event('session_started',{files:{'src/main.c':'initial'},messages:[]});
    const edit=event('code_edited',{file:'src/main.c',before:'initial',after:'edited',changes:[]});
    await store.append(id,request([start]));
    await Promise.all([store.append(id,request([start,edit])),store.append(id,request([edit]))]);
    const restarted=new TraceStore(dir),record=await restarted.get(id);
    assert.equal(record.events.length,2);assert.deepEqual(record.events.map(e=>e.sequence),[1,2]);
    assert.equal(filesAt(record,1)['src/main.c'],'initial');assert.equal(filesAt(record,2)['src/main.c'],'edited');
    assert.equal((await restarted.list())[0].edits,1);
    await assert.rejects(store.append(id,request([{...edit,payload:{after:'tampered'}}])),/不一致/);
    await assert.rejects(store.append(id,{...request([edit]),projectId:'project2'}),/归属/);
    await assert.rejects(store.append('../outside',request([start])),/编号/);
    await assert.rejects(store.append(crypto.randomUUID(),request([edit])),/初始/);
    assert.equal((await store.get(id)).events.length,2);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('baseline import is distinct from new history and snapshot preserves all files',()=>{
  const record={events:[{sequence:1,type:'baseline_imported',payload:{files:{'src/main.c':'old'},messages:[{role:'user',text:'old question'}]}},{sequence:2,type:'file_created',payload:{file:'tests/new.c',content:'test'}},{sequence:3,type:'code_edited',payload:{file:'src/main.c',after:'new'}}]};
  assert.deepEqual(filesAt(record,2),{'src/main.c':'old','tests/new.c':'test'});
  assert.deepEqual(filesAt(record),{'src/main.c':'new','tests/new.c':'test'});
});

test('offline queue retries and concurrent synchronization shares one request',async()=>{
  const {syncTrace}=await import('../public/trace.js');
  const original=globalThis.fetch;
  const trace={id:crypto.randomUUID(),studentId:'student-test-123',projectId:'project1',acknowledged:[],events:[event('session_started',{files:{}})]};
  const states=[];let requests=0;
  try{
    globalThis.fetch=async()=>{requests++;throw Error('offline');};
    await syncTrace(trace,()=>{},s=>states.push(s));
    assert.equal(trace.acknowledged.length,0);assert.match(states.at(-1),/自动重试/);
    globalThis.fetch=async(url,options)=>{requests++;await new Promise(r=>setTimeout(r,5));return {ok:true,json:async()=>({acceptedIds:JSON.parse(options.body).events.map(e=>e.id)})};};
    let saves=0;
    await Promise.all([syncTrace(trace,()=>saves++,s=>states.push(s)),syncTrace(trace,()=>saves++,s=>states.push(s))]);
    assert.equal(requests,2);assert.equal(saves,1);assert.deepEqual(trace.acknowledged,[trace.events[0].id]);
    await syncTrace(trace,()=>{},()=>{});assert.equal(requests,2);
  }finally{globalThis.fetch=original;}
});
