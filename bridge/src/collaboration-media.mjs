import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fail,sha256} from './policy.mjs';
import {SessionFiles,sessionPath} from './session-files.mjs';
import {operateTaskFile} from './collaboration-file-boundary.mjs';

export const MEDIA_FILE_LIMIT=256*1024*1024,MEDIA_CHUNK_LIMIT=49152;
export const MEDIA_TOOLS=['reserve_media_generation','record_media_generation','get_media_generation','register_task_media','archive_existing_task_media','get_task_media','read_task_media_chunk'];
const archiveFlags={preGenerationReservationVerified:false,platformGenerationId:null,upstreamIdentityVerified:false};
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
function rejectWindowsReparse(task,file){
 if(process.platform!=='win32')return;
 // Node的符号链接检测不能覆盖所有Windows重解析标签；仅用可信本机PowerShell检查属性，不读取视频正文。
 const paths=[task.workspace.cwd];let cursor=task.workspace.cwd;for(const part of path.relative(cursor,file).split(path.sep)){cursor=path.join(cursor,part);paths.push(cursor);}
 const encoded=Buffer.from(JSON.stringify(paths),'utf8').toString('base64');
 const script=`$ErrorActionPreference='Stop';try{$paths=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;foreach($item in $paths){if(([IO.File]::GetAttributes($item)-band[IO.FileAttributes]::ReparsePoint)-ne 0){exit 23}}}catch{exit 24}`;
 const probe=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:10000,maxBuffer:4096,stdio:['ignore','pipe','pipe']});
 if(probe.status===23)fail('FILE_LINK_FORBIDDEN','既有视频路径不允许Windows重解析点。');
 if(probe.error||probe.status!==0)fail('MEDIA_REPARSE_CHECK_FAILED','无法核验Windows文件属性，保留文件并停止归档。');
}
function withMediaFile(store,task,relativePath,expected,action,{archive=false}={}){
 requireBrokerMediaBoundary(store,task);const files=new SessionFiles({workspace:task.workspace,scope:task.scope}),file=files.target('outputs',relativePath),before=fs.lstatSync(file,{bigint:true});ordinary(before);
 if(archive)rejectWindowsReparse(task,file);
 if(expected&&!same(identityOf(before),expected))fail('MEDIA_FILE_CHANGED','登记的视频身份、大小或修改时间已变化。');
 const fd=fs.openSync(file,'r');
 try{const opened=fs.fstatSync(fd,{bigint:true});ordinary(opened);if(!same(identityOf(before),identityOf(opened)))fail('MEDIA_FILE_CHANGED','视频打开时已被替换。');const result=action(fd,opened);
  files.verify();sessionPath(file);if(archive)rejectWindowsReparse(task,file);requireBrokerMediaBoundary(store,task);for(const current of [fs.fstatSync(fd,{bigint:true}),fs.lstatSync(file,{bigint:true})]){ordinary(current);if(!same(identityOf(opened),identityOf(current)))fail('MEDIA_FILE_CHANGED','视频读取时发生变化。');}return result;
 }finally{fs.closeSync(fd);}
}
function inspectMedia(store,task,relativePath,options,contentType='video'){return withMediaFile(store,task,relativePath,null,(fd,stat)=>{
 const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024),header=Buffer.alloc(Math.min(4096,Number(stat.size)));let offset=0;
 while(offset<Number(stat.size)){const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,Number(stat.size)-offset),offset);if(!count)fail('MEDIA_FILE_CHANGED','视频读取未完成。');if(offset===0)buffer.copy(header,0,0,header.length);hash.update(buffer.subarray(0,count));offset+=count;}
 let mimeType;
 if(contentType==='video')mimeType=mimeOf(header,relativePath);
 else if(contentType==='mp3'){
  if(path.extname(relativePath).toLowerCase()!=='.mp3'||!(header.subarray(0,3).toString('ascii')==='ID3'||header[0]===255&&(header[1]&224)===224))fail('CONTENT_AUDIO_FORMAT_INVALID','原生音频须有MP3签名与匹配扩展名；签名不证明解码或听感。');
  mimeType='audio/mpeg';
 }else if(contentType==='audio'){
  if(path.extname(relativePath).toLowerCase()!=='.wav'||header.toString('ascii',0,4)!=='RIFF'||header.toString('ascii',8,12)!=='WAVE')fail('CONTENT_AUDIO_FORMAT_INVALID','本地配音版本须有WAV容器签名。');
  mimeType='audio/wav';
 }else{
  if(offset>32768||path.extname(relativePath).toLowerCase()!=='.srt')fail('CONTENT_SUBTITLE_FORMAT_INVALID','字幕版本须为有界UTF-8 SRT文件。');
  const text=Buffer.alloc(offset);let count=0;while(count<text.length){const read=fs.readSync(fd,text,count,text.length-count,count);if(!read)fail('MEDIA_FILE_CHANGED','字幕读取不完整。');count+=read;}
  if(!/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/.test(new TextDecoder('utf-8',{fatal:true}).decode(text)))fail('CONTENT_SUBTITLE_FORMAT_INVALID','字幕缺少合法时间行。');
  mimeType='application/x-subrip';
 }
 return{relativePath,area:'outputs',byteLength:offset,sha256:hash.digest('hex'),mimeType,fileIdentity:identityOf(stat),containerSignatureVerified:true,wholeFileHashVerifiedAtRegistration:true,playabilityVerified:false,fullVideoViewed:false,fileWorkerOsIsolationVerified:false,platformOsIsolationVerified:false};
},options);}
export function inspectCoreMediaOutput(store,task,relativePath,kind){return inspectMedia(store,task,relativePath,{archive:true},kind==='speech'?'mp3':'video');}
export class CollaborationMedia{
 constructor(store){this.store=store;}
 inspectContentOutput(identity,args,{write=true}={}){
  const task=this.task(identity,args,{write}),extension=path.extname(args.relativePath).toLowerCase(),contentType=['.mp4','.webm'].includes(extension)?'video':extension==='.wav'?'audio':extension==='.srt'?'subtitles':null;
  if(!contentType)fail('CONTENT_OUTPUT_FORMAT_UNSUPPORTED','制作输出只登记明确的视频、WAV或SRT版本。');
  return{...inspectMedia(this.store,task,args.relativePath,{archive:true},contentType),contentType,evidence:'broker_file_readback'};
 }
 probeContentOutput(identity,args){
  const task=this.task(identity,args),pin=this.store.contentMediaTools?.ffprobe;
  if(!pin||!path.isAbsolute(pin.path??'')||path.basename(pin.path).toLowerCase()!=='ffprobe.exe'||!/^[a-f0-9]{64}$/.test(pin.sha256??'')||sha256(fs.readFileSync(pin.path))!==pin.sha256)fail('CONTENT_QUALITY_PROBE_REQUIRED','没有可信宿主固定的只读探测工具，不能验证实际媒体范围。');
  const before=this.inspectContentOutput(identity,args,{write:false}),file=new SessionFiles({workspace:task.workspace,scope:task.scope}).target('outputs',args.relativePath);
  const observationId=randomUUID(),directory=sessionPath(path.join(task.workspace.work,'content-quality',observationId),false);fs.mkdirSync(directory,{recursive:true});
  const startedAt=now(),result=spawnSync(pin.path,['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],{cwd:task.workspace.cwd,windowsHide:true,shell:false,timeout:10000,maxBuffer:65536,stdio:['ignore','pipe','pipe']});
  const stdout=result.stdout??Buffer.alloc(0),stderr=result.stderr??Buffer.alloc(0),completion={startedAt,completedAt:now(),toolSha256:pin.sha256,exitCode:result.status,signal:result.signal,error:result.error?.code??null,stdoutSha256:sha256(stdout),stderrSha256:sha256(stderr),completion:'synchronous_process_returned',asyncExitCloseEventsClaimed:false};
  for(const[name,bytes]of [['stdout.json',stdout],['stderr.log',stderr],['completion.json',Buffer.from(JSON.stringify(completion,null,2))]])fs.writeFileSync(path.join(directory,name),bytes,{flag:'wx'});
  if(result.error||result.status!==0)fail('CONTENT_MEDIA_PROBE_UNVERIFIED','实际视频探测失败，日志保留，不把目标时长当实际时长。');
  const after=this.inspectContentOutput(identity,args,{write:false});if(before.sha256!==after.sha256||!same(before.fileIdentity,after.fileIdentity))fail('CONTENT_VERSION_FILE_CHANGED','探测期间媒体身份或内容变化。');
  const probe=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(stdout)),durationMs=Math.round(Number(probe.streams?.find(stream=>stream.codec_type==='video')?.duration??probe.format?.duration)*1000);
  if(!Number.isSafeInteger(durationMs)||durationMs<1||durationMs>600000)fail('CONTENT_MEDIA_DURATION_UNVERIFIED','没有取得有界真实视频时长。');
  const observation={observationId,groupId:args.groupId,taskId:args.taskId,observedBy:'trusted_media_probe',requestedBy:identity.instanceId,actorActuallyCalledAgentTool:false,sourceSha256:before.sha256,sourceByteLength:before.byteLength,durationMs,streams:(probe.streams??[]).map(stream=>({type:stream.codec_type,codec:stream.codec_name,width:stream.width??null,height:stream.height??null,sampleRate:stream.sample_rate??null,channels:stream.channels??null})),localProcessObserved:true,toolSha256:pin.sha256,stdoutSha256:sha256(stdout),completion,at:now(),evidenceLevel:process.env.COLLAB_TEST_MODE==='1'?'local_test':'host_local_observation',modelExecutionVerified:false,businessCompletedVerified:false};
  this.store.put('content_host_observation',observationId,observation);return observation;
 }
 task(identity,args,{write=false}={}){const task=this.store.task(identity,args.groupId,args.taskId);if(!task.workspace||!task.scope)fail('WORKSPACE_NOT_READY','当前任务目录尚未就绪。');if(!task.fileAcl.readers.includes(identity.instanceId)||(write&&!task.fileAcl.writers.includes(identity.instanceId)))fail('FILE_ACL_FORBIDDEN','视频操作须有当前任务明确文件读写权限。');new SessionFiles({workspace:task.workspace,scope:task.scope});return task;}
 archiveSource(identity,args){
  const store=this.store;store.manager(identity,args.groupId);const task=this.task(identity,args,{write:true}),source=store.artifact(identity,args.groupId,args.sourceArtifactId);
  const result=task.results.find(item=>item.artifactId===source.artifactId&&item.authorId===source.authorId&&item.sha256===source.sha256&&item.assignmentRevision===1);
  if(source.taskId!==task.taskId||source.aclMode!=='task_readers'||typeof source.text!=='string'||source.kind||!result||createHash('sha256').update(source.text,'utf8').digest('hex')!==source.sha256)fail('ARCHIVE_SOURCE_INVALID','归档来源必须是本任务原始派单负责人经受控提交形成的文本结果。');
  if(!store.db.prepare('SELECT 1 FROM core_reads WHERE actor=? AND kind=? AND record_id=? AND group_id=?').get(identity.instanceId,'artifact',source.artifactId,args.groupId))fail('SOURCE_NOT_READ','manager须实际读取原负责人结果后才能归档。');
  store.checkSources(identity,args.groupId,[{kind:'artifact',id:source.artifactId}],task.fileAcl.readers);
  return{task,source,result};
 }
 generation(identity,args){const task=this.task(identity,args),generation=this.store.get('media_generation',args.generationId);if(generation.groupId!==args.groupId||generation.taskId!==args.taskId||generation.workspaceBinding!==task.workspace.markerSha256)fail('GENERATION_BINDING_MISMATCH','生成意图必须绑定本组、本任务及原目录。');return{task,generation};}
 receipt(task,reference){if(!reference)return null;const result=operateTaskFile(this.store,task,'read',reference);return{...reference,sha256:result.sha256,byteLength:result.byteLength,contentReadVerified:true,platformOriginVerified:false};}
 async invoke(identity,name,args){const result=await this.store.perform(identity,name,args,()=>this.handle(identity,name,args));if(result.deduplicated&&result.generation){const current=this.generation(identity,{...args,generationId:result.generation.generationId}).generation;return{...result,generation:current};}return result;}
 handle(identity,name,args){const store=this.store,self=identity.instanceId;
  if(name==='reserve_media_generation'){
   const task=this.task(identity,args,{write:true}),group=store.group(identity,args.groupId);if(task.assigneeId!==self&&group.managerId!==self)fail('GENERATION_OPERATOR_REQUIRED','仅负责人或有文件权限的组manager可登记生成意图。');
   if(store.list('media_generation').some(item=>item.groupId===args.groupId&&item.taskId===args.taskId))fail('GENERATION_ALREADY_RESERVED','该任务已有生成意图，失败或unknown也不换号重新提交。');
   if(store.list('core_qwen_reservation').some(item=>item.groupId===args.groupId&&item.taskId===args.taskId))fail('GENERATION_ALREADY_RESERVED','该任务已有独立媒体worker意图，不能由旧通道接管。');
   if(store.list('external_media_archive').some(item=>item.groupId===args.groupId&&item.taskId===args.taskId))fail('MEDIA_ARCHIVE_EXISTS','该任务已有既有视频归档，不能再创建生成意图。');
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
  if(name==='archive_existing_task_media'){
   const{task,source,result}=this.archiveSource(identity,args);
   // 与reserve共用BEGIN IMMEDIATE事务；任意生成状态均优先阻断，不能用归档绕过unknown。
   if(store.list('media_generation').some(item=>item.groupId===args.groupId&&item.taskId===args.taskId))fail('ARCHIVE_GENERATION_EXISTS','该任务已有生成意图，不能另走既有视频归档。');
   if(store.list('core_qwen_reservation').some(item=>item.groupId===args.groupId&&item.taskId===args.taskId))fail('ARCHIVE_GENERATION_EXISTS','该任务已有独立媒体意图，不能用归档覆盖原状态。');
   const archives=store.list('external_media_archive');
   if(archives.some(item=>item.sourceArtifactId===source.artifactId))fail('MEDIA_ALREADY_ARCHIVED','该原结果已有独立归档，不重复登记或改用派生副本。');
   const media=inspectMedia(store,task,args.relativePath,{archive:true}),sameTask=item=>item.groupId===args.groupId&&item.taskId===args.taskId;
   if(store.list('artifact').some(item=>sameTask(item)&&['binary_media','external_media_archive'].includes(item.kind)&&(item.relativePath.replaceAll('\\','/').toLowerCase()===args.relativePath.replaceAll('\\','/').toLowerCase()||item.sha256===media.sha256||(item.fileIdentity.dev===media.fileIdentity.dev&&item.fileIdentity.ino===media.fileIdentity.ino))))fail('MEDIA_ALREADY_REGISTERED','该任务的输出路径、文件身份或内容已登记。');
   store.authorize(identity,name,args);requireBrokerMediaBoundary(store,task);
   const archiveId=randomUUID(),artifact={artifactId:randomUUID(),archiveId,kind:'external_media_archive',groupId:args.groupId,taskId:args.taskId,title:args.title,text:null,authorId:self,archivedBy:self,producerId:source.authorId,readerIds:[...task.fileAcl.readers],aclMode:'task_readers',sourceIds:[{kind:'artifact',id:source.artifactId}],sourceArtifactId:source.artifactId,sourceArtifactSha256:source.sha256,sourceAssignmentRevision:result.assignmentRevision,generationId:null,...archiveFlags,workspaceBinding:task.workspace.markerSha256,...media,createdAt:now(),reviews:{},evidence:'broker_existing_file_archive',modelExecutionVerified:false,businessCompletedVerified:false,sharedConsensusVerified:false};
   store.put('external_media_archive',archiveId,artifact);store.put('artifact',artifact.artifactId,artifact);store.markRead(identity,'artifact',artifact.artifactId,args.groupId);store.event(identity,name,args.groupId,{taskId:args.taskId,archiveId,artifactId:artifact.artifactId,sourceArtifactId:source.artifactId,producerId:source.authorId,sha256:media.sha256,byteLength:media.byteLength});return{artifact};
  }
  if(name==='get_task_media'||name==='read_task_media_chunk'){
   const task=this.task(identity,args),artifact=store.artifact(identity,args.groupId,args.artifactId);if(!['binary_media','external_media_archive','core_qwen_media'].includes(artifact.kind)||artifact.taskId!==args.taskId||artifact.workspaceBinding!==task.workspace.markerSha256)fail('MEDIA_BINDING_MISMATCH','媒体成果必须属于本组、本任务和原目录。');
   if(name==='get_task_media'){store.markRead(identity,'artifact',artifact.artifactId,args.groupId);return{artifact,metadataOnly:true,fullVideoViewed:false};}
   if(args.offset>artifact.byteLength)fail('MEDIA_RANGE_INVALID','分块偏移超出登记视频范围。');
   const chunk=withMediaFile(store,task,artifact.relativePath,artifact.fileIdentity,fd=>{const bytes=Buffer.alloc(Math.min(args.length,artifact.byteLength-args.offset));let offset=0;while(offset<bytes.length){const read=fs.readSync(fd,bytes,offset,bytes.length-offset,args.offset+offset);if(!read)fail('MEDIA_FILE_CHANGED','视频分块读取未完成。');offset+=read;}return bytes;},{archive:artifact.kind==='external_media_archive'});
   store.authorize(identity,name,args);this.task(identity,args);store.markRead(identity,'artifact',artifact.artifactId,args.groupId);
   return{artifactId:artifact.artifactId,artifactKind:artifact.kind,...(artifact.kind==='external_media_archive'?archiveFlags:{}),groupId:args.groupId,taskId:args.taskId,mimeType:artifact.mimeType,totalBytes:artifact.byteLength,registeredSha256:artifact.sha256,offset:args.offset,byteLength:chunk.length,nextOffset:args.offset+chunk.length,endOfFile:args.offset+chunk.length===artifact.byteLength,encoding:'base64',data:chunk.toString('base64'),chunkSha256:createHash('sha256').update(chunk).digest('hex'),chunkReadVerified:true,wholeFileHashVerified:false,fullVideoViewed:false};
  }
  fail('MEDIA_TOOL_UNSUPPORTED','未登记的视频操作。');
 }
}
