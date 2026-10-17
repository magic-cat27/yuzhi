import {connectAgentLive} from './agent-live.js';
import {showPromptTrial} from './prompt-workbench.js';
import {welcomeTitle,welcomeBody} from './agent-welcome.js';
import { mountExecution } from './execution.js';
import { agentRequest, renderAgentStatus, reviewChanges } from './agent-client.js';
import { currentSession, setSession, authRequest, renderAuth, renderAccountHeader } from './auth.js';
let projects=[];
import { migrateWorkspace, restoreAttempt } from './workspace-state.js';
import { createTrace, addEvent, syncTrace, textChange } from './trace.js';
import { renderTeacher } from './teacher.js';
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
 grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
 arrow:'M5 12h14m-5-5 5 5-5 5', back:'M19 12H5m5-5-5 5 5 5', chevron:'m9 5 7 7-7 7',
 tree:'M12 3v6m-7 6v-4h14v4M3 16h4v5H3z M10 3h4v5h-4z M17 16h4v5h-4z',
 route:'M5 5h9a5 5 0 0 1 0 10H9m-4-7V2m-3 3h6m8 14h6m-3-3v6 M4 15h6v6H4z',
 nodes:'M12 7v4M5 16v-5h14v5 M10 2h4v5h-4z M3 16h4v5H3z M17 16h4v5h-4z',
 book:'M12 6C8 3 4 4 2 5v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-2-1-6-2-10 1v14',
 clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 code:'m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18',
 chat:'M21 11a8 8 0 0 1-8 8H6l-4 3V6a4 4 0 0 1 4-4h7a8 8 0 0 1 8 9z M7 8h9M7 12h6',
 spark:'m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
 folder:'M3 5h6l2 2h10v13H3z', file:'M5 2h9l5 5v15H5z M14 2v6h5',
 plus:'M12 5v14M5 12h14', close:'m6 6 12 12M6 18 18 6', play:'m7 3 14 9-14 9z',
 check:'m5 12 4 4L19 6', download:'M12 3v12m-5-5 5 5 5-5 M4 16v5h16v-5',
 panel:'M3 3h18v18H3z M15 3v18', terminal:'m4 5 6 6-6 6m9 0h7',
 send:'M12 20V4m-7 7 7-7 7 7', search:'M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16m6-2 6 6',
 info:'M12 11v6m0-11v1 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 collapse:'m9 5 7 7-7 7 M3 3v18', expand:'m15 5-7 7 7 7 M21 3v18',
 layers:'m12 2 10 5-10 5L2 7z M2 12l10 5 10-5M2 17l10 5 10-5',
 save:'M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8',
};
const icon = (name, cls='') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
let project, state, editor, activeFile, currentKey, modelListener, saveTimer, toastTimer;
let models = new Map(), openFiles = [], views = new Map();
let pendingSource = 0, editTimer, syncTimer, agentTimer;
let agentInfo=null, aiApplying=false, agentStream=null, liveReply=null;
const pendingSync=new Map();
const storageKey = (id, owner=currentSession()?.user.id, attemptId=null) => `yuzhi-account:v1:${owner}:${id}${attemptId?':attempt:'+attemptId:''}`;
function readState(p,attemptId=null) {
  const initial = { schemaVersion:2, files:{...p.files}, messages:[], startedAt:null, elapsed:0, activeFile:'src/main.c', openFiles:['src/main.c'], chatCollapsed:false, terminalCollapsed:false, treeCollapsed:false };
  try {
    const saved = migrateWorkspace(JSON.parse(localStorage.getItem(storageKey(p.id,undefined,attemptId))), p);
    if (saved && saved.files && typeof saved.files === 'object' && !Array.isArray(saved.files)) {
      initial.files = Object.fromEntries(Object.entries(saved.files).filter(([k,v])=>validPath(k) && typeof v==='string'));
      if (!Object.keys(initial.files).length) initial.files={...p.files};
      initial.messages = Array.isArray(saved.messages) ? saved.messages.filter(m=>['user','assistant'].includes(m.role) && typeof m.text==='string') : [];
      for (const key of ['activeFile','openFiles','startedAt','elapsed','chatCollapsed','terminalCollapsed','treeCollapsed','trace','attemptNumber','runSettings']) if(saved[key] !== undefined) initial[key]=saved[key];
    }
  } catch { /* A damaged or unavailable browser store leaves source templates intact. */ }
  if(initial.trace) initial.trace.syncing=false;
  return initial;
}
function persist() {
  if(!project || !state) return;
  state.activeFile=activeFile; state.openFiles=openFiles;
  try { localStorage.setItem(storageKey(project.id,state.trace?.studentId,state.trace?.id),JSON.stringify(state));localStorage.setItem(storageKey(project.id,state.trace?.studentId),JSON.stringify(state)); if($('#save-state')) $('#save-state').textContent='已保存到本机'; }
  catch { if($('#save-state')) $('#save-state').textContent='保存失败，请导出项目'; toast('本地保存不可用，请导出项目以保留修改。'); }
}
function toast(message) { $('#toast').textContent=message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('#toast').classList.remove('visible'),3200); }
let executionCleanup=null;
function cleanup(){agentStream?.close();agentStream=null;liveReply=null;executionCleanup?.();executionCleanup=null; clearTimeout(agentTimer);agentInfo=null; flushEdit(); if(state?.trace)recordEvent('workspace_left',{},'student',false); clearTimeout(editTimer); clearTimeout(saveTimer); if(state){persist();syncCurrent();} modelListener?.dispose(); editor?.dispose(); editor=null; for(const m of models.values())m.dispose(); models.clear(); views.clear(); }
const monacoReady = new Promise(resolve=>{
  if(!window.require) return resolve(null);
  window.require.config({paths:{vs:'/vendor/vs'}});
  window.require(['vs/editor/editor.main'],()=>resolve(window.monaco),()=>resolve(null));
});
function renderHome(){
  cleanup(); project=null; state=null;
  document.body.className='home';
  $('#app').innerHTML=`<div class="home-layout"><aside class="home-nav"><div class="nav-caption">学习空间</div><button class="nav-active">${icon('grid')}我的项目<span>${projects.length}</span></button><div class="nav-bottom"><div class="mini-brand">${icon('spark')} 让思考有价值</div><p>记录每一步探索，<br>让学习的过程被看见。</p><span class="environment"><i></i>账号已登录 · 轨迹自动同步</span></div></aside><main class="home-main"><div class="home-breadcrumb">学习空间 ${icon('chevron')} <span>我的项目</span></div><div class="home-content"><div class="page-intro"><div><span class="eyebrow">LEARN. BUILD. UNDERSTAND.</span><h1>我的考核项目<span class="title-dot">.</span></h1><p>从理解问题开始，在实践中构建你的答案。</p></div><span class="semester">${icon('book')} 数据结构与算法 · 项目实践</span></div><div class="overview-banner"><div class="banner-symbol">${icon('layers')}</div><div><h2>你的思路，是项目的起点。</h2><p>独立规划，与 AI 协作实现，在完整的项目工作区中验证想法。</p></div><div class="workflow"><span><b>01</b> 理解问题</span><i></i><span><b>02</b> 协作实现</span><i></i><span><b>03</b> 测试验证</span></div></div><div class="project-toolbar"><div class="filter-tabs"><button class="selected" data-filter="all">全部项目 <span>${projects.length}</span></button><button data-filter="started">进行中 <span>${projects.filter(p=>readState(p).startedAt).length}</span></button></div><label class="search-field">${icon('search')}<input id="project-search" placeholder="搜索项目…" aria-label="搜索项目"></label></div><div id="project-grid" class="project-grid"></div><div class="home-note">${icon('info')} 每个项目可多次作答，每次的文件、对话与轨迹独立保存。</div><div class="learning-note"><div><span class="eyebrow">YOUR THINKING MATTERS</span><h3>不止完成代码，更要理解为什么。</h3></div><p>用你的语言定义问题，用充分的验证检验结果。<br>AI 是你的协作伙伴，思考的方向始终由你掌握。</p></div></div><footer class="home-footer"><span>驭智 · 让每一次思考都有迹可循</span><span>规划 → 实现 → 验证</span></footer></main></div>`;
  let filter='all';
  const renderCards=()=>{
    const query=$('#project-search').value.trim().toLowerCase();
    const filtered=projects.filter(p=>(filter==='all'||readState(p).startedAt)&&`${esc(p.name)} ${esc(p.english)}`.toLowerCase().includes(query));
    $('#project-grid').innerHTML=filtered.map(p=>{ const started=readState(p).startedAt; return `<a class="project-card" href="#/project/${p.id}"><div class="card-top"><span class="project-symbol ${p.color}">${icon(p.icon)}</span><span class="project-status ${started?'ongoing':''}"><i></i>${started?'进行中':'未开始'}</span></div><span class="project-number">PROJECT ${p.number}</span><h2>${esc(p.name)}</h2><div class="english-name">${esc(p.english)}</div><p class="card-description">${esc(p.description)}</p><div class="tags">${p.tags.map(t=>`<span>${esc(t)}</span>`).join('')}</div><div class="card-meta"><span>${icon('folder')} C 项目</span><span>${icon('book')} 20 分</span></div><div class="card-action"><span>${started?'选择作答 / 新建':'进入项目'}</span>${icon('arrow')}</div></a>`; }).join('') || '<div class="empty-results">没有符合条件的项目</div>';
  };
  renderCards(); $('#project-search').addEventListener('input',renderCards);
  $$('[data-filter]').forEach(btn=>btn.onclick=()=>{filter=btn.dataset.filter;$$('[data-filter]').forEach(b=>b.classList.toggle('selected',b===btn));renderCards();});
}
function problemBody(tab='description'){
  if(tab==='rubric') return `<div class="problem-title"><span class="eyebrow">ASSESSMENT CRITERIA</span><h2>评分标准</h2><p>项目总分 20 分</p></div>${project.scores.map(([label,score])=>`<div class="rubric-row"><span>${esc(label)}</span><b>${score}<small> 分</small></b></div>`).join('')}<div class="callout">提交内容应包括源代码、测试记录和完整报告。具体评分要求以原始题面为准。</div>`;
  if(tab==='source') return '<pre id="source-text" class="source-text">正在加载原始题面…</pre>';
  if(project.customProblem)return `<div class="problem-title"><span class="eyebrow">PROJECT ${project.number}</span><h2>${esc(project.name)}</h2><p>C11 · 项目实践</p></div><pre class="source-text">${esc(project.problem)}</pre>`;
  return `<div class="problem-title"><span class="eyebrow">PROJECT ${project.number}</span><h2>${esc(project.name)}</h2><p>${esc(project.english)}</p><div class="tags"><span class="level">${esc(project.level)}</span><span>C11</span><span>20 分</span></div></div><h3>项目描述</h3><p>${esc(project.description)}</p><h3>${project.id==='project3'?'红黑树的性质':'任务要求'}</h3><ol class="objectives">${project.objectives.map(t=>`<li>${esc(t)}</li>`).join('')}</ol>${project.id==='project3'?`<p>内部节点指非 NULL 节点。黑高为从根节点到任一 NULL 叶子路径上的黑色节点数，不包含根节点，包含 NULL 叶子。</p><h3>输入与输出</h3><p>输入正整数 <code>N ≤ 500</code>。输出不同红黑树的数量，对 <code>1,000,000,007</code> 取模。</p><div class="sample"><div><span>样例输入</span><code>5</code></div><div><span>样例输出</span><code>8</code></div></div>`:''}${project.extra?`<div class="callout">${esc(project.extra)}</div>`:''}<h3>交付内容</h3><div class="deliverable">${icon('code')} 完整源代码与必要注释</div><div class="deliverable">${icon('check')} 测试用例与结果分析</div><div class="deliverable">${icon('file')} 设计说明与实验报告</div><div class="thinking-note">${icon('spark')}<div><strong>先想一想，再动手。</strong><p>可以直接编写代码，<br>也可以随时与 AI 讨论思路。</p></div></div>`;
}
async function renderAttemptPicker(p){
  cleanup();project=null;state=null;
  const target=location.hash;
  document.body.className='home';
  $('#app').innerHTML='<div class="attempt-page"><p>正在加载作答记录…</p></div>';
  let unsynced=null;
  try{
    const local=readState(p);
    if(local.trace){
      if(local.trace.pendingEdit){const edit=local.trace.pendingEdit;delete local.trace.pendingEdit;const event=addEvent(local.trace,'code_edited',edit);event.timestamp=edit.endedAt;}
      localStorage.setItem(storageKey(p.id,local.trace.studentId,local.trace.id),JSON.stringify(local));
      await syncCurrent(local,p);
      if(local.trace.events.some(e=>!local.trace.acknowledged.includes(e.id)))unsynced=local.trace.id;
    }
    const records=await agentRequest('/api/attempts?projectId='+p.id);
    if(location.hash!==target)return;
    $('#app').innerHTML=`<main class="attempt-page"><a href="#/student">← 全部项目</a><span class="eyebrow">PROJECT ${p.number}</span><h1>${esc(p.name)}</h1><p>选择一次作答继续，或从初始模板新建。旧作答不会被清空。</p><button class="primary" id="new-attempt">新建一次作答</button><p id="attempt-error" role="alert"></p><div class="attempt-list">${records.map(r=>`<a class="attempt-row" href="#/project/${p.id}?attempt=${r.id}"><strong>第 ${r.attemptNumber} 次作答</strong><span>开始于 ${new Date(r.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}</span><small>${r.messages} 次提问 · ${r.edits} 段编辑 · ${r.eventCount} 条轨迹</small><b>继续作答 →</b></a>`).join('')||'<p>还没有作答记录。点击上方按钮开始。</p>'}</div></main>`;
    const requestId=crypto.randomUUID();
    if(unsynced){const notice=$('#attempt-error');notice.textContent='有一份本机作答尚未同步。请先打开它，导出保存并处理同步问题；新建作答不会清除它。';const link=document.createElement('a');link.href=`#/project/${p.id}?attempt=${unsynced}`;link.textContent='打开待同步作答 →';notice.append(' ',link);}
    $('#new-attempt').onclick=async()=>{
      const button=$('#new-attempt');button.disabled=true;
      try{const next=await agentRequest('/api/attempts',{projectId:p.id,requestId});if(location.hash===target)location.hash=`#/project/${p.id}?attempt=${next.id}`;}
      catch(e){if(location.hash===target){$('#attempt-error').textContent=e.message;button.disabled=false;}}
    };
  }catch(e){if(location.hash===target)$('#app').innerHTML=`<main class="attempt-page"><h2>暂时无法加载作答</h2><p>${esc(e.message)}</p><button id="attempt-retry">重试</button><a href="#/student">返回项目</a></main>`;$('#attempt-retry')?.addEventListener('click',()=>renderAttemptPicker(p));}
}
async function renderWorkspace(p,attemptId){
  cleanup();project=null;state=null;
  const target=location.hash;
  $('#app').innerHTML='<div class="attempt-page">正在恢复本次作答…</div>';
  let loaded;
  try{
    const local=readState(p,attemptId);
    if(local.trace){
      if(local.trace.pendingEdit){const edit=local.trace.pendingEdit;delete local.trace.pendingEdit;const e=addEvent(local.trace,'code_edited',edit);e.timestamp=edit.endedAt;}
      await syncCurrent(local,p);
    }
    const record=await agentRequest('/api/attempts/'+attemptId);
    if(record.projectId!==p.id)throw Error('这份作答不属于当前项目');
    const pending=local.trace?.events.some(e=>!local.trace.acknowledged.includes(e.id));
    loaded=pending?{...local,attemptNumber:record.attemptNumber}:{...local,...restoreAttempt(record),activeFile:local.activeFile,openFiles:local.openFiles};
  }catch(e){if(location.hash===target)$('#app').innerHTML=`<main class="attempt-page"><h2>作答恢复失败</h2><p>${esc(e.message)}</p><a href="#/project/${p.id}">返回作答列表</a></main>`;return;}
  if(location.hash!==target)return;
  project=p;state=loaded;state.elapsed=Number(state.elapsed)||0;
  activeFile=Object.hasOwn(state.files,state.activeFile)?state.activeFile:Object.keys(state.files)[0];
  openFiles=Array.isArray(state.openFiles)?state.openFiles.filter(f=>Object.hasOwn(state.files,f)):[];
  if(!openFiles.includes(activeFile))openFiles.push(activeFile);
  initTrace();state.startedAt ||= Date.now();
  document.body.className='in-workspace';
  $('#app').innerHTML=`<div class="workspace-top"><a class="back-link" href="#/student">${icon('back')}<span>全部项目</span></a><span class="top-divider"></span><span class="workspace-project-number">PROJECT ${p.number}</span><strong>${esc(p.name)} · 第 ${state.attemptNumber||1} 次</strong><span class="workspace-status"><i></i>进行中</span><div class="workspace-actions"><a class="attempt-switch" href="#/project/${p.id}">作答记录 / 新建</a><span class="timer">${icon('clock')}<span id="timer">00:00:00</span></span><button id="export-project">${icon('download')}<span>导出项目</span></button><button id="toggle-chat" aria-expanded="true">${icon('chat')}<span>AI 助手</span></button></div></div><main class="assessment" id="assessment"><section class="problem-panel"><div class="panel-heading">${icon('book')}<strong>考核题目</strong><span class="quiet-label">独立理解 · 自主规划</span></div><div class="problem-tabs" role="tablist" aria-label="题目信息"><button class="active" data-problem-tab="description" role="tab" aria-selected="true">题目描述</button><button data-problem-tab="rubric" role="tab" aria-selected="false">评分标准</button><button data-problem-tab="source" role="tab" aria-selected="false">原始题面</button></div><article id="problem-content">${problemBody()}</article></section><section class="project-panel"><div class="panel-heading">${icon('code')}<strong>项目工作区</strong><span class="quiet-label" id="save-state">已保存到本机</span><button class="icon-button" id="save-project" aria-label="保存项目" title="保存项目（Ctrl / ⌘ + S）">${icon('save')}</button></div><div class="ide"><aside class="explorer"><div class="explorer-heading"><span>资源管理器</span><button id="new-file" class="icon-button" aria-label="新建文件" title="新建文件">${icon('plus')}</button><button id="hide-tree" class="icon-button" aria-label="折叠文件树" title="折叠文件树">${icon('collapse')}</button></div><div class="project-root">${icon('chevron','rotated')}<span>${esc(p.folder)}</span></div><div id="file-tree" role="navigation" aria-label="项目文件"></div><div class="explorer-footer">${icon('folder')}<span id="file-count"></span> 个文件</div></aside><div class="editor-column"><div class="editor-tabs"><button id="show-tree" class="icon-button" aria-label="展开文件树" title="展开文件树">${icon('panel')}</button><div id="file-tabs" role="tablist" aria-label="打开的文件"></div><button id="toggle-terminal" class="icon-button" aria-label="切换终端面板" title="终端面板">${icon('terminal')}</button></div><div class="editor-breadcrumb"><span>${esc(p.folder)}</span>${icon('chevron')}<span id="file-breadcrumb"></span></div><div id="editor" aria-label="项目代码编辑器"><div class="editor-loading">正在加载代码编辑器…</div></div><div class="editor-status"><span id="language-label">C</span><span>UTF-8</span><span id="cursor-position">行 1，列 1</span><span>空格: 4</span></div><section class="terminal-panel"><div class="terminal-tabs"><button class="active" data-console-tab="terminal">终端</button><button data-console-tab="checks">运行与验证</button><span class="terminal-spacer"></span><button id="run-project" class="run-button">${icon('play')} 运行项目</button><button id="hide-terminal" class="icon-button" aria-label="折叠终端">${icon('close')}</button></div><div id="console-output" class="console-output" role="log" aria-live="polite"><div class="terminal-muted">项目工作区已就绪 · ${esc(p.folder)}</div><div class="terminal-muted">正在检查隔离执行环境。</div><div>输入 <span class="terminal-blue">help</span> 查看运行说明。</div></div><form id="terminal-form"><label for="terminal-input">❯</label><input id="terminal-input" autocomplete="off" spellcheck="false" aria-label="终端命令" placeholder="输入 gcc、python3 等命令…"><span>隔离终端</span></form></section></div></div></section><aside class="chat-panel"><div class="panel-heading"><span class="ai-logo">${icon('spark')}</span><strong>AI 协作助手</strong><button id="collapse-chat" class="icon-button" aria-label="折叠 AI 聊天栏" title="折叠 AI 聊天栏">${icon('collapse')}</button></div><div class="chat-model"><span><i></i>AI Tutor</span><span class="model-badge">正在连接</span></div><div id="agent-controls"></div><div class="chat-context">${icon('folder')}<span>当前项目 · ${esc(p.name)}</span></div><div id="messages" class="messages" aria-live="polite"></div><div class="chat-composer"><div class="context-chip">${icon('file')}<span id="chat-file-context"></span></div><form id="chat-form"><textarea id="chat-input" aria-label="给 AI 助手发送消息" placeholder="说说你的思路，或遇到的问题…" rows="3"></textarea><div class="composer-bottom"><span>Enter 发送 · Shift + Enter 换行</span><button class="primary send-button" aria-label="发送消息" type="submit">${icon('send')}</button></div></form><p class="chat-disclaimer">文件变更经你确认后应用 · 不自动代你规划</p></div></aside><button id="chat-rail" aria-label="展开 AI 聊天栏">${icon('spark')}<span>AI 助手</span>${icon('expand')}</button></main><footer class="workspace-footer"><span><i></i>本地工作区<span class="footer-divider">/</span>每一步思考，都有迹可循</span><span id="trace-status" role="status">轨迹待同步</span></footer>`;
  state.chatCollapsed=false;renderTree();renderTabs();renderMessages(true);applyPanels();bindWorkspace();persist();updateTimer(); recordEvent('workspace_opened',{file:activeFile});
  const agentState=state;
  const key=p.id;currentKey=key;
  const monaco=await monacoReady;
  if(currentKey!==key || state!==agentState || !$('#editor'))return;
  if(monaco){
    monaco.editor.defineTheme('yuzhi-light',{base:'vs',inherit:true,rules:[{token:'comment',foreground:'96A1B2',fontStyle:'italic'},{token:'keyword',foreground:'8057C5'},{token:'string',foreground:'379374'},{token:'number',foreground:'B98538'}],colors:{'editor.background':'#ffffff','editor.foreground':'#34435C','editorLineNumber.foreground':'#B5BECC','editorLineNumber.activeForeground':'#647C9E','editor.lineHighlightBackground':'#F5F8FD','editor.selectionBackground':'#DDE8FF','editorCursor.foreground':'#3268ED','editorIndentGuide.background1':'#EDF0F5'}});
    $('#editor').innerHTML='';
    editor=monaco.editor.create($('#editor'),{theme:'yuzhi-light',automaticLayout:true,editContext:false,fontSize:13,fontFamily:'"Cascadia Code", "DejaVu Sans Mono", Consolas, monospace',lineHeight:23,minimap:{enabled:false},padding:{top:18,bottom:18},scrollBeyondLastLine:false,renderLineHighlight:'all',smoothScrolling:true,tabSize:4,wordWrap:'off',glyphMargin:false,lineNumbersMinChars:3,fixedOverflowWidgets:true,ariaLabel:'项目代码编辑器'});
    editor.onDidChangeCursorPosition(e=>{if($('#cursor-position'))$('#cursor-position').textContent=`行 ${e.position.lineNumber}，列 ${e.position.column}`;});
    editor.addCommand(monaco.KeyMod.CtrlCmd|monaco.KeyCode.KeyS,()=>saveProject());
  } else { $('#editor').innerHTML='<textarea id="fallback-editor" spellcheck="false" aria-label="项目文件编辑器"></textarea>'; $('#fallback-editor').oninput=e=>updateFile(e.target.value); toast('高级编辑器暂不可用，已切换到基础编辑模式。'); }
  switchFile(activeFile);
  syncCurrent().then(()=>pollAgent(agentState));
  connectAgentStream(agentState);
  executionCleanup=mountExecution({traceId:agentState.trace.id,sync:()=>ensureSynced(agentState),activeFile:()=>activeFile,onUpdate:()=>{if(state===agentState)pollAgent(agentState);},openPanel:()=>{state.terminalCollapsed=false;applyPanels();},settings:()=>agentState.runSettings||{},saveSettings:value=>{agentState.runSettings=value;persist();}});
}
function language(path){return path.endsWith('.c')||path.endsWith('.h')?'c':path.endsWith('.py')?'python':path.endsWith('.md')?'markdown':path.endsWith('.json')?'json':'plaintext';}
function fileIcon(f){return `<span class="file-type ${language(f)}">${language(f)==='c'?'C'+(f.endsWith('.h')?'ʰ':''):language(f)==='python'?'Py':language(f)==='markdown'?'M↓':f.endsWith('.txt')?'≡':'#'}</span>`;}
function renderTree(){
  const folders = [...new Set(Object.keys(state.files).filter(f=>f.includes('/')).map(f=>f.split('/')[0]))];
  const fileButton = (f,indent=false)=>`<button class="file-row ${f===activeFile?'active':''} ${indent?'indented':''}" data-file="${esc(f)}" title="${esc(f)}">${fileIcon(f)}<span>${esc(indent?f.slice(f.indexOf('/')+1):f)}</span></button>`;
  $('#file-tree').innerHTML=folders.map(folder=>`<details open><summary>${icon('chevron')}${icon('folder')}<span>${esc(folder)}</span></summary>${Object.keys(state.files).filter(f=>f.startsWith(folder+'/')).map(f=>fileButton(f,true)).join('')}</details>`).join('')+Object.keys(state.files).filter(f=>!f.includes('/')).map(f=>fileButton(f)).join('');
  if(project.datasets){
    $('#file-tree').insertAdjacentHTML('beforeend',`<details open><summary>${icon('chevron')}${icon('folder')}<span>datasets · 只读</span></summary>${project.datasets.files.map(f=>`<div class="file-row indented" title="${esc(f.path)} · ${(f.bytes/1048576).toFixed(1)} MB">${icon('file')}<span>${esc(f.name)}</span></div>`).join('')}<p style="padding:0 12px;font-size:11px;line-height:1.6">数据已解压。代码和终端可直接读取 datasets/ 下的文件；大文件不在编辑器中打开。</p></details>`);
  }
  $$('[data-file]').forEach(b=>b.onclick=()=>switchFile(b.dataset.file));
  $('#file-count').textContent=Object.keys(state.files).length;
}
function renderTabs(){
  $('#file-tabs').innerHTML=openFiles.map(f=>`<div class="file-tab ${f===activeFile?'active':''}"><button role="tab" aria-selected="${f===activeFile}" data-open-file="${esc(f)}" title="${esc(f)}">${fileIcon(f)}${esc(f.split('/').at(-1))}</button><button class="tab-close" data-close-file="${esc(f)}" aria-label="关闭 ${esc(f)} 标签页">${icon('close')}</button></div>`).join('');
  $$('[data-open-file]').forEach(b=>b.onclick=()=>switchFile(b.dataset.openFile));
  $$('[data-close-file]').forEach(b=>b.onclick=()=>{
    const f=b.dataset.closeFile; if(openFiles.length===1)return toast('请至少保留一个打开的文件。');
    openFiles=openFiles.filter(x=>x!==f); if(activeFile===f)switchFile(openFiles.at(-1));else {renderTabs();persist();}
  });
  $('#file-breadcrumb').textContent=activeFile;
  $('#chat-file-context').textContent=activeFile;
  $('#language-label').textContent=language(activeFile)==='c'?'C':language(activeFile)==='python'?'Python':language(activeFile)==='markdown'?'Markdown':'Plain Text';
}
function switchFile(f){
  if(!Object.hasOwn(state.files,f))return;
  if(f!==activeFile){flushEdit();recordEvent('file_opened',{file:f});}
  if(editor && activeFile)views.set(activeFile,editor.saveViewState());
  activeFile=f;if(!openFiles.includes(f))openFiles.push(f);
  if(editor){
    modelListener?.dispose();
    if(!models.has(f))models.set(f,window.monaco.editor.createModel(state.files[f],language(f),window.monaco.Uri.parse(`file:///${project.id}/${f}`)));
    editor.setModel(models.get(f));if(views.has(f))editor.restoreViewState(views.get(f));
    modelListener=editor.onDidChangeModelContent(e=>updateFile(editor.getValue(),e));
  } else if($('#fallback-editor'))$('#fallback-editor').value=state.files[f];
  $$('.file-row').forEach(b=>b.classList.toggle('active',b.dataset.file===f));renderTabs();persist();
}
function updateFile(value,event){
  if(aiApplying)return;
  const before=state.files[activeFile]; if(before===value)return;
  const time=new Date().toISOString();
  let edit=state.trace.pendingEdit;
  if(edit && edit.file!==activeFile){flushEdit();edit=null;}
  edit ||= state.trace.pendingEdit={file:activeFile,before,after:before,startedAt:time,endedAt:time,changes:[]};
  edit.changes.push({timestamp:time,...textChange(before,value),isUndo:!!event?.isUndoing,isRedo:!!event?.isRedoing});
  edit.after=value;edit.endedAt=time;state.files[activeFile]=value;
  $('#save-state').textContent='正在保存…';clearTimeout(saveTimer);saveTimer=setTimeout(persist,350);
  clearTimeout(editTimer);editTimer=setTimeout(flushEdit,1500);
  if(Date.parse(time)-Date.parse(edit.startedAt)>=10000)flushEdit();
}
function initTrace(){
  state.trace ||= createTrace(project,state,currentSession().user.id);
  state.trace.syncing=false;
  if(state.trace.pendingEdit)flushEdit();
}
function flushEdit(){
  clearTimeout(editTimer);
  const edit=state?.trace?.pendingEdit;if(!edit)return;
  delete state.trace.pendingEdit;
  const event=addEvent(state.trace,'code_edited',edit);event.timestamp=edit.endedAt;
  persist();scheduleSync();
}
function recordEvent(type,payload={},actor='student',flush=true){
  if(!state?.trace)return;
  if(flush)flushEdit();const event=addEvent(state.trace,type,payload,actor);persist();scheduleSync();return event;
}
function scheduleSync(){
  const current=state,p=project;if(!current?.trace)return;
  pendingSync.set(current.trace.id,{current,p});
  clearTimeout(syncTimer);
  syncTimer=setTimeout(()=>syncCurrent(current,p),100);
}
function syncCurrent(current=state,p=project){
  if(!current?.trace||current.trace.studentId!==currentSession()?.user.id)return Promise.resolve();
  const key=storageKey(p.id,current.trace.studentId,current.trace.id);
  return syncTrace(current.trace,()=>{
    try{
      if(current===state)localStorage.setItem(key,JSON.stringify(current));
      else{
        const latest=JSON.parse(localStorage.getItem(key));
        if(latest?.trace?.id===current.trace.id){latest.trace.acknowledged=[...new Set([...latest.trace.acknowledged,...current.trace.acknowledged])];localStorage.setItem(key,JSON.stringify(latest));}
      }
    }catch{toast('本地存储已满，请导出轨迹。');}
  },message=>{if(current===state && $('#trace-status'))$('#trace-status').textContent=message;},{csrf:currentSession().csrf,onAuthError:()=>refreshSession()});
}
function saveProject(){flushEdit();recordEvent('code_saved',{file:activeFile,fileCount:Object.keys(state.files).length});persist();toast('项目已保存，轨迹同步中');}

function applyPanels(){
  $('#assessment').classList.toggle('chat-collapsed',!!state.chatCollapsed);
  $('.ide').classList.toggle('tree-collapsed',!!state.treeCollapsed);
  $('.editor-column').classList.toggle('terminal-collapsed',!!state.terminalCollapsed);
  $('#toggle-chat').setAttribute('aria-expanded',String(!state.chatCollapsed));
}
function togglePanel(key){state[key]=!state[key];applyPanels();persist();}
function renderMessages(showWelcome=false){
  $('#messages').innerHTML=`<div class="chat-welcome"><span class="welcome-icon">${icon('spark')}</span><h3>${esc(welcomeTitle)}</h3><p>${esc(welcomeBody)}</p><div class="welcome-rule"><span></span>先说思路，再动手实现<span></span></div><button class="suggestion" data-suggestion="这是我的实现规划：">${icon('book')} 描述我的规划 ${icon('arrow')}</button><button class="suggestion" data-suggestion="请解释一下这段代码的行为">${icon('layers')} 解释已有代码 ${icon('arrow')}</button><button class="suggestion" data-suggestion="请帮我解释这个报错：">${icon('check')} 解释报错信息 ${icon('arrow')}</button></div>`+state.messages.map(m=>`<div class="message ${m.role}"><div class="message-author">${m.role==='user'?'你':icon('spark')+(m.source==='ai'?' AI 助手':' AI Tutor · 历史演示')}</div><div class="bubble">${esc(m.text)}</div></div>`).join('');
  $$('[data-suggestion]').forEach(b=>b.onclick=()=>{$('#chat-input').value=b.dataset.suggestion;$('#chat-input').focus();});
  $('#messages').scrollTop=showWelcome?0:$('#messages').scrollHeight;
}
async function ensureSynced(current=state){
  flushEdit();persist();await syncCurrent(current,project);
  if(current.trace.events.some(e=>!current.trace.acknowledged.includes(e.id)))throw Error('轨迹还未同步成功，请等待网络恢复后重试，文件没有丢失。');
}
async function sendMessage(){
  const input=$('#chat-input'),value=input.value.trim();if(!value||['running','approval'].includes(agentInfo?.status))return;
  if(!agentInfo?.configured){toast('请教师先在 AI 连接中配置密钥。');return;}
  if(value.length>12000){toast('消息过长，请分步说明。');return;}
  const current=state,id=current.trace.id;
  const event=recordEvent('chat_user',{text:value,file:activeFile});
  state.messages.push({role:'user',text:value,eventId:event.id});input.value='';renderMessages();persist();
  try{
    await ensureSynced(current);
    if(current!==state)return;
    agentInfo={...agentInfo,status:'running'};drawAgent();
    await agentRequest(`/api/agent/${id}/message`,{messageId:event.id});
    await pollAgent(current);
  }catch(e){if(current===state){toast(e.message);await pollAgent(current);}}
}
function renderLiveReply(){
  const host=$('#messages');if(!host)return;
  let node=$('#live-ai-reply');
  if(!liveReply||state?.messages.some(m=>m.eventId===liveReply.id)){node?.remove();return;}
  const pinned=host.scrollHeight-host.scrollTop-host.clientHeight<80;
  if(!node){node=document.createElement('div');node.id='live-ai-reply';node.className='message assistant';node.innerHTML='<div class="message-author">AI 助手 · 正在生成</div><div class="bubble"></div><small class="live-phase"></small>';host.append(node);}
  node.querySelector('.bubble').textContent=liveReply.text;
  node.querySelector('.live-phase').textContent=liveReply.phase==='tool'?'正在准备工具操作；文件改动仍需确认':'回复尚未完成…';
  if(pinned)host.scrollTop=host.scrollHeight;
}
function connectAgentStream(current){
  agentStream?.close();
  const path=`/api/agent/${current.trace.id}/live`;
  agentStream=connectAgentLive({url:`${location.protocol==='https:'?'wss:':'ws:'}//${location.host}${path}`,
    isRunning:()=>agentInfo?.status==='running',
    fetchSnapshot:async signal=>{const r=await fetch(path,{cache:'no-store',signal});if(!r.ok)throw Error('实时连接暂不可用');return r.json();},
    onValue:value=>{
      if(current!==state)return;
      liveReply=value;
      if(liveReply)renderLiveReply();else pollAgent(current).finally(()=>{if(current===state)renderLiveReply();});
    },
    onStatus:status=>{if(current===state&&status==='reconnecting'&&$('#live-ai-reply .live-phase'))$('#live-ai-reply .live-phase').textContent='实时连接恢复中，正在补取已生成文字…';}
  });
}

function drawAgent(){
  if(!agentInfo||!state)return;
  renderAgentStatus(agentInfo,{prompt:()=>showPromptTrial(project.id,()=>pollAgent(state)),review:proposal=>reviewChanges(proposal,decideAgent),resume:async()=>{
    try{await ensureSynced();await agentRequest(`/api/agent/${state.trace.id}/resume`,{});pollAgent(state);}catch(e){toast(e.message);}
  }});
}
async function decideAgent(proposalId,approved){
  const current=state;
  await ensureSynced(current);
  if(current!==state)throw Error('项目已切换，请重新打开改动确认。');
  if(approved){editor?.updateOptions({readOnly:true});if($('#fallback-editor'))$('#fallback-editor').disabled=true;if($('#new-file'))$('#new-file').disabled=true;}
  try{await agentRequest(`/api/agent/${current.trace.id}/decision`,{proposalId,approved});await pollAgent(current);}
  catch(e){editor?.updateOptions({readOnly:false});if($('#fallback-editor'))$('#fallback-editor').disabled=false;if($('#new-file'))$('#new-file').disabled=false;throw e;}
}
async function pollAgent(current){
  clearTimeout(agentTimer);
  if(!current?.trace||current!==state)return;
  try{
    const info=await agentRequest(`/api/agent/${current.trace.id}`);
    if(current!==state)return;
    agentInfo=info;let changed=false,filesChanged=false;
    const known=new Set(current.trace.events.map(e=>e.id));
    for(const event of info.events){
      if(known.has(event.id))continue;
      if(event.type==='ai_changes_applied'){
        const conflict=event.payload.changes.some(c=>{const local=Object.hasOwn(current.files,c.path)?current.files[c.path]:null;return local!==c.before&&local!==c.after;});
        if(conflict){toast('收到其他页面的 AI 改动，本地内容已保留，请先导出项目并核对版本。');continue;}
        for(const change of event.payload.changes)current.files[change.path]=change.after;
        filesChanged=true;
      }
      if(['ai_response','ai_response_partial'].includes(event.type)&&!current.messages.some(m=>m.eventId===event.id)){current.messages.push({role:'assistant',text:event.payload.text,source:'ai',eventId:event.id});changed=true;}
      current.trace.events.push(event);current.trace.acknowledged.push(event.id);known.add(event.id);
    }
    if(filesChanged){
      aiApplying=true;modelListener?.dispose();
      try{for(const [file,model] of models)if(Object.hasOwn(current.files,file)&&model.getValue()!==current.files[file])model.setValue(current.files[file]);renderTree();renderTabs();switchFile(activeFile);}
      finally{aiApplying=false;}
    }
    if(info.status!=='running'){editor?.updateOptions({readOnly:false});if($('#fallback-editor'))$('#fallback-editor').disabled=false;if($('#new-file'))$('#new-file').disabled=false;}
    if(changed)renderMessages();renderLiveReply();persist();drawAgent();
  }catch(error){if(current===state&&$('#agent-controls'))$('#agent-controls').textContent='AI 状态暂不可用 · 将自动重连';}
  finally{if(current===state)agentTimer=setTimeout(()=>pollAgent(current),['running','approval'].includes(agentInfo?.status)?1400:8000);}
}
function appendConsole(text,cls=''){const div=document.createElement('div');div.textContent=text;div.className=cls;$('#console-output').append(div);$('#console-output').scrollTop=$('#console-output').scrollHeight;}
function bindWorkspace(){
  $$('[data-problem-tab]').forEach(b=>b.onclick=async()=>{
    $$('[data-problem-tab]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-selected',String(x===b));});
    const token=++pendingSource, id=project.id;$('#problem-content').innerHTML=problemBody(b.dataset.problemTab);
    if(b.dataset.problemTab==='source')try{const res=await fetch(`/api/problems/${id}`);if(!res.ok)throw Error();const {content}=await res.json();if(token===pendingSource&&project?.id===id&&$('#source-text'))$('#source-text').textContent=content;}catch{if($('#source-text'))$('#source-text').textContent='原始题面加载失败，请重新选择此标签页。';}
  });
  $('#toggle-chat').onclick=$('#collapse-chat').onclick=$('#chat-rail').onclick=()=>togglePanel('chatCollapsed');
  $('#hide-tree').onclick=$('#show-tree').onclick=()=>togglePanel('treeCollapsed');
  $('#hide-terminal').onclick=$('#toggle-terminal').onclick=()=>togglePanel('terminalCollapsed');
  $('#save-project').onclick=()=>saveProject();
  $('#new-file').onclick=()=>{$('#file-error').textContent='';$('#file-path').value='';$('#file-dialog').showModal();$('#file-path').focus();};
  $('#export-project').onclick=()=>{
    recordEvent('project_exported',{fileCount:Object.keys(state.files).length});persist();const blob=new Blob([JSON.stringify({project:project.id,title:project.name,exportedAt:new Date().toISOString(),files:state.files,messages:state.messages,trace:state.trace},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${esc(project.folder)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);toast('已导出项目文件与对话记录');
  };
  $('#chat-form').onsubmit=e=>{e.preventDefault();sendMessage();};
  $('#chat-input').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();sendMessage();}};

}
function validPath(value){return typeof value==='string' && value.length<=160 && value!=='datasets' && !value.startsWith('datasets/') && !value.startsWith('/') && !value.includes('\\') && !/[\x00-\x1f<>:"|?*]/.test(value) && value.split('/').every(p=>p&&p!=='.'&&p!=='..'&&!['__proto__','constructor','prototype'].includes(p));}
$('#file-form').onsubmit=e=>{
  e.preventDefault();if(!state)return;const name=$('#file-path').value.trim();
  if(!validPath(name)){ $('#file-error').textContent='请输入有效的相对文件路径，不可包含 .. 或特殊字符。';return; }
  if(name==='artifacts'||name.startsWith('artifacts/')){ $('#file-error').textContent='artifacts 目录用于保存运行产物，请在其他目录创建源码。';return; }
  if(Object.hasOwn(state.files,name)){ $('#file-error').textContent='这个文件已存在，请换一个名称。';return; }
  flushEdit();state.files[name]='';recordEvent('file_created',{file:name,content:''});renderTree();switchFile(name);$('#file-dialog').close();toast(`已创建 ${name}`);
};
$('#file-cancel').onclick=()=>$('#file-dialog').close();
function updateTimer(){if(!state||!$('#timer'))return;const t=Math.floor(state.elapsed);$('#timer').textContent=[Math.floor(t/3600),Math.floor(t/60)%60,t%60].map(v=>String(v).padStart(2,'0')).join(':');}
setInterval(()=>{if(state&&!document.hidden){state.elapsed+=1;updateTimer();if(state.elapsed%10===0)persist();}},1000);
window.addEventListener('beforeunload',()=>{flushEdit();clearTimeout(saveTimer);persist();});
document.addEventListener('visibilitychange',()=>{if(document.hidden){flushEdit();persist();}});
function retryPending(){for(const {current,p} of pendingSync.values())syncCurrent(current,p);}
window.addEventListener('online',retryPending);
setInterval(retryPending,5000);
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'&&state){e.preventDefault();saveProject();}});
let refreshing=false;
function announceAccountChange(){try{localStorage.setItem('yuzhi-auth-change',crypto.randomUUID());}catch{}}
async function refreshSession(){
  if(refreshing)return;
  refreshing=true;
  try {
    const next=await authRequest('me');
    if(next.user?.id!==currentSession()?.user.id||next.csrf!==currentSession()?.csrf){
      cleanup();project=null;state=null;currentKey=null;clearTimeout(syncTimer);pendingSync.clear();
      setSession(next);route();
    }
  }catch{toast('暂时无法连接服务器，本地修改已保留。');}
  finally{refreshing=false;}
}
async function logout(){
  const button=$('#account-logout');if(button)button.disabled=true;
  cleanup();project=null;state=null;currentKey=null;
  await Promise.all([...pendingSync.values()].map(({current,p})=>syncCurrent(current,p)));
  try{
    await authRequest('logout',{});clearTimeout(syncTimer);pendingSync.clear();setSession(null);
    announceAccountChange();location.hash='#/login';route();
  }catch(e){toast(e.message);if(button)button.disabled=false;route();}
}
let routeVersion=0;
async function route(){
  const routeTicket=++routeVersion;
  currentKey=null;
  renderAccountHeader(logout);
  if(!currentSession()){
    cleanup();project=null;state=null;
    renderAuth(result=>{announceAccountChange();location.hash=result.user.role==='teacher'?'#/teacher':'#/student';route();});
    return;
  }
  try{const response=await fetch('/api/projects',{cache:'no-store'});const loaded=response.status===404?(await import('./projects.js')).projects:response.ok?await response.json():null;if(!loaded)throw Error('项目列表加载失败');if(routeTicket!==routeVersion)return;projects=loaded;}
  catch(e){cleanup();$('#app').innerHTML='<div class="teacher-empty">项目列表暂时无法加载，请刷新重试。</div>';return;}
  const teacher=location.hash.split('?')[0].match(/^#\/teacher(?:\/([a-zA-Z0-9_-]{8,80}))?$/);
  if(teacher && currentSession().user.role!=='teacher'){location.hash='#/student';return;}
  if(teacher){
    flushEdit();cleanup();project=null;state=null;
    const target=location.hash;
    const waiting=[];
    for(const p of projects){
      const current=readState(p);if(!current.trace)continue;
      if(current.trace.pendingEdit){const edit=current.trace.pendingEdit;delete current.trace.pendingEdit;const e=addEvent(current.trace,'code_edited',edit);e.timestamp=edit.endedAt;try{localStorage.setItem(storageKey(p.id),JSON.stringify(current));}catch{toast('本地记录保存失败，请返回学生端导出。');}}
      const pending=pendingSync.get(current.trace.id);
      if(pending)waiting.push(syncCurrent(pending.current,pending.p));
      else{pendingSync.set(current.trace.id,{current,p});waiting.push(syncCurrent(current,p));}
    }
    $('#app').innerHTML='<div class="teacher-empty">正在同步作答记录…</div>';
    Promise.all(waiting).finally(()=>{if(location.hash===target)renderTeacher(projects,teacher[1]);});return;
  }
  const id=location.hash.split('?')[0].match(/^#\/project\/(project[1-9][0-9]{0,5})$/)?.[1],p=projects.find(p=>p.id===id);
  const attemptId=new URLSearchParams(location.hash.split('?')[1]||'').get('attempt');
  if(p){if(attemptId)renderWorkspace(p,attemptId);else renderAttemptPicker(p);}else if(location.hash==='#/student')renderHome();else {location.hash=currentSession().user.role==='teacher'?'#/teacher':'#/student';}
}
let booted=false;
window.addEventListener('hashchange',()=>{if(booted)route();});
window.addEventListener('storage',event=>{if(event.key==='yuzhi-auth-change')refreshSession();});
window.addEventListener('focus',()=>{if(booted)refreshSession();});
async function boot(){
  $('#app').innerHTML='<div class="teacher-empty">正在连接学习空间…</div>';
  try{setSession(await authRequest('me'));booted=true;route();}
  catch{$('#app').innerHTML='<div class="teacher-empty"><h2>暂时无法连接服务器</h2><p>请检查网络连接后重试。</p><button id="retry-connection">重新连接</button></div>';$('#retry-connection').onclick=boot;}
}
boot();
