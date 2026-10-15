import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, SOURCE_ROOT, RUNTIME_ROOT, guardedPath, fail, sha256, inside } from './policy.mjs';
import { CODEBUDDY_MCP_NAME, CODEBUDDY_TOOL_NAME, sameRealPath, readCodeBuddyAudit } from './codebuddy-audit.mjs';
import { SESSION_FILE_TOOLS, validFileArguments } from './session-files.mjs';

// 已核实的 2.147.0 当前代理内置声明；未知新增工具仍须被严格 init 检查拒绝。
export const CODEBUDDY_BUILTIN_DENY_TOOLS = Object.freeze([
  'Agent', 'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'PowerShell', 'EnterPlanMode', 'ExitPlanMode',
  'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'WebFetch', 'WebSearch', 'TaskStop', 'TaskOutput',
  'Skill', 'AskUserQuestion', 'StructuredOutput', 'ToolSearch', 'DeferExecuteTool', 'SendMessage',
  'TeamCreate', 'TeamDelete', 'ImageGen', 'VideoGen', 'WeChatReply', 'WeComReply', 'ListMcpResources',
  'ReadMcpResource', 'MessageColleague', 'SpeakInChannel'
]);

export function sanitizeCodeBuddyValue(value, key = '', depth = 0) {
  if (depth > 64) return '[超出脱敏深度]';
  const field = key.replace(/[-_]/g, '').toLowerCase();
  if (/^(?:authorization|apikey|.*token|.*secret|password|credentials?|cookies?|setcookie|userinfo|authurl|authstate|usercode|devicecode|ticket)$/.test(field)) return '[已脱敏]';
  if (Array.isArray(value)) return value.map(item => sanitizeCodeBuddyValue(item, '', depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizeCodeBuddyValue(item, name, depth + 1)]));
  if (typeof value !== 'string') return value;
  return value.replace(/\bsk-[A-Za-z0-9_-]+/g, '[已脱敏令牌]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [已脱敏令牌]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credentials?|cookie|token|user[_-]?code|device[_-]?code|ticket|secret)["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi, '$1[已脱敏]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => {
      try { const parsed = new URL(url); if (/\/(?:login|oauth|authorize|device)(?:\/|$)/i.test(parsed.pathname) || [...parsed.searchParams.keys()].some(name => /^(?:.*token|.*secret|code|password|user[_-]?code|device[_-]?code|ticket)$/i.test(name))) return '[已脱敏认证链接]'; } catch {}
      return url;
    });
}

export function normalizeCodeBuddyConfiguration(config) {
  const keys = new Set(['enabled', 'acceptedProductMode', 'nodeExecutable', 'cliScript', 'nodeSha256', 'cliSha256', 'headlessSha256', 'internetEnvironment', 'timeoutMs', 'maxOutputBytes', 'fileToolsEnabled', 'runtimeLayout', 'packageJson', 'packageSha256', 'runtimeVersion', 'runtimeFiles']);
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => !keys.has(key))) fail('SESSION_CONFIG_INVALID', '独立 CLI 配置含未知字段。');
  for (const key of ['enabled', 'acceptedProductMode', 'fileToolsEnabled']) if (config[key] !== undefined && typeof config[key] !== 'boolean') fail('SESSION_CONFIG_INVALID', '启用与模式确认须为布尔值。');
  if (config.internetEnvironment !== undefined && config.internetEnvironment !== 'internal') fail('SESSION_CONFIG_INVALID', '本适配器仅允许经审查的中国区标识或官方默认地区。');
  if (config.runtimeLayout !== undefined && !['legacy_headless', 'official_package'].includes(config.runtimeLayout)) fail('RUNTIME_LAYOUT_UNSUPPORTED', '运行布局必须显式经过审查，不猜测桌面 bundle。');
  return { ...config, enabled: config.enabled === true, acceptedProductMode: config.acceptedProductMode === true };
}

export function readCodeBuddyConfiguration() {
  if (process.env.COLLAB_TEST_MODE === '1') return { enabled: false, acceptedProductMode: false };
  const file = path.join(RUNTIME_ROOT, 'codebuddy-cli.local.json');
  if (!fs.existsSync(file)) return { enabled: false, acceptedProductMode: false };
  const stat = fs.lstatSync(guardedPath(RUNTIME_ROOT, file));
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16384) fail('SESSION_CONFIG_INVALID', '独立配置须为有界普通文件。');
  return normalizeCodeBuddyConfiguration(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function pinnedFile(candidate, hash, kind) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || !/^[a-f0-9]{64}$/i.test(hash ?? '')) fail('LAUNCHER_INVALID', '可信入口须提供绝对文件路径和 SHA256。');
  const stat = fs.lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('LAUNCHER_INVALID', '可信入口必须是普通非链接文件。');
  const real = fs.realpathSync(candidate);
  if ((kind === 'node' && !/\.exe$/i.test(real)) || (kind === 'cli' && path.basename(real) !== 'codebuddy')) fail('LAUNCHER_INVALID', '只能使用可信 Node 程序和固定 bin/codebuddy 脚本。');
  if (sha256(fs.readFileSync(real)) !== hash.toLowerCase()) fail('LAUNCHER_HASH_MISMATCH', '可信入口或 bundle 的哈希已变化。');
  return real;
}

function reviewedPackage(config) {
  const manifestFile = pinnedFile(config.packageJson, config.packageSha256, 'manifest');
  if (path.basename(manifestFile) !== 'package.json' || fs.statSync(manifestFile).size > 65536) fail('RUNTIME_PACKAGE_INVALID', '必须提供已审查的有界官方包清单。');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')), root = path.dirname(manifestFile);
  if (manifest.name !== '@tencent-ai/codebuddy-code' || typeof config.runtimeVersion !== 'string' || manifest.version !== config.runtimeVersion || typeof manifest.bin?.codebuddy !== 'string') fail('RUNTIME_PACKAGE_INVALID', '包名、审查版本或正式 bin 入口不一致；这不证明账号身份。');
  const entry = path.resolve(root, manifest.bin.codebuddy);
  if (!inside(root, entry) || !sameRealPath(entry, config.cliScript) || !['', '.js', '.cjs', '.mjs'].includes(path.extname(entry))) fail('RUNTIME_PACKAGE_INVALID', '只允许官方包清单中的 Node CLI 入口，不执行 shell shim。');
  if (!Array.isArray(config.runtimeFiles) || config.runtimeFiles.length < 1 || config.runtimeFiles.length > 32) fail('RUNTIME_PINS_REQUIRED', '独立布局须显式提供经审查运行文件的 SHA256 清单。');
  const pins = [{ file: manifestFile, sha256: config.packageSha256 }];
  for (const record of config.runtimeFiles) {
    if (!record || Object.keys(record).sort().join(',') !== 'relativePath,sha256' || typeof record.relativePath !== 'string' || record.relativePath.includes(':') || record.relativePath.split(/[\\/]/).some(part => !part || part === '..' || part === '.')) fail('RUNTIME_PINS_REQUIRED', '运行文件 pin 必须是包内安全相对路径。');
    const file = path.resolve(root, record.relativePath);
    if (!inside(root, file) || !inside(fs.realpathSync(root), fs.realpathSync(file))) fail('RUNTIME_PINS_REQUIRED', '运行文件不能越出官方包根。');
    pins.push({ file: pinnedFile(file, record.sha256, 'runtime'), sha256: record.sha256 });
  }
  return pins;
}

export function buildCodeBuddyPlan(config, cwd, conversationId = null, { turnId } = {}) {
  config = normalizeCodeBuddyConfiguration(config);
  if (config.enabled !== true || config.acceptedProductMode !== true) fail('ADAPTER_DISABLED', '独立 CodeBuddy 模式尚未明确授权启用。');
  if (!turnId || !/^[a-zA-Z0-9-]{1,80}$/.test(turnId)) fail('TURN_BINDING_INVALID', '启动计划必须绑定可信控制器轮次。');
  const command = pinnedFile(config.nodeExecutable, config.nodeSha256, 'node');
  const officialPackage = config.runtimeLayout === 'official_package';
  const script = pinnedFile(config.cliScript, config.cliSha256, officialPackage ? 'official_cli' : 'cli');
  const runtimePins = officialPackage ? reviewedPackage(config) : null;
  const bundle = officialPackage ? null : pinnedFile(path.join(path.dirname(path.dirname(script)), 'dist', 'codebuddy-headless.js'), config.headlessSha256, 'bundle');
  const timeoutMs = config.timeoutMs ?? 60000, maxOutputBytes = config.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1024 || maxOutputBytes > 16 * 1024 * 1024) fail('SESSION_CONFIG_INVALID', '时间或输出上限超出范围。');
  if (config.internetEnvironment !== undefined && config.internetEnvironment !== 'internal') fail('SESSION_CONFIG_INVALID', '地区设置未经审查。');
  if (conversationId !== null && (typeof conversationId !== 'string' || !conversationId.length || conversationId.length > 256 || conversationId.startsWith('-') || /[\x00-\x1f]/.test(conversationId))) fail('NATIVE_ID_INVALID', '续接只能使用平台原始字符串编号。');
  const env = {}, system = new Set(['ALLUSERSPROFILE','APPDATA','COMSPEC','HOME','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','PATH','PATHEXT','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','SYSTEMDRIVE','SYSTEMROOT','TEMP','TMP','USERPROFILE','WINDIR']);
  for (const [key, value] of Object.entries(process.env)) if (system.has(key.toUpperCase())) env[key] = value;
  if (config.internetEnvironment) env.CODEBUDDY_INTERNET_ENVIRONMENT = config.internetEnvironment;
  const auditFile = path.join(cwd, 'work', 'session-control', turnId, 'mcp-audit.jsonl');
  const mcpConfigFile = path.join(cwd, 'inputs', 'session-control', turnId, 'mcp-config.json');
  const fileToolsEnabled = config.fileToolsEnabled === true;
  const bindingFile = path.join(path.dirname(mcpConfigFile), 'file-binding.json');
  const toolNames = fileToolsEnabled ? SESSION_FILE_TOOLS : ['get_capabilities'];
  const expectedTools = toolNames.map(name => `mcp__${CODEBUDDY_MCP_NAME}__${name}`);
  const probeScript = fileURLToPath(new URL(fileToolsEnabled ? './session-file-server.mjs' : './codebuddy-probe-server.mjs', import.meta.url));
  const mcpConfiguration = { mcpServers: { [CODEBUDDY_MCP_NAME]: { type: 'stdio', command, args: [probeScript, '--audit-log', auditFile, ...(fileToolsEnabled ? ['--binding-file', bindingFile] : [])], cwd,
    env: { COLLAB_PROJECT_ROOT: PROJECT_ROOT, ...(process.env.COLLAB_TEST_MODE === '1' ? { COLLAB_TEST_MODE: '1' } : {}) }, alwaysLoad: true } } };
  const args = [script, '--print', '--input-format', 'text', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfigFile,
    '--setting-sources', '', '--permission-mode', 'dontAsk', '--allowedTools', ...expectedTools, '--disallowedTools', ...CODEBUDDY_BUILTIN_DENY_TOOLS,
    '--max-turns', '3', ...(conversationId === null ? [] : ['--resume', conversationId])];
  return { command, args, cwd, conversationId, env, timeoutMs, maxOutputBytes, shell: false, windowsHide: true, auditFile, mcpConfigFile, mcpConfiguration,
    launcherSha256: config.nodeSha256.toLowerCase(), scriptSha256: config.cliSha256.toLowerCase(), headlessSha256: officialPackage ? null : config.headlessSha256.toLowerCase(), bundle, runtimePins, runtimeLayout: config.runtimeLayout ?? 'legacy_headless', fileToolsEnabled, bindingFile, toolNames, expectedTools,
    probeScript, probeSha256: sha256(fs.readFileSync(probeScript)),
    platformStorage: { kind: 'local_cli_records', location: null, documentedDefaultRoot: path.join(env.USERPROFILE ?? env.HOME ?? os.homedir(), '.codebuddy', 'projects'), verified: false },
    textOnly: true, desktopContextVerified: false, fileAccessBoundaryVerified: false, osIsolationVerified: false };
}

export function parseCodeBuddyEvents(events, { cwd, conversationId = null, exitCode, signal, timedOut = false, truncated = false, protocolError = false, mcpAudit = null, expectedTools = [CODEBUDDY_TOOL_NAME] }) {
  const inits = events.filter(item => item.type === 'system' && item.subtype === 'init'), results = events.filter(item => item.type === 'result');
  const init = inits[0], ids = [...new Set(events.map(item => item.session_id).filter(id => id !== undefined))];
  const nativeId = inits.length >= 1 && typeof init.session_id === 'string' && init.session_id.length ? init.session_id : null;
  let reason = timedOut ? 'TIMEOUT_UNKNOWN' : truncated ? 'OUTPUT_TRUNCATED' : protocolError ? 'PROTOCOL_INVALID' : null;
  if (!reason && events.some(item => item.type === 'control_request')) reason = 'INTERACTIVE_CONTROL_REQUIRED';
  if (!reason && (nativeId === null || inits.some(item => typeof item.session_id !== 'string' || !item.session_id.length) || ids.some(id => typeof id !== 'string'))) reason = 'NATIVE_ID_MISSING';
  if (!reason && inits.some(item => item.session_id.length > 256 || item.session_id.startsWith('-') || /[\x00-\x1f]/.test(item.session_id))) reason = 'NATIVE_ID_INVALID';
  if (!reason && (ids.some(id => id !== nativeId) || (conversationId !== null && conversationId !== nativeId))) reason = 'NATIVE_ID_MISMATCH';
  // 重复 init 逐条校验，不能只去重保留首条而忽略后续权限变化。
  if (!reason && inits.some(item => typeof item.cwd !== 'string' || !path.isAbsolute(item.cwd))) reason = 'CWD_MISSING';
  if (!reason) { try { if (inits.some(item => !sameRealPath(item.cwd, cwd))) reason = 'CWD_MISMATCH'; } catch { reason = 'CWD_MISMATCH'; } }
  if (!reason && inits.some(item => !Array.isArray(item.tools) || item.tools.length !== expectedTools.length || new Set(item.tools).size !== expectedTools.length || item.tools.some(name => !expectedTools.includes(name)))) reason = 'TOOL_SET_VIOLATION';
  if (!reason && inits.some(item => !Array.isArray(item.mcp_servers) || item.mcp_servers.length !== 1 || item.mcp_servers[0]?.name !== CODEBUDDY_MCP_NAME || item.mcp_servers[0]?.status !== 'connected')) reason = 'MCP_STATE_UNVERIFIED';
  const toolUses = events.flatMap(item => item.message?.content ?? []).filter(item => item.type === 'tool_use');
  if (!reason && toolUses.some(item => !expectedTools.includes(item.name) || !validFileArguments(item.name.slice(`mcp__${CODEBUDDY_MCP_NAME}__`.length), item.input))) reason = 'MCP_TOOL_VIOLATION';
  if (!reason && !mcpAudit?.verified) reason = 'MCP_AUDIT_UNVERIFIED';
  if (!reason && toolUses.length > (mcpAudit.counts?.['tools/call'] ?? 0)) reason = 'MCP_CALL_AUDIT_MISMATCH';
  if (!reason && mcpAudit.toolCalls && toolUses.some(item => !mcpAudit.toolCalls.some(call => item.name === `mcp__${CODEBUDDY_MCP_NAME}__${call.toolName}` && call.argumentsSha256 === sha256(JSON.stringify(item.input))))) reason = 'MCP_CALL_AUDIT_MISMATCH';
  if (!reason && results.length !== 1) reason = 'RESULT_MISSING';
  if (!reason) { try { if (results[0].session_id !== nativeId || (results[0].cwd !== undefined && (typeof results[0].cwd !== 'string' || !sameRealPath(results[0].cwd, cwd)))) reason = 'RESULT_BINDING_MISMATCH'; } catch { reason = 'RESULT_BINDING_MISMATCH'; } }
  if (!reason && (signal || exitCode !== 0)) reason = 'PROCESS_EXIT_FAILED';
  if (!reason && (results[0].is_error !== false || results[0].subtype !== 'success')) reason = 'PLATFORM_RESULT_FAILED';
  if (!reason && typeof results[0].result !== 'string') reason = 'RESULT_INVALID';
  const replies = events.filter(item => item.type === 'assistant').flatMap(item => (item.message?.content ?? []).filter(block => block.type === 'text').map(block => block.text));
  return { status: reason ? (['PROCESS_EXIT_FAILED','PLATFORM_RESULT_FAILED'].includes(reason) ? 'failed' : 'unknown') : 'succeeded', reason,
    conversationId: ['NATIVE_ID_MISSING','NATIVE_ID_MISMATCH','NATIVE_ID_INVALID','RESULT_BINDING_MISMATCH'].includes(reason) ? null : nativeId,
    idSource: nativeId ? 'system.init.session_id' : null, observedNativeIds: ids, observedCwd: init?.cwd ?? null, initializationCount: inits.length,
    workingDirectoryVerified: !reason, mcpHandshakeVerified: mcpAudit?.handshakeVerified === true, mcpCallVerified: !reason && mcpAudit?.callVerified === true, mcpAudit,
    fileAccessBoundaryVerified: false, osIsolationVerified: false, desktopContextVerified: false,
    replies: sanitizeCodeBuddyValue(replies), result: results.length === 1 ? sanitizeCodeBuddyValue(results[0]) : null, exitCode, signal, timedOut, truncated };
}

export class CodeBuddyCliAdapter {
  constructor(config) { this.config = config; this.evidenceLevel = 'real_runtime'; this.platform = 'workbuddy'; this.mode = 'codebuddy_cli'; }
  prepare(cwd, conversationId, context) { return buildCodeBuddyPlan(this.config, cwd, conversationId, context); }
  async run({ plan, prompt, workDirectory, inputDirectory, onSpawn = () => {}, onLaunchAttempt = () => {} }) {
    if (process.env.COLLAB_TEST_MODE === '1' && (this.evidenceLevel !== 'local_test' || PROJECT_ROOT === SOURCE_ROOT || !inside(PROJECT_ROOT, plan.args[0]))) fail('TEST_OFFICIAL_EXECUTION_FORBIDDEN', '离线测试只允许隔离根内的明确 fixture。');
    if (plan.cwd !== path.dirname(path.dirname(path.dirname(workDirectory))) || path.dirname(plan.mcpConfigFile) !== inputDirectory || path.dirname(plan.auditFile) !== workDirectory) fail('TURN_BINDING_INVALID', '启动文件必须属于本轮任务目录。');
    pinnedFile(plan.command, plan.launcherSha256, 'node'); pinnedFile(plan.args[0], plan.scriptSha256, plan.runtimeLayout === 'official_package' ? 'official_cli' : 'cli');
    if (plan.runtimePins) for (const pin of plan.runtimePins) pinnedFile(pin.file, pin.sha256, 'runtime');
    else pinnedFile(plan.bundle, plan.headlessSha256, 'bundle');
    if (sha256(fs.readFileSync(plan.probeScript)) !== plan.probeSha256) fail('LAUNCHER_HASH_MISMATCH', '专用 MCP 服务源码已经变化。');
    fs.writeFileSync(guardedPath(inputDirectory, plan.mcpConfigFile, { mustExist: false }), JSON.stringify(plan.mcpConfiguration), { flag: 'wx' });
    if (plan.fileToolsEnabled) fs.writeFileSync(guardedPath(inputDirectory, plan.bindingFile, { mustExist: false }), JSON.stringify(plan.fileBinding), { flag: 'wx' });
    const streamFile = path.join(workDirectory, 'native-stream.jsonl'), stderrFile = path.join(workDirectory, 'stderr.txt');
    const streamFd = fs.openSync(streamFile, 'wx'), stderrFd = fs.openSync(stderrFile, 'wx');
    const events = []; let tail = Buffer.alloc(0), stderr = Buffer.alloc(0), count = 0, timedOut = false, truncated = false, protocolError = false, spawnError = null, earlyAbort = null, child, timer, pid = null;
    const saveLine = bytes => {
      if (!bytes.length) return;
      try {
        const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error('事件不是协议对象');
        events.push(event); fs.writeSync(streamFd, JSON.stringify(sanitizeCodeBuddyValue(event)) + '\n');
        if (event.type === 'system' && event.subtype === 'init') {
          const check = parseCodeBuddyEvents(events.filter(item => item.type === 'system' && item.subtype === 'init'), {
            cwd:plan.cwd,conversationId:plan.conversationId,expectedTools:plan.expectedTools,exitCode:0,signal:null,mcpAudit:{verified:true,counts:{'tools/call':0}} });
          if (check.reason !== 'RESULT_MISSING') earlyAbort ??= check.reason;
        }
        if (event.type === 'control_request') earlyAbort ??= 'INTERACTIVE_CONTROL_REQUIRED';
        if (earlyAbort) child?.kill();
      }
      catch { protocolError = true; child?.kill(); fs.writeSync(streamFd, JSON.stringify({ type: 'unparsed', text: sanitizeCodeBuddyValue(bytes.toString('utf8')) }) + '\n'); }
    };
    try {
      onLaunchAttempt();
      child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
      timer = setTimeout(() => { timedOut = true; child.kill(); }, plan.timeoutMs);
      child.on('spawn', () => { pid = child.pid; try { onSpawn(pid); } catch { protocolError = true; child.kill(); } });
      child.on('error', error => { spawnError = sanitizeCodeBuddyValue(error.message); });
      const accept = bytes => { count += bytes.length; if (count > plan.maxOutputBytes) { if (!truncated) child.kill(); truncated = true; return false; } return true; };
      child.stdout.on('data', bytes => { if (!accept(bytes)) return; tail = Buffer.concat([tail,bytes]); let end; while ((end = tail.indexOf(10)) >= 0) { saveLine(tail.subarray(0,end)); tail = tail.subarray(end + 1); } });
      child.stderr.on('data', bytes => { if (accept(bytes)) stderr = Buffer.concat([stderr,bytes]); });
      child.stdin.on('error', () => { protocolError = true; }); child.stdin.end(Buffer.from(prompt,'utf8'));
      const closed = await new Promise(resolve => child.once('close', (exitCode, signal) => resolve({ exitCode, signal })));
      if (tail.length) saveLine(tail);
      fs.writeSync(stderrFd, sanitizeCodeBuddyValue(stderr.toString('utf8')));
      let mcpAudit = null, auditError = null;
      try { mcpAudit = readCodeBuddyAudit(plan.auditFile, { cwd: plan.cwd, cliPid: pid, toolNames: plan.toolNames }); } catch (error) { auditError = { code: error.code ?? 'MCP_AUDIT_UNVERIFIED', message: sanitizeCodeBuddyValue(error.message) }; }
      const parsed = parseCodeBuddyEvents(events, { ...closed, cwd: plan.cwd, conversationId: plan.conversationId, expectedTools: plan.expectedTools, timedOut, truncated, protocolError, mcpAudit });
      return { ...parsed, ...(earlyAbort ? { status:'unknown',reason:earlyAbort,workingDirectoryVerified:false,mcpCallVerified:false } : {}), ...(spawnError ? { status:'unknown', reason:'SPAWN_ERROR', spawnError } : {}), earlyAbort, auditError, evidenceLevel:this.evidenceLevel,
        modelRequestState: this.evidenceLevel === 'local_test' ? 'not_model_local_test' : 'unknown', platformStorage:plan.platformStorage,
        launcherSha256:plan.launcherSha256, scriptSha256:plan.scriptSha256, headlessSha256:plan.headlessSha256,
        files:[streamFile,stderrFile,...(fs.existsSync(plan.auditFile) ? [plan.auditFile] : [])] };
    } finally { clearTimeout(timer); fs.closeSync(streamFd); fs.closeSync(stderrFd); }
  }
}
