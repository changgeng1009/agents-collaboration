import * as z from 'zod/v4';
import { SessionController } from './session-store.mjs';
import { sanitizeSessionValue } from './claude-code-adapter.mjs';

export const SESSION_TOOL_NAMES = ['get_session_capabilities', 'prepare_task_workspace', 'create_conversation', 'send_to_conversation', 'read_conversation', 'get_conversation_result'];

export function registerSessionTools(server, { actor, controllerFactory = () => new SessionController({ actor }) }) {
  let controller;
  const get = () => controller ??= controllerFactory();
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
  for (const [name, description, shape, handler] of definitions) server.registerTool(name, { description, inputSchema: z.object(shape).strict() }, async args => {
    try { const output = await handler(args); return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }; }
    catch (error) {
      const output = { code: error.code ?? 'SESSION_OPERATION_FAILED', message: sanitizeSessionValue(error.message), conversationId: null, ...(error.capability ? { capability: error.capability } : {}) };
      return { isError: true, content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
  });
  return { close: () => controller?.close() };
}
