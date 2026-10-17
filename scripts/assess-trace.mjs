import { readFile,writeFile,lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { AgentModel } from '../src/agent-model.mjs';
import { assessTrace,normalizeTrace,traceHash,RUBRIC_VERSION } from '../src/process-assessment.mjs';
import { randomUUID } from 'node:crypto';
// Explicit CLI paths only; the HTTP API never exposes arbitrary filesystem reads.
const [input,output,...rest]=process.argv.slice(2),ownerId=rest[0];
if(!input||!output||!ownerId){console.error('用法：node --env-file-if-exists=.env scripts/assess-trace.mjs <原始轨迹.json> <评价输出.json> <教师账号ID>');process.exitCode=1;}
else{
  let saver;
  try{
    if(path.resolve(input)===path.resolve(output))throw Error('输出路径不能覆盖原始轨迹');
    try{await lstat(output);throw Error('输出文件已存在，请使用新的输出路径');}catch(e){if(e.code!=='ENOENT')throw e;}
    const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),raw=JSON.parse(await readFile(input,'utf8')),trace=normalizeTrace(raw);
    // Share the web model ledger and configured key; do not create an unrelated budget.
    saver=SqliteSaver.fromConnString(path.join(process.env.AGENT_DATA_DIR||path.join(root,'data/agent'),'agent.sqlite'));
    const model=new AgentModel(saver.db),jobId=randomUUID();
    const result=await assessTrace({raw,problem:await readFile(path.join(root,'problem',trace.projectId+'.txt'),'utf8'),model,ownerId,jobId,onProgress:async p=>console.error(`${p.phase}: ${p.done}/${p.total}`)});
    await writeFile(output,JSON.stringify({id:jobId,rubricVersion:RUBRIC_VERSION,sourceHash:traceHash(raw),sourceEventCount:trace.events.length,model:model.status().model,createdAt:new Date().toISOString(),result},null,2),{flag:'wx',mode:0o600});
    console.log(`评价已保存：${path.resolve(output)}`);
  }catch(e){console.error(e.status?e.message:'评价失败：'+e.message);process.exitCode=1;}finally{saver?.db.close();}
}
