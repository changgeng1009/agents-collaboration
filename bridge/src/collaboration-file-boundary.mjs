import fs from 'node:fs';
import path from 'node:path';
import {fail} from './policy.mjs';
import {SessionFiles,sessionPath} from './session-files.mjs';

// 选择边界必须检查持久准备意图，不能因重启丢失内存backend而降级。
// .os-worker在任何profile/ACL副作用前独占创建；成功、失败及unknown均保留。
export function operateTaskFile(store,task,operation,args,{manager=false}={}){
 if(!['read','write'].includes(operation))fail('FILE_OPERATION_INVALID','仅允许固定的有界文件读写。');
 if(store.fileWorker)return store.fileWorker[operation](task,args);
 const intent=sessionPath(path.join(task.workspace.cwd,'.os-worker'),false);
 let reserved=false;
 try{fs.lstatSync(intent);reserved=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(reserved)fail('FILE_OS_BACKEND_REQUIRED','任务已有持久OS准备意图，当前启动没有可信OS backend；保留原状态，不回退普通文件进程。');
 return new SessionFiles({workspace:task.workspace,scope:task.scope,manager})[operation](args);
}
