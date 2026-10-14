import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BRIDGE_ROOT, PROJECT_ROOT, guardedPath } from '../src/policy.mjs';
import { PARTNER_ARTIFACT_ROOT } from '../src/partner-store.mjs';

const { values } = parseArgs({ options: { role: { type: 'string', default: 'manager' }, tool: { type: 'string' }, 'args-file': { type: 'string' } } });
if (!['manager', 'workbuddy'].includes(values.role) || !values.tool) throw new Error('必须指定有效伙伴身份和工具名。');
const args = values['args-file'] ? JSON.parse(fs.readFileSync(guardedPath(PARTNER_ARTIFACT_ROOT, values['args-file']), 'utf8')) : {};
const client = new Client({ name: 'local-partner-tool-client', version: '0.1.5' });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(BRIDGE_ROOT, 'src', 'partner-server.mjs'), '--role', values.role],
  env: { ...getDefaultEnvironment(), COLLAB_PROJECT_ROOT: PROJECT_ROOT } });
try { await client.connect(transport); const result = await client.callTool({ name: values.tool, arguments: args }); console.log(JSON.stringify(result, null, 2)); if (result.isError) process.exitCode = 1; }
finally { await client.close(); }
