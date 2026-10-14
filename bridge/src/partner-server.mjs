import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { PartnerStore } from './partner-store.mjs';
import { redact } from './policy.mjs';
import { registerSessionTools, SESSION_TOOL_NAMES } from './session-tools.mjs';
import { attachStdioAudit } from './stdio-audit.mjs';

const { values } = parseArgs({ options: { role: { type: 'string' }, db: { type: 'string' }, 'audit-log': { type: 'string' } } });
const store = new PartnerStore({ role: values.role, ...(values.db ? { dbPath: values.db } : {}) });
const server = new McpServer({ name: 'local-partner-channel', version: '0.1.6' }, { instructions: '固定伙伴身份。原伙伴消息和文本工具无执行、审核、发布或唤醒权限；读取须显式确认，manager ACK 只能由其工具写入。独立会话控制默认关闭，平台模式、目录与文件/操作系统边界分别查看 get_session_capabilities。' });
const id = z.string().min(1).max(128);
const artifactId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const version = z.number().int().positive();
const request = { requestId: id };
const tools = [
  ['get_capabilities', '读取固定身份、独立数据库范围和关闭的执行权限', {}, () => store.capabilities()],
  ['send_message', '实际写入发给另一伙伴的消息或回复，不自动构造 ACK', { ...request, recipient: z.enum(['manager', 'workbuddy']), body: z.string().min(1).max(32768), replyTo: id.nullable().default(null) }, args => store.sendMessage(args)],
  ['read_messages', '取回当前角色收件箱，只登记送达', { ...request, unreadOnly: z.boolean().default(true) }, args => store.readMessages(args)],
  ['ack_message', '接收角色实际确认已读一条已送达消息', { ...request, messageId: id }, args => store.ackMessage(args)],
  ['get_message', '读取已知编号的消息及双方状态', { messageId: id }, args => store.getMessage(args)],
  ['put_text_artifact', '创建当前角色的不可覆盖 UTF-8 文本版本，不接受任意文件路径', { ...request, artifactId, version, text: z.string().min(1).max(32768), messageId: id.nullable().default(null) }, args => store.putTextArtifact(args)],
  ['get_text_artifact', '读回指定文本版本的实际正文并核对内容哈希', { artifactId, version }, args => store.getTextArtifact(args)]
];
for (const [name, description, shape, handler] of tools) server.registerTool(name, { description, inputSchema: z.object(shape).strict() }, async args => {
  try { const output = await handler(args); return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }; }
  catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code ?? 'OPERATION_FAILED', message: redact(error.message) }) }] }; }
});
const transport = new StdioServerTransport();
const sessionTools = registerSessionTools(server, { actor: store.role });
attachStdioAudit(transport, { file: values['audit-log'], toolNames: [...tools.map(([name]) => name), ...SESSION_TOOL_NAMES] });
await server.connect(transport);
console.error(`伙伴通道已启动，固定角色=${store.role}；独立会话状态另查能力，审核与发布保持关闭。`);
process.once('exit', () => { store.close(); sessionTools.close(); });
