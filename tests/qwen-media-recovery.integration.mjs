import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {QwenMediaAdapter,QWEN_ORIGIN,QWEN_MODELS,makeTaskBinding} from '../bridge/src/qwen-media-adapter.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex'),host='cdn.example.invalid',proxy={mode:'loopback-connect',host:'127.0.0.1',port:7890};
const media=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom-offline-fixture')]);
const signed=()=>`https://${host}/movie.mp4?Signature=private-fixture&Expires=${Math.floor(Date.now()/1000)+3600}`;
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-recovery-')),taskId='offline-new',taskRoot=path.join(root,'task-workspaces',taskId);
 for(const area of ['inputs','work','outputs'])fs.mkdirSync(path.join(taskRoot,area),{recursive:true});
 const bindingFile=path.join(taskRoot,'binding.json');fs.writeFileSync(bindingFile,JSON.stringify(makeTaskBinding(root,taskId)));
 const config={schema:'qwen_media_host_v1',origin:QWEN_ORIGIN,models:QWEN_MODELS,bindingFile,bindingSha256:hash(fs.readFileSync(bindingFile)),generationBudget:{video:0,speech:0,voiceClone:0,voiceDesign:0},generationApprovals:{},recovery:{allowedHosts:[host],maxBytes:1024,timeoutMs:100,proxy:{...proxy},maxDownloads:1,approvals:{},sourceImports:[]}};
 t.mock.method(dns,'lookup',async()=>{throw new Error('must-not-use-direct-dns');});t.mock.method(https,'request',()=>{throw new Error('unplanned-native-request');});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,taskId,taskRoot,config};
}
function imported(f,{url=signed(),recoveryId='recover-once',nativeTask='native-fixture'}={}) {
 const source={schema:'private_h3_native_source_v1',taskId:'old-success',operationId:'old-operation',task_id:nativeTask,url,hostname:host,apiAuthenticationAllowedForDownload:false};
 const name=`source-${recoveryId}.json`,raw=JSON.stringify(source);fs.writeFileSync(path.join(f.taskRoot,'inputs',name),raw);
 const request={recoveryId,source:{area:'inputs',relativePath:name,sha256:hash(raw)},outputName:`${recoveryId}.mp4`};
 f.config.recovery.sourceImports.push({sha256:hash(raw),taskId:source.taskId,operationId:source.operationId,task_id:nativeTask,urlSha256:hash(url),hostname:host,expectedSha256:hash(media),expectedBytes:media.length});approve(f,request,url);return {source,raw,request};
}
function approve(f,request,url) {f.config.recovery.approvals[request.recoveryId]={requestSha256:hash(JSON.stringify(request)),urlSha256:hash(url),hostname:host,maxRequests:1,expiresAt:new Date(Date.now()+60000).toISOString()};}
function httpMock(t,{status=200,chunks=[media],partial=false,hold=null}={}) {
 let calls=0;t.mock.method(https,'request',(url,options,callback)=>{calls++;assert.equal(options.method,'GET');assert.deepEqual(options.headers,{accept:'application/octet-stream',connection:'close'});const req=new EventEmitter();req.destroy=()=>{};
  req.end=()=>queueMicrotask(async()=>{if(hold)await hold;const res=new EventEmitter();res.statusCode=status;res.headers=status===302?{location:'https://other.invalid/a'}:{'content-length':String(media.length)};res.destroy=()=>{};callback(res);for(const b of chunks)res.emit('data',b);res.emit(partial?'aborted':'end');});return req;
 });return {get calls(){return calls;}};
}
function adapter(f,transport=async()=>{throw new Error('recover-must-not-call-platform');}) {return new QwenMediaAdapter(f.config,{transport});}
function native(f,{automatic=false}={}) {
 const secret='opaque-offline-fixture-token',credentialFile=path.join(f.root,'credential.txt');fs.writeFileSync(credentialFile,secret);f.config.credentials={video:{credentialFile}};
 const request={operationId:'native-operation',kind:'video',input:{prompt:'离线回收测试'},parameters:{duration:4,resolution:'768P',ratio:'9:16',watermark:true}},url=signed();
 f.config.generationBudget.video=1;f.config.generationApprovals[request.operationId]={kind:'video',requestSha256:hash(JSON.stringify(request)),maxUnits:4,maxRequests:1,expiresAt:new Date(Date.now()+60000).toISOString()};
 if(automatic){fs.writeFileSync(path.join(f.taskRoot,'inputs','auto.json'),JSON.stringify({recoveryId:'automatic-once',outputName:'automatic-once.mp4'}));f.config.recovery.automaticRequests={'query-once':'auto.json'};f.config.recovery.approvals['automatic-once']={automaticQueryId:'query-once',operationId:'native-operation',nativeTaskId:'native-fixture',hostname:host,maxRequests:1,expiresAt:new Date(Date.now()+60000).toISOString()};}
 let calls=0;const transport=async req=>{calls++;return req.method==='POST'?{httpStatus:200,body:{output:{task_id:'native-fixture',task_status:'PENDING'}}}:{httpStatus:200,body:{request_id:'native-request',output:{task_id:'native-fixture',task_status:'SUCCEEDED',video_url:url}}};};
 return {request,url,transport,credentialFile,get calls(){return calls;}};
}
test('无凭据纯回收计划零网络，精确导入pin与模型预算分列',t=>{
 const f=fixture(t),i=imported(f),plan=adapter(f).recoveryPlan(i.request);assert.equal(plan.networkRequests,0);assert.equal(plan.credentialReads,0);assert.equal(plan.platformRequests,0);assert.equal(plan.sourceTrust,'host-pinned-import');assert.equal(plan.providerTaskStatus,'SUCCEEDED');assert.equal(plan.linkExpiryKnown,true);assert.ok(!JSON.stringify(plan).includes('Signature='));assert.equal(f.config.generationBudget.video,0);
 f.config.recovery.maxDownloads=0;assert.equal(adapter(f).recoveryPlan(i.request).downloadEnabled,false);
});
test('纯回收精确旧源，平台调用0，落盘pin/独立receipt可读，不含签名URL',async t=>{
 const f=fixture(t),i=imported(f),http=httpMock(t);let calls=0;const result=await adapter(f,async()=>{calls++;throw new Error();}).recover(i.request);assert.equal(result.status,'succeeded');assert.equal(calls,0);assert.equal(http.calls,1);assert.equal(result.credentialReads,0);assert.equal(result.diskReadbackVerified,true);assert.equal(result.providerTaskStatus,'SUCCEEDED');assert.equal(result.technicalDecodeVerified,false);
 assert.equal(hash(fs.readFileSync(path.join(f.taskRoot,'outputs',i.request.outputName))),hash(media));assert.equal(fs.readFileSync(path.join(f.taskRoot,'inputs',i.request.source.relativePath),'utf8'),i.raw);
 const receipt=fs.readFileSync(path.join(f.taskRoot,'work/qwen-media/recovery-recover-once/result.json'),'utf8'),trace=fs.readFileSync(path.join(f.taskRoot,'work/qwen-media/recovery-recover-once/download-trace.json'),'utf8');assert.equal(JSON.parse(receipt).status,'succeeded');assert.ok(!receipt.includes('Signature='));assert.ok(!trace.includes('Signature='));assert.equal(JSON.parse(trace).trace[0].networkMode,'loopback-connect');
});
test('并发/重启/更换回收ID及签名URL仍按同原生task去重',async t=>{
 const f=fixture(t),i=imported(f);let release;const hold=new Promise(resolve=>{release=resolve;}),http=httpMock(t,{hold}),first=adapter(f).recover(i.request);
 assert.equal((await adapter(f).recover(i.request)).deduplicated,true);release();assert.equal((await first).status,'succeeded');assert.equal((await adapter(f).recover(i.request)).deduplicated,true);
 const changed=imported(f,{recoveryId:'another-name',url:signed()+'&Refreshed=fixture'});assert.equal((await adapter(f).recover(changed.request)).deduplicated,true);assert.equal(http.calls,1);
});
test('unknown保留部分文件和持久占位，换ID也不重试',async t=>{
 const f=fixture(t),i=imported(f),http=httpMock(t,{chunks:[media.subarray(0,8)],partial:true}),result=await adapter(f).recover(i.request);assert.equal(result.status,'unknown');assert.equal(result.providerTaskStatus,'SUCCEEDED');assert.equal(result.partialFilePreserved,true);assert.equal(fs.statSync(path.join(f.taskRoot,'outputs',i.request.outputName)).size,8);
 assert.equal((await adapter(f).recover(i.request)).deduplicated,true);const changed=imported(f,{recoveryId:'new-name'});assert.equal((await adapter(f).recover(changed.request)).deduplicated,true);assert.equal(http.calls,1);
});
test('零预算、审批/host/源pin/原task/媒体pin不符和过期源均在GET前停止',async t=>{
 for(const kind of ['zero','request','host','source','native','media','expired','path','proxy'])await t.test(kind,async st=>{
  const f=fixture(st),i=imported(f,{url:kind==='expired'?`https://${host}/movie.mp4?Expires=1`:signed()}),http=httpMock(st);
  if(kind==='zero')f.config.recovery.maxDownloads=0;
  if(kind==='request')f.config.recovery.approvals[i.request.recoveryId].requestSha256=hash('wrong');
  if(kind==='host')f.config.recovery.allowedHosts=['other.invalid'];
  if(kind==='source')fs.appendFileSync(path.join(f.taskRoot,'inputs',i.request.source.relativePath),' ');
  if(kind==='native')f.config.recovery.sourceImports[0].task_id='other-task';
  if(kind==='media')f.config.recovery.sourceImports[0].expectedBytes=2048;
  if(kind==='path')i.request.source.relativePath='../outside.json';
  if(kind==='proxy')f.config.recovery.proxy.authorization='forbidden';
  await assert.rejects(adapter(f).recover(i.request));assert.equal(http.calls,0);assert.equal(fs.existsSync(path.join(f.taskRoot,'outputs',i.request.outputName)),false);
 });
});
test('全局下载预算跨不同原生task持久限制，不随重启补额度',async t=>{
 const f=fixture(t),i=imported(f),http=httpMock(t);assert.equal((await adapter(f).recover(i.request)).status,'succeeded');const j=imported(f,{recoveryId:'second-task',nativeTask:'native-second'});await assert.rejects(adapter(f).recover(j.request),{code:'QWEN_RECOVERY_BUDGET_EXCEEDED'});assert.equal(http.calls,1);
});
test('status成功持久化私有源，随后独立recover无需凭据或再次查平台',async t=>{
 const f=fixture(t),n=native(f),a=adapter(f,n.transport);await a.execute(n.request);const status=await a.status('native-operation','query-once');assert.equal(status.status,'SUCCEEDED');assert.equal(status.sourceContract.area,'work');assert.equal(n.calls,2);assert.ok(!JSON.stringify(status).includes('Signature='));
 const raw=fs.readFileSync(path.join(f.taskRoot,'work',status.sourceContract.relativePath));assert.equal(hash(raw),status.sourceContract.sha256);assert.equal(JSON.parse(raw).url,n.url);
 fs.unlinkSync(n.credentialFile);delete f.config.credentials;f.config.generationBudget.video=0;
 const request={recoveryId:'native-recover',source:status.sourceContract,outputName:'native-recover.mp4'};approve(f,request,n.url);const http=httpMock(t),result=await adapter(f).recover(request);assert.equal(result.status,'succeeded');assert.equal(result.sourceTrust,'persisted-native-result');assert.equal(n.calls,2);assert.equal(http.calls,1);
});
test('status --recover自动入口共用代理下载与持久receipt，保持native SUCCEEDED',async t=>{
 const f=fixture(t),n=native(f,{automatic:true}),http=httpMock(t),a=adapter(f,n.transport);await a.execute(n.request);const result=await a.status('native-operation','query-once',{recover:true});assert.equal(result.status,'SUCCEEDED');assert.equal(result.mediaRecovery.status,'succeeded');assert.equal(result.mediaRecoveryPending,false);assert.equal(http.calls,1);assert.equal(n.calls,2);
 const dir=path.join(f.taskRoot,'work/qwen-media/query-query-once');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'result.json'))).status,'SUCCEEDED');assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'recovery-link.json'))).status,'succeeded');assert.equal(JSON.parse(fs.readFileSync(path.join(f.taskRoot,'work/qwen-media/recovery-automatic-once/result.json'))).status,'succeeded');
});
test('自动回收失败/缺审批不改native成功，不隐藏为unknown，不额外查task',async t=>{
 for(const fail of ['http','approval'])await t.test(fail,async st=>{
  const f=fixture(st),n=native(f,{automatic:true}),http=httpMock(st,{status:302});if(fail==='approval')f.config.recovery.approvals={};const a=adapter(f,n.transport);await a.execute(n.request);const result=await a.status('native-operation','query-once',{recover:true});assert.equal(result.status,'SUCCEEDED');assert.equal(result.providerTaskSucceeded,true);assert.equal(result.mediaRecovery.status,fail==='http'?'unknown':'blocked');assert.equal(n.calls,2);assert.equal(http.calls,fail==='http'?1:0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.taskRoot,'work/qwen-media/query-query-once/result.json'))).status,'SUCCEEDED');
 });
});
test('私有源保存失败只阻塞媒体，不把已成功模型改为unknown',async t=>{
 const f=fixture(t),n=native(f);const transport=async req=>{const response=await n.transport(req);if(req.method==='GET')response.body.output.video_url='http://127.0.0.1/private';return response;};const a=adapter(f,transport);await a.execute(n.request);const result=await a.status('native-operation','query-once');assert.equal(result.status,'SUCCEEDED');assert.equal(result.mediaRecovery.status,'blocked');assert.equal(result.providerTaskSucceeded,true);
});
test('伪造本任务合同缺原native证据时停止，不以JSON标签代替原任务证明',async t=>{
 const f=fixture(t),n=native(f),a=adapter(f,n.transport);await a.execute(n.request);const status=await a.status('native-operation','query-once'),request={recoveryId:'proof-check',source:status.sourceContract,outputName:'proof-check.mp4'};approve(f,request,n.url);fs.writeFileSync(path.join(f.taskRoot,'work/qwen-media/query-query-once/result.json'),'{}');await assert.rejects(adapter(f).recover(request),{code:'QWEN_RECOVERY_NATIVE_PROOF_REQUIRED'});
});
