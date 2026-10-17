import {WebSocketServer,WebSocket} from 'ws';

// Read-only live channel: the normal authenticated POST endpoints still own all actions.
export function attachAgentWebSocket({server,agent,auth,origin,cookieName}){
  const sockets=new WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:1024});
  server.on('upgrade',async(req,socket,head)=>{
    const reject=status=>{if(!socket.destroyed)socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);};
    socket.on('error',()=>{});
    try{
      const match=new URL(req.url,'http://localhost').pathname.match(/^\/api\/agent\/([a-zA-Z0-9_-]{8,80})\/live$/);
      if(!match)return reject('404 Not Found');
      if(req.headers.origin!==(origin||`http://127.0.0.1:${server.address().port}`))return reject('403 Forbidden');
      const token=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1);
      const ownerId=auth.session(token)?.user.id;if(!ownerId)return reject('401 Unauthorized');
      await agent.record(match[1],ownerId);
      if([...sockets.clients].filter(ws=>ws.ownerId===ownerId).length>=12)return reject('429 Too Many Requests');
      if(socket.destroyed)return;
      sockets.handleUpgrade(req,socket,head,ws=>{
        ws.ownerId=ownerId;let latest=null,pending=false,timer=null,alive=true;
        const send=value=>{if(ws.readyState!==WebSocket.OPEN)return;if(ws.bufferedAmount>1024*1024){ws.close(1013,'Slow connection');return;}ws.send(JSON.stringify(value));};
        const flush=()=>{clearTimeout(timer);timer=null;if(pending){pending=false;send(latest);}};
        const off=agent.subscribe(match[1],value=>{
          // Send any pending final text before the completion signal.
          if(value===null){flush();send(null);return;}
          latest=value;pending=true;if(!timer)timer=setTimeout(flush,20);
        });
        ws.on('pong',()=>{alive=true;});
        ws.on('message',()=>ws.close(1008,'Read-only channel'));
        ws.on('error',()=>{});
        const heartbeat=setInterval(()=>{
          if(auth.session(token)?.user.id!==ownerId){ws.close(1008,'Session expired');return;}
          if(!alive){ws.terminate();return;}alive=false;ws.ping();
        },15000);
        ws.on('close',()=>{clearInterval(heartbeat);clearTimeout(timer);off();});
      });
    }catch(e){reject(e.status===403?'403 Forbidden':'404 Not Found');}
  });
  server.on('close',()=>{for(const ws of sockets.clients)ws.terminate();sockets.close();});
  return sockets;
}
