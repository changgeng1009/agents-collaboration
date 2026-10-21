import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import {createLoopbackAgent,openLoopbackTls,validateLoopbackProxy} from '../bridge/src/qwen-loopback-connect.mjs';
import {nativeQwenTransport,QWEN_ORIGIN,QWEN_MODELS} from '../bridge/src/qwen-media-adapter.mjs';

const proxy={mode:'loopback-connect',host:'127.0.0.1',port:7890};
class Socket extends EventEmitter {destroyed=false;writes=[];write(value){this.writes.push(value);this.afterWrite?.();}destroy(){this.destroyed=true;}}
function mockSockets({response='HTTP/1.1 200 Connection established\r\n\r\n',authorized=true,tlsError=false,silent=false}={}) {
 const raw=new Socket(),secure=new Socket();secure.authorized=authorized;let tlsOptions=null,tcpCalls=0;
 const dependencies={connect:options=>{tcpCalls++;assert.deepEqual(options,{host:'127.0.0.1',port:7890});queueMicrotask(()=>raw.emit('connect'));return raw;},secureConnect:options=>{tlsOptions=options;queueMicrotask(()=>secure.emit(tlsError?'error':'secureConnect',new Error('fixture-certificate-error')));return secure;}};
 raw.afterWrite=()=>{if(!silent)queueMicrotask(()=>raw.emit('data',Buffer.from(response)));};
 return {raw,secure,dependencies,get tlsOptions(){return tlsOptions;},get tcpCalls(){return tcpCalls;}};
}
test('仅显式固定loopback CONNECT配置，拒绝任意代理、认证、DNS别名和额外字段',()=>{
 assert.deepEqual(validateLoopbackProxy(proxy),proxy);
 for(const invalid of [{...proxy,host:'localhost'},{...proxy,host:'10.0.0.1'},{...proxy,host:'other.invalid'},{...proxy,port:0},{...proxy,mode:'http'},{...proxy,username:'fixture'},{...proxy,url:'http://127.0.0.1:7890'}])assert.throws(()=>validateLoopbackProxy(invalid),{code:'QWEN_PROXY_CONFIG_FORBIDDEN'});
});
test('CONNECT明文只有精确maas:443，目标TLS证书与hostname校验保持开启',async()=>{
 const fixture=mockSockets();const socket=await openLoopbackTls(proxy,{timeoutMs:100},fixture.dependencies);
 assert.equal(socket,fixture.secure);assert.equal(fixture.tcpCalls,1);
 assert.equal(fixture.raw.writes.join(''),'CONNECT maas.qianwenaiapi.com:443 HTTP/1.1\r\nHost: maas.qianwenaiapi.com:443\r\nConnection: keep-alive\r\n\r\n');
 const options=fixture.tlsOptions;assert.equal(options.servername,'maas.qianwenaiapi.com');assert.equal(options.rejectUnauthorized,true);assert.equal(options.minVersion,'TLSv1.2');assert.deepEqual(options.ALPNProtocols,['http/1.1']);assert.equal(options.checkServerIdentity,tls.checkServerIdentity);
 assert.equal(options.checkServerIdentity('maas.qianwenaiapi.com',{subject:{CN:'other.invalid'},subjectaltname:'DNS:other.invalid'}).code,'ERR_TLS_CERT_ALTNAME_INVALID');
 assert.ok(!fixture.raw.writes.join('').includes('Authorization'));socket.destroy();
});
test('CONNECT认证挑战、重定向、额外正文与超大头停止，不建立TLS、不回退直连',async()=>{
 for(const response of ['HTTP/1.1 407 Proxy Authentication Required\r\n\r\n','HTTP/1.1 302 Found\r\nLocation: https://other.invalid\r\n\r\n','HTTP/1.1 200 OK\r\n\r\nextra','HTTP/1.1 200 OK\r\nX: '+ 'x'.repeat(8192)+'\r\n\r\n']) {
  const fixture=mockSockets({response});await assert.rejects(openLoopbackTls(proxy,{timeoutMs:100},fixture.dependencies));assert.equal(fixture.tlsOptions,null);assert.equal(fixture.tcpCalls,1);assert.equal(fixture.raw.destroyed,true);
 }
});
test('TLS未授权、握手错误或超时均关闭socket，且不放行HTTP认证头',async()=>{
 for(const settings of [{authorized:false},{tlsError:true},{silent:true}]) {
  const fixture=mockSockets(settings);await assert.rejects(openLoopbackTls(proxy,{timeoutMs:5},fixture.dependencies));assert.equal(fixture.raw.destroyed,true);assert.ok(!fixture.raw.writes.join('').includes('Bearer'));
 }
});
test('HTTPS agent只允许精确认证目标，不能把隧道用于别的host或port',async()=>{
 const fixture=mockSockets();const agent=createLoopbackAgent(proxy,{timeoutMs:100},fixture.dependencies);
 for(const options of [{host:'other.invalid',port:443},{host:'maas.qianwenaiapi.com',port:80},{host:'maas.qianwenaiapi.com',port:443,servername:'other.invalid'}]) {
  const failure=await new Promise(resolve=>agent.createConnection(options,error=>resolve(error)));assert.equal(failure.code,'QWEN_PROXY_TARGET_FORBIDDEN');
 }
 assert.equal(fixture.tcpCalls,0);const socket=await new Promise((resolve,reject)=>agent.createConnection({host:'maas.qianwenaiapi.com',port:443,servername:'maas.qianwenaiapi.com'},(failure,value)=>failure?reject(failure):resolve(value)));assert.equal(socket,fixture.secure);socket.destroy();agent.destroy();
});
test('未配置proxy时，fake-IP依然触发原公开IPv4守卫，禁止构造API请求',async t=>{
 let calls=0;t.mock.method(dns,'lookup',async()=>[{address:'198.18.0.210',family:4}]);t.mock.method(https,'request',()=>{calls++;throw new Error('must-not-connect');});
 await assert.rejects(nativeQwenTransport({method:'GET',url:QWEN_ORIGIN+'/api/v1/tasks/native-task',token:'opaque-fixture-only',timeoutMs:100,maxBodyBytes:1000}),{code:'QWEN_DNS_FORBIDDEN'});assert.equal(calls,0);
});
test('显式proxy原生传输采用受限agent，保持认证origin且不走目标直连DNS',async t=>{
 let observed=null,dnsCalls=0;t.mock.method(dns,'lookup',async()=>{dnsCalls++;throw new Error('direct-dns-must-not-run');});
 t.mock.method(https,'request',(url,options,callback)=>{
  observed={url,options};const request=new EventEmitter();request.destroy=()=>{};
  request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=200;response.headers={};response.destroy=()=>{};callback(response);response.emit('data',Buffer.from(JSON.stringify({request_id:'native-fixture-request',output:{task_id:'native-fixture-task',task_status:'PENDING'}})));response.emit('end');});return request;
 });
 const result=await nativeQwenTransport({method:'POST',url:QWEN_ORIGIN+'/api/v1/services/aigc/video-generation/video-synthesis',body:{model:QWEN_MODELS.video},token:'opaque-fixture-token',proxy,async:true,timeoutMs:100,maxBodyBytes:1000});
 assert.equal(dnsCalls,0);assert.equal(observed.url.origin,QWEN_ORIGIN);assert.equal(observed.options.servername,'maas.qianwenaiapi.com');assert.equal(observed.options.rejectUnauthorized,true);assert.equal(typeof observed.options.agent.createConnection,'function');assert.equal(observed.options.headers['Proxy-Authorization'],undefined);assert.equal(result.body.request_id,'native-fixture-request');
});
test('代理路径收到API重定向也不跟随、不重试',async t=>{
 let calls=0;t.mock.method(https,'request',(url,options,callback)=>{calls++;const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=307;response.headers={location:'https://other.invalid'};response.destroy=()=>{};callback(response);});return request;});
 await assert.rejects(nativeQwenTransport({method:'GET',url:QWEN_ORIGIN+'/api/v1/tasks/native-task',token:'opaque-fixture-token',proxy,timeoutMs:100,maxBodyBytes:1000}),{code:'QWEN_REDIRECT_FORBIDDEN'});assert.equal(calls,1);
});
test('原生request错误只保留明确的代理安全码，不回显异常正文',async t=>{
 t.mock.method(https,'request',()=>{const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>request.emit('error',Object.assign(new Error('fixture-private-error-message'),{code:'QWEN_PROXY_CONNECT_REJECTED'})));return request;});
 await assert.rejects(nativeQwenTransport({method:'GET',url:QWEN_ORIGIN+'/api/v1/tasks/native-task',token:'opaque-fixture-token',proxy,timeoutMs:100,maxBodyBytes:1000}),failure=>failure.code==='QWEN_PROXY_CONNECT_REJECTED' && !failure.message.includes('fixture-private'));
});
test('未知或伪造的代理错误码归为unknown，不泄露上游异常信息',async t=>{
 t.mock.method(https,'request',()=>{const request=new EventEmitter();request.destroy=()=>{};request.end=()=>queueMicrotask(()=>request.emit('error',Object.assign(new Error('private-url-and-token'),{code:'QWEN_PROXY_UNREVIEWED_PAYLOAD'})));return request;});
 await assert.rejects(nativeQwenTransport({method:'GET',url:QWEN_ORIGIN+'/api/v1/tasks/native-task',token:'opaque-fixture-token',proxy,timeoutMs:100,maxBodyBytes:1000}),failure=>failure.code==='QWEN_NETWORK_UNKNOWN' && !failure.message.includes('private-url'));
});
