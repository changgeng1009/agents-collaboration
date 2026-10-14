import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, guardedPath, fail, sha256 } from './policy.mjs';

export const CODEBUDDY_MCP_NAME = 't2_candidate';
export const CODEBUDDY_TOOL_NAME = `mcp__${CODEBUDDY_MCP_NAME}__get_capabilities`;
export const AUDIT_BYTE_LIMIT = 256 * 1024;
const comparable = value => process.platform === 'win32' ? value.toLowerCase() : value;
export const sameRealPath = (left, right) => comparable(fs.realpathSync(left)) === comparable(fs.realpathSync(right));

export function taskAuditPath(file, cwd, { mustExist = true } = {}) {
  const taskBase = path.join(PROJECT_ROOT, 'task-workspaces');
  if (!path.isAbsolute(cwd) || comparable(path.dirname(path.resolve(cwd))) !== comparable(taskBase)) fail('AUDIT_TASK_SCOPE', '审计必须绑定本项目的一个任务根。');
  guardedPath(taskBase, cwd);
  const target = guardedPath(path.join(cwd, 'work'), file, { mustExist });
  if (!path.isAbsolute(file) || path.extname(target) !== '.jsonl') fail('AUDIT_PATH_INVALID', '任务审计须为 work 内的绝对 jsonl 路径。');
  let cursor = PROJECT_ROOT;
  for (const part of path.relative(PROJECT_ROOT, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink()) fail('AUDIT_LINK_FORBIDDEN', '任务审计路径不能使用链接或目录联接。');
      if (cursor === target && (!stat.isFile() || stat.nlink !== 1)) fail('AUDIT_FILE_INVALID', '任务审计必须是独占普通文件。');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return target;
}

// 专用任务审计不改变原 project/logs 审计的范围或行为。
export function attachCodeBuddyAudit(transport, { file, cwd }) {
  const target = taskAuditPath(file, cwd, { mustExist: false });
  const fd = fs.openSync(target, 'wx');
  const identity = fs.fstatSync(fd), pending = new Map();
  let written = 0, handler, clientInfo = null;
  const record = value => {
    taskAuditPath(target, cwd);
    const stat = fs.statSync(target);
    if (stat.dev !== identity.dev || stat.ino !== identity.ino) fail('AUDIT_FILE_REPLACED', '任务审计文件已被替换。');
    const bytes = Buffer.from(JSON.stringify({ at: new Date().toISOString(), pid: process.pid, parentPid: process.ppid, processCwd: process.cwd(), ...value }) + '\n', 'utf8');
    if (written + bytes.length > AUDIT_BYTE_LIMIT) fail('AUDIT_OUTPUT_LIMIT', '任务审计达到有界输出上限。');
    fs.writeSync(fd, bytes); written += bytes.length;
  };
  const safeId = value => typeof value === 'number' ? value : typeof value === 'string' ? sha256(value) : null;
  Object.defineProperty(transport, 'onmessage', { configurable: true, get: () => handler, set: next => {
    handler = message => {
      if (['initialize', 'tools/list', 'tools/call'].includes(message.method)) {
        if (message.method === 'initialize') clientInfo = { nameSha256: sha256(String(message.params?.clientInfo?.name ?? '')), versionSha256: sha256(String(message.params?.clientInfo?.version ?? '')) };
        if (pending.size >= 128) fail('AUDIT_REQUEST_LIMIT', '任务审计在途请求过多。');
        const metadata = { method: message.method, jsonRpcId: safeId(message.id), toolName: message.method === 'tools/call' ? (message.params?.name === 'get_capabilities' ? 'get_capabilities' : 'unknown_tool') : null,
          clientInfo, paramsSha256: sha256(JSON.stringify(message.params ?? null)) };
        pending.set(message.id, metadata); record({ direction: 'client_to_server', ...metadata, success: null });
      }
      next?.(message);
    };
  } });
  const send = transport.send.bind(transport);
  transport.send = async message => {
    await send(message);
    const metadata = pending.get(message.id);
    if (metadata) { pending.delete(message.id); record({ direction: 'server_to_client', ...metadata, success: !message.error && message.result?.isError !== true,
      resultSha256: sha256(JSON.stringify(message.result ?? message.error ?? null)) }); }
  };
  return { close: () => fs.closeSync(fd), file: target };
}

export function readCodeBuddyAudit(file, { cwd, cliPid }) {
  const target = taskAuditPath(file, cwd), fd = fs.openSync(target, 'r');
  let bytes;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > AUDIT_BYTE_LIMIT) fail('AUDIT_FILE_INVALID', '审计不是有界独占普通文件。');
    bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail('AUDIT_FILE_CHANGED', '审计读取不完整。'); offset += count; }
    const after = fs.statSync(taskAuditPath(file, cwd));
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail('AUDIT_FILE_CHANGED', '审计读取时发生变化。');
  } finally { fs.closeSync(fd); }
  const records = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  if (!records.length || records.length > 512 || records.some(item => !item || !Number.isSafeInteger(item.pid) || item.parentPid !== cliPid || !sameRealPath(item.processCwd, cwd))) fail('MCP_AUDIT_BINDING_MISMATCH', '审计来源必须为本次 CLI 的任务 MCP 子进程。');
  const serverPids = [...new Set(records.map(item => item.pid))];
  if (serverPids.length !== 1) fail('MCP_AUDIT_BINDING_MISMATCH', '任务审计出现多个服务实例，保留未知。');
  if (records.some(item => item.method === 'tools/call' && item.toolName !== 'get_capabilities')) fail('MCP_TOOL_VIOLATION', '审计包含非授权工具。');
  const counts = {};
  for (const method of ['initialize', 'tools/list', 'tools/call']) {
    const calls = records.filter(item => item.direction === 'client_to_server' && item.method === method);
    if ((method !== 'tools/call' && !calls.length) || calls.some(call => !records.some(item => item.direction === 'server_to_client' && item.method === method && item.jsonRpcId === call.jsonRpcId && item.paramsSha256 === call.paramsSha256 && item.success === true && /^[a-f0-9]{64}$/.test(item.resultSha256)))) fail('MCP_AUDIT_INCOMPLETE', '握手与工具清单必须成功，每次声明的能力调用须有成功审计。');
    counts[method] = calls.length;
  }
  return { verified: true, handshakeVerified: true, callVerified: counts['tools/call'] > 0, file: target, sha256: sha256(bytes), bytes: bytes.length, counts, serverPid: serverPids[0], cliPid, clientInfoIsSelfReported: true, bodyRecorded: false };
}
