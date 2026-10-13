import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PROJECT_ROOT, ARTIFACT_ROOT, LOG_ROOT, guardedPath, sha256, redact, fail, readToolchainConfig } from './policy.mjs';

export const ROUTE_ENV_NAMES = ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'CODEX_API_KEY', 'CODEX_PROFILE', 'CODEX_CONFIG'];
export function resolveCodexExecutable({ required = true } = {}) {
  const executable = process.env.COLLAB_TEST_MODE === '1' ? null : (process.env.COLLAB_CODEX_EXECUTABLE ?? readToolchainConfig().codexExecutable);
  if (!executable) { if (required) fail('CODEX_NOT_CONFIGURED', '尚未提供明确的本地 Codex 程序路径。'); return null; }
  if (!path.isAbsolute(executable) || !fs.statSync(executable).isFile() || !/^codex(?:\.exe)?$/i.test(path.basename(executable))) fail('CODEX_PATH_INVALID', '本地 Codex 程序路径无效。');
  return fs.realpathSync(executable);
}

export function cleanRouteEnvironment(source) {
  const env = { ...source };
  const presence = ROUTE_ENV_NAMES.map(name => ({ name, present: Object.keys(source).some(key => key.toUpperCase() === name) }));
  for (const key of Object.keys(env)) if (ROUTE_ENV_NAMES.includes(key.toUpperCase())) delete env[key];
  return { env, presence };
}

export function publicExecPlan(plan) {
  const { env, ...safe } = plan;
  return safe;
}

// 这是单次进程计划；不修改配置、身份存储、登录方式或全局环境。
export function buildExecPlan({ taskId, workspace, promptFile, outputDirectory, sandbox = 'workspace-write', outputSchema = null }) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(taskId)) fail('TASK_ID_INVALID', '任务编号不合法。');
  const work = guardedPath(ARTIFACT_ROOT, workspace);
  if (!fs.statSync(work).isDirectory()) fail('WORKSPACE_REQUIRED', '执行工作区必须是目录。');
  const promptPath = guardedPath(ARTIFACT_ROOT, promptFile);
  const output = guardedPath(ARTIFACT_ROOT, outputDirectory, { mustExist: false });
  if (!output.startsWith(path.join(ARTIFACT_ROOT, 'codex-runs') + path.sep)) fail('OUTPUT_SCOPE', '输出须位于 artifacts/t1/codex-runs 内。');
  if (!['read-only', 'workspace-write'].includes(sandbox)) fail('SANDBOX_FORBIDDEN', '只支持只读或工作区写入沙箱。');
  const argv = ['exec', '--ignore-user-config', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"',
    '-c', 'approval_policy="never"', '--sandbox', sandbox, '--skip-git-repo-check', '--ephemeral', '--json',
    '--color', 'never', '--cd', work, '--output-last-message', path.join(output, 'final-output.txt'), '-'];
  if (outputSchema) argv.splice(argv.length - 1, 0, '--output-schema', guardedPath(ARTIFACT_ROOT, outputSchema));
  const { env, presence: environmentPresence } = cleanRouteEnvironment(process.env);
  // CODEX_HOME 保持原始位置，不复制或迁移身份文件。
  const executable = resolveCodexExecutable({ required: false });
  return { taskId, executable, executableConfigured: executable !== null, argv, workspace: work, promptFile: promptPath, promptSha256: sha256(fs.readFileSync(promptPath)),
    outputDirectory: output, environmentPresence, env, modelExecutionEnabled: false,
    status: 'prepared_not_executed', note: '只有后续唯一演示派单才能增加运行入口；当前代码不能发起模型请求。' };
}

export function parseCodexEvents(jsonl, { exitCode, executionId = 'unassigned' }) {
  let sessionId = null, completed = false, failed = false, finalOutput = '', usage = 'unknown', rawUsage = null;
  const errors = [], fileChanges = [];
  for (const [index, line] of jsonl.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { errors.push({ line: index + 1, message: 'JSONL 解析失败' }); failed = true; continue; }
    if (event.type === 'thread.started') sessionId = event.thread_id;
    if (event.type === 'turn.completed') {
      completed = true; rawUsage = event.usage ?? null;
      const inputTokens = rawUsage?.input_tokens, outputTokens = rawUsage?.output_tokens;
      usage = Number.isSafeInteger(inputTokens) && inputTokens >= 0 && Number.isSafeInteger(outputTokens) && outputTokens >= 0
        ? { inputTokens, outputTokens } : 'unknown';
    }
    if (event.type === 'turn.failed' || event.type === 'error') { failed = true; errors.push({ line: index + 1, message: redact(event.error?.message ?? event.message ?? '执行错误') }); }
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') finalOutput = event.item.text ?? '';
    if (event.type === 'item.completed' && event.item?.type === 'file_change') fileChanges.push(...(event.item.changes ?? []));
  }
  // exit 0、会话创建或只有 turn.completed 都不足以认定结果成功。
  const status = failed || (exitCode !== undefined && exitCode !== null && exitCode !== 0) ? 'failed'
    : completed && sessionId && finalOutput.trim() && exitCode === 0 ? 'candidate_completed' : 'submission_unknown';
  return { executionId, sessionId, status, exitCode: exitCode ?? null, finalOutput: redact(finalOutput), usage, rawUsage, errors, fileChanges,
    businessAcceptance: 'not_verified', sourceEvidence: 'event_parser_only' };
}

export function hashOutputs(filePaths) {
  return filePaths.map(filePath => {
    const safe = guardedPath(ARTIFACT_ROOT, filePath);
    const bytes = fs.readFileSync(safe);
    return { filePath: safe, sha256: sha256(bytes), byteLength: bytes.length };
  });
}

export function prepare() {
  fs.mkdirSync(guardedPath(PROJECT_ROOT, LOG_ROOT, { mustExist: false }), { recursive: true });
  const executable = resolveCodexExecutable();
  const probe = spawnSync(executable, ['exec', '--ignore-user-config', '-c', 'model_provider="openai"', '-c', 'forced_login_method="chatgpt"', '--help'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  const output = redact((probe.stdout ?? '') + (probe.stderr ?? ''));
  fs.writeFileSync(path.join(LOG_ROOT, 'official-route-help.txt'), output, 'utf8');
  const presence = [...ROUTE_ENV_NAMES, 'CODEX_HOME'].map(name => ({ name, present: Object.keys(process.env).some(key => key.toUpperCase() === name) }));
  const report = { checkedAt: new Date().toISOString(), cliPath: executable, helpExitCode: probe.status,
    ignoreUserConfigInHelp: output.includes('--ignore-user-config'), parameterSyntaxAccepted: probe.status === 0,
    currentLoginChannel: 'not_checked_by_prepare', currentProvider: 'not_checked_by_prepare',
    plannedProvider: 'openai', environmentPresence: presence, authenticationFilesRead: false,
    modelRequestsStarted: 0, providerResolutionVerified: false, officialBackendReachabilityVerified: false, billingVerified: false,
    note: '帮助参数通过只证明 CLI 接受语法；实际路由、账号权益及官方业务任务仍待正式演示。' };
  fs.writeFileSync(path.join(LOG_ROOT, 'official-route-preparation.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === 'prepare') console.log(JSON.stringify(prepare(), null, 2));
  else { console.error('本入口仅提供 prepare；真实模型运行须有独立明确授权。'); process.exitCode = 2; }
}
