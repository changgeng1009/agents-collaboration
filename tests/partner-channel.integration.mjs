import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { PROJECT_ROOT, RUNTIME_ROOT, sha256 } from '../bridge/src/policy.mjs';
import { PARTNER_RUNTIME_ROOT, PARTNER_ARTIFACT_ROOT } from '../bridge/src/partner-store.mjs';

const runId = randomUUID();
const logDir = path.join(FIXTURE_ROOT, 'logs', 'partner-tests', runId); fs.mkdirSync(logDir, { recursive: true });
const dbPath = path.join(PARTNER_RUNTIME_ROOT, 'tests', runId, 'partner.sqlite');
const checks = [], clients = [];
const req = name => `${runId}-${name}`;
const check = (name, callback) => { callback(); checks.push({ name, passed: true }); };

class PeerClient {
  constructor(role, label, database = dbPath, source = 'partner-server.mjs') { this.role = role; this.label = label; this.database = database; this.source = source; this.client = new Client({ name: `local_test_${label}_not_real_client`, version: '0.1.0' }); clients.push(this); }
  async connect() {
    this.transport = new StdioClientTransport({ command: process.execPath, args: [path.join(CODE_ROOT, 'bridge', 'src', this.source), '--role', this.role, '--db', this.database], env: { ...getDefaultEnvironment(), COLLAB_PROJECT_ROOT: PROJECT_ROOT, COLLAB_TEST_MODE: '1' }, stderr: 'pipe' });
    this.transport.stderr.on('data', bytes => fs.appendFileSync(path.join(logDir, `${this.label}-stderr.txt`), bytes));
    const send = this.transport.send.bind(this.transport); this.transport.send = message => { this.log('client_to_server', message); return send(message); };
    let handler;
    Object.defineProperty(this.transport, 'onmessage', { configurable: true, get: () => handler, set: callback => { handler = message => { this.log('server_to_client', message); callback?.(message); }; } });
    await this.client.connect(this.transport);
  }
  log(direction, message) { fs.appendFileSync(path.join(logDir, `${this.label}-wire.jsonl`), JSON.stringify({ at: new Date().toISOString(), role: this.role, direction, source: 'local_test_not_real_workbuddy', message }) + '\n', 'utf8'); }
  async call(name, args = {}, error = null) {
    const result = await this.client.callTool({ name, arguments: args });
    if (error) {
      assert.equal(result.isError, true);
      if (error !== '*') assert.equal(JSON.parse(result.content[0].text).code, error);
      checks.push({ name: `${name} 拒绝 ${error}`, passed: true }); return result;
    }
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent ?? JSON.parse(result.content[0].text);
  }
  async close() { await this.client.close(); }
}

try {
  fs.mkdirSync(RUNTIME_ROOT, { recursive: true });
  const oldHubFixture = path.join(RUNTIME_ROOT, 'hub.sqlite'); fs.writeFileSync(oldHubFixture, '隔离工作区内的旧桥哨兵，不是真实数据库。', 'utf8');
  const oldHash = sha256(fs.readFileSync(oldHubFixture));
  let manager = new PeerClient('manager', 'manager'), buddy = new PeerClient('workbuddy', 'workbuddy');
  await Promise.all([manager.connect(), buddy.connect()]);
  const tools = await buddy.client.listTools();
  check('两个真实 stdio 进程保留七个伙伴工具并新增六项会话工具', () => { assert.equal(tools.tools.length, 13); assert.equal(buddy.client.getServerVersion().version, JSON.parse(fs.readFileSync(path.join(CODE_ROOT, 'bridge', 'package.json'), 'utf8')).version); });
  const caps = await buddy.call('get_capabilities');
  check('固定 workbuddy、独立数据库、无执行审核发布', () => { assert.equal(caps.role, 'workbuddy'); assert.ok(caps.dbPath.includes('partner-channel')); assert.equal(caps.shellEnabled, false); assert.equal(caps.reviewEnabled, false); assert.equal(caps.automaticManagerAck, false); });
  const startupClients = [];
  for (let index = 0; index < 6; index++) {
    const freshDb = path.join(PARTNER_RUNTIME_ROOT, 'tests', runId, `concurrent-${index}.sqlite`);
    startupClients.push(new PeerClient('manager', `startup-${index}-manager`, freshDb), new PeerClient('workbuddy', `startup-${index}-workbuddy`, freshDb));
  }
  await Promise.all(startupClients.map(client => client.connect()));
  await Promise.all(startupClients.map(client => client.close()));
  check('六组全新 SQLite 各两进程同时初始化', () => assert.equal(startupClients.length, 12));
  const challenge = `fixture-challenge-${randomBytes(12).toString('hex')}`;
  const sent = await manager.call('send_message', { requestId: req('challenge'), recipient: 'workbuddy', body: challenge, replyTo: null });
  const duplicate = await manager.call('send_message', { requestId: req('challenge'), recipient: 'workbuddy', body: challenge, replyTo: null });
  check('同一请求去重，消息编号不变', () => { assert.equal(duplicate.message.messageId, sent.message.messageId); assert.equal(duplicate.deduplicated, true); });
  await manager.call('send_message', { requestId: req('challenge'), recipient: 'workbuddy', body: '不同内容', replyTo: null }, 'REQUEST_ID_CONFLICT');
  await buddy.call('ack_message', { requestId: req('early-ack'), messageId: sent.message.messageId }, 'DELIVERY_REQUIRED');
  const inbox = await buddy.call('read_messages', { requestId: req('receive'), unreadOnly: true });
  check('队列/送达/读取分开，只有实际取信才送达', () => { assert.equal(sent.message.status, 'queued'); assert.equal(inbox.messages[0].status, 'delivered'); assert.equal(inbox.messages[0].readAt, null); });
  await buddy.call('send_message', { requestId: req('early-reply'), recipient: 'manager', body: '尚未确认读取', replyTo: sent.message.messageId }, 'READ_ACK_REQUIRED');
  const readAck = await buddy.call('ack_message', { requestId: req('ack'), messageId: sent.message.messageId });
  const nonce = `fixture-buddy-nonce-${randomBytes(12).toString('hex')}`;
  const reply = await buddy.call('send_message', { requestId: req('nonce'), recipient: 'manager', body: JSON.stringify({ challenge, nonce }), replyTo: sent.message.messageId });
  const noServerAck = await buddy.call('read_messages', { requestId: req('before-manager-ack'), unreadOnly: true });
  check('服务没有自动伪造 manager ACK', () => assert.equal(noServerAck.messages.length, 0));
  const managerInbox = await manager.call('read_messages', { requestId: req('manager-inbox'), unreadOnly: true });
  check('manager 实际读取 buddy 自行生成 nonce 回执', () => assert.equal(JSON.parse(managerInbox.messages[0].body).nonce, nonce));
  await manager.call('ack_message', { requestId: req('manager-read'), messageId: reply.message.messageId });
  const actualAck = await manager.call('send_message', { requestId: req('manager-ack'), recipient: 'workbuddy', body: JSON.stringify({ ack: true, nonce }), replyTo: reply.message.messageId });
  const finalInbox = await buddy.call('read_messages', { requestId: req('read-final-ack'), unreadOnly: true });
  const receivedAck = finalInbox.messages.find(message => message.messageId === actualAck.message.messageId);
  check('manager 通过真实工具写 ACK，buddy 实际读回', () => { assert.equal(receivedAck.sender, 'manager'); assert.equal(JSON.parse(receivedAck.body).nonce, nonce); assert.equal(receivedAck.replyTo, reply.message.messageId); });
  await buddy.call('ack_message', { requestId: req('final-ack-read'), messageId: receivedAck.messageId });
  await manager.call('ack_message', { requestId: req('wrong-recipient-ack'), messageId: sent.message.messageId }, 'RECIPIENT_FORBIDDEN');
  await buddy.call('send_message', { requestId: req('sender-forgery'), recipient: 'manager', body: '伪造 manager', sender: 'manager', replyTo: null }, '*');
  await buddy.call('send_message', { requestId: req('root-forgery'), recipient: 'manager', body: '修改范围', projectRoot: path.dirname(PROJECT_ROOT), replyTo: null }, '*');
  await buddy.call('send_message', { requestId: req('old-role-recipient'), recipient: 'codex', body: '不允许扩大旧角色', replyTo: null }, '*');
  await buddy.call('send_message', { requestId: req('wrong-reply'), recipient: 'manager', body: '越权回复', replyTo: reply.message.messageId }, 'REPLY_FORBIDDEN');
  const artifactRequest = { requestId: req('text-v1'), artifactId: 'fixture_text', version: 1, text: '版本一：伙伴消息与文本回传。', messageId: reply.message.messageId };
  const a1 = await buddy.call('put_text_artifact', artifactRequest);
  const a1duplicate = await buddy.call('put_text_artifact', artifactRequest);
  check('文本登记同请求只写一次', () => assert.equal(a1duplicate.artifact.sha256, a1.artifact.sha256));
  const r1 = await manager.call('get_text_artifact', { artifactId: 'fixture_text', version: 1 });
  check('实际 UTF-8 正文和哈希返回 manager', () => { assert.equal(r1.text, artifactRequest.text); assert.equal(r1.artifact.sha256, sha256(Buffer.from(r1.text, 'utf8'))); });
  await buddy.call('put_text_artifact', { ...artifactRequest, requestId: req('overwrite'), text: '禁止覆盖' }, 'VERSION_SEQUENCE');
  await manager.call('put_text_artifact', { ...artifactRequest, requestId: req('other-owner'), version: 2 }, 'ARTIFACT_OWNER_FORBIDDEN');
  await buddy.call('put_text_artifact', { ...artifactRequest, requestId: req('outside-path'), artifactId: '../escape' }, '*');
  await buddy.call('put_text_artifact', { ...artifactRequest, requestId: req('file-path-arg'), artifactId: 'no_file_path', filePath: oldHubFixture }, '*');
  await buddy.call('put_text_artifact', { ...artifactRequest, requestId: req('too-large-text'), artifactId: 'oversized', text: '中'.repeat(11000) }, 'TEXT_LIMIT');
  await buddy.call('send_message', { requestId: req('too-large-message'), recipient: 'manager', body: '中'.repeat(11000), replyTo: null }, 'TEXT_LIMIT');
  await buddy.call('put_text_artifact', { ...artifactRequest, requestId: req('invalid-unicode'), artifactId: 'invalid_text', text: '\uD800' }, 'INVALID_UTF8_TEXT');
  const a2 = await buddy.call('put_text_artifact', { ...artifactRequest, requestId: req('text-v2'), version: 2, text: '版本二：只新增新版。' });
  check('新版追加，旧版正文保持', () => { assert.equal(a2.artifact.version, 2); assert.equal(fs.readFileSync(a1.artifact.filePath, 'utf8'), artifactRequest.text); });
  const outsideDir = path.join(PROJECT_ROOT, 'outside-fixture'); fs.mkdirSync(outsideDir, { recursive: true });
  const linkedId = 'linked_fixture';
  fs.symlinkSync(outsideDir, path.join(PARTNER_ARTIFACT_ROOT, 'versions', 'workbuddy', linkedId), 'junction');
  await buddy.call('put_text_artifact', { ...artifactRequest, requestId: req('junction-escape'), artifactId: linkedId }, 'REALPATH_OUTSIDE_SCOPE');
  const badDb = new PeerClient('manager', 'outside-db', oldHubFixture);
  await assert.rejects(() => badDb.connect()); check('伙伴数据库不能指向原桥 hub 文件', () => assert.equal(sha256(fs.readFileSync(oldHubFixture)), oldHash));
  const wrongRole = new PeerClient('codex', 'wrong-role'); await assert.rejects(() => wrongRole.connect()); checks.push({ name: '旧角色不能启动伙伴通道', passed: true });
  const oldServerRole = new PeerClient('workbuddy', 'old-hub-workbuddy', path.join(RUNTIME_ROOT, 'legacy-role-test.sqlite'), 'server.mjs');
  await assert.rejects(() => oldServerRole.connect()); checks.push({ name: '原 Hub 仍拒绝 workbuddy 角色', passed: true });
  const concurrent = new PeerClient('manager', 'concurrent-manager'); await concurrent.connect();
  const concurrentArgs = { requestId: req('concurrent-submit'), recipient: 'workbuddy', body: '并发去重样本', replyTo: null };
  const [c1, c2] = await Promise.all([manager.call('send_message', concurrentArgs), concurrent.call('send_message', concurrentArgs)]);
  check('跨进程并发请求只创建一条消息', () => assert.equal(c1.message.messageId, c2.message.messageId));
  await Promise.all([manager.close(), buddy.close(), concurrent.close()]);
  manager = new PeerClient('manager', 'manager-restarted'); buddy = new PeerClient('workbuddy', 'workbuddy-restarted'); await Promise.all([manager.connect(), buddy.connect()]);
  const recovered = await buddy.call('get_message', { messageId: sent.message.messageId });
  check('重启恢复原 messageId 与读取时间', () => { assert.equal(recovered.message.readAt, readAck.message.readAt); assert.equal(recovered.message.status, 'read'); });
  const recoveredAck = await buddy.call('get_message', { messageId: receivedAck.messageId });
  check('重启保留真实工具写入的 ACK', () => assert.equal(JSON.parse(recoveredAck.message.body).nonce, nonce));
  const recoveredText = await manager.call('get_text_artifact', { artifactId: 'fixture_text', version: 1 });
  check('重启保留旧版文本及哈希', () => assert.deepEqual(recoveredText, r1));
  const replay = await manager.call('send_message', { requestId: req('challenge'), recipient: 'workbuddy', body: challenge, replyTo: null });
  check('重启后相同请求仍不重新派发', () => assert.equal(replay.message.messageId, sent.message.messageId));
  fs.writeFileSync(a2.artifact.filePath, '离线篡改测试样本', 'utf8');
  await manager.call('get_text_artifact', { artifactId: 'fixture_text', version: 2 }, 'ARTIFACT_TAMPERED');
  const summary = { status: 'passed', runId, checks, dbPath, logDir, fixtureRoot: FIXTURE_ROOT, oldHubSentinelHashUnchanged: sha256(fs.readFileSync(oldHubFixture)) === oldHash,
    managerAckMessageId: actualAck.message.messageId, source: 'local_test_only', realWorkBuddyVerified: false, modelStarts: 0 };
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, summaryPath: path.join(logDir, 'summary.json'), realWorkBuddyVerified: false, modelStarts: 0 }, null, 2));
} catch (error) { fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ message: error.message, checks, stack: error.stack }, null, 2), 'utf8'); console.error(error); process.exitCode = 1; }
finally { await Promise.allSettled(clients.map(client => client.close())); }
