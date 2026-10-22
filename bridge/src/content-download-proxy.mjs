import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

const stop=code=>Object.assign(new Error('下载隧道停止，不回退直连或自动重试。'),{code});
export function validateDownloadProxy(proxy) {
 if(!proxy || Object.keys(proxy).sort().join(',')!=='host,mode,port' || proxy.mode!=='loopback-connect' || proxy.host!=='127.0.0.1' || !Number.isInteger(proxy.port) || proxy.port<1 || proxy.port>65535)throw stop('CONTENT_DOWNLOAD_PROXY_CONFIG_FORBIDDEN');
 return {...proxy};
}
function checkHost(host) {
 if(typeof host!=='string' || host.length>253 || net.isIP(host) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/.test(host))throw stop('CONTENT_DOWNLOAD_PROXY_TARGET_FORBIDDEN');
}
// 独立的无认证CDN隧道；目标只能来自已经校验的来源合同，不复用API认证agent。
export function openDownloadTls(proxy,host,{timeoutMs=15000,signal}={},dependencies={}) {
 proxy=validateDownloadProxy(proxy);checkHost(host);
 const connect=dependencies.connect??net.createConnection,secureConnect=dependencies.secureConnect??tls.connect;
 return new Promise((resolve,reject)=>{
  let raw,secure,finished=false,header=Buffer.alloc(0),timer;
  const abort=()=>finish('CONTENT_DOWNLOAD_PROXY_ABORTED');
  const finish=code=>{
   if(finished)return;finished=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);raw?.removeListener('data',onData);
   if(code){secure?.destroy();raw?.destroy();reject(stop(code));}else resolve(secure);
  };
  const onData=bytes=>{
   header=Buffer.concat([header,bytes]);if(header.length>8192){finish('CONTENT_DOWNLOAD_PROXY_RESPONSE_TOO_LARGE');return;}
   const boundary=header.indexOf('\r\n\r\n');if(boundary<0)return;raw.removeListener('data',onData);
   if(boundary+4!==header.length || !/^HTTP\/1\.[01] 200(?: [^\r\n]*)?\r\n/.test(header.toString('latin1'))){finish('CONTENT_DOWNLOAD_PROXY_CONNECT_REJECTED');return;}
   try {
    secure=secureConnect({socket:raw,servername:host,rejectUnauthorized:true,checkServerIdentity:tls.checkServerIdentity,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});
    secure.once('error',()=>finish('CONTENT_DOWNLOAD_PROXY_TLS_UNKNOWN'));
    secure.once('secureConnect',()=>finish(secure.authorized===true?null:'CONTENT_DOWNLOAD_PROXY_TLS_UNAUTHORIZED'));
   }catch{finish('CONTENT_DOWNLOAD_PROXY_TLS_UNKNOWN');}
  };
  if(signal?.aborted){finish('CONTENT_DOWNLOAD_PROXY_ABORTED');return;}signal?.addEventListener('abort',abort,{once:true});
  timer=setTimeout(()=>finish('CONTENT_DOWNLOAD_PROXY_TIMEOUT'),Math.max(1,Math.min(timeoutMs,15000)));
  try {
   raw=connect({host:proxy.host,port:proxy.port});raw.once('error',()=>finish('CONTENT_DOWNLOAD_PROXY_CONNECT_UNKNOWN'));
   raw.once('connect',()=>raw.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nConnection: keep-alive\r\n\r\n`));raw.on('data',onData);
  }catch{finish('CONTENT_DOWNLOAD_PROXY_CONNECT_UNKNOWN');}
 });
}
export function createDownloadProxyAgent(proxy,host,{timeoutMs=15000}={},dependencies={}) {
 proxy=validateDownloadProxy(proxy);checkHost(host);
 const agent=new https.Agent({keepAlive:false,maxSockets:1,maxCachedSessions:0}),pending=new Set(),destroy=agent.destroy.bind(agent);
 agent.createConnection=(options,callback)=>{
  if(options.host!==host || Number(options.port)!==443 || options.servername!==host){callback(stop('CONTENT_DOWNLOAD_PROXY_TARGET_FORBIDDEN'));return;}
  const controller=new AbortController();pending.add(controller);
  openDownloadTls(proxy,host,{timeoutMs,signal:controller.signal},dependencies).then(socket=>{pending.delete(controller);callback(null,socket);},failure=>{pending.delete(controller);callback(failure);});
 };
 agent.destroy=()=>{for(const controller of pending)controller.abort();destroy();};return agent;
}
