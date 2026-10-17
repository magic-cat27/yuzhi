import {filesAt} from './trace.js';
export function restoreAttempt(record) {
  const messages=[];
  for(const e of record.events){
    if(['baseline_imported','session_started'].includes(e.type))messages.push(...(e.payload.messages||[]));
    if(['chat_user','ai_response','ai_response_partial','chat_demo'].includes(e.type))messages.push({role:e.type==='chat_user'?'user':'assistant',text:e.payload.text,eventId:e.id,source:e.type.startsWith('ai_response')?'ai':undefined});
  }
  return {schemaVersion:2,files:filesAt(record),messages,attemptNumber:record.attemptNumber,startedAt:Date.parse(record.createdAt),elapsed:0,activeFile:'src/main.c',openFiles:['src/main.c'],trace:{id:record.id,studentId:record.ownerId,projectId:record.projectId,events:record.events,acknowledged:record.events.map(e=>e.id)}};
}
// Upgrade browser-saved UI prototypes without discarding student code or conversations.
const legacyMain = '#include <iostream>\n\nint main() {\n    // TODO: 从你的规划开始实现\n\n    return 0;\n}\n';
const legacyCountingMain = '#include <iostream>\n\nconstexpr long long MOD = 1000000007;\n\nint main() {\n    int n;\n    std::cin >> n;\n\n    // TODO: 计算包含 n 个内部节点的红黑树数量\n\n    return 0;\n}\n';

export function migrateWorkspace(saved, project) {
  if (!saved || typeof saved !== 'object' || !saved.files || typeof saved.files !== 'object' || Array.isArray(saved.files)) return saved;
  if (saved.schemaVersion >= 2) return saved;
  const next = { ...saved, schemaVersion: 2, files: { ...saved.files } };
  delete next.files['docs/plan.md'];
  if (typeof next.files['src/main.cpp'] === 'string' && !Object.hasOwn(next.files, 'src/main.c')) {
    const content = next.files['src/main.cpp'];
    next.files['src/main.c'] = [legacyMain, legacyCountingMain].includes(content)
      ? project.files['src/main.c'] : content;
    delete next.files['src/main.cpp'];
  }
  if (typeof next.files['CMakeLists.txt'] === 'string') {
    next.files['CMakeLists.txt'] = next.files['CMakeLists.txt']
      .replace(/LANGUAGES CXX\b/g, 'LANGUAGES C')
      .replace(/CMAKE_CXX_STANDARD 17\b/g, 'CMAKE_C_STANDARD 11')
      .replace(/src\/main\.cpp/g, 'src/main.c');
  }
  if (typeof next.files['README.md'] === 'string') {
    next.files['README.md'] = next.files['README.md'].replace('docs/：规划与报告', 'docs/：实验报告');
  }
  const renameTab = f => f === 'src/main.cpp' && !Object.hasOwn(next.files, f) ? 'src/main.c' : f;
  next.openFiles = [...new Set((Array.isArray(saved.openFiles) ? saved.openFiles : [])
    .map(renameTab).filter(f => Object.hasOwn(next.files, f)))];
  const active = renameTab(saved.activeFile);
  next.activeFile = Object.hasOwn(next.files, active) ? active : 'src/main.c';
  // Remove only obsolete canned demo guidance; student messages remain verbatim.
  if (Array.isArray(saved.messages)) next.messages = saved.messages.map(m =>
    m?.role === 'assistant' && typeof m.text === 'string' && m.text.startsWith('已记录你的问题。这里是聊天交互演示，尚未连接真实 AI。')
      ? { ...m, text: m.text.replace('你可以先在 docs/plan.md 中写下当前思路；', '你可以直接编写代码，或在这里描述遇到的问题；') } : m);
  return next;
}
