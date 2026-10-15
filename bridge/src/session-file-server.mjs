import path from 'node:path';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { SessionFiles, SESSION_FILE_TOOLS, readBoundedFile } from './session-files.mjs';
import { attachCodeBuddyAudit, taskAuditPath } from './codebuddy-audit.mjs';
import { sanitizeCodeBuddyValue } from './codebuddy-cli-adapter.mjs';

const { values } = parseArgs({ options: { 'binding-file': { type: 'string' }, 'audit-log': { type: 'string' } } });
const cwd = process.cwd(), auditPath = taskAuditPath(values['audit-log'], cwd, { mustExist: false });
const expected = path.join(cwd, 'inputs', 'session-control', path.basename(path.dirname(auditPath)), 'file-binding.json');
if (values['binding-file'] !== expected) throw new Error('文件工具绑定必须来自本轮专用启动配置。');
const binding = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBoundedFile(expected).bytes));
if (binding.workspace.cwd !== cwd) throw new Error('文件工具 cwd 与任务绑定不一致。');
const files = new SessionFiles(binding);
const server = new McpServer({ name: 'task-bound-file-tools', version: '0.1.9' });
const fields = { area: z.enum(['inputs', 'work', 'outputs']), relativePath: z.string().min(1).max(240) };
const tools = [
  ['get_capabilities', {}, () => ({ version: '0.1.9', role: 'workbuddy', taskId: binding.workspace.taskId, tools: SESSION_FILE_TOOLS, fileContentReadEnabled: true, fileContentWriteEnabled: true,
    scope: 'task_area_files_only', inputsReadOnly: true, accountQueryEnabled: false, shellEnabled: false, modelExecutionEnabled: false, workerOsIsolationVerified: false, platformOsIsolationVerified: false })],
  ['read_task_file', fields, args => files.read(args)],
  ['write_task_file', { ...fields, text: z.string().max(32768) }, args => files.write(args)]
];
for (const [name, shape, handler] of tools) server.registerTool(name, { description: name === 'get_capabilities' ? '读取任务限定文件范围与未验收的 OS 层状态' : '只操作本任务 inputs/work/outputs 各自 files 子目录内有界文本，不覆盖已有文件', inputSchema: z.object(shape).strict() }, async args => {
  try { const output = handler(args); return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code ?? 'FILE_OPERATION_FAILED', message: sanitizeCodeBuddyValue(error.message) }) }] }; }
});
const transport = new StdioServerTransport();
const audit = attachCodeBuddyAudit(transport, { file: auditPath, cwd, toolNames: SESSION_FILE_TOOLS });
await server.connect(transport);
process.once('exit', () => audit.close());
