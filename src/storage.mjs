import { mkdir, readdir, readFile, writeFile, appendFile, rename, cp, unlink } from 'node:fs/promises';
import { join, relative } from 'node:path';

const safe = value => String(value).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);
const stamp = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)).replace(' ', '_').replaceAll(':', '-');
export function category(s) {
  if (s.dataSource === 'development' || /^回退验证：|^# 验证用规划\n/.test(s.plan || '')) return '03_开发验证';
  if (s.chats?.length) return '01_有AI对话';
  if (s.versions?.length || s.lastRun || s.events?.some(e => ['code_edit', 'code_apply', 'code_run', 'doc_save', 'chat_user', 'chat_ai', 'chat_request', 'input_review'].includes(e.type))) return '02_有作答无对话';
  return '04_仅打开题目';
}
export async function createStorage(root, problems) {
  await mkdir(root, { recursive: true });
  const records = new Map();
  const problemMap = new Map(problems.map(p => [p.id, p]));
  let queue = Promise.resolve();
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function atomic(file, text) { await writeFile(file + '.tmp', text); await rename(file + '.tmp', file); }
  function folder(s) {
    const p = problemMap.get(s.problemId);
    return join(root, category(s), safe(p?.course || '历史课程'), safe(p?.title || s.problemId), `${stamp(s.startedAt)}_${s.id.slice(0, 8)}`);
  }
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) await scan(join(dir, entry.name));
      else if (entry.name === 'session.json') {
        const s = JSON.parse(await readFile(join(dir, entry.name), 'utf8'));
        if (records.has(s.id)) throw new Error(`重复会话：${s.id}`);
        records.set(s.id, { dir, s });
      }
    }
  }
  for (const name of ['01_有AI对话', '02_有作答无对话', '03_开发验证', '04_仅打开题目']) {
    await mkdir(join(root, name), { recursive: true }); await scan(join(root, name));
  }
  async function ensure(s) {
    if (records.has(s.id)) return records.get(s.id).dir;
    const dir = folder(s);
    await mkdir(dir, { recursive: true });
    try { const old = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')); if (old.id !== s.id) throw new Error('记录目录冲突'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    records.set(s.id, { dir, s }); return dir;
  }
  async function save(s) {
    let dir = await ensure(s);
    // Snapshot first: a restart can recover the latest classification even if interrupted during relocation.
    await atomic(join(dir, 'session.json'), JSON.stringify(s, null, 2));
    const destination = folder(s);
    if (dir !== destination) {
      await mkdir(join(destination, '..'), { recursive: true });
      await rename(dir, destination); dir = destination;
    }
    records.set(s.id, { dir, s });
    const p = problemMap.get(s.problemId);
    await atomic(join(dir, '对话.md'), `# ${p?.title || s.problemId}\n\n时间：${stamp(s.startedAt)}（北京时间）\n\n来源：${category(s) === '03_开发验证' ? '开发验证（显式标记）' : '待确认，无登录身份'}\n\n会话 ID：${s.id}\n\n${(s.chats || []).map((c, i) => `## ${i + 1}. ${c.role === 'user' ? '用户' : 'AI · ' + (c.modelName || c.model || 'DeepSeek（历史记录）')}\n\n${c.text}\n`).join('\n') || '暂无 AI 对话。\n'}`);
    await atomic(join(dir, '规划.md'), s.plan || '');
    await atomic(join(dir, p?.language === 'cpp' ? 'main.cpp' : 'main.c'), s.code || '');
  }
  async function index() {
    const rows = [...records.values()].sort((a, b) => b.s.startedAt - a.s.startedAt).map(({ dir, s }) => ({ id: s.id, category: category(s), source: category(s) === '03_开发验证' ? '开发验证（显式标记）' : '来源待确认', course: problemMap.get(s.problemId)?.course || '历史课程', problem: problemMap.get(s.problemId)?.title || s.problemId, startedAt: stamp(s.startedAt), messages: s.chats?.length || 0, planVersions: s.versions?.length || 0, runs: s.events?.filter(e => e.type === 'code_run').length || 0, path: relative(root, dir) }));
    await atomic(join(root, 'index.json'), JSON.stringify(rows, null, 2));
    const cell = s => String(s).replaceAll('|', '\\|').replaceAll('\n', ' ');
    await atomic(join(root, '索引.md'), '# 作答记录索引\n\n时间均为北京时间；一条记录对应一道题，不是一个学生或一整场考试。分类反映操作内容，不代表作答正确或可用于训练。暂无可验证的学生身份。\n\n' + [...new Set(rows.map(r => r.category))].map(c => `${c}：${rows.filter(r => r.category === c).length} 条`).join('；') + '\n\n| 时间 | 分类 | 课程 | 题目 | 消息数 | 规划版本 | 运行次数 | 内容 |\n|---|---|---|---|---:|---:|---:|---|\n' + rows.map(r => `| ${r.startedAt} | ${r.category} | ${cell(r.course)} | ${cell(r.problem)} | ${r.messages} | ${r.planVersions} | ${r.runs} | [查看对话](<${r.path}/对话.md>) |`).join('\n') + '\n');
  }
  // Copy all legacy originals before migrating any of them. The backup is never a live write target.
  const legacy = (await readdir(root)).filter(n => /^[a-f0-9-]{36}\.jsonl?$/.test(n));
  if (legacy.length) {
    const backup = join(root, '迁移备份', `${stamp(Date.now())}_${Date.now()}`);
    await mkdir(backup, { recursive: true });
    for (const name of legacy) await cp(join(root, name), join(backup, name));
    for (const name of legacy.filter(n => n.endsWith('.json'))) {
      const s = JSON.parse(await readFile(join(root, name), 'utf8'));
      if (records.has(s.id)) { // Interrupted migration: never overwrite a subsequently updated snapshot.
        const existing = await readFile(join(records.get(s.id).dir, 'events.jsonl'), 'utf8');
        const original = await readFile(join(root, `${s.id}.jsonl`), 'utf8');
        if (!existing.startsWith(original)) throw new Error(`迁移冲突，已保留原件：${s.id}`);
      } else {
        const dir = await ensure(s);
        await cp(join(root, `${s.id}.jsonl`), join(dir, 'events.jsonl'));
        await save(s);
      }
    }
    await index();
    for (const name of legacy) {
      if (!records.has(name.replace(/\.jsonl?$/, ''))) throw new Error(`孤立日志，已保留原件：${name}`);
    }
    for (const name of legacy) await unlink(join(root, name));
  }
  for (const { s } of [...records.values()]) await save(s);
  await index();
  await atomic(join(root, 'README.md'), '# 数据目录\n\n先打开 [索引.md](索引.md)。目录按「操作类别 / 课程 / 题目 / 北京时间_短ID」组织。\n\n- 01_有AI对话：已有对话，来源未核实。\n- 02_有作答无对话：保存过规划、编辑或运行过代码。\n- 03_开发验证：有明确验证标记，或服务以 DATA_SOURCE=development 启动。\n- 04_仅打开题目：未保存规划、代码或产生对话，可能只有开始、结束或粘贴事件。\n\n每个会话含 session.json（完整快照）、events.jsonl（追加事件日志）、对话.md、规划.md、main.c 或 main.cpp。后面三个是便于阅读的最新视图，历史规划、代码与运行结果见原始快照及日志。新操作会自动更新分类和索引，原会话 ID 保持不变。\n\n回收站保存教师删除的整条题目记录，可在教师端恢复，不计入有效记录索引。删除不是永久擦除，迁移备份中的历史原件也会保留。\n\n迁移备份保存整理前的原文件，不参与统计，不是定时或异地备份。请定期备份整个 data 目录。没有登录系统，不能据此认定真实学生身份；显式测试标记仅用于整理，不是安全边界。\n');
  const trashDir = join(root, '回收站');
  await mkdir(trashDir, { recursive: true });
  async function trashList() {
    const rows = [];
    for (const id of await readdir(trashDir)) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const s = JSON.parse(await readFile(join(trashDir, id, 'session.json'), 'utf8'));
      const meta = JSON.parse(await readFile(join(trashDir, id, '删除信息.json'), 'utf8'));
      const p = problemMap.get(s.problemId);
      rows.push({ id, course: p?.course || '历史课程', problem: p?.title || s.problemId, deletedAt: meta.deletedAt });
    }
    return rows.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }
  return {
    trashList: () => serial(trashList),
    trash: ids => serial(async () => {
      for (const id of ids) if (!records.has(id)) throw new Error('部分记录已不存在，请刷新后重试');
      try {
        for (const id of ids) {
          const record = records.get(id);
          await atomic(join(record.dir, '删除信息.json'), JSON.stringify({ deletedAt: new Date().toISOString(), originalPath: relative(root, record.dir) }, null, 2));
          await rename(record.dir, join(trashDir, id));
          records.delete(id);
        }
      } finally { await index(); }
    }),
    restore: ids => serial(async () => {
      const sessions = [];
      for (const id of ids) {
        if (records.has(id)) throw new Error('记录已恢复，请刷新后重试');
        sessions.push(JSON.parse(await readFile(join(trashDir, id, 'session.json'), 'utf8')));
      }
      try {
        for (const s of sessions) {
          const dir = folder(s);
          await mkdir(join(dir, '..'), { recursive: true });
          await rename(join(trashDir, s.id), dir);
          records.set(s.id, { dir, s });
        }
      } finally { await index(); }
    }),
    save: s => serial(async () => { await save(s); await index(); }),
    append: (s, e) => serial(async () => { const dir = await ensure(s); await appendFile(join(dir, 'events.jsonl'), JSON.stringify(e) + '\n'); }),
    read: id => serial(async () => { const r = records.get(id); if (!r) throw new Error('记录不存在'); return JSON.parse(await readFile(join(r.dir, 'session.json'), 'utf8')); }),
    export: id => serial(async () => { const r = records.get(id); if (!r) throw new Error('记录不存在'); return readFile(join(r.dir, 'events.jsonl')); }),
  };
}
