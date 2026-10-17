import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {ExecutionService,prepareRun} from '../src/execution-service.mjs';
import {ExecutionSandbox,sandboxArgs} from '../src/execution-sandbox.mjs';
import {TraceStore} from '../src/trace-store.mjs';
import {filesAt} from '../public/trace.js';
const root=new URL('..',import.meta.url).pathname;
const ev=(type,payload)=>({id:crypto.randomUUID(),timestamp:new Date().toISOString(),actor:'student',type,payload});
test('execution requests validate source paths and isolate shell commands behind fixed sandbox arguments',()=>{
 assert.throws(()=>prepareRun({'../secret':'x'},{mode:'c'}),/路径/);
 assert.throws(()=>prepareRun({'artifacts/a.csv':'x'},{mode:'c'}),/路径/);
 assert.throws(()=>prepareRun({'x.c':'x'},{mode:'command',command:'echo test',timeout:61}),/1–60/);
 assert.throws(()=>prepareRun({'x.c':'x'},{mode:'python',file:'../x.py'}),/Python/);
 const options=sandboxArgs(root,'/tmp/input','unit',60).join(' ');
 for(const expected of ['--unshare-all','--unshare-user','--disable-userns','MemoryMax=512M','TasksMax=32','MemorySwapMax=0','--remount-ro /','--clearenv'])assert.ok(options.includes(expected));
 assert.ok(!options.includes('--share-net'));
});
test('runs keep immutable snapshots, cross-account permissions, artifact handoff and authenticated events',async()=>{
 const directory=await mkdtemp('/tmp/yuzhi-run-test-'),traces=new TraceStore(directory+'/traces'),owner=crypto.randomUUID(),id=crypto.randomUUID();
 const initial={'main.c':'int main(void){return 0;}'};
 await traces.append(id,{studentId:owner,projectId:'project1',events:[ev('session_started',{files:initial})]},owner);
 let calls=0;
 const sandbox={health:async()=>({available:true}),execute:async request=>{
  calls++;if(calls===2)assert.equal(request.inputs[0].name,'result.csv');
  return {exitCode:0,stdout:'real output fixture',stderr:'',artifacts:[{name:'result.csv',data:Buffer.from('x,y\n1,2\n').toString('base64')}]};
 }};
 const service=new ExecutionService({root,directory:directory+'/runs',traces,sandbox});
 try{
  await assert.rejects(service.start(id,'other',{mode:'c'}),/无权/);
  const run=await service.start(id,owner,{mode:'c'});await service.wait(run.id,{id:owner});
  const done=await service.get(run.id,{id:owner});assert.equal(done.status,'succeeded');assert.equal(done.sourceSequence,1);
  assert.deepEqual(await service.source(run.id,{id:owner}),initial);
  assert.equal(Object.hasOwn(done,'files'),false);
  await assert.rejects(service.get(run.id,{id:'other'}),/无权/);
  await assert.rejects(service.artifact(run.id,done.artifacts[0].id,{id:'other'}),/无权/);
  assert.equal((await service.artifact(run.id,done.artifacts[0].id,{id:'teacher',role:'teacher'})).data.toString(),'x,y\n1,2\n');
  const next=await service.start(id,owner,{mode:'command',command:'cat artifacts/result.csv'},'ai','stable-tool-call');await service.wait(next.id,{id:owner});
  const retry=await service.start(id,owner,{mode:'command',command:'cat artifacts/result.csv'},'ai','stable-tool-call');assert.equal(retry.id,next.id);assert.equal(calls,2);
  const record=await traces.get(id);assert.deepEqual(filesAt(record),initial);
  assert.equal(record.events.filter(e=>e.type==='execution_finished').length,2);
  assert.equal(record.events.at(-1).actor,'ai');assert.equal(record.events.at(-1).origin,'runner');
  await assert.rejects(traces.append(id,{studentId:owner,projectId:'project1',events:[ev('execution_finished',{status:'succeeded'})]},owner),/无效/);
 }finally{service.close();await rm(directory,{recursive:true,force:true});}
});
test('actual sandbox compiles C with stdin, hands CSV to Python and exports a PNG without touching source', {skip:process.env.YUZHI_TEST_EXECUTION!=='1'},async()=>{
 const sandbox=new ExecutionSandbox(root);assert.equal((await sandbox.health()).available,true);
 const c=await sandbox.execute({files:{'main.c':'#include <stdio.h>\nint main(void){int n;scanf("%d",&n);FILE*f=fopen("artifacts/data.csv","w");fprintf(f,"n,t\\n%d,2\\n",n);fclose(f);printf("n=%d\\n",n);return 0;}'},inputs:[],stdin:'5\n',timeout:10,command:'gcc -std=c11 main.c -o /tmp/main && /tmp/main'});
 assert.equal(c.exitCode,0);assert.equal(c.stdout,'n=5\n');assert.equal(c.artifacts[0].name,'data.csv');
 const py=await sandbox.execute({files:{'plot.py':'import csv\nimport matplotlib.pyplot as plt\nwith open("artifacts/data.csv") as f: r=list(csv.DictReader(f))\nplt.plot([int(x["n"]) for x in r],[float(x["t"]) for x in r],"o-")\nplt.show()\n'},inputs:c.artifacts,stdin:'',timeout:10,command:'python3 plot.py'});
 assert.equal(py.exitCode,0);const figure=py.artifacts.find(a=>a.name==='figure-1.png');assert.ok(figure);assert.equal(Buffer.from(figure.data,'base64').subarray(1,4).toString(),'PNG');
});
test('actual sandbox blocks host files/network and stops timeouts, output floods and cancellation',{skip:process.env.YUZHI_TEST_EXECUTION!=='1'},async()=>{
 const sandbox=new ExecutionSandbox(root),run=command=>sandbox.execute({files:{},inputs:[],stdin:'',timeout:2,command});
 const isolated=await run("test ! -e /home/magic-cat/yuzhi-ai/data/agent/agent.sqlite && test ! -e /run/user/1000/bus && test ! -e /var/run/docker.sock && test -z \"$AI_API_KEY\" && python3 -c 'import socket; s=socket.socket(); s.settimeout(.2); print(s.connect_ex((\"1.1.1.1\",80))!=0)'");
 assert.equal(isolated.exitCode,0);assert.equal(isolated.stdout.trim(),'True');
 const timeout=await run('while :; do :; done');assert.equal(timeout.reason,'timeout');
 const flood=await run('yes overflow');assert.equal(flood.reason,'output_limit');assert.ok(flood.stdout.length<=131072);
 const controller=new AbortController(),pending=sandbox.execute({files:{},inputs:[],stdin:'',timeout:10,command:'sleep 30'},controller.signal);setTimeout(()=>controller.abort(),400);
 assert.equal((await pending).reason,'cancelled');
 const failure=await run('gcc missing.c -o /tmp/main');assert.notEqual(failure.exitCode,0);assert.match(failure.stderr,/missing.c/);
});
