import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {PROJECT_ROOT,inside,fail} from './policy.mjs';
import {sessionPath,readBoundedFile} from './session-files.mjs';
import {preparedRootIdentity} from './collaboration-workspaces.mjs';
import {collaborationToolSchema,parseCollaborationArgs} from './collaboration-tools.mjs';
import {attachCodeBuddyAudit,taskAuditPath} from './codebuddy-audit.mjs';
import {MARKET_TASK_TOOLS,MARKET_EXPERT_MODE} from './market-expert-adapter.mjs';

export function assertMarketCoreIdentity(caps,binding){const match=/^(\d+)\.(\d+)\.(\d+)$/.exec(caps.version??'');if(caps.channel!=='independent-collaboration'||!match||Number(match[1])===0&&(Number(match[2])<2||Number(match[2])===2&&Number(match[3])<3))fail('MARKET_CORE_VERSION_UNREVIEWED','独立core版本须至少为本轮0.2.3；旧版本不能承载此候选。');if(caps.identity?.kind!=='member'||caps.identity.instanceId!==binding.instanceId||caps.identity.platform!=='codebuddy'||caps.identity.mode!==MARKET_EXPERT_MODE)fail('MARKET_IDENTITY_MISMATCH','凭据不是此任务登记的CodeBuddy市场专家本人。');}

export async function invokeMarketTask(binding,name,args,{signal}={}){
 if(!MARKET_TASK_TOOLS.includes(name))fail('MARKET_TOOL_FORBIDDEN','不允许此工具。');const parsed=parseCollaborationArgs('member',name,args),current=preparedRootIdentity(binding.cwd);
 if(Object.keys(current).some(key=>current[key]!==binding.cwdIdentity?.[key]))fail('MARKET_CWD_CHANGED','原任务目录身份变化。');
 if(name!=='get_capabilities'&&(parsed.groupId!==binding.groupId||parsed.taskId!==binding.taskId))fail('MARKET_TASK_FORBIDDEN','仅允许原组原任务。');
 if(name==='read_task_file'&&(parsed.area!=='inputs'||!binding.inputPaths.includes(parsed.relativePath)))fail('MARKET_INPUT_FORBIDDEN','只允许manager审查的必要输入。');
 const url=new URL(binding.endpoint);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/mcp'||url.search||url.hash||url.username||url.password||!url.port||[18761,18762,18763].includes(Number(url.port)))fail('MARKET_ENDPOINT_INVALID','仅连接审查的本机独立core。');
 if(!inside(path.join(PROJECT_ROOT,'bridge','runtime','collaboration-core'),binding.credentialFile)||/admin-key/i.test(path.basename(binding.credentialFile)))fail('MARKET_MEMBER_INVALID','只能读取本人core成员凭据。');
 const key=readBoundedFile(binding.credentialFile,128).bytes.toString('utf8').trim();if(!/^[A-Za-z0-9_-]{43}$/.test(key))fail('MARKET_MEMBER_INVALID','成员凭据格式无效。');
 const client=new Client({name:'restricted_market_task_proxy',version:'0.2.4'});
 try{await client.connect(new StreamableHTTPClientTransport(url,{requestInit:{headers:{Authorization:`Bearer ${key}`}}}));const call=async(toolName,argumentsValue)=>{const result=await client.callTool({name:toolName,arguments:argumentsValue},undefined,{signal,timeout:15000});if(result.isError||!result.structuredContent)fail('MARKET_CORE_REJECTED','core拒绝本次请求，保留原requestId，不自动重发。');return result.structuredContent;};
  const caps=await call('get_capabilities',{});assertMarketCoreIdentity(caps,binding);
  if(name==='get_capabilities')return{identity:caps.identity,tools:MARKET_TASK_TOOLS,groupId:binding.groupId,taskId:binding.taskId,modelExecutionVerified:false,osIsolationVerified:false};
  const task=await call('get_task',{groupId:binding.groupId,taskId:binding.taskId});if(task.task?.taskRoot!==binding.cwd||task.task.assigneeId!==binding.instanceId)fail('MARKET_TASK_BINDING_CHANGED','core原任务cwd或负责人改变。');
  if(!task.task.fileAcl?.readers.includes(binding.instanceId)||!task.task.fileAcl?.writers.includes(binding.instanceId))fail('MARKET_TASK_ACL_REQUIRED','本人任务必要文件读写ACL尚未就绪或已撤销。');
  return name==='get_task'?task:await call(name,parsed);
 }finally{await client.close();}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const{values}=parseArgs({options:{'binding-file':{type:'string'},'audit-log':{type:'string'}}}),cwd=process.cwd(),auditFile=taskAuditPath(values['audit-log'],cwd,{mustExist:false}),turnId=path.basename(path.dirname(auditFile));
 const expected=path.join(cwd,'inputs','market-control',turnId,'member-binding.json');if(values['binding-file']!==expected)fail('MARKET_BINDING_INVALID','只接受当前轮固定任务代理配置。');const binding=JSON.parse(readBoundedFile(expected,16384).bytes);if(binding.cwd!==cwd)fail('MARKET_CWD_CHANGED','代理cwd与原任务不同。');
 const server=new McpServer({name:'restricted-market-task',version:'0.2.4'});for(const name of MARKET_TASK_TOOLS)server.registerTool(name,{description:'仅按当前凭据读取本人原任务/必要输入或提交本人处理记录；无管理员与跨任务权限。',inputSchema:collaborationToolSchema('member',name)},async(args,extra)=>{try{const output=await invokeMarketTask(binding,name,args,{signal:extra.signal});return{content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};}catch(error){const output={code:/^[A-Z_]+$/.test(error.code??'')?error.code:'MARKET_PROXY_FAILED',message:'原任务、身份、ACL或工具范围不符合要求；不自动重试。'};return{isError:true,content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};}});
 const transport=new StdioServerTransport(),audit=attachCodeBuddyAudit(transport,{file:auditFile,cwd,toolNames:MARKET_TASK_TOOLS});await server.connect(transport);process.once('exit',()=>audit.close());
}
