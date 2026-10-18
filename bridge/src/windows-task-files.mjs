import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { PROJECT_ROOT, fail, inside, sha256 } from './policy.mjs';
import { SessionFiles, sessionPath, SESSION_FILE_LIMIT, validFileArguments } from './session-files.mjs';

// 本对象只能由可信启动注入；成员参数不接受程序、profile、根目录或认证。
export class WindowsTaskFiles {
  constructor({dotnetExecutable,buildDirectory,binaryHashes,allowedWorkspaceParent,profileCreationAccepted=false}) {
    if(process.platform!=='win32')fail('FILE_OS_UNSUPPORTED','当前OS不支持Windows AppContainer。');
    if(profileCreationAccepted!==true)fail('FILE_OS_PROFILE_NOT_ACCEPTED','尚未明确接受新任务专属profile创建。');
    this.dotnetExecutable=dotnetExecutable;this.buildDirectory=buildDirectory;this.binaryHashes=structuredClone(binaryHashes);
    this.allowedParent=sessionPath(allowedWorkspaceParent);this.bindings=new Map();
    if(!inside(path.join(PROJECT_ROOT,'task-workspaces'),this.allowedParent))fail('FILE_OS_PARENT_FORBIDDEN','OS文件worker父根必须在可信项目的新任务范围。');
    this.checkBinaries();
  }
  checkBinaries(){
    if(!path.isAbsolute(this.dotnetExecutable)||!path.isAbsolute(this.buildDirectory))fail('FILE_OS_BINARY_INVALID','运行入口必须由可信配置提供绝对路径。');
    for(const[name,file]of [['dotnet',this.dotnetExecutable],...['WindowsFileWorker.dll','WindowsFileWorker.deps.json','WindowsFileWorker.runtimeconfig.json'].map(name=>[name,path.join(this.buildDirectory,name)])]){
      const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||sha256(fs.readFileSync(file))!==this.binaryHashes[name])fail('FILE_OS_BINARY_CHANGED','受审查文件worker入口或哈希变化。');
    }
  }
  native(args,cwd,log){
    this.checkBinaries();
    const environment={};for(const name of ['SystemRoot','windir','USERPROFILE','LOCALAPPDATA','APPDATA'])if(process.env[name])environment[name]=process.env[name];
    environment.DOTNET_ROOT=path.dirname(this.dotnetExecutable);environment.DOTNET_EnableDiagnostics='0';environment.DOTNET_GENERATE_ASPNET_CERTIFICATE='false';
    const result=spawnSync(this.dotnetExecutable,[path.join(this.buildDirectory,'WindowsFileWorker.dll'),...args],{cwd,env:environment,windowsHide:true,encoding:'utf8',timeout:40000,maxBuffer:2*1024*1024});
    fs.writeFileSync(log,JSON.stringify({at:new Date().toISOString(),status:result.status,errorCode:result.error?.code??null,stdout:result.stdout??'',stderr:result.stderr??'',automaticRetry:false},null,2),{flag:'wx'});
    if(result.error||result.status!==0)fail('FILE_OS_OPERATION_UNKNOWN','OS worker启动或结果失败，保留占位与文件，不自动重试。');
    let output;try{output=JSON.parse(result.stdout);}catch{fail('FILE_OS_RECEIPT_INVALID','未取得有界文件worker回执。');}return output;
  }
  prepareTask({workspace,scope}){
    const files=new SessionFiles({workspace,scope}),root=files.workspace.cwd;
    if(!inside(this.allowedParent,root)||path.resolve(root)===this.allowedParent)fail('FILE_OS_TASK_FORBIDDEN','任务不属于明确允许的新任务父根。');
    const directory=sessionPath(path.join(root,'.os-worker'),false);if(fs.existsSync(directory))fail('FILE_OS_ALREADY_RESERVED','任务已有隔离意图，不接管或自动重建profile。');
    fs.mkdirSync(directory);const profileName=`collaboration.t10.${randomUUID().replaceAll('-','')}`;
    const config={TaskRoot:root,AllowedParent:this.allowedParent,ProfileName:profileName,BuildDirectory:this.buildDirectory,DotnetRoot:path.dirname(this.dotnetExecutable)};
    const configFile=path.join(directory,'broker-config.json');fs.writeFileSync(configFile,JSON.stringify(config),{flag:'wx',mode:0o600});
    const prepared=this.native(['--prepare',configFile],root,path.join(directory,'prepare-receipt.json'));
    if(prepared.TaskRoot!==root||prepared.ProfileName!==profileName||!/^S-1-15-2-/.test(prepared.Sid))fail('FILE_OS_BINDING_INVALID','实际profile回执未绑定当前任务。');
    files.verify();const binding={workspaceBinding:workspace.markerSha256,configFile,directory,sid:prepared.Sid,profileName,profileFolder:prepared.ProfileFolder,runtimeDirectory:prepared.RuntimeDirectory,lastAttestation:null};
    binding.runtimeHashes=Object.fromEntries(['WindowsFileWorker.dll','WindowsFileWorker.deps.json','WindowsFileWorker.runtimeconfig.json'].map(name=>[name,sha256(fs.readFileSync(path.join(prepared.RuntimeDirectory,name)))]));
    for(const[name,hash]of Object.entries(binding.runtimeHashes))if(hash!==this.binaryHashes[name])fail('FILE_OS_RUNTIME_CHANGED','复制到任务的受限runtime哈希不符。');
    this.bindings.set(workspace.taskId,binding);return{configured:true,prepared:true,mechanism:'windows_appcontainer',profileName,profileRetained:true,workerOsIsolationVerified:false,platformOsIsolationVerified:false};
  }
  binding(workspace){const binding=this.bindings.get(workspace.taskId);if(!binding||binding.workspaceBinding!==workspace.markerSha256)fail('FILE_OS_NOT_PREPARED','当前任务没有可信准备的OS worker，不能回退普通文件进程。');for(const[name,hash]of Object.entries(binding.runtimeHashes))if(sha256(fs.readFileSync(path.join(binding.runtimeDirectory,name)))!==hash)fail('FILE_OS_RUNTIME_CHANGED','任务内runtime已改变。');return binding;}
  invoke({workspace,scope},args,operation){
    if(!validFileArguments(operation==='read'?'read_task_file':'write_task_file',args))fail('FILE_ARGUMENT_INVALID','只接收当前任务有界文件结构，inputs对OS worker只读。');
    const files=new SessionFiles({workspace,scope}),binding=this.binding(workspace),target=files.target(args.area,args.relativePath);
    if(operation==='write'){fs.mkdirSync(sessionPath(path.dirname(target),false),{recursive:true});files.verify();}
    const operationId=randomUUID(),jobFile=path.join(binding.directory,`request-${operationId}.json`),log=path.join(binding.directory,`receipt-${operationId}.json`);
    const job={Operation:operation,Target:target,Text:operation==='write'?args.text:null,ExpectedSid:binding.sid};fs.writeFileSync(jobFile,JSON.stringify(job),{flag:'wx',mode:0o600});
    const output=this.native(['--run',binding.configFile,jobFile],workspace.cwd,log),actual=output.workerResult;
    if(output.exitCode!==0||!actual||actual.status==='failed_or_blocked')fail('FILE_OS_OPERATION_UNKNOWN','受限文件worker未取得成功终态，原文件/意图保留。');
    const token=output.token;
    for(const observed of [token,actual.token])if(observed?.isAppContainer!==true||observed.appContainerSid!==binding.sid||observed.integritySid!=='S-1-16-4096'||observed.capabilityCount!==0)fail('FILE_OS_TOKEN_INVALID','实际进程令牌不符合当前任务AppContainer。');
    if(actual.pid!==output.pid)fail('FILE_OS_TOKEN_INVALID','worker回执进程与实际进程不符。');
    files.verify();const checked=files.read({area:args.area,relativePath:args.relativePath});
    const result=operation==='read'?actual:actual.result;
    if(result.sha256!==checked.sha256||result.byteLength!==checked.byteLength||(operation==='read'&&actual.text!==checked.text))fail('FILE_OS_READBACK_MISMATCH','OS文件结果与独立broker读回不符。');
    binding.lastAttestation={mechanism:'windows_appcontainer',workerPid:output.pid,isAppContainer:true,capabilityCount:0,integritySid:token.integritySid,taskBound:true,networkCapabilitiesGranted:false,profileRetained:true};
    return{...checked,...(operation==='write'?{text:undefined,created:true,overwritten:false}:{}),osIsolationVerified:true,fileWorkerOsIsolationVerified:true,platformOsIsolationVerified:false,osEvidence:binding.lastAttestation};
  }
  read(binding,args){return this.invoke(binding,args,'read');}
  write(binding,args){return this.invoke(binding,args,'write');}
  capabilities(workspace){return{implemented:true,mechanism:'windows_appcontainer',configured:true,taskPrepared:this.bindings.has(workspace.taskId),workerOsIsolationVerified:!!this.bindings.get(workspace.taskId)?.lastAttestation,platformOsIsolationVerified:false,scope:'task_files_plus_readonly_runtime_and_own_profile',automaticFallback:false};}
}
