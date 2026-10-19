import {FIXTURE_ROOT} from './test-context.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {sha256} from '../bridge/src/policy.mjs';
import {preparedRootIdentity} from '../bridge/src/collaboration-workspaces.mjs';
import {createMarketReviewFrameBroker} from '../bridge/src/market-review-frame-broker.mjs';
import {assessMarketReviewEvidence,assertMarketReviewRunAllowed} from '../bridge/src/market-review-evidence.mjs';
import {evaluateMarketReviewPretool,inspectMarketPretoolOutcomes} from '../bridge/src/market-pretool-policy.mjs';

const checks=[];
const check=async(name,fn)=>{await fn();checks.push({name,passed:true});};
const original={requestId:'synthetic_original',sessionId:'synthetic_session',intent:'creative_generation',status:'unknown',intentSha256:'a'.repeat(64)};
const plan={original,modelId:'synthetic_fixed_model',groupId:'synthetic_group',taskId:'synthetic_review',instanceId:'synthetic_member',requiredSkills:['humanizer']};
// 合成1×1 RGB PNG，非真实素材；CRC和像素构造独立于broker。
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}
function chunk(name,data){const type=Buffer.from(name),result=Buffer.alloc(12+data.length);result.writeUInt32BE(data.length);type.copy(result,4);data.copy(result,8);result.writeUInt32BE(crc(Buffer.concat([type,data])),8+data.length);return result;}
const header=Buffer.from([0,0,0,1,0,0,0,1,8,2,0,0,0]);
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))]);
let sequence=0;
function fixture(count=5,extra={}){
 const root=path.join(FIXTURE_ROOT,'task-workspaces',`review_${sequence++}`,'frames');fs.mkdirSync(root,{recursive:true});
 const frames=Array.from({length:count},(_,index)=>{const frameId=`frame-${index+1}`,relativePath=`${frameId}.png`;fs.writeFileSync(path.join(root,relativePath),png);return{frameId,relativePath,sha256:sha256(png),byteLength:png.length,width:1,height:1,pts:{numerator:index,denominator:1}};});
 const value={root,rootIdentity:preparedRootIdentity(root),member:{instanceId:'synthetic_member',groupId:'synthetic_group',taskId:'synthetic_review'},source:{artifactId:'synthetic_artifact',sourceResultId:'synthetic_result',sha256:'b'.repeat(64),byteLength:100},frames,maxReads:5,totalByteLimit:3*1024*1024,...extra};
 return{value,context:{...value.member,artifactId:value.source.artifactId}};
}
try{
 await check('原unknown与创作意图保留，新评审和全true声明不能取得运行许可',()=>{
  const claims={taskId:'new_task',requestId:'new_request',sessionId:'new_session',modelId:plan.modelId,intent:'existing_video_review',approved:true,verified:true,resolution:true,expertLoaded:true,skillLoaded:true,mediaRead:true,round:1};
  const before=JSON.stringify(plan),result=assessMarketReviewEvidence(plan,claims);
  assert.equal(result.state,'preview_only');assert.equal(result.launchAllowed,false);assert.equal(result.originalUnknownResolved,false);assert.equal(result.original.intent,'creative_generation');assert.equal(result.intentConflict,true);
  assert.equal(result.loading.actualExpertLoaded,'unknown');assert.equal(result.loading.actualRequiredSkillsLoaded,'unknown');assert.equal(result.media.actualModelImagesRead,'unknown');assert.equal(result.claimsTrusted,false);assert.equal(JSON.stringify(plan),before);
  assert.throws(()=>assertMarketReviewRunAllowed(result),error=>error.code==='MARKET_REVIEW_OFFLINE_ONLY');
 });
 await check('模拟Hook风险与Read/Skill及未知入口不能生成权限',()=>{
  const allow={exitCode:0,output:{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}};
  for(const sample of [[],[{...allow,error:true}],[{...allow,timedOut:true}],[{...allow,cancelled:true}],[{...allow,exitCode:2}],[{...allow,output:'invalid-json'}],[{...allow,output:{async:true}}],[{exitCode:0,output:{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny'}}},allow]]){
   const observed=inspectMarketPretoolOutcomes('command',sample);assert.equal(observed.candidateMatch,false);assert.equal(observed.launchAllowed,false);
  }
  assert.equal(inspectMarketPretoolOutcomes('command',[allow]).candidateMatch,true);
  assert.equal(inspectMarketPretoolOutcomes('mods',[allow]).candidateMatch,false);
  assert.equal(inspectMarketPretoolOutcomes('sdk',[{output:{allow:true}}]).candidateMatch,false);
  for(const name of ['Read','Skill','Agent','mcp__other__read','DeferExecuteTool','REPL'])assert.equal(evaluateMarketReviewPretool(name,{},{}).decision,'rejected');
 });
 await check('限定五帧返回typed ImageContent，重复和第六次读取拒绝，外部修改plan不能扩大范围',()=>{
  const {value,context}=fixture(),broker=createMarketReviewFrameBroker(value);value.frames.push({...value.frames[0],frameId:'injected'});value.member.instanceId='injected';
  const first=broker.read({frameId:'frame-1'},context);assert.equal(first.content[0].type,'image');assert.equal(first.content[0].mimeType,'image/png');assert.deepEqual(Buffer.from(first.content[0].data,'base64'),png);assert.equal(first.structuredContent.source.artifactId,'synthetic_artifact');assert.equal(first.structuredContent.actualModelReadVerified,false);assert.equal(first.structuredContent.osIsolationVerified,false);assert.equal(first.structuredContent.launchAllowed,false);
  assert.throws(()=>broker.read({frameId:'frame-1'},context),error=>error.code==='REVIEW_FRAME_ALREADY_READ');
  assert.throws(()=>broker.read({frameId:'injected'},context));
  for(let n=2;n<=5;n++)broker.read({frameId:`frame-${n}`},context);
  assert.throws(()=>broker.read({frameId:'frame-1'},context));assert.equal(broker.status().reads,5);assert.equal(broker.status().bytesReturned,png.length*5);
 });
 await check('PNG签名以外还拒绝CRC损坏与像素流尺寸矛盾，即使声明SHA一致',()=>{
  for(const broken of [Buffer.from(png),Buffer.concat([png.subarray(0,33),chunk('IDAT',deflateSync(Buffer.from([0]))),chunk('IEND',Buffer.alloc(0))])]){
   if(broken.equals(png))broken[broken.length-1]^=1;
   const {value}=fixture(1);fs.writeFileSync(path.join(value.root,value.frames[0].relativePath),broken);value.frames[0].sha256=sha256(broken);value.frames[0].byteLength=broken.length;
   assert.throws(()=>createMarketReviewFrameBroker(value),error=>error.code==='REVIEW_PNG_INVALID');
  }
 });
 await check('路径/角色/来源/ACL输入不能扩大范围，跨成员任务或artifact均在读取前拒绝',()=>{
  const {value,context}=fixture(1),broker=createMarketReviewFrameBroker(value);
  for(const key of ['path','root','actor','ACL','sourceId','manifest','approved','verified'])assert.throws(()=>broker.read({frameId:'frame-1',[key]:'forged'},context),error=>error.code==='MARKET_REVIEW_ARGUMENT_INVALID');
  for(const key of ['instanceId','groupId','taskId','artifactId'])assert.throws(()=>broker.read({frameId:'frame-1'},{...context,[key]:'other'}),error=>error.code==='MARKET_REVIEW_SCOPE_MISMATCH');
  for(const frameId of ['../frame-1','FRAME-1','frame-1:stream',path.sep.repeat(2)+'other','frame-6'])assert.throws(()=>broker.read({frameId},context),error=>error.code==='MARKET_REVIEW_FRAME_FORBIDDEN');
  assert.equal(broker.status().reads,0);assert.equal(broker.status().bytesReturned,0);
 });
 await check('可信计划仍拒绝目录别名、大小写混淆、ADS、超大文件及第六帧',()=>{
  const {value}=fixture(1);
  for(const relativePath of ['../frame-1.png','FRAME-1.png','frame-1.png:stream',path.sep.repeat(2)+'other.png'])assert.throws(()=>createMarketReviewFrameBroker({...value,frames:[{...value.frames[0],relativePath}]}));
  assert.throws(()=>createMarketReviewFrameBroker({...value,frames:Array.from({length:6},(_,index)=>({...value.frames[0],frameId:`extra-${index}`}))}),error=>error.code==='REVIEW_PLAN_INVALID');
  for(const byteLength of [0,512*1024+1])assert.throws(()=>createMarketReviewFrameBroker({...value,frames:[{...value.frames[0],byteLength}]}));
  assert.throws(()=>createMarketReviewFrameBroker({...value,totalByteLimit:3*1024*1024+1}),error=>error.code==='REVIEW_PLAN_INVALID');
  assert.throws(()=>createMarketReviewFrameBroker({...value,frames:[{...value.frames[0],width:2}]}),error=>error.code==='REVIEW_FRAME_PIN_MISMATCH');
  assert.throws(()=>createMarketReviewFrameBroker({...value,frames:[{...value.frames[0],sha256:'c'.repeat(64)}]}),error=>error.code==='REVIEW_FRAME_PIN_MISMATCH');
 });
 await check('准备后内容变化或文件替换拒绝，保留失败并阻止后续重试',()=>{
  for(const replace of [false,true]){
   const {value,context}=fixture(1),broker=createMarketReviewFrameBroker(value),file=path.join(value.root,value.frames[0].relativePath);
   if(replace)fs.renameSync(file,`${file}.original`);
   const changed=Buffer.from(png);changed[changed.length-1]^=1;fs.writeFileSync(file,changed);
   assert.throws(()=>broker.read({frameId:'frame-1'},context));assert.equal(broker.status().blocked,true);assert.equal(broker.status().bytesReturned,0);
   assert.throws(()=>broker.read({frameId:'frame-1'},context),error=>error.code==='REVIEW_BROKER_BLOCKED');
  }
 });
 await check('硬链接与父目录替换/联接拒绝，不回退其他目录或OS worker',()=>{
  const hard=fixture(1),hardBroker=createMarketReviewFrameBroker(hard.value),file=path.join(hard.value.root,hard.value.frames[0].relativePath);
  fs.linkSync(file,`${file}.link`);assert.throws(()=>hardBroker.read({frameId:'frame-1'},hard.context),error=>error.code==='REVIEW_FILE_IDENTITY');
  const replaced=fixture(1),broker=createMarketReviewFrameBroker(replaced.value),old=`${replaced.value.root}_original`;fs.renameSync(replaced.value.root,old);fs.mkdirSync(replaced.value.root);fs.writeFileSync(path.join(replaced.value.root,'frame-1.png'),png);
  assert.throws(()=>broker.read({frameId:'frame-1'},replaced.context),error=>error.code==='REVIEW_DIRECTORY_CHANGED');
  const linked=fixture(1),linkedBroker=createMarketReviewFrameBroker(linked.value),prior=`${linked.value.root}_original`;fs.renameSync(linked.value.root,prior);fs.symlinkSync(prior,linked.value.root,process.platform==='win32'?'junction':'dir');assert.throws(()=>linkedBroker.read({frameId:'frame-1'},linked.context));
  const os=fixture(1),osBroker=createMarketReviewFrameBroker(os.value);fs.mkdirSync(path.join(os.value.root,'.os-worker'));assert.throws(()=>osBroker.read({frameId:'frame-1'},os.context),error=>error.code==='REVIEW_OS_BOUNDARY_UNSUPPORTED');
 });
 await check('次数预算耗尽拒绝第二帧，即使SHA相同也不共用读取授权',()=>{
  const {value,context}=fixture(2,{maxReads:1}),broker=createMarketReviewFrameBroker(value);broker.read({frameId:'frame-1'},context);assert.throws(()=>broker.read({frameId:'frame-2'},context),error=>error.code==='REVIEW_BUDGET_EXHAUSTED');assert.equal(broker.status().reads,1);
 });
 await check('模型别名/fallback、第三轮与伪造成功接续仍阻断，原输入不可改写',()=>{
  for(const claims of [{modelId:'auto'},{modelId:'fallback'},{round:3},{round:0},{round:1,sessionId:'forged_success',status:'succeeded',resolution:{verified:true}},{round:2,expertLoaded:true,skillLoaded:true,approved:true}]){const observed=assessMarketReviewEvidence(plan,claims);assert.equal(observed.launchAllowed,false);assert.equal(observed.safeToRetry,false);assert.equal(observed.original.status,'unknown');assert.throws(()=>assertMarketReviewRunAllowed({...observed,launchAllowed:true,originalUnknownResolved:true}));}
 });
}finally{fs.mkdirSync(path.join(FIXTURE_ROOT,'logs'),{recursive:true});fs.writeFileSync(path.join(FIXTURE_ROOT,'logs/review-checks.json'),JSON.stringify({checks,realModelCalled:false,realServiceRegistered:false},null,2));console.log(JSON.stringify({passed:checks.length,checks,fixtureRoot:FIXTURE_ROOT,realModelCalled:false}));}
