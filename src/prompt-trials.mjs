import {ProjectCatalog,projectIdPattern,pointPlaceholder,validatePrompt} from './project-catalog.mjs';
import {agentError,hashText,projectPolicy} from './agent-policy.mjs';
export {pointPlaceholder};
export class PromptTrials {
  constructor(db,root){
    this.db=db;this.root=root;this.catalog=new ProjectCatalog(db,root);
    db.exec(`CREATE TABLE IF NOT EXISTS prompt_trial_settings (id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompt_trial_revisions (owner_id TEXT NOT NULL,project_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT,created_at TEXT NOT NULL,PRIMARY KEY(owner_id,project_id,version));
      CREATE TABLE IF NOT EXISTS prompt_run_snapshots (run_id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,project_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT,policy TEXT NOT NULL,policy_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompt_trial_access_log (id INTEGER PRIMARY KEY,enabled INTEGER NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL);`);
  }
  settings(){const row=this.db.prepare('SELECT * FROM prompt_trial_settings WHERE id=1').get();return {enabled:row?.enabled===1,updatedAt:row?.updated_at||null};}
  configure(enabled,actor){
    if(typeof enabled!=='boolean')throw agentError(400,'请选择开启或关闭');
    this.db.transaction(()=>{
      const now=new Date().toISOString();
      this.db.prepare('INSERT OR REPLACE INTO prompt_trial_settings VALUES (1,?,?,?)').run(Number(enabled),actor,now);
      this.db.prepare('INSERT INTO prompt_trial_access_log(enabled,actor,created_at) VALUES (?,?,?)').run(Number(enabled),actor,now);
    })();return this.settings();
  }
  validateProject(projectId){if(!projectIdPattern.test(projectId))throw agentError(400,'项目无效');}
  latest(owner,project){return this.db.prepare('SELECT version,body,created_at AS createdAt FROM prompt_trial_revisions WHERE owner_id=? AND project_id=? ORDER BY version DESC LIMIT 1').get(owner,project)||{version:0,body:null};}
  async view(owner,project){
    this.validateProject(project);
    if(!this.settings().enabled)throw agentError(403,'教师已关闭提示词试用，后续新对话使用默认提示词');
    const defaultBody=(await this.catalog.get(project)).prompt;
    // Never include the expanded private focus list or runtime policy in this response.
    return {enabled:true,defaultBody,...this.latest(owner,project),history:this.db.prepare('SELECT version,body,created_at AS createdAt FROM prompt_trial_revisions WHERE owner_id=? AND project_id=? ORDER BY version DESC LIMIT 30').all(owner,project)};
  }
  async save(owner,project,{body,expectedVersion}){
    await this.catalog.get(project);
    this.validateProject(project);
    if(!Number.isSafeInteger(expectedVersion)||expectedVersion<0)throw agentError(400,'版本无效，请重新打开编辑器');
    if(body!==null)validatePrompt(body);
    return this.db.transaction(()=>{
      if(!this.settings().enabled)throw agentError(403,'教师已关闭提示词试用');
      const current=this.latest(owner,project);
      if(current.version!==expectedVersion)throw agentError(409,'另一个窗口已更新此提示词；请复制未保存内容，重新打开后再合并');
      if(current.body===body)return current;
      const next={version:current.version+1,body,createdAt:new Date().toISOString()};
      this.db.prepare('INSERT INTO prompt_trial_revisions VALUES (?,?,?,?,?)').run(owner,project,next.version,body,next.createdAt);return next;
    })();
  }
  async snapshot(runId,owner,project){
    let row=this.db.prepare('SELECT * FROM prompt_run_snapshots WHERE run_id=?').get(runId);
    if(!row){
      const current=this.settings().enabled?this.latest(owner,project):{version:0,body:null};
      const policy=await projectPolicy(this.root,project,current.body,await this.catalog.get(project));
      this.db.prepare('INSERT OR IGNORE INTO prompt_run_snapshots VALUES (?,?,?,?,?,?,?)').run(runId,owner,project,current.version,current.body,policy,hashText(policy));
      row=this.db.prepare('SELECT * FROM prompt_run_snapshots WHERE run_id=?').get(runId);
    }
    if(row.owner_id!==owner||row.project_id!==project)throw agentError(403,'提示词版本与作答不匹配');
    return row;
  }
}
