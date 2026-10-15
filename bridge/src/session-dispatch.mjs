import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, SOURCE_ROOT, fail, sha256 } from './policy.mjs';
import { SessionController } from './session-store.mjs';
import { sessionPath } from './session-files.mjs';
import { sanitizeCodeBuddyValue } from './codebuddy-cli-adapter.mjs';

const workerFile = fileURLToPath(new URL('./session-dispatch-worker.mjs', import.meta.url));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const now = () => new Date().toISOString();
const pending = new Set(['worker_starting', 'worker_ready', 'wake_attempting', 'running']);
function strict(args, keys) { if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length !== keys.length || keys.some(key => !Object.hasOwn(args, key))) fail('DISPATCH_ARGUMENTS', '投递参数缺失或含未授权字段。'); }
function requestId(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail('DISPATCH_REQUEST_INVALID', '投递请求编号必须为有界安全标识符。'); }
export class SessionDispatcher {
  constructor({ controller = new SessionController({ actor: 'manager' }), fixtureConfig = null } = {}) {
    this.controller = controller;
    const fixtureRelative = fixtureConfig ? path.relative(PROJECT_ROOT, fixtureConfig.cliScript) : null;
    if (fixtureConfig && (process.env.COLLAB_TEST_MODE !== '1' || PROJECT_ROOT === SOURCE_ROOT || !fixtureRelative || fixtureRelative.startsWith('..') || path.isAbsolute(fixtureRelative))) fail('DISPATCH_FIXTURE_FORBIDDEN', '离线执行器只能显式使用隔离根内 fixture。');
    this.fixtureConfig = fixtureConfig;
    this.controller.db.exec(`CREATE TABLE IF NOT EXISTS session_dispatches(dispatch_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_requests(request_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, dispatch_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dispatch_wake_requests(request_id TEXT PRIMARY KEY, dispatch_id TEXT NOT NULL);`);
  }
  manager() { if (this.controller.actor !== 'manager') fail('ROLE_FORBIDDEN', '只有固定 manager 可以安排或唤醒外部执行。'); }
  row(id) { const row = this.controller.db.prepare('SELECT value FROM session_dispatches WHERE dispatch_id=?').get(id); if (!row) fail('DISPATCH_NOT_FOUND', '本库未登记该投递。'); const job = JSON.parse(row.value); if (job.actor !== this.controller.actor) fail('ROLE_FORBIDDEN', '投递不属于当前固定角色。'); return job; }
  put(job) { this.controller.db.prepare('INSERT INTO session_dispatches VALUES(?,?,?) ON CONFLICT(dispatch_id) DO UPDATE SET value=excluded.value').run(job.dispatchId, job.args.taskId, JSON.stringify(job)); }
  event(job, phase) { this.controller.event('dispatch_state', { dispatchId: job.dispatchId, taskId: job.args.taskId, state: phase }); }
  view(job) { return { dispatchId: job.dispatchId, taskId: job.args.taskId, platform: job.args.platform, mode: job.args.mode, operation: job.operation, state: job.state,
    queuedAt: job.queuedAt, workerStarted: job.workerStarted === true, platformProcessStarted: job.platformProcessStarted === true,
    wakeAttempt: job.platformProcessStarted ? 'process_started' : job.launchIntentRecorded ? 'intent_recorded_outcome_unknown' : 'not_attempted',
    executionSucceeded: job.state === 'succeeded', conversationId: job.outcome?.conversationId ?? job.args.conversationId ?? null,
    blocker: job.blocker ?? null, evidenceLevel: job.evidenceLevel, realPlatformExecutionVerified: job.evidenceLevel === 'real_runtime' && job.state === 'succeeded',
    automaticRetry: false, automaticReassignment: false, fileWorkerOsIsolationVerified: false, platformOsIsolationVerified: false, outcome: job.outcome ?? null }; }
  enqueue(args) {
    this.manager(); strict(args, ['requestId', 'taskId', 'platform', 'mode', 'operation', 'conversationId', 'prompt']); requestId(args.requestId);
    if (!['create_conversation', 'send_to_conversation'].includes(args.operation) || typeof args.prompt !== 'string' || !args.prompt.length || !args.prompt.isWellFormed() || Buffer.byteLength(args.prompt) > 32768) fail('DISPATCH_ARGUMENTS', '投递只支持有界文本的建聊或续发。');
    if (args.operation === 'create_conversation' ? args.conversationId !== null : typeof args.conversationId !== 'string' || !args.conversationId.length) fail('NATIVE_ID_INVALID', '建聊编号必须为空，续发必须提供真实原编号。');
    const workspace = this.controller.verifyWorkspace(this.controller.workspace(args.taskId));
    if (args.operation === 'send_to_conversation') this.controller.binding(args);
    const payloadHash = sha256(JSON.stringify(canonical(args)));
    return this.controller.transaction(() => {
      const cached = this.controller.db.prepare('SELECT * FROM dispatch_requests WHERE request_id=?').get(args.requestId);
      if (cached) { if (cached.payload_hash !== payloadHash) fail('DISPATCH_REQUEST_CONFLICT', '投递请求已用于不同正文或绑定。'); return { ...this.view(this.row(cached.dispatch_id)), deduplicated: true }; }
      const active = this.controller.db.prepare('SELECT value FROM session_dispatches WHERE task_id=?').all(args.taskId).map(row => JSON.parse(row.value)).find(job => job.state === 'queued' || job.state === 'unknown' || pending.has(job.state));
      if (active) fail('DISPATCH_TASK_BUSY', '任务已有排队、在途或未知投递，不自动重派。');
      const session = this.controller.session(args.taskId, false);
      const job = { dispatchId: randomUUID(), actor: this.controller.actor, operation: args.operation, args: { ...args, requestId: `dispatch_${randomUUID().replaceAll('-', '')}` },
        state: 'queued', queuedAt: now(), ownerPid: process.pid, evidenceLevel: this.fixtureConfig ? 'local_test' : 'real_runtime',
        binding: { taskId: workspace.taskId, markerSha256: workspace.markerSha256, identities: workspace.identities, platform: args.platform, mode: args.mode, conversationId: session?.conversationId ?? null, lastTurnId: session?.lastTurnId ?? null } };
      this.put(job); this.controller.db.prepare('INSERT INTO dispatch_requests VALUES(?,?,?)').run(args.requestId, payloadHash, job.dispatchId); this.event(job, job.state); return this.view(job);
    });
  }
  preflight(job) {
    if (job.args.platform === 'claude') fail('CLAUDE_PAUSED', 'Claude 所有新增执行能力暂停。');
    if (job.args.platform === 'doubao') fail('DOUBAO_CONTRACT_UNAVAILABLE', '豆包正式 create/send/read/wakeup、原生编号与目录 scope 契约未取得。');
    if (job.args.platform !== 'workbuddy' || job.args.mode !== 'codebuddy_cli') fail('MODE_ROUTE_UNAVAILABLE', '该产品模式缺少本机受支持的正式执行路由，不自动换模式。');
    const workspace = this.controller.verifyWorkspace(this.controller.workspace(job.args.taskId)), session = this.controller.session(job.args.taskId, false), expected = job.binding;
    if (workspace.markerSha256 !== expected.markerSha256 || JSON.stringify(workspace.identities) !== JSON.stringify(expected.identities) || (session?.lastTurnId ?? null) !== expected.lastTurnId || (session?.conversationId ?? null) !== expected.conversationId) fail('DISPATCH_BINDING_CHANGED', '入队后的任务或原生会话绑定已变化。');
    if (job.operation === 'create_conversation' && session) fail('CREATE_ALREADY_CLAIMED', '旧创建占位已存在，禁止重跑原任务。');
    if (job.operation === 'send_to_conversation') { this.controller.binding(job.args); if (session.status !== 'ready' || session.activeTurnId) fail('CONVERSATION_NOT_READY', '原会话有在途、未知或失败轮次，禁止唤醒续发。'); }
    const adapter = this.controller.adapter(job.args);
    return adapter.prepare(workspace.cwd, job.args.conversationId, { turnId: job.dispatchId });
  }
  async wake(args) {
    this.manager(); strict(args, ['requestId', 'dispatchId']); requestId(args.requestId);
    let job = this.controller.transaction(() => {
      const current = this.row(args.dispatchId), request = this.controller.db.prepare('SELECT dispatch_id FROM dispatch_wake_requests WHERE request_id=?').get(args.requestId);
      if (request && request.dispatch_id !== args.dispatchId) fail('WAKE_REQUEST_CONFLICT', '唤醒请求编号已绑定另一投递，不能触发多个副作用。');
      if (!request) this.controller.db.prepare('INSERT INTO dispatch_wake_requests VALUES(?,?)').run(args.requestId, args.dispatchId);
      return current;
    });
    if (job.wakeRequestId) return { ...this.view(job), deduplicated: true, externalSideEffectRepeated: false };
    let plan;
    try { plan = this.preflight(job); }
    catch (error) {
      return this.controller.transaction(() => { job = this.row(args.dispatchId); if (job.wakeRequestId) return this.view(job);
        job.state = 'blocked'; job.blocker = { code: error.code ?? 'PREFLIGHT_FAILED', message: sanitizeCodeBuddyValue(error.message), required: job.args.platform === 'doubao' ? ['official_create_send_read_wakeup_contract', 'native_conversation_id', 'cwd_and_file_scope'] : ['supported_runtime_layout_and_pins', 'independent_mode_authentication'] };
        this.put(job); this.event(job, job.state); return this.view(job); });
    }
    const token = randomBytes(32).toString('base64url');
    const reserved = this.controller.transaction(() => { job = this.row(args.dispatchId); if (job.wakeRequestId) return false;
      job.state = 'worker_starting'; job.wakeRequestId = args.requestId; job.leaseHash = sha256(token); job.deadline = Date.now() + plan.timeoutMs + 60000; job.workerScriptHash = sha256(fs.readFileSync(workerFile)); job.blocker = null;
      this.put(job); this.event(job, job.state); return true; });
    if (!reserved) return { ...this.view(this.row(args.dispatchId)), deduplicated: true };
    const workspace = this.controller.workspace(job.args.taskId), directory = sessionPath(path.join(workspace.work, 'session-dispatch', job.dispatchId), false);
    let fd, child;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const env = { ...plan.env, COLLAB_PROJECT_ROOT: PROJECT_ROOT };
      if (this.fixtureConfig) {
        const fixtureFile = path.join(directory, 'fixture-config.json'); fs.writeFileSync(fixtureFile, JSON.stringify(this.fixtureConfig), { flag: 'wx' });
        env.COLLAB_TEST_MODE = '1'; env.COLLAB_DISPATCH_FIXTURE_FILE = fixtureFile;
      }
      fd = fs.openSync(sessionPath(path.join(directory, 'worker-output.txt'), false), 'wx');
      child = fork(workerFile, ['--db', this.controller.dbPath, '--dispatch-id', job.dispatchId], { execPath: process.execPath, execArgv: [], cwd: workspace.cwd, env, shell: false, windowsHide: true, detached: true, stdio: ['ignore', fd, fd, 'ipc'] });
      const result = await new Promise(resolve => {
        const timer = setTimeout(() => resolve('handoff_unknown'), 5000);
        const done = value => { clearTimeout(timer); resolve(value); };
        child.once('spawn', () => {
          try {
            this.controller.transaction(() => { const current = this.row(job.dispatchId); current.workerPid = child.pid; current.workerStarted = true; this.put(current); this.event(current, 'worker_started'); });
            child.send({ token });
          } catch { child.kill(); done('handoff_unknown'); }
        });
        child.once('error', () => done('handoff_unknown'));
        child.once('message', message => done(message?.ready === true ? 'ready' : 'handoff_unknown'));
        child.once('exit', () => done('exited'));
      });
      if (result === 'handoff_unknown') this.controller.transaction(() => { const current = this.row(job.dispatchId); if (pending.has(current.state)) { current.state = 'unknown'; this.put(current); this.event(current, 'handoff_unknown'); } });
      if (child.connected) child.disconnect(); child.unref();
      return this.view(this.row(job.dispatchId));
    } catch (error) {
      this.controller.transaction(() => { const current = this.row(job.dispatchId); current.state = 'unknown'; current.blocker = { code: 'WORKER_START_UNKNOWN', message: sanitizeCodeBuddyValue(error.message) }; this.put(current); this.event(current, current.state); });
      return this.view(this.row(job.dispatchId));
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  authenticateWorker(job, token) { if (typeof token !== 'string' || !job.leaseHash || !timingSafeEqual(Buffer.from(job.leaseHash, 'hex'), Buffer.from(sha256(token), 'hex')) || job.workerPid !== process.pid || Date.now() > job.deadline) fail('DISPATCH_LEASE_INVALID', '执行器租约、进程或原投递绑定不一致。'); }
  workerState(id, token, state, turnId = null) {
    this.controller.transaction(() => { const job = this.row(id); this.authenticateWorker(job, token); if (!pending.has(job.state)) fail('DISPATCH_STATE_UNKNOWN', '原投递已终止或未知，不再执行。');
      job.state = state; if (turnId) job.turnId = turnId; if (state === 'wake_attempting') job.launchIntentRecorded = true; if (state === 'running') job.platformProcessStarted = true; this.put(job); this.event(job, state); });
  }
  async runWorker(id, token) {
    const job = this.row(id); this.authenticateWorker(job, token);
    if (sha256(fs.readFileSync(workerFile)) !== job.workerScriptHash) fail('DISPATCH_SOURCE_CHANGED', '受管执行器源码已变化。');
    this.workerState(id, token, 'worker_ready');
    process.send?.({ ready: true });
    try {
      this.preflight(job);
      this.controller.dispatchBinding = job.binding;
      this.controller.executionObserver = (state, turnId) => this.workerState(id, token, state, turnId);
      const outcome = await this.controller.execute(job.operation, job.args);
      this.controller.transaction(() => { const current = this.row(id); this.authenticateWorker(current, token);
        if (!pending.has(current.state)) fail('DISPATCH_STATE_UNKNOWN', '投递已未知，保留原生结果供核查。');
        current.state = outcome.turn.status; current.outcome = outcome; current.finishedAt = now(); current.platformProcessStarted = outcome.turn.processStarted; this.put(current); this.event(current, current.state); });
    } catch (error) {
      this.controller.transaction(() => { const current = this.row(id); if (current.state !== 'unknown') current.state = current.platformProcessStarted || current.launchIntentRecorded ? 'unknown' : 'blocked'; current.blocker ??= { code: error.code ?? 'WORKER_EXECUTION_UNKNOWN', message: sanitizeCodeBuddyValue(error.message) }; this.put(current); this.event(current, current.state); });
    }
  }
  get(args) {
    this.manager(); strict(args, ['dispatchId']); let job = this.row(args.dispatchId);
    if (pending.has(job.state)) {
      let gone = false; try { process.kill(job.workerPid ?? job.ownerPid, 0); } catch (error) { gone = error.code === 'ESRCH'; }
      if (gone || Date.now() > job.deadline) this.controller.transaction(() => { job = this.row(args.dispatchId); if (pending.has(job.state)) { job.state = 'unknown'; job.blocker = { code: gone ? 'DISPATCH_OWNER_EXITED' : 'DISPATCH_LEASE_EXPIRED', message: '保留原投递与副作用占位，不自动重新唤醒。' }; this.put(job); this.event(job, job.state); } });
    }
    return this.view(job);
  }
}
