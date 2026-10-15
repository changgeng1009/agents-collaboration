import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CollaborationStore } from '../bridge/src/collaboration-store.mjs';
import { CodeBuddyCollaborationProvider } from '../bridge/src/collaboration-provider.mjs';
import { executionFiles, CORE_EXECUTION_PENDING } from '../bridge/src/collaboration-execution.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const logDir=path.join(FIXTURE_ROOT,'logs','collaboration-execution-tests');fs.mkdirSync(logDir,{recursive:true});const checks=[];let counter=0;
const cliRoot=path.join(FIXTURE_ROOT,'fixture-cli');fs.mkdirSync(path.join(cliRoot,'bin'),{recursive:true});fs.mkdirSync(path.join(cliRoot,'dist'));
const cli=path.join(cliRoot,'bin','codebuddy'),bundle=path.join(cliRoot,'dist','codebuddy-headless.js');fs.copyFileSync(path.join(CODE_ROOT,'tests','codebuddy-protocol-fixture.cjs'),cli);fs.writeFileSync(bundle,'// local fixture only\n');fs.writeFileSync(path.join(cliRoot,'package.json'),JSON.stringify({type:'commonjs',fixture_only:true}));
const config={enabled:true,acceptedProductMode:true,nodeExecutable:process.execPath,nodeSha256:sha256(fs.readFileSync(process.execPath)),cliScript:cli,cliSha256:sha256(fs.readFileSync(cli)),headlessSha256:sha256(fs.readFileSync(bundle)),fileToolsEnabled:true,timeoutMs:20000};
const provider=new CodeBuddyCollaborationProvider({fixtureConfiguration:config});let store=new CollaborationStore({executionProvider:provider});const identities=new Map(),keys=new Map();
const check=(name,fn)=>{fn();checks.push({name,passed:true});};
const call=(who,name,args={})=>store.as(identities.get(who)).invoke(name,{...(name.startsWith('get_')||name.startsWith('list_')||name==='read_task_file'?{}:{requestId:`request_${++counter}`}),...args});
async function rejected(name,fn,code){await assert.rejects(fn,error=>error.code===code);checks.push({name,passed:true});}
async function finish(executionId,taskId){const deadline=Date.now()+20000;for(;;){const result=await call('agent_a','get_execution',{groupId:'fixture_group',taskId,executionId});if(!CORE_EXECUTION_PENDING.has(result.execution.state))return result.execution;if(Date.now()>deadline)throw new Error('受管fixture超出有界等待');await new Promise(resolve=>setTimeout(resolve,50));}}
async function task(taskId){return call('agent_a','create_task',{groupId:'fixture_group',taskId,title:'受管执行合成任务',assigneeId:'agent_a',participantIds:['agent_a','agent_b'],fileAcl:{readers:['agent_a'],writers:['agent_a'],inputWriters:['agent_a']}});}
const executionArgs=(taskId,text,nativeBindingId=null)=>({groupId:'fixture_group',taskId,operation:nativeBindingId?'send_to_conversation':'create_conversation',nativeBindingId,prompt:JSON.stringify({text,files:true})});
try{
 const admin=store.bootstrapAdmin();keys.set('admin',fs.readFileSync(admin.credentialFile,'utf8'));identities.set('admin',store.resolveCredential(keys.get('admin')));
 for(const[id,platform,mode]of[['agent_a','workbuddy','codebuddy_cli'],['agent_b','workbuddy','codebuddy_cli'],['doubao','doubao','desktop']]){const provisioned=store.provisionMember({instanceId:id,platform,mode});keys.set(id,fs.readFileSync(provisioned.credentialFile,'utf8'));identities.set(id,store.resolveCredential(keys.get(id)));}
 await call('admin','create_group',{groupId:'fixture_group',title:'无Codex成员执行组',memberIds:['agent_a','agent_b','doubao'],managerId:'agent_a',policy:{allowMemberTakeover:true}});
 await task('native_task');await call('agent_a','write_task_file',{groupId:'fixture_group',taskId:'native_task',area:'inputs',relativePath:'source.txt',text:'合成输入\uFEFF😀'});
 const first=await call('agent_a','request_execution',executionArgs('native_task','第一轮'));
 check('请求仅入队，不提升worker/平台/模型/业务阶段',()=>{assert.equal(first.execution.state,'requested');assert.equal(first.execution.workerStarted,false);assert.equal(first.execution.verifiedStages.modelStarted,false);assert.equal(first.execution.verifiedStages.businessCompleted,false);});
 const wakeArgs={requestId:'wake_once',groupId:'fixture_group',taskId:'native_task',executionId:first.execution.executionId};
 const[wake,duplicate]=await Promise.all([call('agent_a','wake_execution',wakeArgs),call('agent_a','wake_execution',wakeArgs)]);
 check('并发相同唤醒保留一次执行占位',()=>{assert.ok(duplicate.deduplicated||duplicate.execution.workerStarted===false);});
 const firstResult=await finish(first.execution.executionId,'native_task');
 check('独立core worker真实运行原生协议fixture与实时ACL文件MCP',()=>{assert.equal(firstResult.state,'succeeded',JSON.stringify(firstResult));assert.equal(firstResult.workerStarted,true);assert.equal(firstResult.platformProcessStarted,true);assert.equal(firstResult.evidenceLevel,'local_test');assert.equal(firstResult.verifiedStages.replyObserved,false);});
 const file=await call('agent_a','read_task_file',{groupId:'fixture_group',taskId:'native_task',area:'outputs',relativePath:'reply_1.txt'});
 check('受管处理产物实际文件读回',()=>assert.equal(file.text,'合成输入\uFEFF😀 | 第一轮'));
 const native=await call('agent_a','get_native_session',{groupId:'fixture_group',taskId:'native_task'});
 check('只有受管返回才登记controlled来源，fixture不标真实',()=>{assert.equal(native.native.sourceType,'controlled_adapter');assert.equal(native.native.nativeFieldName,'session_id');assert.equal(native.native.runtimeVerified,false);assert.equal(native.native.platformIdentityVerified,false);assert.equal(native.native.evidenceLevel,'local_test');});
 const beforeNative=native.native.nativeId;store.close();store=new CollaborationStore({executionProvider:new CodeBuddyCollaborationProvider({fixtureConfiguration:config})});store.bootstrapAdmin();for(const[who,key]of keys)identities.set(who,store.resolveCredential(key));
 const second=await call('agent_a','request_execution',executionArgs('native_task','第二轮',native.native.bindingId));await call('agent_a','wake_execution',{groupId:'fixture_group',taskId:'native_task',executionId:second.execution.executionId});const continued=await finish(second.execution.executionId,'native_task');
 check('DB重开后按原始编号实际第二轮续接与上下文连续',()=>{assert.equal(continued.state,'succeeded',JSON.stringify(continued));assert.ok(continued.replyText.includes('第一轮 / 第二轮'));});
 const afterNative=await call('agent_a','get_native_session',{groupId:'fixture_group',taskId:'native_task'});
 check('原生ID与任务cwd保持同一个原绑定',()=>{assert.equal(afterNative.native.nativeId,beforeNative);assert.equal(afterNative.native.bindingId,native.native.bindingId);assert.equal(afterNative.native.workspaceBinding,native.native.workspaceBinding);});
 const anotherRead=await call('agent_b','get_execution',{groupId:'fixture_group',taskId:'native_task',executionId:second.execution.executionId});
 check('无文件reader授权的参与者不能读模型回复正文',()=>{assert.equal(anotherRead.execution.replyText,null);assert.equal(anotherRead.execution.replyAccessAllowed,false);});
 await rejected('另一实例不能按猜到ID取用原生会话',()=>call('agent_b','get_native_session',{groupId:'fixture_group',taskId:'native_task'}),'NATIVE_NOT_FOUND');
 const root=store.get('task','fixture_group:native_task').workspace.taskRoot;
 check('两个明确执行各一次，没有并发重复副作用',()=>assert.equal(fs.readFileSync(path.join(root,'work','fixture-launches.jsonl'),'utf8').trim().split('\n').length,2));
 await task('cross_request');const cross=await call('agent_a','request_execution',executionArgs('cross_request','不能复用唤醒ID'));
 await rejected('同成员跨投递复用wake request拒绝',()=>call('agent_a','wake_execution',{...wakeArgs,taskId:'cross_request',executionId:cross.execution.executionId}),'REQUEST_ID_CONFLICT');
 await rejected('服务admin无唤醒工具',()=>call('admin','wake_execution',wakeArgs),'TOOL_FORBIDDEN');
 await call('agent_a','assign_task',{groupId:'fixture_group',taskId:'native_task',assigneeId:'agent_b',participantIds:['agent_a','agent_b'],fileAcl:{readers:['agent_a','agent_b'],writers:['agent_a','agent_b'],inputWriters:['agent_a']}});
 const reassigned=await call('agent_b','request_execution',executionArgs('native_task','新实例不能共享原上下文'));
 const reassignedWake=await call('agent_b','wake_execution',{groupId:'fixture_group',taskId:'native_task',executionId:reassigned.execution.executionId});
 check('换负责人不能借原task共享其它实例会话',()=>{assert.equal(reassignedWake.execution.state,'blocked');assert.equal(reassignedWake.execution.blocker.code,'EXECUTION_INSTANCE_BOUND');assert.equal(reassignedWake.execution.workerStarted,false);});
 await task('reported_native');const reportedTask=store.get('task','fixture_group:reported_native');
 const reported=await call('agent_a','register_native_session',{groupId:'fixture_group',taskId:'reported_native',platform:'workbuddy',mode:'codebuddy_cli',nativeFieldName:'session_id',nativeId:'untrusted_reference',storageKind:'local',storageLocation:null,cwd:reportedTask.workspace.cwd,sourceReceiptHash:'b'.repeat(64),source:'成员自报受管，不提升'});
 const reportedRequest=await call('agent_a','request_execution',executionArgs('reported_native','不启用自报原生',reported.native.bindingId));const denied=await call('agent_a','wake_execution',{groupId:'fixture_group',taskId:'reported_native',executionId:reportedRequest.execution.executionId});
 check('自报native不能作为真实受管续发的权限',()=>{assert.equal(denied.execution.state,'blocked');assert.equal(denied.execution.blocker.code,'NATIVE_UNVERIFIED');assert.equal(denied.execution.workerStarted,false);});
 await task('unknown_case');const unknown=await call('agent_a','request_execution',executionArgs('unknown_case','未知不重发'));
 store.tx(()=>{const intent=store.get('execution',unknown.execution.executionId);intent.state='worker_starting';intent.wakeReservedAt=new Date().toISOString();intent.deadline=0;store.put('execution',intent.executionId,intent);});
 const expired=await call('agent_a','get_execution',{groupId:'fixture_group',taskId:'unknown_case',executionId:unknown.execution.executionId});const noRetry=await call('agent_a','wake_execution',{groupId:'fixture_group',taskId:'unknown_case',executionId:unknown.execution.executionId});
 check('超期或owner未知不重新唤醒',()=>{assert.equal(expired.execution.state,'unknown');assert.equal(noRetry.execution.state,'unknown');});
 await rejected('unknown不通过新request重派',()=>call('agent_a','request_execution',executionArgs('unknown_case','另一个请求')),'EXECUTION_TASK_BUSY');
 await task('lease_acl');const leaseTask=store.get('task','fixture_group:lease_acl'),leaseId='fixture_lease_execution',leaseToken='L'.repeat(43);
 store.tx(()=>store.put('execution',leaseId,{executionId:leaseId,groupId:'fixture_group',taskId:'lease_acl',targetId:'agent_a',assignmentRevision:leaseTask.assignmentRevision,workspaceBinding:leaseTask.workspace.markerSha256,state:'platform_running',deadline:Date.now()+60000,leaseHash:sha256(leaseToken)}));
 const leaseFiles=executionFiles(store,leaseId,leaseToken);check('执行文件lease不授予普通消息身份',()=>{assert.equal(leaseFiles.capabilities().accountQueryEnabled,false);assert.equal(leaseFiles.invoke,undefined);});
 leaseFiles.write({area:'outputs',relativePath:'lease.txt',text:'有界写入'});
 await call('agent_a','set_task_acl',{groupId:'fixture_group',taskId:'lease_acl',fileAcl:{readers:['agent_b'],writers:['agent_b'],inputWriters:[]}});
 assert.throws(()=>leaseFiles.read({area:'outputs',relativePath:'lease.txt'}),error=>error.code==='FILE_ACL_FORBIDDEN');checks.push({name:'执行已发出的文件租约逐调用重核ACL吊销',passed:true});
 await task('crash_worker');await call('agent_a','write_task_file',{groupId:'fixture_group',taskId:'crash_worker',area:'inputs',relativePath:'source.txt',text:'无敏感退出样本'});
 const crash=await call('agent_a','request_execution',{...executionArgs('crash_worker','退出后不重发'),prompt:JSON.stringify({text:'退出样本',files:true,delayMs:5000})});
 await call('agent_a','wake_execution',{groupId:'fixture_group',taskId:'crash_worker',executionId:crash.execution.executionId});
 const until=Date.now()+10000;let running;
 do{running=await call('agent_a','get_execution',{groupId:'fixture_group',taskId:'crash_worker',executionId:crash.execution.executionId});if(running.execution.platformProcessStarted)break;if(Date.now()>until)throw new Error('fixture未开始');await new Promise(resolve=>setTimeout(resolve,50));}while(true);
 const processRecord=store.get('execution',crash.execution.executionId);process.kill(processRecord.workerPid);await new Promise(resolve=>setTimeout(resolve,150));
 const crashed=await call('agent_a','get_execution',{groupId:'fixture_group',taskId:'crash_worker',executionId:crash.execution.executionId});
 check('真实fixture worker退出保留可能副作用的unknown',()=>{assert.equal(crashed.execution.state,'unknown');assert.equal(crashed.execution.platformProcessStarted,true);});
 const crashRepeat=await call('agent_a','wake_execution',{groupId:'fixture_group',taskId:'crash_worker',executionId:crash.execution.executionId});
 check('退出后再次唤醒不补发',()=>assert.equal(crashRepeat.execution.state,'unknown'));
 try{process.kill(processRecord.platformPid);}catch{}
 await call('agent_a','assign_task',{groupId:'fixture_group',taskId:'crash_worker',assigneeId:'agent_b',participantIds:['agent_a','agent_b'],fileAcl:{readers:['agent_a','agent_b'],writers:['agent_a','agent_b'],inputWriters:['agent_a']}});
 await rejected('换负责人不清除unknown副作用占位',()=>call('agent_b','request_execution',executionArgs('crash_worker','不能重派')),'EXECUTION_TASK_BUSY');
 await call('agent_a','set_task_acl',{groupId:'fixture_group',taskId:'lease_acl',fileAcl:{readers:['agent_a'],writers:['agent_a'],inputWriters:[]}});
 check('恢复明确ACL后同租约仅在原scope可读',()=>assert.equal(leaseFiles.read({area:'outputs',relativePath:'lease.txt'}).text,'有界写入'));
 await call('admin','revoke_member',{instanceId:'agent_a'});
 assert.throws(()=>leaseFiles.read({area:'outputs',relativePath:'lease.txt'}),error=>error.code==='MEMBER_UNAVAILABLE');checks.push({name:'成员显式吊销同时使受管文件租约失效',passed:true});
 const summary={status:'passed',checks,source:'controlled_local_fixture_not_official_platform',fixtureRoot:FIXTURE_ROOT,officialModelsStarted:0,officialPlatformCalls:0,actualCodexApplicationClosed:false,logDir};fs.writeFileSync(path.join(logDir,'summary.json'),JSON.stringify(summary,null,2),'utf8');console.log(JSON.stringify({status:'passed',checks:checks.length,summaryPath:path.join(logDir,'summary.json'),officialPlatformCalls:0},null,2));
}catch(error){fs.writeFileSync(path.join(logDir,'failure.json'),JSON.stringify({message:error.message,code:error.code,stack:error.stack,checks},null,2),'utf8');console.error(error);process.exitCode=1;}finally{store.close();}
