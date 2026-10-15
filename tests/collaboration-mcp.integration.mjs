import { FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { startCollaborationService } from '../bridge/src/collaboration-service.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const checks=[],clients=[],logDir=path.join(FIXTURE_ROOT,'logs','collaboration-mcp-tests');fs.mkdirSync(logDir,{recursive:true});let service,seq=0;
const check=(name,fn)=>{fn();checks.push({name,passed:true});};
const decode=result=>result.structuredContent??JSON.parse(result.content[0].text);
async function connect(key){const peer=new Client({name:'self_reported_agent_name_is_not_identity_proof',version:'0.2.0'});clients.push(peer);await peer.connect(new StreamableHTTPClientTransport(new URL(service.service.endpoint),{requestInit:{headers:{Authorization:`Bearer ${key}`}}}));return peer;}
async function call(peer,name,args={},error=null){const response=await peer.callTool({name,arguments:{...(name.startsWith('get_')||name.startsWith('list_')||name==='read_task_file'?{}:{requestId:`mcp_${++seq}`}),...args}});if(error){assert.equal(response.isError,true);if(error!=='*')assert.equal(decode(response).code,error);checks.push({name:`MCP拒绝 ${name}/${error}`,passed:true});return;}assert.notEqual(response.isError,true,JSON.stringify(response));return decode(response);}
try{
 service=await startCollaborationService({port:0});const adminKey=fs.readFileSync(service.service.adminKeyFile,'utf8'),admin=await connect(adminKey);
 const adminList=await admin.listTools();check('服务admin不注册成员发言、ACK、会议、任务执行工具',()=>{for(const tool of['send_message','ack_message','submit_statement','review_conclusion','wake_execution'])assert.equal(adminList.tools.some(item=>item.name===tool),false);});
 const wbRegistration=await call(admin,'provision_member',{instanceId:'wb_fixture',platform:'workbuddy',mode:'desktop'}),dbRegistration=await call(admin,'provision_member',{instanceId:'db_fixture',platform:'doubao',mode:'desktop'}),outsiderRegistration=await call(admin,'provision_member',{instanceId:'other_fixture',platform:'other',mode:'local'});
 check('MCP仅返回独立私有凭据路径，普通结果不返回token',()=>{assert.equal(wbRegistration.token,undefined);assert.equal(wbRegistration.credential,undefined);assert.ok(wbRegistration.credentialFile);});
 const wbKey=fs.readFileSync(wbRegistration.credentialFile,'utf8'),dbKey=fs.readFileSync(dbRegistration.credentialFile,'utf8'),wb=await connect(wbKey),db=await connect(dbKey),other=await connect(fs.readFileSync(outsiderRegistration.credentialFile,'utf8'));
 const wbCaps=await call(wb,'get_capabilities');check('平台登记和客户端名都不升级身份或依赖Codex',()=>{assert.equal(wbCaps.identity.instanceId,'wb_fixture');assert.equal(wbCaps.identity.platformVerified,false);assert.equal(wbCaps.requiresCodexRuntime,false);assert.equal(wbCaps.platformOsIsolationVerified,false);});
 await call(admin,'create_group',{groupId:'pair_group',title:'无Codex成员的两客户端',memberIds:['wb_fixture','db_fixture'],managerId:'wb_fixture',policy:{allowMemberTakeover:true}});
 await call(admin,'create_group',{groupId:'other_group',title:'另一组',memberIds:['other_fixture'],managerId:'other_fixture',policy:{allowMemberTakeover:true}});
 const input={values:[13,17,19]},sent=await call(wb,'send_message',{groupId:'pair_group',recipientIds:['db_fixture'],body:JSON.stringify(input)});
 check('真实HTTP保存消息仍无代填送达',()=>assert.equal(sent.message.deliveries.db_fixture.deliveredAt,null));
 await call(wb,'send_message',{groupId:'pair_group',recipientIds:['db_fixture'],body:'不能覆盖身份',actor:'db_fixture'},'*');
 await call(db,'ack_message',{groupId:'pair_group',messageId:sent.message.messageId},'FETCH_REQUIRED');
 const inbox=await call(db,'fetch_messages',{groupId:'pair_group'});await call(db,'ack_message',{groupId:'pair_group',messageId:sent.message.messageId});
 const total=JSON.parse(inbox.messages[0].body).values.reduce((sum,value)=>sum+value,0);
 const reply=await call(db,'send_message',{groupId:'pair_group',recipientIds:['wb_fixture'],body:JSON.stringify({total,inputHash:sha256(Buffer.from(inbox.messages[0].body))}),replyTo:sent.message.messageId,sourceIds:[{kind:'message',id:sent.message.messageId}]});
 const replies=await call(wb,'fetch_messages',{groupId:'pair_group'});
 check('两独立HTTP凭据实际计算和回传，非预填模型结果',()=>{const body=JSON.parse(replies.messages.find(message=>message.messageId===reply.message.messageId).body);assert.equal(body.total,49);assert.equal(body.inputHash,sha256(Buffer.from(JSON.stringify(input))));});
 const stages=await call(wb,'get_message',{groupId:'pair_group',messageId:sent.message.messageId});check('HTTP四阶段来自各自工具调用',()=>{const receipt=stages.message.deliveries.db_fixture;for(const field of['storedAt','deliveredAt','acknowledgedAt','repliedAt'])assert.ok(receipt[field]);});
 await call(other,'get_message',{groupId:'other_group',messageId:sent.message.messageId},'MESSAGE_FORBIDDEN');
 await call(other,'get_group',{groupId:'pair_group'},'GROUP_FORBIDDEN');
 await call(wb,'create_task',{groupId:'pair_group',taskId:'text_task',title:'实际MCP文件任务',assigneeId:'db_fixture',participantIds:['wb_fixture','db_fixture'],fileAcl:{readers:['db_fixture'],writers:['db_fixture'],inputWriters:['db_fixture']}});
 await call(db,'write_task_file',{groupId:'pair_group',taskId:'text_task',area:'inputs',relativePath:'source.txt',text:'实际MCP中文😀'});
 const read=await call(db,'read_task_file',{groupId:'pair_group',taskId:'text_task',area:'inputs',relativePath:'source.txt'});check('HTTP组任务文件实际传输及hash',()=>assert.equal(read.sha256,sha256(Buffer.from('实际MCP中文😀'))));
 await call(wb,'read_task_file',{groupId:'pair_group',taskId:'text_task',area:'inputs',relativePath:'source.txt'},'FILE_ACL_FORBIDDEN');
 await call(db,'write_task_file',{groupId:'pair_group',taskId:'text_task',area:'outputs',relativePath:'../outside.txt',text:'拒绝'},'FILE_PATH_FORBIDDEN');
 await call(db,'start_task',{groupId:'pair_group',taskId:'text_task'});const submitted=await call(db,'submit_task_result',{groupId:'pair_group',taskId:'text_task',text:'本人提交，不是已验业务成功'});
 check('成员接受/提交不自动形成模型或业务成功',()=>{assert.equal(submitted.task.businessCompletedVerified,false);assert.equal(submitted.artifact.businessCompletedVerified,false);assert.equal(submitted.task.agentReported.state,'result_submitted');});
 const intent=await call(db,'request_execution',{groupId:'pair_group',taskId:'text_task',operation:'create_conversation',nativeBindingId:null,prompt:'无正式接口不执行'}),blocked=await call(db,'wake_execution',{groupId:'pair_group',taskId:'text_task',executionId:intent.execution.executionId});
 check('HTTP默认正式豆包契约阻塞、没有worker或模型',()=>{assert.equal(blocked.execution.state,'blocked');assert.equal(blocked.execution.blocker.code,'DOUBAO_CONTRACT_UNAVAILABLE');assert.equal(blocked.execution.workerStarted,false);assert.equal(blocked.execution.platformProcessStarted,false);assert.equal(blocked.execution.verifiedStages.modelStarted,false);});
 const shared=await call(wb,'publish_artifact',{groupId:'pair_group',title:'可发现成果',text:'有作者的共享文本',readerIds:['wb_fixture','db_fixture']});
 await call(wb,'transfer_manager',{groupId:'pair_group',memberId:'db_fixture'});await wb.close();
 const withoutFirst=await call(db,'get_group_context',{groupId:'pair_group'});check('原客户端断线不阻断另一成员发现状态/成果',()=>{assert.equal(withoutFirst.group.managerId,'db_fixture');assert.ok(withoutFirst.artifacts.some(item=>item.artifactId===shared.artifact.artifactId));assert.equal(withoutFirst.group.members.wb_fixture.state,'active');});
 await call(db,'leave_group',{groupId:'pair_group'});const wbReturned=await connect(wbKey);await call(wbReturned,'claim_manager',{groupId:'pair_group'});
 check('经理明确退出后授权成员经HTTP接续职责',()=>assert.equal((service.store.get('group','pair_group')).managerId,'wb_fixture'));
 const audit=fs.readFileSync(service.audit.file,'utf8');check('服务审计无原始key/正文/自报客户端名',()=>{for(const key of[adminKey,wbKey,dbKey])assert.equal(audit.includes(key),false);assert.equal(audit.includes('实际MCP中文'),false);assert.equal(audit.includes('self_reported_agent_name'),false);});
 const summary={status:'passed',checks,source:'isolated_http_mcp_clients_not_official_agents',fixtureRoot:FIXTURE_ROOT,officialPlatformCalls:0,modelExecutions:0,actualCodexApplicationClosed:false,logDir};fs.writeFileSync(path.join(logDir,'summary.json'),JSON.stringify(summary,null,2),'utf8');console.log(JSON.stringify({status:'passed',checks:checks.length,summaryPath:path.join(logDir,'summary.json'),officialPlatformCalls:0},null,2));
}catch(error){fs.writeFileSync(path.join(logDir,'failure.json'),JSON.stringify({message:error.message,code:error.code,stack:error.stack,checks},null,2),'utf8');console.error(error);process.exitCode=1;}finally{await Promise.allSettled(clients.map(client=>client.close()));if(service)await service.close();}
