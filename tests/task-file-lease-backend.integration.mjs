import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { fixture, writeJson } from './task-file-lease-backend.fixture.mjs';
import { sha256 } from '../bridge/src/policy.mjs';
import { restoreExecutionFileBackend, taskFileScopeSha256 } from '../bridge/src/windows-task-file-configuration.mjs';
import { assertExecutionLease } from '../bridge/src/collaboration-execution.mjs';
const token='K'.repeat(43),executionId='lease_fixture';
function boundedOutput(limit=32768){
 let observedBytes=0,storedBytes=0,observedEOF=false;const chunks=[];
 return{feed(bytes){const raw=Buffer.from(bytes);observedBytes+=raw.length;const count=Math.min(raw.length,limit-storedBytes);if(count>0){chunks.push(Buffer.from(raw.subarray(0,count)));storedBytes+=count;}},end(){observedEOF=true;},text(){return Buffer.concat(chunks).toString('utf8');},report(){return{observedBytes,storedBytes,observedEOF,truncated:observedBytes>storedBytes,complete:observedEOF&&observedBytes===storedBytes};},save(file){const bytes=Buffer.concat(chunks);fs.writeFileSync(file,bytes,{flag:'wx'});writeJson(file+'.json',{...this.report(),sha256:sha256(bytes)});}};
}
// 只操作本调用持有的子进程；终止请求与实际exit/close分开，超时也不能伪填终态。
async function observeOwnedChild(child,{artifact,onSpawn=()=>{},timeoutMs=10000,graceMs=5000}={}){
 const stdout=boundedOutput(),stderr=boundedOutput();child.stdout?.on('data',stdout.feed);child.stdout?.once('end',stdout.end);child.stderr?.on('data',stderr.feed);child.stderr?.once('end',stderr.end);
 const result={pid:null,spawnObserved:false,terminationRequested:false,terminationRequestReturned:null,exitObserved:false,exitCode:null,exitSignal:null,closeObserved:false,closeCode:null,closeSignal:null,status:'unknown'};
 await new Promise(resolve=>{let finished=false,grace;const finish=()=>{if(finished)return;finished=true;clearTimeout(deadline);clearTimeout(grace);resolve();};
  function terminate(reason){if(finished||result.terminationRequested)return;result.terminationRequested=true;result.terminationReason=reason;try{result.terminationRequestReturned=child.kill();}catch(error){result.terminationError=String(error.code??error.message).slice(0,256);}grace=setTimeout(finish,graceMs);}
  const deadline=setTimeout(()=>terminate('owned_fixture_deadline'),timeoutMs);
  child.once('spawn',()=>{result.spawnObserved=true;result.pid=child.pid;try{onSpawn();}catch(error){result.setupError=String(error.code??error.message).slice(0,256);terminate('owned_fixture_setup_failed');}});
  child.once('error',error=>{result.processError=String(error.code??error.message).slice(0,256);});
  child.once('exit',(code,signal)=>{if(finished)return;result.exitObserved=true;result.exitCode=code;result.exitSignal=signal;});
  child.once('close',(code,signal)=>{if(finished)return;result.closeObserved=true;result.closeCode=code;result.closeSignal=signal;result.status=result.terminationRequested?'closed_after_termination_request':'closed';finish();});
 });
 result.stdout=stdout.report();result.stderr=stderr.report();stdout.save(artifact+'.stdout');stderr.save(artifact+'.stderr');writeJson(artifact+'.terminal.json',result);return result;
}
function record(f,extra={}){f.store.tx(()=>f.store.put('execution',executionId,{executionId,...f.binding,targetId:f.identity.instanceId,assignmentRevision:f.task.assignmentRevision,workspaceBinding:f.task.workspace.markerSha256,state:'platform_running',deadline:Date.now()+60000,leaseHash:sha256(token),evidenceLevel:'local_test',fileWorkerContext:{pin:f.pin,runtimeRoot:f.store.runtimeRoot,workspaceBinding:f.task.workspace.markerSha256,scopeSha256:taskFileScopeSha256(f.task.scope)},...extra}));}
function launch(f,wrongCwd=false){const root=f.task.workspace.cwd,work=path.join(root,'work/session-control',executionId),input=path.join(root,'inputs/session-control',executionId);fs.mkdirSync(work,{recursive:true});fs.mkdirSync(input,{recursive:true});const binding=writeJson(path.join(input,'file-binding.json'),{workspace:{...f.task.workspace,...(wrongCwd?{cwd:CODE_ROOT}:{})},scope:f.task.scope,collaboration:{dbPath:f.store.dbPath,executionId,token},untrustedBackendHint:'ignored'}),audit=path.join(work,'mcp.jsonl'),nativeAudit=path.join(work,'synthetic-native.jsonl');return{command:process.execPath,args:['--import',pathToFileURL(path.join(CODE_ROOT,'tests/task-file-lease-backend.fixture.mjs')).href,path.join(CODE_ROOT,'bridge/src/collaboration-file-server.mjs'),'--binding-file',binding.path,'--audit-log',audit],cwd:root,env:{...process.env,COLLAB_FILE_NATIVE_FIXTURE:'1',COLLAB_FILE_NATIVE_AUDIT:nativeAudit},nativeAudit};}
test('P11 实际独立stdio文件server经可信execution pin恢复同factory，仅合成runner', {timeout:20000},async()=>{const f=await fixture();let client,transport;const stderr=boundedOutput();try{
 record(f);const options=launch(f);transport=new StdioClientTransport({...options,stderr:'pipe'});transport.stderr?.on('data',stderr.feed);transport.stderr?.once('end',stderr.end);client=new Client({name:'synthetic_file_lease',version:'1'});await client.connect(transport);
 const result=await client.callTool({name:'read_task_file',arguments:{area:'inputs',relativePath:'source.txt'}});assert.notEqual(result.isError,true,JSON.stringify(result));assert.equal(result.structuredContent.text,'合成输入😀');assert.equal(result.structuredContent.platformOsIsolationVerified,false);
 const written=await client.callTool({name:'write_task_file',arguments:{area:'outputs',relativePath:'independent.txt',text:'独立合成租约'} });assert.notEqual(written.isError,true);assert.equal(fs.readFileSync(path.join(f.task.workspace.outputs,'files/independent.txt'),'utf8'),'独立合成租约');
 const observed=fs.readFileSync(options.nativeAudit,'utf8').trim().split('\n').map(JSON.parse);assert.ok(observed.some(value=>value.operation==='--inspect-binding'));assert.ok(observed.some(value=>value.operation==='--run'));assert.ok(observed.every(value=>value.syntheticOnly));assert.equal(f.counters.realNativeRuns,0);
 }catch(error){throw new Error('独立文件server失败（stderr可能截断，见字节回执）：'+stderr.text(),{cause:error});}finally{try{if(client)await client.close();else if(transport)await transport.close();}finally{stderr.save(path.join(f.task.workspace.work,'independent-child-stderr.txt'));f.close();}}});
test('W4 独立file-server错误cwd在任何inspector之前拒绝', {timeout:20000},async()=>{const f=await fixture();try{record(f);const options=launch(f,true);const result=spawnSync(options.command,options.args,{cwd:options.cwd,env:options.env,encoding:'utf8',timeout:10000,maxBuffer:262144});assert.notEqual(result.status,0);assert.match(result.stderr,/cwd/);assert.equal(fs.existsSync(options.nativeAudit),false);}finally{f.close();}});
test('可信租约错误pin、namespace、当前scope或过期在native之前拒绝',async()=>{const f=await fixture();try{
 for(const extra of [{fileWorkerContext:{pin:f.pin,runtimeRoot:'elsewhere',workspaceBinding:f.task.workspace.markerSha256,scopeSha256:taskFileScopeSha256(f.task.scope)}},{fileWorkerContext:{pin:{...f.pin,sha256:'0'.repeat(64)},runtimeRoot:f.store.runtimeRoot,workspaceBinding:f.task.workspace.markerSha256,scopeSha256:taskFileScopeSha256(f.task.scope)}},{deadline:Date.now()-1}]){record(f,extra);const before=f.counters.syntheticInspect;assert.throws(()=>restoreExecutionFileBackend(f.store,assertExecutionLease(f.store,executionId,token),{testHooks:f.options.testHooks}));assert.equal(f.counters.syntheticInspect,before);}
 }finally{f.close();}});
test('Spec2 execution-worker错误runner/source pin或越界fixture在inspector前拒绝', {timeout:30000},async()=>{for(const kind of ['runner','source','fixture']){const f=await fixture();try{
 const config=path.join(f.task.workspace.work,'invalid-runner.json');fs.writeFileSync(config,JSON.stringify({cliScript:kind==='fixture'?path.join(path.parse(CODE_ROOT).root,'outside-fixture.cjs'):path.join(f.task.workspace.cwd,'synthetic.cjs')}));record(f);
 const worker=path.join(CODE_ROOT,'bridge/src/collaboration-execution-worker.mjs'),audit=path.join(f.task.workspace.work,'native-must-not-run.jsonl');
 f.store.tx(()=>{const value=f.store.get('execution',executionId);value.configurationFile=config;value.configurationHash=kind==='runner'?'0'.repeat(64):sha256(fs.readFileSync(config));value.workerScriptHash=kind==='source'?'0'.repeat(64):sha256(fs.readFileSync(worker));f.store.put('execution',executionId,value);});
 const child=spawn(process.execPath,['--import',pathToFileURL(path.join(CODE_ROOT,'tests/task-file-lease-backend.fixture.mjs')).href,worker,'--db',f.store.dbPath,'--execution-id',executionId,'--configuration',config],{cwd:f.task.workspace.cwd,env:{...process.env,COLLAB_FILE_NATIVE_FIXTURE:'1',COLLAB_FILE_NATIVE_AUDIT:audit},windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 const result=await observeOwnedChild(child,{artifact:path.join(f.task.workspace.work,'worker'),onSpawn:()=>{f.store.tx(()=>{const value=f.store.get('execution',executionId);value.workerPid=child.pid;f.store.put('execution',executionId,value);});child.send({token});}});
 assert.equal(result.closeObserved,true);assert.equal(result.closeCode,1);assert.equal(result.exitObserved,true);assert.equal(result.terminationRequested,false);assert.equal(fs.existsSync(audit),false);assert.equal(f.store.get('execution',executionId).state,'unknown');
 }finally{f.close();}}});
test('生命周期：超限stderr仍排空，超时请求终止后等待自有子进程实际close', {timeout:10000},async()=>{
 const directory=path.join(FIXTURE_ROOT,'lifecycle-bounded');fs.mkdirSync(directory);const child=spawn(process.execPath,['-e',"process.stderr.write(Buffer.alloc(131072,88));setInterval(()=>{},1000);"],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe']});
 const result=await observeOwnedChild(child,{artifact:path.join(directory,'owned-child'),timeoutMs:1500,graceMs:5000});assert.equal(result.terminationRequested,true);assert.equal(result.closeObserved,true);assert.equal(result.exitObserved,true);assert.equal(result.status,'closed_after_termination_request');assert.ok(result.exitCode!==null||result.exitSignal!==null);assert.equal(result.stderr.observedBytes,131072);assert.equal(result.stderr.storedBytes,32768);assert.equal(result.stderr.truncated,true);assert.equal(result.stderr.complete,false);assert.equal(result.stderr.observedEOF,true);
});
test('生命周期：未观察close时保存unknown，不从kill请求伪造exit', {timeout:2000},async()=>{
 const directory=path.join(FIXTURE_ROOT,'lifecycle-unknown');fs.mkdirSync(directory);const simulated=new EventEmitter();simulated.pid=null;simulated.stdout=new PassThrough();simulated.stderr=new PassThrough();simulated.kill=()=>false;
 try{const result=await observeOwnedChild(simulated,{artifact:path.join(directory,'simulated-no-terminal'),timeoutMs:10,graceMs:20});assert.equal(result.status,'unknown');assert.equal(result.terminationRequested,true);assert.equal(result.closeObserved,false);assert.equal(result.exitObserved,false);assert.equal(result.exitCode,null);assert.equal(result.exitSignal,null);assert.equal(result.pid,null);writeJson(path.join(directory,'scope.json'),{simulationOnly:true,realProcessStarted:false});}finally{simulated.stdout.destroy();simulated.stderr.destroy();}
});
