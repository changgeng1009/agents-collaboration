import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, SOURCE_ROOT, fail, sha256, inside } from './policy.mjs';
import { CodeBuddyCliAdapter, normalizeCodeBuddyConfiguration } from './codebuddy-cli-adapter.mjs';
import { sessionPath, readBoundedFile } from './session-files.mjs';

const workerFile=fileURLToPath(new URL('./collaboration-execution-worker.mjs',import.meta.url));
export class CodeBuddyCollaborationProvider{
 constructor({configuration=null,fixtureConfiguration=null}={}){
  if(fixtureConfiguration&&(process.env.COLLAB_TEST_MODE!=='1'||PROJECT_ROOT===SOURCE_ROOT||!inside(PROJECT_ROOT,path.resolve(fixtureConfiguration.cliScript))))fail('PROVIDER_FIXTURE_FORBIDDEN','执行样本只能在隔离测试根显式注入。');
  const file=path.join(PROJECT_ROOT,'bridge','runtime','collaboration-core','codebuddy-provider.local.json');
  this.configuration=normalizeCodeBuddyConfiguration(fixtureConfiguration??configuration??(fs.existsSync(file)?JSON.parse(readBoundedFile(file,16384).bytes.toString('utf8')):{enabled:false,acceptedProductMode:false}));
  this.evidenceLevel=fixtureConfiguration?'local_test':'real_runtime';this.name='codebuddy_independent';
 }
 preflight({member,task,intent,native}){
  if(member.platform==='claude')fail('CLAUDE_PAUSED','Claude 正式执行暂停。');
  if(member.platform==='doubao')fail('DOUBAO_CONTRACT_UNAVAILABLE','豆包正式会话和被动唤醒契约未取得。');
  if(member.platform!=='workbuddy'||member.mode!=='codebuddy_cli')fail('PROVIDER_MODE_UNSUPPORTED','受管模式必须是显式登记的独立 CodeBuddy，不替代桌面或云端。');
  if(intent.operation==='send_to_conversation'&&(!native||native.sourceType!=='controlled_adapter'||(native.evidenceLevel==='local_test'&&this.evidenceLevel!=='local_test')))fail('NATIVE_UNVERIFIED','续接只能使用当前受管模式实际返回的原绑定。');
  if(this.configuration.fileToolsEnabled&&(!task.fileAcl.readers.includes(member.instanceId)||!task.fileAcl.writers.includes(member.instanceId)))fail('FILE_ACL_FORBIDDEN','模型文件工具启用须明确授予当前目标实例读取和输出写入。');
  const adapter=new CodeBuddyCliAdapter(this.configuration);adapter.evidenceLevel=this.evidenceLevel;
  const plan=adapter.prepare(task.workspace.cwd,intent.operation==='send_to_conversation'?native.nativeId:null,{turnId:intent.executionId});
  return{timeoutMs:plan.timeoutMs,evidenceLevel:this.evidenceLevel,env:plan.env,configuration:this.configuration,workerScriptHash:sha256(fs.readFileSync(workerFile))};
 }
 async dispatch({store,intent,token,plan,task}){
  const directory=sessionPath(path.join(task.workspace.work,'collaboration-execution',intent.executionId),false);fs.mkdirSync(directory,{recursive:true});
  const configurationFile=path.join(directory,'runner-config.json'),configurationBytes=Buffer.from(JSON.stringify(plan.configuration));fs.writeFileSync(configurationFile,configurationBytes,{flag:'wx',mode:0o600});
  const outputFile=path.join(directory,'worker-output.txt'),fd=fs.openSync(outputFile,'wx',0o600);
  store.tx(()=>{const current=store.get('execution',intent.executionId);current.state='worker_starting';current.workerScriptHash=plan.workerScriptHash;current.configurationHash=sha256(configurationBytes);current.configurationFile=configurationFile;store.put('execution',current.executionId,current);});
  let child;
  try{
   child=fork(workerFile,['--db',store.dbPath,'--execution-id',intent.executionId,'--configuration',configurationFile],{execPath:process.execPath,execArgv:[],cwd:task.workspace.cwd,env:{...plan.env,COLLAB_PROJECT_ROOT:PROJECT_ROOT,...(this.evidenceLevel==='local_test'?{COLLAB_TEST_MODE:'1'}:{})},detached:true,windowsHide:true,stdio:['ignore',fd,fd,'ipc']});
   await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(new Error('执行器交接未知。'),{code:'WORKER_HANDOFF_UNKNOWN'})),5000);
    const done=()=>{clearTimeout(timer);resolve();};
    child.once('spawn',()=>{try{store.tx(()=>{const current=store.get('execution',intent.executionId);current.workerPid=child.pid;current.workerStarted=true;store.put('execution',current.executionId,current);store.event({instanceId:'infrastructure_provider',kind:'trusted_provider'},'worker_started',intent.groupId,{executionId:intent.executionId,onBehalfOf:intent.targetId});});child.send({token});}catch(error){clearTimeout(timer);child.kill();reject(error);}});
    child.once('message',message=>message?.ready===true?done():reject(new Error('执行器未确认租约。')));child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('exit',done);
   });
  }finally{if(child?.connected)child.disconnect();child?.unref();fs.closeSync(fd);}
  return{reference:{executionId:intent.executionId},state:store.get('execution',intent.executionId).state,evidenceLevel:this.evidenceLevel};
 }
 read({store,reference,task,member}){const intent=store.get('execution',reference.executionId);if(!task||!member||intent.groupId!==task.groupId||intent.taskId!==task.taskId||intent.targetId!==member.instanceId)fail('PROVIDER_SCOPE_MISMATCH','执行引用必须与原组、任务和目标实例一致。');return{reference,state:intent.state,evidenceLevel:intent.evidenceLevel,workerStarted:intent.workerStarted===true,platformProcessStarted:intent.platformProcessStarted===true};}
}
