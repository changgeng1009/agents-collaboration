import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PROJECT_ROOT, PROJECT_ID, RUNTIME_ROOT, ARTIFACT_ROOT, guardedPath, fail, sha256 } from './policy.mjs';

export const PARTNER_RUNTIME_ROOT = path.join(RUNTIME_ROOT, 'partner-channel');
export const PARTNER_ARTIFACT_ROOT = path.join(ARTIFACT_ROOT, 'workbuddy-channel');
export const TEXT_LIMIT = 32 * 1024;
const now = () => new Date().toISOString();
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

function limitedText(value) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > TEXT_LIMIT) fail('TEXT_LIMIT', '正文必须非空且 UTF-8 不超过 32 KiB。');
  if (!value.isWellFormed()) fail('INVALID_UTF8_TEXT', '正文含无法保持原文的无效 Unicode 字符。');
}

export class PartnerStore {
  constructor({ role, dbPath = path.join(PARTNER_RUNTIME_ROOT, 'partner.sqlite') }) {
    if (!['manager', 'workbuddy'].includes(role)) fail('ROLE_DISABLED', '伙伴通道只允许 manager 和 workbuddy 固定角色。');
    this.role = role;
    for (const dir of [PARTNER_RUNTIME_ROOT, PARTNER_ARTIFACT_ROOT]) fs.mkdirSync(guardedPath(PROJECT_ROOT, dir, { mustExist: false }), { recursive: true });
    this.dbPath = guardedPath(PARTNER_RUNTIME_ROOT, dbPath, { mustExist: false });
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    guardedPath(PARTNER_RUNTIME_ROOT, path.dirname(this.dbPath));
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA busy_timeout=0;');
    const deadline = Date.now() + 5000;
    const schema = `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS partner_messages(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS partner_artifacts(id TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS partner_requests(actor TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(actor,operation,request_id));
      CREATE TABLE IF NOT EXISTS partner_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, operation TEXT NOT NULL, value TEXT NOT NULL);
      PRAGMA user_version=1;`;
    for (;;) {
      try { this.db.exec(schema); break; }
      catch (error) {
        if (![5, 6].includes(error.errcode) || Date.now() >= deadline) { this.db.close(); throw error; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    this.db.exec('PRAGMA busy_timeout=5000;');
  }
  close() { this.db.close(); }
  message(id) {
    const row = this.db.prepare('SELECT value FROM partner_messages WHERE id=?').get(id);
    if (!row) fail('NOT_FOUND', '指定消息不存在。');
    return JSON.parse(row.value);
  }
  allMessages() { return this.db.prepare('SELECT value FROM partner_messages ORDER BY rowid').all().map(row => JSON.parse(row.value)); }
  putMessage(message) { this.db.prepare('INSERT INTO partner_messages VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(message.messageId, JSON.stringify(message)); }
  transaction(operation, args, action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const payloadHash = sha256(JSON.stringify(canonical(args)));
      const cached = this.db.prepare('SELECT * FROM partner_requests WHERE actor=? AND operation=? AND request_id=?').get(this.role, operation, args.requestId);
      if (cached) {
        if (cached.payload_hash !== payloadHash) fail('REQUEST_ID_CONFLICT', '请求编号已用于不同内容。');
        this.db.exec('COMMIT'); return { ...JSON.parse(cached.response), deduplicated: true, historicalResponse: true };
      }
      const result = action();
      this.db.prepare('INSERT INTO partner_events(at,actor,operation,value) VALUES(?,?,?,?)').run(now(), this.role, operation, JSON.stringify({ requestId: args.requestId, result }));
      this.db.prepare('INSERT INTO partner_requests VALUES(?,?,?,?,?)').run(this.role, operation, args.requestId, payloadHash, JSON.stringify(result));
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  capabilities() {
    return { projectId: PROJECT_ID, role: this.role, channel: 'partner-channel', version: '0.1.8', persistence: 'separate-sqlite-wal', dbPath: this.dbPath,
      artifactRoot: PARTNER_ARTIFACT_ROOT, textByteLimit: TEXT_LIMIT, permissions: ['peer_messages', 'explicit_read_ack', 'versioned_text'],
      permissionsScope: 'partner_messages_and_versioned_text', sessionControlCapabilityTool: 'get_session_capabilities',
      arbitraryFileRead: false, shellEnabled: false, modelExecutionEnabled: false, reviewEnabled: false, publishEnabled: false,
      externalMessagingEnabled: false, automaticWakeup: false, automaticManagerAck: false, realWorkBuddyVerified: false };
  }
  sendMessage(args) {
    limitedText(args.body);
    if (!['manager', 'workbuddy'].includes(args.recipient) || args.recipient === this.role) fail('RECIPIENT_FORBIDDEN', '只能向另一伙伴角色发送。');
    return this.transaction('send_message', args, () => {
      if (args.replyTo) {
        const parent = this.message(args.replyTo);
        if (parent.recipient !== this.role || parent.sender !== args.recipient) fail('REPLY_FORBIDDEN', '不能回复不属于当前角色的消息。');
        if (!parent.readAt) fail('READ_ACK_REQUIRED', '回复前须实际取回并确认读取。');
      }
      const message = { projectId: PROJECT_ID, messageId: randomUUID(), requestId: args.requestId, sender: this.role, recipient: args.recipient,
        body: args.body, replyTo: args.replyTo ?? null, queuedAt: now(), deliveredAt: null, readAt: null, status: 'queued' };
      this.putMessage(message);
      return { message, note: '这里只记录明确工具写入，不自动构造对方 ACK。' };
    });
  }
  readMessages(args) {
    return this.transaction('read_messages', args, () => {
      const messages = this.allMessages().filter(message => message.recipient === this.role && (!args.unreadOnly || !message.readAt));
      for (const message of messages) if (!message.deliveredAt) { message.deliveredAt = now(); message.status = 'delivered'; this.putMessage(message); }
      return { recipient: this.role, messages, note: '已送达本地接收进程；仍须 ack_message 显式确认已读。' };
    });
  }
  ackMessage(args) {
    return this.transaction('ack_message', args, () => {
      const message = this.message(args.messageId);
      if (message.recipient !== this.role) fail('RECIPIENT_FORBIDDEN', '不能确认其他角色的收件。');
      if (!message.deliveredAt) fail('DELIVERY_REQUIRED', '必须先取回收件箱。');
      if (!message.readAt) { message.readAt = now(); message.status = 'read'; this.putMessage(message); }
      return { message };
    });
  }
  getMessage({ messageId }) { return { message: this.message(messageId) }; }
  artifact(id, version) {
    const row = this.db.prepare('SELECT value FROM partner_artifacts WHERE id=? AND version=?').get(id, version);
    if (!row) fail('NOT_FOUND', '指定文本产物版本不存在。');
    return JSON.parse(row.value);
  }
  putTextArtifact(args) {
    limitedText(args.text);
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(args.artifactId) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(args.artifactId) || !Number.isSafeInteger(args.version) || args.version < 1) fail('ARTIFACT_ID_INVALID', '文本编号或版本不合法。');
    return this.transaction('put_text_artifact', args, () => {
      const last = this.db.prepare('SELECT version,value FROM partner_artifacts WHERE id=? ORDER BY version DESC LIMIT 1').get(args.artifactId);
      if (last && JSON.parse(last.value).owner !== this.role) fail('ARTIFACT_OWNER_FORBIDDEN', '不能更新另一角色的文本产物。');
      if (args.version !== (last?.version ?? 0) + 1) fail('VERSION_SEQUENCE', '文本版本须从 1 起逐次递增，不能覆盖旧版。');
      if (args.messageId) this.message(args.messageId);
      const bytes = Buffer.from(args.text, 'utf8');
      const filePath = guardedPath(PARTNER_ARTIFACT_ROOT, path.join(PARTNER_ARTIFACT_ROOT, 'versions', this.role, args.artifactId, `v${args.version}.txt`), { mustExist: false });
      fs.mkdirSync(path.dirname(filePath), { recursive: true }); guardedPath(PARTNER_ARTIFACT_ROOT, path.dirname(filePath));
      if (fs.existsSync(filePath)) fail('SNAPSHOT_EXISTS', '快照已存在，保留核查，不覆盖或自动删除。');
      fs.writeFileSync(filePath, bytes, { flag: 'wx' });
      const artifact = { projectId: PROJECT_ID, artifactId: args.artifactId, version: args.version, owner: this.role, messageId: args.messageId ?? null,
        createdAt: now(), mimeType: 'text/plain; charset=utf-8', byteLength: bytes.length, sha256: sha256(bytes), filePath };
      this.db.prepare('INSERT INTO partner_artifacts VALUES(?,?,?)').run(args.artifactId, args.version, JSON.stringify(artifact));
      return { artifact };
    });
  }
  getTextArtifact(args) {
    const artifact = this.artifact(args.artifactId, args.version);
    const filePath = guardedPath(PARTNER_ARTIFACT_ROOT, artifact.filePath);
    if (!fs.statSync(filePath).isFile()) fail('FILE_REQUIRED', '文本快照不是普通文件。');
    const bytes = fs.readFileSync(filePath);
    if (bytes.length > TEXT_LIMIT || sha256(bytes) !== artifact.sha256) fail('ARTIFACT_TAMPERED', '文本内容与登记校验值不一致。');
    return { artifact, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  }
}
