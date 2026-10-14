import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { StreamableHTTPClientTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { TaskLoopStore, TASK_LOOP_ROOT } from '../bridge/src/task-loop-store.mjs';
import { startTaskExecutor } from '../bridge/src/task-loop-server.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const logDir = path.join(FIXTURE_ROOT, 'logs', 'task-loop-tests'); fs.mkdirSync(logDir, { recursive: true });
const checks = [], peers = [], services = [], stores = [];
const dbPath = path.join(TASK_LOOP_ROOT, 'tasks.sqlite');
const check = (name, action) => { action(); checks.push({ name, passed: true }); };
const expected = (name, action, code) => check(name, () => assert.throws(action, error => error.code === code));
const openStore = (actor, taskId = null) => { const store = new TaskLoopStore({ actor, taskId, dbPath }); stores.push(store); return store; };
const decode = value => value.structuredContent ?? JSON.parse(value.content[0].text);
async function call(client, name, args = {}, errorCode = null) {
  const value = await client.callTool({ name, arguments: args });
  if (errorCode) { assert.equal(value.isError, true); if (errorCode !== '*') assert.equal(decode(value).code, errorCode); checks.push({ name: `${name} 拒绝 ${errorCode}`, passed: true }); return; }
  assert.notEqual(value.isError, true, JSON.stringify(value)); return decode(value);
}
async function managerClient(label) {
  const client = new Client({ name: `local_test_${label}_not_platform`, version: '0.1.0' }); peers.push(client);
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(CODE_ROOT, 'bridge', 'src', 'task-loop-server.mjs'), '--actor', 'manager', '--transport', 'stdio'],
    env: { ...getDefaultEnvironment(), COLLAB_PROJECT_ROOT: FIXTURE_ROOT, COLLAB_TEST_MODE: '1' }, stderr: 'pipe' });
  transport.stderr.on('data', chunk => fs.appendFileSync(path.join(logDir, `${label}-stderr.txt`), chunk));
  await client.connect(transport); return client;
}
async function executorClient(service) {
  const client = new Client({ name: 'local_test_self_reported_doubao_is_not_proof', version: '0.1.0' }); peers.push(client);
  const key = fs.readFileSync(service.service.privateKeyFile, 'utf8');
  await client.connect(new StreamableHTTPClientTransport(new URL(service.service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
  return { client, key };
}
function raw(service, key, message, headers = {}) {
  const bytes = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
  return new Promise((resolve, reject) => {
    const req = http.request(service.service.endpoint, { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', part => chunks.push(part)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    }); req.on('error', reject); req.end(bytes);
  });
}
const create = (taskId, assignee = 'doubao') => ({ requestId: `create_${taskId}`, taskId, assignee, body: `合成任务 ${taskId}：请提交一段中文文本。` });
const submission = (taskId, claim, text = '合成执行正文：离线验证文本领取、提交与独立文件读回。') => ({ requestId: `submit_${taskId}`, taskId, claimId: claim.claimId, claimToken: claim.claimToken, text });

try {
  const probeFile = path.join(CODE_ROOT, 'bridge', 'src', 'doubao-http-probe.mjs'), probeHash = sha256(fs.readFileSync(probeFile));
  const manager = await managerClient('manager_first');
  const managerTools = await manager.listTools();
  check('manager stdio 仅三个闭环工具且版本一致', () => { assert.deepEqual(managerTools.tools.map(tool => tool.name).sort(), ['create_task', 'get_capabilities', 'get_task_result']); assert.equal(manager.getServerVersion().version, JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'bridge', 'package.json'), 'utf8')).version); });
  const created = await call(manager, 'create_task', create('fixture_doubao'));
  await call(manager, 'create_task', create('fixture_workbuddy', 'workbuddy'));
  const duplicateCreate = await call(manager, 'create_task', create('fixture_doubao'));
  check('派单真实创建独立三目录并幂等', () => { assert.equal(duplicateCreate.deduplicated, true); for (const name of ['inputs', 'work', 'outputs']) assert.ok(fs.statSync(path.join(created.task.taskRoot, name)).isDirectory()); assert.equal(created.task.status, 'queued'); assert.equal(created.task.conversationId, null); });
  await call(manager, 'create_task', { ...create('fixture_doubao'), body: '不同内容' }, 'REQUEST_ID_CONFLICT');
  await call(manager, 'create_task', { ...create('fixture_doubao'), requestId: 'create_new_request' }, 'TASK_EXISTS');
  await call(manager, 'create_task', { ...create('invalid'), taskId: '../outside' }, '*');
  await call(manager, 'create_task', { ...create('fixture_extra'), root: FIXTURE_ROOT }, '*');
  await call(manager, 'create_task', { ...create('fixture_long'), body: '汉'.repeat(11000) }, 'TEXT_LIMIT');
  await call(manager, 'create_task', { ...create('fixture_unicode'), body: '\ud800' }, 'TEXT_LIMIT');
  const dbManager = openStore('manager');
  expected('拒绝设备名任务', () => dbManager.createTask(create('CON')), 'TASK_ID_INVALID');
  expected('拒绝启动角色混用', () => new TaskLoopStore({ actor: 'manager', taskId: 'fixture_doubao' }), 'STARTUP_BINDING_REQUIRED');
  expected('执行身份不可由属性改写', () => { dbManager.actor = 'doubao'; }, undefined);
  const doubao = await startTaskExecutor({ actor: 'doubao', taskId: 'fixture_doubao', port: 0 }); services.push(doubao);
  const buddy = await startTaskExecutor({ actor: 'workbuddy', taskId: 'fixture_workbuddy', port: 0 }); services.push(buddy);
  const doubaoPeer = await executorClient(doubao), buddyPeer = await executorClient(buddy);
  check('两个实例只监听 127.0.0.1 且使用不同端口与私有凭据', () => { assert.equal(doubao.server.address().address, '127.0.0.1'); assert.notEqual(doubao.service.port, buddy.service.port); assert.notEqual(doubaoPeer.key, buddyPeer.key); assert.notEqual(doubao.service.port, 18761); });
  const workerList = await doubaoPeer.client.listTools();
  check('执行实例精确三个受限工具', () => assert.deepEqual(workerList.tools.map(tool => tool.name).sort(), ['claim_task', 'get_capabilities', 'submit_task_result']));
  const caps = await call(doubaoPeer.client, 'get_capabilities');
  check('客户端自报豆包名称不升级身份或会话证据', () => { assert.equal(caps.actor, 'doubao'); assert.equal(caps.platformIdentityVerified, false); assert.equal(caps.conversationId, null); assert.equal(caps.reviewEnabled, false); assert.equal(caps.modelExecutionEnabled, false); assert.equal(caps.accountHistoryEnabled, false); });
  await call(doubaoPeer.client, 'get_capabilities', { actor: 'manager' }, '*');
  await call(doubaoPeer.client, 'claim_task', { requestId: 'wrong_task', taskId: 'fixture_workbuddy' }, 'TASK_BINDING_FORBIDDEN');
  const claimArgs = { requestId: 'claim_doubao', taskId: 'fixture_doubao' };
  const [claimed, repeatedClaim] = await Promise.all([call(doubaoPeer.client, 'claim_task', claimArgs), call(doubaoPeer.client, 'claim_task', claimArgs)]);
  check('重复并发领取只有一个持久凭据和租约', () => { assert.equal(claimed.claim.claimToken, repeatedClaim.claim.claimToken); assert.equal(claimed.task.status, 'in_progress'); assert.equal(claimed.body, create('fixture_doubao').body); assert.equal(claimed.inputSha256, sha256(Buffer.from(claimed.body))); });
  await call(doubaoPeer.client, 'claim_task', { ...claimArgs, requestId: 'claim_second' }, 'TASK_ALREADY_CLAIMED');
  const claimStore = openStore('doubao', 'fixture_doubao');
  check('另一个数据库连接读回同一领取凭据', () => assert.equal(claimStore.claimTask(claimArgs).claim.claimToken, claimed.claim.claimToken));
  const wrongActor = openStore('workbuddy', 'fixture_doubao');
  expected('固定另一角色不能冒领', () => wrongActor.claimTask({ requestId: 'wrong_actor', taskId: 'fixture_doubao' }), 'TASK_ACTOR_FORBIDDEN');
  expected('执行方不能审核式读取结果', () => claimStore.getTaskResult({ taskId: 'fixture_doubao' }), 'ROLE_FORBIDDEN');
  expected('执行方不能创建任务', () => claimStore.createTask(create('worker_create')), 'ROLE_FORBIDDEN');
  const submit = submission('fixture_doubao', claimed.claim);
  await call(doubaoPeer.client, 'submit_task_result', { ...submit, claimToken: 'A'.repeat(43) }, 'CLAIM_FORBIDDEN');
  await call(doubaoPeer.client, 'submit_task_result', { ...submit, path: path.join(FIXTURE_ROOT, 'forbidden.txt') }, '*');
  await call(doubaoPeer.client, 'submit_task_result', { ...submit, text: '汉'.repeat(11000) }, 'TEXT_LIMIT');
  await call(doubaoPeer.client, 'submit_task_result', { ...submit, text: '\ud800' }, 'TEXT_LIMIT');
  const submitted = await call(doubaoPeer.client, 'submit_task_result', submit);
  const repeated = await call(doubaoPeer.client, 'submit_task_result', submit);
  const sameWithNewRequest = await call(doubaoPeer.client, 'submit_task_result', { ...submit, requestId: 'submit_same_new_request' });
  check('提交真实文件且相同正文幂等，不重复覆盖', () => { assert.equal(submitted.task.status, 'submitted'); assert.equal(repeated.deduplicated, true); assert.equal(sameWithNewRequest.deduplicated, true); assert.equal(fs.readFileSync(submitted.result.filePath, 'utf8'), submit.text); });
  await call(doubaoPeer.client, 'submit_task_result', { ...submit, text: '不同正文' }, 'REQUEST_ID_CONFLICT');
  await call(doubaoPeer.client, 'submit_task_result', { ...submit, requestId: 'submit_changed', text: '不同正文' }, 'RESULT_CONFLICT');
  await manager.close();
  const secondManager = await managerClient('manager_restarted');
  const readback = await call(secondManager, 'get_task_result', { taskId: 'fixture_doubao' });
  check('新 manager stdio 进程从真实文件独立读回正文和哈希', () => { assert.equal(readback.result.text, submit.text); assert.equal(readback.result.sha256, sha256(Buffer.from(submit.text))); assert.equal(readback.result.readbackVerified, true); assert.equal(readback.result.conversationId, null); assert.equal(readback.result.platformIdentityVerified, false); assert.equal(readback.task.claim.claimToken, undefined); });
  const buddyClaim = await call(buddyPeer.client, 'claim_task', { requestId: 'claim_workbuddy', taskId: 'fixture_workbuddy' });
  await call(buddyPeer.client, 'submit_task_result', submission('fixture_workbuddy', buddyClaim.claim));
  check('WorkBuddy 与豆包执行绑定分离', () => assert.notEqual(buddyClaim.claim.claimToken, claimed.claim.claimToken));

  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  for (const [name, service, key, message, headers, status, code] of [
    ['无凭据', doubao, null, rpc, {}, 401, 'LOCAL_AUTH_REQUIRED'],
    ['跨部署凭据', buddy, doubaoPeer.key, rpc, {}, 401, 'LOCAL_AUTH_REQUIRED'],
    ['非法 Host', doubao, doubaoPeer.key, rpc, { Host: 'localhost' }, 403, 'INVALID_HOST'],
    ['非法 Origin', doubao, doubaoPeer.key, rpc, { Origin: 'https://untrusted.example' }, 403, 'INVALID_ORIGIN'],
    ['禁止文件资源', doubao, doubaoPeer.key, { ...rpc, method: 'resources/read' }, {}, 403, 'RPC_SCOPE_FORBIDDEN'],
    ['禁止 manager 工具', doubao, doubaoPeer.key, { ...rpc, method: 'tools/call', params: { name: 'create_task', arguments: {} } }, {}, 403, 'TOOL_SCOPE_FORBIDDEN'],
    ['禁止命令工具', doubao, doubaoPeer.key, { ...rpc, method: 'tools/call', params: { name: 'run_command', arguments: {} } }, {}, 403, 'TOOL_SCOPE_FORBIDDEN'],
    ['禁止 JSON 批量', doubao, doubaoPeer.key, [rpc], {}, 403, 'RPC_SCOPE_FORBIDDEN'],
    ['拒绝无效 UTF8', doubao, doubaoPeer.key, Buffer.from([123, 255, 125]), {}, 400, 'INVALID_JSON'],
    ['请求体有界', doubao, doubaoPeer.key, Buffer.alloc(256 * 1024 + 1, 65), {}, 413, 'BODY_TOO_LARGE']
  ]) { const value = await raw(service, key, message, headers); check(name, () => { assert.equal(value.status, status); assert.equal(value.body.code, code); }); }
  await assert.rejects(startTaskExecutor({ actor: 'doubao', taskId: 'fixture_doubao', port: 18761 }), error => error.code === 'PORT_INVALID');
  checks.push({ name: '旧 18761 端口不能用于新通道', passed: true });

  for (const id of ['fixture_expired', 'fixture_unknown', 'fixture_input_tamper', 'fixture_junction', 'fixture_hardlink']) dbManager.createTask(create(id));
  const expiredStore = openStore('doubao', 'fixture_expired'), expiryArgs = { requestId: 'claim_expired', taskId: 'fixture_expired' };
  const expiredClaim = expiredStore.claimTask(expiryArgs);
  const expiringTask = dbManager.task('fixture_expired'); expiringTask.claim.leaseExpiresAt = new Date(0).toISOString(); dbManager.transaction(() => dbManager.put(expiringTask));
  expected('过期租约不能提交', () => expiredStore.submitTaskResult(submission('fixture_expired', expiredClaim.claim)), 'LEASE_EXPIRED');
  expected('过期原领取不能自动续租', () => expiredStore.claimTask(expiryArgs), 'LEASE_EXPIRED');
  expected('过期任务不能换请求重领', () => expiredStore.claimTask({ ...expiryArgs, requestId: 'claim_expired_new' }), 'TASK_ALREADY_CLAIMED');
  check('过期租约仍保留原占位', () => assert.equal(dbManager.task('fixture_expired').claim.claimId, expiredClaim.claim.claimId));
  const unknownStore = openStore('doubao', 'fixture_unknown'), unknownClaim = unknownStore.claimTask({ requestId: 'claim_unknown', taskId: 'fixture_unknown' });
  const unknownFile = path.join(dbManager.task('fixture_unknown').taskRoot, 'outputs', 'result.txt'); fs.writeFileSync(unknownFile, '原有证据不覆盖', 'utf8');
  expected('固定输出文件已存在导致提交失败', () => unknownStore.submitTaskResult(submission('fixture_unknown', unknownClaim.claim)), 'EEXIST');
  const reopenedUnknown = openStore('doubao', 'fixture_unknown');
  check('失败占位跨连接持久保存为 unknown 且原文件保留', () => { assert.equal(dbManager.getTaskResult({ taskId: 'fixture_unknown' }).task.status, 'unknown'); assert.equal(fs.readFileSync(unknownFile, 'utf8'), '原有证据不覆盖'); });
  const unknownFromOtherProcess = await call(secondManager, 'get_task_result', { taskId: 'fixture_unknown' });
  check('另一 manager 进程读回 unknown，不伪造正文', () => { assert.equal(unknownFromOtherProcess.task.status, 'unknown'); assert.equal(unknownFromOtherProcess.result, null); });
  expected('unknown 原请求不自动重写', () => reopenedUnknown.submitTaskResult(submission('fixture_unknown', unknownClaim.claim)), 'TASK_UNKNOWN');
  expected('unknown 不重新领取', () => reopenedUnknown.claimTask({ requestId: 'claim_unknown_new', taskId: 'fixture_unknown' }), 'TASK_UNKNOWN');
  fs.mkdirSync(path.join(FIXTURE_ROOT, 'task-workspaces', 'fixture_existing')); const existingBody = create('fixture_existing');
  expected('未登记同名目录不接管', () => dbManager.createTask(existingBody), 'EEXIST');
  expected('创建失败原请求不重做', () => dbManager.createTask(existingBody), 'TASK_UNKNOWN');
  const tamperedTask = dbManager.task('fixture_input_tamper'); fs.appendFileSync(path.join(tamperedTask.taskRoot, 'inputs', 'task.txt'), '变更', 'utf8');
  expected('输入正文篡改不能领取', () => openStore('doubao', 'fixture_input_tamper').claimTask({ requestId: 'claim_input_bad', taskId: 'fixture_input_tamper' }), 'LOOP_CONTENT_MISMATCH');
  const linked = dbManager.task('fixture_junction'), externalDirectory = fs.mkdtempSync(path.join(path.dirname(FIXTURE_ROOT), 'loop-outside-'));
  fs.renameSync(path.join(linked.taskRoot, 'inputs'), path.join(linked.taskRoot, 'inputs-preserved')); fs.symlinkSync(externalDirectory, path.join(linked.taskRoot, 'inputs'), 'junction');
  expected('越界目录联接不能领取', () => openStore('doubao', 'fixture_junction').claimTask({ requestId: 'claim_junction', taskId: 'fixture_junction' }), 'REALPATH_OUTSIDE_SCOPE');
  const hardStore = openStore('doubao', 'fixture_hardlink'), hardClaim = hardStore.claimTask({ requestId: 'claim_hard', taskId: 'fixture_hardlink' });
  const hardResult = hardStore.submitTaskResult(submission('fixture_hardlink', hardClaim.claim));
  fs.linkSync(hardResult.result.filePath, path.join(dbManager.task('fixture_hardlink').taskRoot, 'work', 'alias.txt'));
  expected('多硬链接结果不能通过独立读回', () => dbManager.getTaskResult({ taskId: 'fixture_hardlink' }), 'LOOP_FILE_INVALID');
  fs.appendFileSync(readback.result.filePath, '正文篡改', 'utf8');
  await call(secondManager, 'get_task_result', { taskId: 'fixture_doubao' }, 'LOOP_CONTENT_MISMATCH');
  await call(doubaoPeer.client, 'submit_task_result', submit, 'LOOP_CONTENT_MISMATCH');

  dbManager.createTask(create('fixture_bom'));
  const bomStore = openStore('doubao', 'fixture_bom'), bomClaim = bomStore.claimTask({ requestId: 'claim_bom', taskId: 'fixture_bom' });
  const bomText = '\uFEFF合成正文😀\r\n保留开头字符和行尾。';
  bomStore.submitTaskResult(submission('fixture_bom', bomClaim.claim, bomText));
  check('UTF8 正文保留开头 U+FEFF、补充字符及 CRLF', () => assert.equal(dbManager.getTaskResult({ taskId: 'fixture_bom' }).result.text, bomText));
  dbManager.createTask(create('fixture_restart'));
  const beforeRestart = await startTaskExecutor({ actor: 'doubao', taskId: 'fixture_restart', port: 0 });
  const beforePeer = await executorClient(beforeRestart), restartArgs = { requestId: 'claim_restart', taskId: 'fixture_restart' };
  const beforeClaim = await call(beforePeer.client, 'claim_task', restartArgs);
  await beforePeer.client.close(); await beforeRestart.close();
  const afterRestart = await startTaskExecutor({ actor: 'doubao', taskId: 'fixture_restart', port: 0 }); services.push(afterRestart);
  const afterPeer = await executorClient(afterRestart), afterClaim = await call(afterPeer.client, 'claim_task', restartArgs);
  check('执行服务重启保留原租约和领取凭据，独立轮换传输身份', () => { assert.equal(afterClaim.claim.claimToken, beforeClaim.claim.claimToken); assert.equal(afterClaim.claim.claimId, beforeClaim.claim.claimId); assert.notEqual(afterPeer.key, beforePeer.key); });
  await call(afterPeer.client, 'claim_task', { ...restartArgs, requestId: 'claim_after_restart_new' }, 'TASK_ALREADY_CLAIMED');
  await call(afterPeer.client, 'submit_task_result', submission('fixture_restart', afterClaim.claim));
  const restartResult = await call(secondManager, 'get_task_result', { taskId: 'fixture_restart' });
  check('服务重启后只以原领取继续提交并由独立进程读回', () => assert.equal(restartResult.result.readbackVerified, true));

  const audit = fs.readFileSync(doubao.service.auditFile, 'utf8'), records = audit.trim().split('\n').map(line => JSON.parse(line));
  check('HTTP 审计含 initialize/list/call 与工具完成关联', () => { for (const method of ['initialize', 'tools/list', 'tools/call']) assert.ok(records.some(record => record.rpcMethod === method)); assert.ok(records.some(record => record.tool === 'submit_task_result' && record.success === true)); assert.ok(records.filter(record => record.event === 'tool_completed').every(record => record.correlationId)); });
  check('审计不泄漏 Bearer、领取凭据或正文', () => { for (const secret of [doubaoPeer.key, claimed.claim.claimToken, submit.text, create('fixture_doubao').body]) assert.equal(audit.includes(secret), false); assert.ok(records.every(record => record.clientInfoIsSelfReported === true)); });
  check('旧只读探针源码保持一致', () => assert.equal(sha256(fs.readFileSync(probeFile)), probeHash));
  const summary = { status: 'passed', checks, fixtureRoot: FIXTURE_ROOT, source: 'local_test_not_official_platform', officialModelsStarted: 0, officialClientsUsed: 0,
    oldProbeRequests: 0, localFixtureHttpOnly: true, realPlatformIdentityVerified: false, conversationId: null, dbPath, executorAuditFiles: services.map(service => service.service.auditFile), logDir };
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, summaryPath: path.join(logDir, 'summary.json'), officialModelsStarted: 0, realPlatformIdentityVerified: false }, null, 2));
} catch (error) {
  fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, fixtureRoot: FIXTURE_ROOT, source: 'local_test' }, null, 2), 'utf8'); console.error(error); process.exitCode = 1;
} finally { await Promise.allSettled(peers.map(client => client.close())); await Promise.allSettled(services.map(service => service.close())); for (const store of stores) { try { store.close(); } catch { /* 已关闭的隔离测试连接无需再次处理。 */ } } }
