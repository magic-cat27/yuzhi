import test from 'node:test';
import assert from 'node:assert/strict';
import {groupRecords,recordIdentity} from '../public/teacher-groups.js';
const row=(id,ownerId,username,projectId='project1',role='student')=>({id,ownerId,studentId:ownerId,student:{id:ownerId,name:'同名学生',username,role},projectId,createdAt:'2026-10-15T10:00:00Z',updatedAt:'2026-10-15T11:00:00Z',edits:2,messages:1});
test('same-name accounts remain separate, while multiple records of one account are preserved',()=>{
  const groups=groupRecords([row('record-a','account-1','student_one'),row('record-b','account-2','student_two'),row('record-c','account-1','student_one'),row('record-d','account-1','student_one','project2')]);
  assert.equal(groups.length,2);
  const one=groups.find(g=>g.username==='student_one');
  assert.equal(one.projectCount,2);assert.equal(one.records.length,3);assert.equal(one.edits,6);
  assert.ok(one.records.every(r=>r.ownerId==='account-1'));
  assert.deepEqual(groups.find(g=>g.username==='student_two').records.map(r=>r.id),['record-b']);
});
test('teacher previews and anonymous history cannot be merged into a student account',()=>{
  const student=row('record-a','account-1','student_one');
  const teacher=row('record-b','account-2','teacher_one','project1','teacher');
  const legacy={...student,id:'legacy-a',ownerId:undefined,student:null};
  const groups=groupRecords([student,teacher,legacy]);
  assert.equal(groups.length,3);
  assert.deepEqual(groups.map(g=>g.kind).sort(),['legacy','student','teacher']);
  assert.notEqual(recordIdentity(legacy).key,recordIdentity(student).key);
});
