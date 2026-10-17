import { currentSession } from './auth.js';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const date=t=>new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
const attribution={independent:'独立提出',assisted:'提示后完成',restated:'复述已有方案',unknown:'来源待核验'};
const stateNames={queued:'等待评价',running:'正在评价',completed:'已完成',failed:'评价失败'};
export async function renderAssessment(host,record,onEvidence){
  const panel=document.createElement('section');panel.className='assessment-panel';host.replaceChildren(panel);
  const alive=()=>panel.isConnected&&host.contains(panel);
  const url=`/api/teacher/records/${encodeURIComponent(record.id)}/assessment`;
  let data,selected=new URLSearchParams(location.hash.split('?')[1]||'').get('assessment')||null,busy=false,timer=null;
  const request=async(suffix='',body)=>{
    const r=await fetch(url+suffix,body===undefined?{cache:'no-store'}:{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':currentSession()?.csrf||''},body:JSON.stringify(body)});
    const result=await r.json();if(!r.ok)throw Error(result.error||'评价请求失败，请重试');return result;
  };
  const refs=ids=>ids.length?`<span class="assessment-evidence">${ids.map(id=>{const e=record.events.find(e=>String(e.id)===id);return `<button type="button" data-evidence="${esc(id)}">证据 #${e?.sequence||esc(id)}</button>`;}).join('')}</span>`:'<span class="teacher-muted">暂无可引用证据</span>';
  const schedule=()=>{
    clearTimeout(timer);
    if(data.attempts.some(a=>['queued','running'].includes(a.status)))timer=setTimeout(async()=>{
      if(!alive())return;
      try{data=await request();if(alive()){draw();schedule();}}catch(e){if(alive())panel.querySelector('[role="alert"]').textContent=e.message;}
    },2500);
  };
  const mutate=async(suffix,body)=>{
    busy=true;panel.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{data=await request(suffix,body);if(alive()){selected=suffix==='/review'?body.attemptId:data.attempts.at(-1)?.id;draw();schedule();}}
    catch(e){if(alive()){panel.querySelector('[role="alert"]').textContent=e.message;panel.querySelectorAll('button').forEach(b=>b.disabled=false);}}
    finally{busy=false;}
  };
  function draw(){
    const latest=data.attempts.at(-1),a=data.attempts.find(a=>a.id===selected)||latest;
    const active=data.attempts.some(a=>['queued','running'].includes(a.status));
    const review=a?.reviews?.at(-1),result=review?.result||a?.result;
    panel.innerHTML=`<div class="assessment-heading"><div><h2>过程性评价</h2><p>硬评价与软评价共用原始轨迹证据。模型初评需教师复核。</p></div><div class="record-tools"><button id="assessment-generate" ${active?'disabled':''}>${latest?'重新生成初评':'生成过程评价'}</button><button id="assessment-refresh">刷新状态</button><a class="export-trace" href="${url}/export" download>导出评价</a></div></div><p class="teacher-muted">评价使用已配置的 AI 连接，费用计入发起评价的教师账号。缺少证据不会记零分。</p><p role="alert" class="auth-error"></p>
      ${data.attempts.length?`<label class="assessment-version">评价版本 <select id="assessment-version">${[...data.attempts].reverse().map((v,i)=>`<option value="${esc(v.id)}" ${v.id===a.id?'selected':''}>第 ${data.attempts.length-i} 版 · ${date(v.createdAt)} · ${stateNames[v.status]}${v.stale?' · 轨迹已变化':''}</option>`).join('')}</select></label>`:'<div class="teacher-empty">生成后可查看规划、理解、验证与协作四维评价，并回看每项结论的依据。</div>'}
      ${a?`<div class="trace-notice">${a.stale?'轨迹已有新增或变化，本版本仅对应此前记录。请重新生成后复核。':review?'教师已复核；原始模型初评仍保留。':'模型初评 · 待教师核验'} · 覆盖前 ${a.sourceEventCount} 条事件 · ${esc(a.rubricVersion)} · ${esc(a.model)}</div>`:''}
      ${a&&['queued','running'].includes(a.status)?`<p class="assessment-progress" role="status">${a.progress.phase==='synthesizing'?'证据提取完成，正在综合生成硬评价和软评价…':a.status==='queued'?'已排队，等待评价…':`正在提取过程证据：${a.progress.done} / ${a.progress.total} 个片段`}</p>`:''}
      ${a?.status==='failed'?`<div class="trace-notice">${esc(a.error)}<p>可重新生成；历史完成版本可在上方切换查看。</p></div>`:''}
      ${result?`<div class="assessment-total"><div><span>硬评价</span><strong>${result.total===null?'待核验':result.total+' / 100'}</strong></div><p>证据覆盖权重 ${result.coverageWeight}%${result.total===null?' · 部分维度证据不足，暂不计算总分':''}</p></div><div class="assessment-dimensions">${Object.entries(data.dimensions).map(([key,d])=>`<article><div><h3>${esc(d.label)}</h3><b>${result.hard[key].score===null?'待核验':result.hard[key].score+' / 4'}</b></div><small>权重 ${d.weight}%</small><p>${esc(result.hard[key].reason)}</p>${refs(result.hard[key].event_ids)}</article>`).join('')}</div><section class="assessment-soft"><h3>软评价</h3><div class="assessment-prose">${esc(result.soft.text)}</div>${refs(result.soft.event_ids)}</section>
      <details class="assessment-episodes"><summary>过程片段与贡献来源（${result.episodes.length}）</summary>${result.episodes.map(e=>`<article><h3>${esc(e.title)} <small>${attribution[e.attribution]}</small></h3><dl>${[['学生贡献',e.student_contribution],['AI 帮助',e.ai_help],['验证与修正',e.verification],['结果与责任',e.outcome]].map(([k,v])=>`<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>${refs(e.event_ids)}</article>`).join('')}</details>
      <section class="assessment-limitations"><h3>证据局限</h3>${result.limitations.map(l=>`<p>${esc(l)}</p>`).join('')||'<p>请结合原始轨迹核验模型结论。</p>'}</section>
      <details class="assessment-review"><summary>教师修订与确认</summary><form id="assessment-review-form"><p>修改分数须同步修改该维度理由，并核对下方软评价；“待核验”表示证据不足。</p>${Object.entries(data.dimensions).map(([k,d])=>`<label>${esc(d.label)} <select name="${k}-score">${[null,0,1,2,3,4].map(v=>`<option value="${v===null?'null':v}" ${v===result.hard[k].score?'selected':''}>${v===null?'待核验':v+' / 4'}</option>`).join('')}</select><textarea name="${k}-reason" required maxlength="6000">${esc(result.hard[k].reason)}</textarea><span class="teacher-muted">证据事件 ID（逗号分隔，可从原始轨迹或导出文件核对）</span><input name="${k}-refs" value="${esc(result.hard[k].event_ids.join(','))}"></label>`).join('')}<label>软评价<textarea name="soft" required maxlength="12000" rows="8">${esc(result.soft.text)}</textarea></label><label>软评价证据事件 ID<input name="soft-refs" value="${esc(result.soft.event_ids.join(','))}"></label><label>复核说明<textarea name="note" required maxlength="3000" placeholder="说明确认依据或修订原因"></textarea></label><label class="assessment-check"><input type="checkbox" required>已核对证据、四维分数与软评价的一致性</label><button type="submit" ${a.stale||active?'disabled':''}>保存教师复核</button>${a.stale?'<p>当前轨迹已变化，不能确认此旧版本。</p>':''}</form></details>
      <details class="assessment-history"><summary>原始初评与复核历史（${a.reviews.length} 次复核）</summary><h4>原始模型初评</h4><pre>${esc(JSON.stringify(a.result,null,2))}</pre>${a.reviews.map(r=>`<h4>${date(r.createdAt)} · 教师 ${esc(r.teacherId.slice(0,8))}</h4><p>${esc(r.note)}</p><pre>${esc(JSON.stringify(r.result,null,2))}</pre>`).join('')}</details>`:''}`;
    panel.querySelector('#assessment-generate').onclick=()=>{if(!busy)mutate('',{regenerate:!!latest});};
    panel.querySelector('#assessment-refresh').onclick=async()=>{try{data=await request();if(alive()){draw();schedule();}}catch(e){if(alive())panel.querySelector('[role="alert"]').textContent=e.message;}};
    panel.querySelector('#assessment-version')?.addEventListener('change',e=>{selected=e.target.value;draw();});
    panel.querySelectorAll('[data-evidence]').forEach(b=>b.onclick=()=>{clearTimeout(timer);onEvidence(b.dataset.evidence);});
    panel.querySelector('#assessment-review-form')?.addEventListener('submit',e=>{
      e.preventDefault();if(busy)return;const form=new FormData(e.target),split=v=>String(v||'').split(',').map(v=>v.trim()).filter(Boolean);
      const hard=Object.fromEntries(Object.keys(data.dimensions).map(k=>[k,{score:form.get(k+'-score')==='null'?null:Number(form.get(k+'-score')),reason:form.get(k+'-reason'),event_ids:split(form.get(k+'-refs'))}]));
      mutate('/review',{attemptId:a.id,baseReviewId:review?.id||null,hard,soft:{text:form.get('soft'),event_ids:split(form.get('soft-refs'))},note:form.get('note')});
    });
  }
  panel.innerHTML='<p role="status">正在加载评价…</p>';
  try{data=await request();if(alive()){draw();schedule();}}catch(e){if(alive()){panel.innerHTML=`<p role="alert">${esc(e.message)}</p><button>重新加载评价</button>`;panel.querySelector('button').onclick=()=>renderAssessment(host,record,onEvidence);}}
}
