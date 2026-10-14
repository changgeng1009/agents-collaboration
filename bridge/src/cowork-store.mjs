import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, SOURCE_ROOT, RUNTIME_ROOT, guardedPath, fail, sha256 } from './policy.mjs';
import { SessionController, SESSION_RUNTIME_ROOT } from './session-store.mjs';

export const COWORK_RUNTIME_ROOT = path.join(RUNTIME_ROOT, 'cowork-file-bridge');
export const COWORK_TEXT_LIMIT = 256 * 1024;
const now = () => new Date().toISOString();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const flags = () => ({ conversationId: null, automaticConversationControl: false, automaticWakeup: false,
  runtimeVerified: false, platformCwdVerified: false, fileAccessBoundaryVerified: false, osIsolationVerified: false,
  executionSourceVerified: false, completePlatformLoopVerified: false });

function safePath(root, candidate, mustExist = true) {
  const resolved = guardedPath(root, candidate, { mustExist });
  let cursor = PROJECT_ROOT;
  for (const part of path.relative(PROJECT_ROOT, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('COWORK_LINK_FORBIDDEN', '任务文件和快照不能使用链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}
function textBytes(text) {
  if (typeof text !== 'string' || !text.isWellFormed()) fail('TEXT_INVALID', '正文必须为有效 Unicode。');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > COWORK_TEXT_LIMIT) fail('TEXT_LIMIT', '单个 UTF-8 文本超出 256 KiB。');
  return bytes;
}
function ordinaryFile(root, file) {
  const checked = safePath(root, file), stat = fs.statSync(checked, { bigint: true });
  if (!stat.isFile()) fail('REGULAR_FILE_REQUIRED', '只能读取普通文件。');
  if (stat.nlink !== 1n) fail('COWORK_LINK_FORBIDDEN', '任务文件不能使用硬链接。');
  if (stat.size > BigInt(COWORK_TEXT_LIMIT)) fail('TEXT_LIMIT', 'UTF-8 文件超出 256 KiB。');
  return { checked, identity: [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':') };
}
function readText(root, file) {
  const before = ordinaryFile(root, file), fd = fs.openSync(before.checked, 'r');
  let bytes;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    const identity = [opened.dev, opened.ino, opened.size, opened.mtimeNs, opened.ctimeNs].map(String).join(':');
    if (!opened.isFile() || opened.nlink !== 1n || identity !== before.identity) fail('FILE_CHANGED_DURING_READ', '打开文件时对象身份已经改变。');
    const bounded = Buffer.alloc(COWORK_TEXT_LIMIT + 1); let count = 0, received;
    while (count < bounded.length && (received = fs.readSync(fd, bounded, count, bounded.length - count, null)) > 0) count += received;
    if (count > COWORK_TEXT_LIMIT) fail('TEXT_LIMIT', '读取期间文件超过允许大小，停止，不返回截取正文。');
    bytes = bounded.subarray(0, count);
  } finally { fs.closeSync(fd); }
  const after = ordinaryFile(root, file);
  if (before.identity !== after.identity) fail('FILE_CHANGED_DURING_READ', '文件在读取过程中发生变化，请核查，不自动重读。');
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('INVALID_UTF8', '文件不是有效 UTF-8，保留原文件，不转换或覆盖。'); }
  return { file: before.checked, bytes, text, sha256: sha256(bytes), byteLength: bytes.length, utf8Bom: bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) };
}

export class CoworkFileStore {
  constructor({ role = 'claude', testHooks = {} } = {}) {
    if (role !== 'claude') fail('ROLE_DISABLED', 'Cowork 文件桥规划与审核身份固定为 claude。');
    if (Object.keys(testHooks).length && (process.env.COLLAB_TEST_MODE !== '1' || PROJECT_ROOT === SOURCE_ROOT)) fail('TEST_HOOK_FORBIDDEN', '故障注入只限隔离协议测试。');
    this.testHooks = testHooks;
    fs.mkdirSync(safePath(PROJECT_ROOT, COWORK_RUNTIME_ROOT, false), { recursive: true });
    this.dbPath = path.join(COWORK_RUNTIME_ROOT, 'cowork.sqlite');
    for (const suffix of ['', '-wal', '-shm']) safePath(COWORK_RUNTIME_ROOT, this.dbPath + suffix, false);
    this.db = new DatabaseSync(this.dbPath); this.db.exec('PRAGMA busy_timeout=0;');
    const schema = `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS cowork_tasks(task_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cowork_requests(request_id TEXT PRIMARY KEY, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cowork_versions(task_id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(task_id,version));
      CREATE TABLE IF NOT EXISTS cowork_reviews(review_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cowork_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, operation TEXT NOT NULL, value TEXT NOT NULL);
      PRAGMA user_version=1;`;
    const deadline = Date.now() + 5000;
    for (;;) { try { this.db.exec(schema); break; } catch (error) { if (![5, 6].includes(error.errcode) || Date.now() >= deadline) { this.db.close(); throw error; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } }
    this.db.exec('PRAGMA busy_timeout=5000;');
    try { this.workspaces = new SessionController({ actor: 'claude', dbPath: path.join(SESSION_RUNTIME_ROOT, 'cowork-workspaces.sqlite') }); }
    catch (error) { this.db.close(); throw error; }
  }
  close() { this.workspaces.close(); this.db.close(); }
  transaction(action) {
    safePath(COWORK_RUNTIME_ROOT, this.dbPath); this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  task(taskId) { const row = this.db.prepare('SELECT value FROM cowork_tasks WHERE task_id=?').get(taskId); if (!row) fail('NOT_FOUND', '文件桥没有登记该任务。'); return JSON.parse(row.value); }
  saveTask(task) { this.db.prepare('INSERT INTO cowork_tasks VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value').run(task.taskId, JSON.stringify(task)); }
  event(operation, value) { this.db.prepare('INSERT INTO cowork_events(at,operation,value) VALUES(?,?,?)').run(now(), operation, JSON.stringify(value)); }
  request(operation, args) {
    if (typeof args.requestId !== 'string' || !args.requestId.length || args.requestId.length > 128) fail('REQUEST_ID_INVALID', '请求编号必须非空且不超过 128 字符。');
    const hash = sha256(JSON.stringify(canonical(args))), row = this.db.prepare('SELECT * FROM cowork_requests WHERE request_id=?').get(args.requestId);
    if (row && (row.operation !== operation || row.payload_hash !== hash)) fail('REQUEST_ID_CONFLICT', '请求编号已用于不同操作或内容。');
    return { hash, previous: row ? JSON.parse(row.value) : null };
  }
  insertRequest(operation, args, hash, value) { this.db.prepare('INSERT INTO cowork_requests VALUES(?,?,?,?)').run(args.requestId, operation, hash, JSON.stringify(value)); }
  updateRequest(requestId, value) { this.db.prepare('UPDATE cowork_requests SET value=? WHERE request_id=?').run(JSON.stringify(value), requestId); }
  replay(value) { return { ...value, deduplicated: true, historicalResponse: true, fileSideEffectsRepeated: false }; }
  capabilities() { return { bridge: 'cowork-file-handoff', version: '0.1.5', role: 'claude', documentedFileHandoff: true,
    executionMode: 'unknown', planningSource: 'mcp_tool_observation', resultSource: 'fixed_file_observation',
    chatMcpAutomaticallySharedWithCowork: false, controllerPathBoundaryVerified: true, ...flags() }; }
  verifyTask(task, { complete = true } = {}) {
    if (!task.workspace) fail('TASK_INCOMPLETE', '任务创建尚未取得目录绑定，保留占位，不自动重做。');
    this.workspaces.verifyWorkspace(task.workspace);
    if (complete && !task.inputComplete) fail('TASK_INCOMPLETE', '任务输入未完整写入，不作为已派发任务或结果验收。');
    const files = [];
    for (const expected of task.inputFiles ?? []) {
      const actual = readText(task.workspace.inputs, expected.file);
      if (actual.sha256 !== expected.sha256) fail('INPUT_TAMPERED', '任务输入与原始派单哈希不一致。');
      files.push({ file: actual.file, text: actual.text, sha256: actual.sha256 });
    }
    this.workspaces.verifyWorkspace(task.workspace); return files;
  }
  submitTask(args) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(args.taskId) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(args.taskId)) fail('TASK_ID_INVALID', '任务编号不是安全本地标识符。');
    const names = new Set();
    for (const input of args.textInputs ?? []) { if (!/^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u.test(input.name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(input.name) || names.has(input.name.toLowerCase())) fail('INPUT_NAME_INVALID', '文本输入名称不能含路径、保留设备名或重复名称。'); names.add(input.name.toLowerCase()); textBytes(input.text); }
    const reserved = this.transaction(() => {
      const request = this.request('submit_cowork_task', args);
      if (request.previous) {
        const existing = this.task(args.taskId);
        if (existing.inputComplete) this.verifyTask(existing);
        else if (existing.workspace) this.workspaces.verifyWorkspace(existing.workspace);
        return { replay: this.replay(request.previous) };
      }
      if (this.db.prepare('SELECT 1 FROM cowork_tasks WHERE task_id=?').get(args.taskId)) fail('TASK_ALREADY_CLAIMED', '该任务已有持久占位；失败或未知也不能换请求编号重新派发。');
      const task = { taskId: args.taskId, owner: 'claude', plannedExecutor: 'cowork', title: args.title, status: 'creating', createdAt: now(), ownerPid: process.pid,
        workspace: null, inputFiles: [], inputComplete: false, latestVersion: null, ...flags() };
      this.saveTask(task); const response = { task, status: 'creating', ...flags() };
      this.insertRequest('submit_cowork_task', args, request.hash, response); this.event('submission_reserved', { taskId: args.taskId, requestId: args.requestId }); return { task };
    });
    if (reserved.replay) return reserved.replay;
    this.testHooks.afterClaim?.(reserved.task);
    const task = reserved.task;
    try {
      task.workspace = this.workspaces.prepareTaskWorkspace({ requestId: 'cowork_workspace_' + sha256(args.requestId), taskId: args.taskId }).workspace;
      this.transaction(() => this.saveTask(task));
      this.testHooks.afterWorkspace?.(task);
      const inputRefs = (args.textInputs ?? []).map(input => ({ name: input.name, file: path.join(task.workspace.inputs, 'texts', input.name + '.txt'), sha256: sha256(textBytes(input.text)) }));
      const definition = { formatVersion: 1, taskId: args.taskId, title: args.title, instructions: args.instructions, acceptance: args.acceptance,
        intendedExecutor: 'cowork', inputRefs, hostTaskRoot: task.workspace.taskRoot,
        outputFile: path.join(task.workspace.outputs, 'result.md'), environmentStatus: 'unknown', ...flags() };
      const markdown = `# ${args.title}\n\n本地任务编号：${args.taskId}\n\n## 任务要求\n\n${args.instructions}\n\n## 验收要求\n\n${args.acceptance.map(item => '- ' + item).join('\n')}\n\n## 文件与来源说明\n\n只读取本任务 inputs；工作文件放 work；最终结果写 outputs/result.md。报告实际读取的输入文件及SHA256、实际执行模式、授权任务目录、运行时目录与输出路径；不能确定时写 unknown，不预填挂载路径。文件存在不证明平台来源；本桥不会创建、唤醒或续接平台会话。\n`;
      const files = [{ file: path.join(task.workspace.inputs, 'task.json'), bytes: textBytes(JSON.stringify(definition, null, 2)) },
        { file: path.join(task.workspace.inputs, 'task.md'), bytes: textBytes(markdown) }, ...(args.textInputs ?? []).map((input, index) => ({ file: inputRefs[index].file, bytes: textBytes(input.text) }))];
      if (files.reduce((sum, file) => sum + file.bytes.length, 0) > 512 * 1024) fail('TEXT_LIMIT', '任务输入总量超过 512 KiB。');
      task.inputFiles = files.map(file => ({ file: file.file, sha256: sha256(file.bytes), byteLength: file.bytes.length }));
      this.transaction(() => this.saveTask(task));
      for (const file of files) { this.workspaces.verifyWorkspace(task.workspace); const target = safePath(task.workspace.inputs, file.file, false); fs.mkdirSync(path.dirname(target), { recursive: true }); safePath(task.workspace.inputs, path.dirname(target)); fs.writeFileSync(target, file.bytes, { flag: 'wx' }); }
      task.inputComplete = true; this.verifyTask(task); task.status = 'awaiting_output'; task.dispatchedAt = now();
    } catch (error) { task.inputComplete = false; task.status = 'submission_incomplete'; task.failure = { code: error.code ?? 'FILE_WRITE_FAILED', message: '输入写入未完成；保留占位和已有文件，不自动覆盖或重做。' }; }
    return this.transaction(() => { this.saveTask(task); const response = { task, status: task.status, ...flags() }; this.updateRequest(args.requestId, response); this.event('submission_finished', { taskId: task.taskId, status: task.status, failure: task.failure ?? null }); return response; });
  }
  output(task, required = false) {
    this.verifyTask(task);
    const file = safePath(task.workspace.outputs, path.join(task.workspace.outputs, 'result.md'), false);
    if (!fs.existsSync(file)) { if (required) fail('OUTPUT_MISSING', '固定结果文件尚不存在，不能审核。'); return null; }
    const result = readText(task.workspace.outputs, file); this.verifyTask(task); return result;
  }
  versions(taskId) { return this.db.prepare('SELECT value FROM cowork_versions WHERE task_id=? ORDER BY version').all(taskId).map(row => JSON.parse(row.value)); }
  reviews(taskId) { return this.db.prepare('SELECT value FROM cowork_reviews WHERE task_id=? ORDER BY rowid').all(taskId).map(row => JSON.parse(row.value)); }
  getTask({ taskId }) {
    const task = this.task(taskId);
    if (!task.inputComplete) {
      if (task.workspace) this.workspaces.verifyWorkspace(task.workspace);
      if (task.status === 'creating') {
        let exited = false; try { process.kill(task.ownerPid, 0); } catch (error) { exited = error.code === 'ESRCH'; }
        if (exited) this.transaction(() => { task.status = 'submission_unknown'; task.failure = { code: 'OWNER_EXITED', message: '创建方进程退出；保留占位，不自动重做。' }; this.saveTask(task); this.event('submission_owner_exited', { taskId }); });
      }
      return { task, status: task.status, ...flags() };
    }
    const inputFiles = this.verifyTask(task), output = this.output(task), versions = this.versions(taskId), latest = versions.at(-1);
    if (latest && readText(COWORK_RUNTIME_ROOT, latest.snapshot).sha256 !== latest.sha256) fail('SNAPSHOT_TAMPERED', '最新结果快照已改变，不能报告当前审核通过。');
    const reviews = this.reviews(taskId).map(review => ({ ...review, currentlyValid: review.valid && output?.sha256 === review.sha256 && latest?.version === review.version }));
    const currentReview = reviews.filter(review => review.currentlyValid).at(-1);
    return { task, inputFiles, versions, reviews, liveOutputSha256: output?.sha256 ?? null,
      status: !output ? 'awaiting_output' : latest?.sha256 !== output.sha256 ? 'output_changed_pending_read' : currentReview ? currentReview.verdict === 'passed' ? 'file_review_passed' : 'file_rework' : 'awaiting_review', ...flags() };
  }
  readResult(args) {
    const task = this.task(args.taskId); this.verifyTask(task);
    return this.transaction(() => {
      const request = this.request('read_cowork_result', args);
      if (request.previous) {
        const previous = request.previous;
        if (previous.snapshot && readText(COWORK_RUNTIME_ROOT, previous.snapshot).sha256 !== previous.sha256) fail('SNAPSHOT_TAMPERED', '历史读回快照已改变，不能重放原正文。');
        const current = this.output(task);
        return this.replay({ ...previous, currentOutputSha256: current?.sha256 ?? null, historicalVersionStillCurrent: previous.sha256 !== null && previous.sha256 === current?.sha256 });
      }
      const output = this.output(task);
      if (!output) { const response = { taskId: args.taskId, status: 'awaiting_output', version: null, sha256: null, text: null, ...flags() }; this.insertRequest('read_cowork_result', args, request.hash, response); return response; }
      const last = this.versions(args.taskId).at(-1); let observed = last;
      if (!last || last.sha256 !== output.sha256) {
        const version = (last?.version ?? 0) + 1, snapshot = safePath(COWORK_RUNTIME_ROOT, path.join(COWORK_RUNTIME_ROOT, 'snapshots', args.taskId, `v${version}.md`), false);
        fs.mkdirSync(path.dirname(snapshot), { recursive: true }); safePath(COWORK_RUNTIME_ROOT, path.dirname(snapshot));
        if (fs.existsSync(snapshot)) fail('SNAPSHOT_EXISTS', '快照已存在，保留核查，不覆盖。');
        fs.writeFileSync(snapshot, output.bytes, { flag: 'wx' });
        observed = { taskId: args.taskId, version, sha256: output.sha256, byteLength: output.byteLength, utf8Bom: output.utf8Bom,
          snapshot, sourceFile: output.file, readAt: now(), reader: 'claude', readRequestId: args.requestId, evidenceLevel: 'file_observation' };
        const after = this.output(task, true); if (after.sha256 !== output.sha256) fail('FILE_CHANGED_DURING_READ', '结果在快照建立期间改变，保留快照，不自动再读。');
        this.db.prepare('INSERT INTO cowork_versions VALUES(?,?,?)').run(args.taskId, version, JSON.stringify(observed));
        for (const review of this.reviews(args.taskId)) { review.valid = false; review.invalidatedAt = now(); this.db.prepare('UPDATE cowork_reviews SET value=? WHERE review_id=?').run(JSON.stringify(review), review.reviewId); }
        task.latestVersion = version; task.status = 'awaiting_review'; this.saveTask(task);
      }
      const snapshot = readText(COWORK_RUNTIME_ROOT, observed.snapshot); if (snapshot.sha256 !== observed.sha256) fail('SNAPSHOT_TAMPERED', '已登记的不可覆盖快照已改变。');
      const response = { taskId: args.taskId, status: 'observed_output', version: observed.version, sha256: observed.sha256, byteLength: observed.byteLength, utf8Bom: observed.utf8Bom,
        text: snapshot.text, snapshot: observed.snapshot, evidenceLevel: 'file_observation', reportedEnvironment: 'reported_only_if_present_in_result_text', ...flags() };
      this.insertRequest('read_cowork_result', args, request.hash, response); this.event('output_observed', { taskId: args.taskId, version: observed.version, sha256: observed.sha256 }); return response;
    });
  }
  submitReview(args) {
    const task = this.task(args.taskId); this.verifyTask(task);
    return this.transaction(() => {
      const request = this.request('submit_cowork_review', args);
      const latest = this.versions(args.taskId).at(-1);
      if (!latest || latest.version !== args.version || latest.sha256 !== args.sha256) fail('STALE_RESULT_VERSION', '只能审核明确读回的最新版本及原哈希。');
      const output = this.output(task, true), snapshot = readText(COWORK_RUNTIME_ROOT, latest.snapshot);
      if (snapshot.sha256 !== latest.sha256) fail('SNAPSHOT_TAMPERED', '结果快照已改变，不能审核。');
      if (output.sha256 !== args.sha256) fail('OUTPUT_CHANGED', '固定输出已改变，原读回版本不能审核。');
      if (request.previous) {
        const current = this.reviews(args.taskId).find(review => review.reviewId === request.previous.review.reviewId);
        return this.replay({ ...request.previous, review: { ...request.previous.review, valid: current?.valid === true } });
      }
      const review = { reviewId: randomUUID(), taskId: args.taskId, version: args.version, sha256: args.sha256, verdict: args.verdict, basis: args.basis,
        reviewer: 'claude', reviewedAt: now(), valid: true, scope: 'observed_file_content_only', ...flags() };
      for (const previous of this.reviews(args.taskId).filter(item => item.valid)) { previous.valid = false; previous.invalidatedAt = now(); previous.invalidatedReason = 'superseded_review'; this.db.prepare('UPDATE cowork_reviews SET value=? WHERE review_id=?').run(JSON.stringify(previous), previous.reviewId); }
      this.db.prepare('INSERT INTO cowork_reviews VALUES(?,?,?)').run(review.reviewId, args.taskId, JSON.stringify(review));
      task.status = args.verdict === 'passed' ? 'file_review_passed' : 'file_rework'; this.saveTask(task);
      const response = { review, ...flags() }; this.insertRequest('submit_cowork_review', args, request.hash, response); this.event('file_reviewed', { taskId: args.taskId, version: args.version, verdict: args.verdict }); return response;
    });
  }
}
