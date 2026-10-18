import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assessIndependentRun({independentEnvironment=false,baseline=[],observations=[],peers=[],source='fixture'}){
 const blockers=[];
 if(!independentEnvironment)blockers.push('G_INDEPENDENT_ENVIRONMENT_REQUIRED');
 if(source!=='direct_windows_and_mcp_observation')blockers.push('G_DIRECT_OBSERVATION_REQUIRED');
 if(!baseline.length)blockers.push('G_CODEX_APP_BASELINE_REQUIRED');
 if(observations.length<2||observations.some(item=>!item.querySucceeded||item.appProcesses.length))blockers.push('G_CODEX_APP_CLOSURE_UNCONFIRMED');
 if(new Set(peers.map(item=>item.platform)).size!==2||!peers.some(item=>item.platform==='workbuddy')||!peers.some(item=>item.platform==='doubao'))blockers.push('G_TWO_REAL_PLATFORMS_REQUIRED');
 const closedAt=observations[0]?.at??null;
 for(const peer of peers){
  const execution=peer.execution,native=peer.native;
  if(peer.mode!=='desktop'||peer.identityVerified!==true||execution?.state!=='succeeded'||execution.evidenceLevel!=='real_runtime'||execution.verifiedStages?.modelStarted!==true||execution.verifiedStages?.replyObserved!==true||execution.replyAccessAllowed!==true||!execution.replyText?.some(text=>typeof text==='string'&&text.length)||native?.sourceType!=='controlled_adapter'||native.runtimeVerified!==true||native.platform!==peer.platform||native.mode!==peer.mode||execution.nativeBindingId!==native.bindingId||!native.nativeId)blockers.push('G_REAL_PLATFORM_PROCESSING_REPLY_REQUIRED');
  if(!closedAt||!peer.executedAfterClosure||!peer.receiverReadbackAfterClosure)blockers.push('G_POST_CLOSURE_EXECUTION_AND_PEER_READBACK_REQUIRED');
 }
 if(peers.length!==2)blockers.push('G_TWO_REAL_PLATFORMS_REQUIRED');
 return{status:blockers.length?'blocked':'passed',gVerified:blockers.length===0,blockers:[...new Set(blockers)],businessCompletedVerified:false,parentExitIsCodexClosure:false,automaticRetry:false};
}
function sampleWindowsApp(config){
 // 全部同安装目录的应用进程必须消失；不只检查某个PID或launcher。不终止任何进程。
 const script="$ErrorActionPreference='Stop'; $all=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -and [IO.Path]::GetDirectoryName($_.ExecutablePath) -eq $env:COLLAB_G_APP_DIRECTORY} | ForEach-Object {@{pid=$_.ProcessId;parentPid=$_.ParentProcessId;image=$_.ExecutablePath;started=$_.CreationDate.ToUniversalTime().ToString('o')}}); ConvertTo-Json -InputObject $all -Compress";
 const result=execFileSync(config.powerShellExecutable,['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,encoding:'utf8',env:{SystemRoot:process.env.SystemRoot,COLLAB_G_APP_DIRECTORY:path.dirname(config.codexApplicationExecutable)}});
 const appProcesses=JSON.parse(result);if(!Array.isArray(appProcesses))throw new Error('应用进程观察未返回数组。');
 return{at:new Date().toISOString(),querySucceeded:true,appProcesses};
}
export async function collectIndependentRun(config){
 if(process.platform!=='win32'||config.independentEnvironmentConfirmed!==true)throw Object.assign(new Error('必须在已明确指定的独立Windows环境运行，不关闭当前主控。'),{code:'G_INDEPENDENT_ENVIRONMENT_REQUIRED'});
 if(!path.isAbsolute(config.codexApplicationExecutable??'')||!/^codex[.]exe$/i.test(path.basename(config.codexApplicationExecutable))||!path.isAbsolute(config.powerShellExecutable??'')||!Number.isInteger(config.durationSeconds)||config.durationSeconds<5||config.durationSeconds>600)throw new Error('需要明确Codex应用入口、PowerShell入口和有界观察时长。');
 const directory=path.resolve(config.outputDirectory);fs.mkdirSync(directory,{recursive:false});const journal=path.join(directory,'observations.jsonl');const fd=fs.openSync(journal,'wx',0o600);let previousHash='0'.repeat(64);
 const append=value=>{const entry={previousHash,value};entry.sha256=hash(entry);fs.writeSync(fd,JSON.stringify(entry)+'\n',null,'utf8');fs.fsyncSync(fd);previousHash=entry.sha256;};
 const clients=[];
 try{
  const baseline=sampleWindowsApp(config).appProcesses;append({event:'baseline',runId:randomUUID(),baseline,operatorEnvironmentAssertion:true,assertionIsIndependentProof:false,willCloseApplication:false});
  if(!baseline.some(item=>item.image.toLowerCase()===config.codexApplicationExecutable.toLowerCase()))throw Object.assign(new Error('未观察到指定Codex应用，不能用普通父进程退出代替。'),{code:'G_CODEX_APP_BASELINE_REQUIRED'});
  const peers=[];
  for(const peer of config.peers??[]){
   const url=new URL(peer.endpoint);if(url.hostname!=='127.0.0.1'||url.protocol!=='http:')throw new Error('仅观察独立环境本机受审查协作服务。');
   const credential=fs.readFileSync(peer.credentialFile,'utf8');if(!/^[A-Za-z0-9_-]{43}$/.test(credential))throw new Error('本机凭据格式无效。');
   const client=new Client({name:'independent_readonly_acceptance_observer',version:'0.2.4'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${credential}`}}}));
   const call=async(name,args={})=>{const result=await client.callTool({name,arguments:args});if(result.isError)throw new Error('验收只读请求被拒绝。');return result.structuredContent??JSON.parse(result.content[0].text);};
   const caps=await call('get_capabilities');if(caps.identity?.platform!==peer.platform||caps.identity?.mode!==peer.mode)throw new Error('服务凭据身份不匹配指定平台模式。');
   peers.push({...peer,call,identityVerified:caps.platformIdentityVerified===true});append({event:'service_connected',platform:peer.platform,mode:peer.mode,registeredInstance:caps.identity.instanceId,platformIdentityVerified:caps.platformIdentityVerified===true});
  }
  let observations=[],peerEvidence=[];const deadline=Date.now()+config.durationSeconds*1000;
  while(Date.now()<deadline){
   const observation=sampleWindowsApp(config);append({event:'process_sample',...observation});
   if(observation.appProcesses.length)observations=[];else observations.push(observation);
   if(observations.length>=2){
    peerEvidence=[];
    for(const peer of peers){const args={groupId:peer.groupId,taskId:peer.taskId};const {execution}=await peer.call('get_execution',{...args,executionId:peer.executionId});const {native}=await peer.call('get_native_session',args);
     // 当前核心没有可信模型开始与对端读回阶段，保持阻塞；不接受配置自报来填这两项。
     peerEvidence.push({platform:peer.platform,mode:peer.mode,identityVerified:peer.identityVerified,execution,native,executedAfterClosure:false,receiverReadbackAfterClosure:false});append({event:'execution_observed',platform:peer.platform,executionId:execution.executionId,state:execution.state,evidenceLevel:execution.evidenceLevel,replySha256:hash(execution.replyText??null),nativeHash:hash(native.nativeId)});
    }
    const result=assessIndependentRun({independentEnvironment:true,baseline,observations,peers:peerEvidence,source:'direct_windows_and_mcp_observation'});append({event:'assessment',...result});if(result.gVerified)break;
   }
   await new Promise(resolve=>setTimeout(resolve,1000));
  }
  const result=assessIndependentRun({independentEnvironment:true,baseline,observations,peers:peerEvidence,source:'direct_windows_and_mcp_observation'});append({event:'final',...result});fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({...result,journalSha256:previousHash},null,2),{flag:'wx'});return result;
 }catch(error){append({event:'blocked',code:error.code??'G_OBSERVATION_FAILED',message:error.message,gVerified:false,automaticRetry:false});throw error;}
 finally{await Promise.allSettled(clients.map(client=>client.close()));fs.closeSync(fd);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 try{if(process.argv.length!==3)throw Object.assign(new Error('需显式提供独立环境私有配置；本驱动不关闭应用，不发送任务或启动模型。'),{code:'G_INDEPENDENT_ENVIRONMENT_REQUIRED'});const result=await collectIndependentRun(JSON.parse(fs.readFileSync(process.argv[2],'utf8')));console.log(JSON.stringify(result));if(!result.gVerified)process.exitCode=2;}
 catch(error){console.log(JSON.stringify({status:'blocked',code:error.code??'G_OBSERVATION_FAILED',message:error.message,gVerified:false,automaticRetry:false}));process.exitCode=2;}
}
