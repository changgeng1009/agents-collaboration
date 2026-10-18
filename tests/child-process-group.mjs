import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

// 仅供离线测试：结果回执、进程退出和stdio关闭分别记录，配置及凭据不写入日志。
export async function runChildProcessGroup({script,configurations,cwd,directory,label,timeoutMs=20000}){
 if(!/^[a-z][a-z0-9-]{0,63}$/.test(label)||!Array.isArray(configurations)||!configurations.length||configurations.length>4||!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>30000)throw new Error('无效的合成进程组配置。');
 fs.mkdirSync(directory,{recursive:true});
 const states=[],startedAt=Date.now();let firstError=null,rejectFailure,timer,timerCleared=false,cleanupTimer,cleanupTimerCleared=true,cleanupUnconfirmed=false;
 const failure=new Promise((_,reject)=>{rejectFailure=reject;});void failure.catch(()=>{});
 const fail=(code,message)=>{if(!firstError){firstError=Object.assign(new Error(message),{code});rejectFailure(firstError);}};
 const send=(state,message)=>{try{state.child.send(message,error=>{if(error)fail('CHILD_SEND_FAILED','合成子进程IPC发送失败。');});}catch{fail('CHILD_SEND_FAILED','合成子进程IPC发送失败。');}};
 try{
  timer=setTimeout(()=>fail('CHILD_GROUP_TIMEOUT','合成进程组等待结果及正常关闭超时。'),timeoutMs);
  for(const [index,configuration] of configurations.entries()){
   let readyResolve,closeResolve;const state={index,pid:null,ready:false,started:false,result:null,resultAt:null,exitObserved:false,exitCode:null,exitSignal:null,exitedAt:null,closeObserved:false,closeCode:null,closeSignal:null,closedAt:null,killRequested:false,killAccepted:null,stderrPath:path.join(directory,`${label}-${index}.stderr.txt`)};
   state.readyPromise=new Promise(resolve=>{readyResolve=resolve;});state.closePromise=new Promise(resolve=>{closeResolve=resolve;});states.push(state);
   const fd=fs.openSync(state.stderrPath,'wx');
   try{state.child=spawn(process.execPath,['--input-type=module','-e',script],{cwd,env:process.env,windowsHide:true,stdio:['ignore','ignore',fd,'ipc']});}catch{readyResolve();closeResolve();fail('CHILD_SPAWN_FAILED','合成子进程启动失败。');break;}finally{fs.closeSync(fd);}
   const child=state.child;state.pid=child.pid??null;
   child.on('message',message=>{
    if(message?.ready===true&&!state.ready&&!state.started){state.ready=true;state.readyAt=Date.now();readyResolve();return;}
    if(state.ready&&state.started&&!state.result&&typeof message?.ok==='boolean'&&(message.code===undefined||/^[A-Z_]+$/.test(message.code))){state.result={ok:message.ok,...(message.code?{code:message.code}:{})};state.resultAt=Date.now();return;}
    fail('CHILD_PROTOCOL_INVALID','合成子进程回执重复、顺序或字段不符合协议。');
   });
   child.once('error',()=>fail('CHILD_SPAWN_FAILED','合成子进程发生启动或进程错误。'));
   child.once('exit',(code,signal)=>{state.exitObserved=true;state.exitCode=code;state.exitSignal=signal;state.exitedAt=Date.now();readyResolve();if(code!==0||signal!==null)fail('CHILD_EXIT_FAILED','合成子进程未正常退出，已有结果回执不能覆盖退出失败。');});
   child.once('close',(code,signal)=>{state.closeObserved=true;state.closeCode=code;state.closeSignal=signal;state.closedAt=Date.now();readyResolve();closeResolve();if(code!==0||signal!==null||!state.exitObserved)fail('CHILD_EXIT_FAILED','合成子进程关闭失败或缺少退出证据。');else if(!state.ready||!state.started||!state.result)fail('CHILD_PROTOCOL_INCOMPLETE','合成子进程关闭前缺少就绪或结果回执。');});
   send(state,configuration);
  }
  await Promise.race([Promise.all(states.map(state=>state.readyPromise)),failure]);if(firstError)throw firstError;
  for(const state of states){state.started=true;state.startSentAt=Date.now();send(state,{start:true});}
  await Promise.race([Promise.all(states.map(state=>state.closePromise)),failure]);if(firstError)throw firstError;
 }catch(error){firstError??=error;}
 finally{
  clearTimeout(timer);timerCleared=true;
  if(firstError){
   for(const state of states){const child=state.child;if(child&&!state.exitObserved&&!state.closeObserved&&child.exitCode===null&&child.signalCode===null){state.killRequested=true;state.killRequestedAt=Date.now();try{state.killAccepted=child.kill();}catch{state.killAccepted=false;}}}
   const closed=Promise.all(states.map(state=>state.closePromise));
   cleanupTimerCleared=false;try{await Promise.race([closed,new Promise(resolve=>{cleanupTimer=setTimeout(()=>{cleanupUnconfirmed=true;resolve();},5000);})]);}finally{clearTimeout(cleanupTimer);cleanupTimerCleared=true;}
  }
 }
 const children=states.map(({child,readyPromise,closePromise,...state})=>state),allClosed=children.every(state=>state.closeObserved),allExitedNormally=children.every(state=>state.exitObserved&&state.exitCode===0&&state.exitSignal===null&&state.closeCode===0&&state.closeSignal===null);
 if(!firstError&&(!allClosed||!allExitedNormally||children.some(state=>!state.result||state.killRequested)))firstError=Object.assign(new Error('合成进程组缺少完整正常退出证据。'),{code:'CHILD_LIFECYCLE_INCOMPLETE'});
 const report={status:firstError?'failed':'completed',startedAt,completedAt:Date.now(),timeoutMs,timerCleared,cleanupTimerCleared,cleanupUnconfirmed,allClosed,allExitedNormally,children,error:firstError?{code:firstError.code??'CHILD_GROUP_FAILED',message:firstError.message}:null,configurationOrCredentialsLogged:false};
 const reportPath=path.join(directory,`${label}-lifecycle.json`);fs.writeFileSync(reportPath,JSON.stringify(report,null,2),{flag:'wx'});
 if(firstError)throw Object.assign(firstError,{lifecycle:report,reportPath});return{results:children.map(state=>state.result),lifecycle:report,reportPath};
}
