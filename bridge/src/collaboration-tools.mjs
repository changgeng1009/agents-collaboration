import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { sha256 } from './policy.mjs';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),req={requestId:id},group={groupId:id},task={...group,taskId:id};
const text=z.string().max(32768),ids=z.array(id).max(16),sources=z.array(z.object({kind:z.enum(['message','statement','artifact','conclusion']),id}).strict()).max(16).default([]);
const policy=z.object({allowMemberTakeover:z.boolean()}).strict();
const fileAcl=z.object({readers:ids,writers:ids,inputWriters:ids}).strict();
const memberSchemas={
 get_capabilities:{},list_members:group,list_groups:{},list_invitations:{},
 create_group:{...req,...group,title:z.string().min(1).max(200),policy},get_group:group,get_group_context:{...group,limit:z.number().int().min(1).max(8).default(4)},
 invite_member:{...req,...group,instanceId:id},join_group:{...req,...group},leave_group:{...req,...group},
 transfer_manager:{...req,...group,memberId:id},claim_manager:{...req,...group},
 send_message:{...req,...group,recipientIds:ids.default([]),broadcast:z.boolean().default(false),body:text.min(1),replyTo:id.nullable().default(null),sourceIds:sources},
 fetch_messages:{...req,...group,unreadOnly:z.boolean().default(true),limit:z.number().int().min(1).max(32).default(16),afterMessageId:id.nullable().default(null)},
 open_inbox:{...req,...group,durationSeconds:z.number().int().min(1).max(600).default(180),maxMessages:z.number().int().min(1).max(32).default(8),maxWaits:z.number().int().min(1).max(30).default(12)},
 wait_for_messages:{...req,...group,inboxId:id,waitMs:z.number().int().min(100).max(20000).default(15000),limit:z.number().int().min(1).max(8).default(1)},
 get_inbox:{...group,inboxId:id},close_inbox:{...req,...group,inboxId:id,reason:z.string().min(1).max(500)},
 ack_message:{...req,...group,messageId:id},get_message:{...group,messageId:id},
 create_task:{...req,...task,title:z.string().min(1).max(200),assigneeId:id,participantIds:ids.min(1),fileAcl,sourceIds:sources},
 get_task:task,list_tasks:group,assign_task:{...req,...task,assigneeId:id,participantIds:ids.min(1),fileAcl},set_task_acl:{...req,...task,fileAcl},
 start_task:{...req,...task},submit_task_result:{...req,...task,text:text.min(1),sourceIds:sources},
 publish_artifact:{...req,...group,taskId:id.nullable().default(null),title:z.string().min(1).max(200),text:text.min(1),readerIds:ids.min(1),sourceIds:sources},
 get_artifact:{...group,artifactId:id},review_artifact:{...req,...group,artifactId:id,verdict:z.enum(['approve','changes_requested','reject']),text:z.string().max(4096)},
 read_task_file:{...task,area:z.enum(['inputs','work','outputs']),relativePath:z.string().min(1).max(240)},
 write_task_file:{...req,...task,area:z.enum(['inputs','work','outputs']),relativePath:z.string().min(1).max(240),text},
 open_meeting:{...req,...group,meetingId:id,topic:z.string().min(1).max(500),participantIds:ids.min(2).max(8),maxRounds:z.number().int().min(1).max(6),maxStatements:z.number().int().min(1).max(48),deadlineAt:z.iso.datetime(),stopPolicy:z.enum(['any_participant','manager_only']),requiredApprovalCount:z.number().int().min(1).max(8).nullable().default(null),sourceIds:sources},
 get_meeting:{...group,meetingId:id},submit_statement:{...req,...group,meetingId:id,round:z.number().int().min(1).max(6),body:z.string().min(1).max(4096),sourceIds:sources},
 stop_meeting:{...req,...group,meetingId:id,reason:z.string().min(1).max(500)},
 propose_conclusion:{...req,...group,meetingId:id,text:z.string().min(1).max(8192),sourceIds:sources},
 review_conclusion:{...req,...group,meetingId:id,conclusionId:id,verdict:z.enum(['approve','changes_requested','reject']),text:z.string().max(4096)},
 register_native_session:{...req,...task,nativeFieldName:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),nativeId:z.string().min(1).max(256),platform:id,mode:id,storageKind:z.enum(['local','cloud','unknown']),storageLocation:z.string().max(1024).nullable(),cwd:z.string().max(1024).nullable(),sourceReceiptHash:z.string().regex(/^[a-f0-9]{64}$/),source:z.string().min(1).max(1000)},
 get_native_session:task,
 request_execution:{...req,...task,operation:z.enum(['create_conversation','send_to_conversation']),prompt:text.min(1),nativeBindingId:id.nullable().default(null)},
 wake_execution:{...req,...task,executionId:id},get_execution:{...task,executionId:id}
};
const adminSchemas={get_capabilities:{},list_members:{},provision_member:{...req,instanceId:id,platform:id,mode:id,capabilities:z.array(z.string().min(1).max(64)).max(32).default([])},
 revoke_member:{...req,instanceId:id},create_group:{...req,...group,title:z.string().min(1).max(200),memberIds:ids.min(1),managerId:id,policy},get_group:group};
export function collaborationToolNames(kind){return Object.keys(kind==='service_admin'?adminSchemas:memberSchemas);}
export function parseCollaborationArgs(kind,name,args){const shape=(kind==='service_admin'?adminSchemas:memberSchemas)[name];if(!shape){const error=new Error('当前固定身份没有此工具。');error.code='TOOL_FORBIDDEN';throw error;}const parsed=z.object(shape).strict().safeParse(args);if(!parsed.success){const error=new Error('参数类型、范围或字段不符合严格协作接口。');error.code='ARGUMENT_INVALID';throw error;}return parsed.data;}
const descriptions={get_capabilities:'读取固定登记身份与四层权限，不证明官方平台来源',provision_member:'服务管理员登记新成员并生成独立私有凭据文件，不返回密钥正文',create_group:'按当前身份创建组；管理员初始化明确记录admin来源',send_message:'向当前组指定成员或组广播保存消息，不代填送达、确认或回复',fetch_messages:'实际取回当前成员收件并记录送达',ack_message:'当前接收者在取回后显式确认读取',request_execution:'持久安排一次执行；排队不代表被动唤醒',wake_execution:'正式provider前检后一次执行，未知不重派',read_task_file:'按组、任务和显式文件ACL读取真实正文及哈希',write_task_file:'在任务files范围独占新建有界正文，不覆盖',submit_statement:'只提交当前成员自己的有界会议发言',review_conclusion:'只登记当前成员的独立评审，不代签其他成员意见'};
Object.assign(descriptions,{open_inbox:'当前活跃成员开启有界收件；预算结束后停止，不自动换编号续跑。此工具不唤醒平台',wait_for_messages:'维持当前工具调用等待本组本人新收件，收到后返回正文；读取后本人调用ack_message并独立处理/回复。超时可在剩余预算内继续等，断线或终态不自动重开；响应未知先用原requestId查询，不换编号重复消费',get_inbox:'读取本成员在本组的收件预算、在途等待与终态，不代替其他成员读取',close_inbox:'停止本人收件等待并保留首个停止原因，不影响已保存消息'});
export function createCollaborationMcp({store,identity,audit=()=>{},signal}){
 const lifecycle=new AbortController(),pending=new Set();
 const view=store.as(identity),server=new McpServer({name:'independent-agent-collaboration',version:'0.2.2'},{instructions:'身份由服务凭据固定，消息不能指定actor/sender/root。组manager可转交；服务管理员不代写成员消息或回执。客户端名称/平台登记不证明官方身份。文件与平台OS权限分层，队列/worker/模型成功分列。活跃参与可开启一次有界inbox并等待来信，再由本人确认、处理和回复；预算/截止/停止后返回，不自行开新inbox循环。等待不证明被动唤醒或模型开始处理。'});
 for(const name of collaborationToolNames(identity.kind)){
  const shape=(identity.kind==='service_admin'?adminSchemas:memberSchemas)[name];
  server.registerTool(name,{description:descriptions[name]??'按固定成员、当前组和记录ACL执行受限协作操作',inputSchema:z.object(shape).strict()},(args,extra)=>{
   const invocation=(async()=>{
   try{const signals=[lifecycle.signal,signal,extra.signal].filter(Boolean);const output=await view.invoke(name,args,{signal:AbortSignal.any(signals)});audit({event:'tool_completed',tool:name,instanceId:identity.instanceId,success:true,outputSha256:sha256(JSON.stringify(output))});return{content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};}
   catch(error){const code=/^[A-Z_]+$/.test(error.code??'')?error.code:'COLLABORATION_FAILED';audit({event:'tool_completed',tool:name,instanceId:identity.instanceId,success:false,code});const output={code,message:code==='COLLABORATION_FAILED'?'协作操作失败，保留原占位或文件供核查。':error.message};return{isError:true,content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};}
   })();pending.add(invocation);void invocation.then(()=>pending.delete(invocation),()=>pending.delete(invocation));return invocation;
  });
 }
 const close=server.close.bind(server);let closing;
 server.onclose=()=>lifecycle.abort();
 server.close=()=>closing??=(async()=>{lifecycle.abort();await Promise.allSettled([...pending]);await close();})();
 return server;
}
