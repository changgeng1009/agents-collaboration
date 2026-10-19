import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { startCollaborationService } from '../bridge/src/collaboration-service.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const checks = [], services = [], clients = [];
const logDir = path.join(FIXTURE_ROOT, 'logs', 'independent-service-tests'); fs.mkdirSync(logDir, { recursive: true });
const check = (name, fn) => { fn(); checks.push({ name, passed: true }); };
async function client(service, key) {
  const peer = new Client({ name: 'local_fixture_not_platform_client', version: '0.2.10' }); clients.push(peer);
  await peer.connect(new StreamableHTTPClientTransport(new URL(service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${key}` } } })); return peer;
}
function raw(endpoint, key, message, headers = {}, method = 'POST') {
  const bytes = Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message));
  return new Promise((resolve, reject) => {
    const req = http.request(endpoint, { method, headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', 'Content-Length': bytes.length, ...(key ? { Authorization: `Bearer ${key}` } : {}), ...headers } }, res => {
      const chunks = []; res.on('data', bytes => chunks.push(bytes)); res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); });
    }); req.on('error', reject); req.end(bytes);
  });
}
let childPid = null;
try {
  const service = await startCollaborationService({ port: 0 }); services.push(service);
  const key = fs.readFileSync(service.service.adminKeyFile, 'utf8');
  const peer = await client(service.service, key);
  check('独立 HTTP 初始化与精确版本', () => { assert.equal(peer.getServerVersion().version, '0.2.10'); assert.equal(service.server.address().address, '127.0.0.1'); assert.equal(service.service.codexModelRequired, false); assert.equal(service.service.codexApplicationClosedRuntimeVerified, false); });
  const tools = await peer.listTools();
  check('基础设施管理员工具已注册', () => assert.ok(tools.tools.length > 0));
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  for (const [name, auth, message, headers, method, status, code] of [
    ['匿名请求', null, rpc, {}, 'POST', 401, 'INSTANCE_AUTH_REQUIRED'],
    ['错误凭据', randomBytes(32).toString('base64url'), rpc, {}, 'POST', 401, 'INSTANCE_AUTH_REQUIRED'],
    ['Host 校验', key, rpc, { Host: 'localhost' }, 'POST', 403, 'INVALID_HOST'],
    ['Origin 校验', key, rpc, { Origin: 'https://example.invalid' }, 'POST', 403, 'INVALID_ORIGIN'],
    ['不提供 SSE GET', key, rpc, {}, 'GET', 405, 'POST_REQUIRED'],
    ['禁止批量 RPC', key, [rpc], {}, 'POST', 403, 'RPC_SCOPE_FORBIDDEN'],
    ['禁止文件资源入口', key, { ...rpc, method: 'resources/read' }, {}, 'POST', 403, 'RPC_SCOPE_FORBIDDEN'],
    ['RPC ID 不能带对象', key, { ...rpc, id: {} }, {}, 'POST', 403, 'RPC_SCOPE_FORBIDDEN'],
    ['UTF8 格式校验', key, Buffer.from([123, 255, 125]), {}, 'POST', 400, 'INVALID_JSON'],
    ['请求体有界', key, Buffer.alloc(256 * 1024 + 1, 65), {}, 'POST', 413, 'BODY_TOO_LARGE'],
    ['内容类型校验', key, rpc, { 'Content-Type': 'text/plain' }, 'POST', 415, 'CONTENT_TYPE_REQUIRED'],
    ['禁止未解码压缩体', key, rpc, { 'Content-Encoding': 'gzip' }, 'POST', 415, 'CONTENT_TYPE_REQUIRED']
  ]) { const reply = await raw(service.service.endpoint, auth, message, headers, method); check(name, () => { assert.equal(reply.status, status); assert.equal(reply.body.code, code); }); }
  for (const port of [18761, 18762, 18763]) {
    await assert.rejects(startCollaborationService({ port }), error => error.code === 'SERVICE_PORT_INVALID'); checks.push({ name: '独立服务不接管旧端口', passed: true });
  }
  const audit = fs.readFileSync(service.audit.file, 'utf8');
  check('传输审计保留握手并隐藏原凭据和正文', () => { assert.ok(audit.includes('initialize')); assert.equal(audit.includes(key), false); assert.equal(audit.includes('local_fixture_not_platform_client'), false); assert.ok(audit.includes('clientInfoIsSelfReported')); });
  const keyHash = sha256(fs.readFileSync(service.service.adminKeyFile)), oldPort = service.service.port;
  await peer.close(); await service.close(); services.splice(services.indexOf(service), 1);
  const reopened = await startCollaborationService({ port: oldPort }); services.push(reopened);
  const reconnected = await client(reopened.service, key); await reconnected.listTools();
  check('后台重启沿用独立管理员凭据且没有平台执行', () => { assert.equal(sha256(fs.readFileSync(reopened.service.adminKeyFile)), keyHash); assert.equal(reopened.service.automaticModelExecutionEnabled, false); });
  await reconnected.close(); await reopened.close(); services.splice(services.indexOf(reopened), 1);

  const selected = await startCollaborationService({ port: 0, reviewedCodeBuddyProvider: true }); services.push(selected);
  const operator = await client(selected.service, key);
  const invoke = async (peer, name, args) => {
    const result = await peer.callTool({ name, arguments: args }); assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  };
  const provisioned = await invoke(operator, 'provision_member', { requestId: 'provider_member', instanceId: 'provider_fixture', platform: 'workbuddy', mode: 'codebuddy_cli' });
  const participant = await client(selected.service, fs.readFileSync(provisioned.credentialFile, 'utf8'));
  await invoke(participant, 'create_group', { requestId: 'provider_group', groupId: 'provider_group', title: '正式模式门控样本', policy: { allowMemberTakeover: true } });
  await invoke(participant, 'create_task', { requestId: 'provider_task', groupId: 'provider_group', taskId: 'provider_task', title: '缺配置不得启动模型', assigneeId: 'provider_fixture', participantIds: ['provider_fixture'], fileAcl: { readers: ['provider_fixture'], writers: ['provider_fixture'], inputWriters: [] } });
  const queued = await invoke(participant, 'request_execution', { requestId: 'provider_request', groupId: 'provider_group', taskId: 'provider_task', operation: 'create_conversation', prompt: '仅离线检查默认禁用，不得调用模型。' });
  const blocked = await invoke(participant, 'wake_execution', { requestId: 'provider_wake', groupId: 'provider_group', taskId: 'provider_task', executionId: queued.execution.executionId });
  check('历史provider选择不能绕过已取消独立CLI正式路线', () => { assert.equal(selected.service.reviewedCodeBuddyProviderSelected, true); assert.equal(blocked.execution.state, 'blocked'); assert.equal(blocked.execution.blocker.code, 'CODEBUDDY_ROUTE_CANCELLED'); assert.equal(blocked.execution.workerStarted, false); assert.equal(blocked.execution.platformProcessStarted, false); });
  await participant.close(); await operator.close(); await selected.close(); services.splice(services.indexOf(selected), 1);

  const childReceipt = path.join(logDir, 'independent-child-stdout.txt'), childError = path.join(logDir, 'independent-child-stderr.txt');
  const launcher = path.join(logDir, 'launcher-parent.mjs');
  fs.writeFileSync(launcher, `import fs from 'node:fs'; import {spawn} from 'node:child_process'; const [script,stdout,stderr]=process.argv.slice(2); const out=fs.openSync(stdout,'wx'),err=fs.openSync(stderr,'wx'); const child=spawn(process.execPath,[script,'--port','0'],{cwd:process.cwd(),env:process.env,detached:true,windowsHide:true,stdio:['ignore',out,err]}); child.once('spawn',()=>{fs.closeSync(out);fs.closeSync(err);process.stdout.write(JSON.stringify({pid:child.pid}));child.unref();}); child.once('error',()=>process.exit(1));`, 'utf8');
  const launched = await new Promise((resolve, reject) => {
    const parent = spawn(process.execPath, [launcher, path.join(CODE_ROOT, 'bridge/src/collaboration-service.mjs'), childReceipt, childError], { cwd: FIXTURE_ROOT, env: { ...process.env, COLLAB_PROJECT_ROOT: FIXTURE_ROOT, COLLAB_TEST_MODE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; parent.stdout.on('data', bytes => chunks.push(bytes)); parent.stderr.on('data', bytes => fs.appendFileSync(path.join(logDir, 'parent-stderr.txt'), bytes)); parent.on('error', reject);
    parent.once('exit', code => code === 0 ? resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) : reject(new Error('隔离启动父进程失败。')));
  });
  childPid = launched.pid;
  let startup; const until = Date.now() + 10000;
  for (;;) { try { startup = JSON.parse(fs.readFileSync(childReceipt, 'utf8').trim()); break; } catch { if (Date.now() > until) throw new Error('独立服务启动超时。'); await new Promise(resolve => setTimeout(resolve, 50)); } }
  const detached = await client({ endpoint: startup.endpoint }, key); await detached.listTools();
  check('启动父客户端退出后独立后台仍实际响应', () => { assert.equal(startup.pid, childPid); assert.equal(startup.version, '0.2.10'); });
  await detached.close(); process.kill(childPid); childPid = null;
  const summary = { status: 'passed', checks, source: 'isolated_service_clients_not_official_agents', officialModelsStarted: 0, officialPlatformCalls: 0,
    parentLauncherExitedVerified: true, actualCodexApplicationClosed: false, fixtureRoot: FIXTURE_ROOT, logDir };
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify({ status: 'passed', checks: checks.length, summaryPath: path.join(logDir, 'summary.json'), actualCodexApplicationClosed: false, officialPlatformCalls: 0 }));
} catch (error) { fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ message: error.message, code: error.code, stack: error.stack, checks }, null, 2)); console.error(error); process.exitCode = 1; }
finally { await Promise.allSettled(clients.map(peer => peer.close())); await Promise.allSettled(services.map(service => service.close())); if (childPid) { try { process.kill(childPid); } catch { /* 只处理本测试登记的服务进程。 */ } } }
