import { CODE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, ARTIFACT_ROOT, LOG_ROOT, sha256 } from '../bridge/src/policy.mjs';

const packaging = JSON.parse(fs.readFileSync(path.join(LOG_ROOT, 'extension-package-manifest.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(packaging.unpacked, 'manifest.json'), 'utf8'));
// 扩展属于保留的兼容通道，独立于新协作核心的发行版本。
const sourceVersion = JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'bridge', 'manifest.json'), 'utf8')).version;
assert.equal(manifest.version, sourceVersion, '历史包不能作为当前源码隔离测试对象。');
assert.equal(manifest.server.mcp_config.env?.COLLAB_PROJECT_ROOT, '${user_config.project_root}', '包必须支持显式授权根。');
const command = manifest.server.mcp_config.command.replace('${user_config.node_executable}', process.execPath);
const argv = manifest.server.mcp_config.args.map(arg => arg.replace('${__dirname}', packaging.unpacked));
const runId = randomUUID();
const logFile = path.join(LOG_ROOT, 'extension-smoke-wire.jsonl');
fs.writeFileSync(logFile, '', 'utf8');
const version = spawnSync(command, ['--version'], { encoding: 'utf8', windowsHide: true });
assert.equal(version.status, 0); assert.ok(Number(version.stdout.trim().split('.')[0].slice(1)) >= 24);
const children = [];
function client(executable, args, role) {
  const child = spawn(executable, args, { windowsHide: true, env: { ...process.env, COLLAB_PROJECT_ROOT: PROJECT_ROOT }, stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  let nextId = 1; const pending = new Map();
  const log = (direction, message) => fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), role, direction, message }) + '\n', 'utf8');
  child.stderr.on('data', bytes => fs.appendFileSync(path.join(LOG_ROOT, `extension-smoke-${role}-stderr.txt`), bytes));
  child.once('exit', code => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(`进程退出 ${code}`)); } pending.clear(); });
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line); log('server_to_client', message); const p = pending.get(message.id); if (p) { clearTimeout(p.timer); pending.delete(message.id); message.error ? p.reject(new Error(JSON.stringify(message.error))) : p.resolve(message.result); } });
  const request = (method, params) => {
    const id = nextId++;
    const promise = new Promise((resolve, reject) => { const timer = setTimeout(() => { pending.delete(id); reject(new Error(`超时 ${method}`)); }, 15000); pending.set(id, { resolve, reject, timer }); });
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    log('client_to_server', message); child.stdin.write(JSON.stringify(message) + '\n', 'utf8'); return promise;
  };
  return { child, request, async init() {
    const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: '解包产物验收客户端', version: '0.1.0' } });
    const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' }; log('client_to_server', initialized); child.stdin.write(JSON.stringify(initialized) + '\n', 'utf8'); return result;
  }, async call(name, args = {}) { const result = await request('tools/call', { name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result)); return name === 'get_artifact' ? result : result.structuredContent ?? JSON.parse(result.content[0].text); } };
}
try {
  // Claude 侧严格使用解包后 manifest 的实际 command/args，无 db/角色附加覆盖。
  const claude = client(command, argv, 'claude-manifest');
  await claude.init(); const tools = await claude.request('tools/list'); assert.equal(tools.tools.length, 12);
  const capabilities = await claude.call('get_capabilities'); assert.equal(capabilities.role, 'claude');
  const codex = client(command, [path.join(CODE_ROOT, 'bridge', 'src', 'server.mjs'), '--role', 'codex'], 'codex-local-fixture'); await codex.init();
  const assigned = await claude.call('submit_task', { requestId: `${runId}-submit`, title: '解包扩展本地验收', goal: '读取实际版本文本；不是 Claude 真实账号调用。', acceptance: ['文本逐字一致'], inputs: [] });
  const taskId = assigned.task.taskId;
  await codex.call('read_messages', { requestId: `${runId}-inbox`, taskId, unreadOnly: true });
  await codex.call('ack_message', { requestId: `${runId}-ack`, messageId: assigned.message.messageId });
  await codex.call('start_task', { requestId: `${runId}-start`, taskId });
  const dir = path.join(ARTIFACT_ROOT, 'extension-smoke', runId); fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'result.txt'); fs.writeFileSync(filePath, '解包扩展：实际中文产物读取通过。\n', 'utf8');
  const artifact = await codex.call('register_artifact', { requestId: `${runId}-artifact`, taskId, artifactId: `extension_${runId.replaceAll('-', '')}`, version: 1, filePath, mimeType: 'text/plain', origin: '解包扩展离线进程测试' });
  await codex.call('complete_task', { requestId: `${runId}-complete`, taskId, summary: '解包扩展本地内容读取', artifacts: [{ artifactId: artifact.artifact.artifactId, version: 1 }], execution: { executionId: `smoke-${runId}`, kind: 'local_validation', sessionId: null, usage: 'unknown' } });
  const read = await claude.call('get_artifact', { artifactId: artifact.artifact.artifactId, version: 1 });
  assert.equal(read.content[1].text, fs.readFileSync(filePath, 'utf8'));
  assert.equal(sha256(Buffer.from(read.content[1].text, 'utf8')), artifact.artifact.sha256);
  const report = { status: 'passed', at: new Date().toISOString(), runId, command, argv, nodeVersion: version.stdout.trim(), manifestSha256: sha256(fs.readFileSync(path.join(packaging.unpacked, 'manifest.json'))),
    packageSha256: packaging.packageSha256, packagePath: packaging.packagePath, unpacked: packaging.unpacked, taskId, artifact: artifact.artifact,
    tested: ['解包包内 SDK/依赖加载', '按 manifest command/args 启动', 'initialize', 'tools/list', '任务派发', '对端取回及读取确认', '真实中文文件登记/读取'],
    realClaudeInstalled: false, realClaudeAccountCall: false, modelRequestsStarted: 0, wireLog: logFile };
  fs.writeFileSync(path.join(LOG_ROOT, 'extension-smoke-summary.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ status: report.status, command, argv, nodeVersion: report.nodeVersion, taskId }, null, 2));
} finally {
  await Promise.all(children.map(child => new Promise(resolve => { if (child.exitCode !== null) return resolve(); const timer = setTimeout(() => child.kill(), 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.stdin.end(); })));
}
