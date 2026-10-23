import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { CollaborationStore } from './collaboration-store.mjs';
import { assertExecutionLease, updateExecutionFromProvider } from './collaboration-execution.mjs';
import { CodeBuddyCliAdapter } from './codebuddy-cli-adapter.mjs';
import { sessionPath, readBoundedFile } from './session-files.mjs';
import { PROJECT_ROOT, SOURCE_ROOT, inside, sha256 } from './policy.mjs';
import { restoreExecutionFileBackend } from './windows-task-file-configuration.mjs';

if(!process.send)throw new Error('受管执行只接受本项目新建 IPC 子进程。');
const{values}=parseArgs({options:{db:{type:'string'},'execution-id':{type:'string'},configuration:{type:'string'}}});
const store=new CollaborationStore({dbPath:values.db});
const inputTimer=setTimeout(()=>{store.close();process.exit(2);},7000);
process.once('message',async message=>{
 clearTimeout(inputTimer);const token=message?.token;
 try{
  const context=assertExecutionLease(store,values['execution-id'],token,{workerOnly:true}),intent=context.intent;
  const configurationBytes=readBoundedFile(values.configuration,16384).bytes;
  if(sha256(configurationBytes)!==intent.configurationHash||values.configuration!==intent.configurationFile||sha256(fs.readFileSync(fileURLToPath(import.meta.url)))!==intent.workerScriptHash)throw new Error('受管执行源码或配置 pin 已变化。');
  const configuration=JSON.parse(configurationBytes.toString('utf8'));
  if(intent.evidenceLevel==='local_test'&&(process.env.COLLAB_TEST_MODE!=='1'||PROJECT_ROOT===SOURCE_ROOT||!inside(PROJECT_ROOT,path.resolve(configuration.cliScript))))throw new Error('测试不能执行官方入口。');
  restoreExecutionFileBackend(store,context);
  const fileService=fileURLToPath(new URL('./collaboration-file-server.mjs',import.meta.url));
  class GroupCodeBuddyAdapter extends CodeBuddyCliAdapter{
   prepare(...args){const plan=super.prepare(...args);if(plan.fileToolsEnabled){plan.probeScript=fileService;plan.probeSha256=sha256(fs.readFileSync(fileService));plan.mcpConfiguration.mcpServers.t2_candidate.args[0]=fileService;plan.fileBinding={workspace:context.task.workspace,scope:context.task.scope,collaboration:{dbPath:store.dbPath,executionId:intent.executionId,token}};}return plan;}
  }
  const adapter=new GroupCodeBuddyAdapter(configuration);adapter.evidenceLevel=intent.evidenceLevel;
  updateExecutionFromProvider(store,intent.executionId,token,'worker_ready');process.send?.({ready:true});
  const plan=adapter.prepare(context.task.workspace.cwd,intent.operation==='send_to_conversation'?context.native.nativeId:null,{turnId:intent.executionId});
  const inputDirectory=sessionPath(path.join(context.task.workspace.inputs,'session-control',intent.executionId),false),workDirectory=sessionPath(path.join(context.task.workspace.work,'session-control',intent.executionId),false),outputDirectory=sessionPath(path.join(context.task.workspace.outputs,'session-control',intent.executionId),false);
  for(const directory of[inputDirectory,workDirectory,outputDirectory])fs.mkdirSync(directory,{recursive:true});
  fs.writeFileSync(path.join(inputDirectory,'prompt.txt'),intent.prompt,{flag:'wx',mode:0o600});
  const result=await adapter.run({plan,prompt:intent.prompt,inputDirectory,workDirectory,onLaunchAttempt:()=>updateExecutionFromProvider(store,intent.executionId,token,'wake_attempting'),onSpawn:pid=>updateExecutionFromProvider(store,intent.executionId,token,'platform_running',{pid})});
  assertExecutionLease(store,intent.executionId,token,{workerOnly:true});
  const resultFile=path.join(outputDirectory,'captured-result.json');fs.writeFileSync(resultFile,JSON.stringify(result,null,2),{flag:'wx',mode:0o600});const receiptHash=readBoundedFile(resultFile,16*1024*1024).sha256;
  updateExecutionFromProvider(store,intent.executionId,token,result.status,{result,receiptHash,evidenceLevel:adapter.evidenceLevel});
 }catch{
  try{store.tx(()=>{const current=store.get('execution',values['execution-id']);if(current.workerPid===process.pid&&!['succeeded','failed','unknown'].includes(current.state)){current.state='unknown';current.blocker={code:'CONTROLLED_EXECUTION_UNKNOWN',message:'受管执行中断或绑定变化，保留原占位与文件。'};store.put('execution',current.executionId,current);}});}catch{}
  process.exitCode=1;
 }finally{store.close();if(process.connected)process.disconnect();}
});
