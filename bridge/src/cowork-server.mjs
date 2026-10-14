import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { CoworkFileStore } from './cowork-store.mjs';
import { attachStdioAudit } from './stdio-audit.mjs';
import { sanitizeSessionValue } from './claude-code-adapter.mjs';

const { values } = parseArgs({ options: { role: { type: 'string', default: 'claude' }, 'audit-log': { type: 'string' } } });
const store = new CoworkFileStore({ role: values.role });
const server = new McpServer({ name: 'claude-cowork-file-bridge', version: '0.1.5' }, { instructions: '身份固定 claude。本桥仅写派单文件、读取固定输出和审核文件版本，不创建、唤醒或续接平台会话。Cowork须使用正式文件工具在授权任务目录执行；文件存在和自报环境不能证明真实来源。没有官方会话编号时保持 null，目录与文件权限和操作系统隔离分别保持未验证。' });
const requestId = z.string().min(1).max(128), taskId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const tools = [
  ['get_cowork_capabilities', '读取文件桥及平台会话、目录和来源的独立验证状态', {}, () => store.capabilities()],
  ['submit_cowork_task', '持久占位后写任务输入，不启动或自动派发平台任务', { requestId, taskId, title: z.string().min(1).max(200), instructions: z.string().min(1).max(32768), acceptance: z.array(z.string().min(1).max(2000)).min(1).max(20), textInputs: z.array(z.object({ name: z.string().min(1).max(64), text: z.string().max(65536) }).strict()).max(10).default([]) }, args => store.submitTask(args)],
  ['get_cowork_task', '读回已登记输入及哈希、结果版本和审核状态，不扫描旧聊天', { taskId }, args => store.getTask(args)],
  ['read_cowork_result', '只读取固定 outputs/result.md，并保存真实不可覆盖版本快照', { requestId, taskId }, args => store.readResult(args)],
  ['submit_cowork_review', '只审核明确读回的最新版本和SHA256；通过不等于平台来源通过', { requestId, taskId, version: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/), verdict: z.enum(['passed', 'rework']), basis: z.string().min(1).max(8000) }, args => store.submitReview(args)]
];
for (const [name, description, shape, handler] of tools) server.registerTool(name, { description, inputSchema: z.object(shape).strict() }, async args => {
  try { const output = await handler(args); return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }; }
  catch (error) { const output = { code: error.code ?? 'COWORK_OPERATION_FAILED', message: sanitizeSessionValue(error.message), conversationId: null, completePlatformLoopVerified: false }; return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }; }
});
const transport = new StdioServerTransport();
attachStdioAudit(transport, { file: values['audit-log'], toolNames: tools.map(([name]) => name) });
await server.connect(transport); process.once('exit', () => store.close());
console.error('Claude/Cowork 文件桥已启动；平台会话控制与真实执行来源未验证。');
