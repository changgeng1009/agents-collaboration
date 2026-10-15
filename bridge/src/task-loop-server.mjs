import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { PROJECT_ROOT, SOURCE_ROOT, fail, sha256 } from './policy.mjs';
import { TaskLoopStore, TASK_LOOP_ROOT, LOOP_TEXT_LIMIT, loopPath, loopId } from './task-loop-store.mjs';

const VERSION = '0.1.9';
const methods = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);
const workerTools = new Set(['get_capabilities', 'claim_task', 'submit_task_result']);
const request = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const taskId = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
const text = z.string().min(1).max(LOOP_TEXT_LIMIT);
const stamp = () => new Date().toISOString();

function toolSet(store) {
  const shared = [['get_capabilities', '读取启动固定的角色、唯一任务和受限工具；不证明官方平台身份', {}, () => store.capabilities()]];
  return store.actor === 'manager' ? [...shared,
    ['create_task', '创建指定受限执行角色的有界文本任务；不创建平台会话、不自动唤醒', { requestId: request, taskId, assignee: z.enum(['workbuddy', 'doubao']), body: text }, args => store.createTask(args)],
    ['get_task_result', 'manager 独立读取固定输出文件的正文并核对哈希；不自动审核或发布', { taskId }, args => store.getTaskResult(args)]
  ] : [...shared,
    ['claim_task', '只领取启动绑定的任务；返回原始正文和私有领取凭据；未知或已占位任务不重派', { requestId: request, taskId }, args => store.claimTask(args)],
    ['submit_task_result', '提交原领取凭据绑定的有界 UTF-8 正文；固定写入结果文件，不接受文件路径', { requestId: request, taskId, claimId: z.string().min(1).max(128), claimToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/), text }, args => store.submitTaskResult(args)]
  ];
}
function makeServer(store, audit = () => {}) {
  const server = new McpServer({ name: 'local-task-loop', version: VERSION }, { instructions: '启动身份与唯一任务固定。只进行文本领取、提交及 manager 文件读回；没有审核、发布、命令、账号历史或自动唤醒能力。conversationId 未取得真实平台值，始终为空。客户端名称是自报数据，不证明官方身份。' });
  for (const [name, description, fields, handler] of toolSet(store)) server.registerTool(name, { description, inputSchema: z.object(fields).strict() }, async args => {
    try {
      const output = handler(args);
      audit({ event: 'tool_completed', tool: name, success: true, outputSha256: sha256(JSON.stringify(output)) });
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    } catch (error) {
      const code = /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'OPERATION_FAILED';
      audit({ event: 'tool_completed', tool: name, success: false, code });
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code, message: /^[A-Z_]+$/.test(error.code ?? '') ? error.message : '操作失败，原占位或文件保留供核查。' }) }] };
    }
  });
  return server;
}

function auditWriter(actor, boundTaskId, deploymentId) {
  const directory = loopPath(path.join(PROJECT_ROOT, 'logs', 'task-loop', actor, deploymentId), { mustExist: false });
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'audit.jsonl');
  fs.writeFileSync(loopPath(file, { mustExist: false }), '', { flag: 'wx', mode: 0o600 });
  const original = fs.lstatSync(file, { bigint: true });
  const write = entry => {
    loopPath(file);
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || stat.ino !== original.ino || stat.dev !== original.dev || stat.birthtimeNs !== original.birthtimeNs) fail('AUDIT_IDENTITY_MISMATCH', '闭环审计文件身份发生变化。');
    const descriptor = fs.openSync(file, 'a');
    try {
      const opened = fs.fstatSync(descriptor, { bigint: true });
      if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.nlink !== 1n) fail('AUDIT_IDENTITY_MISMATCH', '打开审计文件时身份发生变化。');
      fs.writeFileSync(descriptor, JSON.stringify({ at: stamp(), deploymentId, actor, taskId: boundTaskId, clientInfoIsSelfReported: true, ...entry }) + '\n', 'utf8');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  };
  return { directory, file, write };
}
function metadata(message) {
  return { rpcMethod: methods.has(message.method) ? message.method : 'forbidden_method', rpcIdSha256: sha256(JSON.stringify(message.id ?? null)),
    tool: message.method === 'tools/call' ? (workerTools.has(message.params?.name) || ['create_task', 'get_task_result'].includes(message.params?.name) ? message.params.name : 'unknown_tool') : null,
    paramsSha256: sha256(JSON.stringify(message.params ?? null)),
    clientInfoSha256: message.method === 'initialize' ? sha256(JSON.stringify(message.params?.clientInfo ?? null)) : null };
}
function attachManagerAudit(transport, audit) {
  let current;
  Object.defineProperty(transport, 'onmessage', { configurable: true, get: () => current, set: handler => {
    current = message => { if (methods.has(message.method)) audit({ event: 'rpc_received', ...metadata(message) }); handler?.(message); };
  } });
  const send = transport.send.bind(transport);
  transport.send = async message => {
    if (message.id !== undefined) audit({ event: 'rpc_response', rpcIdSha256: sha256(JSON.stringify(message.id)), responseSha256: sha256(JSON.stringify(message.result ?? message.error ?? null)), success: !message.error && message.result?.isError !== true });
    await send(message);
  };
}

export async function startTaskManager({ dbPath, leaseMs } = {}) {
  const store = new TaskLoopStore({ actor: 'manager', ...(dbPath ? { dbPath } : {}), ...(leaseMs === undefined ? {} : { leaseMs }) });
  const deploymentId = randomUUID(), audit = auditWriter('manager', null, deploymentId);
  const server = makeServer(store, audit.write), transport = new StdioServerTransport();
  attachManagerAudit(transport, audit.write);
  await server.connect(transport);
  console.error(JSON.stringify({ event: 'manager_started', version: VERSION, deploymentId, auditFile: audit.file }));
  return { server, store, audit, async close() { await server.close(); store.close(); } };
}

function readHttpBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, rejected = false;
    req.on('data', chunk => { if (rejected) return; size += chunk.length; if (size > 256 * 1024) { rejected = true; chunks.length = 0; const error = new Error('请求体过大。'); error.code = 'BODY_TOO_LARGE'; reject(error); return; } chunks.push(chunk); });
    req.on('end', () => { if (!rejected) { try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); } catch { const error = new Error('请求不是有效 UTF-8 JSON。'); error.code = 'INVALID_JSON'; reject(error); } } });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('请求读取超时。')); });
  });
}

// 仅可信启动入口可恢复传输凭据；MCP 工具不接收此参数。原部署证据始终保留。
function resumeRead(file, limit) {
  const checked = loopPath(file), before = fs.lstatSync(checked, { bigint: true });
  const ordinary = stat => stat.isFile() && stat.nlink === 1n && stat.size > 0n && stat.size <= BigInt(limit);
  const same = stat => ordinary(stat) && ['dev', 'ino', 'birthtimeNs', 'size', 'mtimeNs'].every(field => stat[field] === before[field]);
  if (!ordinary(before)) fail('RESUME_FILE_INVALID', '恢复文件必须为有界、单链接普通文件。');
  const descriptor = fs.openSync(checked, 'r');
  try {
    if (!same(fs.fstatSync(descriptor, { bigint: true }))) fail('RESUME_FILE_INVALID', '打开恢复文件时身份改变。');
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (!count) fail('RESUME_FILE_INVALID', '恢复文件未完整读取。'); offset += count; }
    loopPath(checked);
    if (!same(fs.fstatSync(descriptor, { bigint: true })) || !same(fs.lstatSync(checked, { bigint: true }))) fail('RESUME_FILE_INVALID', '读取恢复文件时身份改变。');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { fs.closeSync(descriptor); }
}
function resumeCredential(serviceFile, { actor, boundTaskId, port, dbPath }) {
  const checked = loopPath(serviceFile), previous = JSON.parse(resumeRead(checked, 16384));
  const id = previous.deploymentId;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) fail('RESUME_BINDING_MISMATCH', '恢复部署编号无效。');
  const expectedMetadata = path.join(PROJECT_ROOT, 'logs', 'task-loop', actor, id, 'service.json');
  const expectedKey = path.join(TASK_LOOP_ROOT, 'deployments', id, 'bearer-key.txt');
  if (checked !== expectedMetadata || previous.actor !== actor || previous.taskId !== boundTaskId || previous.port !== port ||
      previous.listenAddress !== '127.0.0.1' || previous.endpoint !== `http://127.0.0.1:${port}/mcp` || previous.dbPath !== dbPath ||
      previous.privateKeyFile !== expectedKey || previous.localAuthenticationEnabled !== true ||
      !Array.isArray(previous.toolNames) || JSON.stringify([...previous.toolNames].sort()) !== JSON.stringify([...workerTools].sort())) {
    fail('RESUME_BINDING_MISMATCH', '恢复只能沿用原角色、任务、端口、数据库和工具范围。');
  }
  loopPath(dbPath);
  const key = resumeRead(expectedKey, 128);
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) fail('RESUME_FILE_INVALID', '原传输凭据格式无效。');
  return { key, deploymentId: id };
}

export async function startTaskExecutor({ actor, taskId: boundTaskId, port = 18762, dbPath, leaseMs, resumeServiceFile } = {}) {
  if (!['workbuddy', 'doubao'].includes(actor)) fail('ROLE_DISABLED', 'HTTP 端只允许启动固定的受限执行角色。');
  loopId(boundTaskId);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || port === 18761 || (port === 0 && !(process.env.COLLAB_TEST_MODE === '1' && PROJECT_ROOT !== SOURCE_ROOT))) fail('PORT_INVALID', '必须使用独立的新端口；随机端口仅限隔离离线测试。');
  const resumed = resumeServiceFile === undefined ? null : resumeCredential(resumeServiceFile, { actor, boundTaskId, port, dbPath: loopPath(dbPath ?? path.join(TASK_LOOP_ROOT, 'tasks.sqlite'), { mustExist: false }) });
  const store = new TaskLoopStore({ actor, taskId: boundTaskId, ...(dbPath ? { dbPath } : {}), ...(leaseMs === undefined ? {} : { leaseMs }) });
  const deploymentId = randomUUID(), audit = auditWriter(actor, boundTaskId, deploymentId);
  const privateDirectory = loopPath(path.join(TASK_LOOP_ROOT, 'deployments', deploymentId), { mustExist: false });
  fs.mkdirSync(privateDirectory, { recursive: true });
  const keyFile = path.join(privateDirectory, 'bearer-key.txt'), key = resumed?.key ?? randomBytes(32).toString('base64url');
  fs.writeFileSync(loopPath(keyFile, { mustExist: false }), key, { flag: 'wx', mode: 0o600 });
  let actualPort;
  const authenticated = value => { if (typeof value !== 'string') return false; const expected = Buffer.from(`Bearer ${key}`), supplied = Buffer.from(value); return expected.length === supplied.length && timingSafeEqual(expected, supplied); };
  const server = http.createServer(async (req, res) => {
    const correlationId = randomUUID();
    const log = entry => audit.write({ correlationId, ...entry });
    const reject = (status, code) => { log({ event: 'request_rejected', status, code }); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code })); };
    try {
      if (req.socket.remoteAddress !== '127.0.0.1') return reject(403, 'NON_LOCAL_ACCESS');
      if (req.headers.host !== `127.0.0.1:${actualPort}`) return reject(403, 'INVALID_HOST');
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${actualPort}`) return reject(403, 'INVALID_ORIGIN');
      if (!authenticated(req.headers.authorization)) return reject(401, 'LOCAL_AUTH_REQUIRED');
      if (req.url !== '/mcp') return reject(404, 'NOT_FOUND');
      if (req.method !== 'POST') return reject(405, 'POST_REQUIRED');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) return reject(415, 'CONTENT_TYPE_REQUIRED');
      let body;
      try { body = await readHttpBody(req); } catch (error) { return reject(error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code === 'BODY_TOO_LARGE' ? error.code : 'INVALID_JSON'); }
      if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || !methods.has(body.method)) return reject(403, 'RPC_SCOPE_FORBIDDEN');
      log({ event: 'rpc_received', ...metadata(body) });
      if (body.method === 'tools/call' && !workerTools.has(body.params?.name)) return reject(403, 'TOOL_SCOPE_FORBIDDEN');
      const mcp = makeServer(store, log);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.once('finish', () => { log({ event: 'rpc_http_response', ...metadata(body), status: res.statusCode }); void mcp.close(); });
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch {
      try { log({ event: 'request_failed', code: 'INTERNAL_OPERATION_FAILED' }); } catch { /* 审计故障时关闭请求，不继续派单。 */ }
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'INTERNAL_OPERATION_FAILED' })); } else res.destroy();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 16;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { store.close(); throw error; }
  actualPort = server.address().port;
  const service = { version: VERSION, actor, taskId: boundTaskId, deploymentId, pid: process.pid, startedAt: stamp(), listenAddress: '127.0.0.1', port: actualPort,
    endpoint: `http://127.0.0.1:${actualPort}/mcp`, privateKeyFile: keyFile, auditFile: audit.file, dbPath: store.dbPath,
    toolNames: [...workerTools], localAuthenticationEnabled: true, platformIdentityVerified: false, clientInfoIsSelfReported: true, conversationId: null,
    credentialResumed: resumed !== null, resumedFromDeploymentId: resumed?.deploymentId ?? null };
  const serviceFile = path.join(audit.directory, 'service.json');
  fs.writeFileSync(loopPath(serviceFile, { mustExist: false }), JSON.stringify(service, null, 2), { flag: 'wx', mode: 0o600 });
  audit.write({ event: 'executor_started', endpoint: service.endpoint, keyLogged: false, credentialResumed: resumed !== null, resumedFromDeploymentId: resumed?.deploymentId ?? null });
  return { server, store, service, serviceFile, async close() { await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); audit.write({ event: 'executor_stopped' }); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { actor: { type: 'string' }, transport: { type: 'string' }, 'task-id': { type: 'string' }, port: { type: 'string' }, db: { type: 'string' }, 'lease-ms': { type: 'string' }, 'resume-service': { type: 'string' } } });
  const common = { ...(values.db ? { dbPath: values.db } : {}), ...(values['lease-ms'] ? { leaseMs: Number(values['lease-ms']) } : {}) };
  let running;
  if (values.actor === 'manager' && values.transport === 'stdio' && values['task-id'] === undefined && values.port === undefined && values['resume-service'] === undefined) running = await startTaskManager(common);
  else if (['workbuddy', 'doubao'].includes(values.actor) && values.transport === 'http') {
    running = await startTaskExecutor({ ...common, actor: values.actor, taskId: values['task-id'], ...(values.port === undefined ? {} : { port: Number(values.port) }), ...(values['resume-service'] === undefined ? {} : { resumeServiceFile: values['resume-service'] }) });
    console.log(JSON.stringify({ endpoint: running.service.endpoint, pid: process.pid, deploymentId: running.service.deploymentId, serviceFile: running.serviceFile }));
  } else fail('STARTUP_SCOPE', 'manager 仅允许 stdio；执行角色仅允许 HTTP 并绑定任务，不能混用启动模式。');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.close(); process.exit(0); });
  process.once('exit', () => { try { running.store.close(); } catch { /* 进程退出时数据库可能已关闭。 */ } });
}
