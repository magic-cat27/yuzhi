import {agentRequest} from './agent-client.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const runLabels={running:'正在运行',succeeded:'运行结束',failed:'运行失败',timeout:'运行超时',cancelled:'已停止',interrupted:'运行中断',error:'运行异常'};
export function artifactMarkup(runId,items=[]){return `<div class="run-artifacts">${items.map(a=>{const url=`/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(a.id)}`;return `<div class="run-artifact">${['image/png','image/jpeg'].includes(a.mime)?`<a href="${url}?preview=1" target="_blank" rel="noopener" title="打开图片"><img src="${url}?preview=1" alt="${esc(a.name)}" loading="lazy"></a>`:''}<a href="${url}" download>${esc(a.name)} ↓</a><small>${(a.size/1024).toFixed(1)} KB</small></div>`;}).join('')}</div>`;}
export function runMarkup(run){return `<div class="run-result"><div class="run-result-heading"><strong>${esc(runLabels[run.status]||run.status)}</strong><span>退出码 ${run.exitCode??'—'} · ${((run.durationMs||0)/1000).toFixed(2)} 秒</span></div><div class="run-version">使用第 ${run.sourceSequence} 条轨迹时的代码 · ${esc(run.sourceHash?.slice(0,10))}</div><pre class="run-command">❯ ${esc(run.command)}</pre>${run.stdout?`<pre class="run-stdout">${esc(run.stdout)}</pre>`:''}${run.stderr?`<pre class="run-stderr">${esc(run.stderr)}</pre>`:''}${run.status==='succeeded'?'<p class="run-caption">程序已退出；结果是否正确仍需结合测试判断。</p>':''}${artifactMarkup(run.id||run.runId,run.artifacts)}</div>`;}
export function mountExecution({traceId,sync,activeFile,onUpdate,openPanel,settings,saveSettings}){
  const output=document.querySelector('#console-output'),form=document.querySelector('#terminal-form'),runButton=document.querySelector('#run-project');
  const tabs=document.querySelector('.terminal-tabs');
  tabs.insertAdjacentHTML('beforeend','<button id="expand-run">放大结果</button><button id="run-settings">输入与设置</button><button id="stop-run" disabled>停止</button>');
  output.insertAdjacentHTML('beforebegin','<div class="run-history-bar"><span id="execution-ready">正在检查运行环境…</span><select id="run-history" aria-label="运行记录"><option value="">暂无运行</option></select></div>');
  document.querySelector('#expand-run').onclick=e=>{const expanded=document.querySelector('.editor-column').classList.toggle('terminal-expanded');e.currentTarget.textContent=expanded?'返回代码':'放大结果';};
  const stop=document.querySelector('#stop-run'),history=document.querySelector('#run-history');
  form.querySelector('span').textContent='隔离终端';
  let disposed=false,timer=null,records=[],selected='',lastView='',busy=false,available=false,readyMessage='正在检查运行环境…';
  const message=text=>{output.textContent=text;};
  function render(){
    if(disposed)return;
    const current=records.find(r=>r.id===selected)||records[0];if(current)selected=current.id;
    history.innerHTML=records.length?records.map(r=>`<option value="${r.id}" ${r.id===selected?'selected':''}>${new Date(r.startedAt).toLocaleTimeString('zh-CN')} · ${esc(runLabels[r.status]||r.status)} · ${r.actor==='ai'?'AI':'你'}</option>`).join(''):'<option>暂无运行</option>';
    const running=records.some(r=>r.status==='running');stop.disabled=!running;runButton.disabled=busy||running||!available;
    if(current&&JSON.stringify(current)!==lastView){lastView=JSON.stringify(current);output.innerHTML=runMarkup(current);}
  }
  async function poll(){
    clearTimeout(timer);if(disposed)return;
    try{
      const next=await agentRequest(`/api/execution/${traceId}`);if(disposed)return;
      if(next[0]&&!records.some(r=>r.id===next[0].id))selected=next[0].id;
      records=await Promise.all(next.map(r=>r.status==='running'?agentRequest(`/api/runs/${r.id}`):r));
      if(disposed)return;document.querySelector('#execution-ready').textContent=readyMessage;render();onUpdate();
    }catch(e){if(!disposed)document.querySelector('#execution-ready').textContent='运行记录暂不可用 · 将自动重连';}
    finally{if(!disposed)timer=setTimeout(poll,records.some(r=>r.status==='running')?800:4000);}
  }
  async function start(input){
    if(busy||!available)return;busy=true;render();openPanel();
    try{await sync();if(disposed)return;const run=await agentRequest(`/api/execution/${traceId}`,{...input,stdin:settings().stdin||'',timeout:settings().timeout||60});selected=run.id;records=[run,...records];lastView='';render();await poll();}
    catch(e){if(!disposed)message(e.message);}
    finally{busy=false;if(!disposed)render();}
  }
  runButton.onclick=()=>start(activeFile()?.endsWith('.py')?{mode:'python',file:activeFile()}:{mode:'c'});
  stop.onclick=async()=>{const running=records.find(r=>r.status==='running');if(running){stop.disabled=true;try{await agentRequest(`/api/runs/${running.id}/cancel`,{});await poll();}catch(e){message(e.message);}}};
  history.onchange=()=>{selected=history.value;lastView='';render();};
  form.onsubmit=e=>{e.preventDefault();const input=document.querySelector('#terminal-input'),command=input.value.trim();if(!command)return;input.value='';
    if(command==='clear'){output.textContent='';lastView='';return;}
    if(command==='help'){message('这里可以运行 gcc、cmake、Python 和 shell 命令。\n示例：python3 scripts/plot.py\n生成数据和图片请写入 artifacts/；plt.show() 会自动保存图片。\n每次运行使用新副本，最近一次运行的产物会带入 artifacts/。\n网络与在线安装不可用；源码改动请在编辑器进行。标准输入在“输入与设置”填写。');return;}
    start({mode:'command',command});};
  document.querySelectorAll('[data-console-tab]').forEach(button=>button.onclick=()=>{document.querySelectorAll('[data-console-tab]').forEach(b=>b.classList.toggle('active',b===button));form.hidden=button.dataset.consoleTab!=='terminal';lastView='';render();});
  document.querySelector('#run-settings').onclick=()=>{
    document.querySelector('#run-settings-dialog')?.remove();const dialog=document.createElement('dialog');dialog.id='run-settings-dialog';dialog.className='run-settings-dialog';
    dialog.innerHTML=`<h2>运行输入与设置</h2><p>当前文件为 Python 时运行此文件；其他文件运行 C 项目。自定义命令可在终端输入。</p><label for="run-stdin">标准输入（stdin）</label><textarea id="run-stdin" rows="7" maxlength="60000" placeholder="例如：5">${esc(settings().stdin||'')}</textarea><label for="run-timeout">最长运行时间</label><select id="run-timeout">${[10,30,60].map(n=>`<option value="${n}" ${n===(settings().timeout||60)?'selected':''}>${n} 秒</option>`).join('')}</select><p>已有产物从最近一次有产物的运行带入；工作区源码不受运行影响。</p><div class="dialog-actions"><button id="run-settings-close">取消</button><button class="primary" id="run-settings-save">保存设置</button></div>`;
    document.body.append(dialog);dialog.showModal();dialog.querySelector('#run-settings-close').onclick=()=>dialog.close();dialog.querySelector('#run-settings-save').onclick=()=>{saveSettings({stdin:dialog.querySelector('#run-stdin').value,timeout:Number(dialog.querySelector('#run-timeout').value)});dialog.close();};
  };
  runButton.disabled=true;
  (async()=>{try{const health=await agentRequest('/api/execution/status');if(disposed)return;available=health.available;readyMessage=health.message;document.querySelector('#execution-ready').textContent=readyMessage;if(!available)message(health.message);else message('运行环境已就绪。点击“运行项目”执行 C 项目或当前 Python 文件；也可以在下方输入命令。');await sync();if(!disposed)await poll();}catch(e){if(!disposed)message(e.message);}})();
  return ()=>{disposed=true;clearTimeout(timer);document.querySelector('#run-settings-dialog')?.remove();};
}
