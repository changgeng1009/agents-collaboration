import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {ordinaryPath,readOrdinary} from './qwen-media-adapter.mjs';
import {containsCredentialMaterial} from './qwen-error-diagnostics.mjs';

export const WORKBUDDY_HISTORY_LIMITS=Object.freeze({maxMessages:100,maxSegmentsPerMessage:16,maxSegmentUtf8Bytes:8192,maxMessageUtf8Bytes:32768,maxTotalTextUtf8Bytes:262144});
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value&&typeof value==='object'?Array.isArray(value)?value.map(v=>JSON.parse(canonical(v))):Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])):value);
const stop=code=>Object.assign(new Error('本地助理正文已停止；私有原证据和未知占位保留，不自动重读。'),{code});
const check=(ok,code)=>{if(!ok)throw stop(code);};
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const exact=(v,keys)=>object(v)&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const id=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const privateId=(v,token)=>id(v)&&!workBuddyHistoryContainsCredential(v,token)?v:null;
const identity=file=>{ordinaryPath(file);const s=fs.lstatSync(file,{bigint:true});check(s.isDirectory()||s.isFile()&&s.nlink===1n,'WB_LOCAL_PRIVATE_IDENTITY');return{path:path.resolve(file),realPath:fs.realpathSync(file),dev:String(s.dev),ino:String(s.ino),birthtimeNs:String(s.birthtimeNs)};};
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value.slice(0,10)+'T00:00:00Z').toISOString().startsWith(value.slice(0,10));
export function workBuddyHistoryContainsCredential(value,token){
 if(value===undefined||value===null)return false;if(typeof value!=='string')return true;
 const queue=[{text:value,depth:0}],seen=new Set();let budget=4*Buffer.byteLength(value)+1024;
 while(queue.length){const{text,depth}=queue.shift();if(seen.has(text))continue;seen.add(text);check(budget>=text.length,'WB_LOCAL_HISTORY_CREDENTIAL_INSPECTION_LIMIT');budget-=text.length;if(containsCredentialMaterial(text,token))return true;if(depth>=3)continue;
  const decoded=text.normalize('NFKC').replace(/(?:%[a-f0-9]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch{return part;}});if(decoded!==text)queue.push({text:decoded,depth:depth+1});
  for(const match of text.matchAll(/[A-Za-z0-9_+\/-]{16,}={0,2}/g)){
   const part=match[0],bytes=Buffer.from(part,'base64url');if(bytes.toString('base64url')!==part.replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'))continue;
   try{const next=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(next.isWellFormed())queue.push({text:next,depth:depth+1});}catch{}
  }
 }
 return false;
}

export function validateWorkBuddyHistoryPolicy(policy){
 check(exact(policy,['schema','persistPlainTextPrivately','allowUncorrelatedOwnerHistory','rawResponsePersistence','limits'])&&policy.schema==='workbuddy_history_content_policy_v1'&&policy.persistPlainTextPrivately===true&&policy.allowUncorrelatedOwnerHistory===true&&policy.rawResponsePersistence===false&&exact(policy.limits,Object.keys(WORKBUDDY_HISTORY_LIMITS)),'WB_LOCAL_HISTORY_POLICY_INVALID');
 for(const[key,max]of Object.entries(WORKBUDDY_HISTORY_LIMITS))check(Number.isSafeInteger(policy.limits[key])&&policy.limits[key]>0&&policy.limits[key]<=max,'WB_LOCAL_HISTORY_POLICY_INVALID');
 return structuredClone(policy);
}

// 只承认官方声明的字符串分段；不猜对象schema，不解释工具指令或附件。
export function parseWorkBuddyHistoryContent(messages,{token,policy}={}){
 const limits=validateWorkBuddyHistoryPolicy(policy).limits;check(Array.isArray(messages),'WB_LOCAL_HISTORY_RESPONSE_INVALID');check(messages.length<=limits.maxMessages,'WB_LOCAL_HISTORY_LIMIT_EXCEEDED');
 let total=0,previous=null,orderWarning=false;const inspected=[],allText=[];
 for(const[index,row]of messages.entries()){
  const value=object(row)?row:{},message_id=privateId(value.message_id,token),role=['user','assistant'].includes(value.role)?value.role:null,msg_type=typeof value.msg_type==='string'&&/^[a-z_]{1,40}$/.test(value.msg_type)&&!workBuddyHistoryContainsCredential(value.msg_type,token)?value.msg_type:null,created_at=timestamp(value.created_at)?value.created_at:null;
  let state='text',reason=null,content=null;
  if(!object(row)||!message_id||!role||!msg_type||!created_at||!Object.hasOwn(value,'content')||!Array.isArray(value.attachments)||!object(value.metadata)){state='unsupported';reason='invalid_or_missing_fields';}
  else if(msg_type!=='text'){state='unsupported';reason='unsupported_message_type';}
  else if(value.attachments.length){state='unsupported';reason='attachments_not_supported';}
  else if(!Array.isArray(value.content)){state='unsupported';reason='structured_or_unknown_content';}
  else{
   check(value.content.length<=limits.maxSegmentsPerMessage,'WB_LOCAL_HISTORY_LIMIT_EXCEEDED');let bytes=0;
   if(value.content.some(part=>typeof part!=='string')){inspected.push({index,message_id,role,msg_type,created_at,content:null,state:'unsupported',reason:'structured_or_unknown_content',attachmentsPersisted:false,metadataPersisted:false,replyTo:null,taskReplyVerified:false});continue;}
   for(const part of value.content){check(part.isWellFormed()&&!/[\p{Cf}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(part),'WB_LOCAL_HISTORY_TEXT_INVALID');const size=Buffer.byteLength(part,'utf8');check(size<=limits.maxSegmentUtf8Bytes,'WB_LOCAL_HISTORY_LIMIT_EXCEEDED');bytes+=size;check(bytes<=limits.maxMessageUtf8Bytes,'WB_LOCAL_HISTORY_LIMIT_EXCEEDED');}
   total+=bytes;check(total<=limits.maxTotalTextUtf8Bytes,'WB_LOCAL_HISTORY_LIMIT_EXCEEDED');
   content=[...value.content];allText.push(content.join(''));if(bytes===0)state='empty';
  }
  if(created_at){const t=Date.parse(created_at);if(previous!==null&&t<previous)orderWarning=true;previous=t;}
  inspected.push({index,message_id,role,msg_type,created_at,content,state,reason,attachmentsPersisted:false,metadataPersisted:false,replyTo:null,taskReplyVerified:false});
 }
 // 脱敏前不截断或哈希正文；包括分段/跨消息拼接及常见编码回显。
 const joined=allText.join('');check(!workBuddyHistoryContainsCredential(joined,token)&&!workBuddyHistoryContainsCredential(joined.replace(/[\r\n\t ]/g,''),token),'WB_LOCAL_HISTORY_CREDENTIAL_REJECTED');
 return{messages:inspected,totalTextUtf8Bytes:total,sourceOrderPreserved:true,orderWarning,completePlainText:inspected.every(m=>m.state!=='unsupported'),historyConversationCorrelationVerified:false,assistantTaskProcessingVerified:false,permissionResponsesSent:0,rawResponsePersisted:false};
}

function controlFile(file,value){ordinaryPath(path.dirname(file));const fd=fs.openSync(ordinaryPath(file,false),'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}

// 可信宿主私有库：任务files工具没有此入口，读取方法也不注册MCP。
export class WorkBuddyPrivateHistory {
 constructor({binding,bindingSha256,authorityId,policy,controlRoot}){
  this.policy=validateWorkBuddyHistoryPolicy(policy);this.bindingSha256=bindingSha256;this.authorityId=authorityId;
  check(id(authorityId)&&/^[a-f0-9]{64}$/.test(bindingSha256??'')&&binding.taskRoot===path.join(binding.projectRoot,'task-workspaces',binding.taskId)&&controlRoot===path.join(binding.taskRoot,'work/workbuddy-localassistant'),'WB_LOCAL_PRIVATE_BINDING_CHANGED');
  this.root=path.join(binding.projectRoot,'bridge/runtime/workbuddy-localassistant-private',hash(canonical({bindingSha256,authorityId})));
  this.control=path.join(controlRoot,'history-private-boundary.json');ordinaryPath(this.root,false);fs.mkdirSync(this.root,{recursive:true});ordinaryPath(controlRoot,false);fs.mkdirSync(controlRoot,{recursive:true});
  this.dbFile=path.join(this.root,'history.sqlite');this.checkFiles();
  const prior=fs.existsSync(this.control)?JSON.parse(readOrdinary(this.control,16384)):null;
  check(prior||!fs.existsSync(this.dbFile),'WB_LOCAL_PRIVATE_ORPHANED');
  if(prior)check(prior.schema==='workbuddy_private_history_binding_v1'&&prior.bindingSha256===bindingSha256&&prior.authorityId===authorityId&&canonical(prior.root)===canonical(identity(this.root))&&fs.existsSync(this.dbFile)&&canonical(prior.database)===canonical(identity(this.dbFile)),'WB_LOCAL_PRIVATE_BINDING_CHANGED');
  // Node fs已完成规范路径/普通文件检查；Windows SQLite使用原生长路径形式，不改系统策略。
  this.db=new DatabaseSync(process.platform==='win32'?path.toNamespacedPath(this.dbFile):this.dbFile);try{this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS history_cursor(cursor_sha TEXT PRIMARY KEY,operation_id TEXT NOT NULL,context_sha TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history_cursor_attempt(operation_id TEXT PRIMARY KEY,cursor_sha TEXT NOT NULL,context_sha TEXT NOT NULL,state TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history_message(id_sha TEXT PRIMARY KEY,body_sha TEXT NOT NULL,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history_receipt(receipt_id TEXT PRIMARY KEY,body_sha TEXT NOT NULL,body TEXT NOT NULL);');
  const expected={schema:'workbuddy_private_history_binding_v1',bindingSha256,authorityId,root:identity(this.root),database:identity(this.dbFile)};
  if(!prior){try{controlFile(this.control,expected);}catch(error){if(error.code!=='EEXIST'){this.db.close();throw error;}check(canonical(JSON.parse(readOrdinary(this.control,16384)))===canonical(expected),'WB_LOCAL_PRIVATE_BINDING_CHANGED');}}
  this.boundary=expected;this.verify();}catch(error){this.close();throw error;}
 }
 checkFiles(){for(const suffix of ['','-wal','-shm','-journal']){const f=ordinaryPath(this.dbFile+suffix,false);if(fs.existsSync(f)){const s=fs.lstatSync(f);check(s.isFile()&&s.nlink===1,'WB_LOCAL_PRIVATE_IDENTITY');}}}
 verify(){this.checkFiles();check(canonical(JSON.parse(readOrdinary(this.control,16384)))===canonical(this.boundary)&&canonical(identity(this.root))===canonical(this.boundary.root)&&canonical(identity(this.dbFile))===canonical(this.boundary.database),'WB_LOCAL_PRIVATE_BINDING_CHANGED');}
 close(){if(this.db){this.db.close();this.db=null;}}
 reserveCursor(afterMessageId,operationId,contextSha256){
  this.verify();const cursorSha=hash(canonical({bindingSha256:this.bindingSha256,authorityId:this.authorityId,afterMessageId}));this.db.exec('BEGIN IMMEDIATE');
  try{
   const attempt=this.db.prepare('SELECT 1 FROM history_cursor_attempt WHERE operation_id=?').get(operationId),old=this.db.prepare('SELECT * FROM history_cursor WHERE cursor_sha=?').get(cursorSha);
   if(attempt||old&&old.state!=='persisted'){this.db.exec('COMMIT');return{reserved:false,cursorSha};}
   this.db.prepare('INSERT INTO history_cursor_attempt VALUES(?,?,?,?)').run(operationId,cursorSha,contextSha256,'unknown_no_retry');
   this.db.prepare('INSERT INTO history_cursor VALUES(?,?,?,?) ON CONFLICT(cursor_sha) DO UPDATE SET operation_id=excluded.operation_id,context_sha=excluded.context_sha,state=excluded.state').run(cursorSha,operationId,contextSha256,'unknown_no_retry');
   this.db.exec('COMMIT');return{reserved:true,cursorSha,previousReadPersisted:Boolean(old)};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 persist(parsed,{cursorSha,operationId,approvalContextSha256,request_id,afterMessageId}){
  this.verify();const cursor=this.db.prepare('SELECT * FROM history_cursor WHERE cursor_sha=?').get(cursorSha);check(cursor?.operation_id===operationId&&cursor.context_sha===approvalContextSha256&&cursor.state==='unknown_no_retry','WB_LOCAL_HISTORY_CURSOR_RESERVED');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   let duplicates=0;const seen=new Set();
   for(const message of parsed.messages){if(!message.message_id)continue;const{index,...body}=message,key=hash(message.message_id),encoded=canonical(body),sha=hash(encoded),old=this.db.prepare('SELECT body_sha FROM history_message WHERE id_sha=?').get(key);if(old)check(old.body_sha===sha,'WB_LOCAL_HISTORY_MESSAGE_CONFLICT');else this.db.prepare('INSERT INTO history_message VALUES(?,?,?)').run(key,sha,encoded);if(seen.has(message.message_id))duplicates++;seen.add(message.message_id);}
   const value={schema:'workbuddy_private_history_receipt_v1',bindingSha256:this.bindingSha256,authorityId:this.authorityId,operationId,approvalContextSha256,request_id,incrementalAfterMessageId:afterMessageId,cursorMeaning:'time_increment_only',nativeConversationId:null,...parsed,duplicateRows:duplicates,createdAt:new Date().toISOString()};
   const body=canonical(value),sha256=hash(body),receiptId=hash(canonical({bindingSha256:this.bindingSha256,authorityId:this.authorityId,operationId}));this.db.prepare('INSERT INTO history_receipt VALUES(?,?,?)').run(receiptId,sha256,body);this.db.prepare('UPDATE history_cursor SET state=? WHERE cursor_sha=?').run('persisted',cursorSha);this.db.prepare('UPDATE history_cursor_attempt SET state=? WHERE operation_id=?').run('persisted',operationId);this.verify();this.db.exec('COMMIT');
   return{storage:'host_private',receiptId,sha256,byteLength:Buffer.byteLength(body),messageCount:parsed.messages.length,textMessages:parsed.messages.filter(m=>m.state==='text').length,emptyMessages:parsed.messages.filter(m=>m.state==='empty').length,unsupportedMessages:parsed.messages.filter(m=>m.state==='unsupported').length,duplicateRows:duplicates,completePlainText:parsed.completePlainText,orderWarning:parsed.orderWarning,contentInSharedOutput:false};
  }catch(error){this.db.exec('ROLLBACK');throw error;}
 }
 read(ref){this.verify();check(ref?.storage==='host_private'&&/^[a-f0-9]{64}$/.test(ref.receiptId??'')&&/^[a-f0-9]{64}$/.test(ref.sha256??''),'WB_LOCAL_PRIVATE_REF_INVALID');const row=this.db.prepare('SELECT * FROM history_receipt WHERE receipt_id=?').get(ref.receiptId);check(row&&row.body_sha===ref.sha256&&hash(row.body)===ref.sha256&&Buffer.byteLength(row.body)===ref.byteLength,'WB_LOCAL_PRIVATE_RECEIPT_CHANGED');return JSON.parse(row.body);}
}
