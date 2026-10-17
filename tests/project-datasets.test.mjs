import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {projectDatasets,datasetInstructions} from '../src/project-datasets.mjs';
import {sandboxArgs,ExecutionSandbox} from '../src/execution-sandbox.mjs';
import {prepareRun,ExecutionService} from '../src/execution-service.mjs';
import {validFile} from '../src/agent-policy.mjs';
import {TraceStore} from '../src/trace-store.mjs';

test('datasets require installed manifest, stay project-scoped and cannot be source files',async()=>{
 const root=await mkdtemp('/tmp/yuzhi-datasets-');
 try{
  assert.equal(await projectDatasets(root,'project2'),null);
  const directory=root+'/data/datasets/project2';await mkdir(directory+'/files',{recursive:true});
  const name='USA-road-d.NY.gr';await writeFile(directory+'/files/'+name,'p sp 2 1\na 1 2 3\n');
  await writeFile(directory+'/manifest.json',JSON.stringify({source:'https://www.diag.uniroma1.it/challenge9/download.shtml',files:[{name,bytes:17,sha256:'fixture'}]}));
  assert.equal(await projectDatasets(root,'project1'),null);
  assert.equal(await projectDatasets(root,'../../etc'),null);
  const datasets=await projectDatasets(root,'project2');assert.equal(datasets.files[0].path,'datasets/'+name);
  assert.match(datasetInstructions(datasets),/共享只读/);
  const args=sandboxArgs(root,'/tmp/input','test',5,datasets.directory);
  const i=args.indexOf(datasets.directory);assert.equal(args[i-1],'--ro-bind');assert.equal(args[i+1],'/workspace/datasets');
  assert.ok(!sandboxArgs(root,'/tmp/input','test',5).includes('/workspace/datasets'));
  assert.equal(validFile('datasets/'+name),false);
  assert.throws(()=>prepareRun({['datasets/'+name]:'x'},{mode:'command',command:'true'}),/路径/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('execution project selection comes from the owned trace, ignoring client project or mount paths',async()=>{
 const root=await mkdtemp('/tmp/yuzhi-dataset-owner-'),traces=new TraceStore(root+'/traces'),owner=crypto.randomUUID(),id=crypto.randomUUID();
 await traces.append(id,{studentId:owner,projectId:'project2',events:[{id:crypto.randomUUID(),timestamp:new Date().toISOString(),actor:'student',type:'session_started',payload:{files:{'main.c':'int main(void){return 0;}'}}}]},owner);
 let observed;
 const service=new ExecutionService({root,traces,directory:root+'/runs',sandbox:{health:async()=>({available:true}),execute:async request=>{observed=request;return {exitCode:0,stdout:'',stderr:'',artifacts:[]};}}});
 try{
  const run=await service.start(id,owner,{mode:'command',command:'true',projectId:'project1',datasetDirectory:'/etc'});await service.wait(run.id,{id:owner});
  assert.equal(observed.projectId,'project2');assert.equal(observed.datasetDirectory,undefined);
 }finally{service.close();await rm(root,{recursive:true,force:true});}
});

test('installed road files are readable, read-only and isolated in a real project2 sandbox',{skip:process.env.YUZHI_TEST_EXECUTION!=='1'},async()=>{
 const root=new URL('..',import.meta.url).pathname,sandbox=new ExecutionSandbox(root);
 const run=(projectId,command)=>sandbox.execute({projectId,files:{},inputs:[],stdin:'',timeout:10,command});
 const result=await run('project2',"head -n 8 datasets/USA-road-d.NY.gr && head -n 8 datasets/USA-road-d.USA.gr && test ! -w datasets/USA-road-d.NY.gr && test ! -e /home/magic-cat/yuzhi-ai/data/auth && ! touch datasets/should-not-exist");
 assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/264346/);assert.match(result.stdout,/23947347/);
 assert.match(result.stderr,/Read-only file system/);
 assert.equal((await run('project1','test ! -e datasets')).exitCode,0);
});
