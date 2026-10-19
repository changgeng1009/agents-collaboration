import fs from 'node:fs';import path from 'node:path';
import {PROJECT_ROOT,SOURCE_ROOT,inside,sha256,fail} from './policy.mjs';import {readBoundedFile,sessionPath} from './session-files.mjs';
import {buildControlledMarketPlan,buildControlledMarketInput,executeControlledMarketLaunch} from './market-controlled-adapter.mjs';
export const CONTENT_EXPERT_STAGES=Object.freeze(['script','review_and_revision','rereview']);
const CONTRACT='content_expert_stages_v1',id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
function pinned(pin,limit=32768){if(!pin||!path.isAbsolute(pin.path??'')||!/^[a-f0-9]{64}$/.test(pin.sha256??''))fail('CONTENT_EXPERT_PIN_REQUIRED','须由可信宿主固定文件与SHA。');const read=readBoundedFile(sessionPath(pin.path),limit);if(read.sha256!==pin.sha256)fail('CONTENT_EXPERT_SOURCE_CHANGED','已审原件改变。');return read;}
export function validateContentExpertStageInputs(context,{stage,briefSha256,previousStageReceiptSha256,cwd,expectedFrames=[],previousSubjectVersionId=null}){
 if(!context||Object.keys(context).sort().join(',')!=='briefSha256,previousStageReceiptSha256,schema,stage,subject'||context.schema!=='content_expert_stage_inputs_v1'||context.stage!==stage||context.briefSha256!==briefSha256||context.previousStageReceiptSha256!==previousStageReceiptSha256)fail('CONTENT_EXPERT_INPUT_CONTEXT_INVALID','阶段输入须固定同一brief、原前阶段回执及明确主体版本。');
 if(stage==='script'){if(context.subject!==null||previousStageReceiptSha256!==null)fail('CONTENT_EXPERT_INPUT_CONTEXT_INVALID','首轮仅原文字brief，不接受事后评审主体。');return context;}
 const subject=context.subject;if(!subject||Object.keys(subject).sort().join(',')!=='frames,originalReceipt,producerId,producerTaskId,versionId,video'||!id(subject.versionId)||!id(subject.producerId)||!id(subject.producerTaskId)||!Array.isArray(subject.frames)||subject.frames.length!==5||JSON.stringify(subject.frames)!==JSON.stringify(expectedFrames))fail('CONTENT_EXPERT_INPUT_CONTEXT_INVALID','评审须固定原producer、任务、版本、原回执及准确五帧。');
 if(stage==='rereview'&&(!previousSubjectVersionId||subject.versionId===previousSubjectVersionId))fail('CONTENT_EXPERT_REVISION_VERSION_REQUIRED','复审须绑定明确的新修订版本，不能沿用首版三次成功凑整链。');
 for(const pin of [subject.video,subject.originalReceipt,...subject.frames]){if(!inside(path.join(cwd,'inputs','files'),pin.path??''))fail('CONTENT_EXPERT_INPUT_SCOPE','评审只接受当前专家任务获准的输入副本。');pinned(pin,64*1024*1024);}
 return structuredClone(context);
}
// 单独的三阶段合同。T16的first/second占位、批准及第三轮拒绝保持原样。
export class ContentExpertStagesRunner{
 #config;#fixture;
 constructor(config,{fixture=false}={}){if(fixture&&(process.env.COLLAB_TEST_MODE!=='1'||PROJECT_ROOT===SOURCE_ROOT||!inside(PROJECT_ROOT,config.market?.base?.nodeExecutable??'')))fail('CONTENT_EXPERT_FIXTURE_FORBIDDEN','假CLI只允许隔离项目内固定程序。');this.#config=structuredClone(config);this.#fixture=fixture;}
 prepare(request){
  if(!request||Object.keys(request).sort().join(',')!=='stage,text,turnId'||!CONTENT_EXPERT_STAGES.includes(request.stage)||!id(request.turnId)||typeof request.text!=='string'||!request.text.length||Buffer.byteLength(request.text)>32768)fail('CONTENT_EXPERT_STAGE_INVALID','只能执行脚本、评审修订、复审三个固定阶段。');
  const config=this.#config,index=CONTENT_EXPERT_STAGES.indexOf(request.stage),brief=pinned(config.briefPin);
  if(!inside(path.join(config.market.base.cwd,'inputs','files'),config.briefPin.path))fail('CONTENT_EXPERT_BRIEF_SCOPE','brief必须是原专家任务内已授权输入。');
  const market={...config.market,frames:config.stageFrames?.[request.stage]??config.market.frames},plan=buildControlledMarketPlan(market,{turnId:request.turnId,phase:'first'}),directory=sessionPath(path.join(plan.cwd,'work',CONTRACT),false),stableBindingSha256=sha256(JSON.stringify({contract:CONTRACT,base:plan.bindingContext.validatedBaseContextSha256,catalog:plan.catalogPin.sha256,sourcePolicy:plan.sourcePolicyPin.sha256,briefSha256:brief.sha256}));
  let priorReceiptSha256=null,prior=null;
  if(index){const file=path.join(directory,CONTENT_EXPERT_STAGES[index-1]+'-result.json');if(!fs.existsSync(file))fail('CONTENT_EXPERT_PRIOR_REQUIRED','须读取原任务持久上一阶段成功回执，不能由消息提供session。');const read=readBoundedFile(sessionPath(file),2*1024*1024);priorReceiptSha256=read.sha256;prior=JSON.parse(read.bytes);if(prior.status!=='succeeded'||prior.stableBindingSha256!==stableBindingSha256||prior.evidenceLevel!==(this.#fixture?'local_test':'real_runtime')||!prior.nativeBinding?.sessionId)fail('CONTENT_EXPERT_PRIOR_UNKNOWN','上一阶段未知或原专家/模型/本人/目录/brief变化，停止不重试。');}
  plan.phase=index?'second':'first';plan.priorBinding=prior?.nativeBinding??null;plan.approvalPin=config.approvals?.[request.stage]??null;
  if(index)plan.args.push('--resume',prior.nativeBinding.sessionId);plan.env.COLLAB_CONTENT_EXPERT_STAGE=request.stage;
  const contextPin=config.stageInputs?.[request.stage],inputContext=validateContentExpertStageInputs(JSON.parse(pinned(contextPin).bytes),{stage:request.stage,briefSha256:brief.sha256,previousStageReceiptSha256:priorReceiptSha256,cwd:plan.cwd,expectedFrames:market.frames,previousSubjectVersionId:prior?.inputSubjectVersionId??null});
  const subject=inputContext.subject,boundText=request.text+'\n\n'+JSON.stringify({stageContext:{contract:CONTRACT,stage:request.stage,briefSha256:brief.sha256,priorReceiptSha256,subject:subject?{versionId:subject.versionId,producerId:subject.producerId,producerTaskId:subject.producerTaskId,videoSha256:subject.video.sha256,originalReceiptSha256:subject.originalReceipt.sha256,frameSha256:subject.frames.map(frame=>frame.sha256)}:null,sourceIdentityVerified:false,fullMotionAndAudioInspected:false}});
  const input=buildControlledMarketInput(plan,boundText),launchSha256=sha256(JSON.stringify({contract:CONTRACT,stage:request.stage,stableBindingSha256,command:plan.command,args:plan.args,env:plan.env,cwd:plan.cwd,cwdIdentity:plan.cwdIdentity,inputSha256:input.sha256,priorReceiptSha256,inputContextSha256:contextPin.sha256}));plan.launchSha256=launchSha256;
  return{contract:CONTRACT,stage:request.stage,turnId:request.turnId,stableBindingSha256,priorReceiptSha256,planSha256:launchSha256,inputSha256:input.sha256,inputContextSha256:contextPin.sha256,inputContext,boundText,nativePlan:plan,input,directory,launchAllowed:false};
 }
 async run(request){
  const prepared=this.prepare(request),config=this.#config,pin=config.approvals?.[request.stage];
  if(!pin)fail('CONTENT_EXPERT_APPROVAL_REQUIRED','新合同须有本阶段准确批准，不能沿用T16预算。');
  if(!this.#fixture&&process.env.COLLAB_TEST_MODE==='1')fail('TEST_OFFICIAL_EXECUTION_FORBIDDEN','测试禁止真实CLI。');
  if(config.market.base.enabled!==true)fail('CONTENT_EXPERT_DISABLED','可信宿主尚未启用候选。');
  const approval=JSON.parse(pinned(pin,16384).bytes),evidenceLevel=this.#fixture?'local_test':'real_runtime';
  if(Object.keys(approval).sort().join(',')!=='evidenceLevel,planSha256,priorReceiptSha256,schema'||approval.schema!=='content_expert_stage_approval_v1'||approval.planSha256!==prepared.planSha256||approval.priorReceiptSha256!==prepared.priorReceiptSha256||approval.evidenceLevel!==evidenceLevel)fail('CONTENT_EXPERT_APPROVAL_MISMATCH','准确批准与本阶段启动、输入、原回执或证据域不符。');
  fs.mkdirSync(prepared.directory,{recursive:true});const intentFile=path.join(prepared.directory,request.stage+'-intent.json'),resultFile=path.join(prepared.directory,request.stage+'-result.json'),rawResultFile=path.join(prepared.directory,request.stage+'-native-result.json');
  try{fs.writeFileSync(intentFile,JSON.stringify({contract:CONTRACT,stage:request.stage,turnId:request.turnId,planSha256:prepared.planSha256,approvalSha256:pin.sha256,state:'unknown',automaticRetry:false}),{flag:'wx'});}catch(error){if(error.code!=='EEXIST')throw error;const prior=JSON.parse(readBoundedFile(sessionPath(intentFile),16384).bytes);if(prior.planSha256!==prepared.planSha256||prior.approvalSha256!==pin.sha256)fail('CONTENT_EXPERT_STAGE_RESERVED','原阶段已有持久意图，不换编号或输入重复。');return fs.existsSync(resultFile)?{...JSON.parse(readBoundedFile(sessionPath(resultFile),2*1024*1024).bytes),deduplicated:true}:{contract:CONTRACT,status:'unknown',reason:'CONTENT_EXPERT_LAUNCH_UNCONFIRMED',automaticRetry:false,deduplicated:true};}
  const native=await executeControlledMarketLaunch(config.market,prepared.nativePlan,prepared.input,{intentFile,resultFile:rawResultFile},evidenceLevel,{...request,text:prepared.boundText},()=>this.prepare(request).nativePlan),raw=readBoundedFile(sessionPath(rawResultFile),2*1024*1024);
  const result={...native,contract:CONTRACT,stage:request.stage,stableBindingSha256:prepared.stableBindingSha256,planSha256:prepared.planSha256,priorReceiptSha256:prepared.priorReceiptSha256,inputContextSha256:prepared.inputContextSha256,inputSubjectVersionId:prepared.inputContext.subject?.versionId??null,rawReceipt:{file:rawResultFile,sha256:raw.sha256,byteLength:raw.byteLength},nativeBinding:native.nativeBinding?{...native.nativeBinding,contract:CONTRACT,stableBindingSha256:prepared.stableBindingSha256}:null,modelExecutionVerified:false,businessCompletedVerified:false,automaticRetry:false};
  fs.writeFileSync(resultFile,JSON.stringify(result,null,2),{flag:'wx'});return result;
 }
}
