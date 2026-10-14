import { parseArgs } from 'node:util';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { attachCodeBuddyAudit } from './codebuddy-audit.mjs';

const { values } = parseArgs({ options: { 'audit-log': { type: 'string' } } });
if (!values['audit-log']) throw new Error('专用能力服务必须提供任务内审计路径。');
const server = new McpServer({ name: 'codebuddy-single-capability', version: '0.1.6' });
server.registerTool('get_capabilities', { description: '只读专用服务能力；不读取账号、文件正文、队列或平台聊天', inputSchema: z.object({}).strict() }, async () => {
  const output = { version: '0.1.6', role: 'workbuddy', productMode: 'codebuddy_cli', tools: ['get_capabilities'],
    permissions: ['read_static_capabilities'], taskExecutionEnabled: false, queueWriteEnabled: false, accountQueryEnabled: false,
    fileContentReadEnabled: false, desktopContextVerified: false, platformRuntimeVerified: false,
    fileAccessBoundaryVerified: false, osIsolationVerified: false, evidenceLevel: process.env.COLLAB_TEST_MODE === '1' ? 'local_test' : 'local_tool_response' };
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
});
const transport = new StdioServerTransport();
const audit = attachCodeBuddyAudit(transport, { file: values['audit-log'], cwd: process.cwd() });
await server.connect(transport);
process.once('exit', () => audit.close());
