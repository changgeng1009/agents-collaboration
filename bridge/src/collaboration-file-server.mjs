import path from 'node:path';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { CollaborationStore } from './collaboration-store.mjs';
import { executionFiles } from './collaboration-execution.mjs';
import { readBoundedFile, SESSION_FILE_TOOLS } from './session-files.mjs';
import { attachCodeBuddyAudit, taskAuditPath } from './codebuddy-audit.mjs';

const{values}=parseArgs({options:{'binding-file':{type:'string'},'audit-log':{type:'string'}}});
const cwd=process.cwd(),auditFile=taskAuditPath(values['audit-log'],cwd,{mustExist:false}),expected=path.join(cwd,'inputs','session-control',path.basename(path.dirname(auditFile)),'file-binding.json');
if(values['binding-file']!==expected)throw new Error('文件租约必须来自本轮固定绑定。');
const binding=JSON.parse(readBoundedFile(expected).bytes.toString('utf8'));
const store=new CollaborationStore({dbPath:binding.collaboration.dbPath}),files=executionFiles(store,binding.collaboration.executionId,binding.collaboration.token);
if(binding.workspace.cwd!==cwd)throw new Error('文件进程 cwd 与原任务绑定不符。');
const server=new McpServer({name:'collaboration-task-file-lease',version:'0.2.0'}),shape={area:z.enum(['inputs','work','outputs']),relativePath:z.string().min(1).max(240)};
for(const[name,fields,handler]of[['get_capabilities',{},()=>files.capabilities()],['read_task_file',shape,args=>files.read(args)],['write_task_file',{...shape,text:z.string().max(32768)},args=>files.write(args)]])server.registerTool(name,{description:'仅按当前执行租约和实时组任务ACL操作本任务files，不授予消息或成员身份',inputSchema:z.object(fields).strict()},async args=>{
 try{const output=handler(args);return{content:[{type:'text',text:JSON.stringify(output)}],structuredContent:output};}catch(error){return{isError:true,content:[{type:'text',text:JSON.stringify({code:error.code??'FILE_LEASE_FAILED',message:'文件租约、范围或当前权限不符合要求。'})}]};}
});
const transport=new StdioServerTransport(),audit=attachCodeBuddyAudit(transport,{file:auditFile,cwd,toolNames:SESSION_FILE_TOOLS});await server.connect(transport);
process.once('exit',()=>{audit.close();store.close();});
