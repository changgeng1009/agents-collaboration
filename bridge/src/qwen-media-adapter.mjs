import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import {createHash} from 'node:crypto';
import {downloadPinnedSource,validateSourceUrl,isPublicIPv4} from './content-download.mjs';
import {validateDownloadProxy} from './content-download-proxy.mjs';
import {createLoopbackAgent,validateLoopbackProxy,LOOPBACK_PROXY_ERROR_CODES} from './qwen-loopback-connect.mjs';
import {collectFailureDiagnostic,containsCredentialMaterial} from './qwen-error-diagnostics.mjs';

export const QWEN_ORIGIN = 'https://maas.qianwenaiapi.com';
export const QWEN_MODELS = Object.freeze({video:'MiniMax/MiniMax-H3', speech:'MiniMax/speech-2.8-hd'});
const POST_PATHS = Object.freeze({video:'/api/v1/services/aigc/video-generation/video-synthesis', speech:'/api/v1/services/aigc/multimodal-generation/generation'});
const LIST_PATH = '/api/v1/tasks/?model_name=MiniMax%2FMiniMax-H3&page_no=1&page_size=1';
const LIMIT = 64 * 1024 * 1024;
const error = code => Object.assign(new Error('千问媒体操作停止；请按脱敏错误码核对本地证据。'), {code});
const requireThat = (condition, code) => {if (!condition) throw error(code);};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value && typeof value==='object' ? Array.isArray(value) ? value.map(item=>JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key=>[key,JSON.parse(canonical(value[key]))])) : value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const exact = (obj, required, optional=[]) => obj && typeof obj === 'object' && !Array.isArray(obj) && required.every(k=>Object.hasOwn(obj,k)) && Object.keys(obj).every(k=>[...required,...optional].includes(k));
const safeId = (value, secret='') => id(value) && !/^sk-/i.test(value) && !containsCredentialMaterial(value,secret) ? value : null;
const reportedModel = (value,secret) => typeof value==='string' && value.length<=128 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) && !value.includes('//') && !/^sk-/i.test(value) && !containsCredentialMaterial(value,secret) ? value : null;
const providerCode = (value,secret='') => !containsCredentialMaterial(value,secret) && (Number.isSafeInteger(value) || typeof value === 'string' && /^(?:InvalidApiKey|InvalidParameter|InvalidParameter\.[A-Za-z]+|AccessDenied|Unauthorized|Forbidden|ModelNotFound|Throttling(?:\.[A-Za-z]+)?|DataInspectionFailed|InternalError|InvalidTask|NotFound)$/.test(value)) ? value : null;
const inside = (root,file) => file===root || !path.relative(root,file).startsWith('..') && !path.isAbsolute(path.relative(root,file));
const sourceExpiry = url => {
 const value=url.searchParams.get('Expires');if(value===null)return null;
 requireThat(/^\d{1,12}$/.test(value) && Number.isFinite(Number(value)*1000),'QWEN_SOURCE_EXPIRY_INVALID');
 return new Date(Number(value)*1000).toISOString();
};

// 原生宿主边界：逐级拒绝联接/符号链接，固定目录身份，普通文件只接受一个硬链接。
// 此边界不宣称提供独立Windows账户或OS隔离。
export function ordinaryPath(value, mustExist=true) {
 requireThat(typeof value==='string' && path.isAbsolute(value), 'QWEN_PATH_INVALID');
 const resolved=path.resolve(value); let cursor=path.parse(resolved).root;
 for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
  requireThat(!/[\x00-\x1f:]/.test(part) && !/[. ]$/.test(part) && !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part), 'QWEN_PATH_INVALID');
  cursor=path.join(cursor,part);
  try {requireThat(!fs.lstatSync(cursor).isSymbolicLink(),'QWEN_LINK_FORBIDDEN');}
  catch (failure) {if(failure.code!=='ENOENT' || mustExist) throw failure;}
 }
 return resolved;
}
function directoryIdentity(file) {
 ordinaryPath(file); const stat=fs.statSync(file,{bigint:true});
 requireThat(stat.isDirectory(),'QWEN_DIRECTORY_INVALID');
 return {path:path.resolve(file),realPath:fs.realpathSync(file),dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};
}
export function readOrdinary(file, maxBytes=1048576) {
 ordinaryPath(file); const before=fs.lstatSync(file,{bigint:true});
 requireThat(before.isFile() && before.nlink===1n && before.size<=BigInt(maxBytes),'QWEN_FILE_INVALID');
 const fd=fs.openSync(file,'r');
 try {
  const opened=fs.fstatSync(fd,{bigint:true});
  const same = other => other.isFile() && other.nlink===1n && ['dev','ino','size','birthtimeNs','mtimeNs'].every(k=>opened[k]===other[k]);
  requireThat(same(before),'QWEN_FILE_CHANGED');
  const bytes=Buffer.alloc(Number(opened.size)); let offset=0;
  while(offset<bytes.length) {const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset); requireThat(count>0,'QWEN_FILE_CHANGED'); offset+=count;}
  ordinaryPath(file); requireThat(same(fs.lstatSync(file,{bigint:true})) && same(fs.fstatSync(fd,{bigint:true})),'QWEN_FILE_CHANGED');
  return bytes;
 } finally {fs.closeSync(fd);}
}
function jsonFile(file,limit) {try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readOrdinary(file,limit)));}catch(failure){throw error(failure.code?.startsWith('QWEN_')?failure.code:'QWEN_JSON_INVALID');}}
function createFile(file, bytes) {
 ordinaryPath(path.dirname(file)); ordinaryPath(file,false); const fd=fs.openSync(file,'wx',0o600);
 try {fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 return {sha256:digest(bytes),byteLength:bytes.length};
}
function writeJson(file,value) {return createFile(file,Buffer.from(JSON.stringify(value,null,2)+'\n'));}
export function makeTaskBinding(projectRoot,taskId) {
 requireThat(id(taskId),'QWEN_TASK_INVALID');
 const taskRoot=ordinaryPath(path.join(projectRoot,'task-workspaces',taskId));
 const directories=Object.fromEntries(['inputs','work','outputs'].map(area=>[area,directoryIdentity(path.join(taskRoot,area))]));
 return {schema:'qwen_media_task_binding_v1',projectRoot:ordinaryPath(projectRoot),taskId,taskRoot,directories};
}
export function readCredential(file) {
 // API Key作为opaque token处理，不要求示例中的sk-前缀，不计算密钥摘要。
 let token;
 try {token=new TextDecoder('utf-8',{fatal:true}).decode(readOrdinary(file,8192));}
 catch {throw error('QWEN_CREDENTIAL_UNREADABLE');}
 token=token.replace(/(?:\r?\n)$/,'');
 requireThat(token.length>=16 && token.length<=4096 && /^[A-Za-z0-9._~+/-]+={0,2}$/.test(token) && !/^https?:/i.test(token),'QWEN_CREDENTIAL_FORMAT_INVALID');
 return token;
}
export function validateApiRequest({method,url,body}) {
 let parsed;try{parsed=new URL(url);}catch{throw error('QWEN_ENDPOINT_FORBIDDEN');}
 requireThat(parsed.origin===QWEN_ORIGIN && !parsed.username && !parsed.password && !parsed.hash && parsed.port==='', 'QWEN_ENDPOINT_FORBIDDEN');
 const list=parsed.pathname+parsed.search===LIST_PATH;
 const query=/^\/api\/v1\/tasks\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parsed.pathname) && !parsed.search;
 requireThat(method==='POST' && Object.values(POST_PATHS).includes(parsed.pathname) && !parsed.search && body || method==='GET' && !body && (list || query),'QWEN_ENDPOINT_FORBIDDEN');
 return parsed;
}
export async function nativeQwenTransport(request) {
 const url=validateApiRequest(request),deadline=Date.now()+request.timeoutMs;
 let rows,dnsTimer,proxyAgent=null;
 if(request.proxy)proxyAgent=createLoopbackAgent(request.proxy,{timeoutMs:request.timeoutMs});
 else {
  try {rows=await Promise.race([dns.lookup(url.hostname,{all:true,family:4,verbatim:true}),new Promise((resolve,reject)=>{dnsTimer=setTimeout(()=>reject(error('QWEN_DNS_TIMEOUT')),Math.min(10000,request.timeoutMs));})]);}catch(failure){throw error(failure.code==='QWEN_DNS_TIMEOUT'?'QWEN_DNS_TIMEOUT':'QWEN_NETWORK_UNKNOWN');}finally{clearTimeout(dnsTimer);}
  requireThat(rows.length>0 && rows.every(row=>isPublicIPv4(row.address)),'QWEN_DNS_FORBIDDEN');
 }
 const bytes=request.body?Buffer.from(JSON.stringify(request.body)):null;
 return new Promise((resolve,reject)=>{
  let finished=false;const finish=(failure,value)=>{if(finished)return;finished=true;clearTimeout(timer);proxyAgent?.destroy();failure?reject(error(failure)):resolve(value);};
  const call=https.request(url,{method:request.method,agent:proxyAgent??false,servername:url.hostname,rejectUnauthorized:true,
   ...(!proxyAgent?{lookup:(host,options,callback)=>callback(null,options?.all?[{address:rows[0].address,family:4}]:rows[0].address,options?.all?undefined:4)}:{}),
   headers:{authorization:`Bearer ${request.token}`,accept:'application/json',connection:'close',...(bytes?{'content-type':'application/json','content-length':bytes.length}:{}),...(request.async?{'X-DashScope-Async':'enable'}:{})}},response=>{
    if(response.statusCode>=300 && response.statusCode<400) {response.destroy();finish('QWEN_REDIRECT_FORBIDDEN');return;}
    if(response.headers['content-encoding'] && response.headers['content-encoding']!=='identity') {response.destroy();finish('QWEN_RESPONSE_ENCODING_UNKNOWN');return;}
    let count=0;const chunks=[];
    response.on('data',chunk=>{count+=chunk.length;if(count>request.maxBodyBytes){response.destroy();finish('QWEN_RESPONSE_TOO_LARGE');}else chunks.push(chunk);});
    response.once('aborted',()=>finish('QWEN_RESPONSE_PARTIAL_UNKNOWN'));response.once('error',()=>finish('QWEN_NETWORK_UNKNOWN'));
    response.once('end',()=>{try {finish(null,{httpStatus:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});}catch{finish('QWEN_RESPONSE_JSON_UNKNOWN');}});
   });
  const timer=setTimeout(()=>{call.destroy();finish('QWEN_NETWORK_UNKNOWN');},Math.max(1,deadline-Date.now()));
  call.once('error',failure=>finish(LOOPBACK_PROXY_ERROR_CODES.includes(failure.code)?failure.code:'QWEN_NETWORK_UNKNOWN'));call.end(bytes);
 });
}

export class QwenMediaAdapter {
 #config; #transport; #binding; #base;
 constructor(config,{transport=nativeQwenTransport}={}) {
  this.#config=structuredClone(config);this.#transport=transport;
  requireThat(config.schema==='qwen_media_host_v1' && config.origin===QWEN_ORIGIN && config.models?.video===QWEN_MODELS.video && config.models?.speech===QWEN_MODELS.speech,'QWEN_CONFIG_INVALID');
  if(config.network?.proxy)validateLoopbackProxy(config.network.proxy);
  this.#binding=jsonFile(config.bindingFile,32768);
  requireThat(digest(readOrdinary(config.bindingFile,32768))===config.bindingSha256,'QWEN_BINDING_CHANGED');
  this.verify();this.#base=path.join(this.#binding.taskRoot,'work','qwen-media');
  ordinaryPath(this.#base,false);fs.mkdirSync(this.#base,{recursive:true});this.verify();
 }
 verify() {
  const b=this.#binding;
  requireThat(b.schema==='qwen_media_task_binding_v1' && id(b.taskId) && b.taskRoot===path.join(b.projectRoot,'task-workspaces',b.taskId),'QWEN_BINDING_INVALID');
  ordinaryPath(b.projectRoot);ordinaryPath(b.taskRoot);
  let osWorkerReserved=false;try{fs.lstatSync(path.join(b.taskRoot,'.os-worker'));osWorkerReserved=true;}catch(failure){if(failure.code!=='ENOENT')throw failure;}
  requireThat(!osWorkerReserved,'QWEN_OS_BACKEND_REQUIRED');
  requireThat(digest(readOrdinary(this.#config.bindingFile,32768))===this.#config.bindingSha256,'QWEN_BINDING_CHANGED');
  for(const area of ['inputs','work','outputs']) requireThat(JSON.stringify(directoryIdentity(path.join(b.taskRoot,area)))===JSON.stringify(b.directories[area]),'QWEN_BINDING_CHANGED');
 }
 #target(area,name) {
  this.verify();requireThat(['inputs','work','outputs'].includes(area) && typeof name==='string' && !path.isAbsolute(name) && !name.split(/[\\/]/).some(part=>!part || part==='.' || part==='..'),'QWEN_PATH_INVALID');
  const root=path.join(this.#binding.taskRoot,area),file=path.resolve(root,name);
  requireThat(inside(root,file) && file!==root,'QWEN_PATH_INVALID');return ordinaryPath(file,false);
 }
 #save(file,value) {this.verify();requireThat(inside(this.#base,file),'QWEN_PATH_INVALID');return writeJson(file,value);}
 #archiveFailure(directory,response,token,kind,phase,result) {
  const diagnostic=collectFailureDiagnostic(response,{token,kind,phase,context:{request_id:result.request_id,task_id:result.task_id,trace_id:result.trace_id,requestedModel:result.requestedModel}});
  if(!diagnostic)return null;
  const available=Object.fromEntries(Object.entries(diagnostic.fields).map(([source,field])=>[source,['available','truncated'].includes(field.state)]));
  try {
   const file=path.join(directory,'error-diagnostic.json'),pin=this.#save(file,diagnostic);
   return {relativePath:path.relative(this.#binding.taskRoot,file).split(path.sep).join('/'),sha256:pin.sha256,fieldsAvailable:available};
  }catch{return {relativePath:null,sha256:null,fieldsAvailable:available,code:'QWEN_ERROR_DIAGNOSTIC_UNAVAILABLE'};}
 }
 #reserve(name,value) {
  this.verify();const dir=path.join(this.#base,name);ordinaryPath(dir,false);
  try{fs.mkdirSync(dir);}catch(failure){if(failure.code==='EEXIST')return null;throw error('QWEN_RESERVE_UNKNOWN');}
  writeJson(path.join(dir,'intent.json'),value);return dir;
 }
 #token(kind) {requireThat(['video','speech'].includes(kind),'QWEN_KIND_INVALID');return readCredential(this.#config.credentials?.[kind]?.credentialFile);}
 #request(kind,input) {
  requireThat(['video','speech'].includes(kind),'QWEN_KIND_INVALID');
  requireThat(exact(input,['operationId','kind','input','parameters']) && id(input.operationId) && input.kind===kind,'QWEN_REQUEST_INVALID');
  if(kind==='video') {
   requireThat(exact(input.input,['prompt'],['media']) && typeof input.input.prompt==='string' && [...input.input.prompt].length>0 && [...input.input.prompt].length<=7000,'QWEN_REQUEST_INVALID');
   const p=input.parameters;
   requireThat(exact(p,['duration','resolution','ratio','watermark']) && Number.isInteger(p.duration) && p.duration>=4 && p.duration<=15 && ['768P','2K'].includes(p.resolution) && ['adaptive','16:9','9:16','1:1','4:3','3:4','21:9'].includes(p.ratio) && typeof p.watermark==='boolean','QWEN_REQUEST_INVALID');
   if(input.input.media!==undefined) {
    requireThat(Array.isArray(input.input.media) && input.input.media.length<=16,'QWEN_REQUEST_INVALID');
    for(const media of input.input.media) {
     requireThat(exact(media,['type','url']) && ['first_frame','last_frame','image_url','feature','driving_audio'].includes(media.type),'QWEN_REQUEST_INVALID');
     let url;try{url=new URL(media.url);}catch{throw error('QWEN_MEDIA_HOST_FORBIDDEN');}
     requireThat(url.protocol==='https:' && !url.username && !url.password && !url.hash && !url.port && this.#config.inputMediaHosts?.includes(url.hostname),'QWEN_MEDIA_HOST_FORBIDDEN');
    }
   }
  } else {
   const i=input.input,p=input.parameters,v=i?.voice_setting,a=i?.audio_setting;
   requireThat(exact(i,['text','voice_setting','audio_setting']) && typeof i.text==='string' && [...i.text].length>0 && [...i.text].length<=10000 && exact(p,['output_format']) && p.output_format==='hex','QWEN_REQUEST_INVALID');
   requireThat(exact(v,['voice_id','speed','vol','pitch'],['emotion']) && this.#config.stockVoiceIds?.includes(v.voice_id) && typeof v.speed==='number' && v.speed>=0.5 && v.speed<=2 && typeof v.vol==='number' && v.vol>0 && v.vol<=10 && Number.isInteger(v.pitch) && v.pitch>=-12 && v.pitch<=12 && (v.emotion===undefined || ['happy','sad','angry','fearful','disgusted','surprised','calm','fluent','whisper'].includes(v.emotion)),'QWEN_VOICE_INVALID');
   requireThat(exact(a,['sample_rate','bitrate','format','channel']) && [16000,22050,24000,32000,44100].includes(a.sample_rate) && [32000,64000,128000,256000].includes(a.bitrate) && a.format==='mp3' && [1,2].includes(a.channel),'QWEN_AUDIO_INVALID');
  }
  // MiniMax的output_format属于input，外层parameters只用于本地可审查请求结构。
  return {model:QWEN_MODELS[kind],input:{...input.input,...(kind==='speech'?input.parameters:{})},...(kind==='video'?{parameters:input.parameters}:{})};
 }
 readRequest(relativePath) {return jsonFile(this.#target('inputs',relativePath),1048576);}
 preflight(request=null) {
  this.verify();const credentials={};for(const kind of ['video','speech']) {try{this.#token(kind);credentials[kind]={readable:true,formatValid:true,authenticationVerified:false};}catch(failure){credentials[kind]={readable:false,formatValid:false,code:safeFailureCode(failure)};}}
  let plan=null;if(request){const body=this.#request(request.kind,request);plan={operationId:request.operationId,kind:request.kind,model:body.model,requestSha256:digest(JSON.stringify(request)),endpoint:QWEN_ORIGIN+POST_PATHS[request.kind],units:request.kind==='video'?request.parameters.duration:[...request.input.text].length};}
  return {schema:'qwen_media_preflight_v1',taskId:this.#binding.taskId,credentials,plan,networkRequests:0,networkMode:this.#config.network?.proxy?'loopback-connect':'direct',generationEnabled:false,osIsolationVerified:false,modelExecutionVerified:false,businessCompletedVerified:false};
 }
 readonlyPlan() {return {schema:'qwen_readonly_auth_v1',method:'GET',url:QWEN_ORIGIN+LIST_PATH,timeoutMs:15000,maxBodyBytes:1048576,maxRedirects:0,automaticRetry:false,maxRequestsPerCredential:1,maxRequestsTotal:2,requestBody:null,defaultTimeRangeHours:24,persistedFields:['credentialSlot','httpStatus','request_id','code','returnedCount','classification','authenticationAccepted','modelAccessVerified'],generationRequests:0};}
 async #call(request) {
  validateApiRequest(request);this.verify();const response=await this.#transport({...request,proxy:this.#config.network?.proxy??null});this.verify();
  requireThat(response && Number.isInteger(response.httpStatus) && response.body && typeof response.body==='object','QWEN_RESPONSE_UNKNOWN');
  requireThat(response.httpStatus<300 || response.httpStatus>=400,'QWEN_REDIRECT_FORBIDDEN');return response;
 }
 async readonlyAuth(kind,reviewSha256) {
  requireThat(!this.#config.readonly?.externalCompletedSlots?.includes(kind),'QWEN_READONLY_ALREADY_CONSUMED');
  const plan=this.readonlyPlan(),planSha=digest(JSON.stringify(plan));
  requireThat(this.#config.readonly?.reviewedPlanSha256===planSha && reviewSha256===planSha,'QWEN_READONLY_REVIEW_REQUIRED');
  const token=this.#token(kind),dir=this.#reserve(`readonly-${kind}`,{kind,planSha256:planSha,at:new Date().toISOString(),automaticRetry:false});
  if(!dir)return {credentialSlot:kind,classification:'reserved_or_finished',automaticRetry:false,authenticationAccepted:false,modelAccessVerified:false};
  let receipt;
  try {
   const {httpStatus,body}=await this.#call({...plan,token});
   const rows=body.output?.tasks ?? body.output?.task_list ?? body.tasks ?? body.task_list;
   receipt={credentialSlot:kind,httpStatus,request_id:safeId(body.request_id,token),code:providerCode(body.code,token),returnedCount:Array.isArray(rows)?rows.length:null,classification:httpStatus===200?'readonly_endpoint_accepted':[401,403].includes(httpStatus)?'authentication_or_scope_rejected':'http_error',authenticationAccepted:httpStatus===200,modelAccessVerified:false};
  }catch(failure){receipt={credentialSlot:kind,httpStatus:null,request_id:null,code:safeFailureCode(failure),returnedCount:null,classification:'unknown_no_retry',authenticationAccepted:false,modelAccessVerified:false};}
  this.#save(path.join(dir,'receipt.json'),receipt);return receipt;
 }
 async execute(request) {
  const body=this.#request(request.kind,request),kind=request.kind,requestSha256=digest(JSON.stringify(request)),approval=this.#config.generationApprovals?.[request.operationId];
  requireThat(approval?.kind===kind && approval.requestSha256===requestSha256 && approval.maxRequests===1 && Date.parse(approval.expiresAt)>Date.now(),'QWEN_GENERATION_APPROVAL_REQUIRED');
  const units=kind==='video'?request.parameters.duration:[...request.input.text].length;
  requireThat(Number.isInteger(approval.maxUnits) && units<=approval.maxUnits,'QWEN_GENERATION_BUDGET_EXCEEDED');
  const token=this.#token(kind),opDir=this.#reserve(`operation-${request.operationId}`,{operationId:request.operationId,kind,requestSha256,origin:QWEN_ORIGIN,at:new Date().toISOString(),automaticRetry:false});
  if(!opDir)return {operationId:request.operationId,status:'reserved_or_finished',deduplicated:true,automaticRetry:false};
  const payloadSha256=digest(canonical({bindingSha256:this.#config.bindingSha256,kind,body}));
  if(!this.#reserve(`payload-${kind}-${payloadSha256}`,{operationId:request.operationId,requestSha256,payloadSha256}))return {status:'reserved_or_finished',deduplicated:true,automaticRetry:false};
  const budget=this.#config.generationBudget?.[kind];requireThat(Number.isInteger(budget) && budget>=1 && budget<=100,'QWEN_GENERATION_BUDGET_EXCEEDED');
  let slot=null;for(let n=1;n<=budget;n++){slot=this.#reserve(`budget-${kind}-${n}`,{operationId:request.operationId,requestSha256});if(slot)break;}
  requireThat(slot,'QWEN_GENERATION_BUDGET_EXCEEDED');
  let result={operationId:request.operationId,kind,origin:QWEN_ORIGIN,requestSha256,payloadSha256,requestedModel:QWEN_MODELS[kind],actualModelIdentity:null,actualModelIdentityVerified:false,status:'unknown',task_id:null,request_id:null,trace_id:null,automaticRetry:false,modelExecutionVerified:false,businessCompletedVerified:false};
  try {
   const response=await this.#call({method:'POST',url:QWEN_ORIGIN+POST_PATHS[kind],body,token,async:kind==='video',maxBodyBytes:kind==='speech'?LIMIT:1048576,timeoutMs:kind==='speech'?120000:15000});
   const output=response.body.output;result.httpStatus=response.httpStatus;result.request_id=safeId(response.body.request_id,token);result.trace_id=safeId(output?.trace_id ?? response.body.trace_id,token);result.code=providerCode(response.body.code ?? output?.base_resp?.status_code,token);result.provider_code=result.code;
   if(kind==='video')result.task_id=safeId(output?.task_id,token);
   const diagnostic=this.#archiveFailure(opDir,response,token,kind,'execute',result);if(diagnostic)result.diagnostic=diagnostic;
   const returnedModel=response.body.model ?? output?.model;result.actualModelIdentity=reportedModel(returnedModel,token);
   if(kind==='video')result.task_id=safeId(output?.task_id,token);
   requireThat(returnedModel===undefined || returnedModel===null || result.actualModelIdentity===QWEN_MODELS[kind],'QWEN_MODEL_MISMATCH');
   if(response.httpStatus!==200) {result.status='http_error';}
   else if(kind==='video') {
    result.task_id=safeId(output?.task_id,token);result.task_status=['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED','UNKNOWN'].includes(output?.task_status)?output.task_status:null;
    requireThat(result.task_id && result.task_status,'QWEN_RESPONSE_UNKNOWN');result.status='submitted';
   } else {
    requireThat(output?.base_resp?.status_code===0 && output.data?.status===2,'QWEN_SPEECH_RESULT_UNKNOWN');
    const audio=output.data.audio;requireThat(typeof audio==='string' && audio.length>0 && audio.length<=LIMIT && audio.length%2===0 && /^[0-9a-fA-F]+$/.test(audio),'QWEN_SPEECH_AUDIO_UNKNOWN');
    const bytes=Buffer.from(audio,'hex');requireThat(bytes.length>=3 && (bytes.subarray(0,3).toString()==='ID3' || bytes[0]===255 && (bytes[1]&224)===224),'QWEN_SPEECH_AUDIO_UNKNOWN');
    if(output.extra_info?.audio_size!==undefined)requireThat(output.extra_info.audio_size===bytes.length,'QWEN_SPEECH_AUDIO_UNKNOWN');
    const filename=`qwen-${request.operationId}.mp3`,file=this.#target('outputs',filename);const pin=createFile(file,bytes);this.verify();
    const meta=output.extra_info;
    const audioMetadata=Object.fromEntries(['audio_length','audio_sample_rate','audio_size','bitrate','audio_channel','usage_characters','word_count'].filter(key=>Number.isSafeInteger(meta?.[key]) && meta[key]>=0).map(key=>[key,meta[key]]));
    result={...result,status:'succeeded',output:{relativePath:filename,...pin},audioMetadata,modelExecutionVerified:true,technicalDecodeVerified:false,humanListeningVerified:false};
   }
  }catch(failure){result.code=safeFailureCode(failure);}
  this.#save(path.join(opDir,'result.json'),result);return result;
 }
 async status(operationId,queryId,{recover=false}={}) {
  requireThat(id(operationId) && id(queryId),'QWEN_REQUEST_INVALID');
  const opDir=path.join(this.#base,`operation-${operationId}`),original=jsonFile(path.join(opDir,'result.json'),32768);
  requireThat(original.kind==='video' && original.origin===QWEN_ORIGIN && safeId(original.task_id) && original.status==='submitted','QWEN_NATIVE_TASK_REQUIRED');
  const token=this.#token('video'),dir=this.#reserve(`query-${queryId}`,{operationId,task_id:original.task_id,origin:QWEN_ORIGIN,automaticRetry:false});
  if(!dir)return {status:'reserved_or_finished',deduplicated:true,automaticRetry:false};
  let result={operationId,requestedModel:QWEN_MODELS.video,actualModelIdentity:null,actualModelIdentityVerified:false,task_id:original.task_id,request_id:null,trace_id:null,status:'unknown',automaticRetry:false,modelExecutionVerified:false,businessCompletedVerified:false};
  try {
   const response=await this.#call({method:'GET',url:`${QWEN_ORIGIN}/api/v1/tasks/${original.task_id}`,token,maxBodyBytes:1048576,timeoutMs:15000});
   const out=response.body.output;result.httpStatus=response.httpStatus;result.request_id=safeId(response.body.request_id,token);result.trace_id=safeId(out?.trace_id ?? response.body.trace_id,token);result.code=providerCode(response.body.code ?? out?.code,token);
   const diagnostic=this.#archiveFailure(dir,response,token,'video','status',result);if(diagnostic)result.diagnostic=diagnostic;
   const returnedModel=response.body.model ?? out?.model;result.actualModelIdentity=reportedModel(returnedModel,token);
   requireThat(returnedModel===undefined || returnedModel===null || result.actualModelIdentity===QWEN_MODELS.video,'QWEN_MODEL_MISMATCH');
   requireThat(response.httpStatus===200 && out?.task_id===original.task_id && ['PENDING','RUNNING','SUCCEEDED','FAILED','CANCELED','UNKNOWN'].includes(out.task_status),'QWEN_NATIVE_RESULT_UNKNOWN');
   result.task_status=out.task_status;result.status=out.task_status;result.providerTaskSucceeded=out.task_status==='SUCCEEDED';
   if(out.task_status==='SUCCEEDED') {
    result.mediaRecoveryPending=true;result.mediaRecovery={status:'pending',automaticRetry:false};
    // 先保留模型终态；私有来源持久化失败只改变回收状态。
    try {
     const url=new URL(out.video_url);requireThat(!containsCredentialMaterial(url.href,token),'QWEN_RESPONSE_SECRET_REJECTED');
     validateSourceUrl({url:url.href,allowedHosts:[url.hostname],mode:'fresh',urlSha256:digest(url.href),maxBytes:LIMIT,maxRedirects:0});
     const source={schema:'qwen_media_source_v1',taskId:this.#binding.taskId,bindingSha256:this.#config.bindingSha256,origin:QWEN_ORIGIN,operationId,queryId,task_id:original.task_id,providerTaskStatus:'SUCCEEDED',requestedModel:QWEN_MODELS.video,actualModelIdentity:result.actualModelIdentity,request_id:result.request_id,url:url.href,urlSha256:digest(url.href),hostname:url.hostname,expiresAt:sourceExpiry(url),apiAuthenticationAllowedForDownload:false,atUtc:new Date().toISOString()};
     const sourceFile=path.join(dir,'source-contract.json'),pin=this.#save(sourceFile,source);
     result.mediaHost=this.#config.recovery?.allowedHosts?.includes(url.hostname)?url.hostname:null;
     result.sourceContract={area:'work',relativePath:path.relative(path.join(this.#binding.taskRoot,'work'),sourceFile).split(path.sep).join('/'),sha256:pin.sha256};
    }catch(failure){result.mediaRecovery={status:'blocked',code:safeFailureCode(failure),automaticRetry:false};}
   }
  }catch(failure){result.status='unknown';result.code=safeFailureCode(failure);}
  this.#save(path.join(dir,'result.json'),result);
  if(recover && result.sourceContract) {
   let mediaRecovery;
   try {
    // request文件与审批由可信宿主提供；URL、代理、目录权限均不能由命令改变。
    const name=this.#config.recovery?.automaticRequests?.[queryId];requireThat(typeof name==='string','QWEN_RECOVERY_REVIEW_REQUIRED');
    const template=this.readRequest(name);requireThat(exact(template,['recoveryId','outputName']),'QWEN_RECOVERY_REQUEST_INVALID');
    mediaRecovery=await this.#recover({...template,source:result.sourceContract},true);
   }catch(failure){mediaRecovery={status:'blocked',code:safeFailureCode(failure),automaticRetry:false};}
   this.#save(path.join(dir,'recovery-link.json'),mediaRecovery);return {...result,mediaRecovery,mediaRecoveryPending:mediaRecovery.status!=='succeeded',...(mediaRecovery.output?{output:mediaRecovery.output,modelExecutionVerified:true,technicalDecodeVerified:false}:{})};
  }
  return result;
 }
 #recoveryContext(request,automatic=false) {
  this.verify();requireThat(exact(request,['recoveryId','source','outputName']) && id(request.recoveryId) && exact(request.source,['area','relativePath','sha256']) && ['inputs','work'].includes(request.source.area) && /^[a-f0-9]{64}$/.test(request.source.sha256) && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.mp4$/.test(request.outputName),'QWEN_RECOVERY_REQUEST_INVALID');
  const bytes=readOrdinary(this.#target(request.source.area,request.source.relativePath),32768);requireThat(digest(bytes)===request.source.sha256,'QWEN_RECOVERY_SOURCE_CHANGED');
  let source;try{source=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw error('QWEN_RECOVERY_SOURCE_INVALID');}
  const policy=this.#config.recovery,approval=policy?.approvals?.[request.recoveryId],requestSha256=digest(JSON.stringify(request));
  requireThat(policy && Array.isArray(policy.allowedHosts) && Number.isSafeInteger(policy.maxBytes) && policy.maxBytes>0 && policy.maxBytes<=LIMIT && Number.isSafeInteger(policy.timeoutMs) && policy.timeoutMs>0 && policy.timeoutMs<=120000 && Number.isInteger(policy.maxDownloads) && policy.maxDownloads>=0 && policy.maxDownloads<=100,'QWEN_RECOVERY_REVIEW_REQUIRED');
  if(policy.proxy)validateDownloadProxy(policy.proxy);
  const url=new URL(source.url),urlSha256=digest(url.href);
  const approvedSource=automatic?source.schema==='qwen_media_source_v1' && approval?.automaticQueryId===source.queryId && approval?.operationId===source.operationId && approval?.nativeTaskId===source.task_id:approval?.requestSha256===requestSha256 && approval?.urlSha256===urlSha256;
  requireThat(approval?.maxRequests===1 && Date.parse(approval.expiresAt)>Date.now() && approval.hostname===url.hostname && approvedSource,'QWEN_RECOVERY_REVIEW_REQUIRED');
  requireThat(source.hostname===url.hostname && source.apiAuthenticationAllowedForDownload===false && id(source.taskId) && id(source.operationId) && safeId(source.task_id),'QWEN_RECOVERY_SOURCE_INVALID');
  let sourceTrust,expectedSha256,expectedBytes;
  if(source.schema==='qwen_media_source_v1') {
   requireThat(source.taskId===this.#binding.taskId && source.bindingSha256===this.#config.bindingSha256 && source.origin===QWEN_ORIGIN && source.providerTaskStatus==='SUCCEEDED' && source.requestedModel===QWEN_MODELS.video && id(source.queryId) && source.urlSha256===urlSha256 && request.source.area==='work' && request.source.relativePath===`qwen-media/query-${source.queryId}/source-contract.json`,'QWEN_RECOVERY_SOURCE_INVALID');
   const native=jsonFile(path.join(this.#base,`query-${source.queryId}`,'result.json'),32768),original=jsonFile(path.join(this.#base,`operation-${source.operationId}`,'result.json'),32768);
   requireThat(native.status==='SUCCEEDED' && native.providerTaskSucceeded===true && native.task_id===source.task_id && native.sourceContract?.sha256===request.source.sha256 && original.kind==='video' && original.origin===QWEN_ORIGIN && original.task_id===source.task_id && original.status==='submitted','QWEN_RECOVERY_NATIVE_PROOF_REQUIRED');
   sourceTrust='persisted-native-result';
  }else {
   const pin=policy.sourceImports?.find(item=>item.sha256===request.source.sha256);
   requireThat(source.schema==='private_h3_native_source_v1' && request.source.area==='inputs' && pin && pin.taskId===source.taskId && pin.operationId===source.operationId && pin.task_id===source.task_id && pin.urlSha256===urlSha256 && pin.hostname===url.hostname && /^[a-f0-9]{64}$/.test(pin.expectedSha256) && Number.isSafeInteger(pin.expectedBytes) && pin.expectedBytes>0 && pin.expectedBytes<=policy.maxBytes,'QWEN_RECOVERY_IMPORT_REVIEW_REQUIRED');
   sourceTrust='host-pinned-import';expectedSha256=pin.expectedSha256;expectedBytes=pin.expectedBytes;
  }
  const expiresAt=sourceExpiry(url);requireThat(!expiresAt || Date.parse(expiresAt)>Date.now(),'QWEN_RECOVERY_SOURCE_EXPIRED');
  requireThat(source.schema!=='qwen_media_source_v1' || source.expiresAt===expiresAt,'QWEN_RECOVERY_SOURCE_INVALID');
  const downloadSource={url:url.href,urlSha256,allowedHosts:policy.allowedHosts,...(expectedSha256?{mode:'pinned',sha256:expectedSha256,byteLength:expectedBytes}:{mode:'fresh',maxBytes:policy.maxBytes,maxRedirects:0})};
  validateSourceUrl(downloadSource);const file=this.#target('outputs',request.outputName);
  return {source,sourceTrust,downloadSource,file,policy,requestSha256,expiresAt};
 }
 recoveryPlan(request) {
  const c=this.#recoveryContext(request);
  return {schema:'qwen_media_recovery_plan_v1',taskId:this.#binding.taskId,recoveryId:request.recoveryId,requestSha256:c.requestSha256,sourceContract:request.source,sourceTrust:c.sourceTrust,originalTaskId:c.source.taskId,nativeTaskId:c.source.task_id,providerTaskStatus:'SUCCEEDED',hostname:c.source.hostname,urlSha256:c.downloadSource.urlSha256,expiresAt:c.expiresAt,linkExpiryKnown:c.expiresAt!==null,outputName:request.outputName,networkMode:c.policy.proxy?'loopback-connect':'direct',maxBytes:c.policy.maxBytes,timeoutMs:c.policy.timeoutMs,remainingBudgetNotVerified:c.policy.maxDownloads,maxRedirects:0,automaticRetry:false,authenticationCopied:false,credentialReads:0,platformRequests:0,generationRequests:0,networkRequests:0,downloadEnabled:c.policy.maxDownloads>0};
 }
 async recover(request) {return this.#recover(request);}
 async #recover(request,automatic=false) {
  const c=this.#recoveryContext(request,automatic);requireThat(c.policy.maxDownloads>=1,'QWEN_RECOVERY_BUDGET_EXCEEDED');
  const dir=this.#reserve(`recovery-${request.recoveryId}`,{requestSha256:c.requestSha256,sourceSha256:request.source.sha256,task_id:c.source.task_id,atUtc:new Date().toISOString(),automaticRetry:false});
  if(!dir)return {recoveryId:request.recoveryId,status:'reserved_or_finished',deduplicated:true,automaticRetry:false};
  // 同一原生任务跨命令名、query签名URL和进程去重；意图永不自动释放。
  const sourceKey=digest(canonical({origin:QWEN_ORIGIN,taskId:c.source.taskId,task_id:c.source.task_id,kind:'video'}));
  if(!this.#reserve(`recovery-source-${sourceKey}`,{recoveryId:request.recoveryId,sourceSha256:request.source.sha256})) {
   const receipt={recoveryId:request.recoveryId,status:'reserved_or_finished',deduplicated:true,automaticRetry:false};this.#save(path.join(dir,'result.json'),receipt);return receipt;
  }
  let slot=null;for(let n=1;n<=c.policy.maxDownloads;n++){slot=this.#reserve(`recovery-budget-${n}`,{recoveryId:request.recoveryId,sourceKey});if(slot)break;}requireThat(slot,'QWEN_RECOVERY_BUDGET_EXCEEDED');
  let result={schema:'qwen_media_recovery_result_v1',recoveryId:request.recoveryId,originalTaskId:c.source.taskId,nativeTaskId:c.source.task_id,providerTaskStatus:'SUCCEEDED',sourceContract:request.source,sourceTrust:c.sourceTrust,status:'unknown',automaticRetry:false,credentialReads:0,platformRequests:0,generationRequests:0,authenticationCopied:false,modelExecutionVerified:false,technicalDecodeVerified:false,businessCompletedVerified:false};
  try {
   const downloaded=await downloadPinnedSource(c.downloadSource,c.file,{proxy:c.policy.proxy??null,timeoutMs:c.policy.timeoutMs,traceFile:path.join(dir,'download-trace.json')});this.verify();
   const bytes=readOrdinary(c.file,c.policy.maxBytes);requireThat(bytes.length===downloaded.byteLength && digest(bytes)===downloaded.sha256 && downloaded.diskReadbackVerified===true,'QWEN_RECOVERY_DISK_MISMATCH');
   requireThat(bytes.length>=8 && bytes.subarray(4,8).toString()==='ftyp','QWEN_VIDEO_TYPE_UNKNOWN');
   result={...result,status:'succeeded',output:{relativePath:request.outputName,sha256:downloaded.sha256,byteLength:downloaded.byteLength},diskReadbackVerified:true,modelExecutionVerified:true};
  }catch(failure){result.code=safeFailureCode(failure);result.downloadCode=typeof failure?.code==='string' && /^CONTENT_DOWNLOAD_[A-Z_]{1,70}$/.test(failure.code)?failure.code:null;result.partialFilePreserved=fs.existsSync(c.file);}
  this.#save(path.join(dir,'result.json'),result);return result;
 }
}
export function safeFailureCode(failure) {return typeof failure?.code==='string' && /^QWEN_[A-Z_]{1,70}$/.test(failure.code)?failure.code:'QWEN_OPERATION_UNKNOWN';}
export function loadQwenConfig(file) {return jsonFile(ordinaryPath(file),65536);}
export function readonlyPlanSha256(plan) {return digest(JSON.stringify(plan));}
