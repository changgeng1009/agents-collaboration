import { CODE_ROOT, FIXTURE_ROOT } from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { CodeBuddyCliAdapter, CODEBUDDY_BUILTIN_DENY_TOOLS, buildCodeBuddyPlan, normalizeCodeBuddyConfiguration, readCodeBuddyConfiguration, sanitizeCodeBuddyValue } from '../bridge/src/codebuddy-cli-adapter.mjs';
import { CODEBUDDY_TOOL_NAME, taskAuditPath, readCodeBuddyAudit } from '../bridge/src/codebuddy-audit.mjs';
import { sessionCapability } from '../bridge/src/session-capabilities.mjs';
import { sha256 } from '../bridge/src/policy.mjs';

const runId=randomUUID(), logDir=path.join(FIXTURE_ROOT,'logs','codebuddy-tests',runId), peers=[],checks=[];
fs.mkdirSync(logDir,{recursive:true});
const cliDir=path.join(FIXTURE_ROOT,'fixture-cli');
fs.mkdirSync(path.join(cliDir,'bin'),{recursive:true});fs.mkdirSync(path.join(cliDir,'dist'));
fs.writeFileSync(path.join(cliDir,'package.json'),JSON.stringify({type:'commonjs',private:true,fixture_only:true}),{flag:'wx'});
const cliScript=path.join(cliDir,'bin','codebuddy'), bundle=path.join(cliDir,'dist','codebuddy-headless.js');
fs.copyFileSync(path.join(CODE_ROOT,'tests','codebuddy-protocol-fixture.cjs'),cliScript,fs.constants.COPYFILE_EXCL);
fs.writeFileSync(bundle,'// local_test; never loaded as official CLI\n',{flag:'wx'});
const config={enabled:true,acceptedProductMode:true,nodeExecutable:process.execPath,cliScript,nodeSha256:sha256(fs.readFileSync(process.execPath)),cliSha256:sha256(fs.readFileSync(cliScript)),headlessSha256:sha256(fs.readFileSync(bundle)),internetEnvironment:'internal'};
const check=(name,fn)=>{fn();checks.push({name,passed:true});};
const request=label=>`${runId}-${label}`;
const create=(taskId,label=taskId,prompt={text:'中文第一轮'})=>({requestId:request(label),taskId,platform:'workbuddy',mode:'codebuddy_cli',prompt:JSON.stringify(prompt)});
const binding=(taskId,conversationId)=>({taskId,platform:'workbuddy',mode:'codebuddy_cli',conversationId});
const count=workspace=>fs.existsSync(path.join(workspace.work,'fixture-launches.jsonl'))?fs.readFileSync(path.join(workspace.work,'fixture-launches.jsonl'),'utf8').trim().split('\n').length:0;
class Peer{
 constructor(label,{source='tests/codebuddy-fixture-server.mjs',behavior='normal',role='manager'}={}){Object.assign(this,{label,source,behavior,role});peers.push(this);}
 async connect(){this.client=new Client({name:'local_codebuddy_controller_fixture',version:'0.1.6'});this.transport=new StdioClientTransport({command:process.execPath,args:[path.join(CODE_ROOT,this.source),'--role',this.role,...(this.source.startsWith('tests/')?['--behavior',this.behavior]:[])],env:{...getDefaultEnvironment(),COLLAB_PROJECT_ROOT:FIXTURE_ROOT,COLLAB_TEST_MODE:'1'},stderr:'pipe'});this.transport.stderr.on('data',bytes=>fs.appendFileSync(path.join(logDir,`${this.label}-stderr.txt`),bytes));await this.client.connect(this.transport);}
 async call(name,args={},expected=null){const response=await this.client.callTool({name,arguments:args});if(expected){assert.equal(response.isError,true);assert.equal(response.structuredContent?.code,expected);checks.push({name:`${name} 拒绝 ${expected}`,passed:true});}else assert.notEqual(response.isError,true,JSON.stringify(response));return response.structuredContent;}
 async close(){await this.client?.close();}
}
let failure=null;
try{
 check('独立模式确认与启用分列',()=>{const cap=sessionCapability('workbuddy','codebuddy_cli',{acceptedProductMode:true});assert.equal(cap.productModeAccepted,true);assert.equal(cap.enabled,false);assert.equal(cap.fileAccessBoundary.verified,false);assert.equal(cap.osIsolation.verified,false);});
 check('测试配置默认关闭',()=>assert.deepEqual(readCodeBuddyConfiguration(),{enabled:false,acceptedProductMode:false}));
 check('设备/OAuth URL及嵌套凭据脱敏',()=>{const safe=JSON.stringify(sanitizeCodeBuddyValue({nested:{credentials:{clientSecret:'sensitive_marker'},clientSecret:'sensitive_marker',device_code:'sensitive_marker',userCode:'sensitive_marker',ticket:'sensitive_marker'},link:'https://example.invalid/callback?user_code=sensitive_marker&secret=sensitive_marker',raw:'clientSecret=sensitive_marker device_code=sensitive_marker'}));assert.ok(!safe.includes('sensitive_marker'));});
 for(const extra of [{env:{CODEBUDDY_API_KEY:'synthetic'}},{internetEnvironment:'selfhosted'},{enabled:'true'},{executable:process.execPath},{acceptedProductMode:1}]) check('未知配置/认证/地区字段拒绝',()=>assert.throws(()=>normalizeCodeBuddyConfiguration({...config,...extra}),error=>error.code==='SESSION_CONFIG_INVALID'));
 const saved={};for(const key of ['CODEBUDDY_API_KEY','CODEBUDDY_AUTH_TOKEN','CODEBUDDY_CONFIG_DIR','CODEBUDDY_FORCE_LITE_WB_BUNDLE','CODEBUDDY_CODE_ISOLATED_MODE']){saved[key]=process.env[key];process.env[key]='synthetic_do_not_forward';}
 const plan=buildCodeBuddyPlan(config,FIXTURE_ROOT,null,{turnId:'fixtureTurn'});
 for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
 check('无扩展名脚本、原生 argv 与 UTF8 stdin 计划',()=>{assert.equal(plan.command,fs.realpathSync(process.execPath));assert.equal(path.basename(plan.args[0]),'codebuddy');assert.equal(plan.args[plan.args.indexOf('--tools')+1],'');assert.equal(plan.args[plan.args.indexOf('--setting-sources')+1],'');assert.equal(plan.args[plan.args.indexOf('--permission-mode')+1],'dontAsk');assert.equal(plan.shell,false);assert.equal(plan.args.includes('-y'),false);assert.equal(plan.args.includes('--safe-mode'),false);});
 check('不继承身份、helper、桌面宿主环境',()=>{assert.equal(plan.env.CODEBUDDY_INTERNET_ENVIRONMENT,'internal');for(const key of Object.keys(saved))assert.equal(plan.env[key],undefined);});
 check('专用清单只有单一服务和精确允许工具',()=>{assert.deepEqual(Object.keys(plan.mcpConfiguration.mcpServers),['t2_candidate']);assert.equal(plan.args[plan.args.indexOf('--allowedTools')+1],CODEBUDDY_TOOL_NAME);assert.equal(plan.mcpConfiguration.mcpServers.t2_candidate.alwaysLoad,true);});
 const denyAt=plan.args.indexOf('--disallowedTools'),denyArgs=plan.args.slice(denyAt+1,plan.args.indexOf('--max-turns'));
 check('34个精确 deny 实参完整、唯一且不包含唯一 MCP',()=>{assert.deepEqual(denyArgs,CODEBUDDY_BUILTIN_DENY_TOOLS);assert.equal(new Set(denyArgs).size,34);assert.ok(!denyArgs.some(name=>name.startsWith('mcp__')));});
 for(const [key,value] of [['nodeSha256','0'.repeat(64)],['cliSha256','0'.repeat(64)],['headlessSha256','0'.repeat(64)]])check('启动文件/bundle 哈希钉住',()=>assert.throws(()=>buildCodeBuddyPlan({...config,[key]:value},FIXTURE_ROOT,null,{turnId:'fixtureTurn'}),error=>error.code==='LAUNCHER_HASH_MISMATCH'));
 check('缺轮次绑定拒绝',()=>assert.throws(()=>buildCodeBuddyPlan(config,FIXTURE_ROOT),error=>error.code==='TURN_BINDING_INVALID'));
 check('未经启用拒绝',()=>assert.throws(()=>buildCodeBuddyPlan({...config,enabled:false},FIXTURE_ROOT,null,{turnId:'fixtureTurn'}),error=>error.code==='ADAPTER_DISABLED'));
 for(const id of ['--continue',9007199254740992,'bad\nvalue'])check('自造选项/数字编号拒绝',()=>assert.throws(()=>buildCodeBuddyPlan(config,FIXTURE_ROOT,id,{turnId:'fixtureTurn'}),error=>error.code==='NATIVE_ID_INVALID'));
 const normal=new Peer('normal'),second=new Peer('second');await normal.connect();await second.connect();
 const production=new Peer('production',{source:'bridge/src/partner-server.mjs'});await production.connect();
 const caps=await production.call('get_session_capabilities',{platform:'workbuddy',mode:'codebuddy_cli'});
 check('生产控制器未授权关闭，不以 fixture 提升能力',()=>{assert.equal(caps.enabled,false);assert.equal(caps.runtimeVerified,false);assert.equal(caps.authenticationStatus,'unverified');});
 await production.call('prepare_task_workspace',{requestId:request('disabled_prep'),taskId:'disabled'});
 await production.call('create_conversation',create('disabled'),'ADAPTER_DISABLED');
 const noDenyPrep=await normal.call('prepare_task_workspace',{requestId:request('native_no_deny_prep'),taskId:'native_no_deny'});
 const noDenyAdapter=new CodeBuddyCliAdapter(config);noDenyAdapter.evidenceLevel='local_test';
 const noDenyPlan=noDenyAdapter.prepare(noDenyPrep.workspace.cwd,null,{turnId:randomUUID()});
 noDenyPlan.args.splice(noDenyPlan.args.indexOf('--disallowedTools'),1+CODEBUDDY_BUILTIN_DENY_TOOLS.length);
 const noDenyInput=path.dirname(noDenyPlan.mcpConfigFile),noDenyWork=path.dirname(noDenyPlan.auditFile);
 fs.mkdirSync(noDenyInput,{recursive:true});fs.mkdirSync(noDenyWork,{recursive:true});
 const noDenyResult=await noDenyAdapter.run({plan:noDenyPlan,prompt:JSON.stringify({text:'无 deny 的安装声明样本'}),inputDirectory:noDenyInput,workDirectory:noDenyWork});
 check('无 deny 时空 tools 仍声明全部内置，真实适配器及时拒绝',()=>{assert.equal(noDenyResult.status,'unknown');assert.equal(noDenyResult.reason,'TOOL_SET_VIOLATION');assert.equal(noDenyResult.earlyAbort,'TOOL_SET_VIOLATION');const init=fs.readFileSync(path.join(noDenyWork,'native-stream.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(item=>item.subtype==='init');assert.equal(init.tools.length,35);});
 check('无 deny 的对照确实能进入本地模拟 handler，有 deny 时应阻止',()=>{const contract=JSON.parse(fs.readFileSync(path.join(noDenyPrep.workspace.work,'fixture-permission-contract.json'),'utf8'));assert.equal(contract.runtimeChecks.find(item=>item.name==='Read').handlerCalled,true);assert.equal(contract.runtimeChecks.find(item=>item.name==='AskUserQuestion').handlerCalled,false);});
 const prep=await normal.call('prepare_task_workspace',{requestId:request('prep_a'),taskId:'task_a'}),workspace=prep.workspace;
 const args=create('task_a','create_a',{text:'中文随机记忆短句',largeId:true,delayMs:100});
 const simultaneous=await Promise.all([normal.call('create_conversation',args),second.call('create_conversation',args)]);
 const first=simultaneous.find(x=>x.turn.status==='succeeded'),duplicate=simultaneous.find(x=>x.deduplicated);
 check('跨进程占位只启动一次，原始大整数字符串不转换',()=>{assert.ok(first,JSON.stringify(simultaneous));assert.equal(first.conversationId,'900719925474099312345');assert.equal(first.session.idSource,'system.init.session_id');assert.equal(duplicate.externalSideEffectRepeated,false);assert.equal(count(workspace),1);});
 check('实际 cwd、握手、清单和能力调用分别有证据',()=>{assert.equal(first.turn.result.observedCwd,workspace.cwd);assert.equal(first.turn.result.workingDirectoryVerified,true);assert.equal(first.turn.result.mcpCallVerified,true);for(const method of ['initialize','tools/list','tools/call'])assert.ok(first.turn.result.mcpAudit.counts[method]>=1);});
 const runtimeContract=JSON.parse(fs.readFileSync(path.join(workspace.work,'fixture-permission-contract.json'),'utf8'));
 for(const name of CODEBUDDY_BUILTIN_DENY_TOOLS)check(`安装契约样本对 ${name} 的声明与执行 deny`,()=>{assert.ok(runtimeContract.denyRules.includes(name));assert.ok(!runtimeContract.declared.includes(name));const record=runtimeContract.runtimeChecks.find(item=>item.name===name);assert.equal(record.decision,'deny');assert.equal(record.handlerCalled,false);});
 check('fixture 永远 local_test，文件/OS/桌面隔离不冒报',()=>{assert.equal(first.evidenceLevel,'local_test');assert.equal(first.session.runtimeVerified,false);assert.equal(first.turn.modelRequestState,'not_model_local_test');assert.equal(first.turn.result.fileAccessBoundaryVerified,false);assert.equal(first.turn.result.osIsolationVerified,false);assert.equal(first.turn.result.desktopContextVerified,false);assert.equal(first.businessAcceptanceVerified,false);});
 const round2=await normal.call('send_to_conversation',{...binding('task_a',first.conversationId),requestId:request('round2'),prompt:JSON.stringify({text:'第二轮读取上下文',largeId:true})});
 check('同原始编号续接，第一轮上下文保留',()=>{assert.equal(round2.turn.status,'succeeded');assert.equal(round2.conversationId,first.conversationId);assert.match(round2.turn.result.result.result,/中文随机记忆短句.*第二轮/);assert.equal(count(workspace),2);});
 const launches=fs.readFileSync(path.join(workspace.work,'fixture-launches.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
 check('第二轮真实 argv 精确 --resume，空参数保持',()=>{const argv=launches[1].argv;assert.equal(argv[argv.indexOf('--resume')+1],first.conversationId);assert.equal(argv[argv.indexOf('--tools')+1],'');assert.equal(argv.includes('--continue'),false);});
 const read=await production.call('get_conversation_result',binding('task_a',first.conversationId));
 check('关闭生产适配器仍独立读回本任务结果',()=>{assert.equal(read.result.status,'succeeded');assert.equal(read.importedAccountHistory,false);assert.equal(read.runtimeVerified,false);});
 const replay=await production.call('create_conversation',args);
 check('历史幂等回执不需要启用也不再启动',()=>{assert.equal(replay.deduplicated,true);assert.equal(count(workspace),2);});
 await normal.call('create_conversation',create('task_a','again'),'CREATE_ALREADY_CLAIMED');
 await normal.call('send_to_conversation',{...binding('task_a','task_a'),requestId:request('fakeid'),prompt:'错误编号'},'CONVERSATION_BINDING_MISMATCH');
 await normal.call('send_to_conversation',{...binding('task_a',first.conversationId),mode:'desktop',requestId:request('wrongmode'),prompt:'错误模式'},'CONVERSATION_BINDING_MISMATCH');
 const textReady=await normal.call('prepare_task_workspace',{requestId:request('text_prep'),taskId:'text_task'});
 const textOutput=await normal.call('create_conversation',create('text_task','text_create',{text:'只需普通文本回复',scenario:'text_only'}));
 check('无 tool_use 的正常文本轮次成功，实际调用分列为 false',()=>{assert.equal(textOutput.turn.status,'succeeded');assert.equal(textOutput.turn.result.mcpHandshakeVerified,true);assert.equal(textOutput.turn.result.mcpCallVerified,false);assert.equal(textOutput.turn.result.mcpAudit.counts['tools/call'],0);assert.equal(count(textReady.workspace),1);});
 const scenarios={missing_init:'NATIVE_ID_MISSING',numeric_id:'NATIVE_ID_MISSING',missing_cwd:'CWD_MISSING',wrong_cwd:'CWD_MISMATCH',missing_tools:'TOOL_SET_VIOLATION',builtin_tool:'TOOL_SET_VIOLATION',future_builtin:'TOOL_SET_VIOLATION',early_invalid_init:'TOOL_SET_VIOLATION',missing_mcp:'MCP_STATE_UNVERIFIED',extra_mcp:'MCP_STATE_UNVERIFIED',mcp_failed:'MCP_STATE_UNVERIFIED',other_tool:'MCP_TOOL_VIOLATION',tool_arguments:'MCP_TOOL_VIOLATION',claimed_without_call:'MCP_CALL_AUDIT_MISMATCH',missing_audit:'MCP_AUDIT_UNVERIFIED',audit_bad_parent:'MCP_AUDIT_UNVERIFIED',audit_unknown_tool:'MCP_AUDIT_UNVERIFIED',missing_result:'RESULT_MISSING',wrong_id:'NATIVE_ID_MISMATCH',control_request:'INTERACTIVE_CONTROL_REQUIRED',output_limit:'OUTPUT_TRUNCATED',invalid_utf8:'PROTOCOL_INVALID',incomplete_json:'PROTOCOL_INVALID',error_result:'PLATFORM_RESULT_FAILED',nonzero:'PROCESS_EXIT_FAILED',timeout:'TIMEOUT_UNKNOWN'};
 for(const [scenario,reason] of Object.entries(scenarios)){
  const taskId=`case_${scenario}`;const ready=await normal.call('prepare_task_workspace',{requestId:request(`prep_${scenario}`),taskId});
  const output=await normal.call('create_conversation',create(taskId,`create_${scenario}`,{text:'无敏感测试',scenario}));
  check(`失败/未知 ${scenario} 不伪造通过`,()=>{assert.notEqual(output.turn.status,'succeeded');assert.equal(output.turn.result.reason,reason,JSON.stringify(output.turn.result));assert.equal(output.session.runtimeVerified,false);});
  if(scenario==='early_invalid_init')check('非法 init 即终止，不等待样本十秒后续响应',()=>{assert.equal(output.turn.result.earlyAbort,'TOOL_SET_VIOLATION');assert.equal(output.turn.result.timedOut,false);assert.equal(output.turn.result.result,null);});
  await normal.call('create_conversation',create(taskId,`retry_${scenario}`),'CREATE_ALREADY_CLAIMED');
  if(output.conversationId!==null)await normal.call('send_to_conversation',{...binding(taskId,output.conversationId),requestId:request(`send_${scenario}`),prompt:'不能重发'},'CONVERSATION_NOT_READY');
  check('失败记录和一次启动占位保留',()=>assert.equal(count(ready.workspace),1));
 }
 const logs=fs.readFileSync(path.join(first.turn.workDirectory,'native-stream.jsonl'),'utf8')+fs.readFileSync(path.join(first.turn.workDirectory,'stderr.txt'),'utf8');
 check('流/错误中的认证、设备码、嵌套凭据脱敏',()=>{assert.ok(logs.includes('[已脱敏]'));for(const secret of ['fixture_secret','fixture_redaction_value','fixture_bearer','fixture_device_secret','fixture_ticket_secret'])assert.ok(!logs.includes(secret));});
 const control=await production.call('read_conversation',binding('case_control_request',`fixture_native_case_control_request`));
 check('登录/权限控制只记录，不自动完成',()=>{assert.equal(control.turn.result.reason,'INTERACTIVE_CONTROL_REQUIRED');const body=fs.readFileSync(path.join(control.turn.workDirectory,'native-stream.jsonl'),'utf8');assert.ok(!body.includes('example.invalid'));});
 const crash=new Peer('crash',{behavior:'crash_after_claim'});await crash.connect();
 await crash.call('prepare_task_workspace',{requestId:request('crash_prep'),taskId:'crash_task'});
 await assert.rejects(()=>crash.call('create_conversation',create('crash_task','crash_create')));await crash.close();
 const recovered=await production.call('read_conversation',binding('crash_task',null));
 check('owner 退出后跨进程读回 unknown，未启动不自动补发',()=>{assert.equal(recovered.turn.status,'unknown');assert.equal(recovered.turn.result.reason,'OWNER_EXITED');assert.equal(recovered.turn.processStarted,false);});
 const unknownReplay=await production.call('create_conversation',create('crash_task','crash_create'));
 check('崩溃占位历史回执仍保留',()=>assert.equal(unknownReplay.deduplicated,true));
 await normal.call('create_conversation',create('crash_task','crash_new'),'CREATE_ALREADY_CLAIMED');
 const scope=await normal.call('prepare_task_workspace',{requestId:request('scope_prep'),taskId:'scope_task'});
 check('专用审计拒绝其它任务或 inputs 路径',()=>{assert.throws(()=>taskAuditPath(path.join(workspace.work,'bad.jsonl'),scope.workspace.cwd,{mustExist:false}));assert.throws(()=>taskAuditPath(path.join(scope.workspace.inputs,'bad.jsonl'),scope.workspace.cwd,{mustExist:false}));});
 const huge=path.join(scope.workspace.work,'huge.jsonl');fs.writeFileSync(huge,Buffer.alloc(262145));
 check('审计读取本身有上限',()=>assert.throws(()=>readCodeBuddyAudit(huge,{cwd:scope.workspace.cwd,cliPid:process.pid}),error=>error.code==='AUDIT_FILE_INVALID'));
 const plain=path.join(scope.workspace.work,'plain.jsonl'),hard=path.join(scope.workspace.work,'hard.jsonl');fs.writeFileSync(plain,'{}\n');fs.linkSync(plain,hard);
 check('审计拒绝硬链接',()=>assert.throws(()=>taskAuditPath(hard,scope.workspace.cwd),error=>error.code==='AUDIT_FILE_INVALID'));
 const junction=path.join(scope.workspace.work,'junction');fs.symlinkSync(workspace.work,junction,'junction');
 check('审计拒绝跨任务目录联接',()=>assert.throws(()=>taskAuditPath(path.join(junction,'new.jsonl'),scope.workspace.cwd,{mustExist:false}),error=>error.code==='REALPATH_OUTSIDE_SCOPE'));
 const ordinary=path.join(scope.workspace.work,'ordinary'),localLink=path.join(scope.workspace.work,'local-link');fs.mkdirSync(ordinary);fs.symlinkSync(ordinary,localLink,'junction');
 check('审计拒绝同任务目录联接',()=>assert.throws(()=>taskAuditPath(path.join(localLink,'new.jsonl'),scope.workspace.cwd,{mustExist:false}),error=>error.code==='AUDIT_LINK_FORBIDDEN'));
 fs.appendFileSync(path.join(round2.turn.workDirectory,'mcp-audit.jsonl'),'{}\n');
 await production.call('read_conversation',binding('task_a',first.conversationId),'EVIDENCE_TAMPERED');
}catch(error){failure={message:error.message,stack:error.stack};throw error;}
finally{
 for(const peer of peers)await peer.close().catch(()=>{});
 const summary={status:failure?'failed':'passed',source:'local_test',checks:checks.length,items:checks,failure,logDir,actualPlatformExecution:false,accountAccess:false,modelCalls:0};
 fs.writeFileSync(path.join(logDir,'summary.json'),JSON.stringify(summary,null,2),'utf8');console.log(JSON.stringify(summary,null,2));
}
