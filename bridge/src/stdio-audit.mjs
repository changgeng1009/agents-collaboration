import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT, guardedPath, fail, sha256 } from './policy.mjs';
import { sanitizeSessionValue } from './claude-code-adapter.mjs';

// 仅可信启动参数可以启用；不保存工具正文、凭据或原始消息。
export function attachStdioAudit(transport, { file, toolNames }) {
  if (!file) return { enabled: false };
  const logRoot = path.join(PROJECT_ROOT, 'logs');
  fs.mkdirSync(guardedPath(PROJECT_ROOT, logRoot, { mustExist: false }), { recursive: true });
  if (!path.isAbsolute(file) || !file.endsWith('.jsonl')) fail('AUDIT_PATH_INVALID', '审计文件须为项目 logs 内的绝对 jsonl 路径。');
  const target = guardedPath(logRoot, file, { mustExist: false });
  const checkLinks = () => {
    let cursor = logRoot;
    for (const part of path.relative(logRoot, target).split(path.sep)) {
      cursor = path.join(cursor, part);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('AUDIT_LINK_FORBIDDEN', '审计路径不能使用链接或目录联接。'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  };
  checkLinks();
  fs.mkdirSync(path.dirname(target), { recursive: true }); guardedPath(logRoot, path.dirname(target));
  if (fs.existsSync(target) && !fs.statSync(target).isFile()) fail('AUDIT_PATH_INVALID', '审计目标须为普通文件。');
  const names = new Set(toolNames), pending = new Map();
  let clientInfo = null, currentHandler;
  const safeId = value => typeof value === 'string' ? sanitizeSessionValue(value).slice(0, 128) : typeof value === 'number' ? value : null;
  const record = value => {
    guardedPath(logRoot, target, { mustExist: false }); checkLinks();
    fs.appendFileSync(target, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, parentPid: process.ppid, processCwd: process.cwd(), projectRoot: PROJECT_ROOT, ...value }) + '\n', 'utf8');
  };
  Object.defineProperty(transport, 'onmessage', { configurable: true, get: () => currentHandler, set: handler => {
    currentHandler = message => {
      if (['initialize', 'tools/list', 'tools/call'].includes(message.method)) {
        if (message.method === 'initialize') clientInfo = { name: sanitizeSessionValue(String(message.params?.clientInfo?.name ?? '')).slice(0, 256), version: sanitizeSessionValue(String(message.params?.clientInfo?.version ?? '')).slice(0, 128) };
        const toolName = message.method === 'tools/call' ? (names.has(message.params?.name) ? message.params.name : 'unknown_tool') : null;
        const metadata = { method: message.method, toolName, jsonRpcId: safeId(message.id), clientInfo, paramsSha256: sha256(JSON.stringify(message.params ?? null)) };
        if (pending.size >= 2048) fail('AUDIT_REQUEST_LIMIT', '同时在途审计请求超出本地上限。');
        pending.set(message.id, metadata); record({ direction: 'client_to_server', ...metadata, resultSha256: null, success: null });
      }
      handler?.(message);
    };
  } });
  const send = transport.send.bind(transport);
  transport.send = async message => {
    await send(message);
    const metadata = pending.get(message.id);
    if (metadata) { pending.delete(message.id); record({ direction: 'server_to_client', ...metadata,
      resultSha256: sha256(JSON.stringify(message.result ?? message.error ?? null)), success: !message.error && message.result?.isError !== true }); }
  };
  return { enabled: true, file: target, clientInfoIsSelfReported: true, bodyRecorded: false, credentialRecorded: false };
}
