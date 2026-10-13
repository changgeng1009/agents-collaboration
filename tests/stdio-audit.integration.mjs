import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { sha256 } from '../bridge/src/policy.mjs';

const runId = randomUUID(), logDir = path.join(FIXTURE_ROOT, 'logs', 'audit-tests', runId);
fs.mkdirSync(logDir, { recursive: true });
const auditFile = path.join(logDir, 'observed.jsonl'), peers = [], checks = [];
const check = (name, callback) => { callback(); checks.push({ name, passed: true }); };
async function peer(label, file = null) {
  const client = new Client({ name: `local_audit_fixture_${label}_not_workbuddy`, version: '0.1.4' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(CODE_ROOT, 'bridge', 'src', 'partner-server.mjs'), '--role', 'workbuddy', ...(file ? ['--audit-log', file] : [])],
    cwd: FIXTURE_ROOT, env: { ...getDefaultEnvironment(), COLLAB_PROJECT_ROOT: FIXTURE_ROOT, COLLAB_TEST_MODE: '1' }, stderr: 'pipe' });
  transport.stderr.on('data', bytes => fs.appendFileSync(path.join(logDir, `${label}-stderr.txt`), bytes)); peers.push(client);
  await client.connect(transport, { timeout: 5000 }); return client;
}
try {
  const client = await peer('observed', auditFile); await client.listTools();
  await client.callTool({ name: 'get_capabilities', arguments: {} });
  const marker = `private_fixture_body_${randomUUID()}`;
  const parameters = { requestId: runId + '-message', recipient: 'manager', body: marker, replyTo: null };
  await client.callTool({ name: 'send_message', arguments: parameters });
  const rejected = await client.callTool({ name: 'send_message', arguments: { ...parameters, sender: 'manager' } }); assert.equal(rejected.isError, true);
  await client.close();
  const raw = fs.readFileSync(auditFile, 'utf8'), rows = raw.trim().split('\n').map(JSON.parse);
  check('仅实际到达本地测试进程的调用留痕并记录独立启动目录', () => { assert.ok(rows.some(row => row.method === 'initialize')); assert.ok(rows.some(row => row.method === 'tools/list')); assert.ok(rows.some(row => row.toolName === 'send_message')); assert.ok(rows.every(row => row.pid && row.parentPid && row.processCwd === FIXTURE_ROOT && row.projectRoot === FIXTURE_ROOT)); });
  check('审计保存参数与结果哈希，不保存正文', () => { assert.ok(!raw.includes(marker)); const incoming = rows.find(row => row.direction === 'client_to_server' && row.paramsSha256 === sha256(JSON.stringify({ name: 'send_message', arguments: parameters }))); assert.ok(incoming); assert.ok(rows.some(row => row.resultSha256?.length === 64)); });
  check('成功和结构化失败分别记录', () => { assert.ok(rows.some(row => row.success === true)); assert.ok(rows.some(row => row.success === false)); assert.ok(rows.every(row => row.clientInfo.name.startsWith('local_audit_fixture'))); });
  const disabled = await peer('disabled'); await disabled.listTools(); await disabled.close();
  check('无可信启动选项时审计默认关闭', () => assert.equal(fs.existsSync(path.join(FIXTURE_ROOT, 'logs', 'default-audit.jsonl')), false));
  await assert.rejects(() => peer('outside', path.join(FIXTURE_ROOT, 'outside.jsonl')));
  check('拒绝 logs 外的审计文件', () => assert.equal(fs.existsSync(path.join(FIXTURE_ROOT, 'outside.jsonl')), false));
  const otherDir = path.join(FIXTURE_ROOT, 'other'); fs.mkdirSync(otherDir); const linkDir = path.join(FIXTURE_ROOT, 'logs', 'linked'); fs.symlinkSync(otherDir, linkDir, 'junction');
  await assert.rejects(() => peer('linked', path.join(linkDir, 'audit.jsonl')));
  check('拒绝同项目目录联接审计路径', () => assert.equal(fs.existsSync(path.join(otherDir, 'audit.jsonl')), false));
  const summary = { status: 'passed', checks, source: 'local_test', realWorkBuddyVerified: false, modelStarts: 0, bodyRecorded: false, authenticationRead: false, auditFile };
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, summaryPath: path.join(logDir, 'summary.json'), realWorkBuddyVerified: false }, null, 2));
} catch (error) { fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks }, null, 2), 'utf8'); console.error(error); process.exitCode = 1; }
finally { await Promise.allSettled(peers.map(client => client.close())); }
