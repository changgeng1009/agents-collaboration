import path from 'node:path';
import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { Hub } from './store.mjs';
import { RUNTIME_ROOT, redact } from './policy.mjs';
import { registerSessionTools } from './session-tools.mjs';

const { values } = parseArgs({ options: { role: { type: 'string' }, db: { type: 'string' } } });
const role = values.role ?? process.env.COLLAB_ROLE;
const hub = new Hub({ role, dbPath: values.db ?? process.env.COLLAB_DB_PATH ?? path.join(RUNTIME_ROOT, 'hub.sqlite') });
const server = new McpServer({ name: 'ai-collaboration-t1', version: '0.1.9' }, { instructions: '中文协作。身份固定于本进程。原任务、消息、产物工具权限不变；普通消息不能通过审核。独立会话控制默认关闭；模式、目录与文件/操作系统边界分别查看 get_session_capabilities。不能把 Code 会话冒充普通桌面上下文。' });
const id = z.string().min(1).max(128);
const request = { requestId: id };
const ref = z.object({ artifactId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/), version: z.number().int().positive() }).strict();
const tools = [
  ['get_capabilities', '读取项目范围、角色、能力及真实连接边界', {}, () => hub.capabilities()],
  ['submit_task', 'Claude 派发唯一任务给 Codex；请求编号去重', { ...request, title: z.string().min(1).max(200), goal: z.string().min(1).max(16000), acceptance: z.array(z.string().min(1).max(2000)).min(1).max(20), inputs: z.array(ref).max(20).default([]) }, a => hub.submitTask(a)],
  ['get_task', '查询任务、产物版本、结果和审核记录', { taskId: id }, a => hub.getTask(a)],
  ['list_tasks', '读取当前项目任务清单', {}, () => hub.listTasks()],
  ['send_message', '发送问题、回复或说明；不改变审核状态', { ...request, taskId: id, recipient: z.enum(['claude', 'codex']), body: z.string().min(1).max(16000), kind: z.enum(['message', 'question', 'answer']).default('message'), replyTo: id.nullable().default(null) }, a => hub.sendMessage(a)],
  ['read_messages', '取回当前角色收件箱；只登记送达，读取另确认', { ...request, taskId: id.optional(), unreadOnly: z.boolean().default(true) }, a => hub.readMessages(a)],
  ['ack_message', '接收角色确认已读指定消息', { ...request, messageId: id }, a => hub.ackMessage(a)],
  ['start_task', 'Codex 在读取派单后登记开始任务', { ...request, taskId: id }, a => hub.startTask(a)],
  ['register_artifact', 'Codex 登记授权目录内的真实文件并保存不可覆盖版本快照', { ...request, taskId: id, artifactId: ref.shape.artifactId, version: ref.shape.version, filePath: z.string().min(1).max(1024), mimeType: z.enum(['text/plain', 'text/markdown', 'application/json', 'image/png', 'image/jpeg']), origin: z.string().min(1).max(1000) }, a => hub.registerArtifact(a)],
  ['get_artifact', '读取指定版本的真实文本或图片，并核对 SHA256', ref.shape, a => hub.getArtifact(a)],
  ['complete_task', 'Codex 提交执行记录及当前版本结果，进入待审核', { ...request, taskId: id, summary: z.string().min(1).max(8000), artifacts: z.array(ref).min(1).max(20), execution: z.object({ executionId: id, kind: z.enum(['local_validation', 'codex_exec']), sessionId: id.nullable(), usage: z.literal('unknown').or(z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict()) }).strict() }, a => hub.completeTask(a)],
  ['submit_review', '仅 Claude 审核当前版本；旧版本拒绝，普通消息无此权限', { ...request, ...ref.shape, verdict: z.enum(['passed', 'rework']), basis: z.string().min(1).max(8000) }, a => hub.submitReview(a)]
];
for (const [name, description, shape, handler] of tools) {
  server.registerTool(name, { description, inputSchema: z.object(shape).strict() }, async args => {
    try {
      const output = await handler(args);
      if (output.content) return output;
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: error.code ?? 'OPERATION_FAILED', message: redact(error.message) }) }] };
    }
  });
}
const transport = new StdioServerTransport();
const sessionTools = registerSessionTools(server, { actor: role });
transport.onclose = () => { hub.close(); sessionTools.close(); };
await server.connect(transport);
console.error(`协作桥已启动：role=${role}，仅 stdio，无自动模型请求。`);
