import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 真OS测试必须明确选择新任务父根和已审查二进制；缺少前提不模拟通过。
const codeRoot=path.resolve(fileURLToPath(new URL('../',import.meta.url)));
const parent=process.env.COLLAB_WINDOWS_ISOLATION_TEST_PARENT,configurationFile=process.env.COLLAB_WINDOWS_FILE_HOST_CONFIG;
if(process.platform!=='win32'||!parent||!configurationFile){console.log(JSON.stringify({status:'blocked',code:'WINDOWS_OS_TEST_PREREQUISITES_REQUIRED',simulated:false,workerOsIsolationVerified:false,platformOsIsolationVerified:false}));process.exitCode=2;}
else{
 const realParent=fs.realpathSync(parent);assert.equal(path.basename(realParent).toLowerCase(),'task-workspaces');
 const fixtureRoot=path.join(realParent,`T10_MCP_OS_${randomUUID().replaceAll('-','')}`);fs.mkdirSync(fixtureRoot);
 process.env.COLLAB_PROJECT_ROOT=fixtureRoot;process.env.COLLAB_TEST_MODE='1';
 const {CollaborationStore}=await import('../bridge/src/collaboration-store.mjs');
 const {startCollaborationService}=await import('../bridge/src/collaboration-service.mjs');
 const {WindowsTaskFiles}=await import('../bridge/src/windows-task-files.mjs');
  const {executionFiles}=await import('../bridge/src/collaboration-execution.mjs');
 const {sha256}=await import('../bridge/src/policy.mjs');
 const {Client}=await import('../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
 const {StreamableHTTPClientTransport}=await import('../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
 const logDir=path.join(codeRoot,'logs/executor/T10-INDEPENDENT-EXECUTION-20261018',`mcp-os-${randomUUID()}`);fs.mkdirSync(logDir,{recursive:true});
 const checks=[],clients=[];let service;
 const check=async(name,fn)=>{await fn();checks.push({name,passed:true});};let counter=0;
 async function connect(key){const client=new Client({name:'isolated_mcp_file_worker_fixture',version:'0.2.4'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL(service.service.endpoint),{requestInit:{headers:{Authorization:`Bearer ${key}`}}}));return client;}
 async function call(peer,name,args={}){const result=await peer.callTool({name,arguments:{...(!name.startsWith('get_')&&!name.startsWith('read_')?{requestId:`fixture_${++counter}`} : {}),...args}});const output=result.structuredContent??JSON.parse(result.content[0].text);if(result.isError)throw Object.assign(new Error(output.message),{code:output.code});return output;}
 const rejected=(fn,code)=>assert.rejects(fn,error=>{assert.equal(error.code,code);return true;});
 try{
  service=await startCollaborationService({port:0});const admin=await connect(fs.readFileSync(service.service.adminKeyFile,'utf8'));
  const a=await call(admin,'provision_member',{instanceId:'fixture_a',platform:'fixture',mode:'desktop'}),b=await call(admin,'provision_member',{instanceId:'fixture_b',platform:'fixture',mode:'desktop'});
  const alpha=await connect(fs.readFileSync(a.credentialFile,'utf8')),beta=await connect(fs.readFileSync(b.credentialFile,'utf8'));
  await call(admin,'create_group',{groupId:'os_group',title:'仅合成文件OS边界',memberIds:['fixture_a','fixture_b'],managerId:'fixture_a',policy:{allowMemberTakeover:false}});
  const binding={groupId:'os_group',taskId:'os_task'};
  await call(alpha,'create_task',{...binding,title:'新任务文件worker',assigneeId:'fixture_a',participantIds:['fixture_a','fixture_b'],fileAcl:{readers:['fixture_a'],writers:['fixture_a'],inputWriters:['fixture_a']}});
  const originalInput='合成输入\uFEFF😀';await call(alpha,'write_task_file',{...binding,area:'inputs',relativePath:'source.txt',text:originalInput});
  const task=service.store.get('task','os_group:os_task'),configuration=JSON.parse(fs.readFileSync(configurationFile,'utf8'));
  const worker=new WindowsTaskFiles({...configuration,allowedWorkspaceParent:path.join(fixtureRoot,'task-workspaces'),profileCreationAccepted:true});
  const prepared=worker.prepareTask(task);service.store.fileWorker=worker;
  await check('只在本轮新任务准备唯一AppContainer，没有自动模型执行',()=>{assert.equal(prepared.prepared,true);assert.equal(prepared.workerOsIsolationVerified,false);assert.equal(service.service.automaticModelExecutionEnabled,false);assert.ok(task.workspace.cwd.startsWith(fixtureRoot));});
  await check('同任务准备意图不可重用或自动重建profile',()=>assert.throws(()=>worker.prepareTask(task),error=>error.code==='FILE_OS_ALREADY_RESERVED'));
  const input=await call(alpha,'read_task_file',{...binding,area:'inputs',relativePath:'source.txt'});
  await check('实际HTTP MCP读取通过受限原生worker并独立读回',()=>{assert.equal(input.text,originalInput);assert.equal(input.sha256,sha256(Buffer.from(originalInput)));assert.equal(input.fileWorkerOsIsolationVerified,true);assert.equal(input.osEvidence.isAppContainer,true);assert.equal(input.osEvidence.integritySid,'S-1-16-4096');assert.equal(input.osEvidence.capabilityCount,0);assert.equal(input.platformOsIsolationVerified,false);});
  const written=await call(alpha,'write_task_file',{...binding,area:'outputs',relativePath:'result.txt',text:'受限worker实际写入😀'});
  await check('实际HTTP MCP写入由OS worker CREATE_NEW完成且broker核对hash',()=>{assert.equal(written.created,true);assert.equal(written.overwritten,false);assert.equal(written.fileWorkerOsIsolationVerified,true);assert.equal(written.sha256,sha256(fs.readFileSync(path.join(task.workspace.outputs,'files/result.txt'))));});
  await check('32KiB正文不依赖Windows命令行长度，走只读请求帧',async()=>{const text='中'.repeat(10922)+'ab';assert.equal(Buffer.byteLength(text),32768);const result=await call(alpha,'write_task_file',{...binding,area:'work',relativePath:'max.txt',text});assert.equal(result.byteLength,32768);assert.equal((await call(alpha,'read_task_file',{...binding,area:'work',relativePath:'max.txt'})).text,text);});
  await check('绕过路径过滤：父子进程验证默认ACL外部合成文件、broker控制文件/合成DB凭据与只读runtime/frames',()=>{
   const fixed=worker.binding(task.workspace);
   const defaultDirectory=path.join(fixtureRoot,'default-acl-canary');fs.mkdirSync(defaultDirectory);const defaultFile=path.join(defaultDirectory,'outside.txt');fs.writeFileSync(defaultFile,'仅本轮默认继承ACL的合成文件');
   const frame=fs.readdirSync(path.join(fixed.directory,'frames')).find(name=>name.endsWith('.json'));assert.ok(frame);
   const targets=[{canary:service.store.dbPath,readError:5,label:'synthetic_broker_database'},{canary:a.credentialFile,readError:5,label:'synthetic_member_credential'},
    {canary:defaultFile,readError:5,label:'external_canary_inherited_default_acl'},
    ...['broker-config.json','prepared-state.json','profile-create-intent.json'].map(name=>({canary:path.join(fixed.directory,name),readError:5,label:`broker_control_${name}`})),
    {canary:path.join(fixed.runtimeDirectory,'WindowsFileWorker.dll'),readError:0,label:'readonly_runtime'},
    {canary:path.join(fixed.directory,'frames',frame),readError:0,label:'readonly_request_frame'}];
   const rawEvidence=[];
   for(const {canary,readError,label} of targets){
    const originalHash=sha256(fs.readFileSync(canary)),suffix=randomUUID(),jobFile=path.join(fixed.directory,`raw-${suffix}.json`);
    fs.writeFileSync(jobFile,JSON.stringify({Operation:'probe',Target:'',ExpectedSid:fixed.sid,ChildExecutable:configuration.dotnetExecutable,Canary:canary,Input:path.join(task.workspace.inputs,'files/source.txt'),Work:path.join(task.workspace.work,'files'),Outputs:path.join(task.workspace.outputs,'files')}),{flag:'wx'});
    const raw=worker.native(['--run',fixed.configFile,jobFile],task.workspace.cwd,path.join(fixed.directory,`raw-receipt-${suffix}.json`));
    assert.equal(raw.exitCode,0);assert.equal(raw.workerResult.child.exitCode,0);
    for(const process of [raw.workerResult,raw.workerResult.child.result]){assert.equal(process.nativePathFiltersApplied,false);assert.equal(process.token.isAppContainer,true);assert.equal(process.token.appContainerSid,fixed.sid);assert.equal(process.token.integritySid,'S-1-16-4096');assert.equal(process.token.capabilityCount,0);assert.equal(process.results.inputRead.opened,true);assert.equal(process.results.outsideRead.win32Error,readError,label);for(const name of ['inputWrite','outsideWrite','outsideNew'])assert.equal(process.results[name].win32Error,5,label);assert.equal(process.results.workWrite.created,true);assert.equal(process.results.outputsWrite.created,true);}
    assert.equal(sha256(fs.readFileSync(canary)),originalHash);assert.equal(fs.existsSync(path.join(path.dirname(canary),'forbidden-new.txt')),false);
    rawEvidence.push({label,canary,readError,writeError:5,createError:5,rawReceipt:path.join(fixed.directory,`raw-receipt-${suffix}.json`),workerPid:raw.pid,childPid:raw.workerResult.child.pid,contentHashUnchanged:true,defaultCanaryAclWasModified:false});
   }
   fs.writeFileSync(path.join(logDir,'raw-native-probes.json'),JSON.stringify({status:'passed',targets:rawEvidence,scope:'specified_synthetic_paths_only',nativePathFiltersApplied:false,ordinaryAppContainerSystemRuntimeAndOwnProfileRemainReadable:true},null,2),{flag:'wx'});
  });
  await check('同一可信broker的文件租约也经OS worker执行且保持租约绑定',()=>{
   const executionId=randomUUID(),token='S'.repeat(43);
   service.store.tx(()=>service.store.put('execution',executionId,{executionId,...binding,targetId:'fixture_a',assignmentRevision:task.assignmentRevision,workspaceBinding:task.workspace.markerSha256,state:'platform_running',evidenceLevel:'local_test',deadline:Date.now()+60000,leaseHash:sha256(token)}));
   const files=executionFiles(service.store,executionId,token);const result=files.write({area:'outputs',relativePath:'synthetic-lease.txt',text:'仅合成租约，无平台执行'});assert.equal(result.fileWorkerOsIsolationVerified,true);assert.equal(files.read({area:'outputs',relativePath:'synthetic-lease.txt'}).text,'仅合成租约，无平台执行');
   service.store.tx(()=>{const intent=service.store.get('execution',executionId);intent.state='unknown';service.store.put('execution',executionId,intent);});assert.throws(()=>files.read({area:'outputs',relativePath:'synthetic-lease.txt'}),error=>error.code==='EXECUTION_LEASE_INVALID');
  });
  await check('OS模式中未准备的另一新任务失败封闭，不回退普通进程',async()=>{await call(alpha,'create_task',{groupId:'os_group',taskId:'unprepared_task',title:'合成未准备任务',assigneeId:'fixture_a',participantIds:['fixture_a'],fileAcl:{readers:['fixture_a'],writers:['fixture_a'],inputWriters:[]}});await rejected(()=>call(alpha,'read_task_file',{groupId:'os_group',taskId:'unprepared_task',area:'outputs',relativePath:'none.txt'}),'FILE_OS_NOT_PREPARED');});
  await check('inputs在OS模式只读，即便原ACL有inputWriter也不回退host写入',()=>rejected(()=>call(alpha,'write_task_file',{...binding,area:'inputs',relativePath:'new.txt',text:'不得写'}),'FILE_ARGUMENT_INVALID'));
  await check('跨根/设备/额外配置参数由broker严格拒绝',async()=>{await rejected(()=>call(alpha,'read_task_file',{...binding,area:'inputs',relativePath:'../../outside.txt'}),'FILE_ARGUMENT_INVALID');const extra=await alpha.callTool({name:'read_task_file',arguments:{...binding,area:'inputs',relativePath:'source.txt',root:fixtureRoot}});assert.equal(extra.isError,true);});
  await check('覆写失败保留unknown原请求，重放不再启动worker',async()=>{const args={requestId:'overwrite_unknown',...binding,area:'outputs',relativePath:'result.txt',text:'禁止覆盖'};await rejected(()=>call(alpha,'write_task_file',args),'FILE_OS_OPERATION_UNKNOWN');const before=fs.readdirSync(path.join(task.workspace.cwd,'.os-worker')).length;const replay=await call(alpha,'write_task_file',args);assert.equal(replay.state,'unknown');assert.equal(replay.deduplicated,true);assert.equal(fs.readdirSync(path.join(task.workspace.cwd,'.os-worker')).length,before);assert.equal(fs.readFileSync(path.join(task.workspace.outputs,'files/result.txt'),'utf8'),'受限worker实际写入😀');});
  await check('当前ACL未授权成员不能借worker读取任务',()=>rejected(()=>call(beta,'read_task_file',{...binding,area:'inputs',relativePath:'source.txt'}),'FILE_ACL_FORBIDDEN'));
  await call(alpha,'set_task_acl',{...binding,fileAcl:{readers:['fixture_b'],writers:['fixture_b'],inputWriters:[]}});
  await check('ACL吊销立即作用于后续OS worker调用',()=>rejected(()=>call(alpha,'read_task_file',{...binding,area:'inputs',relativePath:'source.txt'}),'FILE_ACL_FORBIDDEN'));
  await check('新获明确ACL的本人成员可用同任务绑定读取',async()=>assert.equal((await call(beta,'read_task_file',{...binding,area:'inputs',relativePath:'source.txt'})).text,originalInput));
  await check('硬链接继续失败，不因AppContainer而放宽SessionFiles策略',async()=>{fs.linkSync(path.join(task.workspace.inputs,'files/source.txt'),path.join(task.workspace.inputs,'files/hardlink.txt'));await rejected(()=>call(beta,'read_task_file',{...binding,area:'inputs',relativePath:'hardlink.txt'}),'FILE_OS_OPERATION_UNKNOWN');});
  await check('模型目录联接仍由broker拒绝，未授予canary范围',async()=>{const canary=path.join(fixtureRoot,'synthetic-canary');fs.mkdirSync(canary);fs.writeFileSync(path.join(canary,'outside.txt'),'仅本轮合成');fs.symlinkSync(canary,path.join(task.workspace.work,'files/junction'),'junction');await rejected(()=>call(beta,'read_task_file',{...binding,area:'work',relativePath:'junction/outside.txt'}),'FILE_LINK_FORBIDDEN');});
  await check('全平台强字段不随文件worker成功提升',async()=>{const caps=await call(beta,'get_capabilities');assert.equal(caps.platformOsIsolationVerified,false);assert.equal(caps.passiveWakeVerified,false);assert.equal(caps.businessCompletedVerified,false);});
  await check('吊销成员后不能再触发受限worker',async()=>{await call(admin,'revoke_member',{instanceId:'fixture_b'});await rejected(()=>call(beta,'read_task_file',{...binding,area:'outputs',relativePath:'result.txt'}),401);});
  await check('同合成DB重启后四个文件入口不得丢失已准备OS边界；无backend或空binding均阻塞',async()=>{
   await call(alpha,'assign_task',{...binding,assigneeId:'fixture_a',participantIds:['fixture_a'],fileAcl:{readers:['fixture_a'],writers:['fixture_a'],inputWriters:[]}});
   const dbPath=service.store.dbPath;await Promise.allSettled(clients.map(client=>client.close()));await service.close();service=null;
   const results=[];const originalIntentHash=sha256(fs.readFileSync(path.join(task.workspace.cwd,'.os-worker/profile-create-intent.json')));
   for(const configured of [false,true]){
    const reopened=new CollaborationStore({dbPath,...(configured?{fileWorker:new WindowsTaskFiles({...configuration,allowedWorkspaceParent:path.join(fixtureRoot,'task-workspaces'),profileCreationAccepted:true})}:{})});
    try{
     const identity=reopened.resolveCredential(fs.readFileSync(a.credentialFile,'utf8')),view=reopened.as(identity),executionId=randomUUID(),token='R'.repeat(43);
     reopened.tx(()=>reopened.put('execution',executionId,{executionId,...binding,targetId:'fixture_a',assignmentRevision:reopened.get('task','os_group:os_task').assignmentRevision,workspaceBinding:task.workspace.markerSha256,state:'platform_running',evidenceLevel:'local_test',deadline:Date.now()+60000,leaseHash:sha256(token)}));
     const files=executionFiles(reopened,executionId,token);
     const attempts=[['core_read',()=>view.invoke('read_task_file',{...binding,area:'outputs',relativePath:'result.txt'})],['core_write',()=>view.invoke('write_task_file',{requestId:`restart_${randomUUID()}`,...binding,area:'outputs',relativePath:`restart-${randomUUID()}.txt`,text:'仅合成降级回归'})],['lease_read',()=>files.read({area:'outputs',relativePath:'result.txt'})],['lease_write',()=>files.write({area:'outputs',relativePath:`lease-restart-${randomUUID()}.txt`,text:'仅合成降级回归'})]];
     for(const [entry,fn] of attempts){try{const result=await fn();results.push({configured,entry,unexpectedSuccess:true,scope:result.scope??null,osIsolationVerified:result.osIsolationVerified??false});}catch(error){results.push({configured,entry,code:error.code,unexpectedSuccess:false});}}
     if(!configured){const legacy=await view.invoke('write_task_file',{requestId:`legacy_${randomUUID()}`,groupId:'os_group',taskId:'unprepared_task',area:'outputs',relativePath:'legacy-compat.txt',text:'未准备OS的旧任务保留兼容'});assert.equal(legacy.scope,'bridge_only');}
    }finally{reopened.close();}
   }
   fs.writeFileSync(path.join(logDir,'restart-boundary.json'),JSON.stringify({results,profileIntentHashUnchanged:sha256(fs.readFileSync(path.join(task.workspace.cwd,'.os-worker/profile-create-intent.json')))===originalIntentHash,profileRecreated:false},null,2),{flag:'wx'});
   for(const result of results){assert.equal(result.unexpectedSuccess,false,result.entry);assert.equal(result.code,result.configured?'FILE_OS_NOT_PREPARED':'FILE_OS_BACKEND_REQUIRED');}
   assert.equal(sha256(fs.readFileSync(path.join(task.workspace.cwd,'.os-worker/profile-create-intent.json'))),originalIntentHash);
  });
  const summary={status:'passed',checks,fixtureRoot,taskRoot:task.workspace.cwd,logDir,profileName:prepared.profileName,profileRetained:true,actualWindowsKernelIsolation:true,scope:'new_synthetic_task_mcp_file_operations_only',trustedBrokerOwnsDb:true,restrictedWorkerReceivesDbOrCredentials:false,productionServiceConnections:0,officialModelCalls:0,platformOsIsolationVerified:false};
  fs.writeFileSync(path.join(logDir,'summary.json'),JSON.stringify(summary,null,2),'utf8');console.log(JSON.stringify({status:'passed',checks:checks.length,summaryPath:path.join(logDir,'summary.json'),fixtureRoot,officialModelCalls:0}));
 }catch(error){fs.writeFileSync(path.join(logDir,'failure.json'),JSON.stringify({status:'failed',message:error.message,code:error.code,stack:error.stack,checks,fixtureRoot},null,2),'utf8');console.error(error);process.exitCode=1;}
 finally{await Promise.allSettled(clients.map(client=>client.close()));if(service)await service.close();}
}
