import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import * as z from 'zod/v4';
import { PROJECT_ROOT, ARTIFACT_ROOT, guardedPath, sha256, redact } from './policy.mjs';

export const PROBE_ROOT = path.join(ARTIFACT_ROOT, 'doubao-probe');
export const PROBE_LOG_ROOT = path.join(PROJECT_ROOT, 'logs', 'http-probe');
const allowedRpcMethods = new Set(['initialize', 'notifications/initialized', 'ping', 'tools/list', 'tools/call']);

export async function startProbe({ port = 18761, instance = 'desktop_probe' } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(instance)) throw new Error('探针实例名称无效。');
  for (const dir of [PROBE_ROOT, PROBE_LOG_ROOT]) fs.mkdirSync(guardedPath(PROJECT_ROOT, dir, { mustExist: false }), { recursive: true });
  const deploymentId = randomUUID();
  const deploymentDir = guardedPath(PROBE_ROOT, path.join(PROBE_ROOT, 'deployments', deploymentId), { mustExist: false });
  const logDir = guardedPath(PROBE_LOG_ROOT, path.join(PROBE_LOG_ROOT, instance, deploymentId), { mustExist: false });
  fs.mkdirSync(deploymentDir, { recursive: true }); fs.mkdirSync(logDir, { recursive: true });
  const auditFile = path.join(logDir, 'http-audit.jsonl');
  const keyFile = path.join(deploymentDir, 'local-bearer-key.txt');
  const challengeFile = path.join(deploymentDir, 'challenge.json');
  let key = null, challenge = null, actualPort = null;
  const log = entry => fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), deploymentId, instance, ...entry }) + '\n', 'utf8');
  const authenticated = header => {
    if (!key || typeof header !== 'string') return false;
    const wanted = Buffer.from(`Bearer ${key}`, 'utf8'), actual = Buffer.from(header, 'utf8');
    return wanted.length === actual.length && timingSafeEqual(wanted, actual);
  };
  const capabilities = () => ({ role: 'doubao_probe', projectId: 'ai-collaboration-t1', transport: 'streamable-http-json',
    deploymentId, endpoint: `http://127.0.0.1:${actualPort}/mcp`, allowedTools: ['get_capabilities', 'get_probe'],
    permissions: '仅读取本探针能力及现场挑战码', fileReadEnabled: false, fileWriteEnabled: false, modelExecutionEnabled: false,
    videoGenerationEnabled: false, reviewEnabled: false, automaticWakeup: false, realDoubaoClientVerified: false });
  function makeMcpServer(correlationId) {
    const server = new McpServer({ name: 'doubao-local-readonly-probe', version: '0.1.5' }, { instructions: '仅只读探针工具。客户端名称是自报元数据，不能证明身份或执行成功。' });
    server.registerTool('get_capabilities', { description: '读取本地只读探针的角色、权限和传输能力', inputSchema: z.object({}).strict() }, async () => {
      const value = capabilities(); log({ event: 'tool_completed', correlationId, tool: 'get_capabilities', outputSha256: sha256(JSON.stringify(value)) });
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
    server.registerTool('get_probe', { description: '读取本次部署后生成的现场挑战码、创建时间和角色，仅证明实际工具内容传输', inputSchema: z.object({}).strict() }, async () => {
      const value = { ...challenge, role: 'doubao_probe', permissions: '只读现场挑战码，不生成视频、不执行代码、不审核任务' };
      log({ event: 'tool_completed', correlationId, tool: 'get_probe', challengeSha256: sha256(value.challenge), outputSha256: sha256(JSON.stringify(value)) });
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    });
    return server;
  }
  const server = http.createServer(async (req, res) => {
    const correlationId = randomUUID();
    const base = { correlationId, method: req.method, path: req.url?.split('?')[0], remoteAddress: req.socket.remoteAddress,
      headers: { host: req.headers.host ?? null, origin: req.headers.origin ?? null, authorization: req.headers.authorization ? '[已脱敏本地身份]' : null }, authenticated: false };
    const reject = (status, code, message) => { log({ ...base, event: 'request_rejected', status, code }); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ code, message })); };
    if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return reject(403, 'NON_LOCAL_ACCESS', '仅允许本机访问。');
    if (![`127.0.0.1:${actualPort}`, `localhost:${actualPort}`].includes(req.headers.host)) return reject(403, 'INVALID_HOST', 'Host 不属于此本机服务。');
    if (req.headers.origin && ![`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(req.headers.origin)) return reject(403, 'INVALID_ORIGIN', 'Origin 不属于此本机服务。');
    if (!authenticated(req.headers.authorization)) return reject(401, 'LOCAL_AUTH_REQUIRED', '需要本探针的本地身份 Header。');
    base.authenticated = true;
    if (base.path === '/health' && req.method === 'GET') {
      log({ ...base, event: 'health_requested', status: 200 }); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ status: 'running', deploymentId, role: 'doubao_probe' }));
    }
    if (base.path !== '/mcp') return reject(404, 'NOT_FOUND', '端点不存在。');
    if (req.method !== 'POST') {
      log({ ...base, event: 'method_not_supported', status: 405 }); res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ message: '本探针使用 Streamable HTTP JSON POST；未启用独立 SSE 通道。' }));
    }
    let body;
    try {
      let bytes = 0; const chunks = [];
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) return reject(413, 'BODY_TOO_LARGE', '请求体超过探针上限。'); chunks.push(chunk); }
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return reject(400, 'INVALID_JSON', '请求不是有效 JSON。'); }
    if (!allowedRpcMethods.has(body?.method)) return reject(403, 'RPC_SCOPE_FORBIDDEN', '此探针不提供该操作。');
    log({ ...base, event: 'rpc_received', rpcId: body.id ?? null, rpcMethod: body.method,
      tool: body.method === 'tools/call' ? body.params?.name ?? null : null,
      clientInfo: body.method === 'initialize' ? { name: redact(String(body.params?.clientInfo?.name ?? '')).slice(0, 200), version: redact(String(body.params?.clientInfo?.version ?? '')).slice(0, 80) } : null,
      protocolVersion: body.method === 'initialize' ? body.params?.protocolVersion ?? null : null,
      clientInfoIsSelfReported: true });
    const mcp = makeMcpServer(correlationId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('finish', () => { log({ event: 'rpc_http_response', correlationId, rpcId: body.id ?? null, status: res.statusCode }); void mcp.close(); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res, body); }
    catch (error) {
      log({ event: 'transport_error', correlationId, message: redact(error.message) });
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: '探针传输错误。' })); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  actualPort = server.address().port;
  // 监听成功以后生成挑战码，测试实例与实际部署分别生成，连接提示词中不包含预期答案。
  key = randomBytes(32).toString('base64url');
  challenge = { challenge: `DBP-${randomBytes(18).toString('hex')}`, createdAt: new Date().toISOString(), deploymentId };
  fs.writeFileSync(keyFile, key, { encoding: 'utf8', flag: 'wx' }); fs.writeFileSync(challengeFile, JSON.stringify(challenge, null, 2), { encoding: 'utf8', flag: 'wx' });
  const service = { instance, deploymentId, pid: process.pid, startedAt: new Date().toISOString(), endpoint: `http://127.0.0.1:${actualPort}/mcp`, healthUrl: `http://127.0.0.1:${actualPort}/health`,
    listenAddress: '127.0.0.1', port: actualPort, transport: 'streamable-http-json', role: 'doubao_probe', headerName: 'Authorization', headerValuePrefix: 'Bearer ',
    privateKeyFile: keyFile, challengeFile, logDir, auditFile, localAuthenticationEnabled: true, realDoubaoClientVerified: false, permissions: ['get_capabilities', 'get_probe'] };
  fs.writeFileSync(path.join(logDir, 'service.json'), JSON.stringify(service, null, 2), 'utf8');
  fs.writeFileSync(path.join(PROBE_LOG_ROOT, `${instance}-service.json`), JSON.stringify(service, null, 2), 'utf8');
  log({ event: 'service_started', pid: process.pid, endpoint: service.endpoint, role: service.role, challengeSha256: sha256(challenge.challenge), keyLogged: false });
  return { server, service, async close() { await new Promise(resolve => server.close(resolve)); log({ event: 'service_stopped' }); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { port: { type: 'string', default: '18761' }, instance: { type: 'string', default: 'desktop_probe' } } });
  const probe = await startProbe({ port: Number(values.port), instance: values.instance });
  console.log(JSON.stringify({ endpoint: probe.service.endpoint, pid: process.pid, deploymentId: probe.service.deploymentId, serviceFile: path.join(PROBE_LOG_ROOT, `${values.instance}-service.json`) }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await probe.close(); process.exit(0); });
}
