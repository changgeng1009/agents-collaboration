import { CODE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, ARTIFACT_ROOT, RUNTIME_ROOT, LOG_ROOT, sha256 } from '../bridge/src/policy.mjs';
import { buildExecPlan, parseCodexEvents, hashOutputs, cleanRouteEnvironment, publicExecPlan } from '../bridge/src/codex-adapter.mjs';

const runId = randomUUID();
const logDir = path.join(LOG_ROOT, 'tests', runId);
const fixtureDir = path.join(ARTIFACT_ROOT, 'local-tests', runId);
const dbPath = path.join(RUNTIME_ROOT, 'tests', runId, 'hub.sqlite');
fs.mkdirSync(logDir, { recursive: true }); fs.mkdirSync(fixtureDir, { recursive: true });
const scopeFixtureDir = path.join(PROJECT_ROOT, 'docs'); fs.mkdirSync(scopeFixtureDir, { recursive: true });
fs.writeFileSync(path.join(scopeFixtureDir, 'scope-fixture.txt'), '只用于目录范围拒绝的离线测试样本。', 'utf8');
const checks = [], clients = [];
const check = (name, callback) => { callback(); checks.push({ name, passed: true }); };
let currentPhase = 'initialize';

class RpcClient {
  constructor(role, serverPath = path.join(CODE_ROOT, 'bridge', 'src', 'server.mjs'), label = role, executable = process.execPath, databasePath = dbPath) {
    this.role = role; this.nextId = 1; this.pending = new Map(); this.closed = false;
    this.wirePath = path.join(logDir, `${label}-wire.jsonl`);
    this.child = spawn(executable, [serverPath, '--role', role, '--db', databasePath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.on('data', bytes => fs.appendFileSync(path.join(logDir, `${label}-stderr.txt`), bytes));
    this.child.on('error', error => { for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(error); } this.pending.clear(); });
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => {
      this.closed = true;
      for (const wait of this.pending.values()) { clearTimeout(wait.timer); wait.reject(new Error(`MCP 进程退出：${code}/${signal}`)); }
      this.pending.clear(); resolve({ code, signal });
    }));
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { throw new Error(`stdout 出现非 JSON-RPC 内容：${line}`); }
      this.log('server_to_client', message);
      const wait = this.pending.get(message.id);
      if (wait) { clearTimeout(wait.timer); this.pending.delete(message.id); message.error ? wait.reject(new Error(JSON.stringify(message.error))) : wait.resolve(message.result); }
    });
    clients.push(this);
  }
  log(direction, message) { fs.appendFileSync(this.wirePath, JSON.stringify({ at: new Date().toISOString(), phase: currentPhase, role: this.role, direction, message }) + '\n', 'utf8'); }
  async request(method, params) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`请求超时：${method}`)); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
    });
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    this.log('client_to_server', message);
    this.child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
    return result;
  }
  async init() {
    const result = await this.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'T1-本地验收客户端', version: '0.1.0' } });
    const message = { jsonrpc: '2.0', method: 'notifications/initialized' };
    this.log('client_to_server', message); this.child.stdin.write(JSON.stringify(message) + '\n', 'utf8');
    return result;
  }
  async call(name, args = {}, { error = null } = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    if (error) {
      assert.equal(result.isError, true, `应拒绝 ${name}`);
      const body = error === '*' ? { message: result.content[0].text } : JSON.parse(result.content[0].text);
      if (error !== '*') assert.equal(body.code, error, result.content[0].text);
      checks.push({ name: `${name} 拒绝 ${error}`, passed: true });
      return body;
    }
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent ?? (name === 'get_artifact' ? result : JSON.parse(result.content[0].text));
  }
  async close() {
    if (this.closed) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 3000);
    await this.exited; clearTimeout(timer);
  }
}

const req = label => `${runId}-${label}`;
const textFile = path.join(fixtureDir, 'result.txt');
const imageFile = path.join(fixtureDir, 'fixture.png');
fs.writeFileSync(textFile, '版本一：中文通信闭环已完成。\n', 'utf8');
// 仅作离线内容传输测试的 1x1 PNG；不调用生图模型，不计作补图成果。
fs.writeFileSync(imageFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRMsAAAAASUVORK5CYII=', 'base64'));
const execution = { executionId: `local-${runId}`, kind: 'local_validation', sessionId: null, usage: 'unknown' };

try {
  let planner = new RpcClient('claude'); let executor = new RpcClient('codex');
  const [initP, initX] = await Promise.all([planner.init(), executor.init()]);
  check('两个独立 stdio 进程完成 initialize', () => { assert.equal(initP.serverInfo.name, 'ai-collaboration-t1'); assert.equal(initX.serverInfo.name, 'ai-collaboration-t1'); });
  const listed = await planner.request('tools/list');
  check('真实 tools/list 返回 12 项工具', () => assert.equal(listed.tools.length, 12));
  const capabilities = await planner.call('get_capabilities');
  check('模型执行与豆包能力保持关闭', () => { assert.equal(capabilities.modelExecutionEnabled, false); assert.equal(capabilities.doubaoEnabled, false); });
  currentPhase = 'fresh_database_concurrent_startup';
  const startupClients = [];
  for (let index = 0; index < 6; index++) {
    const startupDb = path.join(RUNTIME_ROOT, 'tests', runId, `startup-${index}.sqlite`);
    startupClients.push(new RpcClient('claude', undefined, `startup-${index}-claude`, process.execPath, startupDb), new RpcClient('codex', undefined, `startup-${index}-codex`, process.execPath, startupDb));
  }
  await Promise.all(startupClients.map(client => client.init()));
  check('6 个全新数据库各 2 进程同时初始化通过', () => assert.equal(startupClients.length, 12));
  await Promise.all(startupClients.map(client => client.close()));
  currentPhase = 'task_and_question';
  const submission = { requestId: req('submit'), title: 'T1 本地通信协议演示', goal: '提交任务、双向问答、读取真实中文产物。', acceptance: ['原样返回中文内容', '登记指定版本与 SHA256'], inputs: [] };
  const assigned = await planner.call('submit_task', submission);
  const taskId = assigned.task.taskId;
  const duplicate = await planner.call('submit_task', submission);
  check('重复派单仅建立一个任务', () => { assert.equal(duplicate.task.taskId, taskId); assert.equal(duplicate.deduplicated, true); });
  await planner.call('submit_task', { ...submission, title: '同编号不同内容' }, { error: 'REQUEST_ID_CONFLICT' });
  await executor.call('submit_task', { ...submission, requestId: req('wrongrole') }, { error: 'ROLE_FORBIDDEN' });
  await executor.call('submit_task', { ...submission, requestId: req('forged'), sender: 'claude' }, { error: '*' });
  await planner.call('submit_task', { ...submission, requestId: req('wrongproject'), projectId: 'other-project' }, { error: '*' });
  await executor.call('ack_message', { requestId: req('early-ack'), messageId: assigned.message.messageId }, { error: 'DELIVERY_REQUIRED' });
  const inbox = await executor.call('read_messages', { requestId: req('inbox'), taskId, unreadOnly: true });
  check('入队与送达分开，送达不自动变为已读', () => { assert.equal(assigned.message.status, 'queued'); assert.equal(inbox.messages[0].status, 'delivered'); assert.equal(inbox.messages[0].readAt, null); });
  await executor.call('start_task', { requestId: req('early-start'), taskId }, { error: 'READ_ACK_REQUIRED' });
  const ack = await executor.call('ack_message', { requestId: req('task-ack'), messageId: assigned.message.messageId });
  await executor.call('start_task', { requestId: req('start'), taskId });
  const q = await executor.call('send_message', { requestId: req('question'), taskId, recipient: 'claude', kind: 'question', body: '请确认结果采用中文。', replyTo: null });
  await planner.call('read_messages', { requestId: req('planner-inbox'), taskId, unreadOnly: true });
  await planner.call('ack_message', { requestId: req('question-ack'), messageId: q.message.messageId });
  const answer = await planner.call('send_message', { requestId: req('answer'), taskId, recipient: 'codex', kind: 'answer', body: '已确认，使用简体中文。', replyTo: q.message.messageId });
  const xInbox = await executor.call('read_messages', { requestId: req('answer-inbox'), taskId, unreadOnly: true });
  check('问题与回复按 messageId/任务编号双向关联', () => { assert.equal(answer.message.replyTo, q.message.messageId); assert.ok(xInbox.messages.some(m => m.body === '已确认，使用简体中文。')); });
  await executor.call('ack_message', { requestId: req('answer-ack'), messageId: answer.message.messageId });
  await planner.call('ack_message', { requestId: req('wrong-ack'), messageId: answer.message.messageId }, { error: 'RECIPIENT_FORBIDDEN' });
  const a1 = await executor.call('register_artifact', { requestId: req('artifact-v1'), taskId, artifactId: 'communication_result', version: 1, filePath: textFile, mimeType: 'text/plain', origin: '离线本地测试，非模型产物' });
  await executor.call('register_artifact', { requestId: req('path-escape'), taskId, artifactId: 'outside', version: 1, filePath: path.join(scopeFixtureDir, 'scope-fixture.txt'), mimeType: 'text/plain', origin: '越界拒绝测试' }, { error: 'PATH_OUTSIDE_SCOPE' });
  const junction = path.join(fixtureDir, 'outside-junction');
  fs.symlinkSync(scopeFixtureDir, junction, 'junction');
  await executor.call('register_artifact', { requestId: req('junction-escape'), taskId, artifactId: 'junction_escape', version: 1, filePath: path.join(junction, 'scope-fixture.txt'), mimeType: 'text/plain', origin: '联接越界拒绝测试' }, { error: 'REALPATH_OUTSIDE_SCOPE' });
  const png = await executor.call('register_artifact', { requestId: req('png'), taskId, artifactId: 'fixture_png', version: 1, filePath: imageFile, mimeType: 'image/png', origin: '1x1 离线协议测试图片，非补图' });
  const pngRead = await planner.call('get_artifact', { artifactId: 'fixture_png', version: 1 });
  check('返回真实图片块，与登记 PNG 字节一致', () => assert.equal(sha256(Buffer.from(pngRead.content[1].data, 'base64')), png.artifact.sha256));
  const refs = [{ artifactId: 'communication_result', version: 1 }, { artifactId: 'fixture_png', version: 1 }];
  const completed = await executor.call('complete_task', { requestId: req('complete'), taskId, summary: '本地中文问答与产物传输完成。', artifacts: refs, execution });
  const pResultInbox = await planner.call('read_messages', { requestId: req('result-inbox'), taskId, unreadOnly: true });
  check('结果进入 Claude 收件箱，任务只到待审核', () => { assert.equal(completed.task.status, 'awaiting_review'); assert.ok(pResultInbox.messages.some(m => m.kind === 'result')); });
  await planner.call('ack_message', { requestId: req('result-ack'), messageId: completed.message.messageId });
  const text = await planner.call('get_artifact', { artifactId: 'communication_result', version: 1 });
  check('产物读取返回真实中文文本与 SHA256', () => { assert.equal(text.content[1].text, '版本一：中文通信闭环已完成。\n'); assert.equal(a1.artifact.sha256, sha256(Buffer.from(text.content[1].text, 'utf8'))); });
  await executor.call('submit_review', { requestId: req('wrong-review'), artifactId: 'communication_result', version: 1, verdict: 'passed', basis: '执行方不能审核' }, { error: 'ROLE_FORBIDDEN' });
  await planner.call('send_message', { requestId: req('no-approval-message'), taskId, recipient: 'codex', body: '通过', kind: 'message', replyTo: null });
  check('普通消息不改变审核状态', () => assert.equal(completed.task.status, 'awaiting_review'));
  const beforeReview = await planner.call('get_task', { taskId });
  check('读回确认普通消息未通过任务', () => assert.equal(beforeReview.task.status, 'awaiting_review'));
  await planner.call('submit_review', { requestId: req('review-text'), artifactId: 'communication_result', version: 1, verdict: 'passed', basis: '实际读取中文文本并核对 SHA256。' });
  await planner.call('submit_review', { requestId: req('review-png'), artifactId: 'fixture_png', version: 1, verdict: 'passed', basis: '实际读取测试 PNG 字节。' });
  const savedState = await planner.call('get_task', { taskId });
  currentPhase = 'restart';
  await Promise.all([planner.close(), executor.close()]);
  planner = new RpcClient('claude', undefined, 'claude-restarted'); executor = new RpcClient('codex', undefined, 'codex-restarted');
  await Promise.all([planner.init(), executor.init()]);
  const recovered = await planner.call('get_task', { taskId });
  const recoveredInbox = await executor.call('read_messages', { requestId: req('recovered-inbox'), taskId, unreadOnly: false });
  check('重启后任务与版本审核记录保留', () => assert.deepEqual(recovered, savedState));
  check('重启后原读取确认时间与执行状态保留', () => { const original = recoveredInbox.messages.find(m => m.messageId === assigned.message.messageId); assert.equal(original.readAt, ack.message.readAt); assert.equal(original.status, 'executed'); assert.ok(original.executedAt); });
  const replay = await planner.call('submit_task', submission);
  check('重启后重复请求仍不重新派发', () => assert.equal(replay.task.taskId, taskId));
  currentPhase = 'input_version_invalidation';
  const downstream = await planner.call('submit_task', { requestId: req('downstream'), title: '下游输入版本测试', goal: '依赖上游 v1', acceptance: ['上游升级后旧结论失效'], inputs: [{ artifactId: 'communication_result', version: 1 }] });
  const downId = downstream.task.taskId;
  await executor.call('read_messages', { requestId: req('down-inbox'), taskId: downId, unreadOnly: true });
  await executor.call('ack_message', { requestId: req('down-ack'), messageId: downstream.message.messageId });
  await executor.call('start_task', { requestId: req('down-start'), taskId: downId });
  await executor.call('register_artifact', { requestId: req('down-file'), taskId: downId, artifactId: 'downstream_result', version: 1, filePath: textFile, mimeType: 'text/plain', origin: '离线依赖测试' });
  await executor.call('complete_task', { requestId: req('down-complete'), taskId: downId, summary: '使用上游 v1', artifacts: [{ artifactId: 'downstream_result', version: 1 }], execution });
  await planner.call('submit_review', { requestId: req('down-pass'), artifactId: 'downstream_result', version: 1, verdict: 'passed', basis: '上游尚为 v1。' });
  const downBefore = await planner.call('get_task', { taskId: downId });
  check('上游 v1 时下游通过有效', () => assert.equal(downBefore.task.approvalValid, true));
  fs.writeFileSync(textFile, '版本二：只更新指定结果。\n', 'utf8');
  await executor.call('register_artifact', { requestId: req('artifact-v2'), taskId, artifactId: 'communication_result', version: 2, filePath: textFile, mimeType: 'text/plain', origin: '离线版本更新，非模型返工' });
  const downAfter = await planner.call('get_task', { taskId: downId });
  check('上游 v2 后下游旧通过失效', () => { assert.equal(downAfter.task.status, 'needs_recheck'); assert.equal(downAfter.task.approvalValid, false); assert.equal(downAfter.reviews[0].current, false); });
  await planner.call('submit_review', { requestId: req('stale-input-review'), artifactId: 'downstream_result', version: 1, verdict: 'passed', basis: '不能沿用旧输入' }, { error: 'STALE_VERSION' });
  await planner.call('submit_review', { requestId: req('stale-artifact-review'), artifactId: 'communication_result', version: 1, verdict: 'passed', basis: '不能沿用旧产物' }, { error: 'STALE_VERSION' });
  const preserved = await planner.call('get_artifact', { artifactId: 'communication_result', version: 1 });
  check('源文件更新后 v1 仍是原始不可覆盖快照', () => assert.equal(preserved.content[1].text, '版本一：中文通信闭环已完成。\n'));
  await executor.call('complete_task', { requestId: req('complete-v2'), taskId, summary: '上游版本二', artifacts: [{ artifactId: 'communication_result', version: 2 }], execution });
  const rework = await planner.call('submit_review', { requestId: req('rework'), artifactId: 'communication_result', version: 2, verdict: 'rework', basis: '定向返工测试：只修改 communication_result。' });
  const reworkInbox = await executor.call('read_messages', { requestId: req('rework-inbox'), taskId, unreadOnly: true });
  check('定向返工意见实际进入 Codex 收件箱', () => { const message = reworkInbox.messages.find(m => m.messageId === rework.message.messageId); assert.equal(message.kind, 'rework'); assert.equal(JSON.parse(message.body).review.version, 2); });
  currentPhase = 'concurrent_deduplication';
  const concurrentPlanner = new RpcClient('claude', undefined, 'claude-concurrent'); await concurrentPlanner.init();
  const concurrentRequest = { ...submission, requestId: req('concurrent'), title: '并发去重测试' };
  const [c1, c2] = await Promise.all([planner.call('submit_task', concurrentRequest), concurrentPlanner.call('submit_task', concurrentRequest)]);
  check('两个进程并发重复请求只生成一个任务', () => assert.equal(c1.task.taskId, c2.task.taskId));
  const forbidden = new RpcClient('doubao', undefined, 'disabled-doubao');
  const exited = await forbidden.exited;
  check('未启用豆包角色启动被拒绝', () => assert.notEqual(exited.code, 0));
  currentPhase = 'codex_adapter_offline';
  const promptFile = path.join(fixtureDir, 'prompt.txt'); fs.writeFileSync(promptFile, '只做指定本地演示。', 'utf8');
  const plan = buildExecPlan({ taskId: 'T1-DEMO-PREPARED', workspace: fixtureDir, promptFile, outputDirectory: path.join(ARTIFACT_ROOT, 'codex-runs', runId) });
  check('官方单次进程计划不继承自定义 provider 且模型关闭', () => { assert.ok(plan.argv.includes('--ignore-user-config')); assert.ok(plan.argv.includes('model_provider="openai"')); assert.ok(plan.argv.includes('forced_login_method="chatgpt"')); assert.equal(plan.modelExecutionEnabled, false); });
  const mixedEnv = cleanRouteEnvironment({ OpenAI_API_Key: 'fixture-secret', OpenAI_Base_Url: 'fixture-url', CoDeX_Api_Key: 'fixture-key', PATH: 'fixture-path', CODEX_HOME: 'fixture-home' });
  check('Windows 混合大小写路由环境项清理有效', () => { assert.deepEqual(mixedEnv.env, { PATH: 'fixture-path', CODEX_HOME: 'fixture-home' }); assert.equal(mixedEnv.presence.find(x => x.name === 'OPENAI_API_KEY').present, true); });
  check('公开执行计划不能序列化 env', () => { assert.equal(Object.hasOwn(publicExecPlan(plan), 'env'), false); assert.equal(JSON.stringify(publicExecPlan({ ...plan, env: mixedEnv.env })).includes('fixture-home'), false); });
  fs.writeFileSync(path.join(logDir, 'codex-exec-plan-NOT-EXECUTED.json'), JSON.stringify(publicExecPlan(plan), null, 2), 'utf8');
  assert.throws(() => buildExecPlan({ taskId: 'T1', workspace: PROJECT_ROOT, promptFile, outputDirectory: plan.outputDirectory }), { code: 'PATH_OUTSIDE_SCOPE' });
  checks.push({ name: '执行工作区越界被拒绝', passed: true });
  const fixtureEvents = [
    { type: 'thread.started', thread_id: 'fixture-session-not-live' },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'fixture', type: 'agent_message', text: '离线解析测试结果。' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
  ].map(x => JSON.stringify(x)).join('\n') + '\n';
  fs.writeFileSync(path.join(logDir, 'codex-events-FIXTURE.jsonl'), fixtureEvents, 'utf8');
  const parsed = parseCodexEvents(fixtureEvents, { exitCode: 0, executionId: 'fixture-execution-not-live' });
  check('离线事件解析保留会话/最终消息/用量，业务验收仍未验证', () => { assert.equal(parsed.status, 'candidate_completed'); assert.equal(parsed.sessionId, 'fixture-session-not-live'); assert.equal(parsed.businessAcceptance, 'not_verified'); });
  check('官方 snake_case 用量归一化且保留原始证据', () => { assert.deepEqual(parsed.usage, { inputTokens: 1, outputTokens: 1 }); assert.deepEqual(parsed.rawUsage, { input_tokens: 1, output_tokens: 1 }); assert.equal(parseCodexEvents('{"type":"turn.completed"}\n', { exitCode: 0 }).usage, 'unknown'); });
  await executor.call('read_messages', { requestId: req('usage-inbox'), taskId: c1.task.taskId, unreadOnly: true });
  await executor.call('ack_message', { requestId: req('usage-ack'), messageId: c1.message.messageId });
  await executor.call('start_task', { requestId: req('usage-start'), taskId: c1.task.taskId });
  await executor.call('register_artifact', { requestId: req('usage-artifact'), taskId: c1.task.taskId, artifactId: 'usage_result', version: 1, filePath: textFile, mimeType: 'text/plain', origin: '离线事件用量协议回传测试，不是真实模型调用' });
  const usageReturned = await executor.call('complete_task', { requestId: req('usage-complete'), taskId: c1.task.taskId, summary: '离线构造事件用量回传', artifacts: [{ artifactId: 'usage_result', version: 1 }], execution: { executionId: parsed.executionId, kind: 'local_validation', sessionId: parsed.sessionId, usage: parsed.usage } });
  check('事件用量通过真实 complete_task 协议回传', () => assert.deepEqual(usageReturned.task.result.execution.usage, { inputTokens: 1, outputTokens: 1 }));
  check('只有 exit 0 或中断不能伪装成功', () => { assert.equal(parseCodexEvents('', { exitCode: 0 }).status, 'submission_unknown'); assert.equal(parseCodexEvents(fixtureEvents, { exitCode: null }).status, 'submission_unknown'); });
  check('错误事件和坏 JSON 均停止', () => { assert.equal(parseCodexEvents(fixtureEvents + '{"type":"turn.failed"}\n', { exitCode: 0 }).status, 'failed'); assert.equal(parseCodexEvents('bad-json', { exitCode: 0 }).status, 'failed'); });
  fs.writeFileSync(path.join(logDir, 'codex-adapter-FIXTURE-report.json'), JSON.stringify({ ...parsed, fixturesOnly: true, liveModelRequests: 0, outputs: hashOutputs([promptFile]) }, null, 2), 'utf8');
  const finalTask = await planner.call('get_task', { taskId });
  fs.writeFileSync(path.join(logDir, 'final-task.json'), JSON.stringify(finalTask, null, 2), 'utf8');
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify({ status: 'passed', runId, checks, dbPath, fixtureDir, logDir, taskId, downstreamTaskId: downId,
    evidence: '真实本地 stdio/SQLite，Claude 与 Codex 角色由离线客户端扮演', realClaudeConnection: false, realCodexModelExecution: false, realDoubaoConnection: false, generatedImages: 0, generatedVideos: 0 }, null, 2), 'utf8');
  fs.writeFileSync(path.join(LOG_ROOT, 'latest-test-run.json'), JSON.stringify({ runId, summaryPath: path.join(logDir, 'summary.json'), logDir }, null, 2), 'utf8');
  console.log(`通过 ${checks.length} 项业务断言。证据：${path.join(logDir, 'summary.json')}`);
} catch (error) {
  fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ status: 'failed', currentPhase, checks, message: error.message, stack: error.stack }, null, 2), 'utf8');
  console.error(error); process.exitCode = 1;
} finally { await Promise.all(clients.map(client => client.close())); }
