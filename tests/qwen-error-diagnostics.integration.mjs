import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {QwenMediaAdapter,QWEN_MODELS,QWEN_ORIGIN,makeTaskBinding} from '../bridge/src/qwen-media-adapter.mjs';
import {sanitizeErrorField,collectFailureDiagnostic,MAX_ERROR_FIELD_CHARS} from '../bridge/src/qwen-error-diagnostics.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const secret=['mock','Credential','ABC123xyz789','EndValue'].join('_');
const video=operationId=>({operationId,kind:'video',input:{prompt:'离线失败诊断测试'},parameters:{duration:4,resolution:'768P',ratio:'9:16',watermark:true}});
const speech=operationId=>({operationId,kind:'speech',input:{text:'你好。',voice_setting:{voice_id:'stock-fixture',speed:1,vol:1,pitch:0},audio_setting:{sample_rate:32000,bitrate:128000,format:'mp3',channel:1}},parameters:{output_format:'hex'}});
function fixture(t,credential=secret) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'qwen-diagnostics-test-')),taskId='offline-diagnostic-task',taskRoot=path.join(root,'task-workspaces',taskId);
 for(const area of ['inputs','work','outputs'])fs.mkdirSync(path.join(taskRoot,area),{recursive:true});
 const credentialFile=path.join(root,'credential.txt');fs.writeFileSync(credentialFile,credential);
 const bindingFile=path.join(taskRoot,'binding.json');fs.writeFileSync(bindingFile,JSON.stringify(makeTaskBinding(root,taskId)));
 const config={schema:'qwen_media_host_v1',origin:QWEN_ORIGIN,models:QWEN_MODELS,bindingFile,bindingSha256:digest(fs.readFileSync(bindingFile)),credentials:{video:{credentialFile},speech:{credentialFile}},generationBudget:{video:0,speech:0,voiceClone:0,voiceDesign:0},generationApprovals:{},readonly:{reviewedPlanSha256:null},stockVoiceIds:['stock-fixture']};
 const approve=request=>{config.generationBudget[request.kind]++;config.generationApprovals[request.operationId]={kind:request.kind,requestSha256:digest(JSON.stringify(request)),maxRequests:1,maxUnits:100,expiresAt:new Date(Date.now()+60000).toISOString()};};
 const diagnostic=result=>JSON.parse(fs.readFileSync(path.join(taskRoot,result.diagnostic.relativePath),'utf8'));
 t.after(()=>{assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert.ok(path.basename(root).startsWith('qwen-diagnostics-test-'));fs.rmSync(root,{recursive:true,force:true});});
 return {root,taskRoot,credentialFile,config,approve,diagnostic};
}
test('HTTP400说明单独归档，保留来源/原request_id，普通结果仅返回文件指针',async t=>{
 const f=fixture(t),request=speech('top-level-error');f.approve(request);
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:400,body:{request_id:'original-error-request',code:'InvalidParameter',message:'Selected voice is unavailable.',param:'input.voice_setting.voice_id',input:{text:'never-copy-input'},headers:{internal:'never-copy-header'},untrusted:'never-copy-extra'}})}).execute(request);
 assert.equal(result.status,'http_error');assert.equal(result.request_id,'original-error-request');assert.equal(result.code,'InvalidParameter');assert.equal(result.diagnostic.fieldsAvailable.message,true);
 assert.ok(result.diagnostic.relativePath.startsWith('work/qwen-media/operation-top-level-error/'));const file=path.join(f.taskRoot,result.diagnostic.relativePath);assert.equal(digest(fs.readFileSync(file)),result.diagnostic.sha256);
 const diagnostic=f.diagnostic(result);assert.equal(diagnostic.fields.message.value,'Selected voice is unavailable.');assert.equal(diagnostic.fields.message.source,'message');assert.equal(diagnostic.fields.param.value,'input.voice_setting.voice_id');assert.equal(diagnostic.request_id,'original-error-request');
 assert.ok(!JSON.stringify(result).includes('Selected voice'));assert.ok(!JSON.stringify(diagnostic).includes('never-copy-'));assert.equal(diagnostic.fullBodyOrHeadersOrInputPersisted,false);
});
test('Speech业务失败保留base_resp来源，原unknown状态/provider code不改变',async t=>{
 const f=fixture(t),request=speech('business-error');f.approve(request);
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:200,body:{request_id:'speech-business-request',output:{base_resp:{status_code:1004,status_msg:'Voice is not ready.'},data:null}}})}).execute(request);
 assert.equal(result.status,'unknown');assert.equal(result.code,'QWEN_SPEECH_RESULT_UNKNOWN');assert.equal(result.provider_code,1004);assert.equal(f.diagnostic(result).fields['output.base_resp.status_msg'].value,'Voice is not ready.');assert.equal(f.diagnostic(result).reason,'speech_business_failure');
});
test('H3 FAILED和UNKNOWN仅归档实际返回说明，原task/request字段不改变',async t=>{
 const f=fixture(t),request=video('native-failure');f.approve(request);let calls=0;
 const adapter=new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:200,body:{request_id:'original-native-request',output:{task_id:'original-native-task',task_status:++calls===1?'PENDING':calls===2?'FAILED':'UNKNOWN',code:calls===1?undefined:'InvalidParameter',message:calls===1?'do-not-archive-pending':'The requested product is not activated.'}}})});
 const submitted=await adapter.execute(request);assert.equal(submitted.diagnostic,undefined);
 const failed=await adapter.status(request.operationId,'failed-query');assert.equal(failed.status,'FAILED');assert.equal(failed.task_id,'original-native-task');assert.equal(f.diagnostic(failed).fields['output.message'].value,'The requested product is not activated.');
 const unknown=await adapter.status(request.operationId,'unknown-query');assert.equal(unknown.status,'UNKNOWN');assert.equal(f.diagnostic(unknown).fields['output.message'].source,'output.message');assert.equal(calls,3);
});
test('完整/编码凭据与伪造响应字段不泄露文件或普通结果',async t=>{
 const f=fixture(t),request=video('redacted-error');f.approve(request);
 const base64=Buffer.from(secret).toString('base64url'),url='https://cdn.example.invalid/media?Signature=synthetic-query';
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:400,body:{request_id:base64,code:secret,message:secret+' '+url,param:{nested:secret},output:{trace_id:secret,message:Buffer.from(secret).toString('base64')},headers:{Authorization:secret},input:{text:secret},diagnostic:{path:secret}}})}).execute(request);
 const text=JSON.stringify({result,diagnostic:f.diagnostic(result)});for(const forbidden of [secret,base64,url,'synthetic-query','Signature='])assert.ok(!text.includes(forbidden));assert.equal(result.request_id,null);assert.equal(result.trace_id,null);assert.equal(result.code,null);assert.equal(f.diagnostic(result).fields.param.state,'redacted');
});
test('明显编码、认证包装、敏感路径和控制字符在内存脱敏',()=>{
 const percent=[...Buffer.from(secret)].map(byte=>'%'+byte.toString(16).padStart(2,'0')).join('');
 const unicode=[...secret].map(char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const entities=[...secret].map(char=>'&#'+char.charCodeAt(0)+';').join('');
 const upperEntities=[...secret].map(char=>'&#X'+char.charCodeAt(0).toString(16)+';').join('');
 const windowsPath=String.fromCharCode(67,58,92)+['Users','synthetic','auth.json'].join(String.fromCharCode(92));
 const commonKey=['sk','synthetic'.repeat(5)].join('-');
 const values=[secret,Buffer.from(secret).toString('base64'),percent,unicode,entities,upperEntities,'Bearer '+secret,'Authorization: '+commonKey,'token='+commonKey,windowsPath,'/home/'+'synthetic/auth.json','bad\u0000'+secret,'bad\u202e'+secret,'https&colon;&sol;&sol;cdn.example.invalid/path','www.example.invalid/private','cdn.example.invalid/path?query=x'];
 for(const value of values){const field=sanitizeErrorField(value,secret);const output=JSON.stringify(field);assert.ok(!output.includes(secret));assert.ok(!output.includes(commonKey));assert.ok(!output.includes('cdn.example.invalid'));assert.ok(!output.includes('synthetic/auth.json'));assert.ok(!/[\u0000-\u001f\u202e]/.test(field.value??''));}
});
test('脱敏先于限长，截断不能输出半段凭据，超大字段整项拒绝',()=>{
 const prefix='safe word '.repeat(Math.floor(MAX_ERROR_FIELD_CHARS/10)-1),field=sanitizeErrorField(prefix+secret+' tail '.repeat(200),secret);
 assert.equal(field.truncated,true);assert.ok(field.value.length<=MAX_ERROR_FIELD_CHARS);assert.ok(!field.value.includes(secret.slice(0,8)));assert.ok(!field.value.includes(secret.slice(-8)));
 const tooLarge=sanitizeErrorField('safe '.repeat(15000)+secret,secret);assert.equal(tooLarge.value,null);assert.equal(tooLarge.state,'redacted');
});
test('缺失message保持null；类型伪造/getter及未知字段不复制也不执行',()=>{
 let invoked=0;const body={code:'InvalidParameter',param:{danger:'not-a-parameter'},irrelevant:{message:'never-copy'}};Object.defineProperty(body,'message',{get(){invoked++;return secret;}});
 const diagnostic=collectFailureDiagnostic({httpStatus:400,body},{token:secret,kind:'speech',phase:'execute'});assert.equal(invoked,0);assert.equal(diagnostic.fields.message.value,null);assert.equal(diagnostic.fields.message.state,'redacted');assert.equal(diagnostic.fields['output.message'].value,null);assert.equal(diagnostic.fields['output.message'].state,'missing');assert.ok(!JSON.stringify(diagnostic).includes('never-copy'));
});
test('没有详情时文件和可用标记保留缺失，不能补写解释',async t=>{
 const f=fixture(t),request=speech('missing-details');f.approve(request);const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:400,body:{request_id:'missing-message-request'}})}).execute(request);
 assert.equal(result.diagnostic.fieldsAvailable.message,false);assert.equal(f.diagnostic(result).fields.message.value,null);assert.equal(f.diagnostic(result).fields.message.state,'missing');
});
test('合法原生ID/模型/标准code只与凭据共享短片段时必须保留',async t=>{
 const credential=['dead','long_synthetic_credential_material','ends'].join('_'),f=fixture(t,credential),request=video('short-overlap');f.approve(request);const native=['deadbeef','bbbb','cccc','dddd','eeeefabcdef0'].join('-');
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:400,body:{request_id:native,code:'InvalidParameter',output:{task_id:native,model:'dead/model-other',message:'A real failure.'}}})}).execute(request);
 assert.equal(result.request_id,native);assert.equal(result.task_id,native);assert.equal(result.actualModelIdentity,'dead/model-other');assert.equal(result.provider_code,'InvalidParameter');
 const overlaps='InvalidParameter_but_full_credential_is_different';assert.equal(sanitizeErrorField('InvalidParameter',overlaps,{structured:true}).value,'InvalidParameter');
 const codeFixture=fixture(t,overlaps),codeRequest=video('code-short-overlap');codeFixture.approve(codeRequest);
 const codeResult=await new QwenMediaAdapter(codeFixture.config,{transport:async()=>({httpStatus:400,body:{request_id:'original-code-request',code:'InvalidParameter'}})}).execute(codeRequest);
 assert.equal(codeResult.code,'InvalidParameter');assert.equal(codeFixture.diagnostic(codeResult).fields.code.value,'InvalidParameter');
});
test('结构化code/id若为完整或明确编码凭据则拒绝，数字凭据也不回显',async t=>{
 const numeric=['12345678','90123456'].join(''),f=fixture(t,numeric),request=video('numeric-secret');f.approve(request);const encoded=Buffer.from(numeric).toString('base64url');
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>({httpStatus:400,body:{request_id:encoded,code:Number(numeric),message:'Invalid numeric code.'}})}).execute(request);
 assert.equal(result.request_id,null);assert.equal(result.code,null);assert.equal(f.diagnostic(result).fields.code.value,null);assert.ok(!JSON.stringify(result).includes(numeric));
 for(const encodedId of [Buffer.from(secret).toString('hex'),Buffer.from(JSON.stringify({token:secret})).toString('base64url')]) {
  const e=fixture(t),r=video('encoded-native-id');e.approve(r);const value=await new QwenMediaAdapter(e.config,{transport:async()=>({httpStatus:400,body:{request_id:encodedId,code:'InvalidParameter'}})}).execute(r);assert.equal(value.request_id,null);
 }
});
test('失败诊断保持原提交防重与预算，不会为取说明追加请求',async t=>{
 const f=fixture(t),request=speech('once-error');f.approve(request);let calls=0;const transport=async()=>{calls++;return {httpStatus:400,body:{request_id:'only-once-request',code:'InvalidParameter',message:'A stable diagnostic.'}};};
 const first=await new QwenMediaAdapter(f.config,{transport}).execute(request),file=path.join(f.taskRoot,first.diagnostic.relativePath),pin=digest(fs.readFileSync(file));
 assert.equal((await new QwenMediaAdapter(f.config,{transport}).execute(request)).deduplicated,true);assert.equal(calls,1);assert.equal(digest(fs.readFileSync(file)),pin);
 await assert.rejects(new QwenMediaAdapter(f.config,{transport}).execute(speech('unapproved-operation')),{code:'QWEN_GENERATION_APPROVAL_REQUIRED'});assert.equal(calls,1);
});
test('成功响应不归档自由文本，诊断目标被占用时不覆盖也不改变原HTTP状态',async t=>{
 const f=fixture(t),request=video('occupied-diagnostic');f.approve(request);
 const result=await new QwenMediaAdapter(f.config,{transport:async()=>{fs.mkdirSync(path.join(f.taskRoot,'work/qwen-media/operation-occupied-diagnostic/error-diagnostic.json'));return {httpStatus:400,body:{request_id:'occupied-file-request',message:'Must not overwrite.'}};}}).execute(request);
 assert.equal(result.status,'http_error');assert.equal(result.diagnostic.sha256,null);assert.equal(result.diagnostic.code,'QWEN_ERROR_DIAGNOSTIC_UNAVAILABLE');assert.equal(fs.statSync(path.join(f.taskRoot,'work/qwen-media/operation-occupied-diagnostic/error-diagnostic.json')).isDirectory(),true);
 assert.equal(collectFailureDiagnostic({httpStatus:200,body:{message:secret,output:{base_resp:{status_code:0}}}},{token:secret,kind:'speech',phase:'execute'}),null);
});
test('普通CLI仅打印诊断指针/摘要/可用性，合成HTTP400文本不进入stdout或stderr',t=>{
 const f=fixture(t),request=speech('cli-failure');f.approve(request);const configFile=path.join(f.root,'host.json');fs.writeFileSync(configFile,JSON.stringify(f.config));fs.writeFileSync(path.join(f.taskRoot,'inputs/request.json'),JSON.stringify(request));
 const fixtureFile=path.join(f.root,'offline-preload.mjs');
 fs.writeFileSync(fixtureFile,`import https from 'node:https';import dns from 'node:dns/promises';import {EventEmitter} from 'node:events';import net from 'node:net';
 net.createConnection=()=>{throw new Error('REAL_NETWORK_FORBIDDEN')};dns.lookup=async()=>[{address:'8.8.8.8',family:4}];
 https.request=(url,options,callback)=>{const call=new EventEmitter();call.destroy=()=>{};call.end=()=>queueMicrotask(()=>{const response=new EventEmitter();response.statusCode=400;response.headers={};response.destroy=()=>{};callback(response);const token=options.headers.authorization.slice(7);response.emit('data',Buffer.from(JSON.stringify({request_id:'cli-original-request',code:'InvalidParameter',message:'DO_NOT_PRINT_FREE_TEXT '+token+' https://cdn.example.invalid/a?Signature=cli-query'})));response.emit('end')});return call;};`);
 const cli=fileURLToPath(new URL('../bridge/scripts/qwen-media.mjs',import.meta.url)),call=spawnSync(process.execPath,['--import',pathToFileURL(fixtureFile).href,cli,'execute','--config',configFile,'--request','request.json'],{encoding:'utf8'});
 assert.equal(call.status,0);const output=JSON.parse(call.stdout);assert.equal(output.status,'http_error');assert.equal(output.request_id,'cli-original-request');assert.equal(typeof output.diagnostic.sha256,'string');
 for(const forbidden of [secret,'DO_NOT_PRINT_FREE_TEXT','Signature=','cli-query'])assert.ok(!(call.stdout+call.stderr).includes(forbidden));assert.equal(f.diagnostic(output).credentialOrHashPersisted,false);
});
