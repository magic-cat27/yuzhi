// Parse provider SSE incrementally, including split UTF-8 and tool arguments.
export async function readModelStream(response,onDelta=()=>{},onUsage=()=>{}) {
  let pending='',content='',finish=null,done=false,usage=null,total=0;
  const decoder=new TextDecoder(),calls=new Map();
  const frame=text=>{
    const data=text.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
    if(!data)return;
    if(data==='[DONE]'){done=true;return;}
    const item=JSON.parse(data);
    if(item.error)throw Error('Provider stream error');
    if(item.usage){usage=item.usage;onUsage(usage);}
    const choice=item.choices?.[0];if(!choice)return;
    if(choice.finish_reason)finish=choice.finish_reason;
    const delta=choice.delta||{};
    if(typeof delta.content==='string'){content+=delta.content;onDelta({text:delta.content});}
    for(const part of delta.tool_calls||[]){
      if(!Number.isInteger(part.index)||part.index<0||part.index>7)throw Error('Invalid tool index');
      const call=calls.get(part.index)||{id:'',type:'function',function:{name:'',arguments:''}};
      if(part.id)call.id+=part.id;
      if(part.function?.name)call.function.name+=part.function.name;
      if(part.function?.arguments)call.function.arguments+=part.function.arguments;
      calls.set(part.index,call);onDelta({tool:true});
    }
  };
  for await(const chunk of response.body){
    total+=chunk.byteLength;if(total>4*1024*1024)throw Error('Stream too large');
    pending+=decoder.decode(chunk,{stream:true});pending=pending.replace(/\r\n/g,'\n');
    let end;while((end=pending.indexOf('\n\n'))>=0){frame(pending.slice(0,end));pending=pending.slice(end+2);}
  }
  pending+=decoder.decode();if(pending.trim())frame(pending);
  if(!done||!finish)throw Error('Incomplete stream');
  const tool_calls=[...calls.entries()].sort(([a],[b])=>a-b).map(([,call])=>call);
  if(tool_calls.some(c=>!c.id||!c.function.name))throw Error('Incomplete tool call');
  return {choices:[{message:{content,...(tool_calls.length?{tool_calls}:{})},finish_reason:finish}],usage};
}
