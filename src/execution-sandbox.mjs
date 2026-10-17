import {projectDatasets} from './project-datasets.mjs';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
const systemEnv=()=>({PATH:'/usr/bin:/bin',LANG:'C.UTF-8',XDG_RUNTIME_DIR:`/run/user/${process.getuid()}`,DBUS_SESSION_BUS_ADDRESS:`unix:path=/run/user/${process.getuid()}/bus`});
export function sandboxArgs(root,input,unit,timeout,datasetDirectory=null){
  return ['--user','--scope','--quiet',`--unit=${unit}`,'-p','MemoryMax=512M','-p','MemorySwapMax=0','-p','TasksMax=32','-p','CPUQuota=100%', '-p',`RuntimeMaxSec=${timeout+10}s`,
    '/usr/bin/prlimit','--core=0','--fsize=16777216','--nofile=128',
    '/usr/bin/bwrap','--unshare-all','--unshare-user','--disable-userns','--new-session','--die-with-parent','--cap-drop','ALL','--clearenv',
    '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
    '--dir','/etc','--ro-bind-try','/etc/matplotlibrc','/etc/matplotlibrc','--ro-bind-try','/etc/alternatives','/etc/alternatives','--ro-bind-try','/etc/ld.so.cache','/etc/ld.so.cache','--ro-bind-try','/etc/fonts','/etc/fonts',
    '--proc','/proc','--dev','/dev','--size','67108864','--tmpfs','/workspace','--size','33554432','--tmpfs','/tmp',
    ...(datasetDirectory?['--ro-bind',datasetDirectory,'/workspace/datasets']:[]),
    '--ro-bind',input,'/input.json','--ro-bind',path.join(root,'runner'),'/runtime',
    '--setenv','PATH','/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','LANG','C.UTF-8','--setenv','MPLBACKEND','Agg','--setenv','MPLCONFIGDIR','/tmp/matplotlib',
    '--setenv','PYTHONPATH','/runtime','--setenv','OPENBLAS_NUM_THREADS','1','--setenv','OMP_NUM_THREADS','1',
    '--remount-ro','/','--chdir','/workspace','/usr/bin/python3','-I','/runtime/execute.py'];
}
export class ExecutionSandbox{
  constructor(root){this.root=root;this.cached=null;}
  health(){
    if(this.healthPromise)return this.healthPromise;
    this.healthPromise=this.checkHealth().finally(()=>{this.healthPromise=null;});return this.healthPromise;
  }
  async checkHealth(){
    if(this.cached&&Date.now()-this.cached.time<15000)return this.cached.value;
    try{
      const result=await this.execute({files:{},inputs:[],stdin:'',timeout:8,command:"gcc --version >/dev/null && cmake --version >/dev/null && python3 -c 'import matplotlib,numpy; print(\"ready\")'"});
      const available=result.exitCode===0&&result.stdout.trim()==='ready';
      const value={available,backend:'bubblewrap + systemd',message:available?'C11 / Python · matplotlib / NumPy 已就绪':'隔离执行环境未就绪，请管理员运行 npm run runner:check',limits:{seconds:60,memoryMB:512,workspaceMB:64,processes:32}};
      this.cached={time:Date.now(),value};return value;
    }catch{return {available:false,message:'隔离执行环境不可用，请管理员运行 npm run runner:check'};}
  }
  async execute(request,signal){
    if(process.platform!=='linux')throw Error('执行服务需要 Linux');
    const datasets=await projectDatasets(this.root,request.projectId);
    const directory=await mkdtemp(path.join(os.tmpdir(),'yuzhi-exec-')),input=path.join(directory,'input.json'),unit='yuzhi-run-'+randomUUID();
    await writeFile(input,JSON.stringify(request),{mode:0o600});
    try{return await new Promise((resolve,reject)=>{
      const child=spawn('/usr/bin/systemd-run',sandboxArgs(this.root,input,unit,request.timeout,datasets?.directory),{env:systemEnv(),stdio:['ignore','pipe','pipe']});
      let stdout=[],stderr=[],size=0,errSize=0,reason=null,ended=false;
      const stop=why=>{
        if(ended||reason)return;reason=why;
        const killer=spawn('/usr/bin/systemctl',['--user','stop',unit+'.scope'],{env:systemEnv(),stdio:'ignore'});killer.on('error',()=>{});
        child.kill('SIGKILL');
      };
      const abort=()=>stop('cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      const timer=setTimeout(()=>stop('timeout'),(request.timeout+6)*1000);
      child.stdout.on('data',chunk=>{size+=chunk.length;if(size>7*1024*1024)stop('output_limit');else stdout.push(chunk);});
      child.stderr.on('data',chunk=>{errSize+=chunk.length;if(errSize<32000)stderr.push(chunk);});
      child.on('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);ended=true;reject(error);});
      child.on('close',code=>{
        ended=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
        if(reason)return resolve({exitCode:null,reason,stdout:'',stderr:reason==='cancelled'?'运行已停止':'运行达到限制，已停止',artifacts:[]});
        try{
          const data=JSON.parse(Buffer.concat(stdout).toString());
          if(!Number.isInteger(data.exitCode)||typeof data.stdout!=='string'||typeof data.stderr!=='string'||!Array.isArray(data.artifacts))throw Error('invalid');
          resolve(data);
        }catch{resolve({exitCode:code,reason:'sandbox_error',stdout:'',stderr:'隔离进程未正常返回（可能达到内存限制或环境未就绪）。'+Buffer.concat(stderr).toString().slice(0,1200),artifacts:[]});}
      });
    });}finally{await rm(directory,{recursive:true,force:true});}
  }
}
