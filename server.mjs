import http from 'node:http';
import { interactionTrace } from './public/interaction-trace.js';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { problems, template } from './problems.mjs';
import { problemSets } from './course-sets.mjs';
import { createStorage } from './src/storage.mjs';
import { modelConfig, defaultModel, publicModels } from './src/models.mjs';
import { guardSnapshot, guardedReply, guardPrompt, guardVersion, guardPromptHash, reviewError } from './src/input-guard.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(root, 'data');
const storage = await createStorage(dataDir, problems);
const port = Number(process.env.PORT || 3100);
const locks = new Set();
const visitors = new Map();
const studentView = s => { const { events, ...visible } = s; return visible; };

let pi;
try { pi = await import('./src/ai.mjs'); await pi.checkPi(); } catch { pi = null; }
const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) {
  let text = ''; for await (const chunk of req) { text += chunk; if (text.length > 1_000_000) throw new Error('请求过大'); }
  return JSON.parse(text || '{}');
}
async function persist(s) { await storage.save(s); }
async function event(s, type, payload) {
  const e = { event_id: randomUUID(), session_id: s.id, timestamp: new Date().toISOString(), type, payload };
  await storage.append(s, e);
  s.events.push(e); return e;
}
export async function execute(command, args, options = {}) {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd: options.cwd, detached: true, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false, done = false;
    const kill = () => { stopped = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    const timer = setTimeout(kill, options.timeout || 5000);
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    child.on('error', e => finish({ stdout, stderr: e.message, exitCode: -1, stopped }));
    child.stdout.on('data', b => { stdout += b; if (stdout.length + stderr.length > 64000) kill(); });
    child.stderr.on('data', b => { stderr += b; if (stdout.length + stderr.length > 64000) kill(); });
    child.stdin.on('error', () => {});
    child.stdin.end(options.stdin || '');
    child.on('close', code => finish({ stdout: stdout.slice(0, 64000), stderr: stderr.slice(0, 64000), exitCode: code, stopped }));
  });
}
async function runC(code, stdin, language = 'c') {
  const dir = await mkdtemp(join(tmpdir(), 'yuzhi-run-'));
  try {
    const cpp = language === 'cpp', filename = cpp ? 'main.cpp' : 'main.c';
    await writeFile(join(dir, filename), code);
    const compile = await execute(cpp ? 'g++' : 'gcc', [cpp ? '-std=c++17' : '-std=c11', '-Wall', '-Wextra', '-O0', filename, '-o', 'program'], { cwd: dir, timeout: 10000 });
    if (compile.exitCode !== 0) return { ...compile, stage: 'compile' };
    const run = await execute('./program', [], { cwd: dir, stdin, timeout: 3000 });
    return { ...run, stage: 'run', warnings: compile.stderr };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
const server = http.createServer(async (req, res) => {
  let lockId;
  try {
    // Local demonstration service: reject cross-origin mutations.
    if (req.headers.origin && req.headers.origin !== `http://localhost:${port}` && req.headers.origin !== `http://127.0.0.1:${port}`) return json(res, { error: '不允许跨站请求' }, 403);
    const url = new URL(req.url, `http://localhost:${port}`);
    const token = req.headers.cookie?.match(/(?:^|; )yuzhi_role=([a-f0-9-]+)/)?.[1];
    const visitor = visitors.get(token);
    if (url.pathname === '/api/role' && req.method === 'POST') {
      const { role } = await body(req);
      if (!['student', 'teacher'].includes(role)) return json(res, { error: '请选择学生端或教师端' }, 400);
      if (token) visitors.delete(token);
      const next = randomUUID(); visitors.set(next, { role, sessions: new Set() });
      res.setHeader('Set-Cookie', `yuzhi_role=${next}; HttpOnly; SameSite=Strict; Path=/`);
      return json(res, { role });
    }
    if (url.pathname === '/api/teacher/trash' || url.pathname === '/api/teacher/restore') {
      if (visitor?.role !== 'teacher') return json(res, { error: '仅教师可管理记录' }, 403);
      if (req.method === 'GET' && url.pathname.endsWith('/trash')) return json(res, await storage.trashList());
      if (req.method !== 'POST') return json(res, { error: '方法不支持' }, 405);
      const { ids } = await body(req);
      if (!Array.isArray(ids) || !ids.length || ids.length > 500 || ids.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) || new Set(ids).size !== ids.length) return json(res, { error: '请选择 1～500 条有效记录' }, 400);
      if (ids.some(id => locks.has(id))) return json(res, { error: '所选记录正在保存或生成回复，请稍后重试' }, 409);
      ids.forEach(id => locks.add(id));
      try {
        if (url.pathname.endsWith('/restore')) await storage.restore(ids);
        else await storage.trash(ids);
        return json(res, { count: ids.length });
      } finally { ids.forEach(id => locks.delete(id)); }
    }
    if (url.pathname === '/api/teacher/records') {
      if (visitor?.role !== 'teacher') return json(res, { error: '请进入教师端查看' }, 403);
      return json(res, JSON.parse(await readFile(join(dataDir, 'index.json'), 'utf8')));
    }
    if (url.pathname === '/api/status') return json(res, { pi: Boolean(pi), configured: Boolean(modelConfig(defaultModel()).apiKey), model: defaultModel(), models: publicModels(), inputGuard: { enabled: true, version: guardVersion }, runtime: 'GCC · C11', localOnly: true });
    if (url.pathname === '/api/problems') return json(res, problems);
    if (url.pathname === '/api/problem-sets') return json(res, problemSets);
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      if (visitor?.role !== 'student') return json(res, { error: '请进入学生端作答' }, 403);
      const b = await body(req);
      if (!problems.some(p => p.id === b.problemId)) return json(res, { error: '题目不存在' }, 400);
      const s = { id: randomUUID(), dataSource: process.env.DATA_SOURCE === 'development' ? 'development' : 'unverified', problemId: b.problemId, startedAt: Date.now(), endedAt: null, plan: template, versions: [], code: '#include <stdio.h>\n\nint main(void) {\n    // 在这里编写代码，或确认应用 AI 生成的代码\n    return 0;\n}\n', chats: [], lastRun: null, events: [] };
      if (problems.find(p => p.id === b.problemId).language === 'cpp') s.code = '#include <iostream>\n\nint main() {\n    // 在这里编写代码，或确认应用 AI 生成的代码\n    return 0;\n}\n';
      await event(s, 'session_start', { problemId: b.problemId }); await persist(s); visitor.sessions.add(s.id); return json(res, studentView(s));
    }
    const match = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\/(plan|code|run|chat|end|export|paste))?$/);
    if (match) {
      const [, id, action] = match;
      if (!visitor || (visitor.role === 'student' && !visitor.sessions.has(id))) return json(res, { error: '无权访问此记录，请重新进入对应端' }, 403);
      if (action === 'export' && visitor.role !== 'teacher') return json(res, { error: '仅教师可导出轨迹' }, 403);
      if (req.method === 'POST' && visitor.role !== 'student') return json(res, { error: '教师端只能查看作答' }, 403);
      if (req.method === 'POST') { if (locks.has(id)) return json(res, { error: '当前操作尚未结束，请稍后重试' }, 409); locks.add(id); lockId = id; }
      let s; try { s = await storage.read(id); } catch { return json(res, { error: '记录不存在' }, 404); }
      s.plan ??= template; s.versions ??= [];
      if (req.method === 'GET' && !action) return json(res, visitor.role === 'teacher' ? s : studentView(s));
      if (req.method === 'GET' && action === 'export') { res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': `attachment; filename="yuzhi-${id}.jsonl"` }); return res.end(interactionTrace(s.events).map(e => JSON.stringify(e)).join('\n') + '\n'); }
      if (req.method !== 'POST') return json(res, { error: '方法不支持' }, 405);
      if (s.endedAt) return json(res, { error: '考核已经结束，记录为只读' }, 409);
      const b = await body(req);
      if (action === 'plan') {
        if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 100000) return json(res, { error: '请填写有效规划内容' }, 400);
        s.plan = b.text; s.versions.push({ version: s.versions.length + 1, text: b.text, timestamp: new Date().toISOString() });
        await event(s, 'doc_save', s.versions.at(-1));
      } else if (action === 'code') {
        if (typeof b.code !== 'string' || b.code.length > 100000) return json(res, { error: '代码无效或过长' }, 400);
        s.code = b.code; await event(s, b.source === 'ai' ? 'code_apply' : 'code_edit', { code: b.code });
      } else if (action === 'run') {
        if (typeof b.code !== 'string' || b.code.length > 100000 || typeof b.stdin !== 'string' || b.stdin.length > 10000) return json(res, { error: '代码或输入无效' }, 400);
        if (s.code !== b.code) await event(s, 'code_edit', { code: b.code });
        s.code = b.code; s.lastRun = { ...await runC(b.code, b.stdin, problems.find(p => p.id === s.problemId).language), stdin: b.stdin, code: b.code, timestamp: new Date().toISOString() };
        await event(s, 'code_run', s.lastRun);
      } else if (action === 'chat') {
        if (!s.versions.length) return json(res, { error: '请先保存规划文档' }, 400);
        const selected = modelConfig(b.model || defaultModel());
        if (!selected) return json(res, { error: '模型不在允许列表中' }, 400);
        if (!selected.apiKey || !pi) return json(res, { error: !selected.apiKey ? `${selected.name} 尚未配置，请在服务端 .env 填写 ${selected.keyEnv} 后重启。` : 'PI 依赖尚未安装完成。' }, 503);
        if (typeof b.text !== 'string' || !b.text.trim() || b.text.length > 12000) return json(res, { error: '消息为空或过长' }, 400);
        const modelInfo = { model: selected.id, modelName: selected.name, provider: selected.provider };
        const requestId = randomUUID(), start = Date.now();
        const snapshot = guardSnapshot(s, b.text);
        await event(s, 'chat_request', { requestId, text: b.text, planVersion: s.versions.length,
          input: snapshot.input, ...modelInfo, guardVersion, guardPromptHash });
        await persist(s);
        const result = await guardedReply({
          input: snapshot.input,
          generate: signal => pi.reply(snapshot.session, problems.find(p => p.id === s.problemId), b.text, selected.apiKey, selected.id, { signal }),
          review: signal => pi.generateText(guardPrompt, JSON.stringify(snapshot.input), selected.apiKey, selected.id, { signal, maxTokens: 1600 }),
        });
        await event(s, 'input_review', { requestId, status: result.status, ...modelInfo, guardVersion, guardPromptHash,
          decision: result.review || null, reviewDurationMs: result.reviewDurationMs, durationMs: Date.now() - start });
        if (result.status === 'review_error' || result.status === 'generation_error') {
          await persist(s);
          return json(res, { error: result.status === 'review_error' ? reviewError : '模型请求失败或超时，请重试。' }, 503);
        }
        const blocked = result.status === 'blocked';
        const turn = { ...modelInfo, requestId, blocked };
        s.chats.push({ role: 'user', text: b.text, ...turn }, { role: 'assistant', text: result.answer, ...turn });
        await event(s, 'chat_user', { text: b.text, planVersion: s.versions.length, ...turn });
        await event(s, 'chat_ai', { text: result.answer, ...turn, source: blocked ? 'input_guard' : 'model' });
      } else if (action === 'paste') {
        await event(s, 'paste', { length: Math.max(0, Math.min(Number(b.length) || 0, 1000000)), tab: ['plan', 'code', 'chat'].includes(b.tab) ? b.tab : 'unknown' });
      } else if (action === 'end') {
        s.endedAt = Date.now(); await event(s, 'session_end', { endedAt: s.endedAt });
      } else return json(res, { error: '操作不存在' }, 404);
      await persist(s); return json(res, studentView(s));
    }
    if (url.pathname.startsWith('/vendor/vs/')) {
      const base = join(root, 'node_modules/monaco-editor/min/vs');
      const file = resolve(base, url.pathname.slice('/vendor/vs/'.length));
      if (!file.startsWith(base + '/')) return json(res, { error: '路径无效' }, 400);
      try { const content = await readFile(file); res.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.json': 'application/json' })[extname(file)] || 'application/octet-stream' }); return res.end(content); } catch { return json(res, { error: '资源不存在' }, 404); }
    }
    const assets = { '/interaction-trace.js': ['interaction-trace.js', 'text/javascript'], '/code-review.js': ['code-review.js', 'text/javascript'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (assets[url.pathname]) { const [file, type] = assets[url.pathname]; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); return res.end(await readFile(join(root, 'public', file))); }
    json(res, { error: '未找到页面' }, 404);
  } catch (e) { json(res, { error: e.message || '操作失败' }, 500); }
  finally { if (lockId) locks.delete(lockId); }
});
server.listen(port, '127.0.0.1', () => console.log(`驭智已启动：http://localhost:${port} · PI ${pi ? '已加载' : '待安装'} · 主模型 ${defaultModel()} ${modelConfig(defaultModel()).apiKey ? '已配置' : '待配置'}`));
