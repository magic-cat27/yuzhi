// Live display is separate from the durable graph and never carries tool arguments.
export function serveAgentStream({req,res,agent,id,auth,token,ownerId}) {
  res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'private, no-cache, no-transform','X-Accel-Buffering':'no'});
  res.flushHeaders();res.write('retry: 1500\n\n');
  let latest=null,pending=false,timer=null,closed=false;
  const write=()=>{timer=null;if(closed||!pending)return;pending=false;
    if(res.writableLength>1024*1024){res.end();return;}
    res.write('data: '+JSON.stringify(latest)+'\n\n');
  };
  const unsubscribe=agent.subscribe(id,value=>{latest=value;pending=true;if(!timer)timer=setTimeout(write,60);});
  const heartbeat=setInterval(()=>{
    if(auth.session(token)?.user.id!==ownerId){res.end();return;}
    res.write(': keepalive\n\n');
  },15000);
  res.on('close',()=>{closed=true;clearTimeout(timer);clearInterval(heartbeat);unsubscribe();});
}
