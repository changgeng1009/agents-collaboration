import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {fail} from './policy.mjs';
import {SessionFiles,sessionPath} from './session-files.mjs';
import {operateTaskFile} from './collaboration-file-boundary.mjs';

export const MEDIA_FILE_LIMIT=256*1024*1024,MEDIA_CHUNK_LIMIT=49152;
export const MEDIA_TOOLS=['reserve_media_generation','record_media_generation','get_media_generation','register_task_media','get_task_media','read_task_media_chunk'];
const now=()=>new Date().toISOString();
const identityOf=stat=>Object.fromEntries(['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'].map(key=>[key,String(stat[key])]));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function ordinary(stat){if(!stat.isFile()||stat.nlink!==1n)fail('MEDIA_FILE_IDENTITY','视频必须为单硬链接普通文件。');if(stat.size<16n||stat.size>BigInt(MEDIA_FILE_LIMIT))fail('MEDIA_FILE_SIZE','视频大小须在16字节至256MiB范围内。');}
function mimeOf(header,relativePath){
 let mime=null,extension=null;
 if(header.subarray(4,8).toString('ascii')==='ftyp'&&header.readUInt32BE(0)>=16&&header.readUInt32BE(0)<=header.length){
  const brand=header.subarray(8,12).toString('ascii');if(['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','dash','M4V '].includes(brand)){mime='video/mp4';extension='.mp4';}
 }else if(header.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&header.includes(Buffer.from('webm'))){mime='video/webm';extension='.webm';}
 if(!mime)fail('MEDIA_MIME_UNSUPPORTED','只登记具有受支持MP4/WebM容器签名的视频；签名不证明可播放。');
 if(path.extname(relativePath).toLowerCase()!==extension)fail('MEDIA_EXTENSION_MISMATCH','文件扩展名与实际容器签名不符。');return mime;
}
function requireBrokerMediaBoundary(store,task){
 // 大文件尚未接入T10固定文本worker；已有OS意图必须失败封闭，不能绕过其持久边界。
 const control=sessionPath(path.join(task.workspace.cwd,'.os-worker'),false);let reserved=false;
 try{fs.lstatSync(control);reserved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(store.fileWorker||reserved)fail('FILE_OS_MEDIA_UNSUPPORTED','当前OS文件worker尚不支持视频大文件，不回退host读取。');
}
function withMediaFile(store,task,relativePath,expected,action){
 requireBrokerMediaBoundary(store,task);const files=new SessionFiles({workspace:task.workspace,scope:task.scope}),file=files.target('outputs',relativePath),before=fs.lstatSync(file,{bigint:true});ordinary(before);
 if(expected&&!same(identityOf(before),expected))fail('MEDIA_FILE_CHANGED','登记的视频身份、大小或修改时间已变化。');
 const fd=fs.openSync(file,'r');
 try{const opened=fs.fstatSync(fd,{bigint:true});ordinary(opened);if(!same(identityOf(before),identityOf(opened)))fail('MEDIA_FILE_CHANGED','视频打开时已被替换。');const result=action(fd,opened);
  files.verify();sessionPath(file);for(const current of [fs.fstatSync(fd,{bigint:true}),fs.lstatSync(file,{bigint:true})]){ordinary(current);if(!same(identityOf(opened),identityOf(current)))fail('MEDIA_FILE_CHANGED','视频读取时发生变化。');}return result;
 }finally{fs.closeSync(fd);}
}
function inspectMedia(store,task,relativePath){return withMediaFile(store,task,relativePath,null,(fd,stat)=>{
 const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024),header=Buffer.alloc(Math.min(4096,Number(stat.size)));let offset=0;
 while(offset<Number(stat.size)){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(stat.size)-offset),offset);if(!count)fail('MEDIA_FILE_CHANGED','视频读取未完成。');if(offset===0)buffer.copy(header,0,0,header.length);hash.update(buffer.subarray(0,count));offset+=count;}
 return{relativePath,area:'outputs',byteLength:offset,sha256:hash.digest('hex'),mimeType:mimeOf(header,relativePath),fileIdentity:identityOf(stat),containerSignatureVerified:true,wholeFileHashVerifiedAtRegistration:true,playabilityVerified:false,fullVideoViewed:false,fileWorkerOsIsolationVerified:false,platformOsIsolationVerified:false};
});}
export class CollaborationMedia{
 constructor(store){this.store=store;}
 task(identity,args,{write=false}={}){const task=this.store.task(identity,args.groupId,args.taskId);if(!task.workspace||!task.scope)fail('WORKSPACE_NOT_READY','当前任务目录尚未就绪。');if(!task.fileAcl.readers.includes(identity.instanceId)||(write&&!task.fileAcl.writers.includes(identity.instanceId)))fail('FILE_ACL_FORBIDDEN','视频操作须有当前任务明确文件读写权限。');new SessionFiles({workspace:task.workspace,scope:task.scope});return task;}
 generation(identity,args){const task=this.task(identity,args),generation=this.store.get('media_generation',args.generationId);if(generation.groupId!==args.groupId||generation.taskId!==args.taskId||generation.workspaceBinding!==task.workspace.markerSha256)fail('GENERATION_BINDING_MISMATCH','生成意图必须绑定本组、本任务及原目录。');return{task,generation};}
 receipt(task,reference){if(!reference)return null;const result=operateTaskFile(this.store,task,'read',reference);return{...reference,sha256:result.sha256,byteLength:result.byteLength,contentReadVerified:true,platformOriginVerified:false};}
 async invoke(identity,name,args){const result=await this.store.perform(identity,name,args,()=>this.handle(identity,name,args));if(result.deduplicated&&result.generation){const current=this.generation(identity,{...args,generationId:result.generation.generationId}).generation;return{...result,generation:current};}return result;}
 handle(identity,name,args){const store=this.store,self=identity.instanceId;
  if(name==='reserve_media_generation'){
   const task=this.task(identity,args,{write:true}),group=store.group(identity,args.groupId);if(task.assigneeId!==self&&group.managerId!==self)fail('GENERATION_OPERATOR_REQUIRED','仅负责人或有文件权限的组manager可登记生成意图。');
   if(store.list('media_generation').some(item=>item.groupId===args.groupId&&item.taskId===args.taskId))fail('GENERATION_ALREADY_RESERVED','该任务已有生成意图，失败或unknown也不换号重新提交。');
   const generation={generationId:randomUUID(),groupId:args.groupId,taskId:args.taskId,workspaceBinding:task.workspace.markerSha256,requestedBy:self,producerId:task.assigneeId,assignmentRevision:task.assignmentRevision,requestedProvider:args.provider,requestedModel:args.model,status:'reserved',providerGenerationId:null,providerGenerationFieldName:null,actualSkillIdentity:null,actualModelIdentity:null,createdAt:now(),events:[],generationSubmittedVerified:false,modelExecutionVerified:false,businessCompletedVerified:false,automaticRetry:false,evidence:'intent_only'};
   store.put('media_generation',generation.generationId,generation);store.event(identity,name,args.groupId,{taskId:args.taskId,generationId:generation.generationId});return{generation};
  }
  if(name==='get_media_generation')return{generation:this.generation(identity,args).generation};
  if(name==='record_media_generation'){
   const{task,generation}=this.generation(identity,args);this.task(identity,args,{write:true});if(self!==generation.producerId||task.assigneeId!==self||task.assignmentRevision!==generation.assignmentRevision)fail('GENERATION_PRODUCER_REQUIRED','仅原负责人可记录自己的生成观察，负责人变更不接管。');
   if(['succeeded','failed','blocked','unknown'].includes(generation.status))fail('GENERATION_TERMINAL','已终止或unknown意图保留，不继续提交或自动补偿。');
   const transitions={reserved:['submitted','blocked','unknown'],submitted:['running','succeeded','failed','unknown'],running:['succeeded','failed','unknown']};if(!transitions[generation.status]?.includes(args.status))fail('GENERATION_STATE_INVALID','生成阶段不能跳过提交记录或倒退。');
   if((args.providerGenerationId===null)!==(args.providerGenerationFieldName===null))fail('GENERATION_NATIVE_FIELD_REQUIRED','平台生成号和原字段名须一同保留，未知均为null。');
   if(generation.providerGenerationId&&(args.providerGenerationId!==generation.providerGenerationId||args.providerGenerationFieldName!==generation.providerGenerationFieldName))fail('GENERATION_NATIVE_ID_CHANGED','已记录的平台生成号及原字段不可变更或清空。');
   for(const field of ['actualSkillIdentity','actualModelIdentity']){if(args[field]&&generation[field]&&!same(args[field],generation[field]))fail('GENERATION_NATIVE_ID_CHANGED','已记录的实际技能或模型标识不可变更。');if(args[field])generation[field]=args[field];}
   const receipt=this.receipt(task,args.sourceReceipt);generation.providerGenerationId??=args.providerGenerationId;generation.providerGenerationFieldName??=args.providerGenerationFieldName;generation.status=args.status;generation.evidence='member_reported';generation.events.push({status:args.status,at:now(),reportedBy:self,providerGenerationId:generation.providerGenerationId,providerGenerationFieldName:generation.providerGenerationFieldName,actualSkillIdentity:generation.actualSkillIdentity,actualModelIdentity:generation.actualModelIdentity,sourceReceipt:receipt,summary:args.summary,evidence:'member_reported'});
   store.put('media_generation',generation.generationId,generation);store.event(identity,name,args.groupId,{taskId:args.taskId,generationId:generation.generationId,status:args.status});return{generation};
  }
  if(name==='register_task_media'){
   const{task,generation}=this.generation(identity,args);this.task(identity,args,{write:true});
   if(store.list('artifact').some(item=>item.kind==='binary_media'&&item.groupId===args.groupId&&item.taskId===args.taskId&&(item.generationId===args.generationId||item.relativePath===args.relativePath)))fail('MEDIA_ALREADY_REGISTERED','该生成意图或输出路径已登记，不换请求重复登记。');
   const media=inspectMedia(store,task,args.relativePath);store.authorize(identity,name,args);this.task(identity,args,{write:true});
   const artifact={artifactId:randomUUID(),kind:'binary_media',groupId:args.groupId,taskId:args.taskId,title:args.title,text:null,authorId:self,readerIds:[...task.fileAcl.readers],aclMode:'task_readers',sourceIds:[],generationId:args.generationId,source:{requestedProvider:generation.requestedProvider,requestedModel:generation.requestedModel,providerGenerationId:generation.providerGenerationId,providerGenerationFieldName:generation.providerGenerationFieldName,actualSkillIdentity:generation.actualSkillIdentity,actualModelIdentity:generation.actualModelIdentity,generationStatus:generation.status,generationEvidence:generation.evidence,platformOriginVerified:false},workspaceBinding:task.workspace.markerSha256,...media,createdAt:now(),reviews:{},evidence:'broker_file_readback',modelExecutionVerified:false,businessCompletedVerified:false,sharedConsensusVerified:false};
   store.put('artifact',artifact.artifactId,artifact);store.markRead(identity,'artifact',artifact.artifactId,args.groupId);store.event(identity,name,args.groupId,{taskId:args.taskId,artifactId:artifact.artifactId,generationId:args.generationId,sha256:artifact.sha256,byteLength:artifact.byteLength});return{artifact};
  }
  if(name==='get_task_media'||name==='read_task_media_chunk'){
   const task=this.task(identity,args),artifact=store.artifact(identity,args.groupId,args.artifactId);if(artifact.kind!=='binary_media'||artifact.taskId!==args.taskId||artifact.workspaceBinding!==task.workspace.markerSha256)fail('MEDIA_BINDING_MISMATCH','视频成果必须属于本组、本任务和原目录。');
   if(name==='get_task_media'){store.markRead(identity,'artifact',artifact.artifactId,args.groupId);return{artifact,metadataOnly:true,fullVideoViewed:false};}
   if(args.offset>artifact.byteLength)fail('MEDIA_RANGE_INVALID','分块偏移超出登记视频范围。');
   const chunk=withMediaFile(store,task,artifact.relativePath,artifact.fileIdentity,fd=>{const bytes=Buffer.alloc(Math.min(args.length,artifact.byteLength-args.offset));let offset=0;while(offset<bytes.length){const read=fs.readSync(fd,bytes,offset,bytes.length-offset,args.offset+offset);if(!read)fail('MEDIA_FILE_CHANGED','视频分块读取未完成。');offset+=read;}return bytes;});
   store.authorize(identity,name,args);this.task(identity,args);store.markRead(identity,'artifact',artifact.artifactId,args.groupId);
   return{artifactId:artifact.artifactId,groupId:args.groupId,taskId:args.taskId,mimeType:artifact.mimeType,totalBytes:artifact.byteLength,registeredSha256:artifact.sha256,offset:args.offset,byteLength:chunk.length,nextOffset:args.offset+chunk.length,endOfFile:args.offset+chunk.length===artifact.byteLength,encoding:'base64',data:chunk.toString('base64'),chunkSha256:createHash('sha256').update(chunk).digest('hex'),chunkReadVerified:true,wholeFileHashVerified:false,fullVideoViewed:false};
  }
  fail('MEDIA_TOOL_UNSUPPORTED','未登记的视频操作。');
 }
}
