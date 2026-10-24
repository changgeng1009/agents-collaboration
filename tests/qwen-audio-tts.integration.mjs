import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {QwenMediaAdapter,QWEN_ORIGIN,QWEN_MODELS,makeTaskBinding,validateApiRequest} from '../bridge/src/qwen-media-adapter.mjs';
import {QWEN_AUDIO_TTS,inspectAudioTtsWav} from '../bridge/src/qwen-audio-tts.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const host='audio.example.invalid',token='opaque-offline-only-token',proxy={mode:'loopback-connect',host:'127.0.0.1',port:7890};
const signed=`https://${host}/sample.wav?Signature=synthetic-query`;
function wav() {
 const b=Buffer.alloc(52);b.write('RIFF');b.writeUInt32LE(44,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(24000,24);b.writeUInt32LE(48000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(8,40);return b;
}
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-audio-')),taskId='offline-audio',taskRoot=path.join(root,'task-workspaces',taskId);
 for(const area of ['inputs','work','outputs'])fs.mkdirSync(path.join(taskRoot,area),{recursive:true});
 const bindingFile=path.join(taskRoot,'binding.json');fs.writeFileSync(bindingFile,JSON.stringify(makeTaskBinding(root,taskId)));
 const config={schema:'qwen_media_host_v1',origin:QWEN_ORIGIN,models:QWEN_MODELS,bindingFile,bindingSha256:hash(fs.readFileSync(bindingFile)),qwenAudioTts:{enabled:true,model:QWEN_AUDIO_TTS.model,voice:QWEN_AUDIO_TTS.voice},credentials:{qwenAudioTts:{credentialFile:'offline-injected-slot'}},generationBudget:{speech:0,video:0,qwenAudioTts:0},generationApprovals:{},audioRecovery:{allowedHosts:[host],maxBytes:1024,timeoutMs:100,maxDownloads:1,proxy:{...proxy},approvals:{}}};
 let reads=0,calls=0;
 const response=()=>({httpStatus:200,body:{request_id:'native-audio-result',output:{finish_reason:'stop',audio:{data:'',url:signed,expires_at:Math.floor(Date.now()/1000)+3600}},usage:{input_tokens:9,output_tokens:15,total_tokens:24}}});
 const dependencies={credentialReader:()=>{reads++;return token;},transport:async()=>{calls++;return response();}};
 const adapter=overrides=>new QwenMediaAdapter(config,{...dependencies,...overrides});
 const request=(operationId='audio-once')=>{
  const body={model:QWEN_AUDIO_TTS.model,input:{text:'今天一起读一本书。',voice:QWEN_AUDIO_TTS.voice,instruction:'请自然、清楚地表达，不增加文字。',format:'wav',sample_rate:24000}},name=`body-${operationId}.json`,bytes=JSON.stringify(body);
  fs.writeFileSync(path.join(taskRoot,'inputs',name),bytes);return {operationId,kind:'speech',model:body.model,input:body.input,parameters:{},source:{area:'inputs',relativePath:name,sha256:hash(bytes)}};
 };
 const approve=request=>{config.generationBudget.qwenAudioTts++;const plan=adapter().planRequest(request);config.generationApprovals[request.operationId]={kind:'speech',model:QWEN_AUDIO_TTS.model,requestSha256:plan.requestSha256,reviewedPlanSha256:plan.planSha256,maxRequests:1,maxTextCodePoints:100,billingAcknowledged:true,expiresAt:new Date(Date.now()+60000).toISOString()};return plan;};
 const approveRecovery=request=>{const plan=adapter().audioRecoveryPlan(request);config.audioRecovery.approvals[request.recoveryId]={maxRequests:1,requestSha256:plan.requestSha256,urlSha256:plan.urlSha256,reviewedPlanSha256:plan.planSha256,expiresAt:new Date(Date.now()+60000).toISOString()};return plan;};
 t.mock.method(dns,'lookup',async()=>[{address:'8.8.8.8',family:4}]);t.mock.method(https,'request',()=>{throw new Error('native-network-forbidden');});
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,taskRoot,config,adapter,request,approve,approveRecovery,response,get reads(){return reads;},get calls(){return calls;}};
}
const recovery=source=>({recoveryId:'audio-download',source,outputName:'audio-download.wav'});
function downloadMock(t,{status=200,bytes=wav(),partial=false,hang=false,length=bytes.length}={}) {
 let calls=0;
 t.mock.method(https,'request',(url,options,callback)=>{
  calls++;assert.equal(url.protocol,'https:');assert.equal(url.hostname,host);assert.equal(options.method,'GET');assert.equal(options.rejectUnauthorized,true);assert.deepEqual(options.headers,{accept:'application/octet-stream',connection:'close'});assert.ok(options.agent);
  const req=new EventEmitter();req.destroy=()=>{};req.end=()=>{if(hang)return;queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=status;res.headers=status===302?{location:'https://other.example.invalid/redirect'}:length===null?{}:{'content-length':String(length)};res.destroy=()=>{};callback(res);res.emit('data',bytes);res.emit(partial?'aborted':'end');});};return req;
 });return {get calls(){return calls;}};
}
test('显式模型精确转发；纯规划绑定任务目录、源pin和指令，零凭据/网络/占位',t=>{
 const f=fixture(t),request=f.request(),plan=f.adapter().planRequest(request);
 assert.equal(plan.model,QWEN_AUDIO_TTS.model);assert.equal(plan.endpoint,QWEN_ORIGIN+QWEN_AUDIO_TTS.pathname);assert.deepEqual(plan.body,{model:request.model,input:request.input});assert.equal(plan.voice,QWEN_AUDIO_TTS.voice);assert.equal(plan.instructionSha256,hash(request.input.instruction));assert.equal(plan.textSha256,hash(request.input.text));assert.equal(plan.bindingSha256,f.config.bindingSha256);assert.equal(plan.taskRoot,f.taskRoot);assert.equal(plan.inputSource.sha256,request.source.sha256);assert.equal(plan.pricing.unit,'million-tokens');assert.equal(plan.pricing.hardCostLimitEnforced,false);
 assert.equal(f.adapter().preflight(request).credentialReads,0);assert.equal(f.reads,0);assert.equal(f.calls,0);assert.deepEqual(fs.readdirSync(path.join(f.taskRoot,'work/qwen-media')),[]);
 const changed=structuredClone(request);changed.input.instruction+='另加一句';assert.throws(()=>f.adapter().planRequest(changed),{code:'QWEN_AUDIO_TTS_SOURCE_CHANGED'});
});
test('未授权、旧审批/旧预算、错误字段/音色/模型和preview外壳均在凭据与网络前拒绝',async t=>{
 const f=fixture(t),request=f.request();await assert.rejects(f.adapter().execute(request),{code:'QWEN_GENERATION_APPROVAL_REQUIRED'});
 f.config.generationApprovals[request.operationId]={kind:'speech',requestSha256:hash(JSON.stringify(request)),maxRequests:1,maxUnits:100,expiresAt:new Date(Date.now()+60000).toISOString()};f.config.generationBudget.speech=100;
 await assert.rejects(f.adapter().execute(request),{code:'QWEN_AUDIO_TTS_REVIEW_REQUIRED'});
 for(const change of [r=>r.model='other-model',r=>r.input.voice='other-voice',r=>r.input.instructions='错误复数字段',r=>r.input.voice_setting={},r=>r.parameters.output_format='hex',r=>delete r.model,r=>r.source.relativePath='../other/body.json',r=>r.source.area='work']) {
  const bad=structuredClone(request);change(bad);await assert.rejects(f.adapter().execute(bad));
 }
 await assert.rejects(f.adapter().execute({previewOnly:true,executionAuthorized:false,requestPreview:{body:{model:request.model,input:request.input}}}));
 f.approve(request);f.config.generationBudget.qwenAudioTts=0;await assert.rejects(f.adapter().execute(request),{code:'QWEN_AUDIO_TTS_REVIEW_REQUIRED'});f.config.generationApprovals[request.operationId].reviewedPlanSha256=f.adapter().planRequest(request).planSha256;await assert.rejects(f.adapter().execute(request),{code:'QWEN_GENERATION_BUDGET_EXCEEDED'});assert.equal(f.reads,0);assert.equal(f.calls,0);
});
test('跨任务复制同源字节与审批仍失败；输入硬链接/路径联接也不放行',async t=>{
 const f=fixture(t),g=fixture(t),a=f.request(),b=g.request();f.approve(a);g.config.generationApprovals=structuredClone(f.config.generationApprovals);g.config.generationBudget.qwenAudioTts=1;
 assert.equal(hash(JSON.stringify(a)),hash(JSON.stringify(b)));await assert.rejects(g.adapter().execute(b),{code:'QWEN_AUDIO_TTS_REVIEW_REQUIRED'});assert.equal(g.reads,0);assert.equal(g.calls,0);
 const hard=path.join(f.root,'hard.json');fs.linkSync(path.join(f.taskRoot,'inputs',a.source.relativePath),hard);assert.throws(()=>f.adapter().planRequest(a),{code:'QWEN_FILE_INVALID'});fs.unlinkSync(hard);
 const original=path.join(f.taskRoot,'outputs'),moved=path.join(f.taskRoot,'outputs-held');fs.renameSync(original,moved);fs.symlinkSync(moved,original,'junction');assert.throws(()=>f.adapter().planRequest(a),{code:'QWEN_LINK_FORBIDDEN'});
});
test('审后更改API代理/凭据位置/回收策略/预算不能复用原生成批准',async t=>{
 for(const field of ['apiProxy','credential','host','maxBytes','timeout','downloads','downloadProxy','budget'])await t.test(field,async st=>{
  const f=fixture(st),request=f.request();f.approve(request);
  if(field==='apiProxy')f.config.network={proxy:{...proxy}};
  if(field==='credential')f.config.credentials.qwenAudioTts.credentialFile='other-offline-slot';
  if(field==='host')f.config.audioRecovery.allowedHosts.push('other.example.invalid');
  if(field==='maxBytes')f.config.audioRecovery.maxBytes++;
  if(field==='timeout')f.config.audioRecovery.timeoutMs++;
  if(field==='downloads')f.config.audioRecovery.maxDownloads++;
  if(field==='downloadProxy')delete f.config.audioRecovery.proxy;
  if(field==='budget')f.config.generationBudget.qwenAudioTts++;
  await assert.rejects(f.adapter().execute(request),{code:'QWEN_AUDIO_TTS_REVIEW_REQUIRED'});assert.equal(f.reads,0);assert.equal(f.calls,0);
 });
});
test('正式响应仅记实际usage/模型；生成回执与音频产物分层，签名URL仅存私有源',async t=>{
 const f=fixture(t),request=f.request();f.approve(request);const result=await f.adapter().execute(request);
 assert.equal(result.status,'generated');assert.equal(result.providerFinished,true);assert.equal(result.finish_reason,'stop');assert.equal(result.request_id,'native-audio-result');assert.equal(result.actualModelIdentity,null);assert.equal(result.actualModelIdentityVerified,false);assert.equal(result.modelExecutionVerified,false);assert.deepEqual(result.usage,{input_tokens:9,output_tokens:15,total_tokens:24});assert.deepEqual(fs.readdirSync(path.join(f.taskRoot,'outputs')),[]);assert.ok(!JSON.stringify(result).includes('Signature='));
 const raw=fs.readFileSync(path.join(f.taskRoot,'work',result.sourceContract.relativePath));assert.equal(hash(raw),result.sourceContract.sha256);assert.equal(JSON.parse(raw).url,signed);assert.equal(f.reads,1);assert.equal(f.calls,1);
 const receipt=fs.readFileSync(path.join(f.taskRoot,'work',result.rawReceipt.relativePath));assert.equal(hash(receipt),result.rawReceipt.sha256);assert.equal(JSON.parse(receipt).body.output.finish_reason,'stop');assert.ok(!receipt.toString().includes('Signature='));
});
test('null终态/无最终URL/错误码/另一模型均不伪造成成功，不自动fallback',async t=>{
 for(const variant of ['null','missing','error','model'])await t.test(variant,async st=>{
  const f=fixture(st),request=f.request();f.approve(request);let calls=0;
  const result=await f.adapter({transport:async()=>{calls++;const r=f.response();if(variant==='null')r.body.output.finish_reason=null;if(variant==='missing')delete r.body.output.audio.url;if(variant==='error')r.body.code='InvalidParameter';if(variant==='model')r.body.model='other/reported-model';return r;}}).execute(request);
  assert.equal(result.status,'unknown');assert.equal(result.modelExecutionVerified,false);assert.equal(result.sourceContract,undefined);assert.equal(result.actualModelIdentity,variant==='model'?'other/reported-model':null);assert.deepEqual(result.usage,{input_tokens:9,output_tokens:15,total_tokens:24});assert.equal(calls,1);assert.ok(result.rawReceipt);assert.ok(fs.existsSync(path.join(f.taskRoot,'work',result.rawReceipt.relativePath)));
 });
});
test('HTTP失败保留完整脱敏原生结构和pin，正文不流入共享result',async t=>{
 const f=fixture(t),request=f.request();f.approve(request);
 const result=await f.adapter({transport:async()=>({httpStatus:403,body:{request_id:'rejected-native',code:'AccessDenied',message:token,nested:{encoded:Buffer.from(token).toString('base64'),keep:'离线失败说明',Authorization:token},headers:{Authorization:token},unexpected:[{url:signed,flag:true}]}})}).execute(request);
 assert.equal(result.status,'http_error');assert.equal(result.request_id,'rejected-native');assert.ok(result.rawReceipt);
 const raw=fs.readFileSync(path.join(f.taskRoot,'work',result.rawReceipt.relativePath),'utf8'),saved=JSON.parse(raw);assert.equal(hash(raw),result.rawReceipt.sha256);assert.equal(saved.httpStatus,403);assert.equal(saved.body.nested.keep,'离线失败说明');assert.equal(saved.body.unexpected[0].flag,true);assert.equal(saved.body.headers,undefined);assert.equal(saved.body.nested.Authorization,undefined);assert.ok(!raw.includes(token));assert.ok(!raw.includes(Buffer.from(token).toString('base64')));assert.ok(!raw.includes('Signature='));assert.equal(result.nested,undefined);assert.ok(!JSON.stringify(result).includes(signed));
});
test('并发/重启/改operationId均持久去重，unknown仅POST一次且重复不读凭据',async t=>{
 const f=fixture(t),request=f.request();f.approve(request);let release,calls=0;const hold=new Promise(resolve=>{release=resolve;});
 const transport=async()=>{calls++;await hold;throw new Error('synthetic-unknown');},first=f.adapter({transport}).execute(request);
 assert.equal((await f.adapter({transport}).execute(request)).deduplicated,true);release();assert.equal((await first).status,'unknown');assert.equal((await f.adapter({transport}).execute(request)).deduplicated,true);
 const changed=f.request('renamed-operation');f.approve(changed);assert.equal((await f.adapter({transport}).execute(changed)).deduplicated,true);assert.equal(calls,1);assert.equal(f.reads,1);
});
test('原生HTTP入口只走准确端点/模型/单数instruction和固定CONNECT，不切旧路径',async t=>{
 const f=fixture(t),request=f.request();f.config.network={proxy:{...proxy}};f.approve(request);let calls=0;
 t.mock.method(https,'request',(url,options,callback)=>{calls++;assert.equal(url.href,QWEN_ORIGIN+QWEN_AUDIO_TTS.pathname);assert.equal(options.method,'POST');assert.equal(options.servername,new URL(QWEN_ORIGIN).hostname);assert.equal(options.rejectUnauthorized,true);assert.ok(options.agent);assert.equal(options.headers['X-DashScope-SSE'],undefined);
  const req=new EventEmitter();req.destroy=()=>{};req.end=body=>{const parsed=JSON.parse(body);assert.deepEqual(parsed,{model:request.model,input:request.input});assert.equal(parsed.input.instructions,undefined);queueMicrotask(()=>{const res=new EventEmitter();res.statusCode=200;res.headers={};res.destroy=()=>{};callback(res);res.emit('data',Buffer.from(JSON.stringify(f.response().body)));res.emit('end');});};return req;
 });
 const result=await new QwenMediaAdapter(f.config,{credentialReader:()=>token}).execute(request);assert.equal(result.status,'generated');assert.equal(calls,1);
 assert.throws(()=>validateApiRequest({method:'POST',url:QWEN_ORIGIN+'/api/v1/services/aigc/multimodal-generation/generation',body:{model:request.model,input:request.input}}),{code:'QWEN_ENDPOINT_FORBIDDEN'});
});
test('HTTPS白名单WAV回收复用代理、不带认证，落盘SHA成立但不冒充解码/听感验收',async t=>{
 const f=fixture(t),request=f.request();f.approve(request);const generated=await f.adapter().execute(request),download=recovery(generated.sourceContract);const plan=f.approveRecovery(download),http=downloadMock(t);
 assert.equal(plan.credentialReads,0);assert.equal(plan.generationRequests,0);assert.ok(!JSON.stringify(plan).includes('Signature='));const result=await f.adapter().recoverAudio(download);
 assert.equal(result.status,'succeeded');assert.equal(result.diskReadbackVerified,true);assert.equal(result.modelExecutionVerified,true);assert.equal(result.actualModelIdentity,null);assert.equal(result.technicalDecodeVerified,false);assert.equal(result.humanListeningVerified,false);assert.equal(result.businessCompletedVerified,false);assert.equal(result.audioMetadata.sampleRate,24000);assert.equal(result.output.sha256,hash(wav()));assert.deepEqual(fs.readFileSync(path.join(f.taskRoot,'outputs',download.outputName)),wav());assert.equal(http.calls,1);assert.equal(f.calls,1);assert.equal(f.reads,1);
 assert.equal((await f.adapter().recoverAudio(download)).deduplicated,true);const other={...download,recoveryId:'other-download',outputName:'other-download.wav'};f.approveRecovery(other);assert.equal((await f.adapter().recoverAudio(other)).deduplicated,true);assert.equal(http.calls,1);
});
test('HTTP样例/未知主机/过期URL保留生成回执且阻塞回收，不能因此重发TTS',async t=>{
 for(const variant of ['http','host','expired'])await t.test(variant,async st=>{
  const f=fixture(st),request=f.request();if(variant==='host')f.config.audioRecovery.allowedHosts=[];f.approve(request);let calls=0;
  const transport=async()=>{calls++;const r=f.response();if(variant==='http')r.body.output.audio.url=signed.replace('https:','http:');if(variant==='expired')r.body.output.audio.expires_at=1;return r;};
  const result=await f.adapter({transport}).execute(request);assert.equal(result.status,'generated');assert.equal(result.mediaRecovery.status,'blocked');assert.equal(result.modelExecutionVerified,false);assert.ok(result.sourceContract);await assert.rejects(f.adapter().recoverAudio(recovery(result.sourceContract)));assert.equal((await f.adapter({transport}).execute(request)).deduplicated,true);assert.equal(calls,1);
 });
});
test('下载跳转/部分/超限/超时/坏WAV只记unknown并保留证据，不重复下载或合成',async t=>{
 for(const variant of ['redirect','partial','size','timeout','wav'])await t.test(variant,async st=>{
  const f=fixture(st),request=f.request();if(variant==='timeout')f.config.audioRecovery.timeoutMs=20;f.approve(request);const generated=await f.adapter().execute(request),download=recovery(generated.sourceContract);f.approveRecovery(download);
  const http=downloadMock(st,variant==='redirect'?{status:302}:variant==='partial'?{bytes:wav().subarray(0,12),partial:true}:variant==='size'?{bytes:Buffer.alloc(2048),length:null}:variant==='timeout'?{hang:true}:{bytes:Buffer.from('not-a-wave')});
  const result=await f.adapter().recoverAudio(download);assert.equal(result.status,'unknown');assert.equal(result.providerFinished,true);assert.equal(result.modelExecutionVerified,false);assert.equal(result.partialFilePreserved,true);assert.equal((await f.adapter().recoverAudio(download)).deduplicated,true);assert.equal((await f.adapter().execute(request)).deduplicated,true);assert.equal(http.calls,1);assert.equal(f.calls,1);
  const expected={redirect:'CONTENT_DOWNLOAD_REDIRECT_LIMIT',partial:'CONTENT_DOWNLOAD_PARTIAL_UNKNOWN',size:'CONTENT_DOWNLOAD_SIZE_UNKNOWN',timeout:'CONTENT_DOWNLOAD_TIMEOUT_UNKNOWN'};
  if(variant==='wav')assert.equal(result.code,'QWEN_AUDIO_WAV_INVALID');else assert.equal(result.downloadCode,expected[variant]);
 });
});
test('回收缺审批/源pin变化/跨目录/恶意代理提前拒绝；直连假IP不连接',async t=>{
 const f=fixture(t),request=f.request();f.approve(request);const generated=await f.adapter().execute(request),download=recovery(generated.sourceContract),http=downloadMock(t);
 await assert.rejects(f.adapter().recoverAudio(download),{code:'QWEN_AUDIO_RECOVERY_REVIEW_REQUIRED'});assert.equal(http.calls,0);
 const changed=structuredClone(download);changed.source.sha256=hash('changed');await assert.rejects(f.adapter().recoverAudio(changed),{code:'QWEN_RECOVERY_SOURCE_CHANGED'});
 const outside=structuredClone(download);outside.source.relativePath='../outside.json';await assert.rejects(f.adapter().recoverAudio(outside),{code:'QWEN_PATH_INVALID'});
 f.config.audioRecovery.proxy.authorization='forbidden';assert.throws(()=>f.adapter().audioRecoveryPlan(download));delete f.config.audioRecovery.proxy.authorization;
 delete f.config.audioRecovery.proxy;f.approveRecovery(download);t.mock.method(dns,'lookup',async()=>[{address:'198.18.0.1',family:4}]);assert.equal((await f.adapter().recoverAudio(download)).downloadCode,'CONTENT_DOWNLOAD_DNS_FORBIDDEN');assert.equal(http.calls,0);assert.equal(f.calls,1);
});
test('回收审批同样绑定有效配置，审后切API代理即在下载前拒绝',async t=>{
 const f=fixture(t),request=f.request();f.approve(request);const generated=await f.adapter().execute(request),download=recovery(generated.sourceContract);f.approveRecovery(download);const http=downloadMock(t);f.config.network={proxy:{...proxy}};
 await assert.rejects(f.adapter().recoverAudio(download),{code:'QWEN_AUDIO_RECOVERY_REVIEW_REQUIRED'});assert.equal(http.calls,0);assert.equal(f.reads,1);assert.equal(f.calls,1);
});
test('无网络CLI plan可审查；预览文档和未授权execute不会成为授权',t=>{
 const f=fixture(t),request=f.request(),configFile=path.join(f.root,'host.json');fs.writeFileSync(configFile,JSON.stringify(f.config));fs.writeFileSync(path.join(f.taskRoot,'inputs','request.json'),JSON.stringify(request));fs.writeFileSync(path.join(f.taskRoot,'inputs','preview.json'),JSON.stringify({previewOnly:true,executionAuthorized:false,requestPreview:{body:{model:request.model,input:request.input}}}));
 const cli=fileURLToPath(new URL('../bridge/scripts/qwen-media.mjs',import.meta.url)),run=(command,name)=>spawnSync(process.execPath,[cli,command,'--config',configFile,'--request',name],{encoding:'utf8',timeout:10000});
 const planned=run('plan','request.json');assert.equal(planned.status,0,planned.stderr);assert.equal(JSON.parse(planned.stdout).credentialReads,0);assert.equal(JSON.parse(planned.stdout).networkRequests,0);assert.equal(JSON.parse(planned.stdout).model,QWEN_AUDIO_TTS.model);
 const denied=run('execute','request.json');assert.equal(denied.status,1);assert.equal(JSON.parse(denied.stderr).code,'QWEN_GENERATION_APPROVAL_REQUIRED');assert.equal(run('execute','preview.json').status,1);assert.deepEqual(fs.readdirSync(path.join(f.taskRoot,'work/qwen-media')),[]);
});
test('WAV只接受完整RIFF/正确采样率和块关系，不以扩展名验收',()=>{
 assert.equal(inspectAudioTtsWav(wav()).structuralReadbackVerified,true);
 for(const change of [b=>b.writeUInt32LE(999,4),b=>b.writeUInt32LE(16000,24),b=>b.writeUInt32LE(1024,40),b=>b.writeUInt16LE(3,32)]) {const b=wav();change(b);assert.throws(()=>inspectAudioTtsWav(b),{code:'QWEN_AUDIO_WAV_INVALID'});}
});
