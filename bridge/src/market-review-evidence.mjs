import {fail} from './policy.mjs';
import {marketRuntimeMinimumTools} from './market-tool-policy.mjs';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);

// 参数是宿主准备的审查基线，claims 仅是待核声明；本模块没有提升声明的权限。
export function assessMarketReviewEvidence(plan,claims={}){
 if(!exact(plan,['original','modelId','groupId','taskId','instanceId','requiredSkills'])||
  ![plan.modelId,plan.groupId,plan.taskId,plan.instanceId].every(id)||
  !exact(plan.original,['requestId','sessionId','intent','status','intentSha256'])||
  ![plan.original.requestId,plan.original.sessionId,plan.original.intent].every(id)||
  !['unknown','unverified','failed','succeeded'].includes(plan.original.status)||!digest(plan.original.intentSha256)||
  !Array.isArray(plan.requiredSkills)||plan.requiredSkills.length>16||plan.requiredSkills.some(skill=>!id(skill))||new Set(plan.requiredSkills).size!==plan.requiredSkills.length||!plain(claims))fail('MARKET_REVIEW_BASELINE_INVALID','离线审查必须保留有界原请求、指定模型和可信任务基线。');
 const blockers=['MARKET_REVIEW_OFFLINE_ONLY','ORIGINAL_REQUEST_DISPOSITION_UNVERIFIED','ACTUAL_PERMISSIONS_UNVERIFIED','PRE_EXECUTION_ENFORCEMENT_UNVERIFIED','EXPERT_RUNTIME_LOAD_UNVERIFIED','MODEL_MEDIA_INPUT_UNVERIFIED'];
 if(plan.requiredSkills.length)blockers.push('REQUIRED_SKILL_RUNTIME_LOAD_UNVERIFIED');
 const intentConflict=claims.intent!==undefined&&claims.intent!==plan.original.intent;
 if(intentConflict)blockers.push('ORIGINAL_INTENT_CONFLICT');
 if(claims.modelId!==undefined&&claims.modelId!==plan.modelId)blockers.push('MODEL_ID_MISMATCH');
 if(claims.round!==undefined&&(!Number.isSafeInteger(claims.round)||claims.round<1||claims.round>2))blockers.push('REVIEW_ROUND_FORBIDDEN');
 if(['requestId','sessionId','taskId'].some(key=>claims[key]!==undefined&&claims[key]!==({requestId:plan.original.requestId,sessionId:plan.original.sessionId,taskId:plan.taskId})[key]))blockers.push('NEW_ID_DOES_NOT_RESOLVE_ORIGINAL');
 return{state:'preview_only',original:structuredClone(plan.original),binding:{modelId:plan.modelId,groupId:plan.groupId,taskId:plan.taskId,instanceId:plan.instanceId},intentConflict,claimsTrusted:false,
  discovery:{state:'unverified',listingProvesLoading:false},permissions:{state:'pending',effectiveRuntimeVerified:false,osIsolationVerified:false},
  loading:{actualExpertLoaded:'unknown',actualRequiredSkillsLoaded:'unknown',requiredSkills:[...plan.requiredSkills],definitionReadProvesSkillExecution:false},
  media:{actualModelImagesRead:'unknown',nativeVideoInput:'unknown',nativeAudioInput:'unknown',brokerReturnProvesModelRead:false},
  execution:{state:'unverified',sameSuccessfulSessionVerified:false},expertRuntimeMinimumTools:marketRuntimeMinimumTools(),blockers,
  launchAllowed:false,actualPermissionsApproved:false,originalUnknownResolved:false,safeToRetry:false,businessCompletedVerified:false};
}

// 此离线增量没有任何可被配置、证据对象或新ID打开的运行分支。
export function assertMarketReviewRunAllowed(){fail('MARKET_REVIEW_OFFLINE_ONLY','评审证据与PNG原型仅供离线审查，不能启动或恢复真实执行。');}
