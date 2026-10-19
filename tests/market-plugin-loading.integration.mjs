import {FIXTURE_ROOT} from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {sha256} from '../bridge/src/policy.mjs';
import {inspectMarketPluginLoading,buildMarketManifestDiagnosticPlan,inspectMarketManifestValidationOutput} from '../bridge/src/market-plugin-inspection.mjs';

const checks=[],check=async(name,fn)=>{await fn();checks.push({name,passed:true});};
let sequence=0,completed=false;
const pins=root=>fs.readdirSync(root,{withFileTypes:true}).flatMap(entry=>{const file=path.join(root,entry.name);return entry.isDirectory()?pins(file).map(pin=>({...pin,relativePath:`${entry.name}/${pin.relativePath}`})):[{relativePath:entry.name,sha256:sha256(fs.readFileSync(file))}];});
function fixture(alias='.codebuddy-plugin',agentExtra=''){
 const root=path.join(FIXTURE_ROOT,'bridge/runtime/private-tools',`loading_${sequence++}`);for(const folder of [alias,'agents','skills/humanizer'])fs.mkdirSync(path.join(root,folder),{recursive:true});
 fs.writeFileSync(path.join(root,alias,'plugin.json'),JSON.stringify({name:'synthetic-expert',version:'1.0.0',agents:['./agents/synthetic-expert.md'],skills:['./skills/humanizer'],expertType:'agent',agentName:'synthetic-expert'}));
 fs.writeFileSync(path.join(root,'agents/synthetic-expert.md'),`---\nname: synthetic-expert\ndescription: 合成专家\n${agentExtra}---\n正文自称自动调用humanizer不算预加载。`);
 fs.writeFileSync(path.join(root,'skills/humanizer/SKILL.md'),'---\nname: humanizer\nallowed-tools:\n  - Read\n  - Write\n---\n合成定义。');
 return{root,pins:()=>pins(root)};
}
try{
 await check('三种官方manifest别名可静态发现，manifest.skills不冒充Agent预加载',()=>{
  for(const alias of ['.codebuddy-plugin','.workbuddy-plugin','.claude-plugin']){
   const item=fixture(alias),observed=inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'});
   assert.equal(observed.manifest.relativePath,`${alias}/plugin.json`);assert.equal(observed.agent.candidateQualifiedName,'synthetic-expert:synthetic-expert');assert.equal(observed.agent.declaredSkills.length,0);assert.equal(observed.skills.length,1);assert.equal(observed.skills[0].candidateQualifiedName,'synthetic-expert:humanizer');
   assert.equal(observed.stages.staticParsed,true);assert.equal(observed.stages.hostCatalogVerified,false);assert.equal(observed.stages.agentSelectedVerified,false);assert.equal(observed.stages.skillBodyInjectedVerified,false);assert.equal(observed.stages.nativeSkillExecutedVerified,false);assert.equal(observed.launchAllowed,false);
  }
 });
 await check('CLI退出0但输出失败或缺close不能记schema成功，明确通过也不升级加载',()=>{
  const manifestPath=path.join(FIXTURE_ROOT,'plugin.json'),capture={stdout:`Validation passed\n${manifestPath}`,stderr:'',exitCode:0,closeCode:0,signal:null,timedOut:false,truncated:false};
  const ok=inspectMarketManifestValidationOutput(capture,{manifestPath});assert.equal(ok.status,'reported_validation_pass');assert.equal(ok.runtimeAgentLoadedVerified,false);assert.equal(ok.originalUnknownResolved,false);assert.equal(ok.launchAllowed,false);
  for(const extra of [{stdout:'Validation failed',exitCode:0},{stderr:'Error: request failed',exitCode:0},{closeCode:null},{signal:'SIGTERM'},{timedOut:true},{truncated:true},{stdout:'Validation passed\nother.json'}])assert.notEqual(inspectMarketManifestValidationOutput({...capture,...extra},{manifestPath}).status,'reported_validation_pass');
 });
 await check('同包别名按官方顺序选中且记录被遮蔽来源，不能跨来源拼装身份',()=>{
  const item=fixture('.workbuddy-plugin');fs.mkdirSync(path.join(item.root,'.codebuddy-plugin'));fs.copyFileSync(path.join(item.root,'.workbuddy-plugin/plugin.json'),path.join(item.root,'.codebuddy-plugin/plugin.json'));
  const result=inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'});assert.equal(result.manifest.relativePath,'.codebuddy-plugin/plugin.json');assert.deepEqual(result.manifest.shadowedAliases,['.workbuddy-plugin']);assert.equal(result.stages.agentSelectedVerified,false);
 });
 await check('Agent显式skills和model/tools只记录声明，根settings.agent覆盖manifest声明而不算应用',()=>{
  const item=fixture('.codebuddy-plugin','skills: humanizer\nmodel: inherit\ntools: Read, Skill\n');const file=path.join(item.root,'.codebuddy-plugin/plugin.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));manifest.settings={agent:'manifest-default'};fs.writeFileSync(file,JSON.stringify(manifest));fs.writeFileSync(path.join(item.root,'settings.json'),JSON.stringify({agent:'root-default'}));
  const result=inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'});assert.deepEqual(result.agent.declaredSkills,['humanizer']);assert.equal(result.agentSkillsPreloadDeclared,true);assert.deepEqual(result.agent.declaredModel,['inherit']);assert.deepEqual(result.agent.declaredTools,['Read','Skill']);assert.equal(result.settings.agent,'root-default');assert.equal(result.settings.appliedToHostVerified,false);assert.equal(result.stages.skillBodyInjectedVerified,false);
 });
 await check('BOM与CRLF原件只读支持，合法但未支持的复杂字段显式列出',()=>{
  const item=fixture(),file=path.join(item.root,'agents/synthetic-expert.md');fs.writeFileSync(file,'\uFEFF---\r\nname: synthetic-expert\r\nskills: [\'humanizer\']\r\n---\r\n合成正文。');
  const result=inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'});assert.equal(result.agent.frontmatterSupported,false);assert.deepEqual(result.agent.unsupported,['skills_flow_syntax']);assert.equal(result.stages.agentSelectedVerified,false);assert.equal(result.platformCompatibility,'runtime_unverified');
 });
 await check('YAML引用、关键字段重复和含逗号工具模式不能被拆成已支持声明',()=>{
  for(const declaration of ['tools: &shared Read\nskills: *shared\n','tools: Read\ntools: Skill\n','tools: Bash(git:*,npm:*)\n','tools: ["Bash(git:*,npm:*)"]\n']){
   const item=fixture('.codebuddy-plugin',declaration),result=inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'});
   assert.equal(result.agent.frontmatterSupported,false);assert.equal(result.agent.declaredTools,null);assert.equal(result.agent.unsupported.length>0,true);assert.equal(result.stages.effectivePermissionsVerified,false);
  }
 });
 await check('不同文件声明同名Agent须显式歧义，不能默认选中第一个',()=>{
  const item=fixture(),custom=path.join(item.root,'custom');fs.mkdirSync(custom);fs.writeFileSync(path.join(custom,'other.md'),'---\nname: synthetic-expert\nskills: humanizer\n---\n另一个同名合成定义。');
  const file=path.join(item.root,'.codebuddy-plugin/plugin.json'),manifest=JSON.parse(fs.readFileSync(file,'utf8'));manifest.agents=['./agents/synthetic-expert.md','./custom/other.md'];fs.writeFileSync(file,JSON.stringify(manifest));
  const result=inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'});assert.equal(result.agent,null);assert.equal(result.agentSelection.ambiguous,true);assert.deepEqual(result.agentSelection.candidatePaths,['agents/synthetic-expert.md','custom/other.md']);assert.equal(result.agentSkillsPreloadDeclared,null);assert.equal(result.stages.agentSelectedVerified,false);
 });
 await check('路径穿越、未pin来源、大小写重复与内容变更不能成为已审组件',()=>{
  const item=fixture(),file=path.join(item.root,'.codebuddy-plugin/plugin.json'),original=JSON.parse(fs.readFileSync(file,'utf8'));
  fs.writeFileSync(file,JSON.stringify({...original,skills:['../outside']}));assert.throws(()=>inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'}),error=>error.code==='MARKET_LOADING_PATH_INVALID');
  fs.writeFileSync(file,JSON.stringify(original));const checked=item.pins();fs.writeFileSync(path.join(item.root,'agents/synthetic-expert.md'),'changed');assert.throws(()=>inspectMarketPluginLoading(item.root,checked,{agentName:'synthetic-expert'}),error=>error.code==='MARKET_LOADING_SOURCE_CHANGED');
  assert.throws(()=>inspectMarketPluginLoading(item.root,item.pins().filter(pin=>!pin.relativePath.endsWith('SKILL.md')),{agentName:'synthetic-expert'}));
  assert.throws(()=>inspectMarketPluginLoading(item.root,[...item.pins(),{...item.pins()[0],relativePath:item.pins()[0].relativePath.toUpperCase()}],{agentName:'synthetic-expert'}),error=>error.code==='MARKET_LOADING_PIN_INVALID');
 });
 await check('只读检查不执行正文/脚本，也不把缺失声明推定必须放开Read或Skill',()=>{
  const item=fixture(),file=path.join(item.root,'agents/synthetic-expert.md');fs.appendFileSync(file,'\n!`synthetic_never_execute`\n');const result=inspectMarketPluginLoading(item.root,item.pins(),{agentName:'synthetic-expert'});assert.equal(result.agent.declaredTools,null);assert.deepEqual(result.agent.declaredModel,[]);assert.equal(result.permissionChangesApplied,false);assert.equal(result.stages.nativeReadExecutedVerified,false);assert.equal(result.stages.nativeSkillExecutedVerified,false);assert.equal(result.launchAllowed,false);
 });
 await check('独立无模型计划不受旧unknown全局阻塞，也不重发旧请求或错误追加root flags',()=>{
  const root=path.join(FIXTURE_ROOT,'task-workspaces/diagnostic/work/synthetic'),scope={root,...Object.fromEntries(['cwd','home','profile','temp','logs'].map(key=>[key,path.join(root,key)]))};
  const input={kind:'manifest_validate',executable:{path:path.join(FIXTURE_ROOT,'node.exe'),sha256:'a'.repeat(64)},entrypoint:{path:path.join(FIXTURE_ROOT,'codebuddy-headless.js'),sha256:'b'.repeat(64)},manifestFile:{path:path.join(FIXTURE_ROOT,'plugin.json'),sha256:'c'.repeat(64)},scope,originalRequestState:'unknown'};
  const observed=buildMarketManifestDiagnosticPlan(input);assert.deepEqual(observed.args,[input.entrypoint.path,'plugin','validate',input.manifestFile.path]);assert.equal(observed.independentOfOriginalUnknown,true);assert.equal(observed.originalUnknownResolved,false);assert.equal(observed.safeToRetryOriginal,false);assert.equal(observed.launchAllowed,false);assert.equal(observed.rootFlagsApplied,false);assert.equal(observed.settingsSourceIsolationVerified,false);assert.equal(observed.modelExecutionAllowed,false);
  for(const replacement of [{kind:'model_run'},{approved:true},{prompt:'run'},{args:['--print','x']},{scope:{...scope,profile:FIXTURE_ROOT}}])assert.throws(()=>buildMarketManifestDiagnosticPlan({...input,...replacement}));
 });
 completed=true;
}finally{const directory=path.join(FIXTURE_ROOT,'logs/plugin-loading-tests');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify({status:completed?'passed':'failed',checks,fixtureRoot:FIXTURE_ROOT,officialCliCalls:0,modelCalls:0},null,2));console.log(JSON.stringify({status:completed?'passed':'failed',checks:checks.length,items:checks,fixtureRoot:FIXTURE_ROOT,officialCliCalls:0,modelCalls:0}));}
