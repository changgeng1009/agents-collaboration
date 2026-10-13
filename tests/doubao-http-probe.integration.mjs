import './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import { startProbe, PROBE_LOG_ROOT } from '../bridge/src/doubao-http-probe.mjs';

const instance = `local_test_${randomUUID().replaceAll('-', '')}`;
const probe = await startProbe({ port: 0, instance });
const { service } = probe; const key = fs.readFileSync(service.privateKeyFile, 'utf8');
const checks = [], wire = [];
const client = new Client({ name: 'local_test_only_not_doubao', version: '0.1.0' });
const responseFile = path.join(service.logDir, 'local-client-wire.jsonl');
const loggedFetch = async (url, init) => {
  const headers = Object.fromEntries(new Headers(init?.headers).entries()); if (headers.authorization) headers.authorization = '[已脱敏本地身份]';
  const req = { at: new Date().toISOString(), direction: 'client_to_server', url: String(url), method: init?.method ?? 'GET', headers, body: init?.body ? JSON.parse(String(init.body)) : null };
  wire.push(req);
  const response = await fetch(url, init);
  if (response.status !== 202 && (response.headers.get('content-type') ?? '').includes('application/json')) {
    const copy = response.clone(); wire.push({ at: new Date().toISOString(), direction: 'server_to_client', status: response.status, body: await copy.json() });
  } else wire.push({ at: new Date().toISOString(), direction: 'server_to_client', status: response.status, body: null });
  return response;
};
const check = (name, callback) => { callback(); checks.push({ name, passed: true }); };
function raw(headers, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(service.endpoint, { method: 'POST', headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', ...headers } }, response => { let text = ''; response.setEncoding('utf8'); response.on('data', chunk => text += chunk); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(text) })); });
    request.on('error', reject); request.end(JSON.stringify(body));
  });
}
try {
  const transport = new StreamableHTTPClientTransport(new URL(service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${key}` } }, fetch: loggedFetch });
  await client.connect(transport);
  const listed = await client.listTools(); check('实际 HTTP initialize 与两个只读工具列出', () => assert.deepEqual(listed.tools.map(t => t.name).sort(), ['get_capabilities', 'get_probe']));
  const caps = await client.callTool({ name: 'get_capabilities', arguments: {} });
  check('固定只读 doubao_probe，无执行/写入/生成', () => { assert.equal(caps.structuredContent.role, 'doubao_probe'); assert.equal(caps.structuredContent.fileWriteEnabled, false); assert.equal(caps.structuredContent.modelExecutionEnabled, false); });
  const actual = await client.callTool({ name: 'get_probe', arguments: {} });
  const expected = JSON.parse(fs.readFileSync(service.challengeFile, 'utf8'));
  check('现场挑战码真实返回且部署关联一致', () => { assert.equal(actual.structuredContent.challenge, expected.challenge); assert.equal(actual.structuredContent.deploymentId, service.deploymentId); });
  const body = { jsonrpc: '2.0', id: 800, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'local_test_rejection', version: '0.1.0' } } };
  const noAuth = await raw({}, body); check('无本地身份拒绝', () => assert.equal(noAuth.status, 401));
  const badAuth = await raw({ Authorization: 'Bearer wrong-local-fixture' }, body); check('错误本地身份拒绝', () => assert.equal(badAuth.status, 401));
  const badOrigin = await raw({ Authorization: `Bearer ${key}`, Origin: 'https://untrusted.example' }, body); check('非法 Origin 拒绝', () => { assert.equal(badOrigin.status, 403); assert.equal(badOrigin.body.code, 'INVALID_ORIGIN'); });
  const badHost = await raw({ Authorization: `Bearer ${key}`, Host: 'untrusted.example:18761' }, body); check('非法 Host 拒绝', () => { assert.equal(badHost.status, 403); assert.equal(badHost.body.code, 'INVALID_HOST'); });
  const forbidden = await raw({ Authorization: `Bearer ${key}` }, { jsonrpc: '2.0', id: 801, method: 'resources/read', params: { uri: 'forbidden://fixture/resource' } }); check('任意文件资源操作被拒绝', () => assert.equal(forbidden.status, 403));
  await client.close();
  const audit = fs.readFileSync(service.auditFile, 'utf8');
  check('实际审计包含握手/工具关联且不泄露 Header 密钥', () => { assert.ok(audit.includes('local_test_only_not_doubao')); assert.ok(audit.includes('get_probe')); assert.ok(audit.includes('correlationId')); assert.equal(audit.includes(key), false); });
  fs.writeFileSync(responseFile, wire.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  const summary = { status: 'passed', instance, deploymentId: service.deploymentId, checks, service, transport: 'real_loopback_http', source: 'local_test_not_doubao', actualDoubaoClientVerified: false, identityHeaderLogged: false, wireFile: responseFile };
  fs.writeFileSync(path.join(service.logDir, 'local-test-summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(path.join(PROBE_LOG_ROOT, 'latest-local-test.json'), JSON.stringify({ summaryPath: path.join(service.logDir, 'local-test-summary.json'), deploymentId: service.deploymentId, checks: checks.length, status: 'passed' }, null, 2), 'utf8');
  console.log(JSON.stringify({ status: 'passed', checks: checks.length, summaryPath: path.join(service.logDir, 'local-test-summary.json'), actualDoubaoClientVerified: false }, null, 2));
} finally { await client.close().catch(() => {}); await probe.close(); }
