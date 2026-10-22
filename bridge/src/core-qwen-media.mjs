import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PROJECT_ROOT,SOURCE_ROOT,sha256,inside,fail} from './policy.mjs';
import {SessionFiles} from './session-files.mjs';
import {QwenMediaAdapter,QWEN_ORIGIN,QWEN_MODELS,ordinaryPath,readOrdinary,nativeQwenTransport,qwenNetworkPreflight} from './qwen-media-adapter.mjs';
import {validateLoopbackProxy} from './qwen-loopback-connect.mjs';
import {validateDownloadProxy} from './content-download-proxy.mjs';
import {inspectCoreMediaOutput} from './collaboration-media.mjs';

export const CORE_QWEN_TOOLS=['reserve_qwen_media','get_qwen_media','run_qwen_media','submit_qwen_media'];
export const isCoreMediaWorker=identity=>identity?.kind==='member'&&identity.platform==='qwen'&&identity.mode==='core_media_worker';
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(item=>JSON.parse(canonical(item))):Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])):value);
const pin=value=>sha256(canonical(value)),now=()=>new Date().toISOString();
const requireThat=(ok,code)=>{if(!ok)fail(code,'核心媒体操作已停止；原占位与证据保留，不自动重试。');};
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===[...keys].sort().join(',');
const safeCode=error=>/^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code??'')?error.code:'CORE_MEDIA_UNKNOWN';
const directory=file=>{ordinaryPath(file);const s=fs.statSync(file,{bigint:true});requireThat(s.isDirectory(),'CORE_MEDIA_DIRECTORY');return{path:path.resolve(file),realPath:fs.realpathSync(file),dev:String(s.dev),ino:String(s.ino),birthtimeNs:String(s.birthtimeNs)};};
function write(file,value){ordinaryPath(path.dirname(file));ordinaryPath(file,false);const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n'),fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}return{sha256:sha256(bytes),byteLength:bytes.length};}
function json(file,limit=1048576){return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readOrdinary(file,limit)));}
function hasOsIntent(task){try{fs.lstatSync(path.join(task.workspace.cwd,'.os-worker'));return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
export function coreMediaSourcePin(){return pin(['core-qwen-media.mjs','core-qwen-worker.mjs','../scripts/core-qwen-host-plan.mjs','qwen-media-adapter.mjs','collaboration-store.mjs','collaboration-tools.mjs','collaboration-service.mjs','configured-collaboration-service.mjs','collaboration-media.mjs','collaboration-file-boundary.mjs','collaboration-workspaces.mjs','session-files.mjs','policy.mjs','content-download.mjs','content-download-proxy.mjs','qwen-loopback-connect.mjs','qwen-error-diagnostics.mjs'].map(name=>({name,sha256:sha256(fs.readFileSync(new URL(name,import.meta.url)))})));}
const bindingState=task=>({groupId:task.groupId,taskId:task.taskId,workerId:task.assigneeId,assignmentRevision:task.assignmentRevision,workspace:task.workspace,scope:task.scope,fileAcl:task.fileAcl,sourceIds:task.sourceIds});
function safeNative(result){const fields=['operationId','kind','origin','requestSha256','payloadSha256','requestedModel','actualModelIdentity','httpStatus','task_id','request_id','trace_id','code','provider_code','status','task_status','providerTaskSucceeded','automaticRetry'];return Object.fromEntries(fields.filter(k=>result[k]!==undefined).map(k=>[k,result[k]]));}

// 可信宿主入口。配置和grant不通过MCP传入；文件边界不等于平台OS隔离。
export class CoreQwenMedia {
 constructor(store,config=null,{transport=null,download=null,networkPreflight=null}={}){
  this.store=store;this.config=config?structuredClone(config):null;this.enabled=config?.enabled===true;
  if(!this.enabled){requireThat(!transport&&!download&&!networkPreflight,'CORE_MEDIA_TEST_HOOK_FORBIDDEN');return;}
  requireThat(!transport&&!download&&!networkPreflight||process.env.COLLAB_TEST_MODE==='1'&&PROJECT_ROOT!==SOURCE_ROOT,'CORE_MEDIA_TEST_HOOK_FORBIDDEN');
  requireThat(!networkPreflight||transport,'CORE_MEDIA_TEST_HOOK_FORBIDDEN');
  this.synthetic=Boolean(transport||download||networkPreflight);this.transport=transport??nativeQwenTransport;this.download=download;
  const c=this.config;
  const required=['schema','enabled','authorityId','expiresAt','credentials','stockVoiceIds','allowedMediaHosts','totalBudget'];requireThat(required.every(k=>Object.hasOwn(c,k))&&Object.keys(c).every(k=>[...required,'network','recovery'].includes(k))&&exact(c.credentials,['video','speech'])&&['video','speech'].every(k=>exact(c.credentials[k],['credentialFile']))&&(!c.network||exact(c.network,['proxy']))&&(!c.recovery||exact(c.recovery,['proxy'])),'CORE_MEDIA_HOST_INVALID');
  this.networkPreflight=networkPreflight??(this.synthetic?async()=>({mode:'synthetic',httpRequests:0}):qwenNetworkPreflight);
  if(c.network?.proxy)validateLoopbackProxy(c.network.proxy);if(c.recovery?.proxy)validateDownloadProxy(c.recovery.proxy);
  requireThat(c.schema==='core_qwen_media_host_v1'&&/^[A-Za-z0-9_-]{1,128}$/.test(c.authorityId??'')&&Date.parse(c.expiresAt)>Date.now()&&Array.isArray(c.stockVoiceIds)&&Array.isArray(c.allowedMediaHosts),'CORE_MEDIA_HOST_INVALID');
  requireThat(exact(c.totalBudget,['videoPosts','speechPosts','statusGets','downloads','videoSeconds','speechCharacters','downloadBytes'])&&Object.values(c.totalBudget).every(n=>Number.isSafeInteger(n)&&n>=0)&&c.totalBudget.videoPosts<=100&&c.totalBudget.speechPosts<=100&&c.totalBudget.statusGets<=300&&c.totalBudget.downloads<=100,'CORE_MEDIA_HOST_INVALID');
  this.root=path.join(store.runtimeRoot,'private-core-media');ordinaryPath(this.root,false);fs.mkdirSync(this.root,{recursive:true});
  for(const name of ['jobs','grants','credentials']){ordinaryPath(path.join(this.root,name),false);fs.mkdirSync(path.join(this.root,name),{recursive:true});}
  for(const kind of ['video','speech'])requireThat(path.isAbsolute(c.credentials?.[kind]?.credentialFile??'')&&inside(path.join(this.root,'credentials'),c.credentials[kind].credentialFile),'CORE_MEDIA_CREDENTIAL_SCOPE');
  this.privateIdentity=directory(this.root);this.grantIdentity=directory(path.join(this.root,'grants'));this.jobsIdentity=directory(path.join(this.root,'jobs'));this.credentialIdentity=directory(path.join(this.root,'credentials'));this.configSha256=pin(c);this.sourceSha256=coreMediaSourcePin();
  const state={configSha256:this.configSha256,sourceSha256:this.sourceSha256,privateIdentity:this.privateIdentity,grantIdentity:this.grantIdentity,jobsIdentity:this.jobsIdentity,credentialIdentity:this.credentialIdentity};
  store.tx(()=>{const old=store.get('core_qwen_authority',c.authorityId,false);requireThat(!old||pin(old)===pin(state),'CORE_MEDIA_AUTHORITY_CHANGED');if(!old)store.put('core_qwen_authority',c.authorityId,state);});
 }
 check(){requireThat(this.enabled,'CORE_MEDIA_DISABLED');requireThat(Date.parse(this.config.expiresAt)>Date.now(),'CORE_MEDIA_HOST_EXPIRED');requireThat(coreMediaSourcePin()===this.sourceSha256&&pin(directory(this.root))===pin(this.privateIdentity)&&pin(directory(path.join(this.root,'grants')))===pin(this.grantIdentity)&&pin(directory(path.join(this.root,'jobs')))===pin(this.jobsIdentity)&&pin(directory(path.join(this.root,'credentials')))===pin(this.credentialIdentity),'CORE_MEDIA_HOST_CHANGED');}
 task(identity,args){this.check();requireThat(isCoreMediaWorker(identity),'CORE_MEDIA_WORKER_REQUIRED');this.store.assertIdentity(identity);const task=this.store.task(identity,args.groupId,args.taskId);requireThat(task.assigneeId===identity.instanceId&&task.fileAcl.readers.includes(identity.instanceId)&&task.fileAcl.writers.includes(identity.instanceId)&&!task.fileAcl.inputWriters.includes(identity.instanceId),'CORE_MEDIA_TASK_ACL');requireThat(!this.store.fileWorker,'FILE_OS_MEDIA_UNSUPPORTED');new SessionFiles({workspace:task.workspace,scope:task.scope});let reserved=false;try{fs.lstatSync(path.join(task.workspace.cwd,'.os-worker'));reserved=true;}catch(e){if(e.code!=='ENOENT')throw e;}requireThat(!reserved,'FILE_OS_MEDIA_UNSUPPORTED');return task;}
 input(task,name){const files=new SessionFiles({workspace:task.workspace,scope:task.scope});const result=files.read({area:'inputs',relativePath:name}),value=JSON.parse(result.text);requireThat(exact(value,['schema','inputVersion','input','parameters'])&&value.schema==='core_qwen_media_input_v1'&&/^[A-Za-z0-9_-]{1,128}$/.test(value.inputVersion??''),'CORE_MEDIA_INPUT_INVALID');const file=files.target('inputs',name),identity=this.store.fileIdentity(file);return{value,pin:{relativePath:name,sha256:result.sha256,byteLength:result.byteLength,inputVersion:value.inputVersion,identity}};}
 record(identity,args){const task=this.task(identity,args),r=this.store.get('core_qwen_reservation',args.reservationId);requireThat(r.groupId===args.groupId&&r.taskId===args.taskId&&r.workerId===identity.instanceId,'CORE_MEDIA_RESERVATION_SCOPE');this.verify(r,task);return r;}
 verify(r,task=this.store.get('task',`${r.groupId}:${r.taskId}`)){
  this.check();const member=this.store.member(r.workerId);requireThat(isCoreMediaWorker(member)&&member.status==='active','CORE_MEDIA_WORKER_REQUIRED');
  requireThat(r.synthetic===this.synthetic&&this.store.get('group',r.groupId).members[r.workerId]?.state==='active','CORE_MEDIA_WORKER_REQUIRED');
  requireThat(pin(bindingState(task))===r.taskStateSha256,'CORE_MEDIA_ASSIGNMENT_CHANGED');
  new SessionFiles({workspace:task.workspace,scope:task.scope});const current=this.input(task,r.input.relativePath);requireThat(pin(current.pin)===pin(r.input),'CORE_MEDIA_INPUT_CHANGED');
  requireThat(!this.store.fileWorker&&!hasOsIntent(task),'FILE_OS_MEDIA_UNSUPPORTED');
 }
 safe(r){return{reservationId:r.reservationId,groupId:r.groupId,taskId:r.taskId,workerId:r.workerId,assignmentRevision:r.assignmentRevision,kind:r.kind,inputVersion:r.input.inputVersion,inputSha256:r.input.sha256,phase:r.phase,post:r.post??null,provider:r.provider??null,recovery:r.recovery??null,submission:r.submission??null,statusQueriesUsed:(r.actions??[]).filter(a=>a.action==='status').length,evidence:r.synthetic?'synthetic_local_api':'host_native_api',modelExecutionVerified:false,businessCompletedVerified:false,platformOsIsolationVerified:false,automaticRetry:false};}
 reserve(identity,args){return this.store.perform(identity,'reserve_qwen_media',args,()=>{
  const task=this.task(identity,args);requireThat(task.agentReported?.state==='processing'&&task.agentReported.authorId===identity.instanceId,'CORE_MEDIA_CLAIM_REQUIRED');const input=this.input(task,args.inputRelativePath);
  requireThat(this.store.db.prepare('SELECT 1 FROM core_reads WHERE actor=? AND kind=? AND record_id=? AND group_id=?').get(identity.instanceId,'task_input',`${args.groupId}:${args.taskId}:${args.inputRelativePath}:${input.pin.sha256}`,args.groupId),'CORE_MEDIA_INPUT_NOT_READ');
  requireThat(!this.store.list('core_qwen_reservation').some(r=>r.groupId===args.groupId&&r.taskId===args.taskId)&&!this.store.list('media_generation').some(r=>r.groupId===args.groupId&&r.taskId===args.taskId)&&!this.store.list('artifact').some(a=>a.groupId===args.groupId&&a.taskId===args.taskId&&['binary_media','external_media_archive'].includes(a.kind)),'CORE_MEDIA_TASK_RESERVED');
  const reservationId=randomUUID(),r={reservationId,groupId:args.groupId,taskId:args.taskId,workerId:identity.instanceId,assignmentRevision:task.assignmentRevision,kind:args.kind,input:input.pin,taskStateSha256:pin(bindingState(task)),synthetic:this.synthetic,phase:'core_reserved',createdAt:now()};this.store.put('core_qwen_reservation',reservationId,r);this.store.event(identity,'core_qwen_reserved',args.groupId,{taskId:args.taskId,reservationId,inputSha256:input.pin.sha256});return this.safe(r);
 });}
 materialize(r){
  this.verify(r);const task=this.store.get('task',`${r.groupId}:${r.taskId}`),job=path.join(this.root,'jobs',r.reservationId);ordinaryPath(job,false);fs.mkdirSync(job,{recursive:true});const privateWork=path.join(job,'work');ordinaryPath(privateWork,false);fs.mkdirSync(privateWork,{recursive:true});
  const binding={schema:'qwen_media_task_binding_v2',projectRoot:PROJECT_ROOT,taskRoot:task.workspace.taskRoot,taskId:r.taskId,privateWork,core:{groupId:r.groupId,workerId:r.workerId,workspaceId:task.workspace.taskId,markerSha256:task.workspace.markerSha256,assignmentRevision:r.assignmentRevision,input:r.input,taskStateSha256:r.taskStateSha256},directories:{inputs:task.scope.directories.inputs,work:directory(privateWork),outputs:task.scope.directories.outputs}};
  const bindingFile=path.join(job,'binding.json');if(fs.existsSync(bindingFile))requireThat(pin(json(bindingFile))===pin(binding),'CORE_MEDIA_BINDING_CHANGED');else write(bindingFile,binding);
  const input=this.input(task,r.input.relativePath).value,request={operationId:r.reservationId,kind:r.kind,input:input.input,parameters:input.parameters};
  return{job,binding,bindingFile,bindingSha256:sha256(readOrdinary(bindingFile)),request};
 }
 adapter(r,m,grant=null,rawSink=null){
  const config={schema:'qwen_media_host_v1',origin:QWEN_ORIGIN,models:QWEN_MODELS,bindingFile:m.bindingFile,bindingSha256:m.bindingSha256,credentials:this.config.credentials,stockVoiceIds:this.config.stockVoiceIds,inputMediaHosts:[],generationBudget:{video:1,speech:1},generationApprovals:grant?{[r.reservationId]:{kind:r.kind,requestSha256:sha256(JSON.stringify(m.request)),maxRequests:1,maxUnits:r.kind==='video'?m.request.parameters.duration:[...m.request.input.text].length,expiresAt:grant.expiresAt}}:{},recovery:null};
  config.network=this.config.network??null;
  return new QwenMediaAdapter(config,{verifyCoreBinding:b=>{this.verify(r);requireThat(pin(b)===pin(m.binding),'CORE_MEDIA_BINDING_CHANGED');return true;},transport:async request=>{const response=await this.transport(request);if(rawSink)rawSink(response,request.token);return response;},...(this.download?{download:this.download}:{})});
 }
 // manager只读/离线准备grant，既不读取API凭据也不调用平台。
 plan(reservationId){this.check();const r=this.store.get('core_qwen_reservation',reservationId),m=this.materialize(r),p=this.adapter(r,m).planRequest(m.request);const context={schema:'core_qwen_grant_context_v1',authorityId:this.config.authorityId,reservationId,groupId:r.groupId,taskId:r.taskId,workerId:r.workerId,assignmentRevision:r.assignmentRevision,input:r.input,bindingSha256:m.bindingSha256,sourceSha256:this.sourceSha256,configSha256:this.configSha256,origin:QWEN_ORIGIN,model:p.model,requestSha256:p.requestSha256,bodySha256:p.bodySha256,units:p.units,allowedActions:['execute',...(r.kind==='video'?['status','recover']:[])],totalBudget:this.config.totalBudget};return{context,contextSha256:pin(context),grantFile:path.join(this.root,'grants',r.reservationId+'.json'),networkRequests:0,credentialReads:0};}
 grant(r){const plan=this.plan(r.reservationId),g=json(plan.grantFile,16384);requireThat(exact(g,['schema','contextSha256','expiresAt','maxPostRequests','maxStatusRequests','maxDownloads'])&&g.schema==='core_qwen_grant_v1'&&g.contextSha256===plan.contextSha256&&g.maxPostRequests===1&&Number.isSafeInteger(g.maxStatusRequests)&&g.maxStatusRequests>=0&&g.maxStatusRequests<=10&&Number.isSafeInteger(g.maxDownloads)&&g.maxDownloads>=0&&g.maxDownloads<=1&&(r.kind==='video'||g.maxStatusRequests===0&&g.maxDownloads===0)&&Date.parse(g.expiresAt)>Date.now()&&Date.parse(g.expiresAt)<=Date.parse(this.config.expiresAt),'CORE_MEDIA_GRANT_REQUIRED');return{...g,sha256:sha256(readOrdinary(plan.grantFile)),context:plan.context};}
 claim(identity,args,r,g){
  const action=args.action,actions=r.actions??=[];requireThat(!actions.some(a=>a.actionId===args.actionId),'CORE_MEDIA_ACTION_RESERVED');
  requireThat(!actions.some(a=>a.status==='reserved_unknown'),'CORE_MEDIA_ACTION_UNKNOWN');
  if(action==='execute')requireThat(!r.post,'CORE_MEDIA_POST_RESERVED');
  if(action==='status')requireThat(r.kind==='video'&&r.post?.status==='submitted'&&(!r.provider||['PENDING','RUNNING'].includes(r.provider.status))&&actions.filter(a=>a.action==='status').length<g.maxStatusRequests,'CORE_MEDIA_QUERY_BLOCKED');
  if(action==='recover')requireThat(r.kind==='video'&&r.provider?.status==='SUCCEEDED'&&r.sourceContract&&!r.recovery&&g.maxDownloads===1,'CORE_MEDIA_RECOVERY_BLOCKED');
  requireThat(!r.grantSha256||r.grantSha256===g.sha256,'CORE_MEDIA_GRANT_CHANGED');r.grantSha256=g.sha256;
  const budget=this.store.get('core_qwen_budget',this.config.authorityId,false)??Object.fromEntries(Object.keys(this.config.totalBudget).map(k=>[k,0])),counts=action==='execute'?{[r.kind==='video'?'videoPosts':'speechPosts']:1,[r.kind==='video'?'videoSeconds':'speechCharacters']:g.context.units}:action==='status'?{statusGets:1}:{downloads:1,downloadBytes:64*1024*1024};
  for(const[k,n]of Object.entries(counts)){requireThat(budget[k]+n<=this.config.totalBudget[k],'CORE_MEDIA_TOTAL_BUDGET');budget[k]+=n;}
  if(action==='execute'){const key=pin({origin:QWEN_ORIGIN,kind:r.kind,bodySha256:g.context.bodySha256});requireThat(!this.store.get('core_qwen_payload',key,false),'CORE_MEDIA_PAYLOAD_RESERVED');this.store.put('core_qwen_payload',key,{reservationId:r.reservationId,grantSha256:g.sha256,state:'unknown_no_retry'});r.post={status:'reserved_unknown',request_id:null,task_id:null,actualModelIdentity:null};}
  if(action==='recover')r.recovery={status:'reserved_unknown'};
  actions.push({action,actionId:args.actionId,status:'reserved_unknown',at:now()});r.actions=actions;r.phase='core_claimed_adapter_pending';this.store.put('core_qwen_budget',this.config.authorityId,budget);this.store.put('core_qwen_reservation',r.reservationId,r);this.store.event(identity,'core_qwen_action_reserved',r.groupId,{taskId:r.taskId,reservationId:r.reservationId,action,actionId:args.actionId,grantSha256:g.sha256});
 }
 async complete(identity,args,r,g){
  const m=this.materialize(r),rawFile=path.join(m.job,`native-${args.actionId}.json`);let rawPin=null,result;
  const sink=(response,token)=>{let body=JSON.stringify(response.body);if(token)body=body.replaceAll(token,'[REDACTED]');rawPin=write(rawFile,{httpStatus:response.httpStatus,body:JSON.parse(body),at:now(),synthetic:this.synthetic});};
  try{
   if(args.action==='recover'){
    const source=json(path.join(m.binding.privateWork,r.sourceContract.relativePath),32768);requireThat(this.config.allowedMediaHosts.includes(source.hostname),'CORE_MEDIA_SOURCE_HOST');
    const request={recoveryId:args.actionId,source:r.sourceContract,outputName:`qwen-${r.reservationId}.mp4`},config={schema:'qwen_media_host_v1',origin:QWEN_ORIGIN,models:QWEN_MODELS,bindingFile:m.bindingFile,bindingSha256:m.bindingSha256,stockVoiceIds:this.config.stockVoiceIds,recovery:{allowedHosts:this.config.allowedMediaHosts,maxBytes:64*1024*1024,timeoutMs:120000,maxDownloads:1,approvals:{[args.actionId]:{requestSha256:sha256(JSON.stringify(request)),urlSha256:source.urlSha256,hostname:source.hostname,maxRequests:1,expiresAt:g.expiresAt}}}};
    config.recovery.proxy=this.config.recovery?.proxy??null;
    result=await new QwenMediaAdapter(config,{verifyCoreBinding:b=>{this.verify(r);requireThat(pin(b)===pin(m.binding),'CORE_MEDIA_BINDING_CHANGED');return true;},...(this.download?{download:this.download}:{})}).recover(request);
   }else{const adapter=this.adapter(r,m,g,sink);result=args.action==='execute'?await adapter.execute(m.request):await adapter.status(r.reservationId,args.actionId);}
  }catch(error){result={status:'unknown',code:safeCode(error),automaticRetry:false};}
  // 核心与adapter各自持久化。中断可留下reserved_unknown；不补偿、不重新POST。
  const privatePin=write(path.join(m.job,`action-${args.actionId}.json`),{action:args.action,result,rawReceipt:rawPin,grantSha256:g.sha256,at:now()});
  const stored=this.store.tx(()=>{const current=this.store.get('core_qwen_reservation',r.reservationId);current.phase='adapter_recorded';current.actions.find(a=>a.actionId===args.actionId).status=result.status;current.actions.find(a=>a.actionId===args.actionId).privateReceiptSha256=privatePin.sha256;
   if(args.action==='execute')current.post=safeNative(result);if(args.action==='status'){current.provider=safeNative(result);if(result.sourceContract)current.sourceContract=result.sourceContract;}if(args.action==='recover')current.recovery={status:result.status,code:result.code??null};
   if(result.output&&result.status==='succeeded')current.output=result.output;this.store.put('core_qwen_reservation',current.reservationId,current);this.store.event(identity,'core_qwen_adapter_recorded',current.groupId,{taskId:current.taskId,reservationId:current.reservationId,action:args.action,status:result.status,privateReceiptSha256:privatePin.sha256});return current;});
  try{this.verify(stored);new SessionFiles({workspace:this.store.get('task',`${r.groupId}:${r.taskId}`).workspace,scope:this.store.get('task',`${r.groupId}:${r.taskId}`).scope}).write({area:'work',relativePath:`media-${args.actionId}.json`,text:JSON.stringify(this.safe(stored))});}catch(error){return{...this.safe(stored),sharedReceiptSaved:false,sharedReceiptCode:safeCode(error)};}
  return{...this.safe(stored),sharedReceiptSaved:true};
 }
 submit(identity,args){return this.store.perform(identity,'submit_qwen_media',args,()=>{
  const r=this.record(identity,args);requireThat(r.output&&!r.submission&&(r.kind==='speech'?r.post?.status==='succeeded':r.provider?.status==='SUCCEEDED'&&r.recovery?.status==='succeeded'),'CORE_MEDIA_OUTPUT_REQUIRED');
  r.submission={status:'reserved_unknown',at:now()};this.store.put('core_qwen_reservation',r.reservationId,r);
  return{...this.safe(r),afterCommit:async()=>{try{return this.store.tx(()=>{
  const current=this.record(identity,args),task=this.task(identity,args),media=inspectCoreMediaOutput(this.store,task,current.output.relativePath,current.kind);requireThat(media.sha256===current.output.sha256&&media.byteLength===current.output.byteLength,'CORE_MEDIA_OUTPUT_CHANGED');
  const artifact={artifactId:randomUUID(),kind:'core_qwen_media',groupId:r.groupId,taskId:r.taskId,title:args.title,text:null,authorId:identity.instanceId,readerIds:[...task.fileAcl.readers],aclMode:'task_readers',sourceIds:task.sourceIds,workspaceBinding:task.workspace.markerSha256,...media,reservationId:r.reservationId,grantSha256:r.grantSha256,inputVersion:r.input.inputVersion,inputSha256:r.input.sha256,native:safeNative(r.provider??r.post),createdAt:now(),reviews:{},evidence:r.synthetic?'broker_synthetic_api_file':'broker_native_api_file',platformOriginVerified:!r.synthetic,modelExecutionVerified:false,businessCompletedVerified:false,sharedConsensusVerified:false};this.store.put('artifact',artifact.artifactId,artifact);this.store.markRead(identity,'artifact',artifact.artifactId,r.groupId);current.submission={status:'registered',artifactId:artifact.artifactId,sha256:artifact.sha256};this.store.put('core_qwen_reservation',r.reservationId,current);this.store.event(identity,'core_qwen_media_submitted',r.groupId,{taskId:r.taskId,reservationId:r.reservationId,artifactId:artifact.artifactId,authorId:identity.instanceId});return{artifact,reservation:this.safe(current)};
  });}catch(error){this.store.tx(()=>{const current=this.store.get('core_qwen_reservation',r.reservationId);current.submission={status:'blocked',code:safeCode(error),at:now()};this.store.put('core_qwen_reservation',r.reservationId,current);this.store.event(identity,'core_qwen_media_submission_blocked',r.groupId,{taskId:r.taskId,reservationId:r.reservationId,code:safeCode(error)});});throw error;}}};
 });}
 async invoke(identity,name,args){
  try{
  if(name==='reserve_qwen_media')return await this.reserve(identity,args);
  const r=this.record(identity,args);if(name==='get_qwen_media')return this.safe(r);if(name==='submit_qwen_media')return await this.submit(identity,args);
  // DNS或配置明确阻塞时不占实际调用次数。校验后仍由同步事务竞争唯一意图。
  if(args.action==='execute'&&!r.post||args.action==='status'||args.action==='recover'&&!r.recovery){
   this.grant(r);let route={proxy:this.config.network?.proxy??null};if(args.action==='recover'){requireThat(r.sourceContract,'CORE_MEDIA_RECOVERY_BLOCKED');const m=this.materialize(r),source=json(path.join(m.binding.privateWork,r.sourceContract.relativePath));requireThat(this.config.allowedMediaHosts.includes(source.hostname),'CORE_MEDIA_SOURCE_HOST');route={hostname:source.hostname,proxy:this.config.recovery?.proxy??null,download:true};}await this.networkPreflight(route);
  }
  return await this.store.perform(identity,name,args,()=>{const current=this.record(identity,args),g=this.grant(current);this.claim(identity,args,current,g);return{...this.safe(current),afterCommit:()=>this.complete(identity,args,current,g)};});
  }catch(error){fail(safeCode(error),'核心媒体操作停止，原记录保留；请由可信宿主按错误码核查，不换编号重试。');}
 }
}
