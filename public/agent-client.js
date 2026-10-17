import {renderCodeDiff} from './code-diff.js';
import { currentSession } from './auth.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function agentRequest(url,body){
  const response=await fetch(url,{cache:'no-store',...(body?{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':currentSession()?.csrf||''},body:JSON.stringify(body)}:{})});
  const result=await response.json();if(!response.ok)throw Error(result.error||'AI 请求失败，请重试');return result;
}
export function renderAgentStatus(info,{review,resume,prompt}){
  const host=document.querySelector('#agent-controls');if(!host)return;
  const label=document.querySelector('.model-badge');
  if(label)label.textContent=info.configured?(info.model?.includes('flash')?'DeepSeek V4 Flash':info.model?.startsWith('deepseek-v4-pro')?'DeepSeek V4 Pro':info.model||'AI 助手'):'待教师连接';
  const status=info.status==='running'?'正在处理 · 进度自动保存':info.status==='approval'?'等待你确认文件改动':info.status==='paused'?'任务已保存 · 可恢复':info.status==='error'?'本轮未完成':info.configured?'已配置 · 文件改动需你同意':'请教师在「AI 连接」中设置密钥';
  host.innerHTML=`<div class="agent-progress" role="status">${esc(status)}${info.budget?.unlimited?'<small>本账号不设平台额度限制</small>':Number.isFinite(info.budget?.remainingRmb)?`<small>个人额度剩余 ¥${info.budget.remainingRmb.toFixed(2)} / ¥${info.budget.budgetRmb} · 按保守估算</small>`:''}${info.compactions?`<small>上下文已整理 ${info.compactions} 次 · 原始轨迹保留</small>`:''}</div>${info.promptTrial?.enabled?`<button id="edit-personal-prompt" class="prompt-trial-button">试用提示词${info.promptTrial.custom?' · 个人版本':''}</button>`:''}${info.error?`<p class="agent-error">${esc(info.error)}</p>`:''}${info.proposal?`<div class="agent-approval-card"><strong>有 ${info.proposal.changes.length} 个文件等待确认</strong><p>${esc(info.proposal.summary)}</p><button id="review-ai-change">查看具体改动</button></div>`:''}${['error','paused'].includes(info.status)?'<button id="resume-ai-task">恢复未完成任务</button>':''}`;
  host.querySelector('#edit-personal-prompt')?.addEventListener('click',prompt);
  host.querySelector('#review-ai-change')?.addEventListener('click',()=>review(info.proposal));
  host.querySelector('#resume-ai-task')?.addEventListener('click',resume);
  const submit=document.querySelector('.send-button');if(submit)submit.disabled=!info.configured||['running','approval'].includes(info.status);
}
export function reviewChanges(proposal,decide){
  document.querySelector('#ai-review-dialog')?.remove();
  const dialog=document.createElement('dialog');dialog.id='ai-review-dialog';dialog.className='ai-review-dialog';
  dialog.innerHTML=`<header><span class="eyebrow">REVIEW CHANGES</span><h2>确认这次文件改动</h2><p>${esc(proposal.summary)}</p><p class="review-plan">依据你的规划：${esc(proposal.planQuote)}</p></header><div class="ai-review-files">${proposal.changes.map(change=>`<section><h3>${change.before===null?'新建':'修改'} · ${esc(change.path)}</h3>${renderCodeDiff(change)}<details class="diff-full"><summary>查看修改前后全文</summary><div class="code-comparison"><div><h4>当前版本</h4><pre>${change.before===null?'（文件尚不存在）':esc(change.before)}</pre></div><div><h4>拟应用版本</h4><pre>${esc(change.after)}</pre></div></div></details></section>`).join('')}</div><p class="agent-error" id="ai-review-error" role="alert"></p><footer><span>只授权本次展示的改动；文件变化后会停止应用。</span><button data-review="close">稍后决定</button><button data-review="reject">拒绝改动</button><button class="primary" data-review="approve">同意并应用</button></footer>`;
  document.body.append(dialog);dialog.showModal();
  dialog.querySelector('[data-review="close"]').onclick=()=>dialog.close();
  for(const action of ['reject','approve'])dialog.querySelector(`[data-review="${action}"]`).onclick=async()=>{
    dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{await decide(proposal.id,action==='approve');dialog.close();}
    catch(e){dialog.querySelector('#ai-review-error').textContent=e.message;dialog.querySelectorAll('button').forEach(b=>b.disabled=false);}
  };
}
export async function showAISettings(){
  document.querySelector('#ai-settings-dialog')?.remove();
  const dialog=document.createElement('dialog');dialog.id='ai-settings-dialog';dialog.className='ai-settings-dialog';
  dialog.innerHTML='<h2>AI 连接</h2><p>正在读取配置…</p>';document.body.append(dialog);dialog.showModal();
  try{
    const info=await agentRequest('/api/teacher/ai-settings');
    dialog.innerHTML=`<span class="eyebrow">MODEL CONNECTION</span><h2>AI 连接</h2><p>${esc(info.model)} · 百炼入口</p><div class="ai-settings-summary">${info.configured?'密钥已配置':'尚未配置密钥'}<br>每账号累计额度：¥${info.budgetRmb}<br>全站已计入保守估算：¥${info.accountedRmb}（含历史连接测试）</div><form><label for="ai-api-key">百炼 API Key</label><input id="ai-api-key" type="password" autocomplete="off" placeholder="${info.configured?'输入新密钥以替换':'输入百炼控制台生成的 API Key'}" minlength="12" maxlength="512" required><p class="teacher-muted">密钥只保存到服务端，不回传浏览器。发送消息时才调用模型并可能产生费用；额度按保守估算控制。</p><p id="ai-settings-error" class="agent-error" role="alert"></p><div class="dialog-actions"><button type="button" id="close-ai-settings">关闭</button><button class="primary" type="submit">保存连接配置</button></div></form>`;
    dialog.querySelector('#close-ai-settings').onclick=()=>dialog.close();
    dialog.querySelector('form').onsubmit=async e=>{
      e.preventDefault();const button=dialog.querySelector('[type="submit"]');button.disabled=true;
      try{await agentRequest('/api/teacher/ai-settings',{apiKey:dialog.querySelector('#ai-api-key').value.trim()});dialog.querySelector('#ai-api-key').value='';dialog.querySelector('.ai-settings-summary').textContent='密钥已保存。可在学生视图发送一条消息验证连接。';}
      catch(error){dialog.querySelector('#ai-settings-error').textContent=error.message;}
      finally{button.disabled=false;}
    };
  }catch(e){dialog.innerHTML=`<h2>AI 连接暂不可用</h2><p>${esc(e.message)}</p><button>关闭</button>`;dialog.querySelector('button').onclick=()=>dialog.close();}
}
