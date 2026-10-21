import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

const TARGET='maas.qianwenaiapi.com';
export const LOOPBACK_PROXY_ERROR_CODES=Object.freeze(['QWEN_PROXY_CONFIG_FORBIDDEN','QWEN_PROXY_RESPONSE_TOO_LARGE','QWEN_PROXY_CONNECT_REJECTED','QWEN_PROXY_TLS_UNKNOWN','QWEN_PROXY_TLS_UNAUTHORIZED','QWEN_PROXY_TIMEOUT','QWEN_PROXY_CONNECT_UNKNOWN','QWEN_PROXY_TARGET_FORBIDDEN']);
const stop=code=>Object.assign(new Error('可信本机隧道未通过验证，停止且不自动重试。'),{code});
export function validateLoopbackProxy(proxy) {
 if(!proxy || Object.keys(proxy).sort().join(',')!=='host,mode,port' || proxy.mode!=='loopback-connect' || proxy.host!=='127.0.0.1' || !Number.isInteger(proxy.port) || proxy.port<1 || proxy.port>65535)throw stop('QWEN_PROXY_CONFIG_FORBIDDEN');
 return {mode:proxy.mode,host:proxy.host,port:proxy.port};
}

// CONNECT阶段只传固定目标，无API凭据。认证HTTP仅在目标TLS验证完成后写入隧道。
export function openLoopbackTls(proxy,{timeoutMs=15000}={},dependencies={}) {
 proxy=validateLoopbackProxy(proxy);
 const connect=dependencies.connect ?? net.createConnection,secureConnect=dependencies.secureConnect ?? tls.connect;
 return new Promise((resolve,reject)=>{
  let raw,secure,finished=false,header=Buffer.alloc(0),timer;
  const finish=(code)=>{
   if(finished)return;finished=true;clearTimeout(timer);
   raw?.removeListener('data',onData);
   if(code){secure?.destroy();raw?.destroy();reject(stop(code));}else resolve(secure);
  };
  const onData=bytes=>{
   header=Buffer.concat([header,bytes]);
   if(header.length>8192){finish('QWEN_PROXY_RESPONSE_TOO_LARGE');return;}
   const boundary=header.indexOf('\r\n\r\n');if(boundary<0)return;
   raw.removeListener('data',onData);
   if(boundary+4!==header.length || !/^HTTP\/1\.[01] 200(?: [^\r\n]*)?\r\n/.test(header.toString('latin1'))){finish('QWEN_PROXY_CONNECT_REJECTED');return;}
   try {
    secure=secureConnect({socket:raw,servername:TARGET,rejectUnauthorized:true,checkServerIdentity:tls.checkServerIdentity,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});
    secure.once('error',()=>finish('QWEN_PROXY_TLS_UNKNOWN'));
    secure.once('secureConnect',()=>finish(secure.authorized===true?null:'QWEN_PROXY_TLS_UNAUTHORIZED'));
   }catch{finish('QWEN_PROXY_TLS_UNKNOWN');}
  };
  timer=setTimeout(()=>finish('QWEN_PROXY_TIMEOUT'),Math.max(1,Math.min(timeoutMs,15000)));
  try {
   raw=connect({host:proxy.host,port:proxy.port});
   raw.once('error',()=>finish('QWEN_PROXY_CONNECT_UNKNOWN'));
   raw.once('connect',()=>{raw.write(`CONNECT ${TARGET}:443 HTTP/1.1\r\nHost: ${TARGET}:443\r\nConnection: keep-alive\r\n\r\n`);});
   raw.on('data',onData);
  }catch{finish('QWEN_PROXY_CONNECT_UNKNOWN');}
 });
}

export function createLoopbackAgent(proxy,{timeoutMs=15000}={},dependencies={}) {
 proxy=validateLoopbackProxy(proxy);
 const agent=new https.Agent({keepAlive:false,maxSockets:1,maxCachedSessions:0});
 agent.createConnection=(options,callback)=>{
  if(options.host!==TARGET || Number(options.port)!==443 || options.servername && options.servername!==TARGET){callback(stop('QWEN_PROXY_TARGET_FORBIDDEN'));return;}
  openLoopbackTls(proxy,{timeoutMs},dependencies).then(socket=>callback(null,socket),failure=>callback(failure));
 };
 return agent;
}
