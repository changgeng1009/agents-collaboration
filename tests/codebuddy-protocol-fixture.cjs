const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 独立本地样本，绝不加载官方 CLI、账户或网络。
(async () => {
  const argv = process.argv.slice(2), get = flag => argv[argv.indexOf(flag) + 1];
  const config = JSON.parse(fs.readFileSync(get('--mcp-config'), 'utf8'));
  const mcp = config.mcpServers.t2_candidate;
  const root = mcp?.env?.COLLAB_PROJECT_ROOT;
  const rel = root && path.relative(root, __filename);
  if (mcp?.env?.COLLAB_TEST_MODE !== '1' || !root || !rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('样本只能在隔离测试根运行。');
  if (!argv.includes('--tools') || get('--tools') !== '' || get('--setting-sources') !== '' || get('--permission-mode') !== 'dontAsk' || !argv.includes('--strict-mcp-config')) throw new Error('样本启动权限不符合封闭模式。');
  let text = ''; for await (const bytes of process.stdin) text += bytes.toString('utf8');
  const prompt = JSON.parse(text), cwd = process.cwd();
  // 模拟已读第一方安装契约：声明不按 isEnabled 缩减，精确 deny 则参与声明与调用判断。
  const nativeBuiltins = ['Agent','Read','Write','Edit','Bash','Glob','Grep','PowerShell','EnterPlanMode','ExitPlanMode','TaskCreate','TaskGet','TaskUpdate','TaskList','WebFetch','WebSearch','TaskStop','TaskOutput','Skill','AskUserQuestion','StructuredOutput','ToolSearch','DeferExecuteTool','SendMessage','TeamCreate','TeamDelete','ImageGen','VideoGen','WeChatReply','WeComReply','ListMcpResources','ReadMcpResource','MessageColleague','SpeakInChannel'];
  const denyIndex = argv.indexOf('--disallowedTools'), denyRules = [];
  if (denyIndex >= 0) for (const item of argv.slice(denyIndex+1)) { if (item.startsWith('--')) break; denyRules.push(...item.split(/[ ,]+/).filter(Boolean)); }
  const denied = new Set(denyRules.map(name=>name.toLowerCase()));
  const declared = ['mcp__t2_candidate__get_capabilities',...nativeBuiltins.filter(name=>!denied.has(name.toLowerCase())),...(prompt.scenario==='future_builtin'?['FutureBuiltin']:[])];
  const runtimeChecks = nativeBuiltins.map(name=>{
    // 本地无副作用 handler 验证 deny 优先于模拟可信 allow，及交互工具 dontAsk 特例。
    let handlerCalled=false;const handler=()=>{handlerCalled=true;};
    if(name==='AskUserQuestion'&&get('--permission-mode')==='dontAsk')return{name,decision:'deny',reason:'mode',handlerCalled};
    if(denied.has(name.toLowerCase()))return{name,decision:'deny',reason:'rule',handlerCalled};
    handler();return{name,decision:'allow',reason:'fixture_trusted_allow',handlerCalled};
  });
  fs.writeFileSync(path.join(cwd,'work','fixture-permission-contract.json'),JSON.stringify({source:'local_test',runtimeVerified:false,denyRules,declared,runtimeChecks}),'utf8');
  fs.appendFileSync(path.join(cwd,'work','fixture-launches.jsonl'),JSON.stringify({ source:'local_test', argv, prompt:text, envKeys:Object.keys(process.env) })+'\n','utf8');
  const id = prompt.largeId ? '900719925474099312345' : `fixture_native_${path.basename(cwd)}`;
  if (argv.includes('--resume') && get('--resume') !== id) process.exit(9);
  const stateFile = path.join(cwd,'work','fixture-context.json');
  const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile,'utf8')) : [];
  previous.push(prompt.text ?? '中文样本'); fs.writeFileSync(stateFile,JSON.stringify(previous),'utf8');
  if (prompt.scenario !== 'missing_audit') {
    const bridge = path.dirname(path.dirname(mcp.args[0]));
    const { Client } = await import(pathToFileURL(path.join(bridge,'node_modules','@modelcontextprotocol','sdk','dist','esm','client','index.js')));
    const { StdioClientTransport, getDefaultEnvironment } = await import(pathToFileURL(path.join(bridge,'node_modules','@modelcontextprotocol','sdk','dist','esm','client','stdio.js')));
    const client = new Client({ name:'local_codebuddy_fixture_not_platform', version:'0.1.6' });
    const transport = new StdioClientTransport({ command:mcp.command, args:mcp.args, cwd:mcp.cwd, env:{...getDefaultEnvironment(),...mcp.env}, stderr:'pipe' });
    transport.stderr.on('data',()=>{});
    await client.connect(transport);
    const list = await client.listTools();
    if (list.tools.length !== 1 || list.tools[0].name !== 'get_capabilities') throw new Error('专用服务暴露额外工具。');
    if (!['text_only','claimed_without_call'].includes(prompt.scenario)) {
      const result = await client.callTool({ name:'get_capabilities', arguments:{} });
      if (result.isError || result.structuredContent?.accountQueryEnabled !== false) throw new Error('能力样本调用失败。');
    }
    if (prompt.scenario === 'audit_unknown_tool') await client.callTool({ name:'send_message', arguments:{} }).catch(()=>{});
    await client.close();
    const auditFile = mcp.args[mcp.args.indexOf('--audit-log')+1];
    if (prompt.scenario === 'audit_bad_parent') {
      const records = fs.readFileSync(auditFile,'utf8').trim().split('\n').map(line=>({...JSON.parse(line),parentPid:process.pid+1}));
      fs.writeFileSync(auditFile,records.map(record=>JSON.stringify(record)).join('\n')+'\n','utf8');
    }
  }
  const emit = event=>process.stdout.write(JSON.stringify({...event,fixture_only:true})+'\n');
  const init={type:'system',subtype:'init',uuid:id,session_id:prompt.scenario==='numeric_id'?9007199254740992:id,
    ...(prompt.scenario==='missing_cwd'?{}:{cwd:prompt.scenario==='wrong_cwd'?path.dirname(cwd):cwd}),
    ...(prompt.scenario==='missing_tools'?{}:{tools:['builtin_tool','early_invalid_init'].includes(prompt.scenario)?['Read']:declared}),
    ...(prompt.scenario==='missing_mcp'?{}:{mcp_servers:prompt.scenario==='extra_mcp'?[{name:'t2_candidate',status:'connected'},{name:'other',status:'connected'}]:[{name:'t2_candidate',status:prompt.scenario==='mcp_failed'?'failed':'connected'}]}),__timestamp:new Date().toISOString()};
  if (prompt.scenario !== 'missing_init') {
    emit(init);
    emit({type:'system',subtype:'status',status:null,uuid:'fixture_status',session_id:id,_meta:{source:'local_test'},__timestamp:new Date().toISOString(),_requestId:'fixture_request'});
    emit({type:'file-history-snapshot',messageId:'fixture_snapshot_message',timestamp:new Date().toISOString(),isSnapshotUpdate:false,snapshot:{trackedFileBackups:{}},_meta:{source:'local_test'},__timestamp:new Date().toISOString(),_requestId:'fixture_request'});
    const repeated={...init,__timestamp:new Date(Date.now()+1).toISOString()};
    if(prompt.scenario==='duplicate_id_change')repeated.session_id=id+'_changed';
    if(prompt.scenario==='duplicate_numeric_id')repeated.session_id=9007199254740992;
    if(prompt.scenario==='duplicate_missing_id')delete repeated.session_id;
    if(prompt.scenario==='duplicate_cwd_change')repeated.cwd=path.dirname(cwd);
    if(prompt.scenario==='duplicate_missing_cwd')delete repeated.cwd;
    if(prompt.scenario==='duplicate_tool_change')repeated.tools=[...declared,'Read'];
    if(prompt.scenario==='duplicate_missing_tools')delete repeated.tools;
    if(prompt.scenario==='duplicate_mcp_change')repeated.mcp_servers=[{name:'other',status:'connected'}];
    if(prompt.scenario==='duplicate_mcp_disconnected')repeated.mcp_servers=[{name:'t2_candidate',status:'disconnected'}];
    if(prompt.scenario==='duplicate_missing_mcp')delete repeated.mcp_servers;
    emit(repeated);
  }
  if (prompt.scenario==='control_request') emit({type:'control_request',request:{subtype:'authenticate',authUrl:'https://example.invalid/login?token='+'fixture_secret'}});
  if (prompt.scenario==='early_invalid_init') await new Promise(resolve=>setTimeout(resolve,10000));
  if (prompt.scenario==='timeout') await new Promise(resolve=>setTimeout(resolve,10000));
  if (prompt.delayMs) await new Promise(resolve=>setTimeout(resolve,prompt.delayMs));
  if (prompt.scenario==='output_limit') {process.stdout.write('x'.repeat(20000));process.exit(0);}
  if (prompt.scenario==='invalid_utf8') {process.stdout.write(Buffer.from([255,254,10]));process.exit(0);}
  if (prompt.scenario==='incomplete_json') {process.stdout.write('{"type":"result",');process.exit(0);}
  emit({type:'assistant',session_id:id,message:{content:[{type:'text',text:previous.join(' / ')},...(prompt.scenario==='text_only'?[]:[{type:'tool_use',id:'fixture_tool_call',name:prompt.scenario==='other_tool'?'Bash':'mcp__t2_candidate__get_capabilities',input:prompt.scenario==='tool_arguments'?{path:'outside'}:{}}])]},
    api_key:'sk-'+'fixture_redaction_value',userinfo:{token:'fixture_secret'},credentials:{clientSecret:'fixture_secret'},device_code:'fixture_device_secret',userCode:'fixture_device_secret',
    callback:'https://example.invalid/callback?device_code='+'fixture_device_secret'+'&ticket='+'fixture_ticket_secret'});
  process.stderr.write('token='+'fixture_secret'+' Bearer '+'fixture_bearer'+'\n');
  if (prompt.scenario!=='missing_result') emit({type:'result',subtype:prompt.scenario==='error_result'?'error_during_execution':'success',is_error:prompt.scenario==='error_result',
    session_id:prompt.scenario==='wrong_id'?id+'_other':id,result:previous.join(' / '),usage:{input_tokens:3,output_tokens:5}});
  if (prompt.scenario==='nonzero') process.exit(7);
})().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
