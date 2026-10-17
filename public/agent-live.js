// WebSocket avoids the SSE buffering on trycloudflare.com. Short requests provide
// live snapshots while the socket reconnects; neither channel submits model work.
export function connectAgentLive({url,onValue,onStatus,fetchSnapshot,isRunning=()=>false,Socket=WebSocket}){
  let socket=null,closed=false,retry=null,poll=null,timeout=null,delay=500,controller=null,last;
  const deliver=value=>{const encoded=JSON.stringify(value);if(encoded!==last){last=encoded;onValue(value);}};
  async function fallback(){
    if(closed||socket?.readyState===1)return;
    controller=new AbortController();const abort=setTimeout(()=>controller?.abort(),5000);
    try{const value=await fetchSnapshot(controller.signal);if(!closed&&socket?.readyState!==1)deliver(value);}catch{ /* Keep the latest visible draft. */ }
    finally{clearTimeout(abort);controller=null;if(!closed&&socket?.readyState!==1)poll=setTimeout(fallback,isRunning()?250:2000);}
  }
  function connect(){
    if(closed)return;
    onStatus('connecting');
    socket=new Socket(url);
    timeout=setTimeout(()=>{if(socket.readyState!==1)socket.close();},5000);
    socket.onopen=()=>{if(closed){socket.close();return;}clearTimeout(timeout);clearTimeout(poll);controller?.abort();delay=500;onStatus('connected');};
    socket.onmessage=event=>{if(closed)return;try{deliver(JSON.parse(event.data));}catch{ /* Ignore malformed frames. */ }};
    socket.onerror=()=>onStatus('reconnecting');
    socket.onclose=()=>{
      clearTimeout(timeout);if(closed)return;onStatus('reconnecting');
      clearTimeout(poll);fallback();retry=setTimeout(connect,delay);delay=Math.min(delay*2,10000);
    };
  }
  connect();fallback();
  return {close(){closed=true;clearTimeout(timeout);clearTimeout(retry);clearTimeout(poll);controller?.abort();socket?.close();}};
}
