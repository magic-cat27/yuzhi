import { readModelStream } from './model-stream.mjs';
import { randomUUID } from 'node:crypto';
import { agentError, hashText } from './agent-policy.mjs';
export class AgentModel {
  constructor(db){
    this.db=db;this.model=process.env.AI_MODEL||'deepseek-v4-flash-0731';
    this.endpoint=process.env.AI_BASE_URL||'https://dashscope.aliyuncs.com/compatible-mode/v1';
    if(!this.endpoint.startsWith('https://'))throw Error('AI_BASE_URL 必须使用 HTTPS');
    this.limit=Number(process.env.AI_USER_BUDGET_RMB||30);
    if(!Number.isFinite(this.limit)||this.limit<=0)throw Error('AI_USER_BUDGET_RMB 必须为正数');
    db.exec(`CREATE TABLE IF NOT EXISTS ai_settings (id INTEGER PRIMARY KEY CHECK(id=1), api_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ai_calls (id TEXT PRIMARY KEY, cache_key TEXT UNIQUE, reserved REAL NOT NULL, cost REAL, response TEXT, created_at TEXT NOT NULL);`);
    if(!db.prepare('PRAGMA table_info(ai_calls)').all().some(column=>column.name==='owner_id'))db.exec('ALTER TABLE ai_calls ADD COLUMN owner_id TEXT');
    db.exec('CREATE INDEX IF NOT EXISTS ai_calls_owner ON ai_calls(owner_id)');
    db.exec(`CREATE TABLE IF NOT EXISTS ai_budget_grants (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, amount REAL NOT NULL CHECK(amount>0),
      reason TEXT NOT NULL, created_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS ai_budget_grants_owner ON ai_budget_grants(owner_id);`);
    db.exec(`CREATE TABLE IF NOT EXISTS ai_budget_policies (
      owner_id TEXT PRIMARY KEY, unlimited INTEGER NOT NULL CHECK(unlimited IN (0,1)),
      reason TEXT NOT NULL, updated_at TEXT NOT NULL
    );`);
  }
  key(){return process.env.AI_API_KEY||process.env.DASHSCOPE_API_KEY||this.db.prepare('SELECT api_key FROM ai_settings WHERE id=1').get()?.api_key;}
  spent(ownerId){return this.db.prepare('SELECT COALESCE(SUM(COALESCE(cost,reserved)),0) AS total FROM ai_calls'+(ownerId?' WHERE owner_id=?':'')).get(...(ownerId?[ownerId]:[])).total;}
  budget(ownerId){if(ownerId&&this.db.prepare('SELECT unlimited FROM ai_budget_policies WHERE owner_id=?').get(ownerId)?.unlimited)return null;return this.limit+(ownerId?this.db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM ai_budget_grants WHERE owner_id=?').get(ownerId).total:0);}
  status(ownerId){const spent=this.spent(ownerId),limit=this.budget(ownerId);return {configured:!!this.key(),model:this.model,budgetRmb:limit,unlimited:limit===null,budgetScope:'account',accountedRmb:Number(spent.toFixed(4)),...(ownerId&&limit!==null?{remainingRmb:Number(Math.max(0,limit-spent).toFixed(4))}:{})};}
  configure(apiKey){
    if(process.env.AI_API_KEY||process.env.DASHSCOPE_API_KEY)throw agentError(409,'当前密钥由服务端环境变量管理，请在部署配置中修改');
    if(typeof apiKey!=='string'||apiKey.length<12||apiKey.length>512||/[\s\x00-\x1f]/.test(apiKey))throw agentError(400,'请填写有效的百炼 API Key');
    this.db.prepare('INSERT OR REPLACE INTO ai_settings VALUES (1,?)').run(apiKey);return this.status();
  }
  async call(messages,{tools,maxTokens=6000,cacheKey,ownerId,onDelta}={}){
    if(typeof ownerId!=='string'||!ownerId.trim())throw agentError(400,'模型调用必须关联登录账号');
    if(!this.key())throw agentError(503,'AI 尚未配置，请联系教师在“AI 连接”中设置百炼密钥');
    const body={model:this.model,messages,max_tokens:maxTokens,enable_thinking:false,stream:!!onDelta,...(onDelta?{stream_options:{include_usage:true}}:{}),...(tools?{tools,tool_choice:'auto',parallel_tool_calls:false}:{})};
    const key=hashText(JSON.stringify([ownerId,cacheKey,body]));
    const cached=this.db.prepare('SELECT response FROM ai_calls WHERE cache_key=?').get(key);
    if(cached?.response)return JSON.parse(cached.response);
    if(cached)throw agentError(409,'上次模型请求结果未确认，为避免重复计费已暂停；请发送新消息重新尝试');
    // UTF-8 bytes are a deliberately conservative token upper bound; reserve above peak list rates.
    const bound=Buffer.byteLength(JSON.stringify(body))+2048;
    if(bound>110000)throw agentError(413,'本轮内容过大，请缩小文件读取范围或分步说明');
    const reserve=(bound*20+maxTokens*60)/1e6;
    const ident=randomUUID();
    this.db.transaction(()=>{
      const limit=this.budget(ownerId);
      if(limit!==null&&this.spent(ownerId)+reserve>limit)throw agentError(402,'你的 AI 累计额度不足，文件与轨迹已保留，请联系教师');
      this.db.prepare('INSERT INTO ai_calls (id,cache_key,reserved,cost,response,created_at,owner_id) VALUES (?,?,?,?,?,?,?)').run(ident,key,reserve,null,null,new Date().toISOString(),ownerId);
    })();
    try{
      const response=await fetch(this.endpoint.replace(/\/$/,'')+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.key()},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw agentError(502,`模型服务请求失败（${response.status}），请教师检查密钥、权限和额度`);
      const accountUsage=usage=>{if(Number.isFinite(usage?.prompt_tokens)&&Number.isFinite(usage?.completion_tokens))this.db.prepare('UPDATE ai_calls SET cost=? WHERE id=?').run((usage.prompt_tokens*20+usage.completion_tokens*60)/1e6,ident);};
      const result=onDelta?await readModelStream(response,onDelta,accountUsage):await response.json(),choice=result.choices?.[0];
      const usage=result.usage;
      const cost=Number.isFinite(usage?.prompt_tokens)&&Number.isFinite(usage?.completion_tokens)?(usage.prompt_tokens*20+usage.completion_tokens*60)/1e6:null;
      this.db.prepare('UPDATE ai_calls SET cost=? WHERE id=?').run(cost,ident);
      if(!choice?.message||choice.finish_reason==='length')throw agentError(502,'模型输出不完整，本轮未应用任何文件改动；请使用小文件或 edits 局部修改，不要重复提交整份大文件。');
      const message={role:'assistant',content:typeof choice.message.content==='string'?choice.message.content:'',...(choice.message.tool_calls?.length?{tool_calls:choice.message.tool_calls}: {})};
      this.db.prepare('UPDATE ai_calls SET cost=?,response=? WHERE id=?').run(cost,JSON.stringify(message),ident);
      return message;
    }catch(error){throw error.status?error:agentError(502,'模型连接中断或超时；原始对话已保留，本轮未确认的请求费用预留保留');}
  }
}
