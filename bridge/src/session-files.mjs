import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROJECT_ROOT, guardedPath, fail, sha256 } from './policy.mjs';

export const SESSION_FILE_LIMIT = 32768;
export const SESSION_FILE_TOOLS = ['get_capabilities', 'read_task_file', 'write_task_file'];
const statId = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function sessionPath(file, mustExist = true) {
  const checked = guardedPath(PROJECT_ROOT, file, { mustExist });
  let cursor = PROJECT_ROOT;
  for (const part of path.relative(PROJECT_ROOT, checked).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('FILE_LINK_FORBIDDEN', '文件工具拒绝符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return checked;
}
function directoryId(directory) {
  sessionPath(directory); const stat = fs.statSync(directory, { bigint: true });
  if (!stat.isDirectory()) fail('FILE_DIRECTORY_REQUIRED', '文件范围组件必须为普通目录。');
  return { path: path.resolve(directory), realPath: fs.realpathSync(directory), ...statId(stat) };
}
function ordinary(stat) { if (!stat.isFile() || stat.nlink !== 1n) fail('FILE_IDENTITY_INVALID', '文件必须为单硬链接普通文件。'); }
export function readBoundedFile(file, limit = SESSION_FILE_LIMIT) {
  sessionPath(file); const before = fs.lstatSync(file, { bigint: true }); ordinary(before);
  if (before.size > BigInt(limit)) fail('FILE_TOO_LARGE', '文件超过有界读取上限。');
  const fd = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(fd, { bigint: true }); ordinary(opened);
    if (!same(statId(before), statId(opened)) || before.size !== opened.size || before.mtimeNs !== opened.mtimeNs) fail('FILE_REPLACED', '文件打开时身份变化。');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) fail('FILE_CHANGED', '文件读取未完成。'); offset += count; }
    sessionPath(file);
    for (const after of [fs.fstatSync(fd, { bigint: true }), fs.lstatSync(file, { bigint: true })]) {
      ordinary(after);
      if (!same(statId(opened), statId(after)) || opened.size !== after.size || opened.mtimeNs !== after.mtimeNs) fail('FILE_CHANGED', '文件读取时发生变化。');
    }
    return { bytes, identity: statId(opened), sha256: sha256(bytes), byteLength: bytes.length };
  } finally { fs.closeSync(fd); }
}
export function verifyFileWorkspace(workspace) {
  if (!workspace || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(workspace.taskId ?? '')) fail('FILE_BINDING_INVALID', '文件工具必须绑定已登记任务。');
  const root = path.join(PROJECT_ROOT, 'task-workspaces', workspace.taskId);
  const paths = { taskRoot: root, inputs: path.join(root, 'inputs'), work: path.join(root, 'work'), outputs: path.join(root, 'outputs') };
  for (const [name, directory] of Object.entries(paths)) {
    if (workspace[name] !== directory || !same(directoryId(directory), workspace.identities?.[name])) fail('FILE_WORKSPACE_CHANGED', '原任务目录身份或绑定不一致。');
  }
  if (readBoundedFile(path.join(root, '.task-binding.json'), 4096).sha256 !== workspace.markerSha256) fail('FILE_WORKSPACE_CHANGED', '任务绑定文件已变化。');
}
export function createFileScope(workspace) {
  verifyFileWorkspace(workspace);
  const scope = { taskId: workspace.taskId, bindingId: randomUUID(), workspaceBinding: workspace.markerSha256, directories: {} };
  for (const area of ['inputs', 'work', 'outputs']) {
    const directory = sessionPath(path.join(workspace[area], 'files'), false);
    fs.mkdirSync(directory);
    scope.directories[area] = directoryId(directory);
  }
  verifyFileWorkspace(workspace); return scope;
}
function safeRelative(value) {
  if (typeof value !== 'string' || !value.length || value.length > 240 || path.isAbsolute(value) || /[:\x00-\x1f]/.test(value)) fail('FILE_PATH_FORBIDDEN', '只接受任务 files 范围内的相对文件名。');
  const parts = value.split(/[\\/]/);
  if (parts.length > 8 || parts.some(part => !/^[A-Za-z0-9_\u4e00-\u9fff .-]+$/.test(part) || part === '.' || part === '..' || /[. ]$/.test(part) || /^[.]/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) fail('FILE_PATH_FORBIDDEN', '文件名包含父级、别名、设备名或不支持的字符。');
  return parts;
}
export function validFileArguments(name, args) {
  const fields = name === 'read_task_file' ? ['area', 'relativePath'] : name === 'write_task_file' ? ['area', 'relativePath', 'text'] : name === 'get_capabilities' ? [] : null;
  if (!fields || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== fields.length || fields.some(key => !Object.hasOwn(args, key))) return false;
  if (!fields.length) return true;
  try { if (!['inputs', 'work', 'outputs'].includes(args.area)) return false; safeRelative(args.relativePath); if (name === 'write_task_file' && (args.area === 'inputs' || typeof args.text !== 'string' || !args.text.isWellFormed() || Buffer.byteLength(args.text, 'utf8') > SESSION_FILE_LIMIT)) return false; return true; } catch { return false; }
}
export class SessionFiles {
  constructor({ workspace, scope, manager = false }) { this.workspace = structuredClone(workspace); this.scope = structuredClone(scope); this.manager = manager; this.verify(); }
  verify() {
    verifyFileWorkspace(this.workspace);
    if (this.scope.taskId !== this.workspace.taskId || this.scope.workspaceBinding !== this.workspace.markerSha256) fail('FILE_BINDING_INVALID', '文件范围不属于该任务绑定。');
    for (const area of ['inputs', 'work', 'outputs']) {
      const expected = path.join(this.workspace[area], 'files');
      if (!same(directoryId(expected), this.scope.directories[area])) fail('FILE_SCOPE_CHANGED', '原文件范围目录被替换。');
    }
  }
  target(area, relativePath) {
    if (!['inputs', 'work', 'outputs'].includes(area)) fail('FILE_AREA_FORBIDDEN', '只允许 inputs/work/outputs 文件范围。');
    return sessionPath(path.join(this.scope.directories[area].path, ...safeRelative(relativePath)), false);
  }
  read({ area, relativePath }) {
    this.verify(); const result = readBoundedFile(this.target(area, relativePath)); this.verify();
    return { taskId: this.workspace.taskId, area, relativePath, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(result.bytes), sha256: result.sha256, byteLength: result.byteLength, readbackVerified: true, osIsolationVerified: false };
  }
  write({ area, relativePath, text }) {
    this.verify();
    if (area === 'inputs' && !this.manager) fail('FILE_WRITE_FORBIDDEN', '模型文件工具不能写入 inputs。');
    if (typeof text !== 'string' || !text.isWellFormed() || Buffer.byteLength(text, 'utf8') > SESSION_FILE_LIMIT) fail('FILE_TEXT_INVALID', '正文必须为有效有界 UTF-8 文本。');
    const file = this.target(area, relativePath), bytes = Buffer.from(text, 'utf8');
    fs.mkdirSync(sessionPath(path.dirname(file), false), { recursive: true }); this.verify(); sessionPath(path.dirname(file));
    const fd = fs.openSync(file, 'wx', 0o600);
    try { ordinary(fs.fstatSync(fd, { bigint: true })); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    const result = this.read({ area, relativePath });
    if (result.sha256 !== sha256(bytes)) fail('FILE_WRITE_UNKNOWN', '写后读回不一致，文件保留，不自动重写。');
    return { ...result, text: undefined, created: true, overwritten: false };
  }
}
