import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, SOURCE_ROOT, sha256 } from '../bridge/src/policy.mjs';
import { CollaborationStore } from '../bridge/src/collaboration-store.mjs';
import { WindowsTaskFiles } from '../bridge/src/windows-task-files.mjs';
import { SessionFiles } from '../bridge/src/session-files.mjs';
import { prepareTaskFileBinding, createTaskFileBackend, taskFileDirectoryIdentity, taskFileRuntimeDirectoryIdentity, taskFileScopeSha256, canonicalFileValue } from '../bridge/src/windows-task-file-configuration.mjs';

function guard(){if(process.env.COLLAB_TEST_MODE!=='1'||PROJECT_ROOT===SOURCE_ROOT)throw new Error('合成替身禁止进入生产根');}
export function writeJson(file,value){fs.mkdirSync(path.dirname(file),{recursive:true});const bytes=Buffer.from(JSON.stringify(value));fs.writeFileSync(file,bytes,{flag:'wx'});return{path:file,sha256:sha256(bytes)};}
export function updateJson(file,change){const value=JSON.parse(fs.readFileSync(file));change(value);fs.writeFileSync(file,JSON.stringify(value));return{path:file,sha256:sha256(fs.readFileSync(file))};}
export function syntheticNative(args,counters={}){
  guard();const count=name=>counters[name]=(counters[name]??0)+1;
  if(args[0]==='--prepare'){
    count('syntheticPrepare');const config=JSON.parse(fs.readFileSync(args[1])),directory=path.dirname(args[1]),runtime=path.join(directory,'runtime');
    fs.mkdirSync(runtime);fs.mkdirSync(path.join(directory,'frames'));
    for(const name of ['WindowsFileWorker.dll','WindowsFileWorker.deps.json','WindowsFileWorker.runtimeconfig.json'])fs.copyFileSync(path.join(config.BuildDirectory,name),path.join(runtime,name));
    const sid='S-1-15-2-123-456',profileFolder=path.join(directory,'synthetic-profile');fs.mkdirSync(profileFolder);
    writeJson(path.join(directory,'profile-create-intent.json'),{ProfileName:config.ProfileName,automaticRetry:false});
    writeJson(path.join(directory,'profile-create-result.json'),{created:true,hresult:0,sid,ProfileName:config.ProfileName});
    writeJson(path.join(directory,'acl-before.json'),{syntheticOnly:true});writeJson(path.join(directory,'acl-after.json'),{syntheticOnly:true});
    const prepared={TaskRoot:config.TaskRoot,ProfileName:config.ProfileName,Sid:sid,ProfileFolder:profileFolder,RuntimeDirectory:runtime,AclPaths:[]};writeJson(path.join(directory,'prepared-state.json'),prepared);
    writeJson(path.join(directory,'fixture-observation.json'),{schema:'windows_task_file_inspection_v1',sid,profileFolder,directories:[{path:config.TaskRoot,volume:1,fileId:'synthetic-id',created:'synthetic-time',attributes:16,sddl:'synthetic-ACL-only'}]});
    return{status:0,stdout:JSON.stringify(prepared),stderr:''};
  }
  if(args[0]==='--inspect-binding'){count('syntheticInspect');return{status:0,stdout:fs.readFileSync(path.join(path.dirname(args[1]),'fixture-observation.json'),'utf8'),stderr:''};}
  if(args[0]==='--run'){
    count('syntheticRun');const job=JSON.parse(fs.readFileSync(args[2])),token={isAppContainer:true,appContainerSid:job.ExpectedSid,integritySid:'S-1-16-4096',capabilityCount:0};
    let result;if(job.Operation==='write'){fs.writeFileSync(job.Target,job.Text,{flag:'wx'});const bytes=fs.readFileSync(job.Target);result={created:true,overwritten:false,sha256:sha256(bytes),byteLength:bytes.length};}
    const bytes=fs.readFileSync(job.Target);let actual=job.Operation==='read'?{token,pid:process.pid,text:bytes.toString('utf8'),sha256:sha256(bytes),byteLength:bytes.length}:{token,pid:process.pid,result};
    let output={exitCode:0,pid:process.pid,token,workerResult:actual};if(counters.mutateOutput)counters.mutateOutput(output);
    return{status:0,stdout:JSON.stringify(output),stderr:''};
  }
  throw new Error('测试替身禁止未知native操作');
}
export async function fixture(){
  guard();const counters={realNativeRuns:0,realProfileApis:0,realAclChanges:0},namespace='FileFixture_'+randomUUID().replaceAll('-',''),store=new CollaborationStore({runtimeNamespace:namespace});
  const admin=store.resolveCredential(fs.readFileSync(store.bootstrapAdmin().credentialFile,'utf8'));
  const member=store.provisionMember({instanceId:'fixture_member',platform:'fixture',mode:'offline'}),other=store.provisionMember({instanceId:'fixture_other',platform:'fixture',mode:'offline'});
  const identity=store.resolveCredential(fs.readFileSync(member.credentialFile,'utf8'));let sequence=0;
  const call=(name,args={},who=identity)=>store.as(who).invoke(name,{...(!name.startsWith('get_')&&!name.startsWith('read_')?{requestId:'r_'+(++sequence)}:{}),...args});
  await call('create_group',{groupId:'fixture_group',title:'合成文件边界',memberIds:['fixture_member','fixture_other'],managerId:'fixture_member',policy:{allowMemberTakeover:false}},admin);
  await call('create_task',{groupId:'fixture_group',taskId:'fixture_task',title:'合成新任务',assigneeId:'fixture_member',participantIds:['fixture_member','fixture_other'],fileAcl:{readers:['fixture_member'],writers:['fixture_member'],inputWriters:['fixture_member']}});
  const task=store.get('task','fixture_group:fixture_task');new SessionFiles({...task,manager:true}).write({area:'inputs',relativePath:'source.txt',text:'合成输入😀'});
  const dotnetRoot=path.join(PROJECT_ROOT,'bridge/runtime',namespace,'dotnet'),buildDirectory=path.join(PROJECT_ROOT,'bridge/runtime',namespace,'build');
  for(const folder of [dotnetRoot,buildDirectory,path.join(dotnetRoot,'host/fxr/8.0.0'),path.join(dotnetRoot,'shared/Microsoft.NETCore.App/8.0.0')])fs.mkdirSync(folder,{recursive:true});
  const dotnetExecutable=path.join(dotnetRoot,'dotnet.exe');fs.writeFileSync(dotnetExecutable,'synthetic-never-executed');fs.writeFileSync(path.join(dotnetRoot,'host/fxr/8.0.0/hostfxr.dll'),'synthetic-host');fs.writeFileSync(path.join(dotnetRoot,'shared/Microsoft.NETCore.App/8.0.0/core.dll'),'synthetic-framework');
  fs.writeFileSync(path.join(buildDirectory,'WindowsFileWorker.dll'),'synthetic-worker');writeJson(path.join(buildDirectory,'WindowsFileWorker.deps.json'),{});writeJson(path.join(buildDirectory,'WindowsFileWorker.runtimeconfig.json'),{runtimeOptions:{rollForward:'Disable',framework:{name:'Microsoft.NETCore.App',version:'8.0.0'}}});
  const binaryHashes={dotnet:sha256(fs.readFileSync(dotnetExecutable)),...Object.fromEntries(['WindowsFileWorker.dll','WindowsFileWorker.deps.json','WindowsFileWorker.runtimeconfig.json'].map(name=>[name,sha256(fs.readFileSync(path.join(buildDirectory,name)))]))};
  const allowedWorkspaceParent=path.join(PROJECT_ROOT,'task-workspaces'),options={dotnetExecutable,buildDirectory,binaryHashes,allowedWorkspaceParent,profileCreationAccepted:true,testHooks:{run:args=>syntheticNative(args,counters)}};
  const worker=new WindowsTaskFiles(options),privateRoot=path.join(store.runtimeRoot,'private-file-worker'),manifestFile=path.join(privateRoot,'bindings','task.json');
  const approval={schema:'windows_task_file_prepare_approval_v1',permission:'prepare_file_worker_once',groupId:task.groupId,taskId:task.taskId,workspaceId:task.workspace.taskId,workspaceMarkerSha256:task.workspace.markerSha256,scopeSha256:taskFileScopeSha256(task.scope),taskRoot:task.workspace.cwd,rootIdentity:taskFileDirectoryIdentity(task.workspace.cwd),allowedWorkspaceParent,dotnetExecutable,buildDirectory,binaryHashesSha256:sha256(canonicalFileValue(binaryHashes)),manifestFile,expiresAt:new Date(Date.now()+60000).toISOString()};
  const approvalPin=writeJson(path.join(privateRoot,'prepare-approval.json'),approval),prepared=prepareTaskFileBinding(worker,task,{runtimeRoot:store.runtimeRoot,manifestFile,approvalPin});
  const selector={groupId:task.groupId,taskId:task.taskId,workspaceId:task.workspace.taskId,taskRoot:task.workspace.cwd,rootIdentity:taskFileDirectoryIdentity(task.workspace.cwd),workspaceMarkerSha256:task.workspace.markerSha256,scopeSha256:taskFileScopeSha256(task.scope),manifestPin:prepared.manifestPin};
  const runtimePins=['dotnet.exe','host/fxr/8.0.0/hostfxr.dll','shared/Microsoft.NETCore.App/8.0.0/core.dll'].map(relativePath=>({relativePath,sha256:sha256(fs.readFileSync(path.join(dotnetRoot,relativePath)))}));
  const runtimeIdentities=Object.fromEntries(Object.entries({dotnetRoot,fxrRoot:path.join(dotnetRoot,'host/fxr'),frameworkRoot:path.join(dotnetRoot,'shared/Microsoft.NETCore.App/8.0.0')}).map(([name,directory])=>[name,taskFileRuntimeDirectoryIdentity(directory)]));
  const config={schema:'windows_task_file_backend_configuration_v1',dotnetExecutable,buildDirectory,binaryHashes,runtimePins,runtimeIdentities,allowedWorkspaceParent,tasks:[selector]},pin=writeJson(path.join(privateRoot,'backend.json'),config);
  const backend=createTaskFileBackend(pin,{runtimeRoot:store.runtimeRoot,testHooks:options.testHooks});
  return{store,task,identity,credentialFile:member.credentialFile,admin,other,call,counters,worker,options,config,pin,selector,approvalPin,manifestFile,backend,reopen:()=>createTaskFileBackend(pin,{runtimeRoot:store.runtimeRoot,testHooks:options.testHooks}),binding:{groupId:task.groupId,taskId:task.taskId},close:()=>store.close()};
}

// Node --import仅用于实际独立文件server的合成IPC测试；先限制根，再替换内建spawnSync。
if(process.env.COLLAB_FILE_NATIVE_FIXTURE==='1'){
  guard();const {default:childProcess}=await import('node:child_process'),{syncBuiltinESMExports}=await import('node:module');
  childProcess.spawnSync=(_executable,args)=>{const result=syntheticNative(args.slice(1));if(process.env.COLLAB_FILE_NATIVE_AUDIT)fs.appendFileSync(process.env.COLLAB_FILE_NATIVE_AUDIT,JSON.stringify({syntheticOnly:true,operation:args[1]})+'\n');return result;};syncBuiltinESMExports();
}
