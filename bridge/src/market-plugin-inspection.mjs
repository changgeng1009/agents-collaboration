import fs from 'node:fs';
import path from 'node:path';
import {fail,inside} from './policy.mjs';
import {readBoundedFile,sessionPath} from './session-files.mjs';

const aliases=['.codebuddy-plugin','.workbuddy-plugin','.claude-plugin'];
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nameValid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
function relative(value){
 if(typeof value!=='string'||value.length>240||value.includes(':')||path.isAbsolute(value))fail('MARKET_LOADING_PATH_INVALID','组件必须为原包内有界相对路径。');
 const normalized=value.replaceAll('\\','/').replace(/^\.\//,'').replace(/\/$/,'');
 if(!normalized||normalized.split('/').some(part=>!part||part==='.'||part==='..'))fail('MARKET_LOADING_PATH_INVALID','组件路径含父级或别名。');return normalized;
}
function fields(text){
 const body=/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
 if(body===undefined)return{supported:false,values:{},unsupported:['frontmatter_missing']};
 const values={},unsupported=[];
 // 仅实现明确的小型声明子集；不能猜测YAML引用、合并或重复字段的含义。
 if(/(?:^|[\s:[{,])[&*][A-Za-z0-9_-]+|^[ \t]*<<[ \t]*:/m.test(body))return{supported:false,values,unsupported:['yaml_reference_or_merge']};
 for(const key of ['name','model','tools','disallowedTools','skills']){
  if([...body.matchAll(new RegExp(`^${key}:`,'gm'))].length>1){unsupported.push(`${key}_duplicate`);continue;}
  const match=new RegExp(`^${key}:[ \\t]*([^\\r\\n]*)(?:\\r?\\n((?:[ \\t]+-[^\\r\\n]*(?:\\r?\\n|$))*))?`,'m').exec(body);if(!match)continue;
  const raw=match[1].trim();
  if(raw.startsWith('[')){try{const list=JSON.parse(raw);if(!Array.isArray(list)||list.some(item=>typeof item!=='string'))throw Error();if(list.some(item=>!/^\*?$|^[A-Za-z0-9_:.\/-]+$/.test(item))){unsupported.push(`${key}_value_syntax`);continue;}values[key]=list;}catch{unsupported.push(`${key}_flow_syntax`);}continue;}
  if(raw.startsWith('{')||raw==='|'||raw==='>'){unsupported.push(`${key}_complex_syntax`);continue;}
  if(/[()[\]{}#&*!|>]/.test(raw)){unsupported.push(`${key}_value_syntax`);continue;}
  const items=raw?raw.split(','):match[2]?.split(/\r?\n/).map(line=>line.replace(/^[ \t]+-[ \t]*/,''))??[];
  const normalized=items.map(item=>item.trim().replace(/^(['"])(.*)\1$/,'$2')).filter(Boolean);
  if(normalized.some(item=>!/^\*?$|^[A-Za-z0-9_:.\/-]+$/.test(item))||(['name','model'].includes(key)&&normalized.length!==1)){unsupported.push(`${key}_value_syntax`);continue;}
  values[key]=normalized;
 }
 return{supported:unsupported.length===0,values,unsupported};
}

// 仅记录宿主可解析的原件来源；不是官方catalog、主Agent选择或模型输入证据。
// 使用已审pin清单，不执行原件正文、脚本、Hook或SDK。
export function inspectMarketPluginLoading(pluginRoot,pluginPins,{agentName}={}){
 if(typeof pluginRoot!=='string'||!path.isAbsolute(pluginRoot)||!Array.isArray(pluginPins)||!pluginPins.length||pluginPins.length>8192||!nameValid(agentName))fail('MARKET_LOADING_INPUT_INVALID','须给已审插件根、文件pin和原Agent技术名。');
 sessionPath(pluginRoot);const pins=new Map();
 for(const pin of pluginPins){if(!plain(pin)||!/^[a-f0-9]{64}$/.test(pin.sha256??''))fail('MARKET_LOADING_PIN_INVALID','插件文件须有固定SHA。');const name=relative(pin.relativePath),key=name.toLowerCase();if(pins.has(key))fail('MARKET_LOADING_PIN_INVALID','插件pin不能重名或大小写歧义。');pins.set(key,{relativePath:name,sha256:pin.sha256});}
 const read=name=>{const key=relative(name),pin=pins.get(key.toLowerCase());if(!pin)fail('MARKET_LOADING_FILE_UNPINNED','组件文件未在可信清单。');const file=path.join(pluginRoot,...pin.relativePath.split('/')),value=readBoundedFile(file,256*1024);if(value.sha256!==pin.sha256)fail('MARKET_LOADING_SOURCE_CHANGED','原插件组件内容已变化。');let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(value.bytes);}catch{fail('MARKET_LOADING_UTF8_INVALID','组件须为有效UTF-8。');}return{relativePath:pin.relativePath,sha256:pin.sha256,byteLength:value.byteLength,text};};
 const present=aliases.filter(alias=>fs.existsSync(sessionPath(path.join(pluginRoot,alias,'plugin.json'),false)));
 if(!present.length)fail('MARKET_LOADING_MANIFEST_REQUIRED','此原件检查入口需要已审manifest，不把可省略清单的官方插件判为平台不兼容。');
 const selected=read(`${present[0]}/plugin.json`);let manifest;try{manifest=JSON.parse(selected.text);}catch{fail('MARKET_LOADING_JSON_INVALID','原manifest不是有效JSON。');}
 if(!plain(manifest)||!nameValid(manifest.name))fail('MARKET_LOADING_MANIFEST_INVALID','原manifest名称无效。');
 const unsupported=[];
 function componentPaths(value,defaults,suffix){
  if(value===undefined)return defaults;
  if(typeof value!=='string'&&!Array.isArray(value)){unsupported.push(`${suffix}_declaration_type`);return[];}
  const paths=[];
  for(const item of typeof value==='string'?[value]:value){
   if(typeof item!=='string'){unsupported.push(`${suffix}_declaration_type`);continue;}
   const name=relative(item);
   if(name.endsWith('.md'))paths.push(name);
   else{const matches=[...pins.values()].map(pin=>pin.relativePath).filter(file=>file.startsWith(`${name}/`)&&(suffix==='agents'?file.endsWith('.md'):file.endsWith('/SKILL.md')));if(matches.length)paths.push(...matches);else{if(suffix==='skills'&&fs.existsSync(sessionPath(path.join(pluginRoot,name,'SKILL.md'),false)))fail('MARKET_LOADING_FILE_UNPINNED','已存在的声明Skill定义未在可信清单。');unsupported.push(`${suffix}_directory_without_pinned_definitions`);}}
  }
  return[...new Set(paths)];
 }
 const defaultAgents=[...pins.values()].map(pin=>pin.relativePath).filter(name=>/^agents\/[^/]+\.md$/.test(name));
 // 固定安装仍补扫默认agents目录；只读合并去重，不能由目录名推定主Agent已选中。
 const agentPaths=[...new Set([...defaultAgents,...componentPaths(manifest.agents,[], 'agents')])];
 const agents=agentPaths.map(name=>{const file=read(name),parsed=fields(file.text),staticName=parsed.values.name?.[0]??path.basename(name,'.md');if(!nameValid(staticName))unsupported.push('agent_name_unsupported');return{relativePath:file.relativePath,sha256:file.sha256,byteLength:file.byteLength,staticName,candidateQualifiedName:`${manifest.name}:${staticName}`,declaredModel:parsed.values.model??[],declaredTools:parsed.values.tools??null,declaredDenyTools:parsed.values.disallowedTools??[],declaredSkills:parsed.values.skills??[],frontmatterSupported:parsed.supported,unsupported:parsed.unsupported};});
 const agentCandidates=agents.filter(agent=>agent.staticName===agentName),selectedAgent=agentCandidates.length===1?agentCandidates[0]:null;
 const defaultSkills=[...pins.values()].map(pin=>pin.relativePath).filter(name=>/^skills\/[^/]+\/SKILL\.md$/.test(name));
 const skillPaths=componentPaths(manifest.skills,defaultSkills,'skills');
 const skills=skillPaths.map(name=>{const file=read(name),parsed=fields(file.text),staticName=parsed.values.name?.[0]??path.basename(path.dirname(name));return{relativePath:file.relativePath,sha256:file.sha256,byteLength:file.byteLength,staticName,candidateQualifiedName:`${manifest.name}:${staticName}`,definitionReadByInspector:true,bodyInjectedVerified:false,nativeExecutedVerified:false,frontmatterSupported:parsed.supported,unsupported:parsed.unsupported};});
 let settingsAgent=typeof manifest.settings?.agent==='string'?manifest.settings.agent:null,settingsSource=settingsAgent?'manifest.settings':null;
 if(fs.existsSync(sessionPath(path.join(pluginRoot,'settings.json'),false))){const file=read('settings.json');let settings;try{settings=JSON.parse(file.text);}catch{fail('MARKET_LOADING_JSON_INVALID','原插件settings不是有效JSON。');}if(typeof settings.agent==='string'){settingsAgent=settings.agent;settingsSource='settings.json';}}
 return{evidence:'pinned_files_static_inspection',manifest:{relativePath:selected.relativePath,sha256:selected.sha256,byteLength:selected.byteLength,name:manifest.name,version:manifest.version??null,aliasesPresent:present,shadowedAliases:present.slice(1)},settings:{agent:settingsAgent,source:settingsSource,appliedToHostVerified:false},agent:selectedAgent,agentSelection:{requestedName:agentName,candidatePaths:agentCandidates.map(agent=>agent.relativePath),ambiguous:agentCandidates.length>1},agents,skills,unsupported,
  stages:{staticParsed:true,hostCatalogVerified:false,agentSelectedVerified:false,agentBodyInjectedVerified:false,skillBodyInjectedVerified:false,effectivePermissionsVerified:false,nativeReadExecutedVerified:false,nativeSkillExecutedVerified:false,modelExecutionVerified:false},
  agentSkillsPreloadDeclared:selectedAgent?selectedAgent.declaredSkills.length>0:null,manifestSkillsAreAgentPreloads:false,completePackageInventoryVerified:false,platformCompatibility:'runtime_unverified',launchAllowed:false,permissionChangesApplied:false,originalUnknownResolved:false,safeToRetry:false};
}

// 固定版本validate叶parser会再次解析完整argv，不接收root flags。
// 只生成待审的裸子命令；环境/初始化边界另核，绝不自动降级为真实运行。
export function buildMarketManifestDiagnosticPlan(config){
 const exact=(value,keys)=>plain(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
 const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.resolve(value)===value&&!value.startsWith(path.sep.repeat(2))&&!value.slice(path.parse(value).root.length).includes(':');
 if(!exact(config,['kind','executable','entrypoint','manifestFile','scope','originalRequestState'])||config.kind!=='manifest_validate')fail('MARKET_DIAGNOSTIC_KIND_FORBIDDEN','仅能准备独立manifest校验计划，不能注入prompt、argv或运行批准。');
 for(const value of [config.executable,config.entrypoint,config.manifestFile])if(!exact(value,['path','sha256'])||!absolute(value.path)||!/^[a-f0-9]{64}$/.test(value.sha256))fail('MARKET_DIAGNOSTIC_PIN_INVALID','计划须固定可执行文件、入口及原manifest来源。');
 if(path.basename(config.entrypoint.path)!=='codebuddy-headless.js'||path.basename(config.manifestFile.path)!=='plugin.json'||!['unknown','unverified','failed','succeeded'].includes(config.originalRequestState))fail('MARKET_DIAGNOSTIC_INPUT_INVALID','诊断入口或原请求状态不符合范围。');
 const scope=config.scope;if(!exact(scope,['root','cwd','home','profile','temp','logs'])||Object.values(scope).some(value=>!absolute(value))||Object.entries(scope).some(([key,value])=>key!=='root'&&(value===scope.root||!inside(scope.root,value)))||new Set(Object.values(scope).map(value=>process.platform==='win32'?value.toLowerCase():value)).size!==6)fail('MARKET_DIAGNOSTIC_SCOPE_INVALID','新诊断目录须各自独立且全部位于可信新根。');
 return{kind:'manifest_validate',evidence:'offline_review_plan_only',executable:{...config.executable},entrypoint:{...config.entrypoint},manifestFile:{...config.manifestFile},scope:{...scope},args:[config.entrypoint.path,'plugin','validate',config.manifestFile.path],
  requiredChildEnvironment:{CODEBUDDY_CONFIG_DIR:scope.profile,USERPROFILE:scope.home,TEMP:scope.temp,TMP:scope.temp,CODEBUDDY_CREDENTIALS_IN_MEMORY:'1',CODEBUDDY_SESSION_HISTORY_CLEANUP:'0',CBC_ENABLE_FUNCTION_HOOKS:'0',CODEBUDDY_PLUGIN_BACKGROUND_MANAGEMENT:'0'},
  rootFlagsApplied:false,settingsSourceIsolationVerified:false,mcpIsolationVerified:false,credentialBootstrapIsolationVerified:false,osIsolationVerified:false,
  diagnosticCanBeReviewed:true,independentOfOriginalUnknown:true,originalRequestState:config.originalRequestState,originalUnknownResolved:false,safeToRetryOriginal:false,launchAllowed:false,modelExecutionAllowed:false,
  blockers:['EXACT_MANAGER_REVIEW_REQUIRED','CHILD_ENVIRONMENT_AND_INITIALIZATION_REVIEW_REQUIRED','BARE_COMMAND_HAS_NO_ROOT_FLAGS'],maxAttempts:1,timeoutMs:30000,maxStdoutBytes:512*1024,maxStderrBytes:512*1024};
}

// 只分析捕获的文本与生命周期；输出自称通过仍不是可信宿主装载/执行回执。
export function inspectMarketManifestValidationOutput(capture,{manifestPath}={}){
 if(!plain(capture)||typeof manifestPath!=='string'||!path.isAbsolute(manifestPath)||typeof capture.stdout!=='string'||typeof capture.stderr!=='string'||Buffer.byteLength(capture.stdout)>512*1024||Buffer.byteLength(capture.stderr)>512*1024)fail('MARKET_DIAGNOSTIC_OUTPUT_INVALID','只接受有界校验输出及固定manifest路径。');
 const errorReported=/Validation failed|ManifestValidationError|Request failed|Error:|ERR_|unknown option|Unhandled/i.test(`${capture.stdout}\n${capture.stderr}`);
 const explicitPass=/Validation passed/i.test(capture.stdout)&&capture.stdout.includes(manifestPath);
 const lifecycleComplete=capture.exitCode===0&&capture.closeCode===0&&capture.signal===null&&capture.timedOut===false&&capture.truncated===false;
 return{evidence:'captured_output_analysis_only',status:errorReported?'reported_validation_failure':explicitPass&&lifecycleComplete?'reported_validation_pass':'unknown',errorReported,explicitPass,lifecycleComplete,
  actualCliLaunchVerified:false,runtimeAgentLoadedVerified:false,runtimeSkillLoadedVerified:false,modelExecutionVerified:false,originalUnknownResolved:false,safeToRetryOriginal:false,launchAllowed:false};
}
