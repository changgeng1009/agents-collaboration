import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import {createHash} from 'node:crypto';
import {createDownloadProxyAgent,openDownloadTls,validateDownloadProxy} from '../bridge/src/content-download-proxy.mjs';
import {downloadPinnedSource} from '../bridge/src/content-download.mjs';

const proxy={mode:'loopback-connect',host:'127.0.0.1',port:7890},host='cdn.example.invalid',hash=b=>createHash('sha256').update(b).digest('hex');
const bytes=Buffer.from('offline-bounded-download'),url=`https://${host}/movie.mp4?Signature=private-fixture`;
class Socket extends EventEmitter {writes=[];destroyed=false;write(value){this.writes.push(value);this.afterWrite?.();}destroy(){this.destroyed=true;}}
function sockets({response='HTTP/1.1 200 OK\r\n\r\n',authorized=true,silent=false,tlsError=false}={}) {
 const raw=new Socket(),secure=new Socket();secure.authorized=authorized;let options=null,calls=0;
 const dependencies={connect:observed=>{calls++;assert.deepEqual(observed,{host:'127.0.0.1',port:7890});queueMicrotask(()=>raw.emit('connect'));return raw;},secureConnect:observed=>{options=observed;queueMicrotask(()=>secure.emit(tlsError?'error':'secureConnect',new Error('private-fixture-error')));return secure;}};
 raw.afterWrite=()=>{if(!silent)queueMicrotask(()=>raw.emit('data',Buffer.from(response)));};return {raw,secure,dependencies,get options(){return options;},get calls(){return calls;}};
}
function output(t) {const root=fs.mkdtempSync(path.join(os.tmpdir(),'cdn-proxy-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return path.join(root,'media.bin');}
function mockHttp(t,{status=200,headers={'content-length':String(bytes.length)},chunks=[bytes],partial=false,silent=false}={}) {
 let calls=0,observed;t.mock.method(dns,'lookup',async()=>{throw new Error('proxy-must-not-use-direct-dns');});
 t.mock.method(https,'request',(target,options,callback)=>{calls++;observed={target,options};const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{if(silent)return;const res=new EventEmitter();res.statusCode=status;res.headers=headers;res.destroy=()=>{};callback(res);for(const chunk of chunks)res.emit('data',chunk);res.emit(partial?'aborted':'end');});return req;});
 return {get calls(){return calls;},get observed(){return observed;}};
}
const source=()=>({url,urlSha256:hash(url),allowedHosts:[host],mode:'fresh',maxBytes:1024,maxRedirects:0});
test('下载代理只接受显式无认证loopback配置，拒绝目标IP和注入host',async()=>{
 assert.deepEqual(validateDownloadProxy(proxy),proxy);
 for(const item of [{...proxy,host:'localhost'},{...proxy,host:'8.8.8.8'},{...proxy,authorization:'secret'},{...proxy,port:0}])assert.throws(()=>validateDownloadProxy(item));
 for(const target of ['127.0.0.1','localhost','cdn.example.invalid\r\nAuthorization: secret','https://cdn.example.invalid'])await assert.rejects(async()=>openDownloadTls(proxy,target));
});
test('CONNECT只发准确CDN host，无签名query/认证；TLS保持hostname/证书验证',async()=>{
 const f=sockets();await openDownloadTls(proxy,host,{timeoutMs:100},f.dependencies);
 assert.equal(f.raw.writes.join(''),`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nConnection: keep-alive\r\n\r\n`);
 assert.equal(f.options.servername,host);assert.equal(f.options.rejectUnauthorized,true);assert.equal(f.options.checkServerIdentity,tls.checkServerIdentity);assert.equal(f.options.minVersion,'TLSv1.2');assert.equal(f.calls,1);
 assert.equal(f.options.checkServerIdentity(host,{subjectaltname:'DNS:other.invalid'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');f.secure.destroy();
});
test('CONNECT挑战/跳转/额外正文/超大头均不建TLS，不回退重试',async()=>{
 for(const response of ['HTTP/1.1 407 Auth\r\n\r\n','HTTP/1.1 302 Found\r\n\r\n','HTTP/1.1 200 OK\r\n\r\nextra','HTTP/1.1 200 OK\r\nX: '+'x'.repeat(8192)+'\r\n\r\n']) {
  const f=sockets({response});await assert.rejects(openDownloadTls(proxy,host,{timeoutMs:100},f.dependencies));assert.equal(f.options,null);assert.equal(f.raw.destroyed,true);assert.equal(f.calls,1);
 }
});
test('TLS不可信/错误/超时和abort销毁隧道',async()=>{
 for(const settings of [{authorized:false},{tlsError:true},{silent:true}]){const f=sockets(settings);await assert.rejects(openDownloadTls(proxy,host,{timeoutMs:5},f.dependencies));assert.equal(f.raw.destroyed,true);}
 const f=sockets({silent:true}),controller=new AbortController(),pending=openDownloadTls(proxy,host,{signal:controller.signal},f.dependencies);controller.abort();await assert.rejects(pending,{code:'CONTENT_DOWNLOAD_PROXY_ABORTED'});assert.equal(f.raw.destroyed,true);
});
test('agent固定目标和SNI，destroy取消尚在CONNECT的请求',async()=>{
 const f=sockets({silent:true}),agent=createDownloadProxyAgent(proxy,host,{},f.dependencies);
 for(const options of [{host:'other.invalid',port:443,servername:host},{host,port:80,servername:host},{host,port:443,servername:'other.invalid'}])assert.equal((await new Promise(resolve=>agent.createConnection(options,resolve))).code,'CONTENT_DOWNLOAD_PROXY_TARGET_FORBIDDEN');
 assert.equal(f.calls,0);const pending=new Promise(resolve=>agent.createConnection({host,port:443,servername:host},resolve));agent.destroy();assert.equal((await pending).code,'CONTENT_DOWNLOAD_PROXY_ABORTED');assert.equal(f.raw.destroyed,true);
});
test('默认直连fake-IP仍拒绝，未构造HTTP',async t=>{
 let calls=0;t.mock.method(dns,'lookup',async()=>[{address:'198.18.0.223',family:4}]);t.mock.method(https,'request',()=>{calls++;throw new Error();});await assert.rejects(downloadPinnedSource(source(),output(t)),{code:'CONTENT_DOWNLOAD_DNS_FORBIDDEN'});assert.equal(calls,0);
});
test('显式代理下载只发GET固定头，无直连DNS；wx和落盘SHA准确',async t=>{
 const file=output(t),f=mockHttp(t),result=await downloadPinnedSource(source(),file,{proxy,timeoutMs:100});assert.equal(f.calls,1);assert.equal(result.sha256,hash(fs.readFileSync(file)));assert.equal(result.diskReadbackVerified,true);assert.equal(result.byteLength,bytes.length);assert.equal(result.trace[0].address,null);assert.equal(result.trace[0].remotePublicAddressVerified,false);
 assert.deepEqual(f.observed.options.headers,{accept:'application/octet-stream',connection:'close'});assert.equal(f.observed.options.method,'GET');assert.equal(f.observed.options.servername,host);assert.equal(f.observed.options.rejectUnauthorized,true);assert.equal(typeof f.observed.options.agent.createConnection,'function');assert.equal(f.observed.options.lookup,undefined);
 await assert.rejects(downloadPinnedSource(source(),file,{proxy,timeoutMs:100}),{code:'EEXIST'});assert.equal(f.calls,1);
});
test('proxy要求准确URL摘要和零跳转策略，在HTTP前拒绝',async t=>{
 const f=mockHttp(t);await assert.rejects(downloadPinnedSource({...source(),urlSha256:hash('other')},output(t),{proxy}),{code:'CONTENT_DOWNLOAD_FRESH_POLICY_REQUIRED'});await assert.rejects(downloadPinnedSource({...source(),maxRedirects:1},output(t),{proxy}),{code:'CONTENT_DOWNLOAD_PROXY_POLICY_REQUIRED'});assert.equal(f.calls,0);
});
test('HTTP跳转/编码/大小不符/部分传输/超时停止，各只一次且保留文件',async t=>{
 for(const options of [{status:302,headers:{location:'https://other.invalid/a'}},{headers:{'content-encoding':'gzip'}},{headers:{'content-length':'99999'}},{partial:true},{silent:true}]) {
  const sub=await t.test(JSON.stringify(options),async st=>{const file=output(st),f=mockHttp(st,options);await assert.rejects(downloadPinnedSource(source(),file,{proxy,timeoutMs:10}));assert.equal(f.calls,1);assert.equal(fs.existsSync(file),true);});void sub;
 }
});
test('独立落盘读回识别写后篡改，不能仅用输入流SHA冒充',async t=>{
 const file=output(t);mockHttp(t);const sync=fs.fsyncSync;t.mock.method(fs,'fsyncSync',fd=>{sync(fd);fs.writeFileSync(file,Buffer.alloc(bytes.length,88));});await assert.rejects(downloadPinnedSource(source(),file,{proxy,timeoutMs:100}),{code:'CONTENT_DOWNLOAD_HASH_UNKNOWN'});
});
