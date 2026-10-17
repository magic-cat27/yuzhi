import {projectDatasets} from './src/project-datasets.mjs';
import {attachAgentWebSocket} from './src/agent-websocket.mjs';
import {projectPolicy} from './src/agent-policy.mjs';
import {serveAgentStream} from './src/agent-stream.mjs';

import { filesAt } from './public/trace.js';
import { ExecutionService } from './src/execution-service.mjs';
import { AgentRuntime } from './src/agent-runtime.mjs';
import { AssessmentService } from './src/assessment-service.mjs';
import { StudentMemory } from './src/student-memory.mjs';
import http from 'node:http';
import { AuthStore, authError } from './src/auth-store.mjs';
import { TraceStore } from './src/trace-store.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));

const json = (res, status, value) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}); res.end(JSON.stringify(value)); };
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
export function createApp(options={}) {
  const origin=options.origin||process.env.APP_ORIGIN;
  const production=options.production??(process.env.NODE_ENV==='production');
  if(production&&(!origin||new URL(origin).protocol!=='https:'))throw new Error('生产环境必须设置 HTTPS APP_ORIGIN');
  if(origin&&new URL(origin).origin!==origin)throw new Error('APP_ORIGIN 应为完整站点来源，不带路径或末尾斜杠');
  const secure=!!origin?.startsWith('https:');
  const cookieName=secure?'__Host-yuzhi_session':'yuzhi_session';
  const auth=new AuthStore(options.authDirectory||process.env.AUTH_DATA_DIR||path.join(root,'data/auth'),{inviteOnly:options.inviteOnly??process.env.REGISTRATION_MODE==='invite'});
  const traces=new TraceStore(options.traceDirectory||process.env.TRACE_DATA_DIR||path.join(root,'data/traces'));
  const execution=new ExecutionService({root,traces,directory:options.runDirectory||process.env.RUN_DATA_DIR||(options.authDirectory?path.join(options.authDirectory,'../runs'):path.join(root,'data/runs')),sandbox:options.executionSandbox});
  const agent=new AgentRuntime({root,traces,execution,directory:options.agentDirectory||process.env.AGENT_DATA_DIR||(options.authDirectory?path.join(options.authDirectory,'../agent'):path.join(root,'data/agent')),model:options.agentModel});
  const assessments=new AssessmentService({root,traces,model:options.assessmentModel||agent.model,directory:options.assessmentDirectory||process.env.ASSESSMENT_DATA_DIR||(options.authDirectory?path.join(options.authDirectory,'../assessments'):path.join(root,'data/assessments'))});
  const memories=new StudentMemory({traces,assessments,model:options.memoryModel||agent.model,directory:options.memoryDirectory||process.env.MEMORY_DATA_DIR||(options.authDirectory?path.join(options.authDirectory,'../memory'):path.join(root,'data/memory'))});
  agent.memories=memories;
  const catalog=agent.promptTrials.catalog;assessments.catalog=catalog;
  const cookie=(res,token,maxAge=604800)=>res.setHeader('Set-Cookie',`${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?'; Secure':''}`);
  const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Frame-Options','DENY');
  if(secure)res.setHeader('Strict-Transport-Security','max-age=31536000');
  try {
    const url = new URL(req.url, 'http://localhost');
    const token=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
    const session=auth.session(token);
    const requireUser=()=>{if(!session?.user)throw authError(401,'请先登录');return session.user;};
    const requireTeacher=()=>{const user=requireUser();if(user.role!=='teacher')throw authError(403,'仅教师可以查看作答记录');return user;};
    if(req.method==='POST') {
      const allowed=origin||`http://127.0.0.1:${server.address().port}`;
      if(req.headers.origin!==allowed)throw authError(403,'请求来源不匹配，请从本站页面操作');
      if(req.headers['content-type']?.split(';')[0]!=='application/json')throw authError(415,'请使用 JSON 请求');
      const isAuth=['/api/auth/login','/api/auth/register','/api/auth/setup-teacher'].includes(url.pathname);
      if(!isAuth){requireUser();if(req.headers['x-csrf-token']!==session.csrf)throw authError(403,'会话已变化，请刷新页面后重试');}
      if(isAuth) {
        let ip=req.socket.remoteAddress;
        // Enable only behind a trusted, local reverse proxy that overwrites this header.
        if(process.env.TRUST_PROXY==='loopback'&&['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip))ip=req.headers['x-real-ip']||ip;
        auth.throttle('auth:'+ip,300);
        req.authRateKey=ip;
      }
      const limit=isAuth?8192:4*1024*1024;
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>limit)throw authError(413,'请求内容过大');chunks.push(chunk);}
      let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw authError(400,'请求格式无效');}
      if(!input||typeof input!=='object'||Array.isArray(input))throw authError(400,'请求格式无效');
      if(isAuth){
        auth.throttle('account:'+req.authRateKey+':'+String(input.username||'').trim().toLowerCase(),10);
        const user=url.pathname==='/api/auth/login'?await auth.login(input):await auth.register(input,url.pathname==='/api/auth/setup-teacher');
        auth.logout(token);
        const next=auth.createSession(user);cookie(res,next.token);
        return json(res,url.pathname==='/api/auth/login'?200:201,{user,csrf:next.csrf});
      }
      if(url.pathname==='/api/attempts'){
        const user=requireUser(),template=await catalog.get(input.projectId);
        if(!template||!/^[-a-f0-9]{36}$/.test(input.requestId||''))throw authError(400,'项目或作答请求编号无效');
        auth.throttle('attempt:'+user.id,30);
        await traces.createAttempt(input.requestId,template,user.id);
        return json(res,201,{id:input.requestId});
      }
      const runStart=url.pathname.match(/^\/api\/execution\/([a-zA-Z0-9_-]{8,80})$/);
      if(runStart){const user=requireUser();auth.throttle('run:'+user.id,120);return json(res,202,await execution.start(runStart[1],user.id,input));}
      const runCancel=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/cancel$/);
      if(runCancel)return json(res,200,await execution.cancel(runCancel[1],requireUser().id));
      const projectSave=url.pathname.match(/^\/api\/teacher\/projects(?:\/(project[1-9][0-9]{0,5}))?$/);
      if(projectSave){const teacher=requireTeacher();auth.throttle('projects:'+teacher.id,60);return json(res,200,await catalog.save(projectSave[1]||null,input,teacher.id));}
      if(url.pathname==='/api/teacher/prompt-trials'){const teacher=requireTeacher();return json(res,200,agent.promptTrials.configure(input.enabled,teacher.id));}
      const promptSave=url.pathname.match(/^\/api\/prompt-trials\/(project[1-9][0-9]{0,5})$/);
      if(promptSave){const user=requireUser();auth.throttle('prompt:'+user.id,60);return json(res,200,await agent.promptTrials.save(user.id,promptSave[1],input));}
      if(url.pathname==='/api/teacher/ai-settings'){requireTeacher();return json(res,200,agent.model.configure(input.apiKey));}
      const memoryAction=url.pathname.match(/^\/api\/teacher\/students\/([a-zA-Z0-9_-]{8,80})\/memory(?:\/([a-zA-Z0-9_-]{8,80}))?$/);
      if(memoryAction){const teacher=requireTeacher();if(!auth.user(memoryAction[1]))throw authError(404,'学生账号不存在');auth.throttle('memory:'+teacher.id,60);return json(res,memoryAction[2]?200:202,memoryAction[2]?await memories.review(memoryAction[1],memoryAction[2],teacher.id,input):await memories.generate(memoryAction[1],input.traceId,teacher.id));}
      const assessmentAction=url.pathname.match(/^\/api\/teacher\/records\/([a-zA-Z0-9_-]{8,80})\/assessment(\/review)?$/);
      if(assessmentAction){const teacher=requireTeacher();auth.throttle('assessment:'+teacher.id,30);return json(res,assessmentAction[2]?200:202,assessmentAction[2]?await assessments.review(assessmentAction[1],teacher.id,input):await assessments.start(assessmentAction[1],teacher.id,input));}
      const agentAction=url.pathname.match(/^\/api\/agent\/([a-zA-Z0-9_-]{8,80})\/(message|decision|resume)$/);
      if(agentAction){
        const user=requireUser();auth.throttle('agent:'+user.id,90);
        const [,id,action]=agentAction;
        return json(res,202,action==='message'?await agent.start(id,user.id,input.messageId):action==='decision'?await agent.decide(id,user.id,input.proposalId,input.approved):await agent.resume(id,user.id));
      }
      if(url.pathname==='/api/auth/logout'){auth.logout(token);cookie(res,'',0);return json(res,200,{ok:true});}
      const match=url.pathname.match(/^\/api\/traces\/([a-zA-Z0-9_-]{8,80})\/events$/);
      if(match){
        const user=requireUser();
        // Ownership and identity come from the session, never from the request body.
        if(input.studentId!==user.id)throw authError(403,'记录与当前登录账号不匹配，请重新登录原账号');
        return json(res,200,await traces.append(match[1],{...input,studentId:user.id},user.id));
      }
      throw authError(404,'接口不存在');
    }
    if(req.method!=='GET'&&req.method!=='HEAD')throw authError(405,'不支持的请求方法');
    if(url.pathname==='/api/attempts'){
      const user=requireUser(),records=await traces.list();
      return json(res,200,records.filter(r=>r.ownerId===user.id&&(!url.searchParams.get('projectId')||r.projectId===url.searchParams.get('projectId'))));
    }
    const attemptMatch=url.pathname.match(/^\/api\/attempts\/([a-zA-Z0-9_-]{8,80})$/);
    if(attemptMatch){
      const user=requireUser(),record=await traces.get(attemptMatch[1]);
      if(record.ownerId!==user.id)throw authError(403,'无权访问这份作答');
      const info=(await traces.list()).find(r=>r.id===record.id);
      return json(res,200,{...record,attemptNumber:info.attemptNumber,files:filesAt(record)});
    }
    if(url.pathname==='/api/execution/status'){requireUser();return json(res,200,await execution.sandbox.health());}
    const runList=url.pathname.match(/^\/api\/execution\/([a-zA-Z0-9_-]{8,80})$/);
    if(runList)return json(res,200,await execution.list(runList[1],requireUser()));
    const runGet=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})$/);
    if(runGet)return json(res,200,await execution.get(runGet[1],requireUser()));
    const artifact=url.pathname.match(/^\/api\/runs\/([a-f0-9-]{36})\/artifacts\/([a-f0-9-]{36})$/);
    if(artifact){
      const {item,data}=await execution.artifact(artifact[1],artifact[2],requireUser());
      const inline=url.searchParams.get('preview')==='1'&&['image/png','image/jpeg'].includes(item.mime);
      res.writeHead(200,{'Content-Type':item.mime,'Cache-Control':'private, no-store','Content-Security-Policy':"sandbox; default-src 'none'",'Content-Disposition':`${inline?'inline':'attachment'}; filename*=UTF-8''${encodeURIComponent(item.name.split('/').at(-1))}`});
      return res.end(req.method==='HEAD'?undefined:data);
    }

    if(url.pathname==='/api/projects'){requireUser();return json(res,200,await Promise.all((await catalog.list()).map(async p=>{const datasets=await projectDatasets(root,p.id);return {...catalog.public(p),datasets:datasets?{source:datasets.source,files:datasets.files}:null};})));}
    if(url.pathname==='/api/teacher/projects'){requireTeacher();return json(res,200,{projects:await catalog.list(),defaultPrompt:await catalog.basePrompt()});}
    const policyGet=url.pathname.match(/^\/api\/teacher\/projects\/(project[1-9][0-9]{0,5})\/policy$/);
    if(policyGet){requireTeacher();const definition=await catalog.get(policyGet[1]);return json(res,200,{policy:await projectPolicy(root,definition.id,null,definition)});}
    const projectGet=url.pathname.match(/^\/api\/teacher\/projects\/(project[1-9][0-9]{0,5})$/);
    if(projectGet){requireTeacher();return json(res,200,{project:await catalog.get(projectGet[1]),history:catalog.history(projectGet[1])});}
    if(url.pathname==='/api/teacher/prompt-trials'){requireTeacher();return json(res,200,agent.promptTrials.settings());}
    const promptGet=url.pathname.match(/^\/api\/prompt-trials\/(project[1-9][0-9]{0,5})$/);
    if(promptGet)return json(res,200,await agent.promptTrials.view(requireUser().id,promptGet[1]));
    if(url.pathname==='/api/teacher/ai-settings'){requireTeacher();return json(res,200,agent.model.status());}
    const liveSnapshot=url.pathname.match(/^\/api\/agent\/([a-zA-Z0-9_-]{8,80})\/live$/);
    if(liveSnapshot){const user=requireUser();await agent.record(liveSnapshot[1],user.id);return json(res,200,agent.live.get(liveSnapshot[1])||null);}
    const liveMatch=url.pathname.match(/^\/api\/agent\/([a-zA-Z0-9_-]{8,80})\/stream$/);
    if(liveMatch){
      const user=requireUser();await agent.record(liveMatch[1],user.id);
      if(req.method!=='GET')throw authError(405,'不支持的请求方法');
      return serveAgentStream({req,res,agent,id:liveMatch[1],auth,token,ownerId:user.id});
    }
    const agentState=url.pathname.match(/^\/api\/agent\/([a-zA-Z0-9_-]{8,80})$/);
    if(agentState)return json(res,200,await agent.status(agentState[1],requireUser().id));
    if(url.pathname==='/api/ai/status'){requireUser();const info=agent.model.status();return json(res,200,{configured:info.configured,model:info.model});}
    if(url.pathname==='/api/auth/me')return json(res,200,session||{user:null});
    const memoryGet=url.pathname.match(/^\/api\/teacher\/students\/([a-zA-Z0-9_-]{8,80})\/memory(\/export)?$/);
    if(memoryGet){requireTeacher();if(!auth.user(memoryGet[1]))throw authError(404,'学生账号不存在');if(memoryGet[2])res.setHeader('Content-Disposition',`attachment; filename="memory-${memoryGet[1]}.json"`);return json(res,200,await memories.status(memoryGet[1]));}
    if(url.pathname==='/api/teacher/records'){
      requireTeacher();const records=await traces.list();
      return json(res,200,await Promise.all(records.map(async record=>{const result={...record,student:record.ownerId?auth.user(record.ownerId):null};if(url.searchParams.get('view')==='assessments'){const state=await assessments.status(record.id),latest=state.attempts.at(-1);result.assessment=latest?{status:latest.status,stale:latest.stale,reviewed:!!latest.reviews.length,total:(latest.reviews.at(-1)?.result||latest.result)?.total}:null;}return result;})));
    }
    const assessmentGet=url.pathname.match(/^\/api\/teacher\/records\/([a-zA-Z0-9_-]{8,80})\/assessment(\/export)?$/);
    if(assessmentGet){requireTeacher();if(assessmentGet[2])res.setHeader('Content-Disposition',`attachment; filename="assessment-${assessmentGet[1]}.json"`);return json(res,200,await assessments.status(assessmentGet[1]));}
    const recordMatch=url.pathname.match(/^\/api\/teacher\/records\/([a-zA-Z0-9_-]{8,80})(\/export)?$/);
    if(recordMatch){
      requireTeacher();const record=await traces.get(recordMatch[1]);
      record.student=record.ownerId?auth.user(record.ownerId):null;
      record.attemptNumber=(await traces.list()).find(r=>r.id===record.id)?.attemptNumber;
      if(recordMatch[2])res.setHeader('Content-Disposition',`attachment; filename="trace-${record.id}.json"`);
      return json(res,200,record);
    }
    let base = path.join(root, 'public');
    let name = decodeURIComponent(url.pathname);
    if (/^\/api\/problems\/project[1-9][0-9]{0,5}$/.test(name)) {
      requireUser();
      const content = (await catalog.get(name.split('/').at(-1))).problem;
      res.writeHead(200, { 'Content-Type': types['.json'] });
      return res.end(JSON.stringify({ content }));
    }
    if (name.startsWith('/vendor/')) { base = path.join(root, 'node_modules/monaco-editor/min'); name = name.slice('/vendor'.length); }
    if (name === '/') name = '/index.html';
    const file = path.resolve(base, '.' + name);
    if (!file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch(e) { json(res,e.status || (e.code==='ENOENT'?404:500),{error:e.status?e.message:e.code==='ENOENT'?'记录或文件不存在':'读取或保存失败，请重试'}); }
});
  attachAgentWebSocket({server,agent,auth,origin,cookieName});
  server.on('close',()=>{execution.close();auth.close();Promise.all([assessments.close(),memories.close()]).finally(()=>agent.close());});
  return server;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const server=createApp();
  server.listen(Number(process.env.PORT||4173),process.env.HOST||'127.0.0.1',()=>console.log(`驭智: ${process.env.APP_ORIGIN||`http://127.0.0.1:${server.address().port}`}`));
}
