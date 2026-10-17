const escape=text=>String(text).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lines=text=>text.match(/[^\n]*\n|[^\n]+$/g)||[];
export function diffLines(before,after){
  const a=lines(before||''),b=lines(after||'');let prefix=0,suffix=0;
  while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
  while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
  const left=a.slice(prefix,a.length-suffix),right=b.slice(prefix,b.length-suffix),rows=[];
  const add=(type,text)=>rows.push({type,text});
  a.slice(0,prefix).forEach(t=>add('same',t));
  if((left.length+1)*(right.length+1)<=2000000){
    const width=right.length+1,table=new Uint32Array((left.length+1)*width);
    for(let i=left.length-1;i>=0;i--)for(let j=right.length-1;j>=0;j--)table[i*width+j]=left[i]===right[j]?1+table[(i+1)*width+j+1]:Math.max(table[(i+1)*width+j],table[i*width+j+1]);
    let i=0,j=0;
    while(i<left.length||j<right.length){
      if(i<left.length&&j<right.length&&left[i]===right[j]){add('same',left[i++]);j++;}
      else if(i<left.length&&(j===right.length||table[(i+1)*width+j]>=table[i*width+j+1]))add('remove',left[i++]);
      else add('add',right[j++]);
    }
  }else{left.forEach(t=>add('remove',t));right.forEach(t=>add('add',t));}
  a.slice(a.length-suffix).forEach(t=>add('same',t));
  let old=0,next=0;return rows.map(row=>({...row,oldLine:row.type==='add'?null:++old,newLine:row.type==='remove'?null:++next}));
}
export function renderCodeDiff(change){
  const rows=diffLines(change.before,change.after),added=rows.filter(r=>r.type==='add').length,removed=rows.filter(r=>r.type==='remove').length;
  return `<div class="diff-summary"><span class="diff-added">+${added} 行新增</span><span class="diff-removed">−${removed} 行删除</span></div><div class="code-diff" role="region" aria-label="${escape(change.path)} 代码差异"><table><thead><tr><th>原行</th><th>新行</th><th>变更</th><th>代码</th></tr></thead><tbody>${rows.map(r=>`<tr class="diff-${r.type}"><td>${r.oldLine??''}</td><td>${r.newLine??''}</td><td aria-label="${r.type==='add'?'新增':r.type==='remove'?'删除':'未改动'}">${r.type==='add'?'+':r.type==='remove'?'−':' '}</td><td><code>${escape(r.text.replace(/\n$/,''))||' '}</code>${!r.text.endsWith('\n')&&r.type!=='same'?'<span class="diff-eof">（文件末尾无换行）</span>':''}</td></tr>`).join('')}</tbody></table></div>`;
}
