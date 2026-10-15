import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PROJECT_ROOT, SOURCE_ROOT, guardedPath, fail, sha256 } from './policy.mjs';
import { CollaborationStore } from './collaboration-store.mjs';
import { createCollaborationMcp } from './collaboration-tools.mjs';

export const COLLAB_SERVICE_VERSION = '0.2.0';
const methods = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);
const bodyLimit = 256 * 1024;
const stamp = () => new Date().toISOString();

function servicePath(file, mustExist = true) {
  const checked = guardedPath(PROJECT_ROOT, file, { mustExist });
  let cursor = PROJECT_ROOT;
  for (const part of path.relative(PROJECT_ROOT, checked).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('SERVICE_LINK_FORBIDDEN', '独立服务路径不能使用链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return checked;
}
function auditWriter(deploymentId) {
  const directory = servicePath(path.join(PROJECT_ROOT, 'logs', 'collaboration-service', deploymentId), false);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'transport-audit.jsonl');
  fs.writeFileSync(servicePath(file, false), '', { flag: 'wx', mode: 0o600 });
  const original = fs.lstatSync(file, { bigint: true }); let written = 0;
  const same = stat => stat.isFile() && stat.nlink === 1n && ['dev', 'ino', 'birthtimeNs'].every(field => stat[field] === original[field]);
  return { directory, file, write(entry) {
    const bytes = Buffer.from(JSON.stringify({ at: stamp(), deploymentId, ...entry }) + '\n', 'utf8');
    if (written + bytes.length > 16 * 1024 * 1024) fail('SERVICE_AUDIT_LIMIT', '审计达到本次部署上限，停止接收操作并保留记录。');
    const before = fs.lstatSync(servicePath(file), { bigint: true });
    if (!same(before) || before.size !== BigInt(written)) fail('SERVICE_AUDIT_CHANGED', '独立服务审计已被替换或更改。');
    const fd = fs.openSync(file, 'a');
    try { if (!same(fs.fstatSync(fd, { bigint: true }))) fail('SERVICE_AUDIT_CHANGED', '打开审计时身份改变。'); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); written += bytes.length; }
    finally { fs.closeSync(fd); }
  } };
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0, rejected = false;
    req.on('data', bytes => { if (rejected) return; size += bytes.length; if (size > bodyLimit) { rejected = true; chunks.length = 0; reject(Object.assign(new Error('请求体超过上限。'), { code: 'BODY_TOO_LARGE' })); } else chunks.push(bytes); });
    req.on('end', () => { if (!rejected) { try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); } catch { reject(Object.assign(new Error('请求必须是有效 UTF-8 JSON。'), { code: 'INVALID_JSON' })); } } });
    req.on('error', reject); req.setTimeout(15000, () => { req.destroy(); reject(Object.assign(new Error('读取请求超时。'), { code: 'REQUEST_TIMEOUT' })); });
  });
}
function rpcMetadata(body) {
  return { rpcMethod: body.method, rpcIdSha256: sha256(JSON.stringify(body.id ?? null)), paramsSha256: sha256(JSON.stringify(body.params ?? null)),
    toolNameSha256: body.method === 'tools/call' ? sha256(String(body.params?.name ?? '')) : null,
    clientInfoSha256: body.method === 'initialize' ? sha256(JSON.stringify(body.params?.clientInfo ?? null)) : null, clientInfoIsSelfReported: true };
}

// 一个独立 HTTP 进程服务任意已登记实例；身份只由本次真实凭据解析，不取消息参数。
export async function startCollaborationService({ port = 18764, dbPath, reviewedCodeBuddyProvider = false } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535 || [18761, 18762, 18763].includes(port) ||
      (port === 0 && !(process.env.COLLAB_TEST_MODE === '1' && PROJECT_ROOT !== SOURCE_ROOT))) fail('SERVICE_PORT_INVALID', '独立协作服务必须使用独立端口；随机端口只允许隔离测试。');
  if (typeof reviewedCodeBuddyProvider !== 'boolean') fail('SERVICE_PROVIDER_INVALID', '执行模式只能由可信启动显式选择。');
  let executionProvider = null;
  if (reviewedCodeBuddyProvider) {
    const { CodeBuddyCollaborationProvider } = await import('./collaboration-provider.mjs');
    executionProvider = new CodeBuddyCollaborationProvider();
  }
  const store = new CollaborationStore({ ...(dbPath ? { dbPath } : {}), executionProvider });
  let admin, audit;
  try { admin = store.bootstrapAdmin(); audit = auditWriter(randomUUID()); }
  catch (error) { store.close(); throw error; }
  let actualPort, closing = false, auditBroken = false;
  const server = http.createServer(async (req, res) => {
    // 无状态 JSON MCP 不保留空闲连接，避免重启后复用上一部署的 TCP 连接。
    res.setHeader('Connection', 'close');
    const correlationId = randomUUID();
    const log = entry => { try { audit.write({ correlationId, ...entry }); } catch (error) { auditBroken = true; throw error; } };
    const reject = (status, code) => { log({ event: 'request_rejected', status, code }); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code })); };
    try {
      if (auditBroken) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'SERVICE_AUDIT_UNAVAILABLE' })); return; }
      if (closing) return reject(503, 'SERVICE_STOPPING');
      if (req.socket.remoteAddress !== '127.0.0.1') return reject(403, 'NON_LOCAL_ACCESS');
      if (req.headers.host !== `127.0.0.1:${actualPort}`) return reject(403, 'INVALID_HOST');
      if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${actualPort}`) return reject(403, 'INVALID_ORIGIN');
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization ?? '');
      const identity = match ? store.resolveCredential(match[1]) : null;
      if (!identity) return reject(401, 'INSTANCE_AUTH_REQUIRED');
      if (req.url !== '/mcp') return reject(404, 'NOT_FOUND');
      if (req.method !== 'POST') return reject(405, 'POST_REQUIRED');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity')) return reject(415, 'CONTENT_TYPE_REQUIRED');
      let body;
      try { body = await readBody(req); } catch (error) { return reject(error.code === 'BODY_TOO_LARGE' ? 413 : 400, error.code === 'BODY_TOO_LARGE' ? error.code : 'INVALID_JSON'); }
      if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || !methods.has(body.method) || (body.id !== undefined && (typeof body.id !== 'string' && typeof body.id !== 'number' || String(body.id).length > 128))) return reject(403, 'RPC_SCOPE_FORBIDDEN');
      const current = store.resolveCredential(match[1]);
      if (!current || JSON.stringify(current) !== JSON.stringify(identity)) return reject(401, 'INSTANCE_AUTH_CHANGED');
      const actor = { kind: identity.kind, instanceId: identity.instanceId ?? null };
      const metadata = rpcMetadata(body);
      log({ event: 'rpc_received', ...actor, ...metadata });
      const mcp = createCollaborationMcp({ store, identity, audit: entry => log({ event: 'tool_audit', ...actor, payloadSha256: sha256(JSON.stringify(entry)) }) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const send = transport.send.bind(transport);
      transport.send = async message => { if (message.id !== undefined) log({ event: 'rpc_response', ...actor, ...metadata, responseSha256: sha256(JSON.stringify(message.result ?? message.error ?? null)), success: !message.error && message.result?.isError !== true }); await send(message); };
      res.once('finish', () => { try { log({ event: 'rpc_http_response', ...actor, ...metadata, status: res.statusCode }); } catch { /* 审计异常已门控后续请求，不在异步事件中继续执行。 */ } finally { void mcp.close(); } });
      await mcp.connect(transport); await transport.handleRequest(req, res, body);
    } catch {
      try { log({ event: 'request_failed', code: 'SERVICE_OPERATION_FAILED' }); } catch { /* 审计异常时关闭请求，不继续操作。 */ }
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code: 'SERVICE_OPERATION_FAILED' })); } else res.destroy();
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxConnections = 64;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); }); }
  catch (error) { store.close(); throw error; }
  actualPort = server.address().port;
  const service = { version: COLLAB_SERVICE_VERSION, pid: process.pid, startedAt: stamp(), listenAddress: '127.0.0.1', port: actualPort,
    endpoint: `http://127.0.0.1:${actualPort}/mcp`, dbPath: store.dbPath, adminKeyFile: admin.credentialFile, auditFile: audit.file,
    infrastructure: 'independent_node_process', codexModelRequired: false, codexApplicationRequiredByImplementation: false,
    codexApplicationClosedRuntimeVerified: false, platformIdentityVerifiedByHandshake: false, automaticModelExecutionEnabled: false,
    reviewedCodeBuddyProviderSelected: reviewedCodeBuddyProvider };
  const serviceFile = path.join(audit.directory, 'service.json');
  fs.writeFileSync(servicePath(serviceFile, false), JSON.stringify(service, null, 2), { flag: 'wx', mode: 0o600 });
  audit.write({ event: 'service_started', endpoint: service.endpoint, platformExecutionsTriggered: 0 });
  return { server, store, service, serviceFile, audit, async close() { closing = true; await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); }); audit.write({ event: 'service_stopped' }); store.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { port: { type: 'string' }, db: { type: 'string' }, 'reviewed-codebuddy-provider': { type: 'boolean', default: false } } });
  const running = await startCollaborationService({ ...(values.port === undefined ? {} : { port: Number(values.port) }), ...(values.db ? { dbPath: values.db } : {}), reviewedCodeBuddyProvider: values['reviewed-codebuddy-provider'] });
  console.log(JSON.stringify({ endpoint: running.service.endpoint, pid: process.pid, serviceFile: running.serviceFile, version: COLLAB_SERVICE_VERSION }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await running.close(); process.exit(0); });
  process.once('exit', () => { try { running.store.close(); } catch { /* 保留已提交状态，退出不重新调度。 */ } });
}
