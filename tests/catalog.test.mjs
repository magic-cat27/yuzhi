import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cProblems } from '../c-problems.mjs';
import { problems } from '../problems.mjs';
import { assessmentPoints } from '../src/assessment-points.mjs';
import { problemSets } from '../course-sets.mjs';

test('题库完整、编号连续、表达式置顶且每题有私有考点', () => {
  assert.equal(cProblems.length, 10);
  assert.equal(cProblems[0].id, 'expression');
  assert.equal(new Set(problems.map(p => p.id)).size, 48);
  assert.equal(problemSets.length, 13);
  assert.equal(problemSets.filter(s => s.category === '专业核心').length, 12);
  assert.deepEqual(problemSets.flatMap(s => s.problemIds).sort(), problems.map(p => p.id).sort());
  for (const set of problemSets) {
    assert.ok(set.problemIds.length >= 3);
    assert.ok(!set.title.includes('Problem Set'));
    assert.match(set.source.url, /^https:\/\//);
    const members = set.problemIds.map(id => problems.find(p => p.id === id));
    assert.deepEqual(members.map(p => p.number), members.map((_, i) => String(i + 1).padStart(2, '0')));
    assert.ok(members.every(p => p.language === set.language));
  }
  for (const [i, p] of cProblems.entries()) {
    assert.equal(p.number, String(i + 1).padStart(2, '0'));
    for (const field of ['title', 'description', 'input', 'output', 'sampleInput', 'sampleOutput']) assert.ok(p[field].trim(), `${p.id}: ${field}`);
  }
  for (const p of problems) {
    for (const field of ['title', 'description', 'input', 'output', 'sampleInput', 'sampleOutput']) assert.ok(p[field].trim(), `${p.id}: ${field}`);
    assert.ok(assessmentPoints[p.id]?.includes('判定要点：'), p.id);
    assert.ok(!JSON.stringify(p).includes('判定要点：'));
  }
});

// Independent calculations validate the public examples, not student solutions.
const solvers = {
  expression: text => {
    const tokens = text.match(/\d+|[()+*-]/g); let i = 0;
    const atom = () => { if (tokens[i] !== '(') return Number(tokens[i++]); i++; const n = sum(); assert.equal(tokens[i++], ')'); return n; };
    const product = () => { let n = atom(); while (tokens[i] === '*') { i++; n *= atom(); } return n; };
    const sum = () => { let n = product(); while (['+', '-'].includes(tokens[i])) { const op = tokens[i++]; const v = product(); n += op === '+' ? v : -v; } return n; };
    const result = sum(); assert.equal(i, tokens.length); return String(result);
  },
  brackets: text => { let rest = text; while (/\(\)|\[\]|\{\}/.test(rest)) rest = rest.replace(/\(\)|\[\]|\{\}/g, ''); return rest ? 'NO' : 'YES'; },
  'big-add': text => text.split(/\s+/).map(BigInt).reduce((a, b) => a + b).toString(),
  intervals: text => {
    const rows = text.split('\n').slice(1).map(s => s.split(' ').map(Number)).sort((a, b) => a[0] - b[0]); const out = [];
    for (const [l, r] of rows) { const last = out.at(-1); if (last && l <= last[1]) last[1] = Math.max(last[1], r); else out.push([l, r]); }
    return [out.length, ...out.map(r => r.join(' '))].join('\n');
  },
  'word-count': text => { const counts = new Map(); for (const word of text.toLowerCase().match(/[a-z]+/g)) counts.set(word, (counts.get(word) || 0) + 1); return [...counts.keys()].sort().map(word => `${word} ${counts.get(word)}`).join('\n'); },
  'matrix-rotate': text => { const rows = text.split('\n').slice(1).map(r => r.split(' ')); return rows[0].map((_, j) => rows.map(r => r[j]).reverse().join(' ')).join('\n'); },
  'stable-unique': text => { const values = [...new Set(text.split('\n')[1].split(' '))]; return `${values.length}\n${values.join(' ')}`; },
  'base-convert': text => { const [x, b] = text.split(' '); return BigInt(x).toString(Number(b)).toUpperCase(); },
  'polynomial-add': text => { const data = text.split(/\s+/).map(Number); let i = 0; const counts = new Map(); for (let p = 0; p < 2; p++) { const n = data[i++]; for (let j = 0; j < n; j++) { const c = data[i++], e = data[i++]; counts.set(e, (counts.get(e) || 0) + c); } } const terms = [...counts].filter(([,c]) => c).sort((a,b) => b[0] - a[0]); return [terms.length, ...terms.map(([e,c]) => `${c} ${e}`)].join('\n'); },
  'count-out': text => { const [n,k] = text.split(' ').map(Number), alive = Array.from({length:n}, (_,i) => i+1), out = []; let pos = 0; while (alive.length) { pos = (pos+k-1)%alive.length; out.push(...alive.splice(pos,1)); } return out.join(' '); },
};
test('十道新增题目的公开样例结果正确', () => {
  for (const p of cProblems) assert.equal(solvers[p.id](p.sampleInput), p.sampleOutput, p.id);
});
