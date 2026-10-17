import {agentRequest,showAISettings} from './agent-client.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
export async function showPromptTrial(projectId,onSaved=()=>{}){
  document.querySelector('#prompt-trial-dialog')?.remove();
  const dialog=document.createElement('dialog');dialog.id='prompt-trial-dialog';dialog.className='prompt-dialog';
  dialog.innerHTML='<p>正在读取提示词…</p><button data-close>关闭</button>';document.body.append(dialog);dialog.showModal();dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  try{
    const data=await agentRequest('/api/prompt-trials/'+projectId);let version=data.version;
    dialog.innerHTML=`<header><span class="eyebrow">PROMPT LAB · 临时开放</span><h2>试用我的提示词</h2><p>只影响你的账号在本项目的后续新消息，多次作答共用。已有对话仍保留；比较效果建议新建一次作答。</p></header><label>加载历史版本 <select id="prompt-history"><option value="">选择版本（加载后需保存才生效）</option>${data.history.map(h=>`<option value="${h.version}">v${h.version} · ${date(h.createdAt)}${h.body===null?' · 恢复默认':''}</option>`).join('')}</select></label><label for="student-prompt-body">教学行为提示词</label><textarea id="student-prompt-body" spellcheck="false"></textarea><p class="teacher-muted">保留“[在此填入本实验的重点模块/任务]”占位符。考点由服务器注入，文件审批和隔离运行仍有效。最多 24 KB。</p><p id="prompt-save-status" role="status">${data.body===null?'当前使用教师默认提示词':'当前使用个人版本 v'+version}</p><footer><button data-close>关闭</button><button id="prompt-reset">恢复教师默认</button><button id="prompt-save" class="primary">保存并用于后续消息</button></footer>`;
    const area=dialog.querySelector('textarea');area.value=data.body??data.defaultBody;
    dialog.querySelector('[data-close]').onclick=()=>dialog.close();
    dialog.querySelector('#prompt-history').onchange=e=>{const item=data.history.find(h=>h.version===Number(e.target.value));if(item){area.value=item.body??data.defaultBody;dialog.querySelector('#prompt-save-status').textContent='已加载旧版本，尚未保存';}};
    async function save(body){
      dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
      try{const result=await agentRequest('/api/prompt-trials/'+projectId,{body,expectedVersion:version});version=result.version;await onSaved();dialog.close();}
      catch(e){dialog.querySelector('#prompt-save-status').textContent=e.message;}
      finally{dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
    }
    dialog.querySelector('#prompt-save').onclick=()=>save(area.value);
    dialog.querySelector('#prompt-reset').onclick=()=>save(null);
  }catch(e){dialog.innerHTML=`<h2>暂时无法编辑</h2><p>${esc(e.message)}</p><button>关闭</button>`;dialog.querySelector('button').onclick=()=>dialog.close();}
}
export async function renderProjectWorkbench(host){
  const [data,access,ai]=await Promise.all([agentRequest('/api/teacher/projects'),agentRequest('/api/teacher/prompt-trials'),agentRequest('/api/teacher/ai-settings')]);
  if(!host.isConnected)return;
  let selected=null,version=0;
  host.innerHTML=`<span class="eyebrow">PROJECT STUDIO</span><div class="teacher-heading"><div><h1>项目工作台</h1><p>从一道题开始，设置 AI 的协作方式。</p></div><button id="studio-new" class="primary">＋ 新建项目</button></div><div class="studio-settings"><div><strong>AI 连接</strong><p>${esc(ai.model)} · ${ai.configured?'已连接':'尚未连接'} · 所有项目共用</p><button id="studio-ai">配置 AI 连接</button></div><div><strong>组员提示词试用</strong><p>临时允许学生编辑自己的提示词。关闭后，新对话恢复教师默认；个人版本保留。</p><label class="studio-switch"><input id="studio-access" type="checkbox" ${access.enabled?'checked':''}> 向学生开放编辑</label><span id="studio-access-status" role="status"></span></div></div><div class="studio-layout"><aside class="studio-projects" aria-label="项目列表"></aside><form id="studio-form"><div class="studio-editor-head"><h2 id="studio-title">项目设置</h2><span id="studio-version"></span></div><div class="studio-tabs" role="tablist" aria-label="项目设置"><button type="button" role="tab" aria-selected="true" data-studio-tab="question">题目</button><button type="button" role="tab" aria-selected="false" data-studio-tab="prompt">系统提示词</button><button type="button" role="tab" aria-selected="false" data-studio-tab="points">考点 / 重点</button></div><section data-studio-panel="question"><label for="studio-name">项目名称</label><input id="studio-name" maxlength="100" required><label for="studio-description">简短介绍</label><textarea id="studio-description" rows="2" maxlength="500" required></textarea><label for="studio-problem">完整题目（含输入输出、测试与评分要求）</label><textarea id="studio-problem" class="studio-long" required></textarea><p class="teacher-muted">新项目配备 C11 项目模板，含 main.c 和 CMake 构建文件。修改题面不会覆盖学生代码和轨迹。</p></section><section data-studio-panel="prompt" hidden><label for="studio-prompt">教学行为提示词</label><textarea id="studio-prompt" class="studio-long" spellcheck="false" required></textarea><p class="teacher-muted">保留考点占位符。服务器会加入本项目考点、题面和运行约束。个人试用版本优先于此默认版本。</p><button type="button" id="studio-original-prompt">载入初始教学规范</button><button type="button" id="studio-preview">预览已保存的完整系统提示词</button></section><section data-studio-panel="points" hidden><label for="studio-points">仅教师与 AI 可见的考点清单</label><textarea id="studio-points" class="studio-long" required></textarea><p class="teacher-muted">请区分重点与非重点，并写明规划需要包含的信息。此内容不会发送到学生的提示词编辑器。</p></section><div class="studio-history"><label>加载历史配置 <select id="studio-history"><option value="">选择版本（加载后需保存才生效）</option></select></label></div><p id="studio-result" role="status"></p><div class="studio-footer"><span>保存后更新学生项目列表与后续新对话。</span><button type="submit" class="primary">保存并发布</button></div></form></div>`;
  const $=s=>host.querySelector(s),form=$('#studio-form');
  $('#studio-ai').onclick=showAISettings;
  $('#studio-access').onchange=async e=>{const input=e.target;input.disabled=true;try{await agentRequest('/api/teacher/prompt-trials',{enabled:input.checked});$('#studio-access-status').textContent=input.checked?'已开放':'已关闭';}catch(error){input.checked=!input.checked;$('#studio-access-status').textContent=error.message;}finally{input.disabled=false;}};
  const fields=['name','description','problem','prompt','points'];
  const fill=p=>{for(const key of fields)$('#studio-'+key).value=p[key]||'';};
  const drawList=()=>{$('.studio-projects').innerHTML=data.projects.map(p=>`<button type="button" data-project="${p.id}" aria-pressed="${p.id===selected}"><small>PROJECT ${p.number}</small><strong>${esc(p.name)}</strong><span>C11 · ${p.version?'已发布 v'+p.version:'初始版本'}</span></button>`).join('');host.querySelectorAll('[data-project]').forEach(b=>b.onclick=()=>open(b.dataset.project));};
  let history=[];
  async function open(id){
    try{const result=await agentRequest('/api/teacher/projects/'+id);if(!host.isConnected)return;selected=id;version=result.project.version;history=result.history;fill(result.project);$('#studio-title').textContent=result.project.name;$('#studio-version').textContent='v'+version;$('#studio-result').textContent='';$('#studio-preview').disabled=false;$('#studio-history').innerHTML='<option value="">选择版本（加载后需保存才生效）</option>'+history.map(h=>`<option value="${h.version}">v${h.version} · ${date(h.createdAt)}</option>`).join('');drawList();}catch(e){$('#studio-result').textContent=e.message;}
  }
  $('#studio-new').onclick=()=>{selected=null;version=0;history=[];fill({prompt:data.defaultPrompt});$('#studio-title').textContent='新建项目';$('#studio-version').textContent='尚未发布';$('#studio-result').textContent='';$('#studio-history').innerHTML='<option value="">暂无历史版本</option>';$('#studio-preview').disabled=true;drawList();host.querySelector('[data-studio-tab="question"]').click();$('#studio-name').focus();};
  host.querySelectorAll('[data-studio-tab]').forEach(b=>b.onclick=()=>{host.querySelectorAll('[data-studio-tab]').forEach(t=>t.setAttribute('aria-selected',String(t===b)));host.querySelectorAll('[data-studio-panel]').forEach(p=>p.hidden=p.dataset.studioPanel!==b.dataset.studioTab);});
  $('#studio-original-prompt').onclick=()=>{$('#studio-prompt').value=data.defaultPrompt;$('#studio-result').textContent='已载入初始规范，保存后生效。';};
  $('#studio-history').onchange=e=>{const h=history.find(r=>r.version===Number(e.target.value));if(h){fill(h.definition);$('#studio-result').textContent='已载入 v'+h.version+'，保存后作为新版本发布。';}};
  $('#studio-preview').onclick=async()=>{try{const {policy}=await agentRequest('/api/teacher/projects/'+selected+'/policy');const d=document.createElement('dialog');d.className='prompt-dialog';d.innerHTML='<h2>已保存的完整系统提示词</h2><p>不含学生个人试用版本、动态文件索引和聊天历史。</p><textarea readonly aria-label="完整系统提示词"></textarea><footer><button>关闭</button></footer>';d.querySelector('textarea').value=policy;d.querySelector('button').onclick=()=>{d.close();d.remove();};document.body.append(d);d.showModal();}catch(e){$('#studio-result').textContent=e.message;}};
  // Hidden fields are validated here so the relevant tab can be shown on error.
  form.noValidate=true;
  form.onsubmit=async e=>{
    e.preventDefault();const button=form.querySelector('[type=submit]');button.disabled=true;
    try{const values=Object.fromEntries(fields.map(k=>[k,$('#studio-'+k).value]));const missing=fields.find(k=>!values[k].trim());if(missing){host.querySelector(`[data-studio-tab="${missing==='points'?'points':missing==='prompt'?'prompt':'question'}"]`).click();$('#studio-'+missing).focus();throw Error('请填写完整的题目、教学提示词和考点。');}
      const result=await agentRequest('/api/teacher/projects'+(selected?'/'+selected:''),{...values,expectedVersion:version});const updated=await agentRequest('/api/teacher/projects');data.projects=updated.projects;await open(result.id);$('#studio-result').textContent='已发布 v'+result.version+'，学生刷新后可见，后续新消息使用新配置。';
    }catch(error){$('#studio-result').textContent=error.message;}finally{button.disabled=false;}
  };
  if(data.projects.length)await open(data.projects[0].id);else $('#studio-new').click();
}
