import { CODE_ROOT } from './test-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, updateJson, writeJson } from './task-file-lease-backend.fixture.mjs';
import { executionFiles } from '../bridge/src/collaboration-execution.mjs';
import { prepareTaskFileBinding } from '../bridge/src/windows-task-file-configuration.mjs';
import { sha256 } from '../bridge/src/policy.mjs';
const error=code=>value=>value.code===code;
function lease(f){const token='L'.repeat(43),executionId='synthetic_lease';f.store.tx(()=>f.store.put('execution',executionId,{executionId,...f.binding,targetId:f.identity.instanceId,assignmentRevision:f.task.assignmentRevision,workspaceBinding:f.task.workspace.markerSha256,state:'platform_running',deadline:Date.now()+60000,leaseHash:sha256(token),evidenceLevel:'local_test'}));return executionFiles(f.store,executionId,token);}
test('P4 精确批准首次prepare与manifest CreateNew，恢复不获取创建权限',async()=>{const f=await fixture();try{
 assert.equal(f.counters.syntheticPrepare,1);assert.equal(fs.existsSync(f.manifestFile+'.intent.json'),true);assert.equal(f.backend.capabilities(f.task).workerOsIsolationVerified,false);
 const before=f.counters.syntheticPrepare;assert.throws(()=>prepareTaskFileBinding(f.worker,f.task,{runtimeRoot:f.store.runtimeRoot,manifestFile:f.manifestFile,approvalPin:f.approvalPin}));assert.equal(f.counters.syntheticPrepare,before);
 assert.throws(()=>prepareTaskFileBinding(f.worker,f.task,{runtimeRoot:f.store.runtimeRoot,manifestFile:f.manifestFile}),error('FILE_OS_CONFIGURATION_PIN'));
 }finally{f.close();}});
test('P5 外部manifest恢复后attestation清零，合成操作成功后才提升单次文件结果',async()=>{const f=await fixture();try{
 f.backend.restoreTask(f.task);assert.equal(f.backend.capabilities(f.task).workerOsIsolationVerified,false);
 const value=f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'});assert.equal(value.text,'合成输入😀');assert.equal(value.platformOsIsolationVerified,false);assert.equal(f.backend.capabilities(f.task).workerOsIsolationVerified,true);
 const restarted=f.reopen();assert.equal(restarted.capabilities(f.task).workerOsIsolationVerified,false);restarted.restoreTask(f.task);assert.equal(restarted.capabilities(f.task).workerOsIsolationVerified,false);assert.equal(f.counters.syntheticPrepare,1);
 }finally{f.close();}});
test('P6 partial/unknown原准备证据不能恢复或自动重建',async()=>{const f=await fixture();try{
 const before=f.counters.syntheticInspect;fs.writeFileSync(path.join(f.task.workspace.cwd,'.os-worker/profile-create-result.json'),JSON.stringify({created:false,state:'unknown'}));assert.throws(()=>f.backend.restoreTask(f.task),error('FILE_OS_BINDING_CHANGED'));assert.equal(f.counters.syntheticInspect,before);assert.equal(f.counters.syntheticPrepare,1);
 }finally{f.close();}});
test('P8 模拟实际ACL/SID/目录/标签观察不符即拒绝，零run且不修复',async()=>{const f=await fixture();try{
 updateJson(path.join(f.task.workspace.cwd,'.os-worker/fixture-observation.json'),v=>v.directories[0].sddl='changed');assert.throws(()=>f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'}),error('FILE_OS_INSPECTION_CHANGED'));assert.equal(f.counters.syntheticRun??0,0);assert.equal(f.counters.realAclChanges,0);
 }finally{f.close();}});
test('P9 成功恢复后换当前scope对象或更改marker不得沿旧闭包',async()=>{const f=await fixture();try{
 f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'});const altered=structuredClone(f.task);altered.scope.bindingId='new-scope';const before=f.counters.syntheticInspect;assert.throws(()=>f.backend.read(altered,{area:'inputs',relativePath:'source.txt'}),error('FILE_OS_BINDING_INVALID'));assert.equal(f.counters.syntheticInspect,before);
 fs.writeFileSync(path.join(f.task.workspace.cwd,'.task-binding.json'),'changed');assert.throws(()=>f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'}),error('FILE_WORKSPACE_CHANGED'));
 }finally{f.close();}});
test('P10 四入口在backend恢复可用/缺失时一致，未准备时不创建目标',async()=>{const f=await fixture();try{
 f.store.fileWorker=f.backend;const files=lease(f);assert.equal((await f.call('read_task_file',{...f.binding,area:'inputs',relativePath:'source.txt'})).text,'合成输入😀');assert.equal(files.read({area:'inputs',relativePath:'source.txt'}).text,'合成输入😀');
 await f.call('write_task_file',{...f.binding,area:'outputs',relativePath:'core.txt',text:'core'});files.write({area:'outputs',relativePath:'lease.txt',text:'lease'});
 f.store.fileWorker=null;for(const fn of [()=>f.call('read_task_file',{...f.binding,area:'outputs',relativePath:'core.txt'}),()=>f.call('write_task_file',{...f.binding,area:'outputs',relativePath:'blocked.txt',text:'x'}),()=>files.read({area:'outputs',relativePath:'core.txt'}),()=>files.write({area:'outputs',relativePath:'lease-blocked.txt',text:'x'})])await assert.rejects(async()=>fn(),error('FILE_OS_BACKEND_REQUIRED'));
 assert.equal(fs.existsSync(path.join(f.task.workspace.outputs,'files/blocked.txt')),false);
 }finally{f.close();}});
test('P12 当前ACL/租约/revision吊销在native动作前阻断',async()=>{const f=await fixture();try{
 f.store.fileWorker=f.backend;const files=lease(f),before=f.counters.syntheticInspect;f.store.tx(()=>{const task=f.store.get('task','fixture_group:fixture_task');task.fileAcl.readers=[];f.store.put('task','fixture_group:fixture_task',task);});assert.throws(()=>files.read({area:'inputs',relativePath:'source.txt'}),error('FILE_ACL_FORBIDDEN'));assert.equal(f.counters.syntheticInspect,before);
 f.store.tx(()=>{const task=f.store.get('task','fixture_group:fixture_task');task.assignmentRevision++;f.store.put('task','fixture_group:fixture_task',task);});assert.throws(()=>files.read({area:'inputs',relativePath:'source.txt'}),error('EXECUTION_BINDING_CHANGED'));
 }finally{f.close();}});
test('P13 合成token或结果哈希错误均不接受；不外推平台隔离',async()=>{const f=await fixture();try{
 f.counters.mutateOutput=o=>o.token.capabilityCount=1;assert.throws(()=>f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'}),error('FILE_OS_TOKEN_INVALID'));
 f.counters.mutateOutput=o=>o.workerResult.sha256='0'.repeat(64);assert.throws(()=>f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'}),error('FILE_OS_READBACK_MISMATCH'));
 }finally{f.close();}});
test('P14 输入写、额外字段、路径穿越、无效UTF8与越界先拒绝',async()=>{const f=await fixture();try{
 const before=f.counters.syntheticInspect;for(const args of [{area:'inputs',relativePath:'new.txt',text:'x'},{area:'outputs',relativePath:'../../outside',text:'x'},{area:'outputs',relativePath:'a',text:'x',root:'elsewhere'},{area:'outputs',relativePath:'a',text:'\ud800'},{area:'outputs',relativePath:'a',text:'x'.repeat(32769)}])assert.throws(()=>f.backend.write(f.task,args),error('FILE_ARGUMENT_INVALID'));assert.equal(f.counters.syntheticInspect,before);
 }finally{f.close();}});
test('P15 同请求unknown重放保留原响应，不再调用worker',async()=>{const f=await fixture();try{
 f.store.fileWorker=f.backend;f.counters.mutateOutput=o=>o.token.capabilityCount=1;const args={requestId:'unknown_once',...f.binding,area:'outputs',relativePath:'unknown.txt',text:'保留'};
 await assert.rejects(()=>f.store.as(f.identity).invoke('write_task_file',args),error('FILE_OS_TOKEN_INVALID'));const before=f.counters.syntheticRun;const replay=await f.store.as(f.identity).invoke('write_task_file',args);assert.equal(replay.state,'unknown');assert.equal(replay.deduplicated,true);assert.equal(f.counters.syntheticRun,before);
 }finally{f.close();}});
test('P19 保留故意claim后崩溃及输入超时fixture语义，native恢复源无权限修改API',()=>{
 for(const name of ['session-fixture-server.mjs','codebuddy-fixture-server.mjs'])assert.match(fs.readFileSync(path.join(CODE_ROOT,'tests',name),'utf8'),/process\.exit\(91\)/);
 const source=fs.readFileSync(path.join(CODE_ROOT,'bridge/native/WindowsFileWorker/BindingInspector.cs'),'utf8');assert.doesNotMatch(source,/Native\.(?:CreateAppContainerProfile|SetNamedSecurityInfo)|SetAccessControl\(/);
});
test('Spec3 runtime同字节替换、硬链接或联接在inspector前阻断',async()=>{for(const kind of ['hardlink','replacement','junction']){const f=await fixture();try{
 const runtime=path.join(f.task.workspace.cwd,'.os-worker/runtime'),dll=path.join(runtime,'WindowsFileWorker.dll'),before=f.counters.syntheticInspect;
 if(kind==='hardlink')fs.linkSync(dll,path.join(f.task.workspace.work,'runtime-link.dll'));
 if(kind==='replacement'){fs.copyFileSync(dll,dll+'.replacement');fs.renameSync(dll+'.replacement',dll);}
 if(kind==='junction'){fs.renameSync(runtime,runtime+'-original');fs.symlinkSync(runtime+'-original',runtime,'junction');}
 assert.throws(()=>f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'}));assert.equal(f.counters.syntheticInspect,before);assert.equal(f.counters.syntheticRun??0,0);
 }finally{f.close();}}});
test('Spec4 最终manifest已存在而intent缺失时prepare次数为0且不覆盖',async()=>{const f=await fixture();try{
 const target=path.join(path.dirname(f.manifestFile),'preexisting.json');fs.writeFileSync(target,'keep-original');const approval=JSON.parse(fs.readFileSync(f.approvalPin.path));approval.manifestFile=target;const pin=writeJson(path.join(path.dirname(f.approvalPin.path),'preexisting-approval.json'),approval);
 const before=f.counters.syntheticPrepare;assert.equal(fs.existsSync(target+'.intent.json'),false);assert.throws(()=>prepareTaskFileBinding(f.worker,f.task,{runtimeRoot:f.store.runtimeRoot,manifestFile:target,approvalPin:pin}),e=>e.code==='EEXIST');assert.equal(f.counters.syntheticPrepare,before);assert.equal(fs.readFileSync(target,'utf8'),'keep-original');assert.equal(fs.existsSync(target+'.intent.json'),false);
 }finally{f.close();}});
