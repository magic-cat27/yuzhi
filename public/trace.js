export const traceLabels={ai_prompt_version:'本轮提示词版本',execution_started:'开始运行',execution_finished:'运行结果',ai_response_partial:'AI 回复中断（未完成）',ai_response:'AI 回复',ai_tool:'AI 读取项目',ai_change_proposed:'AI 提出文件改动',ai_change_decision:'学生审批',ai_changes_applied:'AI 文件改动已应用',ai_context_compacted:'AI 上下文已压缩',ai_error:'AI 请求未完成',session_started:'开始记录',baseline_imported:'导入已有状态',workspace_opened:'进入项目',file_opened:'查看文件',file_created:'新建文件',code_edited:'编辑代码 / 文档',code_saved:'保存项目',chat_user:'学生提问',chat_demo:'系统演示回复',run_unavailable:'运行尝试 · 未执行',terminal_command:'终端操作 · 本地预览',project_exported:'导出项目',workspace_left:'离开项目'};
export function textChange(before, after) {
  let start=0;while(start<before.length&&start<after.length&&before[start]===after[start])start++;
  let endBefore=before.length,endAfter=after.length;
  while(endBefore>start&&endAfter>start&&before[endBefore-1]===after[endAfter-1]){endBefore--;endAfter--;}
  return {offset:start,removed:before.slice(start,endBefore),inserted:after.slice(start,endAfter)};
}
export function createTrace(project, state, studentId) {
  const imported=!!state.startedAt || state.messages.length>0;
  return {id:crypto.randomUUID(),studentId,projectId:project.id,acknowledged:[],events:[{id:crypto.randomUUID(),timestamp:new Date().toISOString(),actor:'system',type:imported?'baseline_imported':'session_started',payload:{files:{...state.files},messages:state.messages.map(m=>({...m})),note:imported?'记录启用前的文件与对话快照，历史编辑过程及消息时间未知。':'初始项目模板；从此处开始记录。'}}]};
}
export function addEvent(trace,type,payload={},actor='student'){
  const event={id:crypto.randomUUID(),timestamp:new Date().toISOString(),type,actor,payload};trace.events.push(event);return event;
}
// Retry unacknowledged immutable events; server deduplicates their UUIDs.
const inflight=new WeakMap();
export function syncTrace(trace,persist,status,auth={}){
  if(inflight.has(trace))return inflight.get(trace);
  const task=sendTrace(trace,persist,status,auth).finally(()=>inflight.delete(trace));
  inflight.set(trace,task);return task;
}
async function sendTrace(trace, persist, status, auth) {
  try {
    const acknowledged=new Set(trace.acknowledged);
    let pending=trace.events.filter(e=>!acknowledged.has(e.id));
    while(pending.length){
      const batch=pending.slice(0,8);
      status('轨迹同步中');
      const res=await fetch(`/api/traces/${trace.id}/events`,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':auth.csrf||''},body:JSON.stringify({projectId:trace.projectId,studentId:trace.studentId,events:batch}),signal:AbortSignal.timeout(10000)});
      if(res.status===409){status('存在文件版本冲突 · 请先同步 AI 改动');return;}
      if(res.status===401||res.status===403){status('登录已变化 · 请重新登录原账号同步');auth.onAuthError?.();return;}
      if(!res.ok)throw new Error('同步失败');
      const result=await res.json();result.acceptedIds.forEach(id=>acknowledged.add(id));
      trace.acknowledged=[...acknowledged];persist();
      pending=trace.events.filter(e=>!acknowledged.has(e.id));
    }
    status('轨迹已同步');
  } catch {status('轨迹待同步 · 将自动重试');}
}
export function filesAt(record, sequence=Infinity) {
  let files={};
  for(const e of record.events){
    if(e.sequence>sequence)break;
    if(['session_started','baseline_imported'].includes(e.type))files={...e.payload.files};
    if(e.type==='code_edited')files[e.payload.file]=e.payload.after;
    if(e.type==='ai_changes_applied')for(const change of e.payload.changes)files[change.path]=change.after;
    if(e.type==='file_created')files[e.payload.file]=e.payload.content||'';
  }
  return files;
}
