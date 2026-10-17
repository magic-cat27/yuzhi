import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { AgentModel } from '../src/agent-model.mjs';

test('provider caches completed requests, reserves uncertain costs and enforces its separate budget',async()=>{
  const saver=SqliteSaver.fromConnString(':memory:'),model=new AgentModel(saver.db),originalFetch=globalThis.fetch;
  model.key=()=> 'test-only-no-network';model.endpoint='https://example.test/v1';model.limit=10;
  let calls=0;
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(url,'https://example.test/v1/chat/completions');
    const body=JSON.parse(options.body);assert.equal(body.enable_thinking,false);assert.equal(body.stream,false);
    return {ok:true,json:async()=>({choices:[{message:{content:'测试回答'},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:20}})};
  };
  try{
    const messages=[{role:'user',content:'解释已有代码'}];
    const first=await model.call(messages,{ownerId:'student-a',cacheKey:'run:1'});
    assert.deepEqual(await model.call(messages,{ownerId:'student-a',cacheKey:'run:1'}),first);assert.equal(calls,1);
    assert.equal(model.status('student-a').accountedRmb,0.0032);
    globalThis.fetch=async()=>{calls++;throw new Error('upstream connection secret must not leak');};
    await assert.rejects(model.call(messages,{ownerId:'student-a',cacheKey:'run:2'}),/模型连接中断/);
    const reserved=model.status('student-a').accountedRmb;assert.ok(reserved>0.0032);
    await assert.rejects(model.call(messages,{ownerId:'student-a',cacheKey:'run:2'}),/避免重复计费/);assert.equal(calls,2);
    assert.equal(model.status('student-a').accountedRmb,reserved);
    model.limit=reserved;
    assert.equal(model.status('student-b').accountedRmb,0);
    assert.equal(model.status('student-b').remainingRmb,reserved);
    await assert.rejects(model.call(messages,{ownerId:'student-a',cacheKey:'run:3'}),/额度不足/);assert.equal(calls,2);
    assert.equal(saver.db.prepare('SELECT count(*) AS n FROM ai_calls').get().n,2);
  }finally{globalThis.fetch=originalFetch;saver.db.close();}
});

test('account budgets isolate concurrent requests, include pending reservations and preserve legacy costs',async()=>{
  const saver=SqliteSaver.fromConnString(':memory:'),db=saver.db,originalFetch=globalThis.fetch;
  db.exec('CREATE TABLE ai_calls (id TEXT PRIMARY KEY, cache_key TEXT UNIQUE, reserved REAL NOT NULL, cost REAL, response TEXT, created_at TEXT NOT NULL)');
  db.prepare('INSERT INTO ai_calls VALUES (?,?,?,?,?,?)').run('legacy','old',17,17,null,'2026-10-15');
  const model=new AgentModel(db);model.key=()=> 'test-only';model.limit=0.06;
  const pending=[];globalThis.fetch=()=>new Promise(resolve=>pending.push(resolve));
  try{
    assert.equal(model.status('student-a').accountedRmb,0);assert.equal(model.status().accountedRmb,17);
    const args={maxTokens:1,cacheKey:'same-request'};
    const a=model.call([{role:'user',content:'test'}],{...args,ownerId:'student-a'});
    await assert.rejects(model.call([{role:'user',content:'test'}],{...args,cacheKey:'second',ownerId:'student-a'}),/额度不足/);
    const b=model.call([{role:'user',content:'test'}],{...args,ownerId:'student-b'});
    assert.equal(pending.length,2);
    assert.ok(model.status('student-a').remainingRmb<0.02);
    for(const resolve of pending)resolve({ok:true,json:async()=>({choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})});
    await Promise.all([a,b]);
    const reopened=new AgentModel(db);
    assert.equal(reopened.status('student-a').accountedRmb,0.0001);
    assert.equal(reopened.status('student-b').accountedRmb,0.0001);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ai_calls WHERE owner_id IS NOT NULL').get().n,2);
    await assert.rejects(model.call([{role:'user',content:'test'}],args),/关联登录账号/);
  }finally{globalThis.fetch=originalFetch;db.close();}
});

test('individual top-ups persist, preserve usage and only unlock the selected account',async()=>{
  const saver=SqliteSaver.fromConnString(':memory:'),db=saver.db,model=new AgentModel(db),originalFetch=globalThis.fetch;
  model.limit=30;model.key=()=> 'test-only';
  for(const owner of ['student-a','student-b'])db.prepare('INSERT INTO ai_calls VALUES (?,?,?,?,?,?,?)').run(owner,owner,30,30,null,'2026-10-16',owner);
  let calls=0;globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})};};
  try{
    const messages=[{role:'user',content:'test'}];
    await assert.rejects(model.call(messages,{ownerId:'student-a',cacheKey:'blocked'}),/额度不足/);
    const grant=db.prepare('INSERT OR IGNORE INTO ai_budget_grants VALUES (?,?,?,?,?)');
    grant.run('grant-1','student-a',20,'Teacher requested top-up','2026-10-16');
    grant.run('grant-1','student-a',20,'Teacher requested top-up','2026-10-16');
    const reopened=new AgentModel(db);reopened.limit=30;
    assert.equal(reopened.status('student-a').budgetRmb,50);
    assert.equal(reopened.status('student-a').remainingRmb,20);
    assert.equal(reopened.status('student-a').accountedRmb,30);
    assert.equal(reopened.status('student-b').budgetRmb,30);
    assert.equal(reopened.status('student-b').remainingRmb,0);
    await model.call(messages,{ownerId:'student-a',cacheKey:'after-grant'});
    await assert.rejects(model.call(messages,{ownerId:'student-b',cacheKey:'still-blocked'}),/额度不足/);
    assert.equal(calls,1);
  }finally{globalThis.fetch=originalFetch;db.close();}
});

test('unlimited policy removes only the chosen account cap and retains usage accounting',async()=>{
 const saver=SqliteSaver.fromConnString(':memory:'),db=saver.db,model=new AgentModel(db),originalFetch=globalThis.fetch;
 model.limit=30;model.key=()=> 'test-only';
 for(const owner of ['unlimited-student','limited-student'])db.prepare('INSERT INTO ai_calls VALUES (?,?,?,?,?,?,?)').run(owner,owner,500,500,null,'2026-10-16',owner);
 db.prepare('INSERT INTO ai_budget_policies VALUES (?,?,?,?)').run('unlimited-student',1,'Teacher removed cap','2026-10-16');
 let calls=0;globalThis.fetch=async()=>{calls++;return {ok:true,json:async()=>({choices:[{message:{content:'ok'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1}})};};
 try{
  const status=new AgentModel(db).status('unlimited-student');
  assert.equal(status.unlimited,true);assert.equal(status.budgetRmb,null);assert.equal(status.remainingRmb,undefined);assert.equal(status.accountedRmb,500);
  assert.equal(model.status('limited-student').unlimited,false);assert.equal(model.status('limited-student').budgetRmb,30);
  await model.call([{role:'user',content:'test'}],{ownerId:'unlimited-student',cacheKey:'allowed'});
  await assert.rejects(model.call([{role:'user',content:'test'}],{ownerId:'limited-student',cacheKey:'blocked'}),/额度不足/);
  assert.equal(calls,1);assert.equal(db.prepare('SELECT count(*) AS n FROM ai_calls WHERE owner_id=?').get('unlimited-student').n,2);
 }finally{globalThis.fetch=originalFetch;db.close();}
});

test('streamed model calls account usage once, cache completed replies and never cache interrupted output',async()=>{
 const saver=SqliteSaver.fromConnString(':memory:'),db=saver.db,model=new AgentModel(db),originalFetch=globalThis.fetch;model.key=()=> 'test-only';
 let calls=0,truncate=false;
 globalThis.fetch=async(url,options)=>{
  calls++;const body=JSON.parse(options.body);assert.equal(body.stream,true);assert.equal(body.stream_options.include_usage,true);
  const frames=[{choices:[{delta:{content:'回答'}}]},...(truncate?[]:[{choices:[{delta:{content:'完成'},finish_reason:'stop'}]}]),{choices:[],usage:{prompt_tokens:10,completion_tokens:5}}];
  return new Response(frames.map(f=>'data: '+JSON.stringify(f)+'\n\n').join('')+(truncate?'':'data: [DONE]\n\n'),{headers:{'Content-Type':'text/event-stream'}});
 };
 try{
  const deltas=[],args={ownerId:'stream-user',cacheKey:'success',onDelta:d=>deltas.push(d.text)},messages=[{role:'user',content:'test'}];
  const result=await model.call(messages,args);assert.equal(result.content,'回答完成');assert.deepEqual(deltas,['回答','完成']);
  await model.call(messages,args);assert.equal(calls,1);assert.equal(deltas.length,2);assert.equal(model.status('stream-user').accountedRmb,0.0005);
  truncate=true;await assert.rejects(model.call(messages,{...args,cacheKey:'broken'}),/连接中断/);
  assert.equal(model.status('stream-user').accountedRmb,0.001);
  await assert.rejects(model.call(messages,{...args,cacheKey:'broken'}),/避免重复计费/);assert.equal(calls,2);
 }finally{globalThis.fetch=originalFetch;db.close();}
});
