import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {readOrdinary} from './qwen-media-adapter.mjs';
import {sha256,fail} from './policy.mjs';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const stop=(ok,code)=>{if(!ok)fail(code,'有界媒体worker已停止；核查原reservation，不自动换号重试。');};
function validate(c){
 const required=['schema','endpoint','memberCredentialFile','expectedWorkerId','groupId','taskId','kind','inputRelativePath','mode','reservationId','maxStatusRequests','pollIntervalMs','expiresAt'];
 stop(c&&Object.keys(c).sort().join(',')===required.sort().join(',')&&c.schema==='core_qwen_worker_v1'&&['prepare','resume'].includes(c.mode)&&['video','speech'].includes(c.kind)&&[c.expectedWorkerId,c.groupId,c.taskId].every(id)&&path.isAbsolute(c.memberCredentialFile??'')&&(c.mode==='prepare'?c.reservationId===null:id(c.reservationId))&&typeof c.inputRelativePath==='string'&&c.inputRelativePath.length<=240&&Number.isInteger(c.maxStatusRequests)&&c.maxStatusRequests>=0&&c.maxStatusRequests<=10&&Number.isInteger(c.pollIntervalMs)&&c.pollIntervalMs>=100&&c.pollIntervalMs<=30000&&Date.parse(c.expiresAt)>Date.now(),'MEDIA_WORKER_CONFIG_INVALID');
 const url=new URL(c.endpoint);stop(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&url.pathname==='/mcp'&&!url.search&&!url.hash&&!url.username&&!url.password,'MEDIA_WORKER_ENDPOINT_FORBIDDEN');return url;
}
export async function runBoundedMediaWorker(config){
 const c=structuredClone(config),url=validate(c),credential=readOrdinary(c.memberCredentialFile,128).toString('utf8');stop(/^[A-Za-z0-9_-]{43}$/.test(credential),'MEDIA_WORKER_CREDENTIAL_INVALID');
 const client=new Client({name:'bounded_core_media_worker',version:'1'}),scope={groupId:c.groupId,taskId:c.taskId};
 async function call(name,args={}){stop(Date.parse(c.expiresAt)>Date.now(),'MEDIA_WORKER_DEADLINE');const result=await client.callTool({name,arguments:args},undefined,{timeout:150000});let value;try{value=result.structuredContent??JSON.parse(result.content?.[0]?.text);}catch{fail('MEDIA_WORKER_RESPONSE_UNKNOWN','工具响应无法确认，停止并保留原状态。');}if(result.isError)fail(/^[A-Z0-9_]+$/.test(value.code)?value.code:'MEDIA_WORKER_TOOL_UNKNOWN','媒体工具未完成，停止并核查原reservation。');return value;}
 try{
  await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${credential}`}}}));
  const capabilities=await call('get_capabilities');stop(capabilities.identity?.instanceId===c.expectedWorkerId&&capabilities.identity.platform==='qwen'&&capabilities.identity.mode==='core_media_worker','MEDIA_WORKER_IDENTITY_MISMATCH');
  const task=await call('get_task',scope);stop(task.task.assigneeId===c.expectedWorkerId,'MEDIA_WORKER_ASSIGNEE_MISMATCH');
  if(c.mode==='prepare'){
   const claim=`media_${c.groupId}_${c.taskId}`;stop(claim.length<110,'MEDIA_WORKER_CONFIG_INVALID');
   await call('start_task',{requestId:claim+'_claim',...scope});
   const input=await call('read_task_file',{...scope,area:'inputs',relativePath:c.inputRelativePath});
   const reservation=await call('reserve_qwen_media',{requestId:claim+'_reserve',...scope,kind:c.kind,inputRelativePath:c.inputRelativePath});
   stop(reservation.inputSha256===input.sha256,'MEDIA_WORKER_INPUT_MISMATCH');return{phase:'awaiting_host_grant',reservation,generationRequests:0,businessCompletedVerified:false};
  }
  const ref={...scope,reservationId:c.reservationId};let r=await call('get_qwen_media',ref);stop(r.workerId===c.expectedWorkerId&&r.kind===c.kind,'MEDIA_WORKER_RESERVATION_MISMATCH');
  const action=async(name,index='')=>call('run_qwen_media',{requestId:`media_${r.reservationId}_${name}${index}`,...ref,action:name,actionId:`${name}_${r.reservationId}${index}`});
  if(!r.post)r=await action('execute');
  if(c.kind==='video'&&r.post?.status==='submitted'){
   while((!r.provider||['PENDING','RUNNING'].includes(r.provider.status))&&r.statusQueriesUsed<c.maxStatusRequests){
    if(r.statusQueriesUsed>0)await new Promise(resolve=>setTimeout(resolve,c.pollIntervalMs));
    r=await action('status',String(r.statusQueriesUsed+1));
   }
   if(r.provider?.status==='SUCCEEDED'&&!r.recovery)r=await action('recover');
  }
  const ready=c.kind==='speech'?r.post?.status==='succeeded':r.provider?.status==='SUCCEEDED'&&r.recovery?.status==='succeeded';
  if(!ready||r.submission&&r.submission.status!=='registered')return{phase:'stopped_or_pending',reservation:r,automaticRetry:false,businessCompletedVerified:false};
  let artifact;
  if(!r.submission){const submitted=await call('submit_qwen_media',{requestId:`media_${r.reservationId}_submit`,...ref,title:c.kind==='video'?'H3视频输出':'Speech音频输出'});artifact=submitted.artifact;r=submitted.reservation;}
  else artifact=(await call('get_artifact',{groupId:c.groupId,artifactId:r.submission.artifactId})).artifact;
  const text=JSON.stringify({reservationId:r.reservationId,artifactId:artifact.artifactId,sha256:artifact.sha256,mimeType:artifact.mimeType,inputVersion:r.inputVersion,native:r.provider??r.post,evidence:r.evidence,modelExecutionVerified:false,businessCompletedVerified:false});
  const result=await call('submit_task_result',{requestId:`media_${r.reservationId}_result`,...scope,text,sourceIds:[{kind:'artifact',id:artifact.artifactId}]});
  return{phase:'core_result_submitted',reservation:r,artifactId:artifact.artifactId,resultArtifactId:result.artifact.artifactId,sha256:artifact.sha256,automaticRetry:false,businessCompletedVerified:false};
 }finally{await client.close();}
}
export function readMediaWorkerConfig(pin){stop(path.isAbsolute(pin?.path??'')&&/^[a-f0-9]{64}$/.test(pin.sha256??''),'MEDIA_WORKER_CONFIG_PIN');const bytes=readOrdinary(pin.path,16384);stop(sha256(bytes)===pin.sha256,'MEDIA_WORKER_CONFIG_CHANGED');const config=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));validate(config);return config;}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const {values}=parseArgs({options:{'configuration-file':{type:'string'},'configuration-sha256':{type:'string'}}});
 try{console.log(JSON.stringify(await runBoundedMediaWorker(readMediaWorkerConfig({path:values['configuration-file'],sha256:values['configuration-sha256']}))));}
 catch(e){console.error(JSON.stringify({code:/^[A-Z0-9_]+$/.test(e.code??'')?e.code:'MEDIA_WORKER_UNKNOWN',automaticRetry:false}));process.exitCode=1;}
}
