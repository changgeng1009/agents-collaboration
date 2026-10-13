import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { RUNTIME_ROOT, guardedPath, fail, sha256 } from './policy.mjs';

export function sanitizeSessionValue(value, key = '') {
  if (/^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential)$/i.test(key)) return '[已脱敏]';
  if (Array.isArray(value)) return value.map(item => sanitizeSessionValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeSessionValue(item, name)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\bsk-[A-Za-z0-9_-]+/g, '[已脱敏令牌]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已脱敏令牌]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi, '$1[已脱敏]');
}

export function readSessionConfiguration() {
  if (process.env.COLLAB_TEST_MODE === '1') return { enabled: false, acceptedProductMode: false };
  const file = path.join(RUNTIME_ROOT, 'session-control.local.json');
  if (!fs.existsSync(file)) return { enabled: false, acceptedProductMode: false };
  const parsed = JSON.parse(fs.readFileSync(guardedPath(RUNTIME_ROOT, file), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== 'claudeCode')) fail('SESSION_CONFIG_INVALID', '会话配置含未知字段。');
  const config = parsed.claudeCode ?? {};
  const keys = new Set(['enabled', 'acceptedProductMode', 'executable', 'nodeExecutable', 'cliScript', 'timeoutMs', 'maxOutputBytes']);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !keys.has(key))) fail('SESSION_CONFIG_INVALID', '文本适配器配置含未知字段。');
  for (const key of ['enabled', 'acceptedProductMode']) if (config[key] !== undefined && typeof config[key] !== 'boolean') fail('SESSION_CONFIG_INVALID', '启用与产品模式确认必须为布尔值。');
  return { ...config, enabled: config.enabled === true, acceptedProductMode: config.acceptedProductMode === true };
}

function trustedFile(candidate, extension) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || !extension.test(candidate)) fail('LAUNCHER_INVALID', '可信启动程序或脚本须为规定类型的绝对文件路径。');
  const real = fs.realpathSync(candidate);
  if (!fs.statSync(real).isFile()) fail('LAUNCHER_INVALID', '可信启动目标不是普通文件。');
  return real;
}

export function buildClaudeCodePlan(config, cwd, conversationId = null) {
  if (config.enabled !== true || config.acceptedProductMode !== true) fail('ADAPTER_DISABLED', '独立 Code 模式尚未明确授权启用。');
  let command, prefix;
  if (config.executable && !config.nodeExecutable && !config.cliScript) { command = trustedFile(config.executable, /\.exe$/i); prefix = []; }
  else if (!config.executable && config.nodeExecutable && config.cliScript) {
    command = trustedFile(config.nodeExecutable, /\.exe$/i); prefix = [trustedFile(config.cliScript, /\.(?:js|mjs|cjs)$/i)];
  } else fail('LAUNCHER_INVALID', '只能配置原生程序或 Node 加固定脚本，不能混合启动方式。');
  const timeoutMs = config.timeoutMs ?? 60000, maxOutputBytes = config.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16 * 1024 * 1024) fail('SESSION_CONFIG_INVALID', '时间或输出上限超出允许范围。');
  if (conversationId !== null && (typeof conversationId !== 'string' || !conversationId.length || /[\x00-\x1f]/.test(conversationId))) fail('NATIVE_ID_INVALID', '续接编号须为平台原始非空字符串。');
  const args = [...prefix, '-p', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--tools', '',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--disable-slash-commands', '--setting-sources', '', '--permission-mode', 'dontAsk', '--safe-mode', '--no-chrome',
    ...(conversationId === null ? [] : ['--resume', conversationId])];
  const env = {};
  const allowed = new Set(['ALLUSERSPROFILE', 'APPDATA', 'COMSPEC', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH', 'PATHEXT', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE', 'WINDIR']);
  for (const [key, value] of Object.entries(process.env)) if (allowed.has(key.toUpperCase())) env[key] = value;
  return { command, args, cwd, conversationId, env, timeoutMs, maxOutputBytes, shell: false, windowsHide: true,
    launcherSha256: sha256(fs.readFileSync(command)), scriptSha256: prefix.length ? sha256(fs.readFileSync(prefix[0])) : null,
    platformStorage: { kind: 'local_cli_records', location: null, documentedDefaultRoot: path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), '.claude', 'projects'), verified: false },
    textOnly: true, fileAccessBoundaryVerified: false, osIsolationVerified: false };
}

export function parseClaudeCodeEvents(events, { cwd, conversationId = null, exitCode, signal, timedOut = false, truncated = false, protocolError = false }) {
  const init = events.filter(event => event.type === 'system' && event.subtype === 'init');
  const results = events.filter(event => event.type === 'result');
  const observedIds = [...new Set(events.map(event => event.session_id).filter(id => id !== undefined))];
  let reason = null;
  const nativeId = init.length === 1 && typeof init[0].session_id === 'string' && init[0].session_id.length ? init[0].session_id : null;
  if (timedOut) reason = 'TIMEOUT_UNKNOWN';
  else if (truncated) reason = 'OUTPUT_TRUNCATED';
  else if (protocolError) reason = 'PROTOCOL_INVALID';
  else if (init.length !== 1 || nativeId === null || observedIds.some(id => typeof id !== 'string')) reason = 'NATIVE_ID_MISSING';
  else if (nativeId.length > 256 || nativeId.startsWith('-') || /[\x00-\x1f]/.test(nativeId)) reason = 'NATIVE_ID_INVALID';
  else if (observedIds.some(id => id !== nativeId) || (conversationId !== null && nativeId !== conversationId)) reason = 'NATIVE_ID_MISMATCH';
  else if (typeof init[0].cwd !== 'string' || !path.isAbsolute(init[0].cwd)) reason = 'CWD_MISSING';
  else {
    try { if (fs.realpathSync(init[0].cwd) !== fs.realpathSync(cwd)) reason = 'CWD_MISMATCH'; }
    catch { reason = 'CWD_MISMATCH'; }
  }
  if (!reason && !Array.isArray(init[0].tools)) reason = 'TEXT_MODE_STATE_UNVERIFIED';
  if (!reason && !Array.isArray(init[0].mcp_servers)) reason = 'MCP_STATE_UNVERIFIED';
  if (!reason && (init[0].tools.length || init[0].mcp_servers.length || events.some(event => event.message?.content?.some?.(item => item.type === 'tool_use')))) reason = 'TEXT_MODE_VIOLATION';
  if (!reason && results.length !== 1) reason = 'RESULT_MISSING';
  if (!reason && (results[0].session_id !== nativeId || (results[0].cwd !== undefined && results[0].cwd !== init[0].cwd))) reason = 'RESULT_BINDING_MISMATCH';
  if (!reason && (signal || exitCode !== 0)) reason = 'PROCESS_EXIT_FAILED';
  if (!reason && (results[0].is_error === true || results[0].subtype !== 'success')) reason = 'PLATFORM_RESULT_FAILED';
  if (!reason && typeof results[0].result !== 'string') reason = 'RESULT_INVALID';
  const knownFailure = reason === 'PROCESS_EXIT_FAILED' || reason === 'PLATFORM_RESULT_FAILED';
  const replies = events.filter(event => event.type === 'assistant').flatMap(event => (event.message?.content ?? []).filter(item => item.type === 'text').map(item => item.text));
  return { status: reason ? (knownFailure ? 'failed' : 'unknown') : 'succeeded', reason, conversationId: reason && ['NATIVE_ID_MISSING', 'NATIVE_ID_MISMATCH', 'RESULT_BINDING_MISMATCH'].includes(reason) ? null : nativeId,
    idSource: nativeId ? 'system.init.session_id' : null, observedNativeIds: observedIds, observedCwd: init[0]?.cwd ?? null,
    workingDirectoryVerified: !reason, fileAccessBoundaryVerified: false, osIsolationVerified: false, replies: sanitizeSessionValue(replies),
    result: results.length === 1 ? sanitizeSessionValue(results[0]) : null, exitCode, signal, timedOut, truncated };
}

export class ClaudeCodeTextAdapter {
  constructor(config) { this.config = config; this.evidenceLevel = 'real_runtime'; }
  prepare(cwd, conversationId) { return buildClaudeCodePlan(this.config, cwd, conversationId); }
  async run({ plan, prompt, workDirectory, onSpawn = () => {} }) {
    const events = [], streamFile = path.join(workDirectory, 'native-stream.jsonl'), stderrFile = path.join(workDirectory, 'stderr.txt');
    const streamFd = fs.openSync(streamFile, 'wx'), stderrFd = fs.openSync(stderrFile, 'wx');
    let stdoutTail = Buffer.alloc(0), stderrBytes = Buffer.alloc(0), count = 0, timedOut = false, truncated = false, protocolError = false;
    const saveLine = bytes => {
      if (!bytes.length) return;
      try { const line = new TextDecoder('utf-8', { fatal: true }).decode(bytes); const event = JSON.parse(line); if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('事件不是对象'); events.push(event); fs.writeSync(streamFd, JSON.stringify(sanitizeSessionValue(event)) + '\n'); }
      catch { protocolError = true; fs.writeSync(streamFd, JSON.stringify({ type: 'unparsed', text: sanitizeSessionValue(bytes.toString('utf8')) }) + '\n'); }
    };
    let child, timer, spawnError = null;
    try {
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      timer = setTimeout(() => { timedOut = true; child.kill(); }, plan.timeoutMs);
      child.on('spawn', () => { try { onSpawn(child.pid); } catch { protocolError = true; child.kill(); } });
      child.on('error', error => { spawnError = sanitizeSessionValue(error.message); });
      const acceptBytes = bytes => { count += bytes.length; if (count > plan.maxOutputBytes) { if (!truncated) child.kill(); truncated = true; return false; } return true; };
      child.stdout.on('data', bytes => { if (!acceptBytes(bytes)) return; stdoutTail = Buffer.concat([stdoutTail, bytes]); let end; while ((end = stdoutTail.indexOf(10)) >= 0) { saveLine(stdoutTail.subarray(0, end)); stdoutTail = stdoutTail.subarray(end + 1); } });
      child.stderr.on('data', bytes => { if (acceptBytes(bytes)) stderrBytes = Buffer.concat([stderrBytes, bytes]); });
      child.stdin.on('error', () => { protocolError = true; });
      child.stdin.end(Buffer.from(prompt, 'utf8'));
      const closed = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
      if (stdoutTail.length) saveLine(stdoutTail);
      fs.writeSync(stderrFd, sanitizeSessionValue(stderrBytes.toString('utf8')));
      const parsed = parseClaudeCodeEvents(events, { ...closed, cwd: plan.cwd, conversationId: plan.conversationId ?? null, timedOut, truncated, protocolError });
      if (spawnError) return { ...parsed, status: 'failed', reason: 'SPAWN_FAILED', spawnError, conversationId: null, evidenceLevel: this.evidenceLevel };
      return { ...parsed, evidenceLevel: this.evidenceLevel };
    } finally { clearTimeout(timer); fs.closeSync(streamFd); fs.closeSync(stderrFd); }
  }
}
