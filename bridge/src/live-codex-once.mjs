import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PROJECT_ROOT, ARTIFACT_ROOT, RUNTIME_ROOT, BRIDGE_ROOT, guardedPath, sha256, redact, fail } from './policy.mjs';
import { buildExecPlan, publicExecPlan, parseCodexEvents } from './codex-adapter.mjs';

function readDemoAuthorization() {
  if (process.env.COLLAB_TEST_MODE === '1') return null;
  const file = path.join(RUNTIME_ROOT, 'live-demo.local.json');
  if (!fs.existsSync(file)) return null;
  const grant = JSON.parse(fs.readFileSync(guardedPath(RUNTIME_ROOT, file), 'utf8'));
  if (grant?.enabled !== true || grant?.scope !== 'count-demo-once' || grant?.maxExecStarts !== 1 ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(grant?.taskNumber ?? '') || !/^[A-Za-z0-9_-]{1,120}$/.test(grant?.executionId ?? '')) fail('DEMO_AUTHORIZATION_INVALID', '一次演示的私有授权记录无效。');
  return grant;
}
const demoAuthorization = readDemoAuthorization();
export const TASK_NUMBER = demoAuthorization?.taskNumber ?? 'count-demo-disabled';
export const EXECUTION_ID = demoAuthorization?.executionId ?? 'count-demo-disabled';
export const LIVE_ROOT = path.join(ARTIFACT_ROOT, 'live-codex');
export const LIVE_LOG = path.join(PROJECT_ROOT, 'logs', 'executor', TASK_NUMBER);
export const RUN_ROOT = path.join(ARTIFACT_ROOT, 'codex-runs', EXECUTION_ID);
export const EXPECTED = { total: 3, done: 1, todo: 1, blocked: 1, language: '简体中文' };
export const INPUT = [{ id: 'shot-1', status: 'done' }, { id: 'shot-2', status: 'todo' }, { id: 'shot-3', status: 'blocked' }];

export function validateDemoOutput(output, input) {
  if (!Array.isArray(input) || JSON.stringify(input) !== JSON.stringify(INPUT)) fail('INPUT_MISMATCH', '输入演示清单发生变化。');
  const actual = JSON.parse(output);
  if (!actual || Array.isArray(actual) || typeof actual !== 'object') fail('RESULT_SHAPE', '输出必须为 JSON 对象。');
  const keys = Object.keys(actual).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(EXPECTED).sort())) fail('RESULT_KEYS', '结果字段不符。');
  const calculated = { total: input.length, done: input.filter(x => x.status === 'done').length, todo: input.filter(x => x.status === 'todo').length, blocked: input.filter(x => x.status === 'blocked').length, language: '简体中文' };
  for (const key of keys) if (actual[key] !== calculated[key]) fail('RESULT_VALUE', `结果字段 ${key} 不符。`);
  return actual;
}

export function verifyObservedRead(jsonl, inputFile, inputBytes) {
  const events = jsonl.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const commands = events.filter(event => event.type === 'item.completed' && event.item?.type === 'command_execution').map(event => event.item);
  if (commands.length !== 1) fail('READ_COMMAND_COUNT', '必须有且只有一次实际只读命令完成记录。');
  const command = commands[0];
  if (command.exit_code !== 0 || !command.command.includes('Get-Content') || !command.command.includes('tasks.json')) fail('READ_COMMAND_FAILED', '实际文件读取未成功。');
  const read = JSON.parse(command.aggregated_output.trim());
  if (JSON.stringify(read) !== JSON.stringify(JSON.parse(inputBytes.toString('utf8')))) fail('OBSERVED_INPUT_MISMATCH', '实际读取的内容与指定输入不一致。');
  return { command: command.command, exitCode: command.exit_code, observedInputMatches: true, inputFile };
}

export function claimOnce(markerPath, record) {
  const safe = guardedPath(path.join(PROJECT_ROOT, 'logs', 'executor'), markerPath, { mustExist: false });
  // 跨进程独占创建；已有 planned/started/失败/未知记录都禁止复跑。
  const fd = fs.openSync(safe, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(record, null, 2), 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function writeJSON(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8'); }

class LoggedMcpClient {
  constructor(role) { this.role = role; this.client = new Client({ name: `${TASK_NUMBER}-${role}-manager-demo-local-client`, version: '0.1.0' }); }
  async connect() {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(BRIDGE_ROOT, 'src', 'server.mjs'), '--role', this.role], stderr: 'pipe' });
    transport.stderr?.on('data', bytes => fs.appendFileSync(path.join(LIVE_LOG, `mcp-${this.role}-stderr.txt`), redact(bytes.toString('utf8')), 'utf8'));
    const originalSend = transport.send.bind(transport);
    transport.send = async message => { this.log('client_to_server', message); return originalSend(message); };
    let handler;
    Object.defineProperty(transport, 'onmessage', { configurable: true, get: () => handler, set: callback => { handler = message => { this.log('server_to_client', message); callback?.(message); }; } });
    await this.client.connect(transport);
  }
  log(direction, message) { fs.appendFileSync(path.join(LIVE_LOG, `mcp-${this.role}-wire.jsonl`), JSON.stringify({ at: new Date().toISOString(), direction, role: this.role, source: 'manager 演示派单，本地客户端；非真实 Claude', message }) + '\n', 'utf8'); }
  async call(name, args = {}) {
    const response = await this.client.callTool({ name, arguments: args });
    if (response.isError) fail('MCP_REJECTED', JSON.stringify(response));
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  }
  async close() { await this.client.close(); }
}

async function executeOneProcess(plan, lifecycle) {
  const startMarker = path.join(LIVE_LOG, `${EXECUTION_ID}.start.json`);
  claimOnce(startMarker, { executionId: EXECUTION_ID, requestedAt: new Date().toISOString(), taskId: lifecycle.taskId, argv: plan.argv, state: 'start_reserved', maxExecStarts: 1 });
  const rawPath = path.join(LIVE_LOG, 'codex-raw-events.jsonl');
  const stderrPath = path.join(LIVE_LOG, 'codex-stderr-redacted.txt');
  const child = spawn(plan.executable, plan.argv, { cwd: plan.workspace, env: plan.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  lifecycle.state = 'started'; lifecycle.execSpawnAttempts = 1; lifecycle.startedAt = new Date().toISOString(); lifecycle.pid = child.pid ?? null;
  writeJSON(path.join(LIVE_LOG, 'execution-lifecycle.json'), lifecycle);
  const outDecoder = new StringDecoder('utf8'), errDecoder = new StringDecoder('utf8');
  let jsonl = '', stderr = '', buffer = '', stopReason = null;
  const stop = reason => { if (!stopReason) { stopReason = reason; lifecycle.stopReason = reason; writeJSON(path.join(LIVE_LOG, 'execution-lifecycle.json'), lifecycle); if (child.exitCode === null) child.kill(); } };
  const handleLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { stop('invalid_jsonl'); return; }
    if (event.type === 'error' || event.type === 'turn.failed') stop('first_observable_error');
    if (event.type === 'item.started' && ['web_search', 'mcp_tool_call', 'file_change'].includes(event.item?.type)) stop('unexpected_model_action');
    if (event.type === 'item.started' && event.item?.type === 'command_execution') {
      const command = event.item.command ?? '';
      // 只接受只读 Get-Content 命令；出现额外命令或路径立即停止。
      const allowed = command.includes('Get-Content') && command.includes('tasks.json') && !/[;&|]|\b(?:Invoke-|Set-|Add-|Remove-|Copy-|Move-|curl|wget|rg|Get-ChildItem)\b/i.test(command);
      if (!allowed) stop('unexpected_model_command');
    }
  };
  child.stdout.on('data', bytes => {
    fs.appendFileSync(rawPath, bytes);
    const chunk = outDecoder.write(bytes); jsonl += chunk; buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1); handleLine(line); }
  });
  child.stderr.on('data', bytes => {
    const chunk = errDecoder.write(bytes); stderr += chunk;
    fs.appendFileSync(stderrPath, redact(chunk), 'utf8');
    if (/reconnect(?:ing)?|retry(?:ing)?|\bERROR\b/i.test(chunk)) stop('first_observable_stderr_error_or_retry');
  });
  child.stdin.on('error', error => { lifecycle.stdinError = redact(error.message); });
  // 显式 UTF-8 字节输入，避免 PowerShell CP936 stdin 解码。
  child.stdin.end(fs.readFileSync(plan.promptFile));
  const timeout = setTimeout(() => stop('timeout_180_seconds'), 180000);
  const exit = await new Promise(resolve => {
    child.once('error', error => { lifecycle.spawnError = redact(error.message); resolve({ code: null, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(timeout);
  jsonl += outDecoder.end(); stderr += errDecoder.end(); if (buffer.trim()) handleLine(buffer);
  const parsed = parseCodexEvents(jsonl, { exitCode: exit.code, executionId: EXECUTION_ID });
  lifecycle.endedAt = new Date().toISOString(); lifecycle.exitCode = exit.code; lifecycle.signal = exit.signal;
  lifecycle.sessionId = parsed.sessionId; lifecycle.usage = parsed.usage;
  lifecycle.state = stopReason ? 'stopped_failed_or_unknown' : parsed.status;
  writeJSON(path.join(LIVE_LOG, 'execution-lifecycle.json'), lifecycle);
  return { parsed, stopReason, jsonl, stderr, exit };
}

export async function runLiveOnce() {
  if (!demoAuthorization) fail('DEMO_NOT_AUTHORIZED', '一次演示入口默认关闭，缺少明确的本地授权记录。');
  for (const dir of [LIVE_ROOT, LIVE_LOG, RUN_ROOT, path.join(LIVE_ROOT, 'input'), path.join(LIVE_ROOT, 'control')]) fs.mkdirSync(guardedPath(PROJECT_ROOT, dir, { mustExist: false }), { recursive: true });
  const plannedPath = path.join(LIVE_LOG, `${EXECUTION_ID}.planned.json`);
  if (fs.existsSync(plannedPath) || fs.existsSync(path.join(LIVE_LOG, `${EXECUTION_ID}.start.json`))) fail('ALREADY_ATTEMPTED', '该演示已有计划或启动记录；禁止复跑，交 manager 核查。');
  const inputFile = path.join(LIVE_ROOT, 'input', 'tasks.json');
  const promptFile = path.join(LIVE_ROOT, 'control', 'prompt.txt');
  const schemaFile = path.join(LIVE_ROOT, 'control', 'result-schema.json');
  fs.writeFileSync(inputFile, JSON.stringify(INPUT) + '\n', { encoding: 'utf8', flag: 'wx' });
  const prompt = `这是 manager 授权的唯一只读演示任务 ${TASK_NUMBER}。本地规划客户端不是 Claude。\n仅允许执行一次 PowerShell 7 只读命令：Get-Content -LiteralPath '${inputFile}' -Raw -Encoding utf8\n只读取该文件，按实际内容统计 total、done、todo、blocked。最后仅返回 JSON 对象，language 必须是“简体中文”。不要写文件、列目录、联网、调用其他工具、发送消息、读取任何其他文件或调用额外 agent。不要重试失败命令。所有输出文件由父适配器保存。\n`;
  fs.writeFileSync(promptFile, prompt, { encoding: 'utf8', flag: 'wx' });
  writeJSON(schemaFile, { type: 'object', properties: { total: { type: 'integer' }, done: { type: 'integer' }, todo: { type: 'integer' }, blocked: { type: 'integer' }, language: { type: 'string' } }, required: Object.keys(EXPECTED), additionalProperties: false });
  const plan = buildExecPlan({ taskId: TASK_NUMBER, workspace: path.dirname(inputFile), promptFile, outputDirectory: RUN_ROOT, sandbox: 'read-only', outputSchema: schemaFile });
  if (!plan.executable) fail('CODEX_NOT_CONFIGURED', '尚未配置明确的 Codex 程序路径。');
  const login = spawnSync(plan.executable, ['login', 'status'], { env: plan.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const loginText = redact((login.stdout ?? '') + (login.stderr ?? ''));
  fs.writeFileSync(path.join(LIVE_LOG, 'login-status-redacted.txt'), loginText, 'utf8');
  if (login.status !== 0 || !loginText.includes('Logged in using ChatGPT')) fail('LOGIN_NOT_CHATGPT', '登录不是明确的 ChatGPT 状态，不启动演示。');
  const publicPlan = { ...publicExecPlan(plan), modelExecutionEnabled: true, taskNumber: TASK_NUMBER, executionId: EXECUTION_ID,
    source: 'manager 演示派单，非真实 Claude', maxExecStarts: 1, internalRetryConfiguration: 'builtin_openai_override_not_supported_not_blindly_set', stopOnFirstObservableError: true };
  claimOnce(plannedPath, { at: new Date().toISOString(), state: 'planned', ...publicPlan });
  const lifecycle = { taskNumber: TASK_NUMBER, executionId: EXECUTION_ID, source: publicPlan.source, state: 'planned', requestId: `${TASK_NUMBER}-submit-01`, execSpawnAttempts: 0,
    inputFile, inputSha256: sha256(fs.readFileSync(inputFile)), outputDirectory: RUN_ROOT, model: 'unknown', currentChatUsage: 'not_separately_measured' };
  writeJSON(path.join(LIVE_LOG, 'execution-lifecycle.json'), lifecycle);
  const planner = new LoggedMcpClient('claude'), executor = new LoggedMcpClient('codex');
  try {
    await planner.connect(); await executor.connect();
    const submission = await planner.call('submit_task', { requestId: lifecycle.requestId, title: `${TASK_NUMBER} manager 唯一真实后台演示`, goal: '由官方 ChatGPT 订阅 Codex exec 只读三个非隐私演示记录并返回计数；派单来源为 manager 本地客户端，非真实 Claude。', acceptance: ['只启动一次 read-only exec', '独立核对输入输出 JSON', '保留 sessionId、原始事件与用量'], inputs: [] });
    lifecycle.taskId = submission.task.taskId; writeJSON(path.join(LIVE_LOG, 'execution-lifecycle.json'), lifecycle);
    await executor.call('read_messages', { requestId: `${TASK_NUMBER}-inbox-01`, taskId: lifecycle.taskId, unreadOnly: true });
    await executor.call('ack_message', { requestId: `${TASK_NUMBER}-ack-01`, messageId: submission.message.messageId });
    await executor.call('start_task', { requestId: `${TASK_NUMBER}-start-task-01`, taskId: lifecycle.taskId });
    const run = await executeOneProcess(plan, lifecycle);
    writeJSON(path.join(LIVE_LOG, 'parsed-real-events.json'), { ...run.parsed, fixture: false, additionalExecProcessStarts: 1 });
    if (run.stopReason || run.parsed.status !== 'candidate_completed') fail('EXEC_FAILED_OR_UNKNOWN', `唯一演示失败或不确定：${run.stopReason ?? run.parsed.status}`);
    const lastFile = path.join(RUN_ROOT, 'final-output.txt');
    if (!fs.existsSync(lastFile)) fail('FINAL_OUTPUT_MISSING', '没有实际最终输出文件。');
    const finalText = fs.readFileSync(lastFile, 'utf8');
    if (finalText.trim() !== run.parsed.finalOutput.trim()) fail('FINAL_OUTPUT_CONFLICT', '最终文件与实际事件消息不一致。');
    const actual = validateDemoOutput(finalText, JSON.parse(fs.readFileSync(inputFile, 'utf8')));
    lifecycle.observedRead = verifyObservedRead(run.jsonl, inputFile, fs.readFileSync(inputFile));
    if (sha256(fs.readFileSync(inputFile)) !== lifecycle.inputSha256) fail('INPUT_CHANGED', '输入哈希变化。');
    const resultFile = path.join(RUN_ROOT, 'result.json'); fs.writeFileSync(resultFile, JSON.stringify(actual) + '\n', { encoding: 'utf8', flag: 'wx' });
    const artifact = await executor.call('register_artifact', { requestId: `${TASK_NUMBER}-artifact-01`, taskId: lifecycle.taskId, artifactId: 'live_codex_demo_result_01', version: 1, filePath: resultFile, mimeType: 'application/json', origin: `官方 Codex exec，ChatGPT 登录；executionId=${EXECUTION_ID}；sessionId=${run.parsed.sessionId}` });
    const completed = await executor.call('complete_task', { requestId: `${TASK_NUMBER}-complete-01`, taskId: lifecycle.taskId, summary: '唯一真实后台 Codex 清单计数已完成，父适配器独立核对通过；等待 manager 审核。', artifacts: [{ artifactId: artifact.artifact.artifactId, version: 1 }], execution: { executionId: EXECUTION_ID, kind: 'codex_exec', sessionId: run.parsed.sessionId, usage: run.parsed.usage } });
    lifecycle.state = 'awaiting_review'; lifecycle.businessResultCorrect = true; lifecycle.outputSha256 = sha256(fs.readFileSync(resultFile)); lifecycle.artifact = artifact.artifact; lifecycle.mcpCompletedTask = completed.task;
    writeJSON(path.join(LIVE_LOG, 'execution-lifecycle.json'), lifecycle);
    console.log(JSON.stringify({ taskNumber: TASK_NUMBER, taskId: lifecycle.taskId, executionId: EXECUTION_ID, sessionId: run.parsed.sessionId, state: lifecycle.state, usage: run.parsed.usage, result: actual, resultFile }, null, 2));
    return lifecycle;
  } catch (error) {
    lifecycle.state = lifecycle.execSpawnAttempts ? 'failed_or_unknown_no_retry' : 'local_preflight_failed'; lifecycle.error = { code: error.code ?? 'ERROR', message: redact(error.message) };
    writeJSON(path.join(LIVE_LOG, 'execution-lifecycle.json'), lifecycle);
    writeJSON(path.join(LIVE_LOG, 'failure.json'), lifecycle);
    console.error(JSON.stringify({ taskNumber: TASK_NUMBER, state: lifecycle.state, error: lifecycle.error }, null, 2));
    process.exitCode = 1; return lifecycle;
  } finally { await Promise.allSettled([planner.close(), executor.close()]); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] !== 'run-authorized-once') { console.error('只允许本次 manager 授权任务的 run-authorized-once 入口。'); process.exitCode = 2; }
  else await runLiveOnce();
}
