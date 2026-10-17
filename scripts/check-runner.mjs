import {ExecutionSandbox} from '../src/execution-sandbox.mjs';
const sandbox=new ExecutionSandbox(new URL('..',import.meta.url).pathname);
const status=await sandbox.health();console.log(JSON.stringify(status,null,2));
if(!status.available){
  const detail=await sandbox.execute({files:{},inputs:[],stdin:'',timeout:8,command:"gcc --version && cmake --version && python3 -c 'import matplotlib,numpy; print(matplotlib.__version__,numpy.__version__)'"}).catch(()=>({stderr:'缺少运行依赖或用户命名空间 / systemd 用户会话不可用'}));
  console.error(detail.stderr);process.exitCode=1;
}
