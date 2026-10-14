import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, SOURCE_ROOT, RUNTIME_ROOT, guardedPath, fail, sha256 } from './policy.mjs';
import { sessionCapability, allSessionCapabilities } from './session-capabilities.mjs';
import { readSessionConfiguration, ClaudeCodeTextAdapter, sanitizeSessionValue } from './claude-code-adapter.mjs';
import { readCodeBuddyConfiguration, CodeBuddyCliAdapter } from './codebuddy-cli-adapter.mjs';

export const SESSION_RUNTIME_ROOT = path.join(RUNTIME_ROOT, 'session-control');
export const TASK_WORKSPACE_ROOT = path.join(PROJECT_ROOT, 'task-workspaces');
const now = () => new Date().toISOString();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function scopedPath(candidate, { mustExist = true } = {}) {
  const resolved = guardedPath(PROJECT_ROOT, candidate, { mustExist });
  const relative = path.relative(PROJECT_ROOT, resolved);
  let cursor = PROJECT_ROOT;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) fail('WORKSPACE_LINK_FORBIDDEN', '任务目录和证据路径不能使用符号链接或目录联接。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return resolved;
}

function directoryIdentity(directory) {
  const checked = scopedPath(directory), stat = fs.statSync(checked, { bigint: true });
  if (!stat.isDirectory()) fail('WORKSPACE_DIRECTORY_REQUIRED', '任务组件必须是普通目录。');
  return { path: path.resolve(directory), realPath: fs.realpathSync(directory), dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}
function checkTaskId(taskId) {
  if (typeof taskId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(taskId) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(taskId)) fail('TASK_ID_INVALID', '本地任务编号须为安全标识符，不能含路径或保留设备名。');
}
function validRequest(requestId) { if (typeof requestId !== 'string' || !requestId.length || requestId.length > 128) fail('REQUEST_ID_INVALID', '请求编号必须非空且不超过 128 字符。'); }
function validPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.length || !prompt.isWellFormed() || Buffer.byteLength(prompt, 'utf8') > 32768) fail('PROMPT_INVALID', '提示正文必须为有效 Unicode，UTF-8 不超过 32 KiB。');
}
function nativeId(id, nullable = false) {
  if (nullable && id === null) return;
  if (typeof id !== 'string' || !id.length || id.length > 256 || id.startsWith('-') || /[\x00-\x1f]/.test(id)) fail('NATIVE_ID_INVALID', '平台编号只能是实际返回的非空字符串，不能作为 CLI 选项。');
}

export class SessionController {
  constructor({ actor, dbPath = path.join(SESSION_RUNTIME_ROOT, 'sessions.sqlite'), testAdapter = null, testHooks = {} }) {
    if (!['manager', 'workbuddy', 'claude', 'codex'].includes(actor)) fail('ROLE_DISABLED', '会话控制身份必须固定于可信进程。');
    if (testAdapter && (process.env.COLLAB_TEST_MODE !== '1' || PROJECT_ROOT === SOURCE_ROOT || testAdapter.evidenceLevel !== 'local_test')) fail('TEST_ADAPTER_FORBIDDEN', '协议测试适配器只可在隔离测试根明确注入。');
    this.actor = actor; this.testAdapter = testAdapter; this.testHooks = testAdapter ? testHooks : {};
    for (const directory of [SESSION_RUNTIME_ROOT, TASK_WORKSPACE_ROOT]) fs.mkdirSync(scopedPath(directory, { mustExist: false }), { recursive: true });
    this.dbPath = guardedPath(SESSION_RUNTIME_ROOT, dbPath, { mustExist: false }); scopedPath(this.dbPath, { mustExist: false });
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    for (const suffix of ['', '-wal', '-shm']) scopedPath(this.dbPath + suffix, { mustExist: false });
    this.db = new DatabaseSync(this.dbPath); this.db.exec('PRAGMA busy_timeout=0;');
    const schema = `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS task_workspaces(task_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controlled_sessions(task_id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS controlled_turns(turn_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_requests(request_id TEXT PRIMARY KEY, actor TEXT NOT NULL, operation TEXT NOT NULL, payload_hash TEXT NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, value TEXT NOT NULL);
      PRAGMA user_version=1;`;
    const deadline = Date.now() + 5000;
    for (;;) { try { this.db.exec(schema); break; } catch (error) { if (![5, 6].includes(error.errcode) || Date.now() >= deadline) { this.db.close(); throw error; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); } }
    this.db.exec('PRAGMA busy_timeout=5000;');
  }
  close() { this.db.close(); }
  transaction(callback) {
    scopedPath(this.dbPath);
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(table, key, value, required = true) {
    const record = this.db.prepare(`SELECT value FROM ${table} WHERE ${key}=?`).get(value);
    if (!record && required) fail('NOT_FOUND', '本控制器未登记该任务、会话或轮次。');
    return record ? JSON.parse(record.value) : null;
  }
  workspace(taskId) { return this.row('task_workspaces', 'task_id', taskId); }
  session(taskId, required = true) { return this.row('controlled_sessions', 'task_id', taskId, required); }
  turn(turnId) { return this.row('controlled_turns', 'turn_id', turnId); }
  putSession(session) { this.db.prepare('INSERT INTO controlled_sessions VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value').run(session.taskId, JSON.stringify(session)); }
  putTurn(turn) { this.db.prepare('INSERT INTO controlled_turns VALUES(?,?,?) ON CONFLICT(turn_id) DO UPDATE SET value=excluded.value').run(turn.turnId, turn.taskId, JSON.stringify(turn)); }
  event(operation, value) { this.db.prepare('INSERT INTO session_events(at,actor,operation,value) VALUES(?,?,?,?)').run(now(), this.actor, operation, JSON.stringify(sanitizeSessionValue(value))); }
  own(workspace) { if (workspace.owner !== this.actor) fail('TASK_OWNER_FORBIDDEN', '只能操作当前固定角色准备的任务。'); }
  verifyWorkspace(workspace) {
    this.own(workspace);
    for (const [name, identity] of Object.entries(workspace.identities)) {
      const current = directoryIdentity(identity.path);
      if (JSON.stringify(current) !== JSON.stringify(identity)) fail('WORKSPACE_IDENTITY_MISMATCH', `任务目录 ${name} 已被替换或目录绑定不一致。`);
    }
    const markerFile = scopedPath(path.join(workspace.taskRoot, '.task-binding.json'));
    if (sha256(fs.readFileSync(markerFile)) !== workspace.markerSha256) fail('WORKSPACE_BINDING_MISMATCH', '任务绑定记录已被替换。');
    return workspace;
  }
  request(operation, args) {
    validRequest(args.requestId);
    const payloadHash = sha256(JSON.stringify(canonical(args)));
    const previous = this.db.prepare('SELECT * FROM session_requests WHERE request_id=?').get(args.requestId);
    if (previous) {
      if (previous.actor !== this.actor || previous.operation !== operation || previous.payload_hash !== payloadHash) fail('REQUEST_ID_CONFLICT', '请求编号已被用于不同角色、操作或内容。');
      return { previous: JSON.parse(previous.value), payloadHash };
    }
    return { previous: null, payloadHash };
  }
  saveRequest(operation, args, payloadHash, value) { this.db.prepare('INSERT INTO session_requests VALUES(?,?,?,?,?)').run(args.requestId, this.actor, operation, payloadHash, JSON.stringify(value)); }
  replay(value) { return { ...value, deduplicated: true, historicalResponse: true, externalSideEffectRepeated: false }; }
  prepareTaskWorkspace(args) {
    checkTaskId(args.taskId);
    return this.transaction(() => {
      const request = this.request('prepare_task_workspace', args);
      if (request.previous) { this.verifyWorkspace(this.workspace(args.taskId)); return this.replay(request.previous); }
      const existing = this.row('task_workspaces', 'task_id', args.taskId, false);
      if (existing) {
        this.verifyWorkspace(existing); const response = { workspace: existing, platformConversationCreated: false, conversationId: null };
        this.saveRequest('prepare_task_workspace', args, request.payloadHash, response); return response;
      }
      const taskRoot = scopedPath(path.join(TASK_WORKSPACE_ROOT, args.taskId), { mustExist: false });
      if (fs.existsSync(taskRoot)) fail('UNREGISTERED_WORKSPACE_EXISTS', '同名未登记目录已存在，保留核查，不接管或覆盖。');
      fs.mkdirSync(taskRoot);
      const directories = { taskRoot, inputs: path.join(taskRoot, 'inputs'), work: path.join(taskRoot, 'work'), outputs: path.join(taskRoot, 'outputs') };
      for (const [name, directory] of Object.entries(directories)) if (name !== 'taskRoot') fs.mkdirSync(scopedPath(directory, { mustExist: false }));
      const marker = Buffer.from(JSON.stringify({ taskId: args.taskId, owner: this.actor, bindingId: randomUUID() }), 'utf8');
      fs.writeFileSync(path.join(taskRoot, '.task-binding.json'), marker, { flag: 'wx' });
      const workspace = { taskId: args.taskId, owner: this.actor, ...directories, cwd: taskRoot, createdAt: now(),
        identities: Object.fromEntries(Object.entries(directories).map(([name, directory]) => [name, directoryIdentity(directory)])), markerSha256: sha256(marker),
        controllerPathBoundaryVerified: true, platformCwdVerified: false, fileAccessBoundaryVerified: false, osIsolationVerified: false };
      this.db.prepare('INSERT INTO task_workspaces VALUES(?,?)').run(args.taskId, JSON.stringify(workspace));
      const response = { workspace, platformConversationCreated: false, conversationId: null };
      this.saveRequest('prepare_task_workspace', args, request.payloadHash, response); this.event('workspace_prepared', response); return response;
    });
  }
  runtimeVerified(platform, mode) {
    return this.db.prepare('SELECT value FROM controlled_sessions').all().some(row => { const session = JSON.parse(row.value); return session.platform === platform && session.mode === mode && session.runtimeVerified === true && session.evidenceLevel === 'real_runtime'; });
  }
  capabilities({ platform, mode }) {
    if (platform === undefined && mode === undefined) return { capabilities: allSessionCapabilities(readSessionConfiguration(), (p, m) => this.runtimeVerified(p, m), readCodeBuddyConfiguration()), automaticRetry: false };
    if (!platform || !mode) fail('EXPLICIT_MODE_REQUIRED', '平台和模式须同时明确，不自动切换。');
    const configuration = platform === 'workbuddy' ? readCodeBuddyConfiguration() : readSessionConfiguration();
    return sessionCapability(platform, mode, configuration, this.runtimeVerified(platform, mode));
  }
  adapter(args) {
    if (this.testAdapter && args.platform === (this.testAdapter.platform ?? 'claude') && args.mode === (this.testAdapter.mode ?? 'code_cli')) return this.testAdapter;
    const configuration = args.platform === 'workbuddy' ? readCodeBuddyConfiguration() : readSessionConfiguration(), capability = sessionCapability(args.platform, args.mode, configuration);
    if (!capability.enabled) { const error = new Error(capability.disabledReason); error.code = capability.disabledCode; error.capability = capability; throw error; }
    return args.platform === 'workbuddy' && args.mode === 'codebuddy_cli' ? new CodeBuddyCliAdapter(configuration) : new ClaudeCodeTextAdapter(configuration);
  }
  binding(args, { allowNull = false } = {}) {
    checkTaskId(args.taskId); nativeId(args.conversationId, allowNull);
    const workspace = this.verifyWorkspace(this.workspace(args.taskId)), session = this.session(args.taskId);
    if (session.platform !== args.platform || session.mode !== args.mode || session.conversationId !== args.conversationId) fail('CONVERSATION_BINDING_MISMATCH', '任务、平台、产品模式和原始会话编号须与本控制器绑定完全一致。');
    if (session.cwd !== workspace.cwd || session.workspaceBinding !== workspace.markerSha256) fail('WORKSPACE_BINDING_MISMATCH', '会话的原任务目录绑定不一致。');
    if (session.lastTurnId) this.verifyEvidence(this.turn(session.lastTurnId));
    return { workspace, session };
  }
  verifyEvidence(turn) {
    for (const evidence of turn.evidenceFiles ?? []) {
      const permittedRoots = [turn.workDirectory, turn.outputDirectory].filter(Boolean);
      if (!permittedRoots.some(root => { const relative = path.relative(root, evidence.file); return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); })) fail('EVIDENCE_SCOPE_MISMATCH', '轮次证据不属于原工作或输出目录。');
      if (sha256(fs.readFileSync(scopedPath(evidence.file))) !== evidence.sha256) fail('EVIDENCE_TAMPERED', '捕获的平台事件或结果文件已变动。');
    }
  }
  claim(operation, args) {
    checkTaskId(args.taskId); validPrompt(args.prompt);
    if (operation === 'send_to_conversation') nativeId(args.conversationId);
    const workspace = this.verifyWorkspace(this.workspace(args.taskId));
    const previous = this.request(operation, args).previous;
    if (previous) {
      const session = this.session(args.taskId);
      if (session.platform !== args.platform || session.mode !== args.mode || (operation === 'send_to_conversation' && session.conversationId !== args.conversationId)) fail('CONVERSATION_BINDING_MISMATCH', '历史回执也须核对原任务与平台绑定。');
      return { replay: this.replay(previous) };
    }
    if (operation === 'send_to_conversation') this.binding(args);
    const adapter = this.adapter(args);
    const plannedTurnId = randomUUID();
    const plan = adapter.prepare(workspace.cwd, operation === 'create_conversation' ? null : args.conversationId, { turnId: plannedTurnId });
    const claim = this.transaction(() => {
      const request = this.request(operation, args);
      if (request.previous) return { replay: this.replay(request.previous) };
      this.verifyWorkspace(workspace);
      let session = this.session(args.taskId, false);
      if (operation === 'create_conversation') {
        if (session) fail('CREATE_ALREADY_CLAIMED', '该任务已占位创建会话，未知或失败也不能换请求编号再次创建。');
        session = { taskId: args.taskId, owner: this.actor, platform: args.platform, mode: args.mode, conversationId: null, idSource: null,
          cwd: workspace.cwd, workspaceBinding: workspace.markerSha256, status: 'pending', createdAt: now(), runtimeVerified: false,
          evidenceLevel: adapter.evidenceLevel, platformStorage: plan.platformStorage, fileAccessBoundaryVerified: false, osIsolationVerified: false };
      } else {
        session = this.binding(args).session;
        if (session.activeTurnId || session.status !== 'ready') fail('CONVERSATION_NOT_READY', '会话有在途轮次或未知/失败结果，禁止再次发送。');
      }
      const turn = { taskId: args.taskId, turnId: plannedTurnId, requestId: args.requestId, operation, status: 'reserved', claimedAt: now(), ownerPid: process.pid,
        conversationId: session.conversationId, cwd: workspace.cwd, evidenceLevel: adapter.evidenceLevel, processStarted: false,
        modelRequestState: adapter.evidenceLevel === 'local_test' ? 'not_model_local_test' : 'unknown', modelUsage: 'unknown', cliInternalRetryStatus: 'unknown', result: null };
      session.status = 'pending'; session.activeTurnId = turn.turnId; session.lastTurnId = turn.turnId;
      this.putSession(session); this.putTurn(turn);
      const response = { session, turn, conversationId: session.conversationId, note: '占位已持久化；不能重发外部副作用。' };
      this.saveRequest(operation, args, request.payloadHash, response); this.event('turn_reserved', response);
      return { workspace, session, turn, plan };
    });
    return { adapter, ...claim };
  }
  async execute(operation, args) {
    const claim = this.claim(operation, args);
    if (claim.replay) return claim.replay;
    this.testHooks.afterClaim?.(claim);
    const { workspace, turn, plan, adapter } = claim;
    let result, inputDirectory, outputDirectory, workDirectory;
    try {
      this.verifyWorkspace(workspace);
      inputDirectory = scopedPath(path.join(workspace.inputs, 'session-control', turn.turnId), { mustExist: false });
      outputDirectory = scopedPath(path.join(workspace.outputs, 'session-control', turn.turnId), { mustExist: false });
      workDirectory = scopedPath(path.join(workspace.work, 'session-control', turn.turnId), { mustExist: false });
      for (const directory of [inputDirectory, workDirectory, outputDirectory]) fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(scopedPath(path.join(inputDirectory, 'request.json'), { mustExist: false }), JSON.stringify(sanitizeSessionValue({ ...args, promptSha256: sha256(Buffer.from(args.prompt, 'utf8')) }), null, 2), { flag: 'wx' });
      fs.writeFileSync(scopedPath(path.join(inputDirectory, 'launch-plan.json'), { mustExist: false }), JSON.stringify({ command: plan.command, args: plan.args, cwd: plan.cwd, shell: false, windowsHide: true, timeoutMs: plan.timeoutMs, envValuesLogged: false, evidenceLevel: adapter.evidenceLevel }, null, 2), { flag: 'wx' });
      this.verifyWorkspace(workspace);
      result = await adapter.run({ plan, prompt: args.prompt, workDirectory, inputDirectory, onSpawn: pid => this.transaction(() => {
        const current = this.turn(turn.turnId); current.status = 'running'; current.childPid = pid; current.processStarted = true; current.processStartedAt = now(); this.putTurn(current); this.event('process_started', current);
      }) });
      this.verifyWorkspace(workspace);
    } catch (error) { result = { status: 'unknown', reason: error.code ?? 'EXECUTION_UNKNOWN', message: sanitizeSessionValue(error.message), conversationId: null, evidenceLevel: adapter.evidenceLevel, workingDirectoryVerified: false, fileAccessBoundaryVerified: false, osIsolationVerified: false }; }
    if (outputDirectory) {
      try { fs.writeFileSync(scopedPath(path.join(outputDirectory, 'captured-result.json'), { mustExist: false }), JSON.stringify(sanitizeSessionValue(result), null, 2), { flag: 'wx' }); }
      catch (error) { result = { ...result, status: 'unknown', reason: 'EVIDENCE_WRITE_FAILED', message: sanitizeSessionValue(error.message) }; }
    }
    return this.transaction(() => {
      const session = this.session(args.taskId), current = this.turn(turn.turnId);
      if (result.conversationId !== null && result.conversationId !== undefined) {
        nativeId(result.conversationId);
        const collision = this.db.prepare('SELECT value FROM controlled_sessions WHERE task_id<>?').all(args.taskId).some(row => { const other = JSON.parse(row.value); return other.platform === session.platform && other.mode === session.mode && other.conversationId === result.conversationId; });
        if (collision) result = { ...result, status: 'unknown', reason: 'NATIVE_ID_ALREADY_BOUND', conversationId: null };
        else if (session.conversationId === null) { session.conversationId = result.conversationId; session.idSource = result.idSource; }
        else if (result.conversationId !== session.conversationId) result = { ...result, status: 'unknown', reason: 'NATIVE_ID_MISMATCH' };
      }
      current.status = result.status; current.finishedAt = now(); current.result = sanitizeSessionValue(result); current.inputDirectory = inputDirectory ?? null; current.workDirectory = workDirectory ?? null; current.outputDirectory = outputDirectory ?? null;
      current.modelUsage = result.result?.usage ?? 'unknown';
      if (session.platform === 'workbuddy' && session.mode === 'codebuddy_cli') current.modelRequestState = result.modelRequestState ?? (adapter.evidenceLevel === 'local_test' ? 'not_model_local_test' : 'unknown');
      current.evidenceFiles = [workDirectory, outputDirectory].filter(directory => directory && fs.existsSync(directory)).flatMap(directory => fs.readdirSync(directory).map(name => { const file = scopedPath(path.join(directory, name)); return { file, sha256: sha256(fs.readFileSync(file)) }; }));
      session.status = result.status === 'succeeded' ? 'ready' : result.status; session.activeTurnId = result.status === 'succeeded' ? null : turn.turnId;
      session.workingDirectoryVerified = result.workingDirectoryVerified === true; session.runtimeVerified = adapter.evidenceLevel === 'real_runtime' && result.status === 'succeeded';
      this.putSession(session); this.putTurn(current);
      const response = { session, turn: current, conversationId: session.conversationId, evidenceLevel: adapter.evidenceLevel, source: 'captured_platform_events', businessAcceptanceVerified: false };
      this.db.prepare('UPDATE session_requests SET value=? WHERE request_id=?').run(JSON.stringify(response), args.requestId); this.event('turn_finished', response); return response;
    });
  }
  createConversation(args) { return this.execute('create_conversation', args); }
  sendToConversation(args) { return this.execute('send_to_conversation', args); }
  readConversation(args) {
    const { session } = this.binding(args, { allowNull: true });
    let turn = this.turn(session.lastTurnId);
    if (['reserved', 'running'].includes(turn.status)) {
      let ownerGone = false; try { process.kill(turn.ownerPid, 0); } catch (error) { ownerGone = error.code === 'ESRCH'; }
      if (ownerGone) this.transaction(() => {
        turn = this.turn(turn.turnId); turn.status = 'unknown'; turn.result = { status: 'unknown', reason: 'OWNER_EXITED', evidenceLevel: turn.evidenceLevel }; turn.finishedAt = now();
        session.status = 'unknown'; this.putTurn(turn); this.putSession(session); this.event('owner_exit_unknown', { session, turn });
      });
    }
    this.verifyEvidence(turn);
    return { session, turn, replies: turn.result?.replies ?? [], source: 'captured_platform_events', importedAccountHistory: false,
      evidenceLevel: turn.evidenceLevel, runtimeVerified: session.runtimeVerified === true, businessAcceptanceVerified: false };
  }
  getConversationResult(args) { const response = this.readConversation(args); return { ...response, result: response.turn.result, pending: ['reserved', 'running'].includes(response.turn.status), automaticRetry: false, automaticRetryScope: 'controller_resubmission_only', cliInternalRetryStatus: 'unknown' }; }
}
