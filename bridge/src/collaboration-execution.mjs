import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fail, sha256 } from './policy.mjs';
import { SessionFiles } from './session-files.mjs';
import { coreText } from './collaboration-store.mjs';

export const CORE_EXECUTION_PENDING=new Set(['wake_reserved','worker_starting','worker_ready','wake_attempting','platform_running']);
const now=()=>new Date().toISOString();
export function executionContext(store,intent){
 const task=store.get('task',`${intent.groupId}:${intent.taskId}`),member=store.member(intent.targetId),group=store.get('group',intent.groupId);
 if(group.members[member.instanceId]?.state!=='active'||task.assigneeId!==member.instanceId||task.assignmentRevision!==intent.assignmentRevision||task.workspace?.markerSha256!==intent.workspaceBinding)fail('EXECUTION_BINDING_CHANGED','组成员、负责人、原目录或任务版本已经变化。');
 new SessionFiles({workspace:task.workspace,scope:task.scope});
 const native=store.get('native',`${intent.groupId}:${intent.taskId}:${member.instanceId}`,false);
 if(intent.operation==='send_to_conversation'&&(!native||native.bindingId!==intent.nativeBindingId||native.workspaceBinding!==intent.workspaceBinding))fail('NATIVE_BINDING_MISMATCH','续发必须使用本组、本任务和当前实例原始绑定。');
 return{member,task,intent,native,store};
}
export function assertExecutionLease(store,executionId,token,{workerOnly=false}={}){
 const intent=store.get('execution',executionId);
 if(typeof token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(token)||!intent.leaseHash||!timingSafeEqual(Buffer.from(intent.leaseHash,'hex'),Buffer.from(sha256(token),'hex'))||!CORE_EXECUTION_PENDING.has(intent.state)||Date.now()>intent.deadline||(workerOnly&&intent.workerPid!==process.pid))fail('EXECUTION_LEASE_INVALID','一次执行租约、状态或进程绑定失效。');
 return executionContext(store,intent);
}
function view(store,identity,intent){const task=store.task(identity,intent.groupId,intent.taskId);const canReadReply=task.fileAcl.readers.includes(identity.instanceId);return{executionId:intent.executionId,groupId:intent.groupId,taskId:intent.taskId,targetId:intent.targetId,requestedBy:intent.requestedBy,operation:intent.operation,state:intent.state,blocker:intent.blocker??null,
  workerStarted:intent.workerStarted===true,platformProcessStarted:intent.platformProcessStarted===true,wakeAttempt:intent.platformProcessStarted?'process_started':intent.launchIntentRecorded?'intent_recorded_outcome_unknown':'not_attempted',
  verifiedStages:{platformIdentity:false,modelStarted:false,replyObserved:intent.evidenceLevel==='real_runtime'&&intent.state==='succeeded'&&!!intent.replyText?.length,businessCompleted:false},
  agentReportedStage:task.agentReported,evidenceLevel:intent.evidenceLevel??'not_executed',nativeBindingId:intent.resultNativeBindingId??intent.nativeBindingId??null,
  replyText:canReadReply?intent.replyText??[]:null,replyAccessAllowed:canReadReply,automaticRetry:false,automaticReassignment:false,fileWorkerOsIsolationVerified:false,platformOsIsolationVerified:false};}
function requireOperator(store,identity,task){const group=store.group(identity,task.groupId);if(identity.instanceId!==task.assigneeId&&group.managerId!==identity.instanceId)fail('EXECUTION_OPERATOR_REQUIRED','只有当前负责人或有任务权限的组 manager 可安排执行。');}
export async function executionOperation(store,identity,name,args){
 const task=store.task(identity,args.groupId,args.taskId);if(name!=='get_execution')requireOperator(store,identity,task);
 if(name==='request_execution')return store.perform(identity,name,args,()=>{
  coreText(args.prompt);if(!task.workspace||!task.scope)fail('WORKSPACE_NOT_READY','任务目录尚未就绪。');
  if(store.list('execution').some(item=>item.groupId===args.groupId&&item.taskId===args.taskId&&(item.state==='requested'||item.state==='unknown'||CORE_EXECUTION_PENDING.has(item.state))))fail('EXECUTION_TASK_BUSY','任务已有排队、在途或未知执行，负责人变更不能清除占位。');
  if(args.operation==='create_conversation'&&args.nativeBindingId!==null)fail('NATIVE_BINDING_INVALID','创建不能传入旧原生绑定。');
  const native=store.get('native',`${args.groupId}:${args.taskId}:${task.assigneeId}`,false);
  if(args.operation==='send_to_conversation'&&(!native||native.bindingId!==args.nativeBindingId))fail('NATIVE_BINDING_MISMATCH','原生绑定不属于该任务当前实例。');
  const intent={executionId:randomUUID(),groupId:args.groupId,taskId:args.taskId,targetId:task.assigneeId,requestedBy:identity.instanceId,operation:args.operation,prompt:args.prompt,nativeBindingId:args.nativeBindingId,assignmentRevision:task.assignmentRevision,workspaceBinding:task.workspace.markerSha256,state:'requested',requestedAt:now(),workerStarted:false,platformProcessStarted:false};store.put('execution',intent.executionId,intent);store.event(identity,name,args.groupId,{taskId:args.taskId,executionId:intent.executionId,origin:'infrastructure_request'});return{execution:view(store,identity,intent)};
 });
 const intent=store.get('execution',args.executionId);if(intent.groupId!==args.groupId||intent.taskId!==args.taskId)fail('EXECUTION_FORBIDDEN','执行编号不属于该组任务。');
 if(name==='get_execution'){
  if(CORE_EXECUTION_PENDING.has(intent.state)){
   let gone=false;try{process.kill(intent.workerPid??intent.ownerPid,0);}catch(error){gone=error.code==='ESRCH';}
   if(gone||Date.now()>intent.deadline)store.tx(()=>{const current=store.get('execution',intent.executionId);if(CORE_EXECUTION_PENDING.has(current.state)){current.state='unknown';current.blocker={code:gone?'EXECUTION_OWNER_EXITED':'EXECUTION_LEASE_EXPIRED',message:'保留原执行，不自动重新投递。'};store.put('execution',current.executionId,current);store.event(identity,'execution_unknown',args.groupId,{executionId:current.executionId});}});
  }
  return{execution:view(store,identity,store.get('execution',intent.executionId))};
 }
 return store.perform(identity,name,args,()=>{
  const current=store.get('execution',intent.executionId),wakeKey=`${identity.instanceId}:${args.requestId}`,previous=store.db.prepare('SELECT * FROM core_wake_requests WHERE request_id=?').get(wakeKey);
  if(previous&&previous.execution_id!==current.executionId)fail('WAKE_REQUEST_CONFLICT','唤醒编号已绑定其它执行。');
  if(!previous)store.db.prepare('INSERT INTO core_wake_requests VALUES(?,?,?)').run(wakeKey,current.executionId,identity.instanceId);
  if(current.wakeReservedAt)return{execution:view(store,identity,current),deduplicated:true};
  let context,plan;
  try{
   context=executionContext(store,current);if(context.member.platform==='claude')fail('CLAUDE_PAUSED','Claude 正式执行保持暂停。');
   if(context.member.platform==='doubao')fail('DOUBAO_CONTRACT_UNAVAILABLE','豆包正式创建、续发、读取和被动唤醒契约未取得。');
   if(context.task.executionOwnerId&&context.task.executionOwnerId!==context.member.instanceId)fail('EXECUTION_INSTANCE_BOUND','原执行上下文属于其它实例，负责人变更不共享会话。');
   if(current.operation==='create_conversation'&&context.native)fail('NATIVE_ALREADY_BOUND','当前实例已登记原生绑定，不自动重新创建。');
   if(current.operation==='send_to_conversation'&&context.native.sourceType!=='controlled_adapter')fail('NATIVE_UNVERIFIED','成员自报的原生编号不能直接提升为受管续接权限。');
   if(!store.executionProvider)fail('PROVIDER_NOT_CONFIGURED','未通过可信启动选择正式执行 provider；当前只支持主动读取。');
   plan=store.executionProvider.preflight(context);
  }catch(error){current.state='blocked';current.blocker={code:error.code??'PROVIDER_PREFLIGHT_FAILED',message:error.code?error.message:'正式执行前检失败。'};store.put('execution',current.executionId,current);store.event(identity,'execution_blocked',args.groupId,{executionId:current.executionId,code:current.blocker.code});return{execution:view(store,identity,current)};}
  const token=randomBytes(32).toString('base64url');current.state='wake_reserved';current.wakeReservedAt=now();current.ownerPid=process.pid;current.leaseHash=sha256(token);current.deadline=Date.now()+(plan.timeoutMs??300000)+60000;current.blocker=null;current.evidenceLevel=plan.evidenceLevel;
  context.task.executionOwnerId??=current.targetId;store.put('task',`${args.groupId}:${args.taskId}`,context.task);store.put('execution',current.executionId,current);store.event(identity,'wake_reserved',args.groupId,{executionId:current.executionId});
  return{execution:view(store,identity,current),afterCommit:async()=>{
   try{await store.executionProvider.dispatch({...context,intent:current,token,plan});}
   catch(error){store.tx(()=>{const record=store.get('execution',current.executionId);if(CORE_EXECUTION_PENDING.has(record.state)){record.state='unknown';record.blocker={code:error.code??'PROVIDER_DISPATCH_UNKNOWN',message:'投递结果未知，不自动重试。'};store.put('execution',record.executionId,record);}});}
   return{execution:view(store,identity,store.get('execution',current.executionId))};
  }};
 });
}
export function updateExecutionFromProvider(store,executionId,token,state,details={}){
 return store.tx(()=>{const context=assertExecutionLease(store,executionId,token,{workerOnly:true}),intent=context.intent;
  if(state==='wake_attempting')intent.launchIntentRecorded=true;
  if(state==='platform_running'){intent.platformProcessStarted=true;intent.platformPid=details.pid;}
  intent.state=state;intent.evidenceLevel=details.evidenceLevel??intent.evidenceLevel;
  if(details.result){intent.replyText=details.result.replies??[];intent.providerResult=details.result;intent.finishedAt=now();
   if(state==='succeeded'&&details.result.conversationId){const key=`${intent.groupId}:${intent.taskId}:${intent.targetId}`,old=store.get('native',key,false);if(old&&old.nativeId!==details.result.conversationId){intent.state='unknown';intent.blocker={code:'NATIVE_BINDING_CONFLICT',message:'实际原生编号与原绑定不一致。'};}
    else{const native={bindingId:old?.bindingId??randomUUID(),groupId:intent.groupId,taskId:intent.taskId,instanceId:intent.targetId,platform:context.member.platform,mode:context.member.mode,nativeFieldName:'session_id',nativeId:details.result.conversationId,conversationId:details.result.conversationId,sourceType:'controlled_adapter',source:details.result.idSource,sourceReceiptHash:details.receiptHash,workspaceBinding:intent.workspaceBinding,cwd:context.task.workspace.cwd,storageKind:'local',storageLocation:null,evidenceLevel:intent.evidenceLevel,runtimeVerified:intent.evidenceLevel==='real_runtime',platformIdentityVerified:false,previousReport:old?.sourceType==='member_reported'?old:null,createdAt:old?.createdAt??now()};store.put('native',key,native);intent.resultNativeBindingId=native.bindingId;}
   }
  }
  store.put('execution',executionId,intent);store.event({instanceId:'infrastructure_provider',kind:'trusted_provider'},'provider_state',intent.groupId,{executionId,state:intent.state,onBehalfOf:intent.targetId});return intent;
 });
}
export function executionFiles(store,executionId,token){
 const context=()=>assertExecutionLease(store,executionId,token);
 return{capabilities(){const{intent}=context();return{tools:['get_capabilities','read_task_file','write_task_file'],instanceId:intent.targetId,groupId:intent.groupId,taskId:intent.taskId,scope:'current_group_task_acl',accountQueryEnabled:false,shellEnabled:false,inputsReadOnly:true,fileWorkerOsIsolationVerified:false,platformOsIsolationVerified:false};},
  read(args){const{task,intent}=context();if(!task.fileAcl.readers.includes(intent.targetId))fail('FILE_ACL_FORBIDDEN','执行实例当前没有文件读取权限。');const result=new SessionFiles({workspace:task.workspace,scope:task.scope}).read(args);context();return{...result,taskId:intent.taskId,groupId:intent.groupId};},
  write(args){const{task,intent}=context();if(!task.fileAcl.readers.includes(intent.targetId)||!task.fileAcl.writers.includes(intent.targetId)||args.area==='inputs')fail('FILE_ACL_FORBIDDEN','执行实例当前无此区域写权限。');const result=new SessionFiles({workspace:task.workspace,scope:task.scope}).write(args);context();store.tx(()=>store.event({instanceId:'infrastructure_provider',kind:'trusted_provider'},'delegated_file_write',intent.groupId,{taskId:intent.taskId,onBehalfOf:intent.targetId,sha256:result.sha256}));return{...result,taskId:intent.taskId,groupId:intent.groupId};}
 };
}
