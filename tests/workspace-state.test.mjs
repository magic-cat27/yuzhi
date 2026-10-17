import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateWorkspace } from '../public/workspace-state.js';
import { projects } from '../public/projects.js';
const project = projects[0];
const legacyMain = '#include <iostream>\n\nint main() {\n    // TODO: 从你的规划开始实现\n\n    return 0;\n}\n';

test('existing prototype upgrades to C and removes planning file and tab', () => {
  const saved = {files:{'src/main.cpp':legacyMain,'docs/plan.md':'old plan','docs/report.md':'my report','CMakeLists.txt':'project(example LANGUAGES CXX)\nset(CMAKE_CXX_STANDARD 17)\nadd_executable(main src/main.cpp)'},activeFile:'docs/plan.md',openFiles:['src/main.cpp','docs/plan.md'],elapsed:32,messages:[{role:'user',text:'my question'}]};
  const result = migrateWorkspace(saved,project);
  assert.equal(result.files['src/main.c'],project.files['src/main.c']);
  assert.equal(result.files['docs/report.md'],'my report');
  assert.equal(result.files['docs/plan.md'],undefined);
  assert.equal(result.files['src/main.cpp'],undefined);
  assert.equal(result.activeFile,'src/main.c');
  assert.deepEqual(result.openFiles,['src/main.c']);
  assert.match(result.files['CMakeLists.txt'],/LANGUAGES C\)/);
  assert.match(result.files['CMakeLists.txt'],/CMAKE_C_STANDARD 11/);
  assert.equal(result.elapsed,32);
  assert.deepEqual(result.messages,saved.messages);
  assert.ok(saved.files['docs/plan.md']);
  assert.deepEqual(migrateWorkspace(result,project),result);
});

test('student edits survive migration and existing C files are never overwritten', () => {
  const edited = '#include <stdio.h>\nint main(void){return 7;}';
  const result = migrateWorkspace({files:{'src/main.cpp':edited}}, project);
  assert.equal(result.files['src/main.c'],edited);
  const collision = migrateWorkspace({files:{'src/main.cpp':edited,'src/main.c':'existing C'}},project);
  assert.equal(collision.files['src/main.c'],'existing C');
  assert.equal(collision.files['src/main.cpp'],edited);
});

test('all new projects use C11 and contain no planning document', () => {
  for(const p of projects){
    assert.ok(p.files['src/main.c']);
    assert.equal(p.files['docs/plan.md'],undefined);
    assert.equal(p.files['src/main.cpp'],undefined);
    assert.match(p.files['CMakeLists.txt'],/LANGUAGES C\)/);
    assert.match(p.files['CMakeLists.txt'],/CMAKE_C_STANDARD 11/);
  }
});
