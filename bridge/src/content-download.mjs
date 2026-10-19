import fs from 'node:fs';import http from 'node:http';import https from 'node:https';import dns from 'node:dns/promises';import {isIP} from 'node:net';import {createHash} from 'node:crypto';import {fail} from './policy.mjs';

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
// 每跳重新验证合同与DNS，固定连接IP和TLS域名；从不复制认证、cookie、代理或自定义头。
export async function downloadPinnedSource(source,file,{fixture=false,traceFile=null}={}){
 let url=validateSourceUrl(source,{fixture});const originalUrlSha256=createHash('sha256').update(url.href).digest('hex'),fresh=source.mode==='fresh',maxBytes=fresh?source.maxBytes:source.byteLength,output=fs.openSync(file,'wx',0o600),hash=createHash('sha256'),trace=[];let count=0,redirects=0,status='unknown';
 const error=(code,message)=>Object.assign(new Error(message),{code});
 try{
  while(true){let address='127.0.0.1';if(!fixture){let timer;const rows=await Promise.race([dns.lookup(url.hostname,{all:true,family:4,verbatim:true}),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(error('CONTENT_DOWNLOAD_DNS_TIMEOUT','DNS结果未知。')),10000);})]).finally(()=>clearTimeout(timer));if(!rows.length||rows.some(row=>!isPublicIPv4(row.address)))fail('CONTENT_DOWNLOAD_DNS_FORBIDDEN','域名解析含非公开地址或无受支持IPv4。');address=rows[0].address;}
   const entry={hop:redirects,host:url.hostname,urlSha256:createHash('sha256').update(url.href).digest('hex'),address,statusCode:null};trace.push(entry);
   const location=await new Promise((resolve,reject)=>{let finished=false;const finish=(failure,location=null)=>{if(finished)return;finished=true;clearTimeout(timer);failure?reject(failure):resolve(location);};
    const transport=fixture?http:https,request=transport.request(url,{method:'GET',agent:false,headers:{accept:'application/octet-stream',connection:'close'},lookup:(host,options,callback)=>callback(null,options?.all?[{address,family:4}]:address,options?.all?undefined:4),servername:url.hostname,rejectUnauthorized:true},response=>{
     entry.statusCode=response.statusCode;
     if(fresh&&[301,302,303,307,308].includes(response.statusCode)){const target=response.headers.location;response.destroy();if(typeof target!=='string'||!target.length||target.length>4096)finish(error('CONTENT_DOWNLOAD_REDIRECT_UNKNOWN','跳转缺少准确地址。'));else finish(null,target);return;}
     const length=response.headers['content-length'];if(response.statusCode!==200||length!==undefined&&(!/^\d+$/.test(length)||Number(length)>maxBytes)||!fresh&&Number(length)!==source.byteLength||response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();finish(error('CONTENT_DOWNLOAD_HTTP_UNKNOWN','来源状态、大小或编码不符。'));return;}
     response.on('data',bytes=>{try{count+=bytes.length;if(count>maxBytes)throw error('CONTENT_DOWNLOAD_SIZE_UNKNOWN','来源超过批准大小上限。');fs.writeSync(output,bytes);hash.update(bytes);}catch(failure){response.destroy();finish(failure);}});
     response.once('aborted',()=>finish(error('CONTENT_DOWNLOAD_PARTIAL_UNKNOWN','传输中断，保留部分文件。')));response.once('error',finish);response.once('end',()=>finish());
    });const timer=setTimeout(()=>{request.destroy();finish(error('CONTENT_DOWNLOAD_TIMEOUT_UNKNOWN','下载超时，保留未知。'));},15000);request.once('error',finish);request.end();
   });
   if(location===null)break;if(redirects>=source.maxRedirects)fail('CONTENT_DOWNLOAD_REDIRECT_LIMIT','超过准确批准跳数，停止不重试。');
   let next;try{next=new URL(location,url);}catch{fail('CONTENT_DOWNLOAD_REDIRECT_UNKNOWN','跳转地址无效。');}
   url=validateSourceUrl({...source,url:next.href,urlSha256:createHash('sha256').update(next.href).digest('hex')},{fixture});redirects++;
  }
  fs.fsyncSync(output);const digest=hash.digest('hex');if(count<1||!fresh&&(count!==source.byteLength||digest!==source.sha256))fail('CONTENT_DOWNLOAD_HASH_UNKNOWN','回收字节与原结果pin不符。');status='succeeded';return{mode:fresh?'fresh':'pinned',byteLength:count,sha256:digest,urlSha256:originalUrlSha256,finalUrlSha256:createHash('sha256').update(url.href).digest('hex'),redirectsFollowed:redirects,trace,authenticationCopied:false,originVerifiedAsPlatform:false};
 }finally{fs.closeSync(output);if(traceFile)fs.writeFileSync(traceFile,JSON.stringify({status,mode:fresh?'fresh':'pinned',bytesObserved:count,trace,automaticRetry:false},null,2),{flag:'wx'});}
}
