import fs from 'node:fs';
import path from 'node:path';
import {fail,sha256} from './policy.mjs';
import {readBoundedFile,sessionPath} from './session-files.mjs';
import {preparedRootIdentity} from './collaboration-workspaces.mjs';
import {parseCollaborationArgs} from './collaboration-tools.mjs';

export const MARKET_MCP_NAME='market_task';
// 这里只是任务传输集合，不能证明原专家加载或完整依赖已经满足。
export const MARKET_TASK_TOOLS=Object.freeze(['get_capabilities','get_task','read_task_file','start_task','submit_task_result']);
export const MARKET_BUILTIN_DENY_TOOLS=Object.freeze([
 'Agent','Read','Write','Edit','Bash','PowerShell','Glob','Grep','EnterPlanMode','ExitPlanMode',
 'TaskCreate','TaskGet','TaskUpdate','TaskList','WebFetch','WebSearch','TaskStop','TaskOutput',
 'Skill','SkillManage','Component','Mods','AskUserQuestion','AskUserForStructuredInput','StructuredOutput',
 'ToolSearch','DeferExecuteTool','SendMessage','SendUserMessage','TeamCreate','TeamDelete','NotebookEdit','LSP',
 'ImageGen','LibraryUpload','VideoGen','AudioTranscribe','Artifact','ArtifactControl','EnterWorktree','LeaveWorktree',
 'CronCreate','CronDelete','CronList','WeChatReply','WeComReply','PushNotification','ReportFindings','ComputerUse',
 'ListMcpResources','ReadMcpResource','WaitForMcpServers','Workflow','Monitor','REPL','A2AGetAgentCard',
 'A2ASendMessage','A2AGetTask','A2ACancelTask','MessageColleague','SpeakInChannel','ChannelTasks',
 'CreateColleague','CreateChannel','ListColleagues'
]);
export const MARKET_TOOL_PROFILES=Object.freeze(['strict_mcp_only','market_expert_preview']);
const expectedTools=MARKET_TASK_TOOLS.map(name=>`mcp__${MARKET_MCP_NAME}__${name}`);
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const nameValid=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,159}$/.test(value);
const idValid=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const comparable=value=>process.platform==='win32'?value.toLowerCase():value;
const scopeKeys=['parent_tool_use_id','parent_session_id','agent_id','subagent_id','child_session_id','source','origin'];
export function assertMarketToolProfile(profile){
 if(!MARKET_TOOL_PROFILES.includes(profile))fail('MARKET_TOOL_PROFILE_INVALID','工具策略模式不在已审查集合内。');
 return profile;
}
export function marketRuntimeMinimumTools(){return{state:'unverified',blocked:true,taskTransportTools:[...expectedTools],taskTransportProvesExpertRuntime:false,candidateBuiltinTools:['Read','Skill'],actualDependenciesVerified:false};}

// 仅由可信计划调用，固定原包内一个定义；不接受事件自报的路径、SHA 或已批准标记。
export function prepareMarketPreviewCandidate(pluginRoot,pluginPins){
 const relativePath='skills/humanizer/SKILL.md',pin=pluginPins.find(item=>item.relativePath===relativePath);
 if(!pin)return null;
 const file=path.join(pluginRoot,...relativePath.split('/')),rootIdentity=preparedRootIdentity(pluginRoot),read=readBoundedFile(file,64*1024);
 if(read.sha256!==pin.sha256)fail('MARKET_PIN_CHANGED','可选定义与原包固定哈希不符。');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(read.bytes),header=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
 if(!header||!/^name:[ \t]*humanizer[ \t]*$/m.test(header))fail('MARKET_PREVIEW_SOURCE_INVALID','候选必须是原包固定的humanizer定义。');
 const hazards=/^(?:context|agent|hooks):/m.test(header)||/!`/.test(text);
 return{file,realPath:fs.realpathSync(file),pluginRoot,rootIdentity,identity:read.identity,sha256:read.sha256,byteLength:read.byteLength,lineCount:text.split(/\r?\n/).length,staticName:'humanizer',runtimeCanonicalName:null,inheritanceVerified:false,hazards};
}
function verifyCandidate(candidate){
 if(!candidate||candidate.hazards||candidate.runtimeCanonicalName!==null)return false;
 try{
  if(!same(preparedRootIdentity(candidate.pluginRoot),candidate.rootIdentity))return false;
  const expected=path.join(candidate.pluginRoot,'skills','humanizer','SKILL.md');
  if(candidate.file!==expected||comparable(fs.realpathSync(sessionPath(expected)))!==comparable(candidate.realPath))return false;
  const read=readBoundedFile(expected,64*1024);
  return same(read.identity,candidate.identity)&&read.sha256===candidate.sha256&&read.byteLength===candidate.byteLength;
 }catch{return false;}
}
export function evaluateMarketPreviewCall(name,input,{plan}={}){
 if(!plain(input))return{decision:'rejected',reason:'MARKET_CALL_ARGUMENT_INVALID'};
 if(expectedTools.includes(name)){
  const toolName=name.slice(`mcp__${MARKET_MCP_NAME}__`.length);let parsed;
  try{parsed=parseCollaborationArgs('member',toolName,input);}catch{return{decision:'rejected',reason:'MARKET_CALL_ARGUMENT_INVALID'};}
  const member=plan?.memberBinding;
  if(toolName!=='get_capabilities'&&(!member||parsed.groupId!==member.groupId||parsed.taskId!==member.taskId))return{decision:'rejected',reason:'MARKET_CALL_TASK_FORBIDDEN'};
  if(toolName==='read_task_file'&&(parsed.area!=='inputs'||!member.inputPaths.includes(parsed.relativePath)))return{decision:'rejected',reason:'MARKET_CALL_INPUT_FORBIDDEN'};
  return{decision:'task_transport_match',reason:null,permissionGranted:false};
 }
 const candidate=plan?.previewCandidate;
 if(!['Read','Skill'].includes(name))return{decision:'rejected',reason:'MARKET_CALL_FORBIDDEN'};
 if(!verifyCandidate(candidate))return{decision:'rejected',reason:'MARKET_PREVIEW_SOURCE_UNVERIFIED'};
 if(name==='Skill'){
  if(Object.keys(input).length!==1||input.skill!==candidate.staticName)return{decision:'rejected',reason:'MARKET_CALL_ARGUMENT_INVALID'};
  return{decision:'candidate_match',reason:'MARKET_SKILL_RUNTIME_SOURCE_UNVERIFIED',permissionGranted:false,runtimeCanonicalName:null};
 }
 if(!Object.hasOwn(input,'file_path')||Object.keys(input).some(key=>!['file_path','offset','limit'].includes(key)))return{decision:'rejected',reason:'MARKET_CALL_ARGUMENT_INVALID'};
 const file=input.file_path;
 if(typeof file!=='string'||!path.isAbsolute(file)||file!==path.resolve(file)||file.split(/[\\/]/).some(part=>part==='.'||part==='..')||file.startsWith('\\\\')||/[\x00-\x1f]/.test(file)||file.slice(path.parse(file).root.length).includes(':')||comparable(file)!==comparable(candidate.file))return{decision:'rejected',reason:'MARKET_CALL_PATH_FORBIDDEN'};
 // 安装版 offset/limit 的含义为行号/行数；文件字节上限由可信读取单独约束。
 for(const key of ['offset','limit'])if(Object.hasOwn(input,key)&&(!Number.isSafeInteger(input[key])||input[key]<1||input[key]>candidate.lineCount))return{decision:'rejected',reason:'MARKET_CALL_LINE_RANGE_INVALID'};
 const offset=input.offset??1,limit=input.limit??(candidate.lineCount-offset+1);
 if(offset+limit-1>candidate.lineCount)return{decision:'rejected',reason:'MARKET_CALL_LINE_RANGE_INVALID'};
 return{decision:'candidate_match',reason:'MARKET_PERMISSION_UNVERIFIED',permissionGranted:false,rangeUnit:'lines',offset,limit,fileByteLength:candidate.byteLength,fileByteLimit:64*1024};
}

// 事后协议分析不能保证工具副作用曾被事前阻止；所有真实权限/专家验收始终未取证。
export function inspectMarketToolEvidence(events,{plan,audit=null,profile=plan?.toolPolicyProfile??'strict_mcp_only'}={}){
 assertMarketToolProfile(profile);
 if(!Array.isArray(events)||events.length>4096||events.some(event=>!plain(event)))fail('MARKET_EVIDENCE_INVALID','只接受有界原生事件对象。');
 let reason=null,discoveryReason=null,catalog=null,initialCatalog=null,unsupportedToolUseContainers=0;const catalogs=[],calls=[],callIds=new Set(),consumed=new Set();
 const reject=code=>{reason??=code;};
 const rejectCatalog=code=>{discoveryReason??=code;reject(code);};
 const auditCalls=Array.isArray(audit?.toolCalls)?audit.toolCalls:[],auditIds=new Set();
 if(auditCalls.length>4096)reject('MCP_AUDIT_UNVERIFIED');
 for(const call of auditCalls){
  if(!plain(call)){reject('MCP_AUDIT_UNVERIFIED');continue;}
  if(Object.hasOwn(call,'jsonRpcId')){const key=JSON.stringify(call.jsonRpcId);if(call.jsonRpcId===null||auditIds.has(key))reject('MCP_AUDIT_UNVERIFIED');auditIds.add(key);}
 }
 const id=events.find(event=>event.type==='system'&&event.subtype==='init')?.session_id;
 for(const event of events){
  const hasUse=value=>plain(value)&&value.type==='tool_use'||Array.isArray(value)&&value.some(item=>plain(item)&&item.type==='tool_use');
  if(event.type==='tool_use'||hasUse(event.content)||hasUse(event.message)){unsupportedToolUseContainers++;reject('MARKET_TOOL_USE_ENVELOPE_UNSUPPORTED');}
  if(scopeKeys.some(key=>event[key]!==undefined&&event[key]!==null)||scopeKeys.some(key=>event.message?.[key]!==undefined&&event.message[key]!==null))reject('MARKET_CALL_SOURCE_UNVERIFIED');
  if(event.type==='system'&&event.subtype==='init'){
   const tools=event.tools;
   if(!Array.isArray(tools)||tools.length>128||tools.some(name=>!nameValid(name))||new Set(tools).size!==tools.length){rejectCatalog(profile==='strict_mcp_only'?'TOOL_SET_VIOLATION':'MARKET_CATALOG_INVALID');catalog=null;continue;}
   const valid=tools.every(name=>expectedTools.includes(name)||profile==='market_expert_preview'&&MARKET_BUILTIN_DENY_TOOLS.includes(name))&&expectedTools.every(name=>tools.includes(name));
   if(!valid)rejectCatalog(profile==='strict_mcp_only'?'TOOL_SET_VIOLATION':'MARKET_CATALOG_UNREVIEWED');
   const signature=[...tools].sort().join(',');if(initialCatalog!==null&&initialCatalog!==signature)rejectCatalog('MARKET_CATALOG_CHANGED');initialCatalog??=signature;
   catalog=new Set(tools);catalogs.push({tools:[...tools],total:tools.length,mcp:tools.filter(name=>name.startsWith('mcp__')).length,nonMcp:tools.filter(name=>!name.startsWith('mcp__')).length,configuredDenyNamesObserved:tools.filter(name=>MARKET_BUILTIN_DENY_TOOLS.includes(name))});
  }
  if(event.message?.content!==undefined&&(!Array.isArray(event.message.content)||event.message.content.length>4096)){reject('MARKET_EVIDENCE_INVALID');continue;}
  for(const use of event.message?.content??[]){
   if(!plain(use)||use.type!=='tool_use')continue;
   if(calls.length>=4096){reject('MARKET_EVIDENCE_INVALID');break;}
   let callReason=null;
   if(!idValid(use.id)||callIds.has(use.id))callReason='MARKET_CALL_ID_INVALID';else callIds.add(use.id);
   if(!nameValid(use.name)||!catalog?.has(use.name))callReason??='MARKET_CALL_NOT_DISCOVERED';
   if(event.type!=='assistant'||event.message.role!==undefined&&event.message.role!=='assistant'||event.session_id!==id||scopeKeys.some(key=>use[key]!==undefined&&use[key]!==null))callReason??='MARKET_CALL_SOURCE_UNVERIFIED';
   const decision=evaluateMarketPreviewCall(use.name,use.input,{plan});
   if(decision.decision==='rejected')callReason??=decision.reason;
   let auditIndex=null;
   if(expectedTools.includes(use.name)&&plain(use.input)){
    if(audit?.verified!==true)callReason??='MCP_AUDIT_UNVERIFIED';
    else{
     const digest=sha256(JSON.stringify(use.input)),toolName=use.name.slice(`mcp__${MARKET_MCP_NAME}__`.length);
     const index=auditCalls.findIndex((call,index)=>!consumed.has(index)&&plain(call)&&call.toolName===toolName&&call.argumentsSha256===digest);
     if(index<0)callReason??='MCP_AUDIT_UNVERIFIED';else{consumed.add(index);auditIndex=index;}
    }
   }else if(decision.decision!=='rejected')callReason??=decision.reason??'MARKET_PERMISSION_UNVERIFIED';
   if(callReason)reject(callReason);
   calls.push({callId:idValid(use.id)?use.id:null,name:nameValid(use.name)?use.name:null,decision:decision.decision,reason:callReason,auditIndex,source:'native_protocol_report_only',permissionGranted:false,verified:false,...(decision.rangeUnit?{rangeUnit:decision.rangeUnit,offset:decision.offset,limit:decision.limit,fileByteLength:decision.fileByteLength,fileByteLimit:decision.fileByteLimit}:{})});
  }
 }
 if(events.some(event=>event.type==='result')&&auditCalls.length!==consumed.size)reject('MCP_AUDIT_UNMATCHED_CALL');
 return{profile,reason,discovery:{status:catalogs.length&&!discoveryReason?'catalog_checked':'recorded_or_unknown',reason:discoveryReason,catalogs,listingProvesPermission:false,listingProvesExecution:false},permissions:{state:'pending',configuredAllow:[...expectedTools],configuredDeny:[...MARKET_BUILTIN_DENY_TOOLS],candidateBuiltinTools:['Read','Skill'],effectiveRuntimeVerified:false,cliParsingVerified:false,inheritanceVerified:false,osIsolationVerified:false,blockers:['EFFECTIVE_PERMISSIONS_UNVERIFIED','SKILL_SOURCE_AND_INHERITANCE_UNVERIFIED','PRE_EXECUTION_ENFORCEMENT_UNVERIFIED']},execution:{observedCalls:calls,unsupportedToolUseContainers,auditMatchesConsumed:consumed.size,matching:'one_to_one_name_and_arguments_digest',nativeCallIdCorrelatedWithRpcId:false,verified:false,posthocDetectionOnly:true,preExecutionPreventionVerified:false,absenceProvesNoExecution:false},expertRuntimeMinimumTools:marketRuntimeMinimumTools(),acceptance:{state:'pending',expertRuntimeLoadedVerified:false,executionVerified:false,businessCompletedVerified:false},launchAllowed:profile==='strict_mcp_only'?null:false,originalUnknownResolved:false,safeToRetry:false};
}
