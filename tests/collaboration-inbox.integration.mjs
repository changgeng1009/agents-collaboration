import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function ownerFixture() {
  const { CollaborationStore } = await import('../bridge/src/collaboration-store.mjs');
  const config = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const store = new CollaborationStore({ dbPath: config.dbPath });
  const identity = store.resolveCredential(fs.readFileSync(config.credentialFile, 'utf8'));
  const pending = store.as(identity).invoke('wait_for_messages', config.args);
  process.send({ started: true });
  if(config.hold) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5000);
  await pending;store.close();process.disconnect();
}

async function main() {
  const { CODE_ROOT, FIXTURE_ROOT } = await import('./test-context.mjs');
  const { CollaborationStore } = await import('../bridge/src/collaboration-store.mjs');
  const { startCollaborationService } = await import('../bridge/src/collaboration-service.mjs');
  const { Client } = await import('../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js');
  const { StreamableHTTPClientTransport } = await import('../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js');
  const logDir = path.join(FIXTURE_ROOT, 'logs', 'active-inbox-tests');fs.mkdirSync(logDir, { recursive: true });
  const checks = [], stores = [], services = [], clients = [], children = [], timings = {};
  const check = async (name, fn) => { await fn();checks.push({ name, passed: true });fs.appendFileSync(path.join(logDir,'progress.jsonl'),JSON.stringify({name,passed:true})+'\n','utf8'); };
  const rejected = (fn, code) => assert.rejects(async()=>fn(), error => error.code === code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async fn => { const stop = Date.now() + 5000;for (;;) { const result = fn();if (result) return result;if (Date.now() > stop) throw new Error('隔离观察超时');await pause(25); } };
  let sequence = 0;
  const identity = new Map(), credentials = new Map();
  let store;
  const call = (who, name, args = {}, context) => store.as(identity.get(who)).invoke(name, { ...(!name.startsWith('get_') ? { requestId: `test_${++sequence}` } : {}), ...args }, context);
  const open = async (who, groupId, options = {}) => (await call(who, 'open_inbox', { groupId, ...options })).inbox.inboxId;
  const waitArgs = (groupId, inboxId, options = {}) => ({ groupId, inboxId, waitMs: 500, limit: 1, ...options });
  const send = (recipientIds, body = '合成收件内容', groupId = 'main_group') => call('alpha', 'send_message', { groupId, recipientIds, body });
  const setup = target => {
    const admin = target.bootstrapAdmin();credentials.set('admin', admin.credentialFile);
    identity.set('admin', target.resolveCredential(fs.readFileSync(admin.credentialFile, 'utf8')));
    for (const [id, platform] of [['alpha', 'workbuddy'], ['beta', 'doubao'], ['gamma', 'fixture']]) {
      const provisioned = target.provisionMember({ instanceId: id, platform, mode: 'desktop' });credentials.set(id, provisioned.credentialFile);
      identity.set(id, target.resolveCredential(fs.readFileSync(provisioned.credentialFile, 'utf8')));
    }
  };
  async function peer(service, who) {
    const client = new Client({ name: 'isolated_active_client_not_platform', version: '0.2.18' });clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(service.service.endpoint), { requestInit: { headers: { Authorization: `Bearer ${fs.readFileSync(credentials.get(who), 'utf8')}` } } }));
    return client;
  }
  async function tool(client, name, args = {}, options) {
    const result = await client.callTool({ name, arguments: { ...(!name.startsWith('get_') ? { requestId: `http_${++sequence}` } : {}), ...args } }, undefined, options);
    const output = result.structuredContent ?? JSON.parse(result.content[0].text);
    if (result.isError) throw Object.assign(new Error(output.message), { code: output.code });return output;
  }
  function raw(who, body, id) {
    const message = id === undefined ? body : { jsonrpc:'2.0',id,method:'tools/call',params:{name:'wait_for_messages',arguments:body} };
    const bytes=Buffer.from(JSON.stringify(message));let request;
    const response=new Promise((resolve,reject)=>{
      request=http.request(services[0].service.endpoint,{method:'POST',headers:{Authorization:`Bearer ${fs.readFileSync(credentials.get(who),'utf8')}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','Content-Length':bytes.length}},res=>{
        const chunks=[];res.on('data',bytes=>chunks.push(bytes));res.on('end',()=>resolve({status:res.statusCode,body:chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null}));
      });request.on('error',reject);request.end(bytes);
    }).catch(error=>error);
    return {request,response};
  }
  try {
    store = new CollaborationStore();stores.push(store);setup(store);
    for (const groupId of ['main_group', 'second_group', 'third_group', 'fourth_group', 'fifth_group', 'http_group', 'http_empty', 'auth_group', 'stop_group'])
      await call('admin', 'create_group', { groupId, title: '隔离合成收件组', memberIds: ['alpha', 'beta', 'gamma'], managerId: 'alpha', policy: { allowMemberTakeover: true } });
    await call('admin','create_group',{groupId:'private_group',title:'仅alpha组',memberIds:['alpha'],managerId:'alpha',policy:{allowMemberTakeover:false}});
    await check('组外成员不能开启收件或用组名取得正文',()=>rejected(()=>open('beta','private_group'),'GROUP_FORBIDDEN'));
    await check('管理员不能开启、等待、查询或停止成员收件', async () => { for (const name of ['open_inbox','wait_for_messages','get_inbox','close_inbox']) await rejected(() => call('admin', name, {}), 'TOOL_FORBIDDEN'); });
    const inbox = await open('beta', 'main_group', { maxMessages: 4, maxWaits: 8 });
    await check('固定成员身份拒绝actor/root/endpoint注入及超界参数', async () => {
      for (const extra of [{ actor: 'alpha' }, { root: '..' }, { endpoint: 'https://example.invalid' }, { waitMs: 20001 }, { limit: 9 }])
        await rejected(() => call('beta', 'wait_for_messages', { ...waitArgs('main_group', inbox), ...extra }), 'ARGUMENT_INVALID');
      await rejected(() => call('gamma', 'open_inbox', { groupId: 'main_group', durationSeconds: 601 }), 'ARGUMENT_INVALID');
    });
    await check('manager不能代查/停止/等待他人inbox，组绑定不能更换', async () => {
      await rejected(() => call('alpha', 'get_inbox', { groupId: 'main_group', inboxId: inbox }), 'INBOX_FORBIDDEN');
      await rejected(() => call('alpha', 'close_inbox', { groupId: 'main_group', inboxId: inbox, reason: '不能代停' }), 'INBOX_FORBIDDEN');
      await rejected(() => call('alpha', 'wait_for_messages', waitArgs('main_group', inbox)), 'INBOX_FORBIDDEN');
      await rejected(() => call('beta', 'get_inbox', { groupId: 'second_group', inboxId: inbox }), 'INBOX_FORBIDDEN');
    });
    const firstArgs = waitArgs('main_group', inbox, { requestId: 'first_wait', waitMs: 3000 });
    const pending = call('beta', 'wait_for_messages', firstArgs);
    await check('等待已持久占位且SQLite不跨await持锁', async () => {
      assert.equal(store.inTransaction, false);assert.ok(store.get('inbox', inbox).activeWait);
      const other = new CollaborationStore();stores.push(other);const asAlpha = other.resolveCredential(fs.readFileSync(credentials.get('alpha'), 'utf8'));
      await other.as(asAlpha).invoke('send_message', { requestId: 'other_store_write', groupId: 'second_group', recipientIds: ['beta'], body: '另一组独立事务成功' });other.close();
    });
    await check('同requestId在途重放返回原占位、不再起等待，变参拒绝', async () => {
      const duplicate = await call('beta', 'wait_for_messages', firstArgs);assert.equal(duplicate.inProgress, true);assert.equal(duplicate.deduplicated, true);
      await rejected(() => call('beta', 'wait_for_messages', { ...firstArgs, limit: 2 }), 'REQUEST_ID_CONFLICT');
      await rejected(() => call('beta', 'wait_for_messages', waitArgs('main_group', inbox)), 'INBOX_WAIT_BUSY');
      assert.equal(store.get('inbox', inbox).waitCount, 1);
    });
    await send(['gamma'], '私信只能gamma读取');await send(['beta'], '跨组私信', 'second_group');
    const sent = await send(['beta'], JSON.stringify({ values: [3, 8, 13] }));const received = await pending;
    await check('等待后收到本人本组新信并保持私信/跨组隔离', () => {
      assert.equal(received.status, 'messages');assert.equal(received.messages.length, 1);assert.equal(received.messages[0].messageId, sent.message.messageId);
      assert.equal(received.messages[0].body, JSON.stringify({ values: [3, 8, 13] }));assert.equal(received.inbox.messageCount, 1);
      assert.equal(received.messages[0].deliveries.beta.acknowledgedAt, null);assert.ok(received.messages[0].deliveries.beta.deliveredAt);
    });
    const next = await send(['beta'], '第二批独立消息');
    await check('原等待正文持久重放不消费第二批或增加预算', async () => {
      const replay = await call('beta', 'wait_for_messages', firstArgs);assert.equal(replay.messages[0].messageId, sent.message.messageId);assert.equal(replay.deduplicated, true);
      assert.equal(store.get('inbox', inbox).messageCount, 1);assert.equal(store.get('message', next.message.messageId).deliveries.beta.deliveredAt, null);
    });
    await check('取回与本人ACK/处理/关联回复分列', async () => {
      await call('beta', 'ack_message', { groupId: 'main_group', messageId: sent.message.messageId });
      const sum = JSON.parse(received.messages[0].body).values.reduce((a,b) => a+b, 0);
      const reply = await call('beta', 'send_message', { groupId: 'main_group', recipientIds: ['alpha'], body: String(sum), replyTo: sent.message.messageId });
      const senderInbox = await open('alpha', 'main_group');const senderRead = await call('alpha', 'wait_for_messages', waitArgs('main_group', senderInbox));
      assert.equal(senderRead.messages[0].messageId, reply.message.messageId);assert.equal(senderRead.messages[0].body, '24');assert.equal(senderRead.modelProcessingVerified, false);
      await call('alpha', 'close_inbox', { groupId: 'main_group', inboxId: senderInbox, reason: '合成计算完成' });
    });
    await check('同inbox下一wait只消费下一批未确认且未由它返回的消息', async () => {
      const second = await call('beta', 'wait_for_messages', waitArgs('main_group', inbox));assert.equal(second.messages[0].messageId, next.message.messageId);assert.equal(second.inbox.messageCount, 2);
    });
    await call('beta', 'close_inbox', { groupId: 'main_group', inboxId: inbox, reason: '首个停止原因' });
    await check('停止保留首个原因且不自动重开，旧请求仍可查', async () => {
      const closed = await call('beta', 'close_inbox', { groupId: 'main_group', inboxId: inbox, reason: '不能改写' });assert.equal(closed.inbox.stopReason, '首个停止原因');
      await rejected(() => call('beta', 'wait_for_messages', waitArgs('main_group', inbox)), 'INBOX_CLOSED');assert.equal((await call('beta', 'wait_for_messages', firstArgs)).messages.length, 1);
    });
    await check('DB另连接重放正文仍为原批次，历史open回执提示当前已停',async()=>{
      const other=new CollaborationStore();stores.push(other);const who=other.resolveCredential(fs.readFileSync(credentials.get('beta'),'utf8'));
      const replay=await other.as(who).invoke('wait_for_messages',firstArgs);assert.equal(replay.messages[0].messageId,sent.message.messageId);assert.equal(replay.clientMustStop,true);assert.equal(replay.currentInbox.state,'closed');other.close();
    });
    await check('每组只开一个、每成员最多四组、其它成员不共享预算', async () => {
      const opened = [];
      for (const groupId of ['main_group','second_group','third_group','fourth_group']) opened.push([groupId, await open('beta', groupId)]);
      await rejected(() => open('beta', 'main_group'), 'INBOX_ALREADY_OPEN');await rejected(() => open('beta', 'fifth_group'), 'INBOX_LIMIT');
      const gamma = await open('gamma', 'fifth_group');await call('gamma', 'close_inbox', { groupId: 'fifth_group', inboxId: gamma, reason: '本人预算独立' });
      for (const [groupId,inboxId] of opened) await call('beta', 'close_inbox', { groupId, inboxId, reason: '显式收口' });
    });
    await check('等待次数预算耗尽后停止而不再起定时器', async () => {
      const id = await open('beta', 'http_empty', { maxWaits: 1 });const result = await call('beta', 'wait_for_messages', waitArgs('http_empty', id, { waitMs: 100 }));
      assert.equal(result.status, 'timeout');assert.equal(result.inbox.state, 'budget_exhausted');assert.equal(result.clientMustStop, true);
      await rejected(() => call('beta', 'wait_for_messages', waitArgs('http_empty', id)), 'INBOX_CLOSED');assert.equal(store.inbox.waiters.size, 0);
    });
    await check('消息预算只返回允许数量，剩余消息未消费', async () => {
      const id = await open('gamma', 'third_group', { maxMessages: 1 });const a = await send(['gamma'], '预算第一条', 'third_group');const b = await send(['gamma'], '预算第二条', 'third_group');
      const result = await call('gamma', 'wait_for_messages', waitArgs('third_group', id, { limit: 8 }));assert.equal(result.messages.length, 1);assert.equal(result.messages[0].messageId, a.message.messageId);assert.equal(result.inbox.state, 'budget_exhausted');assert.equal(store.get('message', b.message.messageId).deliveries.gamma.deliveredAt, null);
    });
    await check('总截止到期中止在途等待，空闲收件查询也过期', async () => {
      const id = await open('gamma', 'http_empty', { durationSeconds: 1 });const pending = call('gamma', 'wait_for_messages', waitArgs('http_empty', id, { waitMs: 3000 }));assert.equal((await pending).inbox.state, 'expired');
      const idle = await open('gamma', 'fourth_group', { durationSeconds: 1 });await pause(1050);assert.equal((await call('gamma', 'get_inbox', { groupId: 'fourth_group', inboxId: idle })).inbox.state, 'expired');
    });
    await check('选择/送达/原请求缓存异常会整体回滚，不留半批正文', async () => {
      const id = await open('beta', 'stop_group');const original = store.inbox.cache.bind(store.inbox);let injected = false;
      store.inbox.cache = (record, output) => { original(record, output);if (output.messages.length && !injected) { injected = true;throw Object.assign(new Error('本地事务故障注入'), { code: 'FIXTURE_TRANSACTION_ABORT' }); } };
      const message = await send(['beta'], '原子提交样本', 'stop_group');const result = await call('beta', 'wait_for_messages', waitArgs('stop_group', id));store.inbox.cache = original;
      assert.equal(result.status, 'interrupted');assert.equal(result.messages.length, 0);assert.equal(store.get('message', message.message.messageId).deliveries.beta.deliveredAt, null);assert.equal(store.get('inbox', id).messageCount, 0);
      const cache = store.db.prepare('SELECT response FROM core_requests WHERE actor=? ORDER BY rowid DESC LIMIT 1').get('member:beta');assert.equal(JSON.parse(cache.response).messages.length, 0);
    });
    await check('等待中退出撤销范围，重新加入也不能重放旧inbox', async () => {
      const id = await open('beta', 'auth_group');const args = waitArgs('auth_group', id, { requestId: 'left_wait', waitMs: 3000 });const pending = call('beta', 'wait_for_messages', args);
      await call('beta', 'leave_group', { groupId: 'auth_group' });const result = await pending;assert.equal(result.status, 'interrupted');assert.equal(result.messages.length, 0);
      await call('alpha', 'invite_member', { groupId: 'auth_group', instanceId: 'beta' });await call('beta', 'join_group', { groupId: 'auth_group' });
      await rejected(() => call('beta', 'wait_for_messages', args), 'INBOX_MEMBERSHIP_CHANGED');
    });
    await check('跨store显式停止立即缓存原等待终态，首个原因不变', async () => {
      const id = await open('beta', 'stop_group'), args = waitArgs('stop_group', id, { requestId: 'cross_store_stop', waitMs: 3000 });
      // 该组已有未取回消息，先显式确认，确保本轮确实进入等待。
      const existing = await call('beta','fetch_messages',{groupId:'stop_group'});for(const item of existing.messages) await call('beta','ack_message',{groupId:'stop_group',messageId:item.messageId});
      const pending = call('beta', 'wait_for_messages', args);const other = new CollaborationStore();stores.push(other);const who = other.resolveCredential(fs.readFileSync(credentials.get('beta'),'utf8'));
      await other.as(who).invoke('close_inbox',{requestId:'other_close',groupId:'stop_group',inboxId:id,reason:'另连接本人停止'});
      const result = await pending;assert.equal(result.status,'closed');assert.equal(result.inbox.stopReason,'另连接本人停止');assert.equal((await call('beta','wait_for_messages',args)).status,'closed');other.close();
    });
    await check('AbortSignal取消留下持久终态并清理监听/定时器', async () => {
      const id = await open('beta','http_empty'), controller = new AbortController();const args = waitArgs('http_empty',id,{requestId:'signal_cancel',waitMs:3000});
      const pending = call('beta','wait_for_messages',args,{signal:controller.signal});controller.abort();assert.equal((await pending).status,'interrupted');assert.equal(store.inbox.waiters.size,0);assert.equal((await call('beta','wait_for_messages',args)).status,'interrupted');
    });
    await check('多store同进程不会因runtime不同接管仍活跃等待', async () => {
      const id = await open('gamma','http_empty'), args = waitArgs('http_empty',id,{requestId:'other_store_observe',waitMs:2000});const pending = call('gamma','wait_for_messages',args);
      const other = new CollaborationStore();stores.push(other);const who = other.resolveCredential(fs.readFileSync(credentials.get('gamma'),'utf8'));assert.ok((await other.as(who).invoke('get_inbox',{groupId:'http_empty',inboxId:id})).inbox.activeWait);
      await call('gamma','close_inbox',{groupId:'http_empty',inboxId:id,reason:'本人停止'});await pending;other.close();
    });
    await check('真实隔离等待所有者强杀后DB重开不恢复/不消费迟到消息', async () => {
      const id = await open('gamma','http_empty'), args = waitArgs('http_empty',id,{requestId:'killed_owner',waitMs:20000});
      const configFile=path.join(logDir,'owner-fixture.local.json');fs.writeFileSync(configFile,JSON.stringify({dbPath:store.dbPath,credentialFile:credentials.get('gamma'),args}));
      const child=fork(fileURLToPath(import.meta.url),['--owner-fixture',configFile],{env:{...process.env},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);
      await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('所有者提前退出')));});
      assert.ok((await call('gamma','get_inbox',{groupId:'http_empty',inboxId:id})).inbox.activeWait);
      await rejected(()=>call('gamma','wait_for_messages',waitArgs('http_empty',id)),'INBOX_WAIT_BUSY');
      const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;
      const other=new CollaborationStore();stores.push(other);const who=other.resolveCredential(fs.readFileSync(credentials.get('gamma'),'utf8'));const snapshot=await other.as(who).invoke('get_inbox',{groupId:'http_empty',inboxId:id});assert.equal(snapshot.inbox.state,'interrupted');
      const replay=await other.as(who).invoke('wait_for_messages',args);assert.equal(replay.deduplicated,true);assert.equal(replay.status,'interrupted');
      const late=await send(['gamma'],'强杀后迟到消息','http_empty');assert.equal(store.get('message',late.message.messageId).deliveries.gamma.deliveredAt,null);other.close();
    });
    await check('相同PID但未知runtime/租约不接管，保守终止原请求', async () => {
      const id=await open('gamma','fifth_group'), args=waitArgs('fifth_group',id,{requestId:'pid_reuse',waitMs:20000});
      const controller=new AbortController(), pending=call('gamma','wait_for_messages',args,{signal:controller.signal});
      store.tx(()=>{const record=store.get('inbox',id);record.activeWait.runtimeId='unowned_runtime';record.activeWait.leaseId='unowned_lease';store.put('inbox',id,record);});
      assert.equal((await call('gamma','get_inbox',{groupId:'fifth_group',inboxId:id})).inbox.state,'interrupted');controller.abort();assert.equal((await pending).status,'interrupted');
    });
    await check('其它进程PID仍活但等待租约过期时保守停止，不接管执行',async()=>{
      const id=await open('gamma','fifth_group'),args=waitArgs('fifth_group',id,{requestId:'stalled_owner',waitMs:100});
      const configFile=path.join(logDir,'stalled-fixture.local.json');fs.writeFileSync(configFile,JSON.stringify({dbPath:store.dbPath,credentialFile:credentials.get('gamma'),args,hold:true}));
      const child=fork(fileURLToPath(import.meta.url),['--owner-fixture',configFile],{env:{...process.env},windowsHide:true,stdio:['ignore','ignore','ignore','ipc']});children.push(child);
      await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('停滞fixture提前退出')));});await pause(200);
      process.kill(child.pid,0);const snapshot=await call('gamma','get_inbox',{groupId:'fifth_group',inboxId:id});assert.equal(snapshot.inbox.state,'interrupted');assert.equal((await call('gamma','wait_for_messages',args)).status,'interrupted');
      const ended=new Promise(resolve=>child.once('exit',resolve));child.kill();await ended;
    });
    // 下半段使用真实隔离 HTTP，不复用生产端口、DB、凭据或真实客户端。
    const service=await startCollaborationService({port:0});services.push(service);const alpha=await peer(service,'alpha'),beta=await peer(service,'beta');
    await check('HTTP能力分列源码支持、客户端验证与被动唤醒',async()=>{const caps=await tool(beta,'get_capabilities');assert.equal(caps.version,'0.2.18');assert.equal(caps.activeInboxWaitSupported,true);assert.equal(caps.activeClientWaitVerified,false);assert.equal(caps.passiveWakeVerified,false);assert.equal(caps.businessCompletedVerified,false);});
    const httpInbox=(await tool(beta,'open_inbox',{groupId:'http_group',maxMessages:2})).inbox.inboxId;
    const httpWait=tool(beta,'wait_for_messages',waitArgs('http_group',httpInbox,{requestId:'http_late',waitMs:3000}));await pause(150);
    const httpMessage=await tool(alpha,'send_message',{groupId:'http_group',recipientIds:['beta'],body:JSON.stringify({values:[5,11,17]})});const httpRead=await httpWait;
    await check('真实HTTP一方等待，另一客户端稍后发信，返回本人正文',()=>{assert.equal(httpRead.messages[0].messageId,httpMessage.message.messageId);assert.equal(httpRead.messages[0].deliveries.beta.acknowledgedAt,null);assert.equal(httpRead.platformWakeAttempted,false);});
    await tool(beta,'ack_message',{groupId:'http_group',messageId:httpMessage.message.messageId});
    const senderInbox=(await tool(alpha,'open_inbox',{groupId:'http_group'})).inbox.inboxId;const senderWait=tool(alpha,'wait_for_messages',waitArgs('http_group',senderInbox,{waitMs:3000}));
    const result=JSON.parse(httpRead.messages[0].body).values.reduce((a,b)=>a+b,0);const reply=await tool(beta,'send_message',{groupId:'http_group',recipientIds:['alpha'],body:String(result),replyTo:httpMessage.message.messageId});const senderResult=await senderWait;
    await check('真实HTTP本人ACK/合成计算/reply后发方等待读回，仍不标模型或业务验证',()=>{assert.equal(senderResult.messages[0].messageId,reply.message.messageId);assert.equal(senderResult.messages[0].body,'33');assert.equal(senderResult.modelProcessingVerified,false);});
    await tool(beta,'close_inbox',{groupId:'http_group',inboxId:httpInbox,reason:'合成闭环结束'});await tool(alpha,'close_inbox',{groupId:'http_group',inboxId:senderInbox,reason:'合成闭环结束'});
    const longInbox=(await tool(beta,'open_inbox',{groupId:'http_empty'})).inbox.inboxId;
    // gamma 的迟到消息不能影响 beta 的最长等待。
    const longStart=Date.now();const long=await tool(beta,'wait_for_messages',waitArgs('http_empty',longInbox,{waitMs:20000}),{timeout:30000});timings.httpFullWaitMs=Date.now()-longStart;
    await check('真实HTTP完整正文后20秒工具等待不被15秒读体限制切断',()=>{assert.equal(long.status,'timeout');assert.ok(timings.httpFullWaitMs>=19900&&timings.httpFullWaitMs<26000);assert.equal(long.inbox.state,'open');});
    await tool(beta,'close_inbox',{groupId:'http_empty',inboxId:longInbox,reason:'长等待验证结束'});
    await check('真实HTTP未完成正文15秒返回408且不执行工具',async()=>{
      const begin=Date.now();const response=await new Promise((resolve,reject)=>{
        const req=http.request(service.service.endpoint,{method:'POST',headers:{Authorization:`Bearer ${fs.readFileSync(credentials.get('alpha'),'utf8')}`,'Content-Type':'application/json','Content-Length':100}},res=>{const chunks=[];res.on('data',bytes=>chunks.push(bytes));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())}));});req.on('error',reject);req.write('{');
      });timings.httpIncompleteBodyMs=Date.now()-begin;assert.equal(response.status,408);assert.equal(response.body.code,'REQUEST_TIMEOUT');assert.ok(timings.httpIncompleteBodyMs>=14900&&timings.httpIncompleteBodyMs<22000);
    });
    await check('HTTP工具取消后持久停止，原request重放不重新等待',async()=>{
      const id=(await tool(beta,'open_inbox',{groupId:'http_empty'})).inbox.inboxId,args=waitArgs('http_empty',id,{requestId:'http_cancel',waitMs:20000}),controller=new AbortController();
      const pending=tool(beta,'wait_for_messages',args,{signal:controller.signal});const observed=pending.catch(error=>error);await until(()=>store.get('inbox',id).activeWait);controller.abort();assert.ok(await observed instanceof Error);
      await until(()=>store.get('inbox',id).state==='interrupted');const replay=await tool(beta,'wait_for_messages',args);assert.equal(replay.status,'interrupted');assert.equal(replay.deduplicated,true);
    });
    await check('HTTP取消只匹配本人凭据/RPC，manager与管理员不能代取消',async()=>{
      const id=(await tool(beta,'open_inbox',{groupId:'http_empty'})).inbox.inboxId,args=waitArgs('http_empty',id,{requestId:'owned_rpc',waitMs:20000});
      const waiting=raw('beta',args,7);await until(()=>store.get('inbox',id).activeWait);
      const cancel={jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:7,reason:'本人取消'}};
      assert.equal((await raw('beta',{...cancel,params:{requestId:'7'}}).response).status,202);assert.ok(store.get('inbox',id).activeWait);
      assert.equal((await raw('beta',{...cancel,params:{requestId:999}}).response).status,202);assert.ok(store.get('inbox',id).activeWait);
      assert.equal((await raw('alpha',cancel).response).status,202);assert.ok(store.get('inbox',id).activeWait);
      assert.equal((await raw('admin',cancel).response).status,403);assert.ok(store.get('inbox',id).activeWait);
      assert.equal((await raw('beta',{...cancel,params:{...cancel.params,actor:'alpha'}}).response).status,403);assert.ok(store.get('inbox',id).activeWait);
      assert.equal((await raw('beta',cancel).response).status,202);const stopped=await waiting.response;
      assert.equal(stopped.body.result.structuredContent.status,'interrupted');assert.equal((await tool(beta,'wait_for_messages',args)).status,'interrupted');
    });
    await check('同凭据RPC编号歧义时拒绝猜测取消，用本人显式停止收口',async()=>{
      const first=(await tool(beta,'open_inbox',{groupId:'http_empty'})).inbox.inboxId,second=(await tool(beta,'open_inbox',{groupId:'http_group'})).inbox.inboxId;
      const a=raw('beta',waitArgs('http_empty',first,{requestId:'ambiguous_first',waitMs:20000}),'ambiguous_rpc'),b=raw('beta',waitArgs('http_group',second,{requestId:'ambiguous_second',waitMs:20000}),'ambiguous_rpc');
      await until(()=>store.get('inbox',first).activeWait&&store.get('inbox',second).activeWait);
      const cancel=await raw('beta',{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:'ambiguous_rpc'}}).response;assert.equal(cancel.status,409);assert.equal(cancel.body.code,'RPC_CANCEL_AMBIGUOUS');
      for(const[groupId,inboxId]of[['http_empty',first],['http_group',second]])await tool(beta,'close_inbox',{groupId,inboxId,reason:'本人显式收口歧义等待'});
      assert.equal((await a.response).body.result.structuredContent.status,'closed');assert.equal((await b.response).body.result.structuredContent.status,'closed');
    });
    await check('真实TCP请求断开后保留原请求终态且不消费迟到消息',async()=>{
      const id=(await tool(beta,'open_inbox',{groupId:'http_empty'})).inbox.inboxId,args=waitArgs('http_empty',id,{requestId:'tcp_disconnect',waitMs:20000});
      const waiting=raw('beta',args,'disconnect_rpc');await until(()=>store.get('inbox',id).activeWait);waiting.request.destroy();await waiting.response;
      await until(()=>store.get('inbox',id).state==='interrupted');const late=await tool(alpha,'send_message',{groupId:'http_empty',recipientIds:['beta'],body:'断线后迟到消息'});
      assert.equal(store.get('message',late.message.messageId).deliveries.beta.deliveredAt,null);assert.equal((await tool(beta,'wait_for_messages',args)).messages.length,0);
      const fetched=await tool(beta,'fetch_messages',{groupId:'http_empty'});for(const item of fetched.messages)await tool(beta,'ack_message',{groupId:'http_empty',messageId:item.messageId});
    });
    await check('等待中吊销凭据不会泄露后来正文，缓存查询也拒绝',async()=>{
      const id=await open('gamma','auth_group'),args=waitArgs('auth_group',id,{requestId:'revoked_wait',waitMs:3000});const pending=call('gamma','wait_for_messages',args);
      await call('admin','revoke_member',{instanceId:'gamma'});const result=await pending;assert.equal(result.messages.length,0);assert.equal(result.status,'interrupted');await rejected(()=>call('gamma','wait_for_messages',args),'CREDENTIAL_REVOKED');
    });
    await check('shutdown中断HTTP等待并排空工具/监听/定时器后关闭DB',async()=>{
      const id=(await tool(beta,'open_inbox',{groupId:'http_empty'})).inbox.inboxId,args=waitArgs('http_empty',id,{requestId:'shutdown_wait',waitMs:20000});const pending=tool(beta,'wait_for_messages',args).catch(error=>error);
      await until(()=>store.get('inbox',id).activeWait);
      const slowBody=new Promise((resolve,reject)=>{const req=http.request(service.service.endpoint,{method:'POST',headers:{Authorization:`Bearer ${fs.readFileSync(credentials.get('alpha'),'utf8')}`,'Content-Type':'application/json','Content-Length':100}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',reject);req.write('{');}).catch(error=>error);
      await pause(50);const began=Date.now();await service.close();timings.shutdownMs=Date.now()-began;await pending;assert.equal(await slowBody,503);
      assert.equal(service.store.inbox.waiters.size,0);assert.equal(service.store.closed,true);assert.ok(timings.shutdownMs<3000);assert.equal(store.get('inbox',id).state,'interrupted');await pause(120);assert.equal(service.store.inbox.waiters.size,0);
      const restarted=await startCollaborationService({port:0});services.push(restarted);const reconnected=await peer(restarted,'beta');const replay=await tool(reconnected,'wait_for_messages',args);assert.equal(replay.status,'interrupted');assert.equal(replay.deduplicated,true);assert.equal(restarted.store.inbox.waiters.size,0);await restarted.close();
    });
    await check('直接关闭共享store先停止等待，再关DB且close幂等',async()=>{
      const local=new CollaborationStore();stores.push(local);const who=local.resolveCredential(fs.readFileSync(credentials.get('beta'),'utf8'));
      const opened=await local.as(who).invoke('open_inbox',{requestId:'store_close_open',groupId:'fifth_group'});const pending=local.as(who).invoke('wait_for_messages',{requestId:'store_close_wait',...waitArgs('fifth_group',opened.inbox.inboxId,{waitMs:20000})});local.close();local.close();assert.equal((await pending).status,'interrupted');assert.equal(local.inbox.waiters.size,0);await pause(100);
    });
    const summary={status:'passed',checks,timings,source:'isolated_store_and_actual_http_not_official_platform',fixtureRoot:FIXTURE_ROOT,logDir,officialModelsStarted:0,officialPlatformCalls:0,productionServiceConnections:0,actualCodexApplicationClosed:false,activeOfficialClientWaitVerified:false,passiveWakeVerified:false};
    fs.writeFileSync(path.join(logDir,'summary.json'),JSON.stringify(summary,null,2),'utf8');console.log(JSON.stringify({status:'passed',checks:checks.length,timings,summaryPath:path.join(logDir,'summary.json'),officialPlatformCalls:0}));
  } catch(error) {fs.writeFileSync(path.join(logDir,'failure.json'),JSON.stringify({message:error.message,code:error.code,stack:error.stack,checks,timings},null,2),'utf8');console.error(error);process.exitCode=1;}
  finally {await Promise.allSettled(clients.map(client=>client.close()));await Promise.allSettled(services.map(service=>service.close()));for(const child of children){if(child.exitCode===null)child.kill();}for(const store of stores)store.close();}
}

if(process.argv[2]==='--owner-fixture') await ownerFixture();else await main();
