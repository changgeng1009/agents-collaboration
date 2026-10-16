import { randomUUID } from 'node:crypto';
import { fail, sha256 } from './policy.mjs';

const stamp = () => new Date().toISOString();
const infrastructure = { instanceId: 'infrastructure_inbox', kind: 'trusted_infrastructure' };
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
// 只识别本进程仍在运行的所有者；其它进程的活性不由 PID 存在推定。
const runtimes = new Map();

export class CollaborationInbox {
  constructor(store) {
    this.store = store;
    this.runtimeId = randomUUID();
    this.waiters = new Map();
    this.closed = false;
    runtimes.set(this.runtimeId, this);
  }

  view(inbox) {
    const { activeWait, credentialId, membershipSequence, deliveredMessageIds, ...record } = inbox;
    return { ...record, activeWait: activeWait ? { requestId: activeWait.requestId,
      startedAt: activeWait.startedAt, deadlineAt: activeWait.deadlineAt } : null,
      activeClientOnly: true, platformWakeAttempted: false, modelProcessingVerified: false,
      automaticRetry: false, acknowledgementsCreated: false };
  }

  output(inbox, status, messages = []) {
    return { status, inbox: this.view(inbox), messages, inProgress: status === 'waiting',
      clientMustStop: inbox.state !== 'open', automaticRetry: false,
      platformWakeAttempted: false, modelProcessingVerified: false, acknowledgementsCreated: false };
  }

  membershipSequence(inbox) {
    return this.store.db.prepare("SELECT COALESCE(MAX(seq),0) AS seq FROM core_events WHERE actor=? AND group_id=? AND operation IN ('join_group','leave_group')")
      .get(inbox.ownerId, inbox.groupId).seq;
  }

  own(identity, args) {
    this.store.authorize(identity, 'get_inbox', args);
    const inbox = this.store.get('inbox', args.inboxId);
    if (inbox.groupId !== args.groupId || inbox.ownerId !== identity.instanceId)
      fail('INBOX_FORBIDDEN', '只能操作本人在本组创建的收件等待，manager 不能代收件。');
    if (inbox.credentialId !== identity.credentialId || inbox.membershipSequence !== this.membershipSequence(inbox))
      fail('INBOX_MEMBERSHIP_CHANGED', '原收件授权已改变，不能恢复旧等待或重放旧正文。');
    return inbox;
  }

  cache(inbox, output) {
    const waiting = inbox.activeWait;
    if (!waiting) return;
    const update = this.store.db.prepare('UPDATE core_requests SET response=? WHERE actor=? AND request_id=?')
      .run(JSON.stringify(output), `member:${inbox.ownerId}`, waiting.requestId);
    if (update.changes !== 1) fail('INBOX_REQUEST_MISSING', '原等待请求占位缺失，保留状态供核查。');
  }

  // 调用者必须处于同步事务内：消息选择、取回记录和原请求正文缓存一并提交。
  complete(inbox, status, { messages = [], reason = null, terminal = false, identity = infrastructure } = {}) {
    const waiting = inbox.activeWait;
    if (inbox.state === 'open') {
      if (terminal) inbox.state = status;
      else if (Date.now() >= Date.parse(inbox.deadlineAt)) { inbox.state = 'expired'; reason = 'deadline'; }
      else if (inbox.waitCount >= inbox.maxWaits || inbox.messageCount >= inbox.maxMessages) { inbox.state = 'budget_exhausted'; reason = 'budget'; }
      if (inbox.state !== 'open') { inbox.closedAt = stamp(); inbox.stopReason = reason ?? status; }
    }
    const savedWait = inbox.activeWait;
    inbox.activeWait = null;
    const output = this.output(inbox, status, messages);
    // 保持 cache 的原请求关联；不在返回后再次更新数据库。
    this.cache({ ...inbox, activeWait: savedWait }, output);
    this.store.put('inbox', inbox.inboxId, inbox);
    this.store.event(identity, waiting ? 'inbox_wait_completed' : 'inbox_stopped', inbox.groupId,
      { inboxId: inbox.inboxId, requestId: waiting?.requestId ?? null, status,
        reasonSha256: reason ? sha256(reason) : null, messageIds: messages.map(message => message.messageId) });
    return output;
  }

  reconcile(inbox) {
    if (inbox.state !== 'open') return inbox;
    const credential = this.store.db.prepare('SELECT active FROM core_credentials WHERE id=?').get(inbox.credentialId);
    const member = this.store.get('member', inbox.ownerId, false), group = this.store.get('group', inbox.groupId, false);
    if (!credential?.active || member?.status !== 'active' || group?.members[inbox.ownerId]?.state !== 'active' || inbox.membershipSequence !== this.membershipSequence(inbox)) {
      this.complete(inbox, 'interrupted', { terminal: true, reason: 'authorization_changed' }); return inbox;
    }
    const waiting = inbox.activeWait;
    if (waiting) {
      const local = runtimes.get(waiting.runtimeId)?.waiters.get(inbox.inboxId);
      const localOwner = waiting.ownerPid === process.pid && local?.leaseId === waiting.leaseId;
      let ownerGone = false;
      if (waiting.ownerPid !== process.pid) {
        try { process.kill(waiting.ownerPid, 0); } catch (error) { ownerGone = error.code === 'ESRCH'; }
      }
      // 新进程不会接管旧 runtime。PID 被复用或无法核实则最多等原租约截止，随后保守停止。
      if (!localOwner && (waiting.ownerPid === process.pid || ownerGone || Date.now() >= Date.parse(waiting.deadlineAt)))
        this.complete(inbox, 'interrupted', { terminal: true, reason: ownerGone ? 'owner_exited' : 'owner_not_resumed' });
    }
    if (inbox.state === 'open' && Date.now() >= Date.parse(inbox.deadlineAt))
      this.complete(inbox, 'expired', { terminal: true, reason: 'deadline' });
    return inbox;
  }

  replay(identity, args, output) {
    this.store.authorize(identity, 'get_inbox', args);
    const current = output.inbox ? this.own(identity, { groupId: args.groupId, inboxId: output.inbox.inboxId }) : null;
    for (const message of output.messages ?? []) this.store.message(identity, args.groupId, message.messageId);
    return { ...output, deduplicated: true, historicalResponse: true,
      ...(current ? { currentInbox: this.view(current), clientMustStop: current.state !== 'open' } : {}) };
  }

  request(identity, name, args, action) {
    return this.store.tx(() => {
      this.store.authorize(identity, name, args);
      const actor = `${identity.kind}:${identity.instanceId}`, payloadHash = sha256(JSON.stringify(canonical({ name, args })));
      const cached = this.store.db.prepare('SELECT * FROM core_requests WHERE actor=? AND request_id=?').get(actor, args.requestId);
      if (cached) {
        if (cached.payload_hash !== payloadHash) fail('REQUEST_ID_CONFLICT', '请求编号已用于不同操作、正文或绑定。');
        return { output: this.replay(identity, args, JSON.parse(cached.response)), created: false };
      }
      const output = action();
      this.store.db.prepare('INSERT INTO core_requests VALUES(?,?,?,?)').run(actor, args.requestId, payloadHash, JSON.stringify(output));
      return { output, created: true };
    });
  }

  invoke(identity, name, args, { signal } = {}) {
    if (this.closed) fail('INBOX_UNAVAILABLE', '服务正在关闭，不再接受等待。');
    if (name === 'open_inbox') return this.request(identity, name, args, () => {
      const open = this.store.list('inbox').filter(inbox => inbox.ownerId === identity.instanceId)
        .map(inbox => this.reconcile(inbox)).filter(inbox => inbox.state === 'open');
      if (open.some(inbox => inbox.groupId === args.groupId)) fail('INBOX_ALREADY_OPEN', '本组已有本人收件，请使用原编号。');
      if (open.length >= 4) fail('INBOX_LIMIT', '每位成员同时最多四个组的收件等待。');
      const inbox = { inboxId: randomUUID(), groupId: args.groupId, ownerId: identity.instanceId, credentialId: identity.credentialId,
        state: 'open', createdAt: stamp(), deadlineAt: new Date(Date.now() + args.durationSeconds * 1000).toISOString(),
        maxMessages: args.maxMessages, maxWaits: args.maxWaits, messageCount: 0, waitCount: 0,
        membershipSequence: 0, deliveredMessageIds: [], activeWait: null, closedAt: null, stopReason: null };
      inbox.membershipSequence = this.membershipSequence(inbox);
      this.store.put('inbox', inbox.inboxId, inbox);
      this.store.event(identity, name, args.groupId, { inboxId: inbox.inboxId, deadlineAt: inbox.deadlineAt });
      return this.output(inbox, 'opened');
    }).output;
    // 查询可终结失去所有者的占位，但绝不恢复等待或消费消息。
    this.store.tx(() => this.reconcile(this.own(identity, args)));
    if (name === 'get_inbox') return this.output(this.own(identity, args), 'snapshot');
    const result = this.request(identity, name, args, () => {
      const inbox = this.own(identity, args);
      if (name === 'close_inbox') {
        if (inbox.state === 'open') return this.complete(inbox, 'closed', { terminal: true, reason: args.reason, identity });
        return this.output(inbox, inbox.state);
      }
      if (inbox.state !== 'open') fail('INBOX_CLOSED', '收件已停止，不要自动换编号重开。');
      if (inbox.activeWait) fail('INBOX_WAIT_BUSY', '本组本人已有在途等待，不能并发消费。');
      inbox.waitCount++;
      inbox.activeWait = { requestId: args.requestId, leaseId: randomUUID(), runtimeId: this.runtimeId, ownerPid: process.pid,
        startedAt: stamp(), deadlineAt: new Date(Math.min(Date.now() + args.waitMs, Date.parse(inbox.deadlineAt))).toISOString() };
      this.store.put('inbox', inbox.inboxId, inbox);
      this.store.event(identity, 'inbox_wait_started', args.groupId, { inboxId: inbox.inboxId, requestId: args.requestId });
      return this.output(inbox, 'waiting');
    });
    if (!result.created || name === 'close_inbox') return result.output;
    return this.wait(identity, args, signal);
  }

  wait(identity, args, signal) {
    const leaseId = this.store.get('inbox', args.inboxId).activeWait.leaseId;
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(entry.timer); signal?.removeEventListener('abort', entry.abort); this.waiters.delete(args.inboxId); };
      const settle = (output, error) => { cleanup(); if (error) reject(error); else resolve(output); };
      const finish = (reason = 'client_cancelled') => {
        if (!this.waiters.has(args.inboxId)) return;
        try {
          const output = this.store.tx(() => {
            const inbox = this.store.get('inbox', args.inboxId);
            if (inbox.activeWait?.leaseId === leaseId) return this.complete(inbox, 'interrupted', { terminal: true, reason });
            return this.cached(identity, args);
          });
          settle(output);
        } catch (error) { settle(null, error); }
      };
      const entry = { leaseId, timer: null, finish, abort: () => finish(signal?.reason?.code === 'SERVICE_STOPPING' ? 'service_stopping' : 'client_cancelled') };
      this.waiters.set(args.inboxId, entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      if (signal?.aborted) { entry.abort(); return; }
      const poll = () => {
        if (!this.waiters.has(args.inboxId)) return;
        try {
          const output = this.store.tx(() => {
            const inbox = this.own(identity, args);
            if (inbox.activeWait?.leaseId !== leaseId) return this.cached(identity, args);
            if (inbox.state !== 'open') return this.complete(inbox, inbox.state, { identity });
            if (Date.now() >= Date.parse(inbox.deadlineAt)) return this.complete(inbox, 'expired', { terminal: true, reason: 'deadline', identity });
            if (Date.now() >= Date.parse(inbox.activeWait.deadlineAt)) return this.complete(inbox, 'timeout', { identity });
            const messages = this.store.list('message').filter(message => message.groupId === args.groupId &&
              message.recipientIds.includes(identity.instanceId) && !message.deliveries[identity.instanceId].acknowledgedAt &&
              !inbox.deliveredMessageIds.includes(message.messageId)).slice(0, Math.min(args.limit, inbox.maxMessages - inbox.messageCount));
            if (!messages.length) return null;
            for (const message of messages) {
              this.store.message(identity, args.groupId, message.messageId);
              message.deliveries[identity.instanceId].deliveredAt ??= stamp();
              this.store.put('message', message.messageId, message);
              this.store.markRead(identity, 'message', message.messageId, args.groupId);
            }
            inbox.messageCount += messages.length;
            inbox.deliveredMessageIds.push(...messages.map(message => message.messageId));
            return this.complete(inbox, 'messages', { messages: messages.map(message => this.store.messageView(identity, message)), identity });
          });
          if (output) settle(output); else entry.timer = setTimeout(poll, 50);
        } catch (error) { finish(error.code ?? 'wait_failed'); }
      };
      poll();
    });
  }

  cached(identity, args) {
    const row = this.store.db.prepare('SELECT response FROM core_requests WHERE actor=? AND request_id=?').get(`member:${identity.instanceId}`, args.requestId);
    if (!row) fail('INBOX_REQUEST_MISSING', '原等待请求缺失，不能补消费消息。');
    return this.replay(identity, args, JSON.parse(row.response));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const entry of [...this.waiters.values()]) entry.finish('service_stopping');
    runtimes.delete(this.runtimeId);
  }
}
