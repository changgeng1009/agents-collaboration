import fs from 'node:fs';import http from 'node:http';import https from 'node:https';import dns from 'node:dns/promises';import {isIP} from 'node:net';import {createHash} from 'node:crypto';import {fail} from './policy.mjs';
import {createDownloadProxyAgent,validateDownloadProxy} from './content-download-proxy.mjs';

export function isPublicIPv4(value){
 if(isIP(value)!==4)return false;const[a,b,c]=value.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||a===100&&b>=64&&b<=127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0&&(c===0||c===2)||b===88&&c===99)||a===198&&(b===18||b===19||b===51&&c===100)||a===203&&b===0&&c===113);
}
export function validateSourceUrl(source,{fixture=false}={}){
 let url;try{url=new URL(source.url);}catch{fail('CONTENT_DOWNLOAD_URL_FORBIDDEN','来源合同缺少有效地址。');}
 if(url.username||url.password||url.hash||url.href.length>4096||!Array.isArray(source.allowedHosts)||!source.allowedHosts.includes(url.hostname))fail('CONTENT_DOWNLOAD_URL_FORBIDDEN','来源地址必须匹配可信宿主固定域名，不含认证或片段。');
 if(fixture){if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||process.env.COLLAB_TEST_MODE!=='1')fail('CONTENT_DOWNLOAD_FIXTURE_FORBIDDEN','测试只访问显式本机临时端口。');}
 else if(url.protocol!=='https:'||url.port&&url.port!=='443'||isIP(url.hostname))fail('CONTENT_DOWNLOAD_URL_FORBIDDEN','真实候选仅允许域名HTTPS默认端口。');
 if(source.mode==='fresh'){
  if(source.urlSha256!==createHash('sha256').update(url.href).digest('hex')||!Number.isSafeInteger(source.maxBytes)||source.maxBytes<1||source.maxBytes>64*1024*1024||!Number.isSafeInteger(source.maxRedirects)||source.maxRedirects<0||source.maxRedirects>3)fail('CONTENT_DOWNLOAD_FRESH_POLICY_REQUIRED','fresh须固定原URL摘要、大小上限、逐跳主机白名单与最多三跳。');
 }else if(source.mode!==undefined&&source.mode!=='pinned'||!/^[a-f0-9]{64}$/.test(source.sha256??'')||!Number.isSafeInteger(source.byteLength)||source.byteLength<1||source.byteLength>64*1024*1024)fail('CONTENT_DOWNLOAD_PIN_REQUIRED','已知字节模式须固定原始SHA和有界准确大小。');return url;
}
// 默认逐跳固定公开IPv4；显式代理单独验证CDN TLS，不宣称验证了代理端DNS的公开IP。
// 所有模式只发两个固定头，不复制API认证、Cookie、系统代理或自定义头。
export async function downloadPinnedSource(source,file,{fixture=false,traceFile=null,proxy=null,timeoutMs=15000}={}){
 let url=validateSourceUrl(source,{fixture});const originalUrlSha256=createHash('sha256').update(url.href).digest('hex'),fresh=source.mode==='fresh',maxBytes=fresh?source.maxBytes:source.byteLength;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>120000)fail('CONTENT_DOWNLOAD_TIMEOUT_POLICY_REQUIRED','下载总时限必须有界。');
 if(proxy){validateDownloadProxy(proxy);if(fixture||source.urlSha256!==originalUrlSha256||fresh&&source.maxRedirects!==0)fail('CONTENT_DOWNLOAD_PROXY_POLICY_REQUIRED','显式下载代理须固定原URL摘要且禁止跳转。');}
 const output=fs.openSync(file,'wx+',0o600),opened=fs.fstatSync(output,{bigint:true}),hash=createHash('sha256'),trace=[],deadline=Date.now()+timeoutMs;let count=0,redirects=0,status='unknown',agent=null;
 const error=(code,message)=>Object.assign(new Error(message),{code});
 try{
  while(true){let address=fixture?'127.0.0.1':null;if(!fixture&&!proxy){let timer;const rows=await Promise.race([dns.lookup(url.hostname,{all:true,family:4,verbatim:true}),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(error('CONTENT_DOWNLOAD_DNS_TIMEOUT','DNS结果未知。')),Math.max(1,Math.min(10000,deadline-Date.now())));})]).finally(()=>clearTimeout(timer));if(!rows.length||rows.some(row=>!isPublicIPv4(row.address)))fail('CONTENT_DOWNLOAD_DNS_FORBIDDEN','域名解析含非公开地址或无受支持IPv4。');address=rows[0].address;}
   if(Date.now()>=deadline)throw error('CONTENT_DOWNLOAD_TIMEOUT_UNKNOWN','下载总时限已到。');
   if(proxy)agent=createDownloadProxyAgent(proxy,url.hostname,{timeoutMs:deadline-Date.now()});
   const entry={hop:redirects,host:url.hostname,urlSha256:createHash('sha256').update(url.href).digest('hex'),address,networkMode:proxy?'loopback-connect':'direct',remotePublicAddressVerified:!fixture&&!proxy,statusCode:null};trace.push(entry);
   const location=await new Promise((resolve,reject)=>{let finished=false,timer,responseRef;const finish=(failure,location=null)=>{if(finished)return;finished=true;clearTimeout(timer);failure?reject(failure):resolve(location);};
    const transport=fixture?http:https,request=transport.request(url,{method:'GET',agent:agent??false,headers:{accept:'application/octet-stream',connection:'close'},...(!proxy?{lookup:(host,options,callback)=>callback(null,options?.all?[{address,family:4}]:address,options?.all?undefined:4)}:{}),servername:url.hostname,rejectUnauthorized:true},response=>{
     responseRef=response;
     entry.statusCode=response.statusCode;
     if(fresh&&[301,302,303,307,308].includes(response.statusCode)){const target=response.headers.location;response.destroy();if(typeof target!=='string'||!target.length||target.length>4096)finish(error('CONTENT_DOWNLOAD_REDIRECT_UNKNOWN','跳转缺少准确地址。'));else finish(null,target);return;}
     const length=response.headers['content-length'];if(response.statusCode!==200||length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBytes)||!fresh&&Number(length)!==source.byteLength||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();finish(error('CONTENT_DOWNLOAD_HTTP_UNKNOWN','来源状态、大小或编码不符。'));return;}
     response.on('data',bytes=>{if(finished)return;try{count+=bytes.length;if(count>maxBytes)throw error('CONTENT_DOWNLOAD_SIZE_UNKNOWN','来源超过批准大小上限。');let offset=0;while(offset<bytes.length){const written=fs.writeSync(output,bytes,offset,bytes.length-offset);if(written<1)throw error('CONTENT_DOWNLOAD_WRITE_UNKNOWN','写入未完成。');offset+=written;}hash.update(bytes);}catch(failure){response.destroy();finish(failure);}});
     response.once('aborted',()=>finish(error('CONTENT_DOWNLOAD_PARTIAL_UNKNOWN','传输中断，保留部分文件。')));response.once('error',finish);response.once('end',()=>finish());
    });timer=setTimeout(()=>{responseRef?.destroy();request.destroy();finish(error('CONTENT_DOWNLOAD_TIMEOUT_UNKNOWN','下载超时，保留未知。'));},Math.max(1,deadline-Date.now()));request.once('error',finish);request.end();
   });
   if(location===null)break;if(redirects>=source.maxRedirects)fail('CONTENT_DOWNLOAD_REDIRECT_LIMIT','超过准确批准跳数，停止不重试。');
   let next;try{next=new URL(location,url);}catch{fail('CONTENT_DOWNLOAD_REDIRECT_UNKNOWN','跳转地址无效。');}
   url=validateSourceUrl({...source,url:next.href,urlSha256:createHash('sha256').update(next.href).digest('hex')},{fixture});redirects++;
  }
  fs.fsyncSync(output);const streamed=hash.digest('hex'),diskHash=createHash('sha256'),buffer=Buffer.alloc(65536);let diskBytes=0;
  const before=fs.fstatSync(output,{bigint:true});for(let n;(n=fs.readSync(output,buffer,0,buffer.length,diskBytes))>0;){diskBytes+=n;if(diskBytes>maxBytes)fail('CONTENT_DOWNLOAD_SIZE_UNKNOWN','落盘大小超限。');diskHash.update(buffer.subarray(0,n));}
  const after=fs.fstatSync(output,{bigint:true}),named=fs.lstatSync(file,{bigint:true}),digest=diskHash.digest('hex');
  if(!named.isFile()||named.nlink!==1n||['dev','ino','birthtimeNs'].some(k=>named[k]!==opened[k])||['dev','ino','size','mtimeNs'].some(k=>before[k]!==after[k]||after[k]!==named[k])||diskBytes!==count||Number(named.size)!==count||digest!==streamed||count<1||!fresh&&(count!==source.byteLength||digest!==source.sha256))fail('CONTENT_DOWNLOAD_HASH_UNKNOWN','落盘身份、大小或SHA与回收字节不符。');
  status='succeeded';return{mode:fresh?'fresh':'pinned',byteLength:diskBytes,sha256:digest,diskReadbackVerified:true,urlSha256:originalUrlSha256,finalUrlSha256:createHash('sha256').update(url.href).digest('hex'),redirectsFollowed:redirects,trace,authenticationCopied:false,originVerifiedAsPlatform:false};
 }finally{agent?.destroy();fs.closeSync(output);if(traceFile)fs.writeFileSync(traceFile,JSON.stringify({status,mode:fresh?'fresh':'pinned',bytesObserved:count,trace,automaticRetry:false},null,2),{flag:'wx'});}
}
