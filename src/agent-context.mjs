export const contextSize = (messages, summary='') => Buffer.byteLength(JSON.stringify(messages))+Buffer.byteLength(summary);
export function boundedText(text, bytes) {
  let result='',size=0;
  for(const char of text){size+=Buffer.byteLength(char);if(size>bytes)break;result+=char;}
  return result;
}
// Keep the latest student turn verbatim; never split an assistant/tool exchange.
export function compressionCut(messages, target, summaryReserve=6000) {
  const lastUser=messages.findLastIndex(m=>m.role==='user');
  if(lastUser<=0)return 0;
  const candidates=messages.flatMap((m,i)=>i>0&&i<=lastUser&&m.role==='user'?[i]:[]);
  return candidates.find(i=>contextSize(messages.slice(i)) + summaryReserve <= target) || lastUser;
}
// Raw calls remain in agent_history. Failed code is not a project artifact or a plan.
export function discardFailedProposal(messages, callId) {
  return messages.map(m=>m.tool_calls?.some(c=>c.id===callId)?{...m,tool_calls:m.tool_calls.map(c=>c.id===callId?{...c,function:{...c.function,arguments:JSON.stringify({failed_proposal_omitted:true,note:'该提案未应用；代码正文已从工作上下文移除，原始轨迹保留。请根据工具错误修正。'})}}:c)}:m);
}
export function trimWorkingTools(messages) {
  let result=messages;
  for(const message of messages){
    if(message.role!=='tool')continue;
    try{if(JSON.parse(message.content)?.error)result=discardFailedProposal(result,message.tool_call_id);}catch{}
  }
  const latestTools=result.flatMap((m,i)=>m.role==='tool'?[i]:[]).slice(-3);
  return result.map((m,i)=>m.role==='tool'&&!latestTools.includes(i)&&Buffer.byteLength(m.content)>3000
    ?{...m,content:JSON.stringify({archived_tool_result:true,note:'较早的长工具结果已移出工作上下文；需要时重新读取文件、运行结果或原始历史。'})}:m);
}
