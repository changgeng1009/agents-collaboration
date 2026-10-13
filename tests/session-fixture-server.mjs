import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { McpServer } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { StdioServerTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { ClaudeCodeTextAdapter } from '../bridge/src/claude-code-adapter.mjs';
import { SessionController } from '../bridge/src/session-store.mjs';
import { registerSessionTools } from '../bridge/src/session-tools.mjs';

if (process.env.COLLAB_TEST_MODE !== '1') throw new Error('协议进程仅限显式隔离测试。');
const { values } = parseArgs({ options: { role: { type: 'string', default: 'manager' }, behavior: { type: 'string', default: 'normal' } } });
const adapter = new ClaudeCodeTextAdapter({ enabled: true, acceptedProductMode: true, nodeExecutable: process.execPath,
  cliScript: fileURLToPath(new URL('./session-protocol-fixture.mjs', import.meta.url)), timeoutMs: 1200, maxOutputBytes: 4096 });
adapter.evidenceLevel = 'local_test';
const server = new McpServer({ name: 'local_session_fixture_not_platform', version: '0.1.4' });
const controller = new SessionController({ actor: values.role, testAdapter: adapter,
  testHooks: values.behavior === 'crash_after_claim' ? { afterClaim: () => process.exit(91) } : {} });
const registered = registerSessionTools(server, { actor: values.role, controllerFactory: () => controller });
const transport = new StdioServerTransport();
await server.connect(transport);
process.once('exit', () => { registered.close(); });
