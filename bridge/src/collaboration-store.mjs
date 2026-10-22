import { operateTaskFile } from './collaboration-file-boundary.mjs';
import { platformRoutes } from './collaboration-routes.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, SOURCE_ROOT, RUNTIME_ROOT, inside, fail, sha256 } from './policy.mjs';
import { sessionPath, readBoundedFile, createFileScope, SessionFiles } from './session-files.mjs';
import { parseCollaborationArgs, collaborationToolNames } from './collaboration-tools.mjs';
import { CollaborationInbox } from './collaboration-inbox.mjs';
import { CollaborationMedia, MEDIA_TOOLS } from './collaboration-media.mjs';
import {CollaborationContent,CONTENT_TOOLS} from './collaboration-content.mjs';
import {CoreQwenMedia,CORE_QWEN_TOOLS} from './core-qwen-media.mjs';
import {reviewPreparedWorkspaces,verifyPreparedWorkspace,copyPreparedBrief,safeLocalDirectoryName} from './collaboration-workspaces.mjs';

export const COLLABORATION_RUNTIME_ROOT=path.join(RUNTIME_ROOT,'collaboration-core');
const now=()=>new Date().toISOString(),uuid=()=>randomUUID();
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const unique=values=>[...new Set(values)];
export function coreText(value,limit=32768,empty=false){if(typeof value!=='string'||!value.isWellFormed()||(!empty&&!value.length)||Buffer.byteLength(value,'utf8')>limit)fail('TEXT_LIMIT','正文必须为有效、有界 UTF-8 文本。');return value;}
function directoryIdentity(directory){sessionPath(directory);const stat=fs.statSync(directory,{bigint:true});if(!stat.isDirectory())fail('WORKSPACE_DIRECTORY_REQUIRED','任务组件必须为普通目录。');return{path:path.resolve(directory),realPath:fs.realpathSync(directory),dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export class CollaborationStore{
 #issued=new WeakSet();
 constructor({dbPath,runtimeNamespace=null,preparedWorkspaces=[],executionProvider=null,fileWorker=null,contentMediaTools=null,allowPausedFixtures=false,coreMedia=null,coreMediaTestHooks={}}={}){
  if(runtimeNamespace!==null&&!safeLocalDirectoryName(runtimeNamespace))fail('RUNTIME_NAMESPACE_INVALID','独立运行命名空间必须是可信启动指定的安全标识。');
  this.runtimeRoot=runtimeNamespace===null?COLLABORATION_RUNTIME_ROOT:path.join(COLLABORATION_RUNTIME_ROOT,runtimeNamespace);this.preparedWorkspaces=reviewPreparedWorkspaces(preparedWorkspaces);
  this.fileWorker=fileWorker;
  this.contentMediaTools=contentMediaTools?structuredClone(contentMediaTools):null;
  this.executionProvider=executionProvider;this.allowPausedFixtures=allowPausedFixtures===true&&process.env.COLLAB_TEST_MODE==='1'&&PROJECT_ROOT!==SOURCE_ROOT;
  fs.mkdirSync(sessionPath(this.runtimeRoot,false),{recursive:true});
  this.dbPath=sessionPath(dbPath??path.join(this.runtimeRoot,'collaboration.sqlite'),false);if(!inside(this.runtimeRoot,this.dbPath))fail('DATABASE_SCOPE','协作数据库只能位于可信独立运行命名空间。');
  fs.mkdirSync(sessionPath(path.dirname(this.dbPath),false),{recursive:true});this.checkDb();
  this.db=new DatabaseSync(this.dbPath);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
  this.db.exec(`CREATE TABLE IF NOT EXISTS core_records(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
   CREATE TABLE IF NOT EXISTS core_credentials(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,instance_id TEXT NOT NULL,kind TEXT NOT NULL,active INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS core_requests(actor TEXT NOT NULL,request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(actor,request_id));
   CREATE TABLE IF NOT EXISTS core_reads(actor TEXT NOT NULL,kind TEXT NOT NULL,record_id TEXT NOT NULL,group_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(actor,kind,record_id));
   CREATE TABLE IF NOT EXISTS core_events(seq INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,actor TEXT NOT NULL,actor_kind TEXT NOT NULL,operation TEXT NOT NULL,group_id TEXT,value TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS core_wake_requests(request_id TEXT PRIMARY KEY,execution_id TEXT NOT NULL,actor TEXT NOT NULL);
   PRAGMA user_version=1;`);
  this.databaseIdentity=this.fileIdentity(this.dbPath);
  this.inbox=new CollaborationInbox(this);
  this.media=new CollaborationMedia(this);
  this.content=new CollaborationContent(this);
  this.coreMedia=new CoreQwenMedia(this,coreMedia,coreMediaTestHooks);
 }
 fileIdentity(file){const stat=fs.lstatSync(sessionPath(file),{bigint:true});if(!stat.isFile()||stat.nlink!==1n)fail('DATABASE_IDENTITY','协作数据文件必须是单链接普通文件。');return{dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};}
 checkDb(){for(const suffix of['','-wal','-shm','-journal']){const file=sessionPath(this.dbPath+suffix,false);if(fs.existsSync(file)){const identity=this.fileIdentity(file);if(suffix===''&&this.databaseIdentity&&!same(identity,this.databaseIdentity))fail('DATABASE_IDENTITY','数据库路径已被替换。');}else if(suffix===''&&this.databaseIdentity)fail('DATABASE_IDENTITY','数据库路径已丢失。');}}
 close(){if(this.closed)return;this.inbox.close();this.closed=true;this.db.close();}
 tx(action){if(this.closed)fail('STORE_CLOSED','协作存储已关闭。');if(this.inTransaction)return action();this.checkDb();this.db.exec('BEGIN IMMEDIATE');this.inTransaction=true;try{const result=action();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}finally{this.inTransaction=false;}}
 get(kind,id,required=true){const row=this.db.prepare('SELECT value FROM core_records WHERE kind=? AND id=?').get(kind,id);if(!row&&required)fail('NOT_FOUND','当前授权范围没有该记录。');return row?JSON.parse(row.value):null;}
 put(kind,id,value){this.db.prepare('INSERT INTO core_records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind,id,JSON.stringify(value));return value;}
 list(kind){return this.db.prepare('SELECT value FROM core_records WHERE kind=? ORDER BY rowid').all(kind).map(row=>JSON.parse(row.value));}
 event(identity,operation,groupId,value={}){this.db.prepare('INSERT INTO core_events(at,actor,actor_kind,operation,group_id,value) VALUES(?,?,?,?,?,?)').run(now(),identity.instanceId,identity.kind,operation,groupId??null,JSON.stringify(value));}
 bootstrapAdmin(){
  const credentialFile=path.join(this.runtimeRoot,'admin-key.txt'),existing=this.get('member','service_admin',false);
  if(existing){if(!fs.existsSync(credentialFile))fail('ADMIN_CREDENTIAL_MISSING','已登记管理员的原凭据文件丢失，禁止自动重建。');const token=readBoundedFile(credentialFile,128).bytes.toString('utf8'),identity=this.resolveCredential(token);if(!identity||identity.kind!=='service_admin')fail('ADMIN_CREDENTIAL_CHANGED','管理员原凭据与数据库不一致。');return{credentialFile};}
  if(fs.existsSync(credentialFile))fail('ADMIN_CREDENTIAL_ORPHANED','存在未登记管理员凭据，保留核查，不接管。');
  return this.provisionMember({instanceId:'service_admin',platform:'infrastructure',mode:'local',kind:'service_admin',capabilities:[]});
 }
 provisionMember({instanceId,platform,mode,credential,kind='member',capabilities=[]}){
  for(const value of[instanceId,platform,mode])if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))fail('MEMBER_INVALID','成员、平台和模式必须为安全标识符。');
  platform=platform.toLowerCase();
  if(!['member','service_admin'].includes(kind)||(kind==='service_admin'&&instanceId!=='service_admin')||(kind==='member'&&instanceId==='service_admin'))fail('MEMBER_INVALID','服务管理员与成员命名空间分离。');
  if(platform==='claude'&&!this.allowPausedFixtures)fail('CLAUDE_PAUSED','Claude 正式登记、认证和执行暂停。');
  if(!Array.isArray(capabilities)||capabilities.length>32||capabilities.some(value=>typeof value!=='string'||value.length>64))fail('MEMBER_INVALID','能力登记必须有界，不授予额外权限。');
  const raw=credential??randomBytes(32).toString('base64url');if(!/^[A-Za-z0-9_-]{43}$/.test(raw))fail('CREDENTIAL_INVALID','本地身份必须为独立生成的有界凭据。');
  return this.tx(()=>{if(this.get('member',instanceId,false))fail('MEMBER_EXISTS','实例已登记，禁止静默替换身份。');const credentialId=uuid();
   const credentialFile=kind==='service_admin'?path.join(this.runtimeRoot,'admin-key.txt'):path.join(this.runtimeRoot,'credentials',`${credentialId}.key`);
   fs.mkdirSync(sessionPath(path.dirname(credentialFile),false),{recursive:true});fs.writeFileSync(sessionPath(credentialFile,false),raw,{flag:'wx',mode:0o600});
   const member={instanceId,kind,platform,mode,capabilities:unique(capabilities),status:'active',createdAt:now(),identityEvidence:'registered',platformVerified:false};
   this.put('member',instanceId,member);this.db.prepare('INSERT INTO core_credentials VALUES(?,?,?,?,1)').run(credentialId,sha256(raw),instanceId,kind);
   return{member,credentialId,credentialFile};});
 }
 resolveCredential(raw){if(typeof raw!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(raw))return null;this.checkDb();const record=this.db.prepare('SELECT * FROM core_credentials WHERE token_hash=? AND active=1').get(sha256(raw));if(!record)return null;const member=this.get('member',record.instance_id,false);if(!member||member.status!=='active'||(member.platform==='claude'&&!this.allowPausedFixtures))return null;
  const identity=Object.freeze({credentialId:record.id,kind:record.kind,instanceId:member.instanceId,platform:member.platform,mode:member.mode,capabilities:Object.freeze([...member.capabilities]),identityEvidence:'registered',platformVerified:false});this.#issued.add(identity);return identity;
 }
 assertIdentity(identity){if(!identity||!this.#issued.has(identity))fail('IDENTITY_UNTRUSTED','身份必须由当前服务凭据映射产生。');const credential=this.db.prepare('SELECT * FROM core_credentials WHERE id=?').get(identity.credentialId),member=this.get('member',identity.instanceId,false);if(!credential?.active||credential.instance_id!==identity.instanceId||credential.kind!==identity.kind||member?.status!=='active')fail('CREDENTIAL_REVOKED','当前凭据已吊销或身份失效。');return identity;}
 as(identity){this.assertIdentity(identity);return Object.freeze({identity,invoke:(name,args={},context={})=>this.invoke(identity,name,args,context)});}
 group(identity,groupId){const group=this.get('group',groupId);if(identity.kind!=='member'||group.members[identity.instanceId]?.state!=='active')fail('GROUP_FORBIDDEN','当前成员不在该组的授权范围。');return group;}
 manager(identity,groupId){const group=this.group(identity,groupId);if(group.managerId!==identity.instanceId)fail('GROUP_MANAGER_REQUIRED','仅当前组 manager 可执行此职责。');return group;}
 memberIds(group){return Object.entries(group.members).filter(([id,value])=>value.state==='active'&&this.get('member',id,false)?.status==='active').map(([id])=>id);}
 member(id){const member=this.get('member',id);if(member.kind!=='member'||member.status!=='active')fail('MEMBER_UNAVAILABLE','目标成员当前不可加入协作。');return member;}
 task(identity,groupId,taskId,{metadata=false}={}){const group=this.group(identity,groupId),task=this.get('task',`${groupId}:${taskId}`);if(task.groupId!==groupId||(!task.participantIds.includes(identity.instanceId)&&!(metadata&&group.managerId===identity.instanceId)))fail('TASK_FORBIDDEN','当前成员没有该任务权限。');return task;}
 message(identity,groupId,id){this.group(identity,groupId);const message=this.get('message',id);if(message.groupId!==groupId||![message.senderId,...message.recipientIds].includes(identity.instanceId))fail('MESSAGE_FORBIDDEN','消息属于其它组或私密收件范围。');return message;}
 artifactReaders(artifact){if(artifact.aclMode!=='task_readers')return artifact.readerIds;const task=this.get('task',`${artifact.groupId}:${artifact.taskId}`);return unique([...(['binary_media','external_media_archive'].includes(artifact.kind)?[]:[artifact.authorId]),...task.fileAcl.readers]).filter(id=>task.participantIds.includes(id));}
 artifact(identity,groupId,id){this.group(identity,groupId);const artifact=this.get('artifact',id);if(artifact.groupId!==groupId||!this.artifactReaders(artifact).includes(identity.instanceId))fail('ARTIFACT_FORBIDDEN','当前成员无权读取该共享成果。');if(artifact.taskId)this.task(identity,groupId,artifact.taskId);return{...artifact,effectiveReaderIds:this.artifactReaders(artifact)};}
 markRead(identity,kind,recordId,groupId){this.db.prepare('INSERT INTO core_reads VALUES(?,?,?,?,?) ON CONFLICT(actor,kind,record_id) DO UPDATE SET at=excluded.at').run(identity.instanceId,kind,recordId,groupId,now());}
 checkSources(identity,groupId,refs,audience){for(const ref of refs){const record=this.get(ref.kind,ref.id);if(record.groupId!==groupId)fail('SOURCE_GROUP_FORBIDDEN','引用不能跨工作组。');const readers=ref.kind==='message'?[record.senderId,...record.recipientIds]:ref.kind==='artifact'?this.artifactReaders(record):record.readerIds??record.participantIds;
   if(!readers?.includes(identity.instanceId))fail('SOURCE_FORBIDDEN','当前成员无权读取引用。');
   if(ref.kind==='artifact'&&record.taskId)this.task(identity,groupId,record.taskId);
   const author=record.authorId??record.senderId;if(author!==identity.instanceId&&!this.db.prepare('SELECT 1 FROM core_reads WHERE actor=? AND kind=? AND record_id=? AND group_id=?').get(identity.instanceId,ref.kind,ref.id,groupId))fail('SOURCE_NOT_READ','引用须来自当前成员实际读过的记录。');
   if(audience.some(id=>!readers.includes(id)))fail('SOURCE_AUDIENCE_FORBIDDEN','引用的目标范围不能大于原授权读者。');
  }}
 taskSummary(task){const{workspace,scope,...publicTask}=task;return{...publicTask,workspaceId:workspace?.taskId??null,taskRoot:workspace?.taskRoot??null,bridgePathBoundaryImplemented:true,platformWorkingDirectoryVerified:false,modelToolBoundaryVerified:false,fileWorkerOsIsolationVerified:false,platformOsIsolationVerified:false,businessCompletedVerified:false};}
 authorize(identity,name,args){
  this.assertIdentity(identity);if(identity.kind==='service_admin')return;
  if(args.groupId&&!['create_group','join_group'].includes(name))this.group(identity,args.groupId);
  if(['invite_member','transfer_manager','create_task','assign_task','set_task_acl','open_meeting','archive_existing_task_media'].includes(name))this.manager(identity,args.groupId);
  if(args.taskId&&name!=='create_task'){
   const task=this.task(identity,args.groupId,args.taskId,{metadata:['get_task','assign_task','set_task_acl'].includes(name)});
   if(['start_task','submit_task_result'].includes(name)&&task.assigneeId!==identity.instanceId)fail('TASK_ASSIGNEE_REQUIRED','仅当前负责人可提交自己的处理记录。');
   if(name==='read_task_file'&&!task.fileAcl.readers.includes(identity.instanceId))fail('FILE_ACL_FORBIDDEN','任务参与身份不等于文件读取授权。');
   if(name==='write_task_file'&&(!task.fileAcl.writers.includes(identity.instanceId)||(args.area==='inputs'&&!task.fileAcl.inputWriters.includes(identity.instanceId))))fail('FILE_ACL_FORBIDDEN','当前成员没有该区域的明确写权限。');
   if(MEDIA_TOOLS.includes(name)&&(!task.fileAcl.readers.includes(identity.instanceId)||(['reserve_media_generation','record_media_generation','register_task_media','archive_existing_task_media'].includes(name)&&!task.fileAcl.writers.includes(identity.instanceId))))fail('FILE_ACL_FORBIDDEN','视频操作及历史请求读回须满足当前任务文件ACL。');
  }
  if(name==='archive_existing_task_media')this.media.archiveSource(identity,args);
  if(args.artifactId)this.artifact(identity,args.groupId,args.artifactId);
 }
 async invoke(identity,name,input,context={}){
  const args=parseCollaborationArgs(identity.kind,name,input,identity);this.authorize(identity,name,args);
  if(CORE_QWEN_TOOLS.includes(name))return this.coreMedia.invoke(identity,name,args);
  if(MEDIA_TOOLS.includes(name))return this.media.invoke(identity,name,args);
  if(CONTENT_TOOLS.includes(name))return this.content.invoke(identity,name,args);
  if(['open_inbox','wait_for_messages','get_inbox','close_inbox'].includes(name))return this.inbox.invoke(identity,name,args,context);
  if(['open_meeting','get_meeting','submit_statement','stop_meeting','propose_conclusion','review_conclusion'].includes(name)){const{meetingOperation,expireMeetingIfNeeded}=await import('./collaboration-meetings.mjs');if(name!=='open_meeting')this.tx(()=>expireMeetingIfNeeded(this,identity,name,args));return this.perform(identity,name,args,()=>meetingOperation(this,identity,name,args));}
  if(['request_execution','wake_execution','get_execution'].includes(name)){const{executionOperation}=await import('./collaboration-execution.mjs');return executionOperation(this,identity,name,args);}
  return this.perform(identity,name,args,()=>this.handle(identity,name,args));
 }
 async perform(identity,name,args,action){
  let afterCommit=null;
  const execute=()=>{this.authorize(identity,name,args);const actor=`${identity.kind}:${identity.instanceId}`,payloadHash=sha256(JSON.stringify(canonical({name,args})));
   if(args.requestId){const cached=this.db.prepare('SELECT * FROM core_requests WHERE actor=? AND request_id=?').get(actor,args.requestId);if(cached){if(cached.payload_hash!==payloadHash)fail('REQUEST_ID_CONFLICT','请求编号已用于不同操作、正文或绑定。');return{...JSON.parse(cached.response),deduplicated:true,historicalResponse:true};}}
   const result=action();if(result?.afterCommit){afterCommit=result.afterCommit;delete result.afterCommit;}
   if(args.requestId)this.db.prepare('INSERT INTO core_requests VALUES(?,?,?,?)').run(actor,args.requestId,payloadHash,JSON.stringify(result));
   return result;
  };
  const result=this.tx(execute);
  if(afterCommit){const completed=await afterCommit();if(args.requestId)this.tx(()=>{this.authorize(identity,name,args);this.db.prepare('UPDATE core_requests SET response=? WHERE actor=? AND request_id=?').run(JSON.stringify(completed),`${identity.kind}:${identity.instanceId}`,args.requestId);});return completed;}
  return result;
 }
 handle(identity,name,args){
  const self=identity.instanceId;
  if(name==='get_capabilities')return{version:'0.2.21',channel:'independent-collaboration',identity:{kind:identity.kind,instanceId:self,platform:identity.platform,mode:identity.mode,identityEvidence:'registered',platformVerified:false},tools:collaborationToolNames(identity.kind,identity),executionRoutes:platformRoutes(identity.platform,identity.mode),fileWorkerBoundary:{implemented:true,configured:this.fileWorker!==null,verification:'per_operation_only',unconfiguredMode:'bridge_only',configuredFailureFallback:false,platformOsIsolationVerified:false},managerRole:'group_scoped_transferable',requiresCodexRuntime:false,activeInboxWaitSupported:true,activeClientWaitVerified:false,maxInboxWaitMs:20000,maxInboxDurationSeconds:600,maxInboxMessages:32,maxInboxWaits:30,maxInboxGroupsPerMember:4,passivePlatformWakeSupported:false,automaticMemberMessages:false,platformIdentityVerified:false,platformWorkingDirectoryVerified:false,modelToolBoundaryVerified:false,fileWorkerOsIsolationVerified:false,platformOsIsolationVerified:false,passiveWakeVerified:false,businessCompletedVerified:false};
  if(name==='list_members')return{members:identity.kind==='service_admin'?this.list('member').filter(member=>member.kind==='member'):this.memberIds(this.group(identity,args.groupId)).map(id=>this.member(id))};
  if(name==='provision_member'){const result=this.provisionMember(args);this.event(identity,name,null,{instanceId:args.instanceId});return result;}
  if(name==='revoke_member'){const target=this.member(args.instanceId);this.db.prepare('UPDATE core_credentials SET active=0 WHERE instance_id=?').run(target.instanceId);target.status='revoked';this.put('member',target.instanceId,target);for(const group of this.list('group'))if(group.members[target.instanceId]?.state==='active'){group.members[target.instanceId].state='revoked';if(group.managerId===target.instanceId){group.managerId=null;this.event(identity,'manager_vacated_by_explicit_revoke',group.groupId,{previousManagerId:target.instanceId,origin:'service_admin_revocation'});}this.put('group',group.groupId,group);}this.event(identity,name,null,{instanceId:target.instanceId});return{instanceId:target.instanceId,status:'revoked'};}
  if(name==='create_group'){
   if(this.get('group',args.groupId,false))fail('GROUP_EXISTS','工作组已存在，不能接管。');
   const memberIds=identity.kind==='service_admin'?unique(args.memberIds):[self],managerId=identity.kind==='service_admin'?args.managerId:self;
   for(const id of memberIds)this.member(id);if(!memberIds.includes(managerId))fail('GROUP_MANAGER_INVALID','组 manager 必须是明确加入的成员。');
   const origin=identity.kind==='service_admin'?'service_admin_initialization':'member_created';
   const group={groupId:args.groupId,title:args.title,managerId,policy:args.policy,createdAt:now(),createdBy:self,origin,members:Object.fromEntries(memberIds.map(id=>[id,{state:'active',joinedAt:now(),consent:origin}]))};this.put('group',group.groupId,group);this.event(identity,name,group.groupId,{origin,managerId,memberIds});return{group};
  }
  if(name==='get_group')return{group:identity.kind==='service_admin'?this.get('group',args.groupId):this.group(identity,args.groupId)};
  if(name==='list_groups')return{groups:this.list('group').filter(group=>group.members[self]?.state==='active')};
  if(name==='get_group_context')return this.groupContext(identity,args);
  if(name==='list_invitations')return{invitations:this.list('invitation').filter(invite=>invite.instanceId===self&&invite.state==='pending')};
  if(name==='invite_member'){const group=this.manager(identity,args.groupId);this.member(args.instanceId);if(group.members[args.instanceId]?.state==='active')fail('ALREADY_MEMBER','目标已在组内。');const invitation={groupId:group.groupId,instanceId:args.instanceId,invitedBy:self,state:'pending',createdAt:now()};this.put('invitation',`${group.groupId}:${args.instanceId}`,invitation);this.event(identity,name,group.groupId,{instanceId:args.instanceId});return{invitation};}
  if(name==='join_group'){const group=this.get('group',args.groupId),invite=this.get('invitation',`${group.groupId}:${self}`);if(invite.instanceId!==self||invite.state!=='pending')fail('JOIN_CONSENT_REQUIRED','加入必须有明确邀请并由本人确认。');if(this.memberIds(group).length>=16)fail('GROUP_LIMIT','组成员达到有界上限。');group.members[self]={state:'active',joinedAt:now(),consent:'member_joined'};invite.state='accepted';this.put('group',group.groupId,group);this.put('invitation',`${group.groupId}:${self}`,invite);this.event(identity,name,group.groupId);return{group};}
  if(name==='leave_group'){const group=this.group(identity,args.groupId);group.members[self].state='left';group.members[self].leftAt=now();if(group.managerId===self)group.managerId=null;this.put('group',group.groupId,group);this.event(identity,name,group.groupId,{managerId:group.managerId});return{group};}
  if(name==='transfer_manager'){const group=this.manager(identity,args.groupId);if(group.members[args.memberId]?.state!=='active')fail('GROUP_MANAGER_INVALID','职责只能转交给现有成员。');this.member(args.memberId);group.managerId=args.memberId;this.put('group',group.groupId,group);this.event(identity,name,group.groupId,{from:self,to:args.memberId});return{group};}
  if(name==='claim_manager'){const group=this.group(identity,args.groupId);if(group.managerId!==null||!group.policy.allowMemberTakeover)fail('GROUP_TAKEOVER_FORBIDDEN','仅明确政策允许且职责空缺时可接任。');group.managerId=self;this.put('group',group.groupId,group);this.event(identity,name,group.groupId,{to:self});return{group};}
  if(name==='send_message')return this.sendMessage(identity,args);
  if(name==='fetch_messages'){this.group(identity,args.groupId);const all=this.list('message').filter(message=>message.groupId===args.groupId&&message.recipientIds.includes(self));const cursor=args.afterMessageId?all.findIndex(message=>message.messageId===args.afterMessageId):-1;if(args.afterMessageId&&cursor<0)fail('MESSAGE_CURSOR_FORBIDDEN','游标必须属于当前成员本组收件。');const eligible=all.slice(cursor+1).filter(message=>!args.unreadOnly||!message.deliveries[self].acknowledgedAt),messages=eligible.slice(0,args.limit);for(const message of messages){message.deliveries[self].deliveredAt??=now();this.put('message',message.messageId,message);this.markRead(identity,'message',message.messageId,args.groupId);}this.event(identity,name,args.groupId,{messageIds:messages.map(message=>message.messageId)});return{messages:messages.map(message=>this.messageView(identity,message)),nextAfterMessageId:messages.at(-1)?.messageId??args.afterMessageId,hasMore:eligible.length>messages.length};}
  if(name==='ack_message'){const message=this.message(identity,args.groupId,args.messageId),delivery=message.deliveries[self];if(!delivery)fail('RECEIPT_ACTOR_FORBIDDEN','发送方或其他成员不能代填收件回执。');if(!delivery.deliveredAt)fail('FETCH_REQUIRED','显式确认前必须实际取回消息。');delivery.acknowledgedAt??=now();this.put('message',message.messageId,message);this.event(identity,name,args.groupId,{messageId:message.messageId});return{message:this.messageView(identity,message)};}
  if(name==='get_message'){const message=this.message(identity,args.groupId,args.messageId);if(message.senderId!==self&&!message.deliveries[self]?.deliveredAt)fail('FETCH_REQUIRED','接收者须先实际取回消息。');this.markRead(identity,'message',message.messageId,args.groupId);return{message:this.messageView(identity,message)};}
  if(name==='create_task')return this.createTask(identity,args);
  if(name==='get_task')return{task:this.taskSummary(this.task(identity,args.groupId,args.taskId,{metadata:true}))};
  if(name==='list_tasks'){const group=this.group(identity,args.groupId);return{tasks:this.list('task').filter(task=>task.groupId===group.groupId&&(group.managerId===self||task.participantIds.includes(self))).map(task=>this.taskSummary(task))};}
  if(name==='assign_task'||name==='set_task_acl'){const group=this.manager(identity,args.groupId),task=this.task(identity,args.groupId,args.taskId,{metadata:true}),previousAcl=task.fileAcl,previousAssignee=task.assigneeId;const participants=name==='assign_task'?unique(args.participantIds):task.participantIds;this.validateTaskAcl(group,participants,args.fileAcl,name==='assign_task'?args.assigneeId:task.assigneeId);task.fileAcl=args.fileAcl;if(name==='assign_task'){task.assigneeId=args.assigneeId;task.participantIds=participants;task.assignmentRevision++;}this.put('task',`${task.groupId}:${task.taskId}`,task);this.event(identity,name,task.groupId,{taskId:task.taskId,assigneeId:task.assigneeId,previousAssignee,previousAcl,fileAcl:task.fileAcl,assignmentRevision:task.assignmentRevision});return{task:this.taskSummary(task)};}
  if(name==='start_task'){const task=this.task(identity,args.groupId,args.taskId);task.agentReported={state:'processing',at:now(),authorId:self};this.put('task',`${task.groupId}:${task.taskId}`,task);this.event(identity,name,task.groupId,{taskId:task.taskId,evidence:'agent_reported'});return{task:this.taskSummary(task),modelStartedVerified:false};}
  if(name==='publish_artifact'||name==='submit_task_result')return this.publishArtifact(identity,args,name==='submit_task_result');
  if(name==='get_artifact'){const artifact=this.artifact(identity,args.groupId,args.artifactId);this.markRead(identity,'artifact',artifact.artifactId,args.groupId);return{artifact};}
  if(name==='review_artifact'){const artifact=this.artifact(identity,args.groupId,args.artifactId);if(!this.db.prepare('SELECT 1 FROM core_reads WHERE actor=? AND kind=? AND record_id=?').get(self,'artifact',artifact.artifactId))fail('SOURCE_NOT_READ','评审前必须实际读取成果。');if(artifact.reviews[self])fail('REVIEW_ALREADY_RECORDED','每位成员只登记一次独立评审，修改应创建新成果。');coreText(args.text,4096,true);artifact.reviews[self]={authorId:self,verdict:args.verdict,text:args.text,at:now(),evidence:'member_submitted'};this.put('artifact',artifact.artifactId,artifact);this.event(identity,name,args.groupId,{artifactId:artifact.artifactId});return{artifact};}
  if(name==='read_task_file'){const task=this.task(identity,args.groupId,args.taskId);if(!task.workspace||!task.scope)fail('WORKSPACE_NOT_READY','任务目录尚未就绪或创建结果未知。');const result=operateTaskFile(this,task,'read',{area:args.area,relativePath:args.relativePath});this.authorize(identity,name,args);if(args.area==='inputs')this.markRead(identity,'task_input',`${args.groupId}:${args.taskId}:${args.relativePath}:${result.sha256}`,args.groupId);return{...result,groupId:args.groupId,taskId:args.taskId,scope:this.fileWorker?'os_worker_with_trusted_broker':'bridge_only'};}
  if(name==='write_task_file')return this.writeTaskFile(identity,args);
  if(name==='register_native_session')return this.registerNative(identity,args);
  if(name==='get_native_session'){const native=this.get('native',`${args.groupId}:${args.taskId}:${self}`,false);if(!native)fail('NATIVE_NOT_FOUND','当前实例未登记该任务的原生来源。');return{native};}
  fail('TOOL_FORBIDDEN','当前工具尚未登记。');
 }
 messageView(identity,message){return identity.instanceId===message.senderId?message:{...message,deliveries:{[identity.instanceId]:message.deliveries[identity.instanceId]}};}
 groupContext(identity,args){const self=identity.instanceId,group=this.group(identity,args.groupId),limit=args.limit;
  const messages=this.list('message').filter(message=>message.groupId===args.groupId&&[message.senderId,...message.recipientIds].includes(self)).slice(-limit);for(const message of messages){if(message.deliveries[self]){message.deliveries[self].deliveredAt??=now();this.put('message',message.messageId,message);}this.markRead(identity,'message',message.messageId,args.groupId);}
  const tasks=this.list('task').filter(task=>task.groupId===args.groupId&&(task.participantIds.includes(self)||group.managerId===self)).slice(-limit).map(task=>this.taskSummary(task));
  const artifacts=this.list('artifact').filter(artifact=>artifact.groupId===args.groupId&&this.artifactReaders(artifact).includes(self)&&(!artifact.taskId||this.get('task',`${args.groupId}:${artifact.taskId}`).participantIds.includes(self))).slice(-limit);for(const artifact of artifacts)this.markRead(identity,'artifact',artifact.artifactId,args.groupId);
  const meetings=this.list('meeting').filter(meeting=>meeting.groupId===args.groupId&&meeting.participantIds.includes(self)).slice(-limit).map(meeting=>{
   if(Date.now()>Date.parse(meeting.deadlineAt)&&!['completed','stopped'].includes(meeting.status)){meeting.status='stopped';meeting.closedReason='deadline';meeting.stoppedBy=null;meeting.stoppedAt=now();this.put('meeting',`${meeting.groupId}:${meeting.meetingId}`,meeting);this.event(identity,'meeting_deadline_observed',meeting.groupId,{meetingId:meeting.meetingId,origin:'infrastructure_deadline'});}
   const statements=meeting.statementIds.slice(-3).map(id=>this.get('statement',id)),conclusions=meeting.conclusionIds.slice(-1).map(id=>this.get('conclusion',id));for(const statement of statements)this.markRead(identity,'statement',statement.statementId,args.groupId);for(const conclusion of conclusions)this.markRead(identity,'conclusion',conclusion.conclusionId,args.groupId);return{meeting,statements,conclusions};});
  return{group,messages:messages.map(message=>this.messageView(identity,message)),tasks,artifacts,meetings,contextSource:'persisted_acl_filtered_records',automaticallySummarized:false,acknowledgementsCreated:false};
 }
 sendMessage(identity,args){const group=this.group(identity,args.groupId),self=identity.instanceId;coreText(args.body);const recipients=args.broadcast?this.memberIds(group).filter(id=>id!==self):unique(args.recipientIds);if(!recipients.length||recipients.includes(self)||recipients.some(id=>!this.memberIds(group).includes(id)))fail('RECIPIENT_FORBIDDEN','收件范围必须是当前组的其他授权成员。');
  if(args.replyTo){const parent=this.message(identity,args.groupId,args.replyTo),delivery=parent.deliveries[self];if(!delivery?.acknowledgedAt)fail('READ_ACK_REQUIRED','回复前须实际取回并显式确认原消息。');if(!recipients.includes(parent.senderId)||recipients.some(id=>![parent.senderId,...parent.recipientIds].includes(id)))fail('REPLY_SCOPE_FORBIDDEN','回复不能超出原消息范围，且须送达原发送者。');}
  this.checkSources(identity,args.groupId,args.sourceIds,[self,...recipients]);const message={messageId:uuid(),groupId:group.groupId,senderId:self,recipientIds:recipients,broadcast:args.broadcast,body:args.body,replyTo:args.replyTo,sourceIds:args.sourceIds,storedAt:now(),deliveries:Object.fromEntries(recipients.map(id=>[id,{storedAt:now(),deliveredAt:null,acknowledgedAt:null,repliedAt:null,replyMessageIds:[]}]))};
  this.put('message',message.messageId,message);this.markRead(identity,'message',message.messageId,args.groupId);
  if(args.replyTo){const parent=this.get('message',args.replyTo);parent.deliveries[self].repliedAt??=now();parent.deliveries[self].replyMessageIds.push(message.messageId);this.put('message',parent.messageId,parent);}
  this.event(identity,'send_message',args.groupId,{messageId:message.messageId,recipientIds:recipients,replyTo:args.replyTo});return{message};
 }
 validateTaskAcl(group,participants,acl,assignee){if(!participants.includes(assignee)||participants.some(id=>!this.memberIds(group).includes(id)))fail('TASK_PARTICIPANTS_INVALID','任务负责人和参与者必须在当前组。');for(const key of['readers','writers','inputWriters'])if(acl[key].some(id=>!participants.includes(id)))fail('FILE_ACL_INVALID','文件授权必须显式限定为任务参与者。');if(acl.writers.some(id=>!acl.readers.includes(id))||acl.inputWriters.some(id=>!acl.writers.includes(id)))fail('FILE_ACL_INVALID','写权限须有读取权限，输入写须有普通写权限。');}
 createTask(identity,args){const group=this.manager(identity,args.groupId),key=`${args.groupId}:${args.taskId}`;if(this.get('task',key,false))fail('TASK_EXISTS','任务已登记，不能接管或替换。');const participants=unique(args.participantIds);this.validateTaskAcl(group,participants,args.fileAcl,args.assigneeId);this.checkSources(identity,args.groupId,args.sourceIds,participants);
  const prepared=this.preparedWorkspaces.get(key)??null;
  const task={groupId:args.groupId,taskId:args.taskId,title:args.title,assigneeId:args.assigneeId,participantIds:participants,fileAcl:args.fileAcl,sourceIds:args.sourceIds,createdBy:identity.instanceId,createdAt:now(),assignmentRevision:1,status:'workspace_unknown',workspaceId:prepared?path.basename(prepared.root):`core_${uuid().replaceAll('-','')}`,results:[],agentReported:null};this.put('task',key,task);this.event(identity,'task_reserved',args.groupId,{taskId:task.taskId});
  return{task:this.taskSummary(task),afterCommit:async()=>{try{const root=path.join(PROJECT_ROOT,'task-workspaces',task.workspaceId);if(prepared)verifyPreparedWorkspace(prepared,{requireUnbound:true});else{fs.mkdirSync(sessionPath(path.dirname(root),false),{recursive:true});fs.mkdirSync(sessionPath(root,false));}const paths={taskRoot:root,inputs:path.join(root,'inputs'),work:path.join(root,'work'),outputs:path.join(root,'outputs')};for(const area of['inputs','work','outputs']){if(prepared&&fs.existsSync(paths[area]))directoryIdentity(paths[area]);else fs.mkdirSync(sessionPath(paths[area],false));}const marker=Buffer.from(JSON.stringify({taskId:task.workspaceId,owner:'collaboration-core',groupId:task.groupId,logicalTaskId:task.taskId,bindingId:uuid()}),'utf8');fs.writeFileSync(path.join(root,'.task-binding.json'),marker,{flag:'wx',mode:0o600});
    const workspace={taskId:task.workspaceId,owner:'collaboration-core',...paths,cwd:root,identities:Object.fromEntries(Object.entries(paths).map(([name,directory])=>[name,directoryIdentity(directory)])),markerSha256:sha256(marker)};const scope=createFileScope(workspace);const preparedInput=prepared?copyPreparedBrief(prepared,path.join(paths.inputs,'files','manager-brief.json')):null;
    return this.tx(()=>{this.authorize(identity,'create_task',args);const current=this.get('task',key);current.workspace=workspace;current.scope=scope;current.preparedInput=preparedInput;current.status='assigned';this.put('task',key,current);this.event(identity,'task_workspace_ready',args.groupId,{taskId:task.taskId});return{task:this.taskSummary(current)};});
   }catch(error){this.tx(()=>{const current=this.get('task',key);current.status='workspace_unknown';this.put('task',key,current);});fail('WORKSPACE_CREATION_UNKNOWN','任务目录创建未完成，原占位与文件保留，不自动重做。');}}};
 }
 publishArtifact(identity,args,taskResult=false){const self=identity.instanceId,task=args.taskId?this.task(identity,args.groupId,args.taskId):null;coreText(args.text);const readers=taskResult?unique([self,...task.fileAcl.readers]):unique(args.readerIds);if(!readers.includes(self)||readers.some(id=>!this.memberIds(this.group(identity,args.groupId)).includes(id))||(task&&readers.some(id=>!task.participantIds.includes(id))))fail('ARTIFACT_READERS_INVALID','成果读者须明确且不超出任务/组范围。');this.checkSources(identity,args.groupId,args.sourceIds,readers);
  const artifact={artifactId:uuid(),groupId:args.groupId,taskId:task?.taskId??null,title:taskResult?task.title:args.title,text:args.text,authorId:self,readerIds:readers,aclMode:taskResult?'task_readers':'explicit_readers',sourceIds:args.sourceIds,sha256:sha256(Buffer.from(args.text,'utf8')),byteLength:Buffer.byteLength(args.text),createdAt:now(),reviews:{},evidence:'member_submitted',sharedConsensusVerified:false,businessCompletedVerified:false};this.put('artifact',artifact.artifactId,artifact);this.markRead(identity,'artifact',artifact.artifactId,args.groupId);
  if(taskResult){task.results.push({artifactId:artifact.artifactId,authorId:self,assignmentRevision:task.assignmentRevision,sha256:artifact.sha256,at:now()});task.agentReported={state:'result_submitted',authorId:self,at:now()};this.put('task',`${task.groupId}:${task.taskId}`,task);}
  this.event(identity,taskResult?'task_result_submitted':'artifact_published',args.groupId,{artifactId:artifact.artifactId,taskId:task?.taskId??null});return{artifact,task:task?this.taskSummary(task):null};
 }
 writeTaskFile(identity,args){const task=this.task(identity,args.groupId,args.taskId);coreText(args.text,32768,true);if(!task.workspace||!task.scope)fail('WORKSPACE_NOT_READY','任务目录创建结果未知，不能写文件。');const intentId=uuid();this.put('file_write',intentId,{groupId:args.groupId,taskId:args.taskId,authorId:identity.instanceId,state:'unknown',sha256:sha256(Buffer.from(args.text)),at:now()});
  return{writeId:intentId,state:'unknown',afterCommit:async()=>{try{this.authorize(identity,'write_task_file',args);const current=this.task(identity,args.groupId,args.taskId);const result=operateTaskFile(this,current,'write',{area:args.area,relativePath:args.relativePath,text:args.text},{manager:args.area==='inputs'});return this.tx(()=>{this.authorize(identity,'write_task_file',args);this.put('file_write',intentId,{groupId:args.groupId,taskId:args.taskId,authorId:identity.instanceId,state:'succeeded',sha256:result.sha256,at:now()});this.event(identity,'task_file_written',args.groupId,{taskId:args.taskId,writeId:intentId,sha256:result.sha256});return{...result,taskId:args.taskId,groupId:args.groupId,writeId:intentId,scope:this.fileWorker?'os_worker_with_trusted_broker':'bridge_only'};});}catch(error){fail(error.code??'FILE_WRITE_UNKNOWN','文件写入失败，原占位/已有文件保留，不自动覆盖或重写。');}}};
 }
 registerNative(identity,args){const task=this.task(identity,args.groupId,args.taskId);if(args.platform!==identity.platform||args.mode!==identity.mode||args.nativeId.startsWith('-')||/[\x00-\x1f]/.test(args.nativeId))fail('NATIVE_BINDING_INVALID','原生来源必须属于当前实例登记的平台与模式。');
  const allowedFields=['session_id','sessionId','conversation_id','conversationId',...(identity.platform==='workbuddy'&&identity.mode==='cloud'?['task_id']:[]),...(identity.platform==='codex'&&['code_cli','codex_cli','cli'].includes(identity.mode)?['thread_id']:[])];
  if(!allowedFields.includes(args.nativeFieldName)||(args.nativeFieldName==='task_id'&&args.storageKind!=='cloud')||[args.groupId,args.taskId,task.workspaceId,identity.instanceId].includes(args.nativeId)||['message','artifact','execution','statement'].some(kind=>this.get(kind,args.nativeId,false)))fail('NATIVE_FIELD_UNSUPPORTED','消息、连接、组或本地任务编号不能冒充原生会话编号；原字段须匹配平台模式。');
  if(args.storageKind==='local'){if(!task.workspace||typeof args.cwd!=='string'||!path.isAbsolute(args.cwd)||args.cwd!==path.resolve(args.cwd)||path.resolve(args.cwd).toLowerCase()!==task.workspace.cwd.toLowerCase())fail('NATIVE_CWD_MISMATCH','本地 cwd 必须与本任务规范路径绑定。');new SessionFiles({workspace:task.workspace,scope:task.scope});if(fs.realpathSync(args.cwd).toLowerCase()!==fs.realpathSync(task.workspace.cwd).toLowerCase())fail('NATIVE_CWD_MISMATCH','本地 cwd 真实路径不符。');}
  else if(args.storageKind==='unknown'?args.cwd!==null:args.cwd!==null&&(!args.cwd.startsWith('/')||args.cwd.includes(':')||args.cwd.includes('\\')))fail('NATIVE_CWD_UNVERIFIED','未知位置 cwd 留空；云端 cwd 不能填本机根。');
  const key=`${args.groupId}:${args.taskId}:${identity.instanceId}`,existing=this.get('native',key,false);const payload={...args};delete payload.requestId;if(existing){if(existing.payloadHash!==sha256(JSON.stringify(canonical(payload))))fail('NATIVE_BINDING_CONFLICT','原生绑定不能通过消息覆盖或改号。');return{native:existing};}
  const native={bindingId:uuid(),groupId:args.groupId,taskId:args.taskId,instanceId:identity.instanceId,platform:identity.platform,mode:identity.mode,nativeFieldName:args.nativeFieldName,nativeId:args.nativeId,storageKind:args.storageKind,storageLocation:args.storageLocation,cwd:args.cwd,workspaceBinding:task.workspace?.markerSha256??null,sourceReceiptHash:args.sourceReceiptHash,reportedSource:args.source,sourceType:'member_reported',runtimeVerified:false,platformIdentityVerified:false,conversationId:null,payloadHash:sha256(JSON.stringify(canonical(payload))),createdAt:now()};this.put('native',key,native);this.event(identity,'native_reported',args.groupId,{taskId:args.taskId,bindingId:native.bindingId});return{native};
 }
}
