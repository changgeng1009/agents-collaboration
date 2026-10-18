import fs from 'node:fs';
import path from 'node:path';
import {PROJECT_ROOT,fail,sha256} from './policy.mjs';
import {sessionPath,readBoundedFile} from './session-files.mjs';

export const safeLocalDirectoryName=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)&&!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(value);
export function preparedRootIdentity(root){const file=sessionPath(root),stat=fs.statSync(file,{bigint:true});if(!stat.isDirectory())fail('PREPARED_ROOT_INVALID','预备根必须为普通目录。');return{path:file,realPath:fs.realpathSync(file),dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};}
export function verifyPreparedWorkspace(plan,{requireUnbound=false}={}){
 const expected=path.join(PROJECT_ROOT,'task-workspaces',path.basename(plan.root));
 if(plan.root!==expected||!safeLocalDirectoryName(path.basename(plan.root)))fail('PREPARED_ROOT_INVALID','可信预备根必须是本项目task-workspaces直属的安全命名目录。');
 const current=preparedRootIdentity(plan.root);if(!plan.rootIdentity||Object.keys(current).some(key=>current[key]!==plan.rootIdentity[key])||Object.keys(plan.rootIdentity).length!==Object.keys(current).length)fail('PREPARED_ROOT_CHANGED','预备根真实路径或目录身份已变化。');
 const brief=readBoundedFile(path.join(plan.root,'inputs','manager-brief.json'));
 if(brief.sha256!==plan.briefSha256)fail('PREPARED_BRIEF_CHANGED','可信预备输入与审查哈希不符。');
 if(requireUnbound){for(const name of ['.task-binding.json','.os-worker']){const reserved=sessionPath(path.join(plan.root,name),false);if(fs.existsSync(reserved))fail('PREPARED_ROOT_RESERVED','预备根已有绑定或OS意图，不能接管、覆盖或重建。');}}
 return brief;
}
export function reviewPreparedWorkspaces(entries){
 if(!Array.isArray(entries)||entries.length>16)fail('PREPARED_CONFIG_INVALID','预备映射只接受可信启动的有界清单。');
 const result=new Map(),roots=new Set();for(const value of entries){if(!value||Object.keys(value).sort().join(',')!=='briefSha256,groupId,root,rootIdentity,taskId'||![value.groupId,value.taskId].every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))||typeof value.root!=='string'||!path.isAbsolute(value.root)||!/^[a-f0-9]{64}$/.test(value.briefSha256))fail('PREPARED_CONFIG_INVALID','预备映射字段、根或哈希不符合要求。');
  const plan=structuredClone(value),key=`${plan.groupId}:${plan.taskId}`;if(result.has(key)||roots.has(plan.root.toLowerCase()))fail('PREPARED_CONFIG_DUPLICATE','预备任务或根不能重复绑定。');verifyPreparedWorkspace(plan);result.set(key,plan);roots.add(plan.root.toLowerCase());
 }return result;
}
export function copyPreparedBrief(plan,destination){const receipt=verifyPreparedWorkspace(plan);fs.writeFileSync(sessionPath(destination,false),receipt.bytes,{flag:'wx',mode:0o600});if(readBoundedFile(destination).sha256!==sha256(receipt.bytes))fail('PREPARED_INPUT_UNKNOWN','预备输入读回失败，原意图与文件保留。');return{source:'trusted_prepared_input',sha256:receipt.sha256,byteLength:receipt.byteLength};}
