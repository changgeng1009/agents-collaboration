import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { buildClaudeCodePlan, readSessionConfiguration } from '../bridge/src/claude-code-adapter.mjs';
import { SESSION_TOOL_NAMES } from '../bridge/src/session-tools.mjs';
import { sessionCapability } from '../bridge/src/session-capabilities.mjs';
import { SESSION_RUNTIME_ROOT, TASK_WORKSPACE_ROOT } from '../bridge/src/session-store.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const runId = randomUUID(), logDir = path.join(FIXTURE_ROOT, 'logs', 'session-tests', runId);
fs.mkdirSync(logDir, { recursive: true });
const clients = [], checks = [], req = label => `${runId}-${label}`;
const check = (name, callback) => { callback(); checks.push({ name, passed: true }); };
class Peer {
  constructor(label, source = 'tests/session-fixture-server.mjs', role = 'manager', behavior = 'normal') { this.label = label; this.source = source; this.role = role; this.behavior = behavior; clients.push(this); }
  async connect() {
    this.client = new Client({ name: 'local_session_test_not_platform', version: '0.1.5' });
    this.transport = new StdioClientTransport({ command: process.execPath, args: [path.join(CODE_ROOT, this.source), '--role', this.role, ...(this.source.startsWith('tests/') ? ['--behavior', this.behavior] : [])],
      env: { ...getDefaultEnvironment(), COLLAB_PROJECT_ROOT: FIXTURE_ROOT, COLLAB_TEST_MODE: '1' }, stderr: 'pipe' });
    this.transport.stderr.on('data', bytes => fs.appendFileSync(path.join(logDir, `${this.label}-stderr.txt`), bytes));
    const send = this.transport.send.bind(this.transport); this.transport.send = message => { this.log('client_to_server', message); return send(message); };
    let callback;
    Object.defineProperty(this.transport, 'onmessage', { configurable: true, get: () => callback, set: handler => { callback = message => { this.log('server_to_client', message); handler?.(message); }; } });
    await this.client.connect(this.transport);
  }
  log(direction, message) { fs.appendFileSync(path.join(logDir, `${this.label}-wire.jsonl`), JSON.stringify({ at: new Date().toISOString(), source: 'local_test', direction, message }) + '\n', 'utf8'); }
  async call(name, args = {}, expectedError = null) {
    const result = await this.client.callTool({ name, arguments: args });
    if (expectedError) { assert.equal(result.isError, true); if (expectedError !== '*') assert.equal(result.structuredContent?.code, expectedError); checks.push({ name: `${name} 拒绝 ${expectedError}`, passed: true }); return result.structuredContent; }
    assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent;
  }
  async close() { await this.client?.close(); }
}
const createArgs = (taskId, label = taskId, prompt = { text: '你好，中文第一轮。' }) => ({ requestId: req(label), taskId, platform: 'claude', mode: 'code_cli', prompt: JSON.stringify(prompt) });
const binding = (taskId, conversationId) => ({ taskId, platform: 'claude', mode: 'code_cli', conversationId });
const launchCount = workspace => fs.existsSync(path.join(workspace.work, 'fixture-launches.jsonl')) ? fs.readFileSync(path.join(workspace.work, 'fixture-launches.jsonl'), 'utf8').trim().split('\n').length : 0;

try {
  const normal = new Peer('normal'); await normal.connect();
  const second = new Peer('second'); await second.connect();
  const prodHub = new Peer('production-hub', 'bridge/src/server.mjs', 'codex'); await prodHub.connect();
  const prodPartner = new Peer('production-partner', 'bridge/src/partner-server.mjs', 'workbuddy'); await prodPartner.connect();
  for (const peer of [prodHub, prodPartner]) {
    const tools = await peer.client.listTools(); check(`${peer.label} 共用六项严格会话工具`, () => { for (const name of SESSION_TOOL_NAMES) assert.ok(tools.tools.some(tool => tool.name === name)); });
    const caps = await peer.call('get_session_capabilities');
    check(`${peer.label} 三平台模式默认关闭且编号为空`, () => { assert.ok(caps.capabilities.length >= 10); for (const cap of caps.capabilities) { assert.equal(cap.enabled, false); assert.equal(cap.runtimeVerified, false); assert.equal(cap.conversationId, null); assert.equal(cap.fileAccessBoundary.verified, false); } });
  }
  const prepared = await prodHub.call('prepare_task_workspace', { requestId: req('disabled-workspace'), taskId: 'disabled_task' });
  const disabled = await prodHub.call('create_conversation', createArgs('disabled_task'), 'ADAPTER_DISABLED');
  check('未启用在外部副作用前拒绝且无假平台编号', () => { assert.equal(disabled.conversationId, null); assert.equal(disabled.capability.enabled, false); assert.equal(launchCount(prepared.workspace), 0); });
  await prodHub.call('create_conversation', { ...createArgs('disabled_task', 'desktop-disabled'), mode: 'desktop' }, 'NO_DOCUMENTED_INTERFACE');
  await prodHub.call('create_conversation', { ...createArgs('disabled_task', 'doubao-disabled'), platform: 'doubao', mode: 'openapi' }, 'CAPABILITY_UNVERIFIED');
  await prodHub.call('create_conversation', { ...createArgs('disabled_task', 'cloud-disabled'), platform: 'workbuddy', mode: 'cloud' }, 'LOCAL_DIRECTORY_UNSUPPORTED');
  await prodHub.call('get_session_capabilities', { platform: 'claude' }, 'EXPLICIT_MODE_REQUIRED');
  await normal.call('prepare_task_workspace', { requestId: req('path-args'), taskId: 'safe_task', cwd: path.dirname(FIXTURE_ROOT) }, '*');
  await normal.call('prepare_task_workspace', { requestId: req('device-name'), taskId: 'CON' }, 'TASK_ID_INVALID');
  await normal.call('prepare_task_workspace', { requestId: req('parent-path'), taskId: '../outside' }, '*');
  const prepArgs = { requestId: req('workspace-a'), taskId: 'task_a' };
  const [prepA, prepSame] = await Promise.all([normal.call('prepare_task_workspace', prepArgs), second.call('prepare_task_workspace', prepArgs)]);
  const workspace = prepA.workspace;
  check('跨进程准备幂等且任务根为 cwd', () => { assert.equal(prepSame.workspace.markerSha256, workspace.markerSha256); assert.equal(workspace.cwd, workspace.taskRoot); assert.equal(fs.realpathSync(workspace.inputs), workspace.inputs); assert.equal(prepared.platformConversationCreated, false); });
  fs.writeFileSync(path.join(workspace.inputs, '中文资料.txt'), '独立输入文件。', 'utf8');
  await normal.call('prepare_task_workspace', { ...prepArgs, taskId: 'other_task' }, 'REQUEST_ID_CONFLICT');
  const create = createArgs('task_a', 'create-a', { text: '中文第一轮', largeId: true, delayMs: 180 });
  const competing = await Promise.all([normal.call('create_conversation', create), second.call('create_conversation', create)]);
  const first = competing.find(response => response.turn.status === 'succeeded'), concurrent = competing.find(response => response.deduplicated);
  check('同 request 跨进程占位只启动一次并保持超安全整数原串', () => { assert.equal(first.conversationId, '900719925474099312345'); assert.equal(first.session.idSource, 'system.init.session_id'); assert.equal(concurrent.deduplicated, true); assert.equal(launchCount(workspace), 1); });
  check('平台目录与文件/操作系统边界各自记录', () => { assert.equal(first.turn.result.workingDirectoryVerified, true); assert.equal(first.session.runtimeVerified, false); assert.equal(first.turn.result.fileAccessBoundaryVerified, false); assert.equal(first.turn.result.osIsolationVerified, false); assert.equal(first.evidenceLevel, 'local_test'); });
  check('进程启动不等于模型请求，CLI 内部重试保持未知', () => { assert.equal(first.turn.processStarted, true); assert.equal(first.turn.modelRequestState, 'not_model_local_test'); assert.equal(first.turn.cliInternalRetryStatus, 'unknown'); assert.equal(first.turn.modelStarted, undefined); });
  const disabledReplay = new Peer('disabled-replay', 'bridge/src/partner-server.mjs', 'manager'); await disabledReplay.connect();
  const historical = await disabledReplay.call('create_conversation', create);
  check('关闭适配器或没有 launcher 仍能读取原幂等回执', () => { assert.equal(historical.deduplicated, true); assert.equal(historical.conversationId, first.conversationId); assert.equal(launchCount(workspace), 1); });
  const acceptedCap = sessionCapability('claude', 'code_cli', { enabled: false, acceptedProductMode: true });
  check('已接受产品模式与未启用执行分别表达', () => { assert.equal(acceptedCap.productModeAccepted, true); assert.equal(acceptedCap.enabled, false); assert.ok(acceptedCap.disabledReason.includes('已接受')); });
  await second.call('create_conversation', { ...create, prompt: JSON.stringify({ text: '不同正文' }) }, 'REQUEST_ID_CONFLICT');
  await second.call('create_conversation', createArgs('task_a', 'new-create-id'), 'CREATE_ALREADY_CLAIMED');
  await normal.call('send_to_conversation', { ...binding('task_a', 'task_a'), requestId: req('fake-id'), prompt: '错误编号' }, 'CONVERSATION_BINDING_MISMATCH');
  await normal.call('send_to_conversation', { ...binding('task_a', first.conversationId), platform: 'workbuddy', mode: 'desktop', requestId: req('wrong-platform'), prompt: '错误平台' }, 'CONVERSATION_BINDING_MISMATCH');
  await normal.call('send_to_conversation', { ...binding('task_a', first.conversationId), requestId: req('launcher-injection'), prompt: '不允许', executable: process.execPath }, '*');
  const sendArgs = { ...binding('task_a', first.conversationId), requestId: req('second-turn'), prompt: JSON.stringify({ text: '中文第二轮', largeId: true, delayMs: 450 }) };
  const sending = normal.call('send_to_conversation', sendArgs);
  const deadline = Date.now() + 1500; while (launchCount(workspace) < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  await second.call('send_to_conversation', { ...sendArgs, requestId: req('concurrent-new-turn') }, 'CONVERSATION_NOT_READY');
  const sent = await sending;
  const read = await second.call('read_conversation', binding('task_a', first.conversationId));
  const completed = await second.call('get_conversation_result', binding('task_a', first.conversationId));
  check('两轮 create/resume 读取实际捕获正文和结果', () => { assert.equal(sent.conversationId, first.conversationId); assert.deepEqual(read.replies, ['中文第一轮 / 中文第二轮']); assert.equal(completed.result.status, 'succeeded'); assert.equal(completed.importedAccountHistory, false); assert.equal(completed.source, 'captured_platform_events'); });
  const launches = fs.readFileSync(path.join(workspace.work, 'fixture-launches.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('中文 stdin 与固定安全参数，无生成或隐式续接编号', () => { assert.equal(JSON.parse(launches[1].prompt).text, '中文第二轮'); const args = launches[1].argv; assert.equal(args[args.indexOf('--resume') + 1], first.conversationId); assert.equal(args[args.indexOf('--tools') + 1], ''); assert.equal(args[args.indexOf('--setting-sources') + 1], ''); assert.ok(args.includes('--strict-mcp-config')); assert.ok(!args.includes('--session-id')); assert.ok(!args.includes('--continue')); assert.ok(!args.includes('--bare')); assert.ok(!args.includes('--fork-session')); });
  const stream = fs.readFileSync(path.join(sent.turn.workDirectory, 'native-stream.jsonl'), 'utf8');
  check('原生事件留存但凭据字段已脱敏', () => { assert.ok(stream.includes('session_id')); assert.ok(!stream.includes('fixture_redaction_value')); });
  check('输入、原生工作流和最终输出分别落盘', () => { assert.ok(sent.turn.inputDirectory.startsWith(workspace.inputs)); assert.ok(sent.turn.workDirectory.startsWith(workspace.work)); assert.ok(sent.turn.outputDirectory.startsWith(workspace.outputs)); });
  await normal.close(); const restarted = new Peer('restarted'); await restarted.connect();
  const recovered = await restarted.call('get_conversation_result', binding('task_a', first.conversationId));
  check('重启保留绑定、平台原串与结果，无再启动', () => { assert.equal(recovered.session.conversationId, first.conversationId); assert.equal(recovered.result.result.result, '中文第一轮 / 中文第二轮'); assert.equal(launchCount(workspace), 2); });
  const capsAfter = await restarted.call('get_session_capabilities', { platform: 'claude', mode: 'code_cli' });
  check('local_test 不能提升真实能力状态', () => { assert.equal(capsAfter.runtimeVerified, false); assert.equal(capsAfter.enabled, false); });
  const other = await restarted.call('prepare_task_workspace', { requestId: req('workspace-b'), taskId: 'task_b' });
  const spare = path.join(FIXTURE_ROOT, 'saved-inputs'); fs.renameSync(workspace.inputs, spare); fs.symlinkSync(other.workspace.inputs, workspace.inputs, 'junction');
  await restarted.call('send_to_conversation', { ...sendArgs, requestId: req('junction-send') }, 'WORKSPACE_LINK_FORBIDDEN');
  fs.unlinkSync(workspace.inputs); fs.renameSync(spare, workspace.inputs);
  fs.renameSync(workspace.work, path.join(FIXTURE_ROOT, 'saved-work')); fs.mkdirSync(workspace.work);
  await restarted.call('send_to_conversation', { ...sendArgs, requestId: req('replaced-dir-send') }, 'WORKSPACE_IDENTITY_MISMATCH');
  check('同项目联接和同路径重建不触发续发', () => assert.equal(launchCount(workspace), 0));
  const cases = { wrong_id: 'NATIVE_ID_MISMATCH', wrong_cwd: 'CWD_MISMATCH', missing_init: 'NATIVE_ID_MISSING', numeric_id: 'NATIVE_ID_MISSING', missing_result: 'RESULT_MISSING', incomplete_json: 'PROTOCOL_INVALID', output_limit: 'OUTPUT_TRUNCATED', timeout: 'TIMEOUT_UNKNOWN', nonzero: 'PROCESS_EXIT_FAILED', error_result: 'PLATFORM_RESULT_FAILED', tool_violation: 'TEXT_MODE_VIOLATION', missing_tools: 'TEXT_MODE_STATE_UNVERIFIED', missing_mcp: 'MCP_STATE_UNVERIFIED', mcp_violation: 'TEXT_MODE_VIOLATION' };
  for (const [scenario, reason] of Object.entries(cases)) {
    const taskId = `case_${scenario}`, prep = await restarted.call('prepare_task_workspace', { requestId: req(`prepare-${scenario}`), taskId });
    const response = await restarted.call('create_conversation', createArgs(taskId, `create-${scenario}`, { scenario, text: '故障协议样本' }));
    check(`保留 ${scenario} 的真实失败或未知`, () => { assert.equal(response.turn.result.reason, reason); assert.notEqual(response.turn.status, 'succeeded'); assert.equal(response.session.runtimeVerified, false); });
    await second.call('create_conversation', createArgs(taskId, `retry-${scenario}`), 'CREATE_ALREADY_CLAIMED');
    check(`${scenario} 不因新 requestId 再启动`, () => assert.equal(launchCount(prep.workspace), 1));
  }
  const crash = new Peer('crash-owner', 'tests/session-fixture-server.mjs', 'manager', 'crash_after_claim'); await crash.connect();
  const crashWorkspace = await crash.call('prepare_task_workspace', { requestId: req('prepare-crash'), taskId: 'crash_task' });
  await assert.rejects(() => crash.call('create_conversation', createArgs('crash_task', 'crash-create')));
  const afterCrash = await second.call('get_conversation_result', binding('crash_task', null));
  check('占位后进程崩溃保留 unknown，未启动协议进程', () => { assert.equal(afterCrash.result.reason, 'OWNER_EXITED'); assert.equal(launchCount(crashWorkspace.workspace), 0); });
  await second.call('create_conversation', createArgs('crash_task', 'crash-new-request'), 'CREATE_ALREADY_CLAIMED');
  const orphan = path.join(TASK_WORKSPACE_ROOT, 'unregistered_task'); fs.mkdirSync(orphan);
  await second.call('prepare_task_workspace', { requestId: req('unregistered'), taskId: 'unregistered_task' }, 'UNREGISTERED_WORKSPACE_EXISTS');
  const replacement = await second.call('prepare_task_workspace', { requestId: req('prepare-root-replaced'), taskId: 'root_replaced' });
  fs.renameSync(replacement.workspace.taskRoot, path.join(FIXTURE_ROOT, 'saved-task-root')); fs.mkdirSync(replacement.workspace.taskRoot);
  await second.call('create_conversation', createArgs('root_replaced'), 'WORKSPACE_IDENTITY_MISMATCH');
  fs.symlinkSync(path.dirname(FIXTURE_ROOT), path.join(TASK_WORKSPACE_ROOT, 'escape_link'), 'junction');
  await second.call('prepare_task_workspace', { requestId: req('escape-link'), taskId: 'escape_link' }, 'REALPATH_OUTSIDE_SCOPE');
  await second.call('create_conversation', createArgs('task_b', 'oversized-prompt', '中'.repeat(11000)), 'PROMPT_INVALID');
  await prodPartner.call('read_conversation', binding('crash_task', null), 'TASK_OWNER_FORBIDDEN');
  const config = readSessionConfiguration(); check('隔离测试不读真实启用配置', () => assert.equal(config.enabled, false));
  assert.throws(() => buildClaudeCodePlan({ enabled: true, acceptedProductMode: true, executable: path.join(FIXTURE_ROOT, 'shim.ps1') }, FIXTURE_ROOT), error => error.code === 'LAUNCHER_INVALID');
  checks.push({ name: '拒绝 PowerShell shim，无 shell 拼接', passed: true });
  const proofWorkspace = await second.call('prepare_task_workspace', { requestId: req('prepare-proof'), taskId: 'proof_task' });
  const proof = await second.call('create_conversation', createArgs('proof_task'));
  const tamperTarget = proof.turn.evidenceFiles.find(file => file.file.endsWith('captured-result.json')); fs.appendFileSync(tamperTarget.file, '改动', 'utf8');
  await second.call('get_conversation_result', binding('proof_task', proof.conversationId), 'EVIDENCE_TAMPERED');
  await second.call('send_to_conversation', { ...binding('proof_task', proof.conversationId), requestId: req('tampered-send'), prompt: '禁止续发' }, 'EVIDENCE_TAMPERED');
  check('证据篡改独立拒绝，不启动新的轮次', () => assert.equal(launchCount(proofWorkspace.workspace), 1));
  const summary = { status: 'passed', checks, source: 'local_test', modelStarts: 0, realConversationsCreated: 0, runtimeVerified: false,
    fixtureRoot: FIXTURE_ROOT, sessionDatabase: path.join(SESSION_RUNTIME_ROOT, 'sessions.sqlite'), logDir, fixtureLaunchesOnly: true, authenticationRead: false };
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(JSON.stringify({ status: 'passed', assertions: checks.length, summaryPath: path.join(logDir, 'summary.json'), modelStarts: 0, runtimeVerified: false }, null, 2));
} catch (error) { fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, source: 'local_test' }, null, 2), 'utf8'); console.error(error); process.exitCode = 1; }
finally { await Promise.allSettled(clients.map(client => client.close())); }
