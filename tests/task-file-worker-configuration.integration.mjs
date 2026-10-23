import { FIXTURE_ROOT, CODE_ROOT } from './test-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, writeJson, updateJson } from './task-file-lease-backend.fixture.mjs';
import { readTaskFileConfiguration, createTaskFileBackend } from '../bridge/src/windows-task-file-configuration.mjs';
import { readConfiguration, prepareConfiguredService, startConfiguredService } from '../bridge/src/configured-collaboration-service.mjs';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { sha256 } from '../bridge/src/policy.mjs';
import { operateTaskFile } from '../bridge/src/collaboration-file-boundary.mjs';
const error=code=>value=>value.code===code;
const mutated=(f,change)=>{const config=structuredClone(f.config);change(config);return writeJson(path.join(f.store.runtimeRoot,'private-file-worker',`changed-${Math.random()}.json`),config);};
test('P1 v1/v2默认null与v3准确pin、严格字段、禁止provider/媒体扩权',async()=>{
 const f=await fixture();try{
  const ffprobe=path.join(FIXTURE_ROOT,'ffprobe.exe');fs.writeFileSync(ffprobe,'synthetic');const {sha256}=await import('../bridge/src/policy.mjs');
  const base={schema:'collaboration_service_configuration_v1',port:0,dbPath:path.join(f.store.runtimeRoot,'collaboration.sqlite'),runtimeNamespace:path.basename(f.store.runtimeRoot),preparedWorkspaces:[],reviewedCodeBuddyProvider:false,fileWorker:null,contentMediaTools:{ffprobe:{path:ffprobe,sha256:sha256(fs.readFileSync(ffprobe))}}};
  let n=0;const pin=config=>writeJson(path.join(FIXTURE_ROOT,`config-${n++}.json`),config);
  assert.equal(readConfiguration(pin(base)).config.fileWorker,null);
  const mediaFile=path.join(f.store.runtimeRoot,'private-core-media/config.json'),coreMediaPin=writeJson(mediaFile,{schema:'core_qwen_media_host_v1',enabled:true});assert.equal(readConfiguration(pin({...base,schema:'collaboration_service_configuration_v2',coreMediaPin})).config.fileWorker,null);
  assert.throws(()=>readConfiguration(pin({...base,fileWorker:{}})),error('SERVICE_CONFIGURATION_INVALID'));
  const v3={...base,schema:'collaboration_service_configuration_v3',fileWorkerPin:f.pin};assert.equal(prepareConfiguredService(pin(v3)).fileWorker.selectedTaskCount,1);
  for(const change of [{fileWorkerPin:{...f.pin,sha256:'0'.repeat(64)}},{reviewedCodeBuddyProvider:true},{coreMediaPin:f.pin},{runner:'cmd.exe'}])assert.throws(()=>readConfiguration(pin({...v3,...change})));
  assert.equal(f.counters.syntheticRun??0,0);assert.equal(f.counters.realNativeRuns,0);
 }finally{f.close();}
});
test('P2 精确任务和目录、重复和同名异组不自动选择',async()=>{const f=await fixture();try{
 assert.equal(f.backend.appliesTo({...f.task,groupId:'other_group'}),false);
 for(const change of [config=>config.tasks.push(config.tasks[0]),config=>config.tasks[0].taskRoot=FIXTURE_ROOT,config=>config.tasks[0].rootIdentity.ino='changed'])assert.throws(()=>readTaskFileConfiguration(mutated(f,change),{runtimeRoot:f.store.runtimeRoot}));
 const before=f.counters.syntheticInspect;assert.throws(()=>f.backend.read({...f.task,workspace:{...f.task.workspace,markerSha256:'0'.repeat(64)}},{area:'inputs',relativePath:'source.txt'}),error('FILE_OS_BINDING_INVALID'));assert.equal(f.counters.syntheticInspect,before);
 }finally{f.close();}});
test('P3 未选择原任务兼容、有intent禁止回退、原全局backend语义保留',async()=>{const f=await fixture();try{
 const another=structuredClone(f.task);another.groupId='other';assert.throws(()=>operateTaskFile({fileWorker:f.backend},another,'read',{area:'inputs',relativePath:'source.txt'}),error('FILE_OS_BACKEND_REQUIRED'));
 const backend={read(){throw Object.assign(new Error('未准备'),{code:'FILE_OS_NOT_PREPARED'});}};assert.throws(()=>operateTaskFile({fileWorker:backend},f.task,'read',{}),error('FILE_OS_NOT_PREPARED'));
 await f.call('create_task',{groupId:f.binding.groupId,taskId:'unselected',title:'未选择任务',assigneeId:f.identity.instanceId,participantIds:[f.identity.instanceId],fileAcl:{readers:[f.identity.instanceId],writers:[f.identity.instanceId],inputWriters:[]}});f.store.fileWorker=f.backend;const written=await f.call('write_task_file',{groupId:f.binding.groupId,taskId:'unselected',area:'outputs',relativePath:'legacy.txt',text:'原bridge模式'});assert.equal(written.scope,'bridge_only');assert.equal(written.osIsolationVerified,false);
 }finally{f.close();}});
test('P7 runtime完整集合、目录身份、自动版本滚动或任一字节变化均阻断',async()=>{const f=await fixture();try{
 assert.throws(()=>readTaskFileConfiguration(mutated(f,c=>c.runtimePins.pop()),{runtimeRoot:f.store.runtimeRoot}),error('FILE_OS_BINARY_INVALID'));
 assert.throws(()=>readTaskFileConfiguration(mutated(f,c=>c.runtimeIdentities.fxrRoot.ino='bad'),{runtimeRoot:f.store.runtimeRoot}),error('FILE_OS_RUNTIME_CHANGED'));
 const root=path.dirname(f.options.dotnetExecutable),extra=path.join(root,'host/fxr/8.0.0/extra.dll');fs.writeFileSync(extra,'new-dependency');assert.throws(()=>f.reopen(),error('FILE_OS_BINARY_INVALID'));
 }finally{f.close();}});
test('P16 受审plan含配置/manifest/runtime集合；输入pin变化拒绝',async()=>{const f=await fixture();try{
 assert.throws(()=>createTaskFileBackend({...f.pin,sha256:'1'.repeat(64)},{runtimeRoot:f.store.runtimeRoot}),error('FILE_OS_CONFIGURATION_CHANGED'));
 assert.throws(()=>readTaskFileConfiguration(mutated(f,c=>c.tasks[0].manifestPin.sha256='0'.repeat(64)),{runtimeRoot:f.store.runtimeRoot}),error('FILE_OS_CONFIGURATION_CHANGED'));
 }finally{f.close();}});
test('P17 媒体原全局阻断没有随任务选择放开',async()=>{const f=await fixture();try{f.store.fileWorker=f.backend;const submitted=await f.call('submit_task_result',{...f.binding,text:'合成既有成果'});await f.call('get_artifact',{groupId:f.binding.groupId,artifactId:submitted.artifact.artifactId});await assert.rejects(()=>f.call('archive_existing_task_media',{...f.binding,sourceArtifactId:submitted.artifact.artifactId,relativePath:'clip.mp4',title:'不得回退读取'}),error('FILE_OS_MEDIA_UNSUPPORTED'));assert.equal(f.counters.syntheticRun??0,0);for(const file of ['collaboration-media.mjs','core-qwen-media.mjs'])assert.match(fs.readFileSync(path.join(CODE_ROOT,'bridge/src',file),'utf8'),/FILE_OS_MEDIA_UNSUPPORTED/);}finally{f.close();}});
test('P18 严格配置拒绝runner、凭据或任意命令字段',async()=>{const f=await fixture();try{for(const key of ['runner','credential','shell','profileCreationAccepted'])assert.throws(()=>readTaskFileConfiguration(mutated(f,c=>c[key]='forbidden'),{runtimeRoot:f.store.runtimeRoot}),error('FILE_OS_CONFIGURATION_INVALID'));assert.equal(f.counters.realNativeRuns,0);}finally{f.close();}});
test('P20 新公开文件有精确白名单，私有运行证据仍默认排除',()=>{const ignore=fs.readFileSync(path.join(CODE_ROOT,'.gitignore'),'utf8');for(const name of ['bridge/src/windows-task-file-configuration.mjs','bridge/native/WindowsFileWorker/BindingInspector.cs','tests/task-file-worker-configuration.integration.mjs','tests/task-file-worker-restore.integration.mjs','tests/task-file-lease-backend.integration.mjs','tests/task-file-lease-backend.fixture.mjs'])assert.ok(ignore.includes('!/'+name));assert.ok(ignore.includes('**/runtime/'));assert.ok(ignore.includes('**/*private*'));});
test('v3真实合成HTTP重启选定任务恢复，启动意图不可重放；不调用真实native', {timeout:20000},async()=>{
 const f=await fixture();let running,client;try{
  // 使用已存在的fixture成员凭据；绝不打开真实项目的认证文件。
  const credential=fs.readFileSync(f.credentialFile,'utf8');f.close();
  const probe=path.join(f.store.runtimeRoot,'ffprobe.exe');fs.writeFileSync(probe,'synthetic');const config={schema:'collaboration_service_configuration_v3',port:0,dbPath:f.store.dbPath,runtimeNamespace:path.basename(f.store.runtimeRoot),preparedWorkspaces:[],reviewedCodeBuddyProvider:false,fileWorker:null,fileWorkerPin:f.pin,contentMediaTools:{ffprobe:{path:probe,sha256:sha256(fs.readFileSync(probe))}}};
  const pin=writeJson(path.join(f.store.runtimeRoot,'service-v3.json'),config),plan=prepareConfiguredService(pin),approvalPin=writeJson(path.join(f.store.runtimeRoot,'start-once.json'),{schema:'configured_core_start_approval_v1',permission:'start_core_once',planSha256:plan.planSha256,expiresAt:new Date(Date.now()+60000).toISOString()});
  running=await startConfiguredService(pin,{approvalPin,fileWorkerTestHooks:f.options.testHooks});client=new Client({name:'synthetic_http_restore',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(running.service.endpoint),{requestInit:{headers:{Authorization:'Bearer '+credential}}}));
  const result=await client.callTool({name:'read_task_file',arguments:{...f.binding,area:'inputs',relativePath:'source.txt'}});assert.notEqual(result.isError,true,JSON.stringify(result));assert.equal(result.structuredContent.text,'合成输入😀');assert.equal(running.service.reviewedCodeBuddyProviderSelected,false);assert.equal(f.counters.syntheticPrepare,1);
  await assert.rejects(()=>startConfiguredService(pin,{approvalPin,fileWorkerTestHooks:f.options.testHooks}),error('SERVICE_START_RESERVED'));assert.equal(f.counters.realNativeRuns,0);
 }finally{if(client)await client.close();if(running)await running.close();f.close();}
});
test('runtime自动roll-forward、复制runtime字节和新增host解析版本均拒绝',async()=>{for(const mutation of ['rollForward','copiedBytes','newHost']){const f=await fixture();try{
 const before=f.counters.syntheticInspect;if(mutation==='rollForward'){updateJson(path.join(f.options.buildDirectory,'WindowsFileWorker.runtimeconfig.json'),value=>value.runtimeOptions.rollForward='LatestPatch');assert.throws(()=>f.reopen(),error('FILE_OS_BINARY_INVALID'));}
 if(mutation==='newHost'){const target=path.join(path.dirname(f.options.dotnetExecutable),'host/fxr/9.0.0');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'hostfxr.dll'),'unreviewed');assert.throws(()=>f.reopen(),error('FILE_OS_BINARY_INVALID'));}
 if(mutation==='copiedBytes'){fs.writeFileSync(path.join(f.task.workspace.cwd,'.os-worker/runtime/WindowsFileWorker.dll'),'changed');assert.throws(()=>f.backend.read(f.task,{area:'inputs',relativePath:'source.txt'}),error('FILE_OS_RUNTIME_CHANGED'));}
 if(mutation!=='copiedBytes')assert.equal(f.counters.syntheticInspect,before);assert.equal(f.counters.syntheticRun??0,0);
 }finally{f.close();}}});
