import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {inflateSync} from 'node:zlib';
import {PROJECT_ROOT,SOURCE_ROOT,inside,fail,sha256} from './policy.mjs';
import {readBoundedFile,sessionPath} from './session-files.mjs';
import {preparedRootIdentity} from './collaboration-workspaces.mjs';
import {buildMarketExpertPlan,parseMarketExpertEvents,checkMarketModelEvidence,MARKET_BUILTIN_DENY_TOOLS,MARKET_TASK_TOOLS} from './market-expert-adapter.mjs';
import {inspectMarketToolEvidence} from './market-tool-policy.mjs';
import {readCodeBuddyAudit} from './codebuddy-audit.mjs';
import {sanitizeCodeBuddyValue} from './codebuddy-cli-adapter.mjs';

const CONTRACT='market_expert_c_v1',MODEL='deepseek-v4.1-flash';
const retryPolicy=Object.freeze({controllerAutomaticRetry:false,scope:'controller_cli_operations_only',vendorInternalRequestRetries:'not_overridden_not_verified',modelTurnsPerOperation:8});
const taskTools=MARKET_TASK_TOOLS.map(name=>`mcp__market_task__${name}`);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const same=(left,right)=>JSON.stringify(left)===JSON.stringify(right);
const validId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
function pinned(pin,limit=1024*1024){
 if(!exact(pin,['path','sha256'])||typeof pin.path!=='string'||!path.isAbsolute(pin.path)||!/^[a-f0-9]{64}$/.test(pin.sha256))fail('CONTROLLED_PIN_INVALID','可信来源须有固定路径与摘要。');
 const value=readBoundedFile(pin.path,limit);if(value.sha256!==pin.sha256)fail('CONTROLLED_SOURCE_CHANGED','已审来源文件发生变化。');return value;
}
function readJson(pin,limit){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(pinned(pin,limit).bytes));}catch(error){if(error.code)throw error;fail('CONTROLLED_JSON_INVALID','已审来源不是有效JSON。');}}

// 此准备入口没有spawn/core/claim，审批引用只来自可信启动配置，不接受消息布尔值。
export function buildControlledMarketPlan(config,{turnId,phase,priorBinding=null}={}){
 if(!exact(config,['base','catalogPin','sourcePolicyPin','frames','approvals'])||!['first','second'].includes(phase)||!validId(turnId)||!exact(config.approvals,['first','second']))fail('CONTROLLED_CONFIG_INVALID','C合同字段、阶段或轮次无效。');
 if(config.base.modelId!==MODEL||config.base.runtimeVersion!=='2.168.2')fail('CONTROLLED_RUNTIME_REQUIRED','仅接受已审固定CLI与指定模型，不配置回退。');
 if(config.base.pluginName!=='content-creator'||config.base.pluginVersion!=='1.0.1'||config.base.agentName!=='content-creator')fail('CONTROLLED_EXPERT_REQUIRED','本合同只承载已审原content-creator 1.0.1。');
 const legacy=buildMarketExpertPlan(config.base,{turnId}),catalog=readJson(config.catalogPin),policy=readJson(config.sourcePolicyPin);
 if(!Array.isArray(catalog))fail('CONTROLLED_CATALOG_INVALID','须给可信宿主的实际目录响应。');
 const directory=catalog.filter(row=>row.path==='/api/v1/jobs/dispatch-context'&&row.status===200).at(-1)?.body?.data;
 const candidates=directory?.agents?.filter(agent=>agent.name===config.base.agentName&&agent.custom===true&&agent.source==='project'&&typeof agent.description==='string'&&agent.description.endsWith(`(${config.base.pluginName}@inline:agents)`));
 if(candidates?.length!==1||legacy.pluginLoadingInspection.agent?.staticName!==config.base.agentName||legacy.pluginLoadingInspection.agentSelection.ambiguous)fail('CONTROLLED_AGENT_SOURCE_REQUIRED','原Agent目录名及原件来源未闭合。');
 if(!exact(policy,['schema','headlessSha256','productSha256','toolNames','taskTools','sourcePins','registryPins'])||policy.schema!=='market_c_sources_v1'||!same(policy.toolNames,MARKET_BUILTIN_DENY_TOOLS)||!same(policy.taskTools,taskTools)||!Array.isArray(policy.sourcePins)||!policy.sourcePins.length||policy.sourcePins.length>32||!Array.isArray(policy.registryPins)||policy.registryPins.length>32)fail('CONTROLLED_SOURCE_POLICY_INVALID','须固定审查来源、65项deny和五MCP，不接受自报许可。');
 for(const source of policy.sourcePins)pinned(source);
 const extraRegistryPaths=[path.join(config.base.packageRoot,'customization.json'),path.join(config.base.pluginRoot,'bin'),...['.codebuddy','.mcp.json','.codebuddy-mcp.json'].map(relative=>path.join(config.base.cwd,relative))];
 for(const registry of policy.registryPins){if(!exact(registry,['path','sha256'])||typeof registry.path!=='string'||!inside(config.base.profileRoot,registry.path)&&!extraRegistryPaths.includes(registry.path))fail('CONTROLLED_REGISTRY_SCOPE','仅核已审profile及固定包/任务配置来源。');sessionPath(registry.path,false);if(registry.sha256===null){if(fs.existsSync(registry.path))fail('CONTROLLED_REGISTRY_CHANGED','原无配置来源出现文件。');}else pinned(registry);}
 const headless=path.join(config.base.packageRoot,'dist','codebuddy-headless.js'),productFile=path.join(config.base.packageRoot,'product.json');
 if(!legacy.bindingSha256||!config.base.runtimePins.some(pin=>pin.relativePath.replaceAll('\\','/')==='dist/codebuddy-headless.js'&&pin.sha256===policy.headlessSha256)||!config.base.runtimePins.some(pin=>pin.relativePath.replaceAll('\\','/')==='product.json'&&pin.sha256===policy.productSha256))fail('CONTROLLED_ENTRYPOINT_UNREVIEWED','新入口和模型目录必须在官方原件pins中。');
 const product=readJson({path:productFile,sha256:policy.productSha256},512*1024),models=product.models?.filter(model=>model.id===MODEL);
 if(models?.length!==1||models[0].supportsImages!==true||models[0].supportsToolCall!==true)fail('CONTROLLED_MODEL_CATALOG_REQUIRED','固定模型目录声明不符，不能自动换型。');
 if(!Array.isArray(config.frames)||![0,5].includes(config.frames.length))fail('CONTROLLED_FRAMES_INVALID','帧范围只能为零或已审五帧。');
 const frames=config.frames.map(pin=>{const read=pinned(pin,512*1024);if(!inside(path.join(legacy.cwd,'inputs','files'),pin.path))fail('CONTROLLED_FRAME_SCOPE','仅允许本新任务的已审输入帧。');return{...pin,byteLength:read.byteLength,fileIdentity:read.identity,directoryIdentity:preparedRootIdentity(path.dirname(pin.path))};});
 if(new Set(frames.map(frame=>frame.path.toLowerCase())).size!==frames.length||frames.reduce((sum,frame)=>sum+frame.byteLength,0)>3*1024*1024||phase==='second'&&frames.length!==5)fail('CONTROLLED_FRAMES_INVALID','五帧来源、数量或总字节不符。');
 const bindingContext={schema:CONTRACT,validatedBaseContextSha256:legacy.bindingSha256,modelId:MODEL,agentRawName:config.base.agentName,settingSources:'none',inputFormat:'stream-json',entrypointSha256:policy.headlessSha256,productSha256:policy.productSha256,catalogSha256:config.catalogPin.sha256,sourcePolicySha256:config.sourcePolicyPin.sha256,proxySha256:legacy.proxySha256,frames,retryPolicy,limits:{firstMs:300000,secondMs:240000,maxTurns:8,maxOutputBytes:2*1024*1024,maxInputBytes:4*1024*1024}},bindingSha256=sha256(JSON.stringify(bindingContext));
 if(phase==='first'&&priorBinding!==null||phase==='second'&&(!exact(priorBinding,['contract','sessionId','nativeFieldName','modelId','bindingSha256','status','evidenceLevel'])||priorBinding.contract!==CONTRACT||priorBinding.status!=='succeeded'||priorBinding.modelId!==MODEL||priorBinding.nativeFieldName!=='session_id'||priorBinding.bindingSha256!==bindingSha256||!['local_test','real_runtime'].includes(priorBinding.evidenceLevel)||typeof priorBinding.sessionId!=='string'||!priorBinding.sessionId.length||priorBinding.sessionId.length>256||priorBinding.sessionId.startsWith('-')||/[\x00-\x1f]/.test(priorBinding.sessionId)))fail('CONTROLLED_RESUME_BINDING','只能接续本新C合同的相同成功会话。');
 const args=[...legacy.args];args[0]=headless;args[args.indexOf('--input-format')+1]='stream-json';args[args.indexOf('--agent')+1]=config.base.agentName;args[args.indexOf('--setting-sources')+1]='none';args.splice(args.indexOf('--permission-mode'),0,'--no-plugin-management');if(phase==='second')args.push('--resume',priorBinding.sessionId);
 const env={...legacy.env,CODEBUDDY_SESSION_HISTORY_CLEANUP:'0',CBC_ENABLE_FUNCTION_HOOKS:'0',CODEBUDDY_PLUGIN_BACKGROUND_MANAGEMENT:'0',CODEBUDDY_DISABLE_PLUGIN_INSTALLS:'1',CODEBUDDY_SKIP_BUILTIN_MARKETPLACE:'1',CODEBUDDY_DISABLE_HOT_RELOAD:'1',CODEBUDDY_DISABLE_COMPILE_CACHE:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',SERVER__HOST:'127.0.0.1',SERVER__PORT:'0'};
 const launchSha256=sha256(JSON.stringify({contract:CONTRACT,bindingSha256,phase,turnId,command:legacy.command,args,env,cwd:legacy.cwd,cwdIdentity:legacy.cwdIdentity,mcpConfiguration:legacy.mcpConfiguration,memberBinding:legacy.memberBinding,timeoutMs:phase==='first'?300000:240000,maxOutputBytes:2*1024*1024}));
 return{...legacy,contract:CONTRACT,phase,turnId,args,env,bindingContext,bindingSha256,launchSha256,priorBinding,frames,sourcePolicy:policy,catalogPin:config.catalogPin,sourcePolicyPin:config.sourcePolicyPin,approvalPin:config.approvals[phase],timeoutMs:phase==='first'?300000:240000,maxOutputBytes:2*1024*1024,maxInputBytes:4*1024*1024,agentSelectedByArgument:config.base.agentName,toolPolicyProfile:CONTRACT,entrypointSha256:policy.headlessSha256,launchAllowed:false,originalUnknownResolved:false,safeToRetryOriginal:false};
}

// 复用已验的有界目录/审计归约；这不是旧preview的运行开关，也不输出真实许可。
export function inspectControlledMarketEvidence(events,{plan,audit=null}={}){
 if(plan?.contract!==CONTRACT)fail('CONTROLLED_CONTRACT_REQUIRED','只能分析独立C合同。');
 const observed=inspectMarketToolEvidence(events,{plan,audit,profile:'market_expert_preview'});
 const nativeRequested=observed.execution.observedCalls.some(call=>MARKET_BUILTIN_DENY_TOOLS.includes(call.name));
 return{...observed,profile:CONTRACT,reason:nativeRequested?'CONTROLLED_NATIVE_TOOL_REQUESTED':observed.reason,permissions:{...observed.permissions,candidateBuiltinTools:[],modelCallApproved:false},execution:{...observed.execution,requestIntents:observed.execution.observedCalls.length,actualNativeExecutionVerified:false,requestIntentAloneProvesExecution:false},launchAllowed:false};
}

// 可信宿主只构造一条user NDJSON；正文内JSON只是text，不能注入SDK控制面。
export function buildControlledMarketInput(plan,text){
 if(plan?.contract!==CONTRACT||!['first','second'].includes(plan.phase)||typeof text!=='string'||!text.length||Buffer.byteLength(text)>32768)fail('CONTROLLED_INPUT_INVALID','仅接受已审阶段的有界文字，不接收原始JSON行。');
 const content=[{type:'text',text}],images=[];
 if(plan.phase==='second'){
  if(plan.frames.length!==5)fail('CONTROLLED_FRAMES_INVALID','第二轮必须是准确五帧。');
  for(const frame of plan.frames){const current=readBoundedFile(frame.path,512*1024);if(current.sha256!==frame.sha256||!same(current.identity,frame.fileIdentity)||!same(preparedRootIdentity(path.dirname(frame.path)),frame.directoryIdentity))fail('CONTROLLED_FRAME_CHANGED','原帧内容或身份已变化。');const dimensions=pngDimensions(current.bytes);content.push({type:'image',source:{type:'base64',media_type:'image/png',data:current.bytes.toString('base64')}});images.push({path:frame.path,sha256:current.sha256,byteLength:current.byteLength,...dimensions});}
 }
 const bytes=Buffer.from(JSON.stringify({type:'user',message:{role:'user',content}})+'\n','utf8');if(bytes.length>4*1024*1024)fail('CONTROLLED_INPUT_TOO_LARGE','完整用户输入超过4MiB。');return{bytes,sha256:sha256(bytes),byteLength:bytes.length,imageCount:images.length,images,imagesAcceptedByProvider:false,evidence:'prepared_user_payload_only'};
}

export class ControlledMarketExpertCliAdapter{
 #config;#evidenceLevel;
 constructor(config,{fixture=false}={}){if(fixture&&(process.env.COLLAB_TEST_MODE!=='1'||PROJECT_ROOT===SOURCE_ROOT||!inside(PROJECT_ROOT,config.base.nodeExecutable)))fail('CONTROLLED_FIXTURE_FORBIDDEN','合成进程仅允许隔离项目中的显式测试入口。');this.#config=structuredClone(config);this.#evidenceLevel=fixture?'local_test':'real_runtime';}
 prepare(context){return buildControlledMarketPlan(this.#config,context);}
 async run(request){
  const keys=Object.keys(request??{});if(!plain(request)||keys.some(key=>!['turnId','phase','text','priorBinding'].includes(key))||!['first','second'].includes(request.phase)||!validId(request.turnId)||typeof request.text!=='string'||!request.text.length)fail('CONTROLLED_REQUEST_INVALID','运行请求只能提供固定阶段、正文和原成功绑定。');
  if(!this.#config.approvals[request.phase])fail('CONTROLLED_PHASE_NOT_APPROVED','尚无准确阶段批准，禁止core预检、占位和进程启动。');
  if(this.#config.base.enabled!==true)fail('CONTROLLED_DISABLED','可信启动没有启用新合同。');
  if(process.env.COLLAB_TEST_MODE==='1'&&this.#evidenceLevel!=='local_test')fail('TEST_OFFICIAL_EXECUTION_FORBIDDEN','离线测试不能启动官方账号或模型入口。');
  if(request.priorBinding&&request.priorBinding.evidenceLevel!==this.#evidenceLevel)fail('CONTROLLED_RESUME_BINDING','合成和真实成功会话不能混用。');
  const plan=this.prepare(request),input=buildControlledMarketInput(plan,request.text),approval=readJson(plan.approvalPin,16384),evidenceLevel=this.#evidenceLevel;
  const fields=['schema','contract','phase','turnId','bindingSha256','launchSha256','inputSha256','inputBytes','priorReceiptSha256','evidenceLevel'];
  if(!exact(approval,fields)||approval.schema!=='market_c_phase_approval_v1'||approval.contract!==CONTRACT||approval.phase!==plan.phase||approval.turnId!==plan.turnId||approval.bindingSha256!==plan.bindingSha256||approval.launchSha256!==plan.launchSha256||approval.inputSha256!==input.sha256||approval.inputBytes!==input.byteLength||approval.evidenceLevel!==evidenceLevel||plan.phase==='first'&&approval.priorReceiptSha256!==null)fail('CONTROLLED_APPROVAL_MISMATCH','准确阶段批准与固定计划、输入或证据域不匹配。');
  const claim=claimControlledLaunch(plan,input,approval,evidenceLevel);if(claim.replay)return claim.replay;
  return executeControlledMarketLaunch(this.#config,plan,input,claim,evidenceLevel,request,context=>this.prepare(context));
 }
}

// 可信宿主内部共用进程层；合同、批准和阶段占位由各自外层验证。
export async function executeControlledMarketLaunch(config,plan,input,claim,evidenceLevel,request,prepare){
  const lifecycle=[],stdin={attempted:false,writeCompleted:false,sha256:input.sha256,byteLength:input.byteLength,imageCount:input.imageCount,imagesAcceptedByProvider:false},readiness={verified:false,cliPid:null,proof:null};
  let child,pid=null,closed={exitCode:null,signal:null},timedOut=false,truncated=false,protocolError=false,failure=null,audit=null,auditError=null,streamFile=null,logPoll,timer,fd=null,outputBytes=0,tail=Buffer.alloc(0);const events=[],stderr=[];
  const note=(type,details={})=>lifecycle.push({type,at:new Date().toISOString(),...details});
  const terminate=code=>{failure??=code;child?.kill();};
  let diagnosticCount=0,omittedDiagnostics=0,omittedBytes=0;const omittedHash=createHash('sha256');
  // 诊断只进入受保护日志；不进入events，不授予权限，也不回灌stdin。
  const recordUnparsed=(bytes,{captureUnit='stdout_line',captureComplete=true,omitText=false}={})=>{
   if(diagnosticCount++>=8){omittedDiagnostics++;omittedBytes+=bytes.length;omittedHash.update(bytes);return;}
   let text='',utf8Valid=null,textTruncated=omitText;
   if(!omitText){try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);utf8Valid=true;}catch{text=bytes.toString('utf8');utf8Valid=false;}
    text=sanitizeCodeBuddyValue(text).replace(/(["']?authorization["']?\s*[:=]\s*)[^\r\n]+/gi,'$1[已脱敏]').replace(/https?:\/\/[^\s"'<>]+/gi,'[已脱敏链接]').replace(/[A-Za-z0-9_+\/=-]{32,}/g,'[已脱敏不透明值]');textTruncated=text.length>4096;text=text.slice(0,4096);
   }
   fs.writeSync(fd,JSON.stringify({type:'unparsed',countsAsNativeEvent:false,captureUnit,captureComplete,byteLength:bytes.length,sha256:sha256(bytes),utf8Valid,text,maxTextCodeUnits:4096,textTruncated,bodyOmitted:omitText,redacted:true})+'\n');
  };
  try{
   // 先占位再预检或spawn；预检失败同样保留未知，不按“未发prompt”自动重启。
   const{invokeMarketTask}=await import('./market-expert-task-server.mjs');await invokeMarketTask(plan.memberBinding,'get_task',{groupId:plan.memberBinding.groupId,taskId:plan.memberBinding.taskId});note('parent_core_preflight',{expertToolCall:false});
   fs.mkdirSync(sessionPath(plan.inputDirectory,false),{recursive:true});fs.mkdirSync(sessionPath(plan.workDirectory,false),{recursive:true});
   for(const[file,value]of[[plan.mcpConfigFile,plan.mcpConfiguration],[plan.bindingFile,plan.memberBinding]])writeExclusive(file,value);
   streamFile=path.join(plan.workDirectory,'native-stream.jsonl');fd=fs.openSync(sessionPath(streamFile,false),'wx');
   const logBaseline=profileLogSnapshot(config.base.profileRoot);
   const acceptLine=bytes=>{
    if(!bytes.length)return;
    let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!plain(value)||typeof value.type!=='string'||events.length>=4096)fail('PROTOCOL_INVALID','事件格式无效。');}
    catch{recordUnparsed(bytes);protocolError=true;terminate('PROTOCOL_INVALID');return;}
    try{
     events.push(value);fs.writeSync(fd,JSON.stringify(sanitizeCodeBuddyValue(value))+'\n');
     if(!stdin.attempted){validatePreinputMetadata(value,events,plan);note('preinput_metadata',{subtype:value.subtype,event:value.event??null});return;}
     if(value.type==='control_request')terminate('INTERACTIVE_CONTROL_REQUIRED');
     else if(checkMarketModelEvidence(events,plan.modelId).reason)terminate(checkMarketModelEvidence(events,plan.modelId).reason);
     else if(value.type==='system'&&value.subtype==='init'){const parsed=parseMarketExpertEvents(events.filter(event=>event.type==='system'&&event.subtype==='init'),{plan:{...plan,toolPolicyProfile:'market_expert_preview'},exitCode:0,audit:{verified:true,toolCalls:[]}});if(parsed.reason!=='RESULT_MISSING')terminate(parsed.reason);}
     else if(value.message?.content?.some?.(use=>use?.type==='tool_use'&&!taskTools.includes(use.name)))terminate('CONTROLLED_UNAPPROVED_TOOL_REQUESTED');
    }catch(error){protocolError=true;terminate(error.code??'PROTOCOL_INVALID');}
   };
   child=spawn(plan.command,plan.args,{cwd:plan.cwd,env:plan.env,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
   const completed=new Promise(resolve=>{child.once('spawn',()=>{pid=child.pid;readiness.cliPid=pid;note('spawn',{pid});});child.once('error',error=>{note('error',{code:error.code??'SPAWN_ERROR'});failure??=error.code??'SPAWN_ERROR';});child.once('exit',(exitCode,signal)=>note('exit',{exitCode,signal}));child.once('close',(exitCode,signal)=>{note('close',{exitCode,signal});resolve({exitCode,signal});});});
   const accept=(bytes,stdout=false)=>{outputBytes+=bytes.length;if(outputBytes>plan.maxOutputBytes){truncated=true;if(stdout){recordUnparsed(Buffer.concat([tail,bytes]),{captureUnit:'stdout_pending_prefix',captureComplete:false,omitText:true});tail=Buffer.alloc(0);}terminate('OUTPUT_TRUNCATED');return false;}return true;};
   child.stdout.on('data',bytes=>{if(!accept(bytes,true))return;tail=Buffer.concat([tail,bytes]);let end;while((end=tail.indexOf(10))>=0){acceptLine(tail.subarray(0,end));tail=tail.subarray(end+1);}});
   child.stderr.on('data',bytes=>{if(accept(bytes))stderr.push(bytes);});child.stdin.on('error',error=>{note('stdin_error',{code:error.code??'STDIN_ERROR'});protocolError=true;terminate('STDIN_WRITE_UNKNOWN');});
   timer=setTimeout(()=>{timedOut=true;terminate(stdin.attempted?'TIMEOUT_UNKNOWN':'CONTROLLED_READINESS_TIMEOUT');},plan.timeoutMs);
   logPoll=setInterval(()=>{if(!pid||failure||stdin.attempted)return;let stage='observe_profile_logs';try{const proof=observeControlledReadiness(config.base.profileRoot,logBaseline,pid);if(!proof)return;stage='recheck_prepared_plan';const current=prepare(request),currentInput=buildControlledMarketInput(current,request.text);stage='recheck_phase_approval';if(current.launchSha256!==plan.launchSha256||currentInput.sha256!==input.sha256||pinned(plan.approvalPin,16384).sha256!==plan.approvalPin.sha256)fail('CONTROLLED_PREINPUT_CHANGED','输入前计划或批准发生变化。');readiness.verified=true;readiness.proof=proof;readiness.observedAt=new Date().toISOString();stdin.attempted=true;stdin.attemptedAt=new Date().toISOString();stdin.monotonicNs=process.hrtime.bigint().toString();note('stdin_write',{sha256:input.sha256,byteLength:input.byteLength});child.stdin.end(input.bytes,()=>{stdin.writeCompleted=true;stdin.completedAt=new Date().toISOString();});}catch(error){readiness.failure={stage,code:error.code??'CONTROLLED_READINESS_INVALID',fileReadObservation:error.fileReadObservation??null};note('readiness_error',readiness.failure);terminate(readiness.failure.code);}},50);
   closed=await completed;clearInterval(logPoll);clearTimeout(timer);if(tail.length)acceptLine(tail);
   if(!readiness.verified)failure??='CONTROLLED_READINESS_MISSING';if(!stdin.writeCompleted)failure??='STDIN_WRITE_UNKNOWN';
   try{audit=readCodeBuddyAudit(plan.auditFile,{cwd:plan.cwd,cliPid:pid,toolNames:MARKET_TASK_TOOLS});}catch(error){auditError=error.code??'MCP_AUDIT_UNVERIFIED';}
  }catch(error){failure??=error.code??'CONTROLLED_LAUNCH_UNKNOWN';note('adapter_error',{code:failure});}finally{clearInterval(logPoll);clearTimeout(timer);if(fd!==null){if(omittedDiagnostics)fs.writeSync(fd,JSON.stringify({type:'unparsed_summary',countsAsNativeEvent:false,omittedRecords:omittedDiagnostics,byteLength:omittedBytes,sha256:omittedHash.digest('hex'),hashScope:'concatenated_omitted_units',textTruncated:true,bodyOmitted:true})+'\n');fs.fsyncSync(fd);fs.closeSync(fd);}}
  const receipt=controlledReceipt(events,{plan,...closed,timedOut,truncated,protocolError,audit,evidenceLevel,failure,readiness,stdin});
  Object.assign(receipt,{pid,lifecycle,outputBytes,audit,auditError,turnId:plan.turnId,phase:plan.phase,contract:CONTRACT,bindingSha256:plan.bindingSha256,launchSha256:plan.launchSha256,approvalSha256:plan.approvalPin.sha256,launchIntentFile:claim.intentFile,streamFile,modelRequestState:evidenceLevel==='local_test'?'not_model_local_test':receipt.status==='succeeded'?'native_terminal_success_observed':receipt.reason==='PLATFORM_RESULT_FAILED'?'native_terminal_failure_observed':'unknown',billingState:'unknown',automaticRetry:false,retryPolicy});
  if(fs.existsSync(plan.workDirectory)){writeExclusive(path.join(plan.workDirectory,'stderr.txt'),sanitizeCodeBuddyValue(Buffer.concat(stderr).toString('utf8')));writeExclusive(path.join(plan.workDirectory,'result.json'),receipt);}
  writeExclusive(claim.resultFile,receipt);return receipt;
}

function writeExclusive(file,value){const fd=fs.openSync(sessionPath(file,false),'wx',0o600);try{fs.writeFileSync(fd,typeof value==='string'?value:JSON.stringify(value,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function validatePreinputMetadata(value,events,plan){
 const iso=text=>typeof text==='string'&&Number.isFinite(Date.parse(text))&&new Date(text).toISOString()===text;
 if(value.type!=='system'||!['init','mcp_status'].includes(value.subtype)||events.length>32)fail('CONTROLLED_OUTPUT_BEFORE_INPUT','输入前仅接受固定初始化元数据。');
 if(value.subtype==='init'){
  const required=['type','subtype','uuid','session_id','apiKeySource','cwd','tools','mcp_servers','model','permissionMode','slash_commands','output_style'],allowed=[...required,'__timestamp','mcp_servers_unavailable'];
  if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!allowed.includes(key))||value.uuid!==value.session_id||typeof value.apiKeySource!=='string'||value.apiKeySource.length>1024||value.permissionMode!=='dontAsk'||value.output_style!=='default'||!Array.isArray(value.slash_commands)||value.slash_commands.length>128||value.slash_commands.some(name=>typeof name!=='string'||name.length>128)||value.__timestamp!==undefined&&!iso(value.__timestamp)||value.mcp_servers_unavailable!==undefined&&(!Array.isArray(value.mcp_servers_unavailable)||value.mcp_servers_unavailable.length))fail('CONTROLLED_PREINPUT_METADATA_INVALID','输入前init字段或有效配置不符。');
  const parsed=parseMarketExpertEvents(events.filter(event=>event.type==='system'&&event.subtype==='init'),{plan:{...plan,toolPolicyProfile:'market_expert_preview'},exitCode:0,audit:{verified:true,toolCalls:[]}});if(parsed.reason!=='RESULT_MISSING')fail(parsed.reason??'CONTROLLED_PREINPUT_METADATA_INVALID','输入前init的目录、模型、会话或工具范围不符。');return;
 }
 const common=['type','subtype','event','uuid','__timestamp'],fields=value.event==='start'?['servers','total_count']:value.event==='server'?['name','state','completed','total',...(Object.hasOwn(value,'error')?['error']:[])]:value.event==='finish'?['failed','timed_out']:null;
 if(!fields||!exact(value,[...common,...fields])||typeof value.uuid!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.uuid)||!iso(value.__timestamp))fail('CONTROLLED_PREINPUT_METADATA_INVALID','MCP初始化记录须匹配固定schema。');
 const names=items=>Array.isArray(items)&&items.length<=1&&new Set(items).size===items.length&&items.every(name=>name==='market_task');
 if(value.event==='start'&&(!names(value.servers)||value.total_count!==value.servers.length)||value.event==='server'&&(value.name!=='market_task'||!['connecting','ready'].includes(value.state)||!Number.isInteger(value.completed)||!Number.isInteger(value.total)||value.completed<0||value.completed>value.total||value.total>1||value.total<1||value.error!==undefined)||value.event==='finish'&&(!names(value.failed)||!names(value.timed_out)||value.failed.length||value.timed_out.length))fail('CONTROLLED_PREINPUT_MCP_REJECTED','唯一MCP的范围、状态或计数不符，禁止发送用户输入。');
}
function claimControlledLaunch(plan,input,approval,evidenceLevel){
 const member=plan.memberBinding,taskKey=sha256(JSON.stringify({cwd:plan.cwd,instanceId:member.instanceId,groupId:member.groupId,taskId:member.taskId})),directory=sessionPath(path.join(PROJECT_ROOT,'bridge','runtime','market-expert-c-control',taskKey),false);fs.mkdirSync(directory,{recursive:true});
 const firstIntent=path.join(directory,'first-intent.json'),firstResult=path.join(directory,'first-result.json'),intentFile=path.join(directory,`${plan.phase}-intent.json`),resultFile=path.join(directory,`${plan.phase}-result.json`),read=file=>JSON.parse(readBoundedFile(file,2*1024*1024).bytes);
 if(plan.phase==='second'){
  if(!fs.existsSync(firstIntent)||!fs.existsSync(firstResult))fail('CONTROLLED_PRIOR_RECEIPT_REQUIRED','第二轮必须有新C合同的持久首轮成功回执。');
  const first=read(firstIntent),receipt=read(firstResult),digest=readBoundedFile(firstResult,2*1024*1024).sha256;
  if(first.bindingSha256!==plan.bindingSha256||first.evidenceLevel!==evidenceLevel||receipt.status!=='succeeded'||receipt.evidenceLevel!==evidenceLevel||!same(receipt.nativeBinding,plan.priorBinding)||approval.priorReceiptSha256!==digest)fail('CONTROLLED_PRIOR_RECEIPT_REQUIRED','首轮持久成功、同session及新审批的原回执摘要须一致。');
 }
 const intent={contract:CONTRACT,phase:plan.phase,turnId:plan.turnId,bindingSha256:plan.bindingSha256,launchSha256:plan.launchSha256,inputSha256:input.sha256,approvalSha256:plan.approvalPin.sha256,priorReceiptSha256:approval.priorReceiptSha256,evidenceLevel,state:'launch_unknown',automaticRetry:false};
 try{writeExclusive(intentFile,intent);}catch(error){if(error.code!=='EEXIST')throw error;const original=read(intentFile);if(original.turnId!==plan.turnId)fail('CONTROLLED_PHASE_RESERVED','该阶段已有意图，禁止换编号重复启动。');if(!same(original,intent))fail('CONTROLLED_REQUEST_CONFLICT','已有意图的准确计划、输入或批准发生变化。');return{replay:fs.existsSync(resultFile)?{...read(resultFile),deduplicated:true}:{contract:CONTRACT,status:'unknown',reason:'LAUNCH_UNCONFIRMED',turnId:plan.turnId,nativeBinding:null,deduplicated:true,automaticRetry:false,safeToRetryOriginal:false}};}
 return{intentFile,resultFile};
}
const logStatValue=stat=>stat?{dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs),size:String(stat.size),mtimeNs:String(stat.mtimeNs)}:null;
// 活跃日志只核同一文件的稳定前缀；固定包、批准和任务输入仍走严格readBoundedFile。
function readReadinessLogPrefix(file,limit=2*1024*1024){
 sessionPath(file);const before=fs.lstatSync(file,{bigint:true});
 const ordinary=stat=>{if(!stat.isFile()||stat.nlink!==1n)fail('FILE_IDENTITY_INVALID','就绪日志必须为单硬链接普通文件。');};
 const sameIdentity=(left,right)=>left.dev===right.dev&&left.ino===right.ino&&left.birthtimeNs===right.birthtimeNs;
 ordinary(before);if(before.size>BigInt(limit))fail('FILE_TOO_LARGE','就绪日志超过有界读取上限。');
 const fd=fs.openSync(file,'r');let opened=null,afterDescriptor=null,afterPath=null;
 try{
  opened=fs.fstatSync(fd,{bigint:true});ordinary(opened);
  if(!sameIdentity(before,opened)||opened.size<before.size)fail('FILE_REPLACED','就绪日志打开时身份变化或长度缩短。');
  if(opened.size>BigInt(limit))fail('FILE_TOO_LARGE','就绪日志超过有界读取上限。');
  if(opened.size===before.size&&opened.mtimeNs!==before.mtimeNs)fail('FILE_CHANGED','就绪日志在无增长时发生修改。');
  const readPrefix=()=>{const bytes=Buffer.alloc(Number(opened.size));let offset=0;while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)fail('FILE_CHANGED','就绪日志前缀读取未完成。');offset+=count;}return bytes;};
  const bytes=readPrefix(),verified=readPrefix();
  if(!bytes.equals(verified))fail('FILE_CHANGED','就绪日志已读前缀发生变化。');
  sessionPath(file);afterDescriptor=fs.fstatSync(fd,{bigint:true});afterPath=fs.lstatSync(file,{bigint:true});
  for(const after of[afterDescriptor,afterPath]){ordinary(after);if(!sameIdentity(opened,after))fail('FILE_REPLACED','就绪日志读取期间被替换。');if(after.size<opened.size||after.size===opened.size&&after.mtimeNs!==opened.mtimeNs)fail('FILE_CHANGED','就绪日志截断或发生非追加修改。');if(after.size>BigInt(limit))fail('FILE_TOO_LARGE','就绪日志超过有界读取上限。');}
  // 尚未写完的末行不用于就绪判断，避免把半条标记提前当作完整宿主信号。
  const end=bytes.lastIndexOf(10)+1,complete=bytes.subarray(0,end);
  return{bytes:complete,byteLength:complete.length,sha256:sha256(complete),readObservation:{file,before:logStatValue(before),opened:logStatValue(opened),afterDescriptor:logStatValue(afterDescriptor),afterPath:logStatValue(afterPath),sampledByteLength:bytes.length,completePrefixBytes:complete.length,prefixRechecked:true,appendOnlyGrowthObserved:afterPath.size>opened.size}};
 }catch(error){
  // 诊断采样失败不能覆盖首个保护错误；路径重新过门禁后才取元数据，不读正文。
  try{afterDescriptor??=fs.fstatSync(fd,{bigint:true});}catch{}
  try{sessionPath(file);afterPath??=fs.lstatSync(file,{bigint:true});}catch{}
  Object.defineProperty(error,'fileReadObservation',{value:{file,before:logStatValue(before),opened:logStatValue(opened),afterDescriptor:logStatValue(afterDescriptor),afterPath:logStatValue(afterPath)},configurable:true});throw error;
 }
 finally{fs.closeSync(fd);}
}
function profileLogFiles(profileRoot){const root=sessionPath(path.join(profileRoot,'logs'),false);if(!fs.existsSync(root))return[];const files=[];for(const date of fs.readdirSync(root,{withFileTypes:true})){if(!/^\d{4}-\d{2}-\d{2}$/.test(date.name)||!date.isDirectory())continue;const folder=sessionPath(path.join(root,date.name));for(const entry of fs.readdirSync(folder,{withFileTypes:true})){if(!entry.isFile()||!entry.name.endsWith('.log'))continue;files.push(sessionPath(path.join(folder,entry.name)));if(files.length>256)fail('CONTROLLED_LOG_LIMIT','就绪日志来源超过有限范围。');}}return files;}
function profileLogSnapshot(profileRoot){return new Map(profileLogFiles(profileRoot).map(file=>{const stat=fs.statSync(file,{bigint:true});return[file,{size:Number(stat.size),ino:String(stat.ino),dev:String(stat.dev)}];}));}
export function observeControlledReadiness(profileRoot,baseline,pid){
 for(const file of profileLogFiles(profileRoot)){
  const previous=baseline.get(file),stat=fs.statSync(file,{bigint:true});if(previous&&(previous.ino!==String(stat.ino)||previous.dev!==String(stat.dev)||Number(stat.size)<previous.size))fail('CONTROLLED_LOG_CHANGED','既有日志身份或前缀边界改变。');if(Number(stat.size)===(previous?.size??0))continue;
  const read=readReadinessLogPrefix(file),start=previous?.size??0,text=read.bytes.subarray(start).toString('utf8'),lines=text.split(/\r?\n/).filter(line=>line.includes(`[pid=${pid}]`));
  const component=lines.findIndex(line=>line.includes('Loaded plugin components for content-creator@inline: 1 agent(s), 0 command(s), 5 skill(s), 0 hook(s), 0 MCP server(s), 0 LSP server(s), 0 output style(s)')),overlay=lines.findIndex(line=>line.includes('Settings agent: applied "content-creator" config (instructions/tools) onto default agent "cli"')),refresh=lines.findIndex(line=>line.includes('[PluginRuntime] refresh completed (startup), active=1, changed=true'));
  if(component<0||overlay<=component||refresh<=overlay)continue;
  if(lines.slice(component).some(line=>/\[PluginRuntime\].*(?:failed|degraded)|Settings agent:.*(?:not found|failed)/i.test(line)))fail('CONTROLLED_READINESS_DEGRADED','原插件或Agent在准入前发生降级。');
  return{file,startOffset:start,endOffset:read.byteLength,observedPrefixSha256:read.sha256,newBytesSha256:sha256(read.bytes.subarray(start)),cliPid:pid,componentLine:component+1,overlayLine:overlay+1,refreshLine:refresh+1,readObservation:read.readObservation,evidence:'same_process_host_configuration_only',providerBodyVerified:false};
 }return null;
}
function controlledReceipt(events,options){
 const{plan,readiness,stdin,failure,...rest}=options,legacy=parseMarketExpertEvents(events,{...rest,plan:{...plan,toolPolicyProfile:'market_expert_preview'}}),toolEvidence=inspectControlledMarketEvidence(events,{plan,audit:rest.audit});
 const reason=failure??toolEvidence.reason??legacy.reason,status=reason?(reason==='PLATFORM_RESULT_FAILED'?'failed':'unknown'):'succeeded',sessionId=events.find(event=>event.type==='system'&&event.subtype==='init')?.session_id;
 // 首轮须五动作，接续轮不重复start；只认可原生事件与成功代理审计的一一匹配。
 const requiredActions=plan.phase==='first'?MARKET_TASK_TOOLS:MARKET_TASK_TOOLS.filter(name=>name!=='start_task'),actualTaskReadAndSubmitObserved=!reason&&rest.audit?.verified===true&&requiredActions.every(name=>toolEvidence.execution.observedCalls.some(call=>call.name===`mcp__market_task__${name}`&&call.reason===null&&Number.isInteger(call.auditIndex)&&rest.audit.toolCalls[call.auditIndex]?.toolName===name));
 return{...legacy,contract:CONTRACT,status,reason,toolEvidence,readiness,stdin,actualTaskReadAndSubmitObserved,nativeTerminal:{observed:legacy.result!==null,subtype:legacy.result?.subtype??null,evidence:'native_protocol_report_only'},nativeBinding:status==='succeeded'?{contract:CONTRACT,sessionId,nativeFieldName:'session_id',modelId:plan.modelId,bindingSha256:plan.bindingSha256,status,evidenceLevel:rest.evidenceLevel}:null,protocolSucceeded:!reason,reportedModelBindingMatched:!reason&&legacy.reportedModelBindingMatched,expertRuntimeLoadedVerified:false,hostAgentConfigurationObserved:readiness.verified,modelIdentityVerified:false,modelExecutionVerified:false,businessCompletedVerified:false,safeToRetryOriginal:false};
}
function pngDimensions(bytes){
 if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')fail('REVIEW_PNG_INVALID','只接受具有PNG签名和IHDR的固定图片。');
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 if(!width||!height||width>4096||height>4096||width*height>8*1024*1024)fail('REVIEW_PNG_DIMENSIONS','PNG尺寸超过固定范围。');
 // 原型只接受8位RGB/RGBA静态非交错PNG，CRC和有界像素流另核；不加载图片库或外部解码器。
 const channels=bytes[25]===2?3:bytes[25]===6?4:0;
 if(bytes[24]!==8||!channels||bytes[26]||bytes[27]||bytes[28])fail('REVIEW_PNG_INVALID','PNG编码不在本原型的已审范围。');
 let cursor=8,count=0,ended=false,sawData=false,dataEnded=false;const compressed=[];
 while(cursor<bytes.length){
  if(++count>256||cursor+12>bytes.length)fail('REVIEW_PNG_INVALID','PNG块数量或边界无效。');
  const length=bytes.readUInt32BE(cursor),end=cursor+12+length;
  if(end>bytes.length)fail('REVIEW_PNG_INVALID','PNG块越界。');
  const type=bytes.toString('ascii',cursor+4,cursor+8);
  if(!/^[A-Za-z]{4}$/.test(type)||crc32(bytes.subarray(cursor+4,end-4))!==bytes.readUInt32BE(end-4))fail('REVIEW_PNG_INVALID','PNG块CRC或类型无效。');
  if(type==='IHDR'){if(cursor!==8||length!==13)fail('REVIEW_PNG_INVALID','PNG头重复或无效。');}
  else if(type==='IDAT'){if(dataEnded)fail('REVIEW_PNG_INVALID','PNG像素块必须连续。');sawData=true;compressed.push(bytes.subarray(cursor+8,end-4));}
  else if(type==='IEND'){if(length||!sawData||end!==bytes.length)fail('REVIEW_PNG_INVALID','PNG终块或尾部无效。');ended=true;}
  else{if(sawData)dataEnded=true;if(['acTL','fcTL','fdAT'].includes(type)||/^[A-Z]/.test(type)&&type!=='PLTE')fail('REVIEW_PNG_INVALID','PNG含动画或未知关键块。');}
  cursor=end;
 }
 if(!ended)fail('REVIEW_PNG_INVALID','PNG缺少终块。');
 const stride=width*channels+1,expected=stride*height;let decoded;
 try{decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});}catch{fail('REVIEW_PNG_INVALID','PNG像素流无效或超出尺寸。');}
 if(decoded.length!==expected)fail('REVIEW_PNG_INVALID','PNG像素流尺寸不同。');
 for(let row=0;row<height;row++)if(decoded[row*stride]>4)fail('REVIEW_PNG_INVALID','PNG扫描行滤波无效。');
 return{width,height};
}
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}


