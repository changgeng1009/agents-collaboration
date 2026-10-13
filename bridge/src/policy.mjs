import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 授权根只来自本进程的可信启动配置，工具参数与消息正文不能改变它。
export const BRIDGE_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const SOURCE_ROOT = path.dirname(BRIDGE_ROOT);
const configuredRoot = process.env.COLLAB_PROJECT_ROOT;
if (configuredRoot && !path.isAbsolute(configuredRoot)) throw new Error('授权项目根必须是绝对路径。');
export const PROJECT_ROOT = fs.realpathSync(configuredRoot ?? SOURCE_ROOT);
if (!fs.statSync(PROJECT_ROOT).isDirectory()) throw new Error('授权项目根必须是现有目录。');
export const PROJECT_ID = 'ai-collaboration-t1';
export const ARTIFACT_ROOT = path.join(PROJECT_ROOT, 'artifacts', 't1');
export const RUNTIME_ROOT = path.join(PROJECT_ROOT, 'bridge', 'runtime');
export const LOG_ROOT = path.join(PROJECT_ROOT, 'logs', 'bridge');

export function readToolchainConfig() {
  if (process.env.COLLAB_TEST_MODE === '1') return {};
  const file = path.join(RUNTIME_ROOT, 'toolchain.local.json');
  if (!fs.existsSync(file)) return {};
  const parsed = JSON.parse(fs.readFileSync(guardedPath(RUNTIME_ROOT, file), 'utf8'));
  const allowedKeys = new Set(['codexExecutable', 'nodeExecutable', 'npmCli']);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !allowedKeys.has(key))) fail('TOOLCHAIN_CONFIG_INVALID', '本地程序配置包含不支持的字段。');
  for (const value of Object.values(parsed)) if (typeof value !== 'string' || !path.isAbsolute(value)) fail('TOOLCHAIN_PATH_INVALID', '本地程序路径必须是绝对路径。');
  return parsed;
}

export function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

export function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// 既检查规范路径，也检查真实路径，阻止 ../、盘符切换、符号链接与目录联接越界。
export function guardedPath(root, candidate, { mustExist = true } = {}) {
  const resolved = path.resolve(candidate);
  if (!inside(root, resolved)) fail('PATH_OUTSIDE_SCOPE', '路径超出授权目录。');
  let ancestor = resolved;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) fail('PATH_NOT_FOUND', '路径不存在。');
    ancestor = parent;
  }
  if (!inside(root, fs.realpathSync(ancestor))) fail('REALPATH_OUTSIDE_SCOPE', '真实路径超出授权目录。');
  if (mustExist && !fs.existsSync(resolved)) fail('PATH_NOT_FOUND', '路径不存在。');
  return resolved;
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function redact(text) {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[已脱敏邮箱]')
    .replace(/\b(?:sk-|sess-)[A-Za-z0-9_-]+/g, '[已脱敏令牌]')
    .replace(/(Bearer\s+)[^\s"']+/gi, '$1[已脱敏令牌]');
}
