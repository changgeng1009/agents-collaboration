import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, RUNTIME_ROOT, PROJECT_ID, guardedPath, inside, fail, sha256 } from './policy.mjs';

export const TASK_LOOP_ROOT = path.join(RUNTIME_ROOT, 'task-loop');
export const LOOP_WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'task-workspaces');
export const LOOP_TEXT_LIMIT = 32768;
const now = () => new Date().toISOString();
const actors = new Set(['manager', 'workbuddy', 'doubao']);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function loopId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value)) fail('TASK_ID_INVALID', '任务编号必须为安全标识符，不能包含路径或设备名。');
  return value;
}
function requestId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail('REQUEST_ID_INVALID', '请求编号必须是有界安全标识符。');
}
function strictArgs(args, fields) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(args, key))) fail('ARGUMENT_SCOPE', '参数缺失或包含角色、目录等未授权字段。');
}
function textBytes(value) {
  if (typeof value !== 'string' || !value.length || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > LOOP_TEXT_LIMIT) fail('TEXT_LIMIT', '正文必须为有效 Unicode，非空且 UTF-8 不超过 32 KiB。');
  return Buffer.from(value, 'utf8');
}

// 所有路径由可信启动根和固定文件名推导；拒绝中间链接、目录联接及多硬链接文件。
export function loopPath(candidate, { mustExist = true } = {}) {
  const result = guardedPath(PROJECT_ROOT, candidate, { mustExist });
  let cursor = PROJECT_ROOT;
  for (const part of path.relative(PROJECT_ROOT, result).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('LOOP_LINK_FORBIDDEN', '任务闭环路径不能使用链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return result;
}
function identity(stat) { return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) }; }
function sameIdentity(a, b) { return JSON.stringify(identity(a)) === JSON.stringify(identity(b)); }
function ordinary(stat) { if (!stat.isFile() || stat.nlink !== 1n) fail('LOOP_FILE_INVALID', '任务闭环文件必须为单链接普通文件。'); }
function directoryIdentity(directory) {
  const checked = loopPath(directory), stat = fs.statSync(checked, { bigint: true });
  if (!stat.isDirectory()) fail('LOOP_DIRECTORY_INVALID', '任务路径组件必须为普通目录。');
  return { path: checked, realPath: fs.realpathSync(checked), ...identity(stat) };
}
function exactRead(file, expected, maxBytes = LOOP_TEXT_LIMIT) {
  loopPath(file);
  const before = fs.lstatSync(file, { bigint: true }); ordinary(before);
  if (before.size > BigInt(maxBytes)) fail('LOOP_FILE_LIMIT', '文件超过允许读取上限。');
  const descriptor = fs.openSync(file, 'r');
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true }); ordinary(opened);
    if (!sameIdentity(before, opened) || before.size !== opened.size || before.mtimeNs !== opened.mtimeNs) fail('LOOP_FILE_REPLACED', '打开文件时身份发生变化。');
    if (expected.identity && JSON.stringify(identity(opened)) !== JSON.stringify(expected.identity)) fail('LOOP_FILE_REPLACED', '文件身份与登记值不符。');
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(descriptor, bytes, offset, bytes.length - offset, offset); if (!count) fail('LOOP_FILE_CHANGED', '文件读取未完成。'); offset += count; }
    const after = fs.fstatSync(descriptor, { bigint: true }); ordinary(after);
    loopPath(file);
    const located = fs.lstatSync(file, { bigint: true }); ordinary(located);
    if (![after, located].every(stat => sameIdentity(opened, stat) && stat.size === opened.size && stat.mtimeNs === opened.mtimeNs)) fail('LOOP_FILE_CHANGED', '文件在读取时发生变化。');
    if (bytes.length !== expected.byteLength || sha256(bytes) !== expected.sha256) fail('LOOP_CONTENT_MISMATCH', '真实文件正文与登记哈希或长度不一致。');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text, identity: identity(opened) };
  } finally { fs.closeSync(descriptor); }
}
function exclusiveWrite(file, bytes) {
  loopPath(file, { mustExist: false });
  const descriptor = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  const expected = { sha256: sha256(bytes), byteLength: bytes.length };
  return { ...expected, identity: exactRead(file, expected).identity };
}

export class TaskLoopStore {
  constructor({ actor, taskId = null, dbPath = path.join(TASK_LOOP_ROOT, 'tasks.sqlite'), leaseMs = 15 * 60 * 1000 }) {
    if (!actors.has(actor)) fail('ROLE_DISABLED', '任务闭环只允许固定 manager、workbuddy 或 doubao 角色。');
    if (actor === 'manager' ? taskId !== null : taskId === null) fail('STARTUP_BINDING_REQUIRED', '执行角色必须在启动时绑定唯一任务，manager 不绑定执行任务。');
    if (taskId !== null) loopId(taskId);
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30000 || leaseMs > 86400000) fail('LEASE_INVALID', '领取租约必须在 30 秒至 24 小时之间。');
    Object.defineProperties(this, { actor: { value: actor, enumerable: true }, taskId: { value: taskId, enumerable: true }, leaseMs: { value: leaseMs } });
    for (const directory of [TASK_LOOP_ROOT, LOOP_WORKSPACE_ROOT]) fs.mkdirSync(loopPath(directory, { mustExist: false }), { recursive: true });
    const checkedDb = loopPath(dbPath, { mustExist: false });
    if (!inside(TASK_LOOP_ROOT, checkedDb)) fail('DATABASE_SCOPE', '闭环数据库必须位于独立运行目录。');
    fs.mkdirSync(loopPath(path.dirname(checkedDb), { mustExist: false }), { recursive: true });
    this.dbPath = checkedDb;
    this.checkDatabasePaths();
    this.db = new DatabaseSync(checkedDb);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS loop_tasks(task_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS loop_requests(actor TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,operation,request_id));
      CREATE TABLE IF NOT EXISTS loop_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, task_id TEXT NOT NULL, value TEXT NOT NULL);
      PRAGMA user_version=1;`);
    this.databaseIdentity = identity(fs.lstatSync(this.dbPath, { bigint: true }));
  }
  close() { this.db.close(); }
  checkDatabasePaths() {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const file = loopPath(this.dbPath + suffix, { mustExist: false });
      if (fs.existsSync(file)) {
        const stat = fs.lstatSync(file, { bigint: true }); ordinary(stat);
        if (suffix === '' && this.databaseIdentity && JSON.stringify(identity(stat)) !== JSON.stringify(this.databaseIdentity)) fail('DATABASE_IDENTITY_MISMATCH', '闭环数据库路径已被替换。');
      } else if (suffix === '' && this.databaseIdentity) fail('DATABASE_IDENTITY_MISMATCH', '闭环数据库路径已丢失。');
    }
  }
  transaction(action) {
    this.checkDatabasePaths(); this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  requireManager() { if (this.actor !== 'manager') fail('ROLE_FORBIDDEN', '仅固定 manager 可以派单或独立读回。'); }
  requireExecutor(taskId) { if (this.actor === 'manager' || taskId !== this.taskId) fail('TASK_BINDING_FORBIDDEN', '执行进程只能操作启动时绑定的唯一任务。'); }
  task(taskId) {
    const row = this.db.prepare('SELECT value FROM loop_tasks WHERE task_id=?').get(taskId);
    if (!row) fail('TASK_NOT_FOUND', '指定闭环任务未登记。');
    const task = JSON.parse(row.value);
    if (this.actor !== 'manager' && task.assignee !== this.actor) fail('TASK_ACTOR_FORBIDDEN', '任务没有指派给当前固定角色。');
    return task;
  }
  put(task) { this.db.prepare('INSERT INTO loop_tasks VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value').run(task.taskId, JSON.stringify(task)); }
  event(operation, task, details = {}) { this.db.prepare('INSERT INTO loop_events(at,actor,operation,task_id,value) VALUES(?,?,?,?,?)').run(now(), this.actor, operation, task.taskId, JSON.stringify(details)); }
  request(operation, args) {
    requestId(args.requestId);
    const payloadHash = sha256(JSON.stringify(canonical(args)));
    const previous = this.db.prepare('SELECT * FROM loop_requests WHERE actor=? AND operation=? AND request_id=?').get(this.actor, operation, args.requestId);
    if (previous && previous.payload_hash !== payloadHash) fail('REQUEST_ID_CONFLICT', '相同请求编号不能用于不同正文或绑定。');
    return { payloadHash, previous: previous ? JSON.parse(previous.response) : null };
  }
  saveRequest(operation, args, payloadHash, response) { this.db.prepare('INSERT INTO loop_requests VALUES(?,?,?,?,?) ON CONFLICT(actor,operation,request_id) DO UPDATE SET response=excluded.response').run(this.actor, operation, args.requestId, payloadHash, JSON.stringify(response)); }
  summary(task) {
    return { taskId: task.taskId, assignee: task.assignee, status: task.status, phase: task.phase, createdAt: task.createdAt, completedAt: task.completedAt ?? null,
      conversationId: null, platformIdentityVerified: false, platformCwdVerified: false, fileAccessBoundaryVerified: false, osIsolationVerified: false,
      taskRoot: task.taskRoot, inputSha256: task.input?.sha256 ?? null, claim: task.claim ? { claimId: task.claim.claimId, actor: task.claim.actor, leaseExpiresAt: task.claim.leaseExpiresAt } : null,
      automaticReassignment: false, automaticRetry: false };
  }
  paths(task) {
    const taskRoot = path.join(LOOP_WORKSPACE_ROOT, loopId(task.taskId));
    if (task.taskRoot !== taskRoot) fail('WORKSPACE_BINDING_MISMATCH', '数据库中的任务根与可信推导位置不一致。');
    return { taskRoot, inputs: path.join(taskRoot, 'inputs'), work: path.join(taskRoot, 'work'), outputs: path.join(taskRoot, 'outputs') };
  }
  verifyWorkspace(task) {
    const directories = this.paths(task);
    for (const [name, directory] of Object.entries(directories)) if (JSON.stringify(directoryIdentity(directory)) !== JSON.stringify(task.directories[name])) fail('WORKSPACE_IDENTITY_MISMATCH', '任务目录身份发生变化。');
    exactRead(path.join(directories.taskRoot, '.task-loop-binding.json'), task.marker);
    return directories;
  }
  instruction(task) { const directories = this.verifyWorkspace(task); const result = exactRead(path.join(directories.inputs, 'task.txt'), task.input); this.verifyWorkspace(task); return result.text; }
  readResult(task) {
    const directories = this.verifyWorkspace(task);
    const filePath = path.join(directories.outputs, 'result.txt');
    const result = exactRead(filePath, task.result); this.verifyWorkspace(task);
    return { text: result.text, filePath, sha256: task.result.sha256, byteLength: task.result.byteLength, readbackVerified: true,
      submittedBy: task.assignee, conversationId: null, platformIdentityVerified: false, evidenceLevel: 'local_task_submission_only' };
  }
  capabilities() {
    return { projectId: PROJECT_ID, version: '0.1.8', channel: 'task-loop', actor: this.actor, taskId: this.taskId,
      tools: this.actor === 'manager' ? ['get_capabilities', 'create_task', 'get_task_result'] : ['get_capabilities', 'claim_task', 'submit_task_result'],
      textByteLimit: LOOP_TEXT_LIMIT, leaseMs: this.leaseMs, persistence: 'separate-sqlite-wal', conversationId: null,
      platformIdentityVerified: false, clientInfoIsSelfReported: true, arbitraryFileAccess: false, shellEnabled: false, modelExecutionEnabled: false,
      reviewEnabled: false, publishEnabled: false, accountHistoryEnabled: false, automaticWakeup: false, automaticRetry: false, automaticReassignment: false,
      platformCwdVerified: false, fileAccessBoundaryVerified: false, osIsolationVerified: false };
  }
  createTask(args) {
    this.requireManager(); strictArgs(args, ['requestId', 'taskId', 'assignee', 'body']); loopId(args.taskId);
    if (!['workbuddy', 'doubao'].includes(args.assignee)) fail('ASSIGNEE_FORBIDDEN', '只可指派给受限执行角色。');
    const bytes = textBytes(args.body);
    const reserved = this.transaction(() => {
      const request = this.request('create_task', args);
      if (request.previous) {
        const task = this.task(args.taskId);
        if (task.status === 'unknown') fail('TASK_UNKNOWN', '创建结果未知，保留原占位，不自动重做。');
        this.instruction(task); return { response: { ...request.previous, historicalResponse: true, deduplicated: true } };
      }
      if (this.db.prepare('SELECT 1 FROM loop_tasks WHERE task_id=?').get(args.taskId)) fail('TASK_EXISTS', '同名任务已登记，不覆盖、不自动重派。');
      const task = { taskId: args.taskId, assignee: args.assignee, taskRoot: path.join(LOOP_WORKSPACE_ROOT, args.taskId), status: 'unknown', phase: 'creating', createdAt: now(), claim: null,
        input: { byteLength: bytes.length, sha256: sha256(bytes) } };
      this.put(task); this.saveRequest('create_task', args, request.payloadHash, { task: this.summary(task) }); this.event('create_reserved', task);
      return { task, payloadHash: request.payloadHash };
    });
    if (reserved.response) return reserved.response;
    const task = reserved.task;
    try {
      const directories = this.paths(task);
      fs.mkdirSync(loopPath(directories.taskRoot, { mustExist: false }));
      for (const name of ['inputs', 'work', 'outputs']) fs.mkdirSync(loopPath(directories[name], { mustExist: false }));
      task.directories = Object.fromEntries(Object.entries(directories).map(([name, directory]) => [name, directoryIdentity(directory)]));
      task.marker = exclusiveWrite(path.join(task.taskRoot, '.task-loop-binding.json'), Buffer.from(JSON.stringify({ taskId: task.taskId, assignee: task.assignee, bindingId: randomUUID() }), 'utf8'));
      task.input = exclusiveWrite(path.join(directories.inputs, 'task.txt'), bytes);
      this.instruction(task);
      return this.transaction(() => {
        if (this.task(task.taskId).phase !== 'creating') fail('TASK_STATE_CONFLICT', '创建占位已变化。');
        this.instruction(task);
        task.status = 'queued'; task.phase = 'awaiting_claim'; this.put(task);
        const response = { task: this.summary(task), inputSha256: task.input.sha256 };
        this.saveRequest('create_task', args, reserved.payloadHash, response); this.event('task_created', task, { inputSha256: task.input.sha256 }); return response;
      });
    } catch (error) { this.recordUnknown(task.taskId, 'creating', error); throw error; }
  }
  recordUnknown(taskId, phase, error) {
    this.transaction(() => { const current = this.task(taskId); current.status = 'unknown'; current.phase = phase; this.put(current); this.event('operation_unknown', current, { code: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'FILESYSTEM_OPERATION_FAILED' }); });
  }
  claimTask(args) {
    strictArgs(args, ['requestId', 'taskId']); loopId(args.taskId); this.requireExecutor(args.taskId);
    return this.transaction(() => {
      const request = this.request('claim_task', args), task = this.task(args.taskId);
      if (task.status === 'unknown') fail('TASK_UNKNOWN', '任务结果未知，禁止自动重新领取。');
      if (request.previous) {
        if (Date.now() >= Date.parse(task.claim.leaseExpiresAt)) fail('LEASE_EXPIRED', '原租约已过期，保留占位，禁止自动重派。');
        this.instruction(task); return { ...request.previous, historicalResponse: true, deduplicated: true };
      }
      if (task.status !== 'queued') fail('TASK_ALREADY_CLAIMED', '任务已有领取占位或结果，不可再次领取。');
      const body = this.instruction(task), claimToken = randomBytes(32).toString('base64url');
      task.claim = { actor: this.actor, claimId: randomUUID(), tokenSha256: sha256(claimToken), claimedAt: now(), leaseExpiresAt: new Date(Date.now() + this.leaseMs).toISOString() };
      task.status = 'in_progress'; task.phase = 'claimed'; this.put(task);
      const response = { task: this.summary(task), body, inputSha256: task.input.sha256, claim: { claimId: task.claim.claimId, claimToken, leaseExpiresAt: task.claim.leaseExpiresAt } };
      this.saveRequest('claim_task', args, request.payloadHash, response); this.event('task_claimed', task, { claimId: task.claim.claimId, leaseExpiresAt: task.claim.leaseExpiresAt }); return response;
    });
  }
  verifyClaim(task, args) {
    if (typeof args.claimId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(args.claimId) || typeof args.claimToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(args.claimToken)) fail('CLAIM_FORBIDDEN', '需要原领取编号与有界领取凭据。');
    if (!task.claim || task.claim.actor !== this.actor || task.claim.claimId !== args.claimId || !timingSafeEqual(Buffer.from(task.claim.tokenSha256, 'hex'), Buffer.from(sha256(args.claimToken), 'hex'))) fail('CLAIM_FORBIDDEN', '领取凭据与当前角色及任务绑定不一致。');
  }
  submitTaskResult(args) {
    strictArgs(args, ['requestId', 'taskId', 'claimId', 'claimToken', 'text']); loopId(args.taskId); this.requireExecutor(args.taskId);
    const bytes = textBytes(args.text), contentHash = sha256(bytes);
    const reserved = this.transaction(() => {
      const request = this.request('submit_task_result', args), task = this.task(args.taskId); this.verifyClaim(task, args);
      if (task.status === 'unknown') fail('TASK_UNKNOWN', '提交结果未知，保留原文件和占位，不自动重写。');
      if (task.status === 'submitted') {
        if (task.result.sha256 !== contentHash || task.result.byteLength !== bytes.length) fail('RESULT_CONFLICT', '已提交正文不同，不允许覆盖结果。');
        const result = this.readResult(task);
        const response = { task: this.summary(task), result: { ...result, text: undefined }, deduplicated: true, historicalResponse: true };
        if (!request.previous) this.saveRequest('submit_task_result', args, request.payloadHash, response);
        return { response };
      }
      if (task.status !== 'in_progress' || Date.now() >= Date.parse(task.claim.leaseExpiresAt)) fail('LEASE_EXPIRED', '原租约不在有效执行期，禁止重派或写结果。');
      this.instruction(task);
      task.status = 'unknown'; task.phase = 'submitting'; task.result = { sha256: contentHash, byteLength: bytes.length }; this.put(task);
      this.saveRequest('submit_task_result', args, request.payloadHash, { task: this.summary(task) }); this.event('submit_reserved', task, { resultSha256: contentHash });
      return { task, payloadHash: request.payloadHash };
    });
    if (reserved.response) return reserved.response;
    const task = reserved.task;
    try {
      const directories = this.verifyWorkspace(task);
      task.result = exclusiveWrite(path.join(directories.outputs, 'result.txt'), bytes);
      return this.transaction(() => {
        const current = this.task(task.taskId); this.verifyClaim(current, args);
        if (current.status !== 'unknown' || current.phase !== 'submitting' || current.result.sha256 !== contentHash || Date.now() >= Date.parse(current.claim.leaseExpiresAt)) fail('SUBMISSION_STATE_CONFLICT', '提交占位或租约发生变化，保留文件核查。');
        const readback = this.readResult(task);
        task.status = 'submitted'; task.phase = 'awaiting_manager_readback'; task.completedAt = now(); this.put(task);
        const response = { task: this.summary(task), result: { ...readback, text: undefined } };
        this.saveRequest('submit_task_result', args, reserved.payloadHash, response); this.event('result_submitted', task, { resultSha256: contentHash }); return response;
      });
    } catch (error) { this.recordUnknown(task.taskId, 'submitting', error); throw error; }
  }
  getTaskResult(args) {
    this.requireManager(); strictArgs(args, ['taskId']); loopId(args.taskId);
    return this.transaction(() => {
      const task = this.task(args.taskId);
      if (task.status === 'submitted') this.instruction(task);
      const response = { task: this.summary(task), result: task.status === 'submitted' ? this.readResult(task) : null };
      if (response.result) this.event('manager_result_readback', task, { resultSha256: response.result.sha256, readbackVerified: true });
      return response;
    });
  }
}
