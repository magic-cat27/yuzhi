import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {projects} from '../public/projects.js';
import {agentError} from './agent-policy.mjs';
export const projectIdPattern=/^project[1-9][0-9]{0,5}$/;
export const pointPlaceholder='[在此填入本实验的重点模块/任务]';
export function validatePrompt(body){if(typeof body!=='string'||!body.trim()||Buffer.byteLength(body)>24000||body.split(pointPlaceholder).length!==2)throw agentError(400,'提示词须为非空文本、最多 24 KB，并保留且仅保留一个考点占位符');}
export class ProjectCatalog {
  constructor(db,root){this.db=db;this.root=root;db.exec(`CREATE TABLE IF NOT EXISTS project_revisions (project_id TEXT NOT NULL,version INTEGER NOT NULL,definition TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,version));`);}
  async basePrompt(){return readFile(path.join(this.root,'prompt/AGENTS.md'),'utf8');}
  async get(id){
    if(!projectIdPattern.test(id))throw agentError(400,'项目编号无效');
    const row=this.db.prepare('SELECT * FROM project_revisions WHERE project_id=? ORDER BY version DESC LIMIT 1').get(id);
    if(row)return {...JSON.parse(row.definition),version:row.version,updatedAt:row.created_at};
    const template=projects.find(p=>p.id===id);if(!template)throw agentError(404,'项目不存在');
    const [prompt,points,problem]=await Promise.all([this.basePrompt(),readFile(path.join(this.root,`point/${id}_考点.txt`),'utf8'),readFile(path.join(this.root,`problem/${id}.txt`),'utf8')]);
    return {...template,version:0,prompt,points,problem};
  }
  async list(){const ids=[...new Set([...projects.map(p=>p.id),...this.db.prepare('SELECT DISTINCT project_id FROM project_revisions').all().map(r=>r.project_id)])];return Promise.all(ids.sort((a,b)=>Number(a.slice(7))-Number(b.slice(7))).map(id=>this.get(id)));}
  public(def){const {prompt,points,...safe}=def;return safe;}
  history(id){return this.db.prepare('SELECT version,definition,created_at AS createdAt FROM project_revisions WHERE project_id=? ORDER BY version DESC LIMIT 20').all(id).map(r=>({version:r.version,createdAt:r.createdAt,definition:JSON.parse(r.definition)}));}
  async save(id,input,actor){
    const old=id?await this.get(id):null;
    if(!Number.isSafeInteger(input.expectedVersion)||input.expectedVersion<0)throw agentError(400,'版本无效，请重新打开项目');
    const text=(key,max)=>{const v=input[key];if(typeof v!=='string'||!v.trim()||v.length>max)throw agentError(400,`${key} 不能为空或超过长度限制`);return v.trim();};
    const name=text('name',100),description=text('description',500),problem=text('problem',20000),points=text('points',16000);validatePrompt(input.prompt);
    return this.db.transaction(()=>{
      const latest=id?this.db.prepare('SELECT MAX(version) AS version FROM project_revisions WHERE project_id=?').get(id).version||0:0;
      if(latest!==input.expectedVersion)throw agentError(409,'项目已在其他窗口更新，请保留内容并重新加载后合并');
      if(old&&latest===0)this.db.prepare('INSERT OR IGNORE INTO project_revisions VALUES (?,?,?,?,?)').run(id,0,JSON.stringify(old),actor,new Date().toISOString());
      const nextNumber=id?Number(id.slice(7)):Math.max(3,...this.db.prepare('SELECT DISTINCT project_id FROM project_revisions').all().map(r=>Number(r.project_id.slice(7))))+1;
      const projectId=id||'project'+nextNumber;
      const definition={...(old||{id:projectId,number:String(nextNumber).padStart(2,'0'),english:'Programming Project',icon:'code',tags:['编程实践'],level:'项目实践',color:'blue',folder:projectId,objectives:[],scores:[['综合评价',20]],files:{'src/main.c':'#include <stdio.h>\n\nint main(void) {\n    // TODO: 从你的规划开始实现\n    return 0;\n}\n','README.md':'# 项目说明\n\n请在左侧阅读题目。\n','CMakeLists.txt':'cmake_minimum_required(VERSION 3.16)\nproject(assessment LANGUAGES C)\nset(CMAKE_C_STANDARD 11)\nadd_executable(main src/main.c)\n'}}),name,description,problem,points,prompt:input.prompt,customProblem:true};
      delete definition.updatedAt;delete definition.version;
      this.db.prepare('INSERT INTO project_revisions VALUES (?,?,?,?,?)').run(projectId,latest+1,JSON.stringify(definition),actor,new Date().toISOString());return {id:projectId,version:latest+1};
    })();
  }
}
