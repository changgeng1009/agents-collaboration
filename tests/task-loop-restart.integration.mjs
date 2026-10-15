import { FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { TaskLoopStore, TASK_LOOP_ROOT } from '../bridge/src/task-loop-store.mjs';
import { startTaskExecutor } from '../bridge/src/task-loop-server.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const checks = [], services = [], clients = [];
const dbPath = path.join(TASK_LOOP_ROOT, 'tasks.sqlite');
const manager = new TaskLoopStore({ actor: 'manager', dbPath });
const check = (name, fn) => { fn(); checks.push(name); };
const rejected = async (name, args, code) => {
  await assert.rejects(startTaskExecutor(args), error => error.code === code);
  checks.push(name);
};
async function peer(service, key) {
  const client = new Client({ name: 'local_test_restart_not_platform', version: '0.1.0' }); clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(service.service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return client;
}
const decode = value => value.structuredContent ?? JSON.parse(value.content[0].text);
const logDir = path.join(FIXTURE_ROOT, 'logs', 'restart-tests'); fs.mkdirSync(logDir, { recursive: true });
try {
  manager.createTask({ requestId: 'create_restart', taskId: 'fixture_restart', assignee: 'workbuddy', body: '合成任务：服务恢复后仍保留原正文。' });
  const original = await startTaskExecutor({ actor: 'workbuddy', taskId: 'fixture_restart', port: 0, dbPath }); services.push(original);
  const oldKey = fs.readFileSync(original.service.privateKeyFile, 'utf8');
  const worker = new TaskLoopStore({ actor: 'workbuddy', taskId: 'fixture_restart', dbPath });
  const claim = worker.claimTask({ requestId: 'claim_restart', taskId: 'fixture_restart' });
  worker.submitTaskResult({ requestId: 'submit_restart', taskId: 'fixture_restart', claimId: claim.claim.claimId, claimToken: claim.claim.claimToken, text: '合成结果：只恢复连接，不重复执行。' }); worker.close();
  const before = manager.getTaskResult({ taskId: 'fixture_restart' });
  const originals = [original.serviceFile, original.service.privateKeyFile, before.result.filePath].map(file => ({ file, hash: sha256(fs.readFileSync(file)) }));
  const args = { actor: 'workbuddy', taskId: 'fixture_restart', port: original.service.port, dbPath, resumeServiceFile: original.serviceFile };
  await original.close(); services.splice(services.indexOf(original), 1);
  await assert.rejects(fetch(original.service.endpoint), error => error.cause?.code === 'ECONNREFUSED'); checks.push('关闭服务真实复现 ECONNREFUSED');
  const resumed = await startTaskExecutor(args); services.push(resumed);
  const client = await peer(resumed, oldKey);
  check('原连接器凭据恢复，无需重填', () => assert.equal(fs.readFileSync(resumed.service.privateKeyFile, 'utf8'), oldKey));
  check('恢复必须登记原部署和新部署', () => { assert.equal(resumed.service.resumedFromDeploymentId, original.service.deploymentId); assert.notEqual(resumed.service.deploymentId, original.service.deploymentId); assert.equal(resumed.service.credentialResumed, true); });
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ['claim_task', 'get_capabilities', 'submit_task_result']);
  checks.push('恢复后工具仍精确三个');
  const caps = decode(await client.callTool({ name: 'get_capabilities', arguments: {} }));
  check('角色和任务固定，未升级平台身份证据', () => { assert.equal(caps.actor, 'workbuddy'); assert.equal(caps.taskId, 'fixture_restart'); assert.equal(caps.platformIdentityVerified, false); });
  const after = manager.getTaskResult({ taskId: 'fixture_restart' });
  check('原提交状态和正文哈希保持一致', () => { assert.equal(after.task.status, 'submitted'); assert.equal(after.result.sha256, before.result.sha256); assert.equal(after.result.text, before.result.text); });
  check('原服务、密钥和输出文件未覆盖', () => originals.forEach(entry => assert.equal(sha256(fs.readFileSync(entry.file)), entry.hash)));
  await rejected('仍在监听的端口不能启动第二实例', args, 'EADDRINUSE');
  for (const [label, changed] of [['角色', { actor: 'doubao' }], ['任务', { taskId: 'fixture_other' }], ['端口', { port: 0 }], ['数据库', { dbPath: path.join(TASK_LOOP_ROOT, 'other.sqlite') }]]) {
    await rejected(`恢复不能改变${label}`, { ...args, ...changed }, 'RESUME_BINDING_MISMATCH');
  }
  const metadata = JSON.parse(fs.readFileSync(original.serviceFile, 'utf8'));
  fs.writeFileSync(original.serviceFile, JSON.stringify({ ...metadata, toolNames: [...metadata.toolNames, 'create_task'] }));
  await rejected('篡改工具范围拒绝恢复', args, 'RESUME_BINDING_MISMATCH');
  fs.writeFileSync(original.serviceFile, JSON.stringify(metadata));
  fs.linkSync(original.service.privateKeyFile, path.join(path.dirname(original.service.privateKeyFile), 'hardlink.txt'));
  await rejected('多硬链接密钥拒绝恢复', args, 'RESUME_FILE_INVALID');
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({ status: 'passed', checks, fixtureRoot: FIXTURE_ROOT, officialModelsStarted: 0, officialClientsUsed: 0, source: 'local_test_not_platform' }, null, 2));
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, summaryPath: path.join(logDir, 'summary.json'), officialModelsStarted: 0 }));
} catch (error) {
  fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ code: error.code, message: error.message, checks }, null, 2)); console.error(error); process.exitCode = 1;
} finally { await Promise.allSettled(clients.map(client => client.close())); await Promise.allSettled(services.map(service => service.close())); manager.close(); }
