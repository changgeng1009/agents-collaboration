import * as z from 'zod/v4';
import { SessionController } from './session-store.mjs';
import { sanitizeSessionValue } from './claude-code-adapter.mjs';
import { SessionDispatcher } from './session-dispatch.mjs';

export const SESSION_TOOL_NAMES = ['get_session_capabilities', 'prepare_task_workspace', 'create_conversation', 'send_to_conversation', 'read_conversation', 'get_conversation_result'];
export const MANAGER_SESSION_TOOL_NAMES = ['enqueue_session_execution', 'wake_session_execution', 'get_session_dispatch', 'read_task_file', 'write_task_file'];

export function registerSessionTools(server, { actor, controllerFactory = () => new SessionController({ actor }) }) {
  let controller;
  const get = () => controller ??= controllerFactory();
  let dispatcher;
  const dispatch = () => dispatcher ??= new SessionDispatcher({ controller: get() });
  const id = z.string().min(1).max(128), taskId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
  const platform = z.enum(['claude', 'workbuddy', 'doubao']), mode = z.string().min(1).max(64);
  const binding = { taskId, platform, mode, conversationId: z.string().min(1).max(256).nullable() };
  const prompt = z.string().min(1).max(32768);
  const definitions = [
    ['get_session_capabilities', '按明确平台与产品模式读取会话、目录与权限各自验证状态，不自动切换', { platform: platform.optional(), mode: mode.optional() }, args => get().capabilities(args)],
    ['prepare_task_workspace', '创建当前角色任务专用 inputs/work/outputs；不会创建平台会话', { requestId: id, taskId }, args => get().prepareTaskWorkspace(args)],
    ['create_conversation', '默认关闭；仅在明确授权模式中持久占位后创建原生会话', { requestId: id, taskId, platform, mode, prompt }, args => get().createConversation(args)],
    ['send_to_conversation', '仅向本控制器创建且任务、原始编号和目录均匹配的会话续发一次', { requestId: id, ...binding, conversationId: binding.conversationId.unwrap(), prompt }, args => get().sendToConversation(args)],
    ['read_conversation', '只读当前任务捕获的平台事件，不扫描账户历史；未知创建用 null 编号查询', binding, args => get().readConversation(args)],
    ['get_conversation_result', '读取捕获的轮次终态、结果和证据；exit 0 不代替业务验收', binding, args => get().getConversationResult(args)]
  ];
  if (actor === 'manager') definitions.push(
    ['enqueue_session_execution', '只持久入队，不代表已唤醒；后续一次受管执行须显式调用唤醒工具', { requestId: id, taskId, platform, mode, operation: z.enum(['create_conversation', 'send_to_conversation']), conversationId: binding.conversationId, prompt }, args => dispatch().enqueue(args)],
    ['wake_session_execution', '在正式模式/入口/任务绑定前检后只启动一次受管执行；未知不自动补发', { requestId: id, dispatchId: id }, args => dispatch().wake(args)],
    ['get_session_dispatch', '读取入队、阻塞、worker、平台启动与终态各自证据；owner退出或租约到期保留未知', { dispatchId: id }, args => dispatch().get(args)],
    ['read_task_file', '读取本任务区域 files 子目录的实际有界正文与哈希，不读取运行证据或账号', { taskId, area: z.enum(['inputs', 'work', 'outputs']), relativePath: z.string().min(1).max(240) }, ({ taskId, ...args }) => get().taskFiles(taskId).read(args)],
    ['write_task_file', 'manager 独占写入本任务 files 子目录并实际读回，拒绝覆盖和任意路径', { taskId, area: z.enum(['inputs', 'work', 'outputs']), relativePath: z.string().min(1).max(240), text: z.string().max(32768) }, ({ taskId, ...args }) => get().taskFiles(taskId).write(args)]
  );
  for (const [name, description, shape, handler] of definitions) server.registerTool(name, { description, inputSchema: z.object(shape).strict() }, async args => {
    try { const output = await handler(args); return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }; }
    catch (error) {
      const output = { code: error.code ?? 'SESSION_OPERATION_FAILED', message: sanitizeSessionValue(error.message), conversationId: null, ...(error.capability ? { capability: error.capability } : {}) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
  });
  return { close: () => controller?.close() };
}
