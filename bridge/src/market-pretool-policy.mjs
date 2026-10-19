import {MARKET_BUILTIN_DENY_TOOLS,MARKET_TASK_TOOLS,evaluateMarketPreviewCall} from './market-tool-policy.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const rejected=reason=>({decision:'rejected',reason,candidateMatch:false,permissionGranted:false,launchAllowed:false});
const pending=()=>({decision:'offline_candidate',reason:'MARKET_REVIEW_OFFLINE_ONLY',candidateMatch:true,permissionGranted:false,launchAllowed:false});

// 只分析合成/已收集的协议对象；不安装Hook、不调用SDK，也不声称官方宿主采用本归约。
export function inspectMarketPretoolOutcomes(protocol,outcomes){
 const result={evidenceKind:'offline_protocol_analysis',protocol,candidateMatch:false,launchAllowed:false,permissionGranted:false,actualHostEnforcementVerified:false};
 if(!['command','sdk','mods'].includes(protocol)||!Array.isArray(outcomes)||!outcomes.length||outcomes.length>16)return{...result,reason:'PRETOOL_PROTOCOL_INVALID'};
 for(const item of outcomes){
  if(!plain(item)||Object.keys(item).some(key=>!['exitCode','output','error','timedOut','cancelled'].includes(key))||item.error||item.timedOut||item.cancelled||!plain(item.output))return{...result,reason:'PRETOOL_INCOMPLETE_OR_FAILED'};
  const output=item.output;
  if(protocol==='command'&&item.exitCode!==0||protocol!=='command'&&item.exitCode!==undefined||output.async!==undefined||output.continue===false||output.decision!==undefined)return{...result,reason:'PRETOOL_CONFLICT_OR_ASYNC'};
  if(protocol==='mods'){
   if(Object.keys(output).length!==1||output.allow!==true)return{...result,reason:'PRETOOL_DECISION_REJECTED'};
  }else{
   if(Object.keys(output).length!==1||!plain(output.hookSpecificOutput)||Object.keys(output.hookSpecificOutput).sort().join(',')!=='hookEventName,permissionDecision'||output.hookSpecificOutput.hookEventName!=='PreToolUse'||output.hookSpecificOutput.permissionDecision!=='allow')return{...result,reason:'PRETOOL_DECISION_REJECTED'};
  }
 }
 return{...result,candidateMatch:true,reason:'HOST_COVERAGE_UNVERIFIED'};
}

// context 和 plan 只由可信宿主传入；模型参数不得含actor/root/source/ACL。
// 即使匹配，也只是离线候选，不能生成实际运行许可。
export function evaluateMarketReviewPretool(name,input,{plan,context}={}){
 if(MARKET_BUILTIN_DENY_TOOLS.includes(name))return rejected(name==='Skill'?'SKILL_RUNTIME_BOUNDARY_UNVERIFIED':'NATIVE_TOOL_REMAINS_DENIED');
 if(MARKET_TASK_TOOLS.some(tool=>name===`mcp__market_task__${tool}`)){
  const checked=evaluateMarketPreviewCall(name,input,{plan});return checked.decision==='task_transport_match'?pending():rejected(checked.reason);
 }
 if(name!=='read_review_frame')return rejected('MARKET_REVIEW_TOOL_FORBIDDEN');
 if(!plain(input)||Object.keys(input).length!==1||typeof input.frameId!=='string')return rejected('MARKET_REVIEW_ARGUMENT_INVALID');
 if(!plan||!plain(context)||Object.keys(context).sort().join(',')!=='artifactId,groupId,instanceId,taskId'||!['instanceId','groupId','taskId'].every(key=>context[key]===plan.member?.[key])||context.artifactId!==plan.source?.artifactId)return rejected('MARKET_REVIEW_SCOPE_MISMATCH');
 if(!Array.isArray(plan.frames)||!plan.frames.some(frame=>frame.frameId===input.frameId))return rejected('MARKET_REVIEW_FRAME_FORBIDDEN');
 return pending();
}
