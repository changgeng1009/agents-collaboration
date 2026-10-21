import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {QwenMediaAdapter,QWEN_MODELS,QWEN_ORIGIN,makeTaskBinding,readCredential,readonlyPlanSha256,validateApiRequest} from '../bridge/src/qwen-media-adapter.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const secret='opaque-offline-fixture-token-for-unit-tests';
const signed='https://media.example.invalid/movie.mp4?Signature=signed-fixture-private-query';
const video=operationId=>({operationId,kind:'video',input:{prompt:'离线接口契约测试'},parameters:{duration:4,resolution:'768P',ratio:'9:16',watermark:true}});
const speech=operationId=>({operationId,kind:'speech',input:{text:'你好。',voice_setting:{voice_id:'stock-fixture',speed:1,vol:1,pitch:0},audio_setting:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1}},parameters:{output_format:'hex'}});
function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-media-test-')),taskId='offline-task',taskRoot=path.join(root,'task-workspaces',taskId);
 for(const area of ['inputs','work','outputs'])fs.mkdirSync(path.join(taskRoot,area),{recursive:true});
 const credentialFile=path.join(root,'credential.txt');fs.writeFileSync(credentialFile,secret);
 const bindingFile=path.join(taskRoot,'binding.json');fs.writeFileSync(bindingFile,JSON.stringify(makeTaskBinding(root,taskId)));
 const config={schema:'qwen_media_host_v1',origin:QWEN_ORIGIN,models:QWEN_MODELS,bindingFile,bindingSha256:hash(fs.readFileSync(bindingFile)),credentials:{video:{credentialFile},speech:{credentialFile}},generationBudget:{video:0,speech:0,voiceClone:0,voiceDesign:0},generationApprovals:{},readonly:{reviewedPlanSha256:null},stockVoiceIds:['stock-fixture'],inputMediaHosts:[],recovery:{allowedHosts:[],maxBytes:1048576}};
 const approve=request=>{config.generationBudget[request.kind]++;config.generationApprovals[request.operationId]={kind:request.kind,requestSha256:hash(JSON.stringify(request)),maxRequests:1,maxUnits:100,expiresAt:new Date(Date.now()+60000).toISOString()};};
 const readAll=()=>{const pieces=[];const visit=dir=>{for(const item of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())visit(file);else pieces.push(fs.readFileSync(file).toString());}};visit(path.join(taskRoot,'work'));return pieces.join('\n');};
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,taskRoot,credentialFile,bindingFile,config,approve,readAll};
}
test('opaque凭据按整行格式核对，不要求sk前缀、不修剪标签、不回显',t=>{
 const f=fixture(t);assert.equal(readCredential(f.credentialFile),secret);
 for(const invalid of ['Bearer '+secret,'label='+secret,' '+secret,secret+'\nextra',secret+'\n\n','https://example.invalid/'+secret,'"'+secret+'"']) {
  fs.writeFileSync(f.credentialFile,invalid);assert.throws(()=>readCredential(f.credentialFile),failure=>failure.code==='QWEN_CREDENTIAL_FORMAT_INVALID' && !failure.message.includes(secret));
 }
 fs.writeFileSync(f.credentialFile,secret+'\r\n');assert.equal(readCredential(f.credentialFile),secret);
 fs.writeFileSync(f.credentialFile,'\ufeff'+secret+'\n');assert.equal(readCredential(f.credentialFile),secret);
});
test('离线前检为零网络；未授权生成与只读请求均被拒绝',async t=>{
 const f=fixture(t);let calls=0;const adapter=new QwenMediaAdapter(f.config,{transport:async()=>{calls++;throw new Error();}});
 assert.equal(adapter.preflight(video('unapproved')).networkRequests,0);
 await assert.rejects(adapter.execute(video('unapproved')),{code:'QWEN_GENERATION_APPROVAL_REQUIRED'});
 await assert.rejects(adapter.readonlyAuth('video','unapproved'),{code:'QWEN_READONLY_REVIEW_REQUIRED'});assert.equal(calls,0);
});
test('仅固定maas媒体契约和原生Task GET；禁用models、直连厂商、重定向目的地',()=>{
 for(const url of ['https://dashscope.aliyuncs.com/api/v1/tasks/task','https://api.minimax.io/v1/video_generation','https://maas.qianwenaiapi.com/compatible-mode/v1/models','http://maas.qianwenaiapi.com/api/v1/tasks/task','https://maas.qianwenaiapi.com/api/v1/tasks/task?key=bad','https://user@maas.qianwenaiapi.com/api/v1/tasks/task'])assert.throws(()=>validateApiRequest({method:'GET',url}),{code:'QWEN_ENDPOINT_FORBIDDEN'});
});
test('H3提交与查询两步保留原始ID、同一端点；签名URL不写日志',async t=>{
 const f=fixture(t),request=video('video-once');f.approve(request);const calls=[];
 const transport=async req=>{calls.push(req);return req.method==='POST'?{httpStatus:200,body:{request_id:'original-submit-id',output:{task_id:'original-native-task',task_status:'PENDING'}}}:{httpStatus:200,body:{request_id:'original-query-id',output:{task_id:'original-native-task',task_status:'SUCCEEDED',video_url:signed}}};};
 const adapter=new QwenMediaAdapter(f.config,{transport}),submitted=await adapter.execute(request);
 assert.equal(submitted.task_id,'original-native-task');assert.equal(submitted.request_id,'original-submit-id');assert.equal(calls[0].async,true);assert.equal(calls[0].body.model,QWEN_MODELS.video);
 const queried=await adapter.status(request.operationId,'query-once');assert.equal(queried.task_id,'original-native-task');assert.equal(queried.request_id,'original-query-id');assert.equal(queried.mediaRecoveryPending,true);assert.equal(queried.businessCompletedVerified,false);
 assert.equal(calls[1].url,QWEN_ORIGIN+'/api/v1/tasks/original-native-task');assert.ok(!f.readAll().includes('Signature='));assert.ok(!f.readAll().includes(secret));
});
test('Speech按正式input voice/audio/output_format与output.data.audio解析hex',async t=>{
 const f=fixture(t),request=speech('speech-once');f.approve(request);let observed;
 const bytes=Buffer.from('ID3offline-fixture-audio');
 const adapter=new QwenMediaAdapter(f.config,{transport:async req=>{observed=req;return {httpStatus:200,body:{request_id:'speech-original-id',output:{base_resp:{status_code:0,status_msg:'success'},data:{status:2,audio:bytes.toString('hex')},extra_info:{audio_size:bytes.length}}}};}});
 const result=await adapter.execute(request);assert.equal(result.status,'succeeded');assert.equal(result.request_id,'speech-original-id');assert.equal(result.requestedModel,QWEN_MODELS.speech);assert.equal(result.actualModelIdentity,null);assert.equal(result.trace_id,null);assert.equal(observed.body.input.output_format,'hex');assert.equal(observed.body.input.voice_setting.voice_id,'stock-fixture');assert.equal(observed.body.parameters,undefined);
 assert.deepEqual(fs.readFileSync(path.join(f.taskRoot,'outputs',result.output.relativePath)),bytes);assert.equal(result.technicalDecodeVerified,false);assert.equal(result.humanListeningVerified,false);
});
test('并发与新实例恢复均只提交一次，unknown不重POST',async t=>{
 const f=fixture(t),request=video('unknown-once');f.approve(request);let calls=0,release;
 const hold=new Promise(resolve=>{release=resolve;});const transport=async()=>{calls++;await hold;throw new Error(secret+' '+signed);};
 const first=new QwenMediaAdapter(f.config,{transport}).execute(request);
 const second=await new QwenMediaAdapter(f.config,{transport}).execute(request);assert.equal(second.deduplicated,true);release();assert.equal((await first).status,'unknown');
 const restarted=await new QwenMediaAdapter(f.config,{transport}).execute(request);assert.equal(restarted.deduplicated,true);assert.equal(calls,1);assert.ok(!f.readAll().includes(secret));assert.ok(!f.readAll().includes('Signature='));
});
test('不同operation并发也不能突破持久全局budget',async t=>{
 const f=fixture(t),a=video('budget-a'),b=video('budget-b');b.input.prompt+='另一个内容';f.approve(a);f.approve(b);f.config.generationBudget.video=1;let calls=0;
 const transport=async()=>{calls++;return {httpStatus:200,body:{request_id:'request-budget',output:{task_id:'task-budget',task_status:'PENDING'}}};};
 const result=await Promise.allSettled([new QwenMediaAdapter(f.config,{transport}).execute(a),new QwenMediaAdapter(f.config,{transport}).execute(b)]);assert.equal(calls,1);assert.equal(result.filter(x=>x.status==='rejected' && x.reason.code==='QWEN_GENERATION_BUDGET_EXCEEDED').length,1);
});
test('同一provider payload更换operationId及JSON字段顺序仍不得重复提交',async t=>{
 const f=fixture(t),a=video('same-payload-a'),b=video('same-payload-b');b.parameters={watermark:true,ratio:'9:16',resolution:'768P',duration:4};f.approve(a);f.approve(b);let calls=0;
 const transport=async()=>{calls++;throw new Error('unknown');};
 assert.equal((await new QwenMediaAdapter(f.config,{transport}).execute(a)).status,'unknown');
 assert.equal((await new QwenMediaAdapter(f.config,{transport}).execute(b)).deduplicated,true);assert.equal(calls,1);
});
test('provider hostname回显凭据停止，原生trace保留，requestedModel不冒充actualModelIdentity',async t=>{
 const f=fixture(t),v=video('secret-host');f.approve(v);let calls=0;
 const adapter=new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:200,body:{request_id:'native-original-request',output:++calls===1?{task_id:'native-original-task',task_status:'PENDING',trace_id:'native-submit-trace'}:{task_id:'native-original-task',task_status:'SUCCEEDED',trace_id:'native-query-trace',video_url:`https://${secret}.example.invalid/movie.mp4`}}})});
 const submitted=await adapter.execute(v);assert.equal(submitted.requestedModel,QWEN_MODELS.video);assert.equal(submitted.actualModelIdentity,null);assert.equal(submitted.trace_id,'native-submit-trace');
 const queried=await adapter.status(v.operationId,'secret-host-query');assert.equal(queried.status,'unknown');assert.equal(queried.code,'QWEN_RESPONSE_SECRET_REJECTED');assert.equal(queried.trace_id,'native-query-trace');assert.ok(!f.readAll().includes(secret));
});
test('上游明确回传另一型号则停止，保留脱敏原值与native ID，不写成品',async t=>{
 const f=fixture(t),s=speech('wrong-speech');f.approve(s);
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:200,body:{model:'other/reported-speech',request_id:'wrong-model-request',output:{trace_id:'original-speech-trace',base_resp:{status_code:0},data:{status:2,audio:Buffer.from('ID3fixture').toString('hex')}}}})}).execute(s);
 assert.equal(result.status,'unknown');assert.equal(result.code,'QWEN_MODEL_MISMATCH');assert.equal(result.actualModelIdentity,'other/reported-speech');assert.equal(result.modelExecutionVerified,false);assert.equal(result.trace_id,'original-speech-trace');assert.deepEqual(fs.readdirSync(path.join(f.taskRoot,'outputs')),[]);
 const v=video('wrong-video');f.approve(v);const wrong=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:200,body:{model:'other/reported-video',output:{task_id:'retained-native-task',task_status:'PENDING'}}})}).execute(v);assert.equal(wrong.task_id,'retained-native-task');assert.equal(wrong.status,'unknown');
});
test('宿主已由manager消费只读预算后，本入口拒绝重复请求',async t=>{
 const f=fixture(t);f.config.readonly.externalCompletedSlots=['video','speech'];let calls=0;
 await assert.rejects(new QwenMediaAdapter(f.config,{transport:async()=>{calls++;}}).readonlyAuth('video','unused'),{code:'QWEN_READONLY_ALREADY_CONSUMED'});assert.equal(calls,0);
});
test('已有OS worker持久意图时不得降级到普通宿主文件路径',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.taskRoot,'.os-worker'));assert.throws(()=>new QwenMediaAdapter(f.config),{code:'QWEN_OS_BACKEND_REQUIRED'});
});
test('HTTP重定向不跟随，不把凭据转交另一主机；恶意错误字段脱敏',async t=>{
 const f=fixture(t),a=video('redirect-once');f.approve(a);let calls=0;
 const adapter=new QwenMediaAdapter(f.config,{transport:async()=>{calls++;return {httpStatus:307,body:{location:'https://other.invalid/'+secret}};}});
 assert.equal((await adapter.execute(a)).code,'QWEN_REDIRECT_FORBIDDEN');assert.equal(calls,1);assert.ok(!f.readAll().includes(secret));
 const b=video('malicious-error');b.input.prompt+='不同副作用';f.approve(b);
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:401,body:{request_id:secret,code:secret,message:secret+' '+signed}})}).execute(b);
 assert.equal(result.request_id,null);assert.equal(result.code,null);assert.ok(!f.readAll().includes(secret));assert.ok(!f.readAll().includes('Signature='));
});
test('只读单次预算持久化，只保存白名单字段，不保存真实任务正文',async t=>{
 const f=fixture(t);const plan=new QwenMediaAdapter(f.config).readonlyPlan();const sha=readonlyPlanSha256(plan);f.config.readonly.reviewedPlanSha256=sha;let calls=0;
 const adapter=new QwenMediaAdapter(f.config,{transport:async req=>{calls++;assert.equal(req.method,'GET');assert.equal(req.maxBodyBytes,1048576);return {httpStatus:200,body:{request_id:'readonly-native-id',output:{tasks:[{prompt:'private-task-body',url:signed}]}}};}});
 const result=await adapter.readonlyAuth('video',sha);assert.equal(result.authenticationAccepted,true);assert.equal(result.modelAccessVerified,false);assert.equal(result.returnedCount,1);
 await new QwenMediaAdapter(f.config,{transport:async()=>{calls++;}}).readonlyAuth('video',sha);assert.equal(calls,1);assert.ok(!f.readAll().includes('private-task-body'));
});
test('symlink目录、硬链接凭据、输入路径穿越、目录替换均被阻止',async t=>{
 const f=fixture(t),adapter=new QwenMediaAdapter(f.config);assert.throws(()=>adapter.readRequest('../escape.json'),{code:'QWEN_PATH_INVALID'});
 const hard=path.join(f.root,'hard.txt');fs.linkSync(f.credentialFile,hard);assert.throws(()=>readCredential(hard),{code:'QWEN_CREDENTIAL_UNREADABLE'});fs.unlinkSync(hard);
 const out=path.join(f.taskRoot,'outputs'),old=path.join(f.taskRoot,'outputs-old');fs.renameSync(out,old);fs.symlinkSync(old,out,process.platform==='win32'?'junction':'dir');assert.throws(()=>adapter.preflight(),{code:'QWEN_LINK_FORBIDDEN'});fs.unlinkSync(out);fs.mkdirSync(out);assert.throws(()=>adapter.preflight(),{code:'QWEN_BINDING_CHANGED'});
});
test('原生查询task_id不匹配或未知Speech结果不得伪造成功',async t=>{
 const f=fixture(t),v=video('native-binding');f.approve(v);let count=0;
 const adapter=new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:200,body:{request_id:'native-request',output:{task_id:++count===1?'native-task':'different-task',task_status:'PENDING'}}})});
 await adapter.execute(v);assert.equal((await adapter.status(v.operationId,'bad-query')).status,'unknown');
 const s=speech('bad-audio');f.approve(s);const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:200,body:{request_id:'speech-error',output:{base_resp:{status_code:1004},data:null}}})}).execute(s);assert.equal(result.status,'unknown');assert.equal(result.modelExecutionVerified,false);
});
test('独立CLI跨进程执行离线前检，缺审批时拒绝实际POST',t=>{
 const f=fixture(t),config=path.join(f.root,'host.json');fs.writeFileSync(config,JSON.stringify(f.config));fs.writeFileSync(path.join(f.taskRoot,'inputs','request.json'),JSON.stringify(video('cli-unapproved')));
 const cli=fileURLToPath(new URL('../bridge/scripts/qwen-media.mjs',import.meta.url));
 const preflight=spawnSync(process.execPath,[cli,'preflight','--config',config,'--request','request.json'],{encoding:'utf8'});assert.equal(preflight.status,0);assert.equal(JSON.parse(preflight.stdout).networkRequests,0);
 const execute=spawnSync(process.execPath,[cli,'execute','--config',config,'--request','request.json'],{encoding:'utf8'});assert.equal(execute.status,1);assert.equal(JSON.parse(execute.stderr).code,'QWEN_GENERATION_APPROVAL_REQUIRED');assert.ok(!execute.stderr.includes(secret));
});
