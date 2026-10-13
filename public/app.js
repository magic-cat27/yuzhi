import { reviewCode } from './code-review.js';
import { interactionTrace } from './interaction-trace.js';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
let problems = [], session, current, status, tab = 'plan', view = 'workspace', editor, busy = false, codeDirty = false;
let sessions = {}, exam = null, entering = false;
let allProblems = [], activeSet;
let problemSets = [];
const languageLabel = language => language === 'cpp' ? 'C++17 / G++' : 'C11 / GCC';
const codeFilename = () => current?.language === 'cpp' ? 'main.cpp' : 'main.c';

const sessionStates = new Map();
const drafts = new Map();
async function api(path, body) { const r = await fetch('/api/' + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error || '请求失败'); return data; }
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('visible'); clearTimeout(toast.timer); toast.timer = setTimeout(() => $('#toast').classList.remove('visible'), 5500); }
function showGuardWarning() { if (!$('#guard-warning').open) $('#guard-warning').showModal(); }
$('#guard-warning-confirm').onclick = () => $('#guard-warning').close();
$('#guard-warning').addEventListener('close', () => $('#chat-input').focus());
function confirmDialog(title, html, label = '确认') { return new Promise(resolve => { $('#dialog-body').innerHTML = `<h2>${esc(title)}</h2>${html}`; $('#dialog-confirm').textContent = label; $('#dialog').showModal(); const finish = yes => { $('#dialog').close(); resolve(yes); }; $('#dialog-confirm').onclick = () => finish(true); $('#dialog-cancel').onclick = () => finish(false); $('#dialog').oncancel = () => resolve(false); }); }
function setBusy(value) { busy = value; $('#send').textContent = value ? '处理中…' : '发送 ↑'; updateState(); }
function code() { return editor ? editor.getValue() : $('#code-fallback').value; }
function putCode(value) { if (editor) editor.setValue(value); else $('#code-fallback').value = value; codeDirty = false; $('#code-save-state').textContent = '已保存'; }
function storeDraft() { if (!session) return; const d = { plan: $('#plan-editor').value, code: code(), stdin: $('#stdin').value }; drafts.set(session.id, d); localStorage.setItem(`yuzhi-draft-${session.id}`, JSON.stringify(d)); }
function updateState() {
  if (!session) return;
  sessionStates.set(session.problemId, session);
  const ended = Boolean(session.endedAt), unlocked = session.versions.length > 0;
  const dirty = $('#plan-editor').value !== session.plan;
  $('#save-state').textContent = dirty || !unlocked ? '未保存' : '已保存'; $('#save-state').classList.toggle('dirty', dirty || !unlocked);
  $('#plan-count').textContent = `${$('#plan-editor').value.length} 字`;
  $('#version-label').textContent = unlocked ? `已保存 ${session.versions.length} 个版本 · 当前 v${session.versions.length}` : '尚未生成版本';
  $('#chat-lock').textContent = unlocked ? '' : '⌑';
  $('#chat-context').textContent = unlocked ? `参考规划 v${session.versions.length} · ${dirty ? '有未保存修改，AI 仍使用已保存版本' : '规划与代码由你掌握'}` : '先独立完成并保存规划文档，再开启 AI 协作。';
  $('#chat-input').disabled = !unlocked || ended || busy;
  $('#send').disabled = !unlocked || ended || busy;
  $('#save-plan').disabled = ended || busy; $('#save-code').disabled = ended || busy; $('#run').disabled = ended || busy; $('#end').disabled = ended || busy;
  $('#plan-editor').readOnly = ended || busy; $('#code-fallback').readOnly = ended || busy; editor?.updateOptions({ readOnly: ended || busy });
  $('#session-status').textContent = ended ? '已提交 · 只读' : unlocked ? '考核进行中' : '规划阶段';
  $('#footer-status').textContent = `规划 ${session.versions.length} 版 · 对话 ${session.chats.length / 2} 轮`;
  const selected = status.models.find(m => m.id === $('#model-select').value);
  $('#model-select').disabled = ended || busy;
  $('#send').disabled ||= !selected?.configured;
  $('#model-status').textContent = !status.pi ? 'PI 依赖待安装' : selected?.configured ? `${selected.route} · 密钥已配置` : `${selected?.route || '模型'} · 未配置密钥`;
  $('#model-status').classList.toggle('status-green', status.pi && selected?.configured);
}
async function selectProblem(id, fresh = false) {
  if (busy) return toast('请等待当前操作结束');
  if (!exam) return;
  storeDraft(); current = problems.find(p => p.id === id); if (!current) return;
  session = null;
  if (sessions[id] && !fresh) { try { session = await api(`sessions/${sessions[id]}`); } catch {} }
  if (!session) { session = await api('sessions', { problemId: id }); sessions[id] = session.id;  }
  let draft = drafts.get(session.id); if (!draft) { try { draft = JSON.parse(localStorage.getItem(`yuzhi-draft-${session.id}`)); } catch {} }
  $('#plan-editor').value = !session.endedAt && draft ? (draft.plan ?? session.plan) : session.plan;
  $('.language-badge').textContent = languageLabel(current.language);
  $('#code-filename').textContent = codeFilename();
  $('#code-language').textContent = `${languageLabel(current.language)} · UTF-8`;
  $('#code-fallback').setAttribute('aria-label', `${current.language === 'cpp' ? 'C++' : 'C'} 代码编辑器`);
  if (editor) { monaco.editor.setModelLanguage(editor.getModel(), current.language === 'cpp' ? 'cpp' : 'c'); editor.updateOptions({ ariaLabel: `${current.language === 'cpp' ? 'C++' : 'C'} 代码编辑器` }); }
  putCode(!session.endedAt && draft ? draft.code : session.code);
  codeDirty = code() !== session.code;
  $('#stdin').value = draft?.stdin ?? current.sampleInput;
  $('#problem-heading').textContent = `${current.number} / ${current.title}`;
  $('#problem-list').innerHTML = problems.map(p => `<button class="problem-item ${p.id === id ? 'active' : ''}" data-problem="${p.id}"><span class="problem-num">${p.number}</span><span><strong>${esc(p.title.split(' · ')[0])}</strong><small>${esc(p.title.split(' · ')[1])}</small></span></button>`).join('');
  $$('[data-problem]').forEach(b => b.onclick = () => selectProblem(b.dataset.problem).catch(e => toast(e.message)));
  $('#problem-content').innerHTML = `<span class="eyebrow">${esc(current.course)} / PROGRAMMING</span><h2>${esc(current.title)}</h2><div class="tags"><span class="tag level">${esc(current.difficulty)}</span>${current.tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div><p>${esc(current.description)}</p><h3>输入格式</h3><p>${esc(current.input)}</p><h3>输出格式</h3><p>${esc(current.output)}</p><h3>样例输入</h3><div class="sample-box"><div class="sample-label">STDIN</div><pre>${esc(current.sampleInput)}</pre></div><h3>样例输出</h3><div class="sample-box"><div class="sample-label">STDOUT</div><pre>${esc(current.sampleOutput)}</pre></div><div class="problem-note">先完成规划，再开启 AI 协作。请独立考虑题目中的输入约束与边界情况。</div>`;
  const source = current.source || activeSet.source;
  if (source) $('#problem-content').insertAdjacentHTML('beforeend', `<div class="problem-source">选题参考：<a href="${esc(source.url)}" target="_blank" rel="noopener noreferrer">${esc(source.title)}</a><p>本平台自编的单文件练习，参考公开资料主题，非原课程完整实验。</p></div>`);
  showRun(); renderMessages(); setView('workspace'); setTab('plan'); updateState();
}
function setTab(name) { tab = name; $$('.tab').forEach(t => { const selected = t.dataset.tab === name; t.classList.toggle('active', selected); t.setAttribute('aria-selected', String(selected)); }); ['plan', 'chat', 'code'].forEach(n => $(`#${n}-pane`).classList.toggle('hidden', n !== name)); if (name === 'code') editor?.layout(); }
function renderMessages() {
  if (!session.chats.length) {
    $('#messages').innerHTML = `<div class="chat-welcome"><div class="welcome-symbol">✦</div><h3>你来规划，AI 来实现</h3><p>保存你的规划后，告诉 AI 需要完成什么。<br>遇到不明确的设计，AI 会请你补充。<br>生成的代码由你确认后写入。</p><div class="steps">独立规划 → 保存文档 → 开始协作</div></div>`; return;
  }
  $('#messages').innerHTML = session.chats.map((m, i) => {
    let chunks = m.text.split(/```(?:c|C|cpp|c\+\+)?\s*\n([\s\S]*?)```/g);
    return `<div class="message ${m.role}"><div class="who">${m.role === 'user' ? '你' : m.blocked ? '平台提示' : '✦ AI · ' + esc(m.modelName || m.model || 'DeepSeek（历史记录）')}</div><div class="bubble">${chunks.map((c, j) => j % 2 ? `<pre>${esc(c)}</pre>${m.role === 'assistant' ? `<button class="small primary apply-code" data-message="${i}" data-block="${j}">查看修改并应用 ${codeFilename()}</button>` : ''}` : esc(c)).join('')}</div></div>`;
  }).join('');
  $$('.apply-code').forEach(b => { b.disabled = Boolean(session?.endedAt) || busy; b.onclick = async () => {
    const value = session.chats[Number(b.dataset.message)].text.split(/```(?:c|C|cpp|c\+\+)?\s*\n([\s\S]*?)```/g)[Number(b.dataset.block)].trim() + '\n';
    const original = code(), sessionId = session.id;
    const approved = await reviewCode({ original, proposed: value, filename: codeFilename(), language: current.language === 'cpp' ? 'cpp' : 'c' });
    if (!approved) return;
    if (session?.id !== sessionId || session.endedAt || busy || code() !== original) return toast('当前代码或作答状态已变化，请重新查看差异');
    setBusy(true);
    try { session = await api(`sessions/${sessionId}/code`, { code: value, source: 'ai' }); putCode(value); storeDraft(); setTab('code'); updateState(); toast('已应用审核后的修改，可以编译运行'); } catch (e) { toast(e.message); }
    finally { setBusy(false); }
  }; });
  $('#messages').scrollTop = $('#messages').scrollHeight;
}
function showRun() { const r = session.lastRun; if (!r) { $('#run-state').textContent = '尚未运行'; $('#output').textContent = '点击「编译运行」查看真实输出。'; return; } const label = r.stopped ? '超时 / 输出超限' : r.stage === 'compile' ? '编译失败' : r.exitCode === 0 ? '运行完成' : `退出状态 ${r.exitCode}`; $('#run-state').textContent = label; $('#run-state').className = r.exitCode === 0 ? 'status-green' : 'status-red'; $('#output').textContent = [r.stdout, r.stderr, r.warnings].filter(Boolean).join('\n') || '程序正常结束，无输出。'; }
async function saveCode() { if (code() === session.code) return; session = await api(`sessions/${session.id}/code`, { code: code(), source: 'manual' }); codeDirty = false; $('#code-save-state').textContent = '已保存'; updateState(); storeDraft(); }
$('#save-plan').onclick = async () => { try { session = await api(`sessions/${session.id}/plan`, { text: $('#plan-editor').value }); storeDraft(); updateState(); toast(`规划 v${session.versions.length} 已保存，AI 对话已解锁`); } catch (e) { toast(e.message); } };
$('#plan-editor').oninput = () => { storeDraft(); updateState(); };
$('#save-code').onclick = () => saveCode().then(() => toast('代码已保存')).catch(e => toast(e.message));
function changedCode() { codeDirty = true; $('#code-save-state').textContent = '未保存'; storeDraft(); }
$('#code-fallback').oninput = changedCode; $('#stdin').oninput = storeDraft;
$('#sample-input').onclick = () => { $('#stdin').value = current.sampleInput; storeDraft(); };
$('#run').onclick = async () => { setBusy(true); $('#run-state').textContent = '编译运行中…'; try { session = await api(`sessions/${session.id}/run`, { code: code(), stdin: $('#stdin').value }); codeDirty = false; $('#code-save-state').textContent = '已保存'; showRun(); storeDraft(); } catch (e) { toast(e.message); $('#run-state').textContent = '运行失败'; } finally { setBusy(false); } };
$('#send').onclick = async () => { const text = $('#chat-input').value.trim(); if (!text || busy) return; setBusy(true); try { await saveCode(); session = await api(`sessions/${session.id}/chat`, { text, model: $('#model-select').value }); $('#chat-input').value = ''; renderMessages(); const last = session.chats.at(-1); if (last?.role === 'assistant' && last.blocked === true) showGuardWarning(); } catch (e) { toast(e.message); } finally { setBusy(false); renderMessages(); } };
$('#chat-input').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#send').click(); };
$('#end').onclick = async () => { if (busy) return; if (!await confirmDialog('结束本次考核？', '<p>当前代码会保存，考核结束后将变为只读。未保存的规划草稿不会作为正式版本提交，请先确认规划已经保存。</p>', '确认结束')) return; try { setBusy(true); await saveCode(); for (const [problemId, id] of Object.entries(sessions)) { const state = sessionStates.get(problemId); const ended = state?.endedAt ? state : await api(`sessions/${id}/end`, {}); sessionStates.set(problemId, ended); if (id === session.id) session = ended; } exam.endedAt = Date.now(); updateState(); renderMessages(); setView('overview'); toast('题集已提交，完整轨迹已保留'); } catch (e) { toast(e.message); } finally { setBusy(false); } };
$('#work-help').onclick = () => confirmDialog('如何完成一次考核', '<p>1. 阅读题目，独立编写并保存规划。<br>2. 在 AI 对话中发出实现请求。<br>3. 如果 AI 反问，请在规划文档中补全并保存。<br>4. 检查生成的代码，确认写入当前代码文件。<br>5. 编译运行，检查结果，必要时继续排查。<br>6. 结束并提交考核。</p><p>当前为本机演示版，过程评分后续接入。</p>', '知道了');
$$('.tab').forEach(b => b.onclick = () => setTab(b.dataset.tab));
$$('.nav-item').forEach(b => b.onclick = () => setView(b.dataset.view));
const names = { chat_blocked: '已拦截', chat_failed: '回复未完成', session_start: '开始考核', doc_save: '保存规划', chat_user: '学生发出指令', chat_ai: 'AI 回复', code_apply: '确认应用 AI 代码', code_edit: '保存手动代码', code_run: '编译运行', session_end: '结束考核', paste: '粘贴操作' };
function setView(name) {
  if (!exam || !['overview', 'workspace'].includes(name)) return;
  view = name;
  $('.sidebar').classList.toggle('hidden', name === 'overview');
  $('.workspace-heading').classList.toggle('hidden', name === 'overview');
  if (name === 'overview') { renderOverview(); } $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name)); $('#workspace').classList.toggle('hidden', name !== 'workspace'); $('#alternate-view').classList.toggle('hidden', name === 'workspace');
  if (name === 'overview') return;
  if (name === 'workspace') { if (tab === 'code') editor?.layout(); return; }
}

for (const [selector, name] of [['#plan-editor', 'plan'], ['#code-fallback', 'code'], ['#chat-input', 'chat']]) $(selector).addEventListener('paste', e => { if (!session || session.endedAt || busy) return; api(`sessions/${session.id}/paste`, { length: e.clipboardData.getData('text').length, tab: name }).catch(() => {}); });
function updateTimer() { const seconds = exam ? Math.max(0, Math.floor(((exam.endedAt || Date.now()) - exam.startedAt) / 1000)) : 0; const value = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':'); $('#timer').textContent = '◷ ' + value; if ($('#overview-time')) $('#overview-time').textContent = value; }
setInterval(updateTimer, 1000);
window.addEventListener('beforeunload', storeDraft);
function showSets() {
  document.body.classList.add('at-home'); $('#sets-page').classList.remove('hidden'); $('.layout').classList.add('hidden'); $('#back-to-sets').classList.add('hidden');
  $('.course').innerHTML = '考核练习<span>规划由你掌握，实现与 AI 协作</span>';
  $('#footer-status').textContent = '选择题集后开始计时';
  exam = null; updateTimer();
  $('.sets-tabs small').textContent = `全部题集 · ${problemSets.length}`;
  $('#set-list').innerHTML = problemSets.map(set => { const count = allProblems.filter(p => set.problemIds.includes(p.id)).length; return `<button class="set-card" data-set="${set.id}" ${!count ? 'disabled' : ''}><span class="set-icon">▣</span><span class="set-info"><strong>${esc(set.title)}</strong><small>${count} 道编程题 · ${languageLabel(set.language)} · ${esc(set.category)}</small></span><span class="set-right"><span class="pill">${count ? '可参加' : '请重启服务加载题目'}</span><small>进入考核 →</small></span></button>`; }).join('');
  $$('[data-set]').forEach(b => b.onclick = () => enterSet(b.dataset.set));
}
async function leaveExam() {
  if (busy || entering) return toast('请等待当前操作结束');
  if (exam && !exam.endedAt && !await confirmDialog('返回题集列表？', '<p>本次记录会保留。再次进入题集将开启新的考核，规划、代码和对话重新开始。</p>', '返回列表')) return;
  storeDraft(); showSets();
}
async function enterSet(setId) {
  if (entering) return;
  activeSet = problemSets.find(s => s.id === setId);
  if (!activeSet) return;
  problems = allProblems.filter(p => activeSet.problemIds.includes(p.id));
  if (!problems.length) return;
  entering = true; $$('[data-set]').forEach(b => b.disabled = true);
  try {
    storeDraft(); session = null; sessions = {}; sessionStates.clear();
    exam = { startedAt: Date.now(), endedAt: null };
    for (const p of problems) { const state = await api('sessions', { problemId: p.id }); sessions[p.id] = state.id; sessionStates.set(p.id, state); }
    document.body.classList.remove('at-home'); $('#sets-page').classList.add('hidden'); $('.layout').classList.remove('hidden'); $('#back-to-sets').classList.remove('hidden');
    $('.course').innerHTML = `${esc(activeSet.title)}<span>AI 协同编程考核</span>`;
    $('.sidebar-sub').textContent = `${activeSet.course} · ${activeSet.language === 'cpp' ? '单文件 C++' : '单文件 C'}`;
    $('#problem-count').textContent = String(problems.length).padStart(2, '0');
    await selectProblem(problems[0].id); updateTimer(); setView('overview');
  } catch (e) { showSets(); toast(e.message); }
  finally { entering = false; $$('[data-set]').forEach(b => b.disabled = !allProblems.some(p => problemSets.find(s => s.id === b.dataset.set).problemIds.includes(p.id))); }
}
function renderOverview() {
  const states = [...sessionStates.values()];
  const planned = states.filter(s => s.versions.length).length;
  const tested = states.filter(s => s.lastRun).length;
  const ended = Boolean(exam.endedAt);
  $('#alternate-view').innerHTML = `<div class="overview-grid"><div class="overview-hero">▣<span>${esc(activeSet.title)}</span></div><section class="overview-card"><div class="overview-title"><h2>本次考核</h2><span class="pill">${ended ? '已提交' : '答题中'}</span></div><p>开始时间 <strong>${new Date(exam.startedAt).toLocaleString('zh-CN')}</strong></p><p>考核用时 <strong id="overview-time">00:00:00</strong></p><div class="overview-actions"><button id="continue-exam" class="primary">${ended ? '查看作答' : '开始答题'} →</button><button id="overview-end" class="end-button" ${ended ? 'disabled' : ''}>结束考核</button></div></section><section class="overview-card"><h2>题集信息</h2><p>题目类型 <strong>编程题</strong></p><p>编程语言 <strong>${languageLabel(activeSet.language)}</strong></p><p>题目数量 <strong>${problems.length} 道</strong></p></section><section class="overview-card progress-card"><h2>作答进度</h2><div class="overview-stats"><span>已保存规划 <strong>${planned} / ${problems.length}</strong></span><span>已尝试运行 <strong>${tested} / ${problems.length}</strong></span><span>考核状态 <strong>${ended ? '已结束' : '进行中'}</strong></span></div><table><thead><tr><th>编程题</th><th>规划版本</th><th>运行状态</th><th>操作</th></tr></thead><tbody>${problems.map(p => { const s = sessionStates.get(p.id); return `<tr><td>${esc(p.title)}</td><td>${s.versions.length ? 'v' + s.versions.length : '未保存'}</td><td>${s.lastRun ? (s.lastRun.exitCode === 0 ? '运行完成' : '需检查') : '未运行'}</td><td><button class="text-button" data-overview-problem="${p.id}">${ended ? '查看' : '答题'} →</button></td></tr>`; }).join('')}</tbody></table></section><section class="overview-card"><h2>考核流程</h2><ol class="overview-flow"><li>独立规划<span>保存规划，解锁 AI</span></li><li>协同实现<span>检查并确认写入代码</span></li><li>运行验证<span>测试结果，排查问题</span></li><li>结束考核<span>保存本次过程记录</span></li></ol><button id="overview-back" class="text-button">返回题集列表 →</button></section></div>`;
  $('#continue-exam').onclick = () => setView('workspace');
  $('#overview-end').onclick = () => $('#end').click();
  $('#overview-back').onclick = leaveExam;
  $$('[data-overview-problem]').forEach(b => b.onclick = () => selectProblem(b.dataset.overviewProblem).catch(e => toast(e.message)));
  updateTimer();
}
$('#back-to-sets').onclick = leaveExam;
$('.brand').onclick = e => { e.preventDefault(); switchRole(); };
async function init() {
  [allProblems, status, problemSets] = await Promise.all([api('problems'), api('status'), api('problem-sets')]);
  $('#model-select').innerHTML = status.models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}${m.recommended ? ' · 推荐' : ''}${m.configured ? '' : ' · 未配置'}</option>`).join('');
  $('#model-select').value = status.model;
  $('#model-select').onchange = updateState;
  showRoles();
  if (window.require) { window.require.config({ paths: { vs: '/vendor/vs' } }); window.require(['vs/editor/editor.main'], () => {
    const value = $('#code-fallback').value;
    editor = monaco.editor.create($('#monaco-editor'), { value, language: current?.language === 'cpp' ? 'cpp' : 'c', theme: 'vs', editContext: false, ariaLabel: current?.language === 'cpp' ? 'C++ 代码编辑器' : 'C 代码编辑器', fontSize: 12, fontFamily: 'Consolas, monospace', minimap: { enabled: false }, scrollBeyondLastLine: false, automaticLayout: true, padding: { top: 16 }, lineNumbersMinChars: 3, overviewRulerLanes: 0, readOnly: Boolean(session?.endedAt) });
    $('#code-fallback').classList.add('hidden'); editor.onDidChangeModelContent(changedCode); editor.onDidPaste(e => { if (session && !session.endedAt && !busy) api(`sessions/${session.id}/paste`, { length: editor.getModel().getValueInRange(e.range).length, tab: 'code' }).catch(() => {}); });
  }, () => { $('#monaco-editor').classList.add('hidden'); }); } else $('#monaco-editor').classList.add('hidden');
}
init().catch(e => toast(`初始化失败：${e.message}`));

let teacherRecords = [], teacherTab = 'records';
function showRoles() {
  document.body.classList.add('at-home');
  ['#sets-page', '#teacher-page', '.layout', '#back-to-sets', '#switch-role', '#teacher-models'].forEach(s => $(s).classList.add('hidden'));
  $('#role-page').classList.remove('hidden');
  $('.course').innerHTML = 'AI 协同编程考核<span>规划由学生掌握，实现与 AI 协作</span>';
  $('.avatar').textContent = '驭智'; $('#footer-status').textContent = '请选择进入学生端或教师端';
}
async function switchRole() {
  if (busy || entering) return toast('请等待当前操作结束');
  if (exam && !exam.endedAt && !await confirmDialog('离开本次作答？', '<p>已保存的记录会保留。再次进入学生端会开启新的考核，请先保存规划和代码。</p>', '切换入口')) return;
  storeDraft(); session = null; exam = null; sessions = {}; sessionStates.clear(); showRoles();
}
$('#switch-role').onclick = switchRole;
$('#teacher-models').onclick = async () => {
  try {
    status = await api('status');
    if ($('#teacher-page').classList.contains('hidden')) return;
    await confirmDialog('模型配置', `<span class="eyebrow">MODEL PROVIDERS</span><p class="teacher-muted">主模型：${esc(status.model)}。密钥已配置不代表模型已开通或连接已验证；具体可用性以服务商授权和实际调用为准。</p><div class="teacher-courses">${status.models.map(m => `<section class="teacher-course"><div class="teacher-title"><strong>${esc(m.name)}${m.recommended ? ' · 推荐主模型' : ''}</strong><span class="pill">${m.configured ? '密钥已配置' : '未配置'}</span></div><p>${esc(m.brand)} · ${esc(m.purpose)}</p><p class="teacher-muted">接入渠道：${esc(m.route)} · 模型 ID：${esc(m.id)}</p></section>`).join('')}</div><p class="teacher-muted">百炼模型在服务端配置 DASHSCOPE_API_KEY，DeepSeek 配置 DEEPSEEK_API_KEY。第三方模型可能需要在百炼控制台单独开通。修改配置后重启服务。</p>`, '关闭');
  } catch (e) { toast(e.message); }
};
$$('[data-role]').forEach(b => b.onclick = async () => {
  $$('[data-role]').forEach(x => x.disabled = true);
  try {
    await api('role', { role: b.dataset.role });
    $('#role-page').classList.add('hidden'); $('#switch-role').classList.remove('hidden');
    $('.avatar').textContent = b.dataset.role === 'student' ? '学生' : '教师';
    if (b.dataset.role === 'student') showSets();
    else {
      $('#teacher-page').classList.remove('hidden');
      $('#teacher-models').classList.remove('hidden');
      $('.course').innerHTML = '教师工作台<span>查看作答证据，理解学生的思考过程</span>';
      $('#footer-status').textContent = '作答记录 · 完整轨迹 · 课程题集';
      await renderTeacher('records');
    }
  } catch (e) { showRoles(); toast(e.message); }
  finally { $$('[data-role]').forEach(x => x.disabled = false); }
});
$$('[data-teacher-tab]').forEach(b => b.onclick = () => renderTeacher(b.dataset.teacherTab).catch(e => toast(e.message)));
async function renderTeacher(name) {
  teacherTab = name;
  $$('[data-teacher-tab]').forEach(b => b.classList.toggle('active', b.dataset.teacherTab === name));
  const host = $('#teacher-content');
  if (name === 'assessment') {
    host.innerHTML = '<span class="eyebrow">PROCESS ASSESSMENT</span><h1>过程评价</h1><div class="teacher-empty"><h2>先看见过程，再评价能力</h2><p>过程性评分尚未接入。当前可以查看完整作答证据，供教师人工审阅。</p><button id="teacher-see-records" class="primary">查看作答记录 →</button></div>';
    $('#teacher-see-records').onclick = () => renderTeacher('records').catch(e => toast(e.message)); return;
  }
  if (name === 'courses') {
    host.innerHTML = `<span class="eyebrow">COURSE LIBRARY</span><h1>课程题集</h1><p class="teacher-muted">${problemSets.length} 门课程 · ${allProblems.length} 道编程题</p><div class="teacher-courses">${problemSets.map(set => `<details class="teacher-course"><summary><strong>${esc(set.title)}</strong><span>${set.problemIds.length} 道题</span></summary>${allProblems.filter(p => set.problemIds.includes(p.id)).map(p => `<details class="teacher-problem"><summary>${esc(p.title)}</summary><p>${esc(p.description)}</p><h4>输入格式</h4><p>${esc(p.input)}</p><h4>输出格式</h4><p>${esc(p.output)}</p><h4>公开样例</h4><pre>${esc(p.sampleInput)}\n→\n${esc(p.sampleOutput)}</pre></details>`).join('')}</details>`).join('')}</div>`; return;
  }
  teacherRecords = await api('teacher/records');
  if (teacherTab !== 'records' || $('#teacher-page').classList.contains('hidden')) return;
  host.innerHTML = `<span class="eyebrow">ANSWER RECORDS</span><div class="teacher-title"><h1>作答记录</h1><div class="record-actions"><button id="open-trash" class="quiet-action" aria-expanded="false" aria-controls="inline-trash">回收站</button><button id="teacher-refresh">刷新记录 ↻</button></div></div><p class="teacher-muted">每条记录对应一道题。来源尚未核实，不等同于真实学生人数。</p><section id="inline-trash" class="inline-trash hidden" aria-label="回收站"></section><div class="stat-grid"><div class="stat">题目记录<strong id="record-total">${teacherRecords.length}</strong></div><div class="stat">有 AI 对话<strong id="record-chat-total">${teacherRecords.filter(r => r.messages > 0).length}</strong></div><div class="stat">课程题集<strong>${problemSets.length}</strong></div></div><div class="teacher-filters"><label>课程<select id="record-course"><option value="">全部课程</option>${[...new Set(teacherRecords.map(r => r.course))].map(c => `<option>${esc(c)}</option>`).join('')}</select></label><label>记录类别<select id="record-category"><option value="active">有作答内容</option><option value="">全部记录</option>${['01_有AI对话', '02_有作答无对话', '03_开发验证', '04_仅打开题目'].map(c => `<option value="${c}">${c.slice(3)}</option>`).join('')}</select></label><label>搜索<input id="record-search" placeholder="题目名称或记录编号"></label></div><div id="record-results"></div>`;
  $('#open-trash').onclick = async () => {
    const panel = $('#inline-trash'), open = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !open);
    $('#open-trash').setAttribute('aria-expanded', String(open));
    $('#open-trash').textContent = open ? '收起回收站' : '回收站';
    if (open) { panel.textContent = '正在加载回收站…'; try { await renderTrash(); } catch (e) { panel.textContent = '加载失败，请收起后重试。'; toast(e.message); } }
  };
  $('#teacher-refresh').onclick = () => renderTeacher('records').catch(e => toast(e.message));
  ['#record-course', '#record-category', '#record-search'].forEach(id => $(id).oninput = renderRecordRows);
  renderRecordRows();
}
function renderRecordRows() {
  const course = $('#record-course').value, cat = $('#record-category').value, query = $('#record-search').value.trim().toLowerCase();
  const rows = teacherRecords.filter(r => (!course || r.course === course) && (!cat || (cat === 'active' ? r.category !== '04_仅打开题目' : r.category === cat)) && `${r.problem} ${r.id}`.toLowerCase().includes(query));
  $('#record-results').innerHTML = `<div class="teacher-title"><p class="teacher-muted">共 ${rows.length} 条记录 · 时间为北京时间</p><button id="delete-selected" class="danger-button" disabled>删除所选</button></div><div class="teacher-table-wrap"><table class="teacher-table"><thead><tr><th><input type="checkbox" id="select-records" aria-label="全选当前筛选结果" ${rows.length ? '' : 'disabled'}></th><th>题目 / 课程</th><th>开始时间</th><th>类别</th><th>规划 / 消息 / 运行</th><th></th></tr></thead><tbody>${rows.map(r => `<tr><td><input type="checkbox" data-select-record="${r.id}" aria-label="选择 ${esc(r.problem)} ${r.id.slice(0, 8)}"></td><td><strong>${esc(r.problem)}</strong><small>${esc(r.course)} · ${r.id.slice(0, 8)}</small></td><td>${esc(r.startedAt.replace('_', ' ').replace(/(\d{2})-(\d{2})-(\d{2})$/, '$1:$2:$3'))}</td><td><span class="pill">${esc(r.category.slice(3))}</span></td><td>${r.planVersions} / ${r.messages} / ${r.runs}</td><td><button data-record="${r.id}" class="small">查看轨迹 →</button> <button data-delete-record="${r.id}" class="small danger-button">删除</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : '<div class="teacher-empty">没有符合条件的记录</div>'}</div>`;
  $$('[data-record]').forEach(b => b.onclick = () => openRecord(b.dataset.record).catch(e => toast(e.message)));
  const updateSelection = () => {
    const boxes = $$('[data-select-record]'), count = boxes.filter(b => b.checked).length;
    $('#delete-selected').disabled = count === 0;
    $('#delete-selected').textContent = count ? `删除所选（${count}）` : '删除所选';
    $('#select-records').checked = count > 0 && count === boxes.length;
    $('#select-records').indeterminate = count > 0 && count < boxes.length;
  };
  $('#select-records').onchange = e => { $$('[data-select-record]').forEach(b => b.checked = e.target.checked); updateSelection(); };
  $$('[data-select-record]').forEach(b => b.onchange = updateSelection);
  $('#delete-selected').onclick = () => deleteRecords($$('[data-select-record]').filter(b => b.checked).map(b => b.dataset.selectRecord));
  $$('[data-delete-record]').forEach(b => b.onclick = () => deleteRecords([b.dataset.deleteRecord]));
}
async function openRecord(id) {
  const s = await api(`sessions/${id}`), p = allProblems.find(p => p.id === s.problemId);
  const trace = interactionTrace(s.events);
  if ($('#teacher-page').classList.contains('hidden')) return;
  $('#teacher-content').innerHTML = `<div class="teacher-title"><button id="records-back">← 返回记录列表</button><a class="primary download-button" href="/api/sessions/${s.id}/export" download>导出完整轨迹 ↓</a></div><h1>${esc(p?.title || s.problemId)}</h1><p class="teacher-muted">${esc(p?.course)} · ${new Date(s.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} · ${s.endedAt ? '已提交' : '未提交'} · 来源待核实</p><div class="teacher-detail-tabs"><button data-detail="timeline" class="active">完整轨迹 (${trace.length})</button><button data-detail="plan">规划版本 (${s.versions.length})</button><button data-detail="chat">AI 对话 (${s.chats.length})</button><button data-detail="code">代码与运行</button></div><div id="record-detail"></div>`;
  $('#records-back').onclick = () => renderTeacher('records').catch(e => toast(e.message));
  const draw = tab => {
    $$('[data-detail]').forEach(b => b.classList.toggle('active', b.dataset.detail === tab));
    let html;
    if (tab === 'timeline') html = trace.map(e => `<details class="trace-event"><summary><time>${new Date(e.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time><strong>${esc(names[e.type] || e.type)}</strong></summary><pre>${esc(['chat_user', 'chat_ai', 'chat_blocked', 'chat_failed'].includes(e.type) ? e.payload.text : JSON.stringify(e.payload, null, 2))}</pre></details>`).join('');
    else if (tab === 'plan') html = s.versions.map(v => `<section class="trace-event"><h3>规划 v${v.version}</h3><pre>${esc(v.text)}</pre></section>`).join('');
    else if (tab === 'chat') html = s.chats.map(c => `<section class="message ${c.role === 'user' ? 'user' : ''}"><div class="who">${c.role === 'user' ? '学生' : c.blocked ? '平台提示' : 'AI · ' + esc(c.modelName || c.model || 'DeepSeek（历史记录）')}</div><div class="bubble">${esc(c.text)}</div></section>`).join('');
    else html = `<h3>当前保存的代码</h3><pre>${esc(s.code)}</pre><h3>最近一次运行</h3><pre>${s.lastRun ? esc(JSON.stringify(s.lastRun, null, 2)) : '暂无运行记录'}</pre>`;
    $('#record-detail').innerHTML = html || '<div class="teacher-empty">暂无记录</div>';
  };
  $$('[data-detail]').forEach(b => b.onclick = () => draw(b.dataset.detail)); draw('timeline');
}

let managingRecords = false;
async function deleteRecords(ids) {
  if (managingRecords || !ids.length) return;
  managingRecords = true;
  try {
    const selected = teacherRecords.filter(r => ids.includes(r.id));
    const summary = selected.slice(0, 5).map(r => `<li>${esc(r.problem)} · ${esc(r.startedAt)} · ${r.id.slice(0, 8)}</li>`).join('');
    if (!await confirmDialog(`删除 ${ids.length} 条作答记录？`, `<p>将整条记录的规划、对话、代码和运行轨迹移入回收站，并从统计中移除。可在教师端回收站恢复。</p><ul>${summary}</ul>${ids.length > 5 ? `<p>另有 ${ids.length - 5} 条所选记录。</p>` : ''}`, '移入回收站')) return;
    const filters = ['#record-course', '#record-category', '#record-search'].map(id => $(id)?.value || '');
    await api('teacher/trash', { ids });
    await renderTeacher('records');
    ['#record-course', '#record-category', '#record-search'].forEach((id, i) => { if ([...($(id).options || [])].some(o => o.value === filters[i]) || id === '#record-search') $(id).value = filters[i]; });
    renderRecordRows(); toast(`已将 ${ids.length} 条记录移入回收站`);
  } catch (e) { toast(e.message); }
  finally { managingRecords = false; }
}
async function renderTrash() {
  const rows = await api('teacher/trash');
  if (teacherTab !== 'records' || !$('#inline-trash') || $('#inline-trash').classList.contains('hidden') || $('#teacher-page').classList.contains('hidden')) return;
  $('#inline-trash').innerHTML = `<span class="eyebrow">RECYCLE BIN</span><div class="teacher-title"><h2>回收站</h2><div class="record-actions"><button id="back-from-trash" class="quiet-action">收起</button><button id="refresh-trash">刷新 ↻</button></div></div><p class="teacher-muted">共 ${rows.length} 条记录。删除后不计入作答统计，恢复后保留原记录编号和完整轨迹。</p><div class="teacher-table-wrap"><table class="teacher-table"><thead><tr><th>题目 / 课程</th><th>删除时间</th><th>操作</th></tr></thead><tbody>${rows.map(r => `<tr><td><strong>${esc(r.problem)}</strong><small>${esc(r.course)} · ${r.id.slice(0, 8)}</small></td><td>${new Date(r.deletedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</td><td><button data-restore-record="${r.id}" class="small">恢复记录</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : '<div class="teacher-empty">回收站为空</div>'}</div>`;
  $('#back-from-trash').onclick = () => $('#open-trash').click();
  $('#refresh-trash').onclick = () => renderTrash().catch(e => toast(e.message));
  $$('[data-restore-record]').forEach(b => b.onclick = async () => {
    if (managingRecords) return;
    managingRecords = true; b.disabled = true;
    try { await api('teacher/restore', { ids: [b.dataset.restoreRecord] }); await renderTrash();
      teacherRecords = await api('teacher/records');
      if ($('#record-total')) { $('#record-total').textContent = teacherRecords.length; $('#record-chat-total').textContent = teacherRecords.filter(r => r.messages > 0).length; renderRecordRows(); }
      toast('记录已恢复'); }
    catch (e) { toast(e.message); b.disabled = false; }
    finally { managingRecords = false; }
  });
}
