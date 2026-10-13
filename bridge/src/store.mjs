import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, PROJECT_ID, ARTIFACT_ROOT, RUNTIME_ROOT, guardedPath, fail, sha256 } from './policy.mjs';

const now = () => new Date().toISOString();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export class Hub {
  constructor({ role, dbPath = path.join(RUNTIME_ROOT, 'hub.sqlite') }) {
    if (!['claude', 'codex'].includes(role)) fail('ROLE_DISABLED', '只允许 Claude 规划角色与 Codex 执行角色；豆包连接尚未启用。');
    this.role = role;
    for (const dir of [RUNTIME_ROOT, ARTIFACT_ROOT]) fs.mkdirSync(guardedPath(PROJECT_ROOT, dir, { mustExist: false }), { recursive: true });
    this.dbPath = guardedPath(RUNTIME_ROOT, dbPath, { mustExist: false });
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout=5000;');
    const schema = `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS requests (actor TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,operation,request_id));
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, value TEXT NOT NULL);
      PRAGMA user_version=1;`;
    // SQLite journal_mode 在首次并发初始化时可能立即返回 BUSY，即使设置了 busy_timeout。
    // 这里只重试幂等的本地初始化，最长 5 秒；绝不重发平台任务或模型请求。
    const deadline = Date.now() + 5000;
    for (;;) {
      try { this.db.exec(schema); break; }
      catch (error) {
        if (![5, 6].includes(error.errcode) || Date.now() >= deadline) { this.db.close(); throw error; }
        console.error('本地 SQLite 初始化正在等待并发锁。');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
  }
  close() { this.db.close(); }
  requireRole(role) { if (this.role !== role) fail('ROLE_FORBIDDEN', '当前角色没有此操作权限。'); }
  get(kind, id) {
    const row = this.db.prepare('SELECT value FROM records WHERE kind=? AND id=?').get(kind, id);
    if (!row) fail('NOT_FOUND', '指定记录不存在。');
    return JSON.parse(row.value);
  }
  all(kind) { return this.db.prepare('SELECT value FROM records WHERE kind=? ORDER BY rowid').all(kind).map(row => JSON.parse(row.value)); }
  put(kind, id, value) { this.db.prepare('INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind, id, JSON.stringify(value)); }
  event(operation, value) { this.db.prepare('INSERT INTO events(at,actor,operation,value) VALUES (?,?,?,?)').run(now(), this.role, operation, JSON.stringify(value)); }
  transaction(operation, args, action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const payloadHash = sha256(JSON.stringify(canonical(args)));
      const cached = this.db.prepare('SELECT * FROM requests WHERE actor=? AND operation=? AND request_id=?').get(this.role, operation, args.requestId);
      if (cached) {
        if (cached.payload_hash !== payloadHash) fail('REQUEST_ID_CONFLICT', '请求编号已用于不同内容，拒绝重复提交。');
        this.db.exec('COMMIT');
        return { ...JSON.parse(cached.response), deduplicated: true };
      }
      const result = action();
      this.event(operation, { requestId: args.requestId, result });
      this.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?)').run(this.role, operation, args.requestId, payloadHash, JSON.stringify(result));
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  task(id) { return this.get('task', id); }
  effectiveTask(task) {
    const staleInputs = task.inputs.filter(ref => this.latestVersion(ref.artifactId) !== ref.version);
    return { ...task, storedStatus: task.status, status: staleInputs.length ? 'needs_recheck' : task.status,
      inputsCurrent: staleInputs.length === 0, staleInputs, approvalValid: task.status === 'approved' && staleInputs.length === 0 };
  }
  artifact(id, version) { return this.get('artifact', `${id}@${version}`); }
  latestVersion(id) { return Math.max(0, ...this.all('artifact').filter(a => a.artifactId === id).map(a => a.version)); }
  latestRefs(taskId) { return this.all('artifact').filter(a => a.taskId === taskId && a.version === this.latestVersion(a.artifactId)).map(a => ({ artifactId: a.artifactId, version: a.version })); }
  checkCurrent(ref) {
    const artifact = this.artifact(ref.artifactId, ref.version);
    if (this.latestVersion(ref.artifactId) !== ref.version) fail('STALE_VERSION', '该产物已有新版本，不能沿用旧版本审核或执行。');
    return artifact;
  }
  message({ taskId, recipient, body, kind = 'message', replyTo = null }) {
    const record = { projectId: PROJECT_ID, messageId: randomUUID(), taskId, sender: this.role, recipient, body, kind, replyTo,
      queuedAt: now(), deliveredAt: null, readAt: null, executedAt: null, executionRef: null, status: 'queued' };
    this.put('message', record.messageId, record);
    return record;
  }
  capabilities() {
    return { projectId: PROJECT_ID, role: this.role, dbPath: this.dbPath, artifactRoot: ARTIFACT_ROOT,
      transport: 'stdio', persistence: 'sqlite-wal', modelExecutionEnabled: false, modelExecutionScope: 'original_codex_adapter', sessionControlCapabilityTool: 'get_session_capabilities', doubaoEnabled: false,
      automaticWakeup: false, clientConnectionVerified: false,
      statusLabels: { queued: '已入队', delivered: '已送达本地接收进程', read: '接收方已确认读取', executed: '接收方已登记执行', assigned: '已派发', in_progress: '执行中', awaiting_review: '待审核', approved: '已通过当前版本审核' } };
  }
  submitTask(args) {
    this.requireRole('claude');
    return this.transaction('submit_task', args, () => {
      for (const ref of args.inputs) this.checkCurrent(ref);
      const task = { projectId: PROJECT_ID, taskId: randomUUID(), sender: this.role, owner: 'codex', title: args.title, goal: args.goal,
        acceptance: args.acceptance, inputs: args.inputs, version: 1, createdAt: now(), updatedAt: now(), status: 'assigned', result: null };
      const message = this.message({ taskId: task.taskId, recipient: 'codex', kind: 'task', body: JSON.stringify({ title: task.title, goal: task.goal, acceptance: task.acceptance, inputs: task.inputs }) });
      task.assignmentMessageId = message.messageId;
      this.put('task', task.taskId, task);
      return { task, message };
    });
  }
  getTask({ taskId }) {
    const task = this.effectiveTask(this.task(taskId));
    return { task, artifacts: this.all('artifact').filter(a => a.taskId === taskId), reviews: this.all('review').filter(r => r.taskId === taskId).map(r => ({ ...r, current: r.version === this.latestVersion(r.artifactId) && task.inputsCurrent })) };
  }
  listTasks() { return { tasks: this.all('task').map(task => this.effectiveTask(task)) }; }
  sendMessage(args) {
    if (args.recipient === this.role) fail('RECIPIENT_FORBIDDEN', '消息必须发送给另一角色。');
    return this.transaction('send_message', args, () => {
      this.task(args.taskId);
      let original;
      if (args.replyTo) {
        original = this.get('message', args.replyTo);
        if (original.taskId !== args.taskId || original.recipient !== this.role || original.sender !== args.recipient) fail('REPLY_FORBIDDEN', '回复不属于当前角色或任务。');
        if (!original.readAt) fail('READ_ACK_REQUIRED', '回复前先确认已读取原消息。');
      }
      const message = this.message(args);
      if (original && original.kind !== 'task') {
        original.executedAt = now(); original.status = 'executed'; original.executionRef = message.messageId;
        this.put('message', original.messageId, original);
      }
      return { message };
    });
  }
  readMessages(args) {
    return this.transaction('read_messages', args, () => {
      const messages = this.all('message').filter(m => m.recipient === this.role && (!args.taskId || m.taskId === args.taskId) && (!args.unreadOnly || !m.readAt));
      for (const message of messages) if (!message.deliveredAt) {
        message.deliveredAt = now(); message.status = 'delivered';
        this.put('message', message.messageId, message);
      }
      return { recipient: this.role, messages, note: '这里仅登记送达本地进程；需另调用 ack_message 确认读取。' };
    });
  }
  ackMessage(args) {
    return this.transaction('ack_message', args, () => {
      const message = this.get('message', args.messageId);
      if (message.recipient !== this.role) fail('RECIPIENT_FORBIDDEN', '不能确认其他角色的收件记录。');
      if (!message.deliveredAt) fail('DELIVERY_REQUIRED', '先读取收件箱，不能把未送达消息直接标记为已读。');
      if (!message.readAt) { message.readAt = now(); message.status = 'read'; this.put('message', message.messageId, message); }
      return { message };
    });
  }
  startTask(args) {
    this.requireRole('codex');
    return this.transaction('start_task', args, () => {
      const task = this.task(args.taskId);
      if (task.status !== 'assigned' && task.status !== 'in_progress') fail('TASK_STATE', '该任务当前不能开始执行。');
      for (const ref of task.inputs) this.checkCurrent(ref);
      if (!this.get('message', task.assignmentMessageId).readAt) fail('READ_ACK_REQUIRED', '开始前须确认已读取派单。');
      task.status = 'in_progress'; task.updatedAt = now();
      this.put('task', task.taskId, task);
      return { task };
    });
  }
  registerArtifact(args) {
    this.requireRole('codex');
    return this.transaction('register_artifact', args, () => {
      const task = this.task(args.taskId);
      if (!['in_progress', 'awaiting_review', 'approved'].includes(task.status)) fail('TASK_STATE', '须先开始任务才能登记产物。');
      const latest = this.latestVersion(args.artifactId);
      if (latest && this.artifact(args.artifactId, latest).taskId !== args.taskId) fail('ARTIFACT_TASK_CONFLICT', '产物编号已属于其他任务。');
      if (args.version !== latest + 1) fail('VERSION_SEQUENCE', '版本必须从 1 起逐次递增，旧版不可覆盖。');
      const source = guardedPath(ARTIFACT_ROOT, args.filePath);
      if (!fs.statSync(source).isFile()) fail('FILE_REQUIRED', '产物必须是普通文件。');
      if (fs.statSync(source).size > 4 * 1024 * 1024) fail('FILE_TOO_LARGE', 'T1 产物上限为 4 MiB。');
      const bytes = fs.readFileSync(source);
      if (args.mimeType.startsWith('text/') || args.mimeType === 'application/json') {
        if (bytes.length > 256 * 1024) fail('TEXT_TOO_LARGE', '文本产物上限为 256 KiB。');
        new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } else if (args.mimeType === 'image/png') {
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) fail('MIME_MISMATCH', '文件不是 PNG 图片。');
      } else if (args.mimeType === 'image/jpeg') {
        if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('MIME_MISMATCH', '文件不是 JPEG 图片。');
      } else fail('MIME_UNSUPPORTED', 'T1 只返回 UTF-8 文本、JSON、PNG 或 JPEG。');
      const extension = { 'image/png': '.png', 'image/jpeg': '.jpg', 'application/json': '.json', 'text/markdown': '.md', 'text/plain': '.txt' }[args.mimeType];
      const snapshot = guardedPath(ARTIFACT_ROOT, path.join(ARTIFACT_ROOT, 'versions', args.taskId, args.artifactId, `v${args.version}${extension}`), { mustExist: false });
      fs.mkdirSync(path.dirname(snapshot), { recursive: true });
      guardedPath(ARTIFACT_ROOT, path.dirname(snapshot));
      if (fs.existsSync(snapshot)) {
        if (sha256(fs.readFileSync(snapshot)) !== sha256(bytes)) fail('SNAPSHOT_CONFLICT', '快照路径已存在且内容不同，拒绝覆盖。');
      } else fs.writeFileSync(snapshot, bytes, { flag: 'wx' });
      const artifact = { projectId: PROJECT_ID, taskId: args.taskId, artifactId: args.artifactId, version: args.version,
        sender: this.role, createdAt: now(), sourcePath: source, filePath: snapshot, sha256: sha256(bytes), byteLength: bytes.length, mimeType: args.mimeType, origin: args.origin };
      this.put('artifact', `${args.artifactId}@${args.version}`, artifact);
      if (latest && task.status !== 'in_progress') {
        task.version += 1; task.status = 'in_progress'; task.result = null;
        this.put('task', task.taskId, task);
      }
      return { artifact, latestVersion: args.version };
    });
  }
  getArtifact(args) {
    const artifact = this.artifact(args.artifactId, args.version);
    const bytes = fs.readFileSync(guardedPath(ARTIFACT_ROOT, artifact.filePath));
    if (sha256(bytes) !== artifact.sha256) fail('ARTIFACT_TAMPERED', '产物内容与登记校验值不同，停止读取。');
    const content = [{ type: 'text', text: JSON.stringify({ artifact, current: args.version === this.latestVersion(args.artifactId) }) }];
    if (artifact.mimeType.startsWith('image/')) content.push({ type: 'image', mimeType: artifact.mimeType, data: bytes.toString('base64') });
    else content.push({ type: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
    return { content };
  }
  completeTask(args) {
    this.requireRole('codex');
    return this.transaction('complete_task', args, () => {
      const task = this.task(args.taskId);
      if (task.status !== 'in_progress') fail('TASK_STATE', '任务须处于执行中才能提交结果。');
      for (const ref of args.artifacts) {
        const artifact = this.checkCurrent(ref);
        if (artifact.taskId !== args.taskId) fail('ARTIFACT_TASK_CONFLICT', '结果产物属于其他任务。');
        this.getArtifact(ref);
      }
      for (const ref of task.inputs) this.checkCurrent(ref);
      task.status = 'awaiting_review'; task.updatedAt = now();
      task.result = { summary: args.summary, artifacts: args.artifacts, execution: args.execution, completedAt: now() };
      this.put('task', task.taskId, task);
      const assignment = this.get('message', task.assignmentMessageId);
      assignment.status = 'executed'; assignment.executedAt = now(); assignment.executionRef = args.execution.executionId;
      this.put('message', assignment.messageId, assignment);
      const message = this.message({ taskId: task.taskId, recipient: 'claude', kind: 'result', body: JSON.stringify(task.result) });
      return { task, message };
    });
  }
  submitReview(args) {
    this.requireRole('claude');
    return this.transaction('submit_review', args, () => {
      const artifact = this.checkCurrent(args);
      const task = this.task(artifact.taskId);
      for (const input of task.inputs) this.checkCurrent(input);
      if (task.status !== 'awaiting_review') fail('TASK_STATE', '只接受当前待审核结果的审核。');
      if (!task.result.artifacts.some(ref => ref.artifactId === args.artifactId && ref.version === args.version)) fail('REVIEW_SCOPE', '产物不属于本次提交结果。');
      this.getArtifact(args);
      const review = { reviewId: randomUUID(), taskId: task.taskId, artifactId: args.artifactId, version: args.version,
        reviewer: this.role, createdAt: now(), verdict: args.verdict, basis: args.basis, artifactSha256: artifact.sha256 };
      this.put('review', review.reviewId, review);
      let message = null;
      if (args.verdict === 'rework') {
        task.status = 'in_progress'; task.result = null; task.version += 1;
        message = this.message({ taskId: task.taskId, recipient: 'codex', kind: 'rework', body: JSON.stringify({ review, instruction: '只修改指定产物；其他已通过版本保留。' }) });
      }
      else if (task.result.artifacts.every(ref => {
        const latest = this.all('review').filter(r => r.artifactId === ref.artifactId && r.version === ref.version).at(-1);
        return latest?.verdict === 'passed' && this.latestVersion(ref.artifactId) === ref.version;
      })) task.status = 'approved';
      this.put('task', task.taskId, task);
      return { review, task: this.effectiveTask(task), message };
    });
  }
}
