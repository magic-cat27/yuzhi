import {renderProjectWorkbench} from './prompt-workbench.js';
import {renderCodeDiff} from './code-diff.js';
import { runMarkup } from './execution.js';
import { renderAssessment } from './assessment.js';
import { renderMemory } from './memory.js';
import { showAISettings } from './agent-client.js';
import { groupRecords, recordIdentity } from './teacher-groups.js';
import { traceLabels, filesAt, textChange } from './trace.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
async function get(url){const r=await fetch(url,{cache:'no-store'});if(!r.ok)throw Error('记录加载失败，请重试');return r.json();}
const views={projects:{title:'项目工作台',subtitle:'出题、连接 AI 与设置提示词。',eyebrow:'PROJECT STUDIO'},traces:{title:'过程轨迹',subtitle:'回看学生的决策、代码变化与 AI 协作证据。',eyebrow:'LEARNING EVIDENCE'},assessments:{title:'过程性评价',subtitle:'按每次作答生成硬评价与软评价，核对证据并完成教师复核。',eyebrow:'PROCESS ASSESSMENT'},memory:{title:'长期记忆',subtitle:'将评价转为可更新的学生观察，用于下一次 AI 协作。',eyebrow:'LEARNING OVER TIME'}};
const currentView=()=>{const v=new URLSearchParams(location.hash.split('?')[1]||'').get('view');return Object.hasOwn(views,v)?v:'traces';};
function navigation(view,student){return `<div class="nav-caption">教学工作台</div><nav class="teacher-nav" aria-label="教学工作台">${Object.entries(views).map(([key,v],n)=>`<a class="${key===view?'nav-active':''}" ${key===view?'aria-current="page"':''} href="#/teacher?view=${key}${student?'&student='+encodeURIComponent(student):''}"><span class="teacher-nav-number">0${n+1}</span><span>${v.title}</span></a>`).join('')}</nav>`;}
let generation=0;
export async function renderTeacher(projects, id){
  const ticket=++generation,view=currentView();
  document.body.className='teacher-mode';
  document.querySelector('.avatar').textContent='教师';
  const app=document.querySelector('#app');
  app.innerHTML=`<div class="teacher-layout"><aside class="home-nav">${navigation(view,new URLSearchParams(location.hash.split('?')[1]||'').get('student'))}<div class="nav-bottom"><div class="mini-brand">看见学习的过程</div><p>先查看事实与证据，<br>再理解学生的选择。</p><span class="environment"><i></i>教师专属 · 账号已认证</span></div></aside><main class="teacher-main"><div id="teacher-content"><p class="teacher-muted">正在加载教学工作台…</p></div></main></div>`;
  const host=document.querySelector('#teacher-content');
  try {
    if(view==='projects'){await renderProjectWorkbench(host);return;}
    if(id){const record=await get(`/api/teacher/records/${id}`);if(ticket!==generation||!host.isConnected)return;app.querySelector('.teacher-nav').outerHTML=navigation(view,recordIdentity(record).key).replace('<div class="nav-caption">教学工作台</div>','');renderRecord(host,record,projects,view);return;}
    const records=await get('/api/teacher/records?view='+view);if(ticket!==generation||!host.isConnected)return;
    renderStudents(host,records,projects,view);

  } catch(e){if(host.isConnected)host.innerHTML=`<div class="teacher-empty"><h2>${esc(e.message)}</h2><button id="teacher-retry">重新加载</button></div>`;host.querySelector('#teacher-retry')?.addEventListener('click',()=>renderTeacher(projects,id));}
}
function renderStudents(host,records,projects,view){
  const allGroups=groupRecords(records),params=new URLSearchParams(location.hash.split('?')[1]||'');
  let selected=params.get('student');
  let scope=allGroups.find(g=>g.key===selected)?.kind||params.get('scope')||'student';
  if(!['student','teacher','legacy'].includes(scope))scope='student';
  const projectName=id=>projects.find(p=>p.id===id)?.name||id;
  const scopeLabels={student:'学生作答',teacher:'教师试用',legacy:'历史演示'};
  const studentRecords=records.filter(r=>recordIdentity(r).kind==='student');
  host.innerHTML=`<span class="eyebrow">${views[view].eyebrow}</span><div class="teacher-heading"><div><h1>${views[view].title}</h1><p>${views[view].subtitle}</p></div><div class="record-tools"><button id="teacher-ai-settings">AI 连接</button><button id="teacher-refresh">↻ 刷新记录</button></div></div><div class="teacher-stats" ${view==='memory'?'hidden':''}><div><span>已有轨迹的学生</span><strong>${allGroups.filter(g=>g.kind==='student').length}</strong></div><div><span>学生项目记录</span><strong>${studentRecords.length}</strong></div><div><span>${view==='assessments'?'已完成评价':'学生编辑片段'}</span><strong>${view==='assessments'?studentRecords.filter(r=>r.assessment?.status==='completed').length:studentRecords.reduce((sum,r)=>sum+r.edits,0)}</strong></div></div><div class="student-scopes" role="group" aria-label="记录类型">${Object.entries(scopeLabels).map(([key,label])=>`<button data-student-scope="${key}">${label}<span>${allGroups.filter(g=>g.kind===key).length}</span></button>`).join('')}</div><div class="teacher-filter"><label>项目 <select id="teacher-project"><option value="">全部项目</option>${projects.map(p=>`<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label class="teacher-search">搜索 <input id="teacher-search" placeholder="学生姓名、用户名或项目"></label><span>时间为北京时间</span></div><div class="student-browser"><aside class="student-roster" aria-label="选择学生"><div class="student-roster-heading">账号列表 <span id="student-count"></span></div><div id="student-rows"></div></aside><section id="student-records" aria-live="polite"></section></div><p class="teacher-muted">按账号分别记录，同名学生通过用户名区分。同一项目的多次作答分别保留，可从不同浏览器继续已同步的作答；教师试用和历史演示不计入学生统计。</p>`;
  const updateURL=()=>{
    const query=new URLSearchParams({view});if(scope!=='student')query.set('scope',scope);if(selected)query.set('student',selected);if(view==='memory'&&params.get('trace')&&params.get('student')===selected)query.set('trace',params.get('trace'));
    history.replaceState(null,'',`#/teacher${query.size?'?'+query:''}`);
  };
  const draw=()=>{
    const query=host.querySelector('#teacher-search').value.trim().toLowerCase(),project=host.querySelector('#teacher-project').value;
    const filtered=records.filter(r=>{
      const identity=recordIdentity(r);
      return identity.kind===scope&&(!project||r.projectId===project)&&`${identity.name} ${identity.username} ${projectName(r.projectId)} ${r.id}`.toLowerCase().includes(query);
    });
    const groups=groupRecords(filtered);
    const active=groups.find(g=>g.key===selected)||groups[0];
    if(active){selected=active.key;updateURL();document.querySelector('.teacher-nav').outerHTML=navigation(view,selected).replace('<div class="nav-caption">教学工作台</div>','');}
    host.querySelectorAll('[data-student-scope]').forEach(button=>{
      const active=button.dataset.studentScope===scope;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    });
    host.querySelector('#student-count').textContent=`${groups.length} 位`;
    host.querySelector('#student-rows').innerHTML=groups.map(group=>`<button class="student-row ${group===active?'active':''}" data-student="${esc(group.key)}" aria-pressed="${group===active}"><span class="student-avatar">${esc(group.name.slice(0,1))}</span><span class="student-row-info"><strong>${esc(group.name)}</strong><small>${group.kind==='legacy'?'标识 '+esc(group.username.slice(0,8)):'@'+esc(group.username)}</small><span>${group.projectCount} 个项目 · ${group.records.length} 份记录</span></span><span class="student-arrow">›</span></button>`).join('')||'<p class="student-list-empty">暂无符合条件的账号</p>';
    const panel=host.querySelector('#student-records');
    if(!active){
      panel.innerHTML=`<div class="teacher-empty"><span>▤</span><h2>暂无${scopeLabels[scope]}记录</h2><p>${query||project?'请调整搜索或项目筛选条件。':scope==='student'?'学生注册并进入项目后，轨迹会按账号显示在这里。':scope==='teacher'?'教师使用学生视图时产生的记录会单独列在这里。':'登录功能上线前的匿名记录会保留在这里。'}</p></div>`;
      return;
    }
    host.querySelectorAll('[data-student]').forEach(button=>button.onclick=()=>{selected=button.dataset.student;updateURL();draw();});
    if(view==='memory'){if(active.kind==='legacy')panel.innerHTML='<div class="teacher-empty">历史演示未绑定账号，不能形成学生长期记忆。</div>';else renderMemory(panel,{id:active.records[0].ownerId,name:active.name,username:active.username},projects);return;}
    panel.innerHTML=`<div class="student-detail-heading"><div><span class="eyebrow">${scope==='student'?'STUDENT PROFILE':scope==='teacher'?'TEACHER PREVIEW':'LEGACY RECORDS'}</span><h2>${esc(active.name)}</h2><p>${active.kind==='legacy'?'浏览器标识 · '+esc(active.username):'@'+esc(active.username)}<span class="student-kind">${scopeLabels[scope]}</span></p></div><div class="student-updated">最近同步<br><strong>${date(active.updatedAt)}</strong></div></div><div class="student-summary"><span><b>${active.projectCount}</b> 个项目</span><span><b>${active.records.length}</b> 份记录</span><span><b>${active.edits}</b> 段编辑</span><span><b>${active.messages}</b> 次提问</span></div><div class="teacher-table-wrap"><table class="teacher-table"><thead><tr><th>项目 / 记录</th><th>最近同步</th><th>${view==='assessments'?'评价状态':'过程记录'}</th><th></th></tr></thead><tbody>${active.records.map(r=>`<tr><td><strong>${esc(projectName(r.projectId))}</strong><small>第 ${r.attemptNumber||1} 次作答 · 记录 ${esc(r.id.slice(0,8))} · ${r.imported?'含历史快照':'开始于 '+date(r.createdAt)}</small></td><td>${date(r.updatedAt)}</td><td>${view==='assessments'?assessmentLabel(r.assessment):`${r.eventCount} 条<small>${r.edits} 段学生编辑 · ${r.aiEdits||0} 次 AI 应用 · ${r.messages} 次提问</small>`}</td><td><a class="record-link" href="#/teacher/${r.id}?view=${view}">${view==='assessments'?'查看评价':'查看轨迹'} →</a></td></tr>`).join('')}</tbody></table></div>`;
    host.querySelectorAll('[data-student]').forEach(button=>button.onclick=()=>{selected=button.dataset.student;updateURL();draw();});
  };
  host.querySelectorAll('[data-student-scope]').forEach(button=>button.onclick=()=>{scope=button.dataset.studentScope;selected=null;updateURL();draw();});
  host.querySelector('#teacher-project').onchange=draw;host.querySelector('#teacher-search').oninput=draw;
  host.querySelector('#teacher-refresh').onclick=()=>renderTeacher(projects);
  host.querySelector('#teacher-ai-settings').onclick=showAISettings;
  draw();
}
function assessmentLabel(a){if(!a)return '<span class="assessment-badge">未评价</span>';const text=a.stale?'轨迹已更新':a.status==='completed'?(a.reviewed?'教师已复核':'待教师复核'):({queued:'排队中',running:'正在评价',failed:'评价失败'}[a.status]||'待评价');return `<span class="assessment-badge ${a.status==='completed'&&!a.stale?'done':''}">${text}</span>${a.status==='completed'?`<small>${a.total==null?'部分维度待核验':'硬评价 '+a.total+' / 100'}</small>`:''}`;}
function renderRecord(host,record,projects,view){
  const project=projects.find(p=>p.id===record.projectId);
  host.innerHTML=`<div class="teacher-heading"><a class="back-link" href="#/teacher?view=${view}&student=${encodeURIComponent(recordIdentity(record).key)}">← 返回该账号记录</a><div class="record-tools"><button id="record-refresh">↻ 刷新</button><a class="export-trace" href="/api/teacher/records/${record.id}/export" download>↓ 导出完整轨迹</a></div></div><div class="record-title"><span class="eyebrow">${views[view].eyebrow}</span><h1>${esc(project?.name||record.projectId)} · 第 ${record.attemptNumber||1} 次作答</h1><p>${record.student?esc(record.student.name)+' · @'+esc(record.student.username):'历史演示 · 未关联账号'} <span> / </span> 记录始于 ${date(record.events[0]?.timestamp||record.createdAt)} <span> / </span> ${record.events.length} 条记录</p></div><div class="trace-notice">轨迹保留原始行为证据；过程性评价提供带引用的模型初评，由教师复核。连续编辑分段仅用于阅读，不代表独立考核点。</div>${view==='assessments'?`<div class="record-crosslinks"><a href="#/teacher/${record.id}?view=traces">回看过程轨迹 ↗</a>${record.ownerId?`<a href="#/teacher?view=memory&student=${encodeURIComponent(recordIdentity(record).key)}&trace=${record.id}">提取 / 查看长期记忆 →</a>`:''}</div>`:''}<div class="record-tabs" ${view==='assessments'?'hidden':''}><button class="active" data-record-tab="timeline">过程轨迹</button><button data-record-tab="chat">AI 对话</button><button data-record-tab="files">项目文件</button></div><div id="record-body"></div>`;
  host.querySelector('#record-refresh').onclick=()=>renderTeacher(projects,record.id);
  const body=host.querySelector('#record-body');
  const showFiles=sequence=>{
    const files=filesAt(record,sequence);
    body.innerHTML=`<div class="snapshot-heading"><strong>${Number.isFinite(sequence)?`第 ${sequence} 条记录后的项目快照`:'最新同步的项目快照'}</strong><span>${Object.keys(files).length} 个文件</span></div><div class="snapshot-view"><div class="snapshot-files">${Object.keys(files).map(f=>`<button data-snapshot-file="${esc(f)}">${esc(f)}</button>`).join('')}</div><div class="snapshot-code"><div id="snapshot-path"></div><pre id="snapshot-content"></pre></div></div>`;
    const choose=f=>{body.querySelector('#snapshot-path').textContent=f;body.querySelector('#snapshot-content').textContent=files[f];body.querySelectorAll('[data-snapshot-file]').forEach(b=>b.classList.toggle('active',b.dataset.snapshotFile===f));};
    body.querySelectorAll('[data-snapshot-file]').forEach(b=>b.onclick=()=>choose(b.dataset.snapshotFile));
    if(Object.keys(files).length)choose(Object.hasOwn(files,'src/main.c')?'src/main.c':Object.keys(files)[0]);
  };
  const setTab=name=>host.querySelectorAll('[data-record-tab]').forEach(b=>b.classList.toggle('active',b.dataset.recordTab===name));
  const draw=tab=>{
    setTab(tab);
    if(tab==='assessment'){renderAssessment(body,record,id=>{location.hash=`#/teacher/${record.id}?view=traces&event=${encodeURIComponent(id)}`;});return;}
    if(tab==='files'){showFiles(Infinity);return;}
    if(tab==='chat'){
      const old=record.events.filter(e=>e.type==='baseline_imported').flatMap(e=>Array.isArray(e.payload.messages)?e.payload.messages:[]);
      const messages=record.events.filter(e=>['chat_user','chat_demo','ai_response','ai_response_partial'].includes(e.type));
      body.innerHTML=(old.length?`<div class="trace-notice">以下 ${old.length} 条是启用记录前的历史对话，时间与当时代码上下文未知。</div>${old.map(m=>`<div class="review-message"><span>${m.role==='user'?'学生':'系统演示回复'} · 历史导入</span><pre>${esc(m.text)}</pre></div>`).join('')}`:'')+messages.map(e=>`<div class="review-message ${e.type==='chat_user'?'student':''}"><span>${e.type==='chat_user'?'学生':e.type.startsWith('ai_response')?'AI 助手':'系统演示回复 · 非真实模型'} · ${date(e.timestamp)}</span><pre>${esc(e.payload.text)}</pre><small>当时文件：${esc(e.payload.file)}</small></div>`).join('')||'<div class="teacher-empty">暂无对话记录</div>';
      return;
    }
    body.innerHTML=`<div class="timeline-filter"><label>显示 <select id="event-filter"><option value="all">全部记录</option><option value="code">代码与文件</option><option value="chat">对话</option><option value="run">运行与终端</option></select></label><span>按记录顺序展示 · 展开查看原始证据</span></div><div id="trace-list"></div>`;
    const events=()=>{
      const filter=body.querySelector('#event-filter').value;
      const list=record.events.filter(e=>filter==='all'||(filter==='code'&&['code_edited','code_saved','file_created','file_opened','ai_change_proposed','ai_change_decision','ai_changes_applied'].includes(e.type))||(filter==='chat'&&['chat_user','chat_demo','ai_response','ai_response_partial'].includes(e.type))||(filter==='run'&&['execution_started','execution_finished','run_unavailable','terminal_command'].includes(e.type)));
      body.querySelector('#trace-list').innerHTML=list.map(e=>eventCard(e)).join('')||'<div class="teacher-empty">此分类暂无记录</div>';
      body.querySelectorAll('[data-snapshot]').forEach(b=>b.onclick=()=>{setTab('files');showFiles(Number(b.dataset.snapshot));});
    };
    events();body.querySelector('#event-filter').onchange=events;
  };
  host.querySelectorAll('[data-record-tab]').forEach(b=>b.onclick=()=>draw(b.dataset.recordTab));draw(view==='assessments'?'assessment':'timeline');
  const eventId=new URLSearchParams(location.hash.split('?')[1]||'').get('event');
  if(eventId&&view==='traces'){const card=body.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);if(card){card.open=true;card.scrollIntoView({block:'center'});}}
}
function eventCard(e){
  const p=e.payload;
  let summary=p.file||p.command||p.text?.slice(0,85)||p.note||'';
  if(e.type==='ai_change_decision')summary=p.conflict?'学生同意，但文件版本已变化，未应用':p.approved?'学生同意本次改动':'学生拒绝本次改动';
  let content='';
  if(e.type==='execution_finished'){summary=`${p.command} · 退出码 ${p.exitCode??'—'}`;content=`<button data-snapshot="${p.sourceSequence}">查看本次运行的源码 →</button>`+runMarkup({...p,id:p.runId});}
  else if(e.type==='execution_started'){summary=p.command;content=`<pre>${esc(p.command)}</pre><p>源码版本：第 ${p.sourceSequence} 条轨迹 · ${esc(p.sourceHash)}</p><h4>标准输入</h4><pre>${esc(p.stdin||'（空）')}</pre>`;}
  else if(['ai_change_proposed','ai_changes_applied'].includes(e.type)){
    summary=p.summary||p.changes.map(c=>c.path).join('、');
    content=(p.planQuote?`<p>学生规划原文：${esc(p.planQuote)}</p>`:'')+p.changes.map(c=>`<h4>${esc(c.path)}</h4>${renderCodeDiff(c)}<details class="diff-full"><summary>查看修改前后全文</summary><div class="code-comparison"><section><h4>修改前</h4><pre>${c.before===null?'（新文件）':esc(c.before)}</pre></section><section><h4>${e.type==='ai_change_proposed'?'拟修改为':'修改后'}</h4><pre>${esc(c.after)}</pre></section></div></details>`).join('');
  }else if(e.type==='code_edited'){
    const diff=textChange(p.before,p.after);
    summary=`${p.file} · ${p.changes.length} 次编辑 · ${date(p.startedAt)} — ${date(p.endedAt)}`;
    content=`<div class="diff-caption">改动位置：字符偏移 ${diff.offset} · 共 ${p.changes.length} 次编辑（含撤销/重做）</div>${renderCodeDiff({path:p.file,before:p.before,after:p.after})}<details class="diff-full"><summary>查看修改前后全文</summary><div class="code-comparison"><section><h4>修改前</h4><pre>${esc(p.before)}</pre></section><section><h4>修改后</h4><pre>${esc(p.after)}</pre></section></div></details><details class="raw-changes"><summary>查看逐次编辑增量</summary><pre>${esc(JSON.stringify(p.changes,null,2))}</pre></details>`;
  }else if(['chat_user','chat_demo','ai_response','ai_response_partial'].includes(e.type))content=`<pre class="event-text">${esc(p.text)}</pre>${e.type==='chat_demo'?'<p class="teacher-muted">系统固定演示回复，尚未调用 AI 模型。</p>':''}`;
  else if(['session_started','baseline_imported'].includes(e.type))content=`<p>${esc(p.note)}</p><p class="teacher-muted">${Object.keys(p.files||{}).length} 个文件 · ${(p.messages||[]).length} 条既有消息</p>`;
  else content=`<pre class="event-text">${esc(JSON.stringify(p,null,2))}</pre>`;
  return `<details class="trace-event" data-event-id="${esc(e.id)}"><summary><span class="trace-dot ${e.actor==='system'?'system':''}"></span><div class="trace-event-heading"><strong>${esc(traceLabels[e.type]||e.type)}</strong><span>${esc(summary)}</span></div><time>${date(e.timestamp)}</time><span class="event-sequence">#${e.sequence}</span></summary><div class="event-body"><div class="event-meta">${e.actor==='system'?'系统记录':e.actor==='ai'?'AI 操作':'学生操作'} · 服务端收到：${date(e.receivedAt)} · 事件 ID：${esc(e.id)}</div>${content}<button class="snapshot-button" data-snapshot="${e.sequence}">查看此时项目 →</button></div></details>`;
}
