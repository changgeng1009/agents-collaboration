import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import {createHash} from 'node:crypto';
import {makeTaskBinding,readOrdinary,ordinaryPath,readCredential} from './qwen-media-adapter.mjs';
import {isPublicIPv4} from './content-download.mjs';
import {containsCredentialMaterial} from './qwen-error-diagnostics.mjs';

export const WORKBUDDY_LOCAL_ORIGIN='https://www.workbuddy.cn';
const BASE='/openapi/v2/localassistant',READ='user.localassistant.readable',INVOKE='user.localassistant.invokable';
const hash=b=>createHash('sha256').update(b).digest('hex'),stop=code=>Object.assign(new Error('本地助理候选停止；无自动重试或产品模式回退。'),{code});
const check=(ok,code)=>{if(!ok)throw stop(code);},id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v);
const safeId=(v,token)=>id(v)&&!containsCredentialMaterial(v,token)?v:null;
const json=f=>JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readOrdinary(f,65536)));
function save(file,value){ordinaryPath(path.dirname(file));ordinaryPath(file,false);const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
export function makeWorkBuddyLocalBinding(projectRoot,taskId){return{...makeTaskBinding(projectRoot,taskId),schema:'workbuddy_localassistant_task_binding_v1'};}
export function workBuddyLocalFailureCode(failure){return typeof failure?.code==='string'&&/^WB_LOCAL_[A-Z_]{1,70}$/.test(failure.code)?failure.code:'WB_LOCAL_OPERATION_UNKNOWN';}
export function workBuddyLocalApprovalContextSha256(config,request){return hash(canonical({schema:'workbuddy_localassistant_approval_context_v1',bindingSha256:config.bindingSha256,mode:config.mode,origin:config.origin,authorityId:config.authorization?.authorityId??null,grantedScopes:Array.isArray(config.authorization?.scopes)?[...config.authorization.scopes].sort():[],allowOwnerWideHistory:config.authorization?.allowOwnerWideHistory===true,maxRequestsTotal:config.maxRequestsTotal??0,request}));}

export function validateWorkBuddyLocalRequest(request) {
 let url;try{url=new URL(request.url);}catch{throw stop('WB_LOCAL_ENDPOINT_FORBIDDEN');}
 check(url.origin===WORKBUDDY_LOCAL_ORIGIN&&!url.username&&!url.password&&!url.hash&&!url.port,'WB_LOCAL_ENDPOINT_FORBIDDEN');
 const status=request.method==='GET'&&url.pathname===BASE&&!url.search&&!request.body;
 const history=request.method==='GET'&&url.pathname===BASE+'/message'&&[...url.searchParams.keys()].join(',')==='message_id'&&id(url.searchParams.get('message_id'))&&!request.body;
 const post=request.method==='POST'&&url.pathname===BASE+'/message'&&!url.search&&exact(request.body,['content','msg_type'])&&request.body.msg_type==='text'&&typeof request.body.content==='string'&&request.body.content.isWellFormed()&&Buffer.byteLength(request.body.content)>0&&Buffer.byteLength(request.body.content)<=32768;
 check(status||history||post,'WB_LOCAL_ENDPOINT_FORBIDDEN');return url;
}
// 原生传输保持固定官方源和公开IPv4；无系统代理、重定向、token刷新或隐式查询。
export async function nativeWorkBuddyLocalTransport(request) {
 const url=validateWorkBuddyLocalRequest(request);let timer,rows;
 try{rows=await Promise.race([dns.lookup(url.hostname,{all:true,family:4,verbatim:true}),new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(stop('WB_LOCAL_DNS_UNKNOWN')),10000);})]);}catch{throw stop('WB_LOCAL_DNS_UNKNOWN');}finally{clearTimeout(timer);}
 check(rows.length>0&&rows.every(r=>isPublicIPv4(r.address)),'WB_LOCAL_DNS_FORBIDDEN');
 const bytes=request.body?Buffer.from(JSON.stringify(request.body)):null;
 return new Promise((resolve,reject)=>{
  let done=false,deadline,responseRef;const finish=(failure,result)=>{if(done)return;done=true;clearTimeout(deadline);failure?reject(stop(failure)):resolve(result);};
  const req=https.request(url,{method:request.method,agent:false,servername:url.hostname,rejectUnauthorized:true,lookup:(host,options,callback)=>callback(null,options?.all?[{address:rows[0].address,family:4}]:rows[0].address,options?.all?undefined:4),headers:{authorization:`Bearer ${request.token}`,accept:'application/json',connection:'close',...(bytes?{'content-type':'application/json','content-length':bytes.length}:{})}},response=>{
   responseRef=response;if(response.statusCode>=300&&response.statusCode<400){response.destroy();finish('WB_LOCAL_REDIRECT_FORBIDDEN');return;}
   if(response.headers['content-encoding']&&response.headers['content-encoding']!=='identity'){response.destroy();finish('WB_LOCAL_RESPONSE_UNKNOWN');return;}
   let count=0;const chunks=[];response.on('data',chunk=>{if(done)return;count+=chunk.length;if(count>1048576){response.destroy();finish('WB_LOCAL_RESPONSE_TOO_LARGE');}else chunks.push(chunk);});
   response.once('aborted',()=>finish('WB_LOCAL_RESPONSE_UNKNOWN'));response.once('error',()=>finish('WB_LOCAL_RESPONSE_UNKNOWN'));
   response.once('end',()=>{try{finish(null,{httpStatus:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{finish('WB_LOCAL_RESPONSE_UNKNOWN');}});
  });deadline=setTimeout(()=>{responseRef?.destroy();req.destroy();finish('WB_LOCAL_NETWORK_UNKNOWN');},15000);req.once('error',()=>finish('WB_LOCAL_NETWORK_UNKNOWN'));req.end(bytes);
 });
}

// 候选独立入口：不注册到旧core、不切换CLI/云模式、不授予cwd/专家/会话权限。
export class WorkBuddyLocalAssistantCandidate {
 #config;#binding;#base;#transport;
 constructor(config,{transport=nativeWorkBuddyLocalTransport}={}) {
  check(config.schema==='workbuddy_localassistant_host_v1'&&config.mode==='localassistant'&&config.origin===WORKBUDDY_LOCAL_ORIGIN,'WB_LOCAL_CONFIG_INVALID');
  const scopes=config.authorization?.scopes;check(scopes===undefined||Array.isArray(scopes)&&scopes.length<=32&&new Set(scopes).size===scopes.length&&scopes.every(s=>typeof s==='string'&&/^[a-z][a-z0-9_.]{0,95}$/.test(s)),'WB_LOCAL_AUTHORIZATION_INVALID');
  this.#config=structuredClone(config);this.#transport=transport;this.#binding=json(config.bindingFile);this.verify();this.#base=path.join(this.#binding.taskRoot,'work','workbuddy-localassistant');
 }
 verify(){const c=this.#config,b=this.#binding;check(hash(readOrdinary(c.bindingFile,65536))===c.bindingSha256&&JSON.stringify(makeWorkBuddyLocalBinding(b.projectRoot,b.taskId))===JSON.stringify(b),'WB_LOCAL_BINDING_CHANGED');let reserved=false;try{fs.lstatSync(path.join(b.taskRoot,'.os-worker'));reserved=true;}catch(f){if(f.code!=='ENOENT')throw f;}check(!reserved,'WB_LOCAL_OS_BACKEND_REQUIRED');}
 #read(operationId){check(id(operationId),'WB_LOCAL_OPERATION_INVALID');return json(path.join(this.#base,`operation-${operationId}`,'result.json'));}
 #reserve(name,value){this.verify();ordinaryPath(this.#base,false);fs.mkdirSync(this.#base,{recursive:true});const dir=path.join(this.#base,name);ordinaryPath(dir,false);try{fs.mkdirSync(dir);}catch(f){if(f.code==='EEXIST')return null;throw stop('WB_LOCAL_RESERVATION_UNKNOWN');}save(path.join(dir,'intent.json'),value);return dir;}
 #plan(request){
  this.verify();check(exact(request,['operationId','operation','arguments'])&&id(request.operationId),'WB_LOCAL_REQUEST_INVALID');
  const a=request.arguments,operation=request.operation;let body=null,url=WORKBUDDY_LOCAL_ORIGIN+BASE,method='GET',scope=READ;
  if(operation==='get_assistant_status')check(exact(a,[]),'WB_LOCAL_REQUEST_INVALID');
  else if(operation==='post_assistant_message'){
   check(exact(a,['content','msg_type','statusOperationId'])&&a.msg_type==='text'&&id(a.statusOperationId),'WB_LOCAL_PERMISSION_OR_SESSION_FORBIDDEN');body={content:a.content,msg_type:'text'};url+='/message';method='POST';scope=INVOKE;
  }else if(operation==='read_assistant_messages'){
   check(exact(a,['afterOperationId'])&&id(a.afterOperationId),'WB_LOCAL_REQUEST_INVALID');check(this.#config.authorization?.allowOwnerWideHistory===true,'WB_LOCAL_HISTORY_SCOPE_REQUIRED');
   const old=this.#read(a.afterOperationId);check(old.status==='message_accepted'&&id(old.message_id)&&old.authorityId===this.#config.authorization?.authorityId&&old.bindingSha256===this.#config.bindingSha256,'WB_LOCAL_OWN_MESSAGE_REQUIRED');url+='/message?message_id='+encodeURIComponent(old.message_id);
  }else throw stop('WB_LOCAL_NATIVE_SESSION_UNAVAILABLE');
  validateWorkBuddyLocalRequest({method,url,body});return{method,url,body,scope,operation,requestSha256:hash(JSON.stringify(request)),approvalContextSha256:workBuddyLocalApprovalContextSha256(this.#config,request)};
 }
 preflight(request){const plan=this.#plan(request),auth=this.#config.authorization,missing=[];if(this.#config.enabled!==true)missing.push('provider_disabled');if(auth?.approvedApplication!==true)missing.push('approved_application');if(auth?.ownerOAuth!==true||!id(auth?.authorityId)||!(Date.parse(auth?.expiresAt)>Date.now()))missing.push('owner_oauth');if(!Array.isArray(auth?.scopes)||!auth.scopes.includes(plan.scope))missing.push(plan.scope);return{operation:plan.operation,requestSha256:plan.requestSha256,approvalContextSha256:plan.approvalContextSha256,requiredScope:plan.scope,missingPrerequisites:missing,readyForReviewedRequest:missing.length===0,authorizationEvidence:'trusted_host_configuration_only',runtimeAuthenticationVerified:false,networkReadinessVerified:false,networkMode:'direct_public_ipv4',requiresExactRequestApproval:true,providerRegisteredToCore:false,dnsTimeoutMs:10000,httpTimeoutMs:15000,maxResponseBytes:1048576,maxRedirects:0,automaticRetry:false,networkRequests:0,credentialReads:0,nativeConversationSelectionSupported:false,cwdSelectionSupported:false,expertSelectionSupported:false,permissionResponseSupported:false,modelStartedVerified:false,businessCompletedVerified:false};}
 async execute(request){
  const preflight=this.preflight(request);check(!preflight.missingPrerequisites.length,'WB_LOCAL_OAUTH_SCOPE_REQUIRED');
  const plan=this.#plan(request),config=this.#config,approval=config.approvals?.[request.operationId];
  check(approval?.requestSha256===plan.requestSha256&&approval.contextSha256===plan.approvalContextSha256&&approval.maxRequests===1&&Date.parse(approval.expiresAt)>Date.now()&&(plan.method!=='POST'||approval.permission==='post_localassistant_text_once'&&approval.modelExecutionMayBeTriggered===true),'WB_LOCAL_REVIEW_REQUIRED');
  check(Number.isInteger(config.maxRequestsTotal)&&config.maxRequestsTotal>=1&&config.maxRequestsTotal<=100,'WB_LOCAL_BUDGET_EXCEEDED');
  if(plan.method==='POST'){const status=this.#read(request.arguments.statusOperationId);check(status.status==='status_read'&&status.online===true&&status.authorityId===config.authorization.authorityId&&status.bindingSha256===config.bindingSha256&&Date.parse(status.observedAt)<=Date.now()&&Date.now()-Date.parse(status.observedAt)<=300000,'WB_LOCAL_ONLINE_STATUS_REQUIRED');}
  const token=readCredential(config.authorization.accessTokenFile);check(!containsCredentialMaterial(request.operationId,token)&&!containsCredentialMaterial(config.authorization.authorityId,token)&&!containsCredentialMaterial(plan.body?.content,token),'WB_LOCAL_CREDENTIAL_IN_REQUEST');
  const dir=this.#reserve(`operation-${request.operationId}`,{operation:request.operation,requestSha256:plan.requestSha256,automaticRetry:false});
  if(!dir)return{operationId:request.operationId,status:'reserved_or_finished',deduplicated:true,automaticRetry:false};
  if(plan.method==='POST'){
   const key=hash(canonical({bindingSha256:config.bindingSha256,authorityId:config.authorization.authorityId,body:plan.body}));
   if(!this.#reserve(`message-payload-${key}`,{operationId:request.operationId,automaticRetry:false})){const duplicate={operationId:request.operationId,status:'reserved_or_finished',deduplicated:true,automaticRetry:false};save(path.join(dir,'result.json'),duplicate);return duplicate;}
  }
  let budget=null;for(let n=1;n<=config.maxRequestsTotal;n++){budget=this.#reserve(`budget-${n}`,{operationId:request.operationId});if(budget)break;}check(budget,'WB_LOCAL_BUDGET_EXCEEDED');
  let result={operationId:request.operationId,operation:request.operation,authorityId:config.authorization.authorityId,bindingSha256:config.bindingSha256,approvalContextSha256:plan.approvalContextSha256,status:'unknown',observedAt:new Date().toISOString(),httpStatus:null,platformCode:null,request_id:null,message_id:null,nativeConversationId:null,preciseConversationVerified:false,modelStartedVerified:false,modelCompletedVerified:false,passiveWakeVerified:false,businessCompletedVerified:false,automaticRetry:false};
  try{
   const response=await this.#transport({...plan,token});this.verify();result.httpStatus=Number.isInteger(response?.httpStatus)&&response.httpStatus>=100&&response.httpStatus<=599?response.httpStatus:null;const platformCode=response?.body?.code;result.platformCode=Number.isInteger(platformCode)&&platformCode>=-2147483648&&platformCode<=2147483647?platformCode:null;result.request_id=safeId(response?.body?.request_id,token);check(result.httpStatus===200&&result.platformCode===0,'WB_LOCAL_RESPONSE_UNKNOWN');
   const data=response.body.data;check(data&&typeof data==='object'&&!Array.isArray(data),'WB_LOCAL_RESPONSE_UNKNOWN');
   if(request.operation==='get_assistant_status'){check(typeof data.online==='boolean','WB_LOCAL_RESPONSE_UNKNOWN');result={...result,status:'status_read',online:data.online};}
   else if(request.operation==='post_assistant_message'){const message_id=safeId(data.message_id,token);check(message_id,'WB_LOCAL_RESPONSE_UNKNOWN');result={...result,status:'message_accepted',message_id,messageReceiptVerified:true};}
   else {
    check(Array.isArray(data.messages)&&data.messages.length<=100,'WB_LOCAL_RESPONSE_TOO_LARGE');
    const messages=data.messages.map(row=>({message_id:safeId(row?.message_id,token),role:['user','assistant'].includes(row?.role)?row.role:null,msg_type:typeof row?.msg_type==='string'&&/^[a-z_]{1,40}$/.test(row.msg_type)&&!containsCredentialMaterial(row.msg_type,token)?row.msg_type:null,contentAvailable:Array.isArray(row?.content)&&row.content.length>0}));
    result={...result,status:'history_read',messages,historyConversationCorrelationVerified:false,contentPersisted:false,permissionResponsesSent:0};
   }
  }catch(failure){result.code=workBuddyLocalFailureCode(failure);}
  save(path.join(dir,'result.json'),result);return result;
 }
}
