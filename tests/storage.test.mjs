import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorage } from '../src/storage.mjs';

test('legacy migration preserves originals; activity relocation, export and restart preserve identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yuzhi-storage-'));
  try {
    const s = { id: '12345678-1234-1234-1234-123456789abc', problemId: 'p', startedAt: 1791500000000, plan: '', versions: [], chats: [], events: [], code: '' };
    const raw = JSON.stringify(s), log = '{"type":"session_start"}\n';
    await writeFile(join(root, s.id + '.json'), raw); await writeFile(join(root, s.id + '.jsonl'), log);
    const problems = [{ id: 'p', course: '课程', title: '题目' }];
    let store = await createStorage(root, problems);
    assert.deepEqual(await store.read(s.id), s); assert.equal(String(await store.export(s.id)), log);
    const backup = (await readdir(join(root, '迁移备份')))[0];
    assert.equal(await readFile(join(root, '迁移备份', backup, s.id + '.json'), 'utf8'), raw);
    assert.equal((await readdir(root)).includes(s.id + '.json'), false);
    const index = async () => JSON.parse(await readFile(join(root, 'index.json'), 'utf8'));
    assert.equal((await index())[0].category, '04_仅打开题目');
    s.versions.push({ text: '规划' }); s.plan = '规划'; await store.save(s);
    assert.equal((await index())[0].category, '02_有作答无对话');
    const e = { type: 'chat_user', payload: { text: '执行' } };
    await store.append(s, e); s.events.push(e); s.chats.push({ role: 'user', text: '执行' }); await store.save(s);
    assert.equal((await index())[0].category, '01_有AI对话');
    const path = (await index())[0].path;
    assert.match(await readFile(join(root, path, '对话.md'), 'utf8'), /执行/);
    store = await createStorage(root, problems);
    assert.deepEqual(await store.read(s.id), s);
    assert.equal(String(await store.export(s.id)), log + JSON.stringify(e) + '\n');
    assert.equal((await readdir(join(root, '迁移备份'))).length, 1);
    s.dataSource = 'development'; await store.save(s);
    assert.equal((await index())[0].category, '03_开发验证');
    const before = String(await store.export(s.id));
    await assert.rejects(store.trash([s.id, '00000000-0000-0000-0000-000000000000']));
    assert.equal((await index()).length, 1);
    await store.trash([s.id]);
    assert.equal((await index()).length, 0);
    await assert.rejects(store.read(s.id));
    store = await createStorage(root, problems);
    assert.equal((await store.trashList())[0].id, s.id);
    await assert.rejects(store.export(s.id));
    await store.restore([s.id]);
    assert.deepEqual(await store.read(s.id), s);
    assert.equal(String(await store.export(s.id)), before);
    assert.equal((await store.trashList()).length, 0);
    assert.equal((await index()).length, 1);

  } finally { await rm(root, { recursive: true, force: true }); }
});
