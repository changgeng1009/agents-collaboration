import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { CoworkFileStore, COWORK_TEXT_LIMIT } from '../bridge/src/cowork-store.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const runId = randomUUID(), logDir = path.join(FIXTURE_ROOT, 'logs', 'cowork-tests', runId);
fs.mkdirSync(logDir, { recursive: true });
const peers = [], checks = [], req = label => `${runId}-${label}`;
const check = (name, action) => { action(); checks.push({ name, passed: true }); };
class Peer {
  constructor(label, role = 'claude', audit = false) { this.label = label; this.role = role; this.audit = audit; peers.push(this); }
  async connect() {
    this.client = new Client({ name: `local_cowork_protocol_${this.label}_not_platform`, version: '0.1.5' });
    this.transport = new StdioClientTransport({ command: process.execPath, args: [path.join(CODE_ROOT, 'bridge', 'src', 'cowork-server.mjs'), '--role', this.role,
      ...(this.audit ? ['--audit-log', path.join(logDir, `${this.label}-audit.jsonl`)] : [])], cwd: FIXTURE_ROOT,
      env: { ...getDefaultEnvironment(), COLLAB_PROJECT_ROOT: FIXTURE_ROOT, COLLAB_TEST_MODE: '1' }, stderr: 'pipe' });
    this.transport.stderr.on('data', bytes => fs.appendFileSync(path.join(logDir, `${this.label}-stderr.txt`), bytes));
    const send = this.transport.send.bind(this.transport); this.transport.send = message => { this.log('client_to_server', message); return send(message); };
    let receiver;
    Object.defineProperty(this.transport, 'onmessage', { configurable: true, get: () => receiver, set: handler => { receiver = message => { this.log('server_to_client', message); handler?.(message); }; } });
    await this.client.connect(this.transport, { timeout: 5000 });
  }
  log(direction, message) { fs.appendFileSync(path.join(logDir, `${this.label}-wire.jsonl`), JSON.stringify({ at: new Date().toISOString(), source: 'local_test', direction, message }) + '\n', 'utf8'); }
  async call(name, argumentsValue = {}, error = null) {
    const result = await this.client.callTool({ name, arguments: argumentsValue });
    if (error) { assert.equal(result.isError, true); if (error !== '*') assert.equal(result.structuredContent?.code, error, JSON.stringify(result)); checks.push({ name: `${name} 拒绝 ${error}`, passed: true }); return result.structuredContent; }
    assert.notEqual(result.isError, true, JSON.stringify(result)); return result.structuredContent;
  }
  async close() { await this.client?.close(); }
}
const taskArgs = (taskId, label = taskId) => ({ requestId: req(label), taskId, title: '中文文件交接样本', instructions: '读取输入并生成中文结果；仅协议测试，不调用平台。', acceptance: ['结果为中文', '保留来源未验证'], textInputs: [{ name: '中文资料', text: '测试输入正文。' }] });
const reviewArgs = (taskId, result, label, verdict = 'passed') => ({ requestId: req(label), taskId, version: result.version, sha256: result.sha256, verdict, basis: '只审核本地实际读回文本，不证明平台来源。' });

try {
  const one = new Peer('one', 'claude', true), two = new Peer('two'); await Promise.all([one.connect(), two.connect()]);
  const tools = await one.client.listTools(); check('独立实际 stdio 恰好五个文件工具', () => assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['get_cowork_capabilities', 'submit_cowork_task', 'get_cowork_task', 'read_cowork_result', 'submit_cowork_review'].sort()));
  const caps = await one.call('get_cowork_capabilities');
  check('Cowork 与 Code 分开，所有平台验证仍关闭', () => { assert.equal(caps.role, 'claude'); assert.equal(caps.conversationId, null); assert.equal(caps.automaticConversationControl, false); assert.equal(caps.runtimeVerified, false); assert.equal(caps.platformCwdVerified, false); assert.equal(caps.fileAccessBoundaryVerified, false); assert.equal(caps.completePlatformLoopVerified, false); });
  const wrong = new Peer('wrong', 'codex'); await assert.rejects(() => wrong.connect()); checks.push({ name: '拒绝 codex 角色，不伪装 Cowork', passed: true });
  await one.call('submit_cowork_task', { ...taskArgs('safe'), cwd: FIXTURE_ROOT }, '*');
  await one.call('submit_cowork_task', taskArgs('../escape'), '*');
  await one.call('submit_cowork_task', taskArgs('CON'), 'TASK_ID_INVALID');
  await one.call('submit_cowork_task', { ...taskArgs('bad_input'), textInputs: [{ name: '../escape', text: '样本' }] }, 'INPUT_NAME_INVALID');
  const args = taskArgs('file_task'), submitted = await Promise.all([one.call('submit_cowork_task', args), two.call('submit_cowork_task', args)]);
  const dispatched = submitted.find(response => response.task.inputComplete), duplicate = submitted.find(response => response.deduplicated);
  check('跨进程一次持久派单和完整内容去重', () => { assert.ok(dispatched); assert.ok(duplicate); assert.equal(dispatched.status, 'awaiting_output'); assert.equal(dispatched.task.workspace.owner, 'claude'); assert.equal(dispatched.task.inputFiles.length, 3); });
  const workspace = dispatched.task.workspace;
  const planning = await one.call('get_cowork_task', { taskId: 'file_task' });
  check('实际输入正文和各文件哈希读回', () => { assert.ok(planning.inputFiles.some(file => file.text.includes('测试输入正文'))); for (const file of planning.inputFiles) assert.equal(file.sha256, sha256(fs.readFileSync(file.file))); assert.equal(workspace.cwd, workspace.taskRoot); });
  await two.call('submit_cowork_task', { ...args, title: '不同内容' }, 'REQUEST_ID_CONFLICT');
  await two.call('submit_cowork_task', taskArgs('file_task', 'new-submit-id'), 'TASK_ALREADY_CLAIMED');
  const absent = await one.call('read_cowork_result', { requestId: req('absent'), taskId: 'file_task' });
  check('输出不存在保持 awaiting_output，无假成功', () => { assert.equal(absent.status, 'awaiting_output'); assert.equal(absent.version, null); assert.equal(absent.text, null); });
  const outputFile = path.join(workspace.outputs, 'result.md');
  fs.writeFileSync(outputFile, '# 中文结果\n\n来源：本地协议样本，非真实 Cowork。\n执行环境：unknown。\n', 'utf8');
  const read1 = await one.call('read_cowork_result', { requestId: req('read-v1'), taskId: 'file_task' });
  check('真实中文输出 SHA256 和不可覆盖快照', () => { assert.equal(read1.version, 1); assert.equal(read1.sha256, sha256(fs.readFileSync(outputFile))); assert.equal(read1.text, fs.readFileSync(outputFile, 'utf8')); assert.equal(fs.readFileSync(read1.snapshot, 'utf8'), read1.text); assert.equal(read1.executionSourceVerified, false); });
  const same = await two.call('read_cowork_result', { requestId: req('same-content'), taskId: 'file_task' });
  check('同内容不同请求不重复版本', () => { assert.equal(same.version, 1); assert.equal(same.snapshot, read1.snapshot); });
  await two.call('read_cowork_result', { requestId: req('cross-path'), taskId: 'file_task', filePath: path.join(FIXTURE_ROOT, 'foreign.md') }, '*');
  const reviewed = await one.call('submit_cowork_review', reviewArgs('file_task', read1, 'review-v1'));
  check('明确读回版本可审核，但不冒充平台闭环', () => { assert.equal(reviewed.review.verdict, 'passed'); assert.equal(reviewed.review.scope, 'observed_file_content_only'); assert.equal(reviewed.completePlatformLoopVerified, false); assert.equal(reviewed.conversationId, null); });
  const repeatedReview = await two.call('submit_cowork_review', reviewArgs('file_task', read1, 'review-v1'));
  check('审核请求同内容去重不新增审核', () => assert.equal(repeatedReview.review.reviewId, reviewed.review.reviewId));
  await one.call('submit_cowork_review', { ...reviewArgs('file_task', read1, 'review-v1'), basis: '冲突内容' }, 'REQUEST_ID_CONFLICT');
  fs.writeFileSync(outputFile, '# 第二版中文结果\n只新增版本，旧来源仍未验证。', 'utf8');
  await two.call('submit_cowork_review', reviewArgs('file_task', read1, 'review-v1'), 'OUTPUT_CHANGED');
  await two.call('submit_cowork_review', reviewArgs('file_task', read1, 'changed-before-read'), 'OUTPUT_CHANGED');
  const staleView = await two.call('get_cowork_task', { taskId: 'file_task' });
  check('输出一变，旧审核当前有效性即失效', () => { assert.equal(staleView.reviews[0].currentlyValid, false); assert.equal(staleView.status, 'output_changed_pending_read'); });
  const read2 = await two.call('read_cowork_result', { requestId: req('read-v2'), taskId: 'file_task' });
  check('新输出建立新版，旧快照正文不改', () => { assert.equal(read2.version, 2); assert.equal(fs.readFileSync(read1.snapshot, 'utf8'), read1.text); });
  await one.call('submit_cowork_review', reviewArgs('file_task', read1, 'old-version-review'), 'STALE_RESULT_VERSION');
  await one.call('submit_cowork_review', reviewArgs('file_task', read1, 'review-v1'), 'STALE_RESULT_VERSION');
  await one.call('submit_cowork_review', reviewArgs('file_task', read2, 'cycle-first-pass'));
  const firstPassView = await one.call('get_cowork_task', { taskId: 'file_task' }); assert.equal(firstPassView.status, 'file_review_passed');
  const rework = await one.call('submit_cowork_review', reviewArgs('file_task', read2, 'review-v2', 'rework'));
  check('rework 是文件审核状态，无平台唤醒', () => { assert.equal(rework.review.verdict, 'rework'); assert.equal(rework.automaticWakeup, false); });
  const reworkView = await one.call('get_cowork_task', { taskId: 'file_task' }); check('当前审核状态如实为 rework', () => assert.equal(reworkView.status, 'file_rework'));
  await one.call('submit_cowork_review', reviewArgs('file_task', read2, 'cycle-final-pass'));
  const finalPassView = await one.call('get_cowork_task', { taskId: 'file_task' });
  const oldPassReplay = await two.call('submit_cowork_review', reviewArgs('file_task', read2, 'cycle-first-pass'));
  check('同版本 passed→rework→passed，旧请求重放不复活审核', () => { assert.equal(finalPassView.status, 'file_review_passed'); assert.equal(oldPassReplay.review.valid, false); assert.equal(oldPassReplay.historicalResponse, true); assert.equal(finalPassView.reviews.filter(review => review.currentlyValid).length, 1); });
  await one.close(); const restarted = new Peer('restarted'); await restarted.connect();
  const recovery = await restarted.call('get_cowork_task', { taskId: 'file_task' });
  check('进程重启保留输入、两个版本和旧审核失效', () => { assert.equal(recovery.versions.length, 2); assert.equal(recovery.versions[0].sha256, read1.sha256); assert.equal(recovery.reviews[0].valid, false); });
  const restore = await restarted.call('read_cowork_result', { requestId: req('recovered-read'), taskId: 'file_task' }); check('恢复实际快照正文', () => assert.equal(restore.text, read2.text));
  fs.appendFileSync(read2.snapshot, '篡改', 'utf8');
  await restarted.call('get_cowork_task', { taskId: 'file_task' }, 'SNAPSHOT_TAMPERED');
  await restarted.call('read_cowork_result', { requestId: req('tampered-snapshot'), taskId: 'file_task' }, 'SNAPSHOT_TAMPERED');
  const probeTask = async (taskId, content) => { const response = await two.call('submit_cowork_task', taskArgs(taskId)); const resultFile = path.join(response.task.workspace.outputs, 'result.md'); if (content !== undefined) fs.writeFileSync(resultFile, content); return { response, resultFile }; };
  const invalid = await probeTask('invalid_utf8', Buffer.from([255, 254, 0])); await two.call('read_cowork_result', { requestId: req('invalid-utf8'), taskId: 'invalid_utf8' }, 'INVALID_UTF8');
  const oversized = await probeTask('oversized', Buffer.alloc(COWORK_TEXT_LIMIT + 1)); await two.call('read_cowork_result', { requestId: req('read-oversized'), taskId: 'oversized' }, 'TEXT_LIMIT');
  const linked = await probeTask('linked'); const foreign = path.join(FIXTURE_ROOT, 'foreign.md'); fs.writeFileSync(foreign, '本地外部样本', 'utf8'); fs.linkSync(foreign, linked.resultFile);
  await two.call('read_cowork_result', { requestId: req('hardlink'), taskId: 'linked' }, 'COWORK_LINK_FORBIDDEN');
  const altered = await probeTask('altered'); fs.appendFileSync(path.join(altered.response.task.workspace.inputs, 'task.md'), '改输入', 'utf8');
  await two.call('submit_cowork_task', taskArgs('altered'), 'INPUT_TAMPERED');
  await two.call('get_cowork_task', { taskId: 'altered' }, 'INPUT_TAMPERED');
  const swapped = await probeTask('swapped'), target = await probeTask('junction_target'); fs.renameSync(swapped.response.task.workspace.outputs, path.join(FIXTURE_ROOT, 'saved-outputs')); fs.symlinkSync(target.response.task.workspace.outputs, swapped.response.task.workspace.outputs, 'junction');
  await two.call('read_cowork_result', { requestId: req('junction'), taskId: 'swapped' }, 'WORKSPACE_LINK_FORBIDDEN');
  const recreated = await probeTask('recreated'); fs.renameSync(recreated.response.task.workspace.work, path.join(FIXTURE_ROOT, 'saved-work')); fs.mkdirSync(recreated.response.task.workspace.work);
  await two.call('get_cowork_task', { taskId: 'recreated' }, 'WORKSPACE_IDENTITY_MISMATCH');
  const fault = new CoworkFileStore({ testHooks: { afterWorkspace: task => fs.writeFileSync(path.join(task.workspace.inputs, 'task.md'), '已有文件必须保留', 'utf8') } });
  try {
    const partial = fault.submitTask(taskArgs('partial', 'partial-write'));
    check('中途写入失败留持久未完成占位和原文件', () => { assert.equal(partial.status, 'submission_incomplete'); assert.equal(partial.task.inputComplete, false); assert.equal(fs.readFileSync(path.join(partial.task.workspace.inputs, 'task.md'), 'utf8'), '已有文件必须保留'); });
    const replay = fault.submitTask(taskArgs('partial', 'partial-write')); check('失败请求重放不再覆盖文件', () => assert.equal(replay.historicalResponse, true));
    assert.throws(() => fault.submitTask(taskArgs('partial', 'partial-new-request')), error => error.code === 'TASK_ALREADY_CLAIMED'); checks.push({ name: '失败不能换 requestId 再创建', passed: true });
  } finally { fault.close(); }
  const childCode = `const {CoworkFileStore}=await import(${JSON.stringify(pathToFileURL(path.join(CODE_ROOT,'bridge','src','cowork-store.mjs')).href)});new CoworkFileStore({testHooks:{afterClaim:()=>process.exit(91)}}).submitTask(${JSON.stringify(taskArgs('crashed','crash-after-claim'))});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { cwd: FIXTURE_ROOT, env: { ...getDefaultEnvironment(), COLLAB_PROJECT_ROOT: FIXTURE_ROOT, COLLAB_TEST_MODE: '1' }, shell: false, windowsHide: true, stdio: 'ignore' });
  const exit = await new Promise(resolve => child.once('exit', resolve)); check('占位后崩溃没有伪造已派发', () => assert.equal(exit, 91));
  const crashed = await two.call('get_cowork_task', { taskId: 'crashed' }); check('创建方崩溃后保留 unknown 占位，平台编号仍空', () => { assert.equal(crashed.task.inputComplete, false); assert.equal(crashed.task.workspace, null); assert.equal(crashed.conversationId, null); assert.equal(crashed.status, 'submission_unknown'); });
  await two.call('submit_cowork_task', taskArgs('crashed', 'crash-new-id'), 'TASK_ALREADY_CLAIMED');
  await two.call('read_cowork_result', { requestId: req('crashed-read'), taskId: 'crashed' }, 'TASK_INCOMPLETE');
  const auditRows = fs.readFileSync(path.join(logDir, 'one-audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  check('专用审计记录实际本地工具名和哈希，不记正文', () => { assert.ok(auditRows.some(row => row.toolName === 'submit_cowork_task')); assert.ok(auditRows.some(row => row.toolName === 'submit_cowork_review')); assert.ok(!JSON.stringify(auditRows).includes(args.instructions)); assert.ok(auditRows.every(row => row.projectRoot === FIXTURE_ROOT)); });
  const summary = { status: 'passed', checks, source: 'local_test', modelStarts: 0, realCoworkExecutionVerified: false, completePlatformLoopVerified: false, fixtureRoot: FIXTURE_ROOT, logDir, authenticationRead: false };
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8'); console.log(JSON.stringify({ status: 'passed', assertions: checks.length, summaryPath: path.join(logDir, 'summary.json'), realCoworkExecutionVerified: false, modelStarts: 0 }, null, 2));
} catch (error) { fs.writeFileSync(path.join(logDir, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack, checks, source: 'local_test' }, null, 2), 'utf8'); console.error(error); process.exitCode = 1; }
finally { await Promise.allSettled(peers.map(peer => peer.close())); }
