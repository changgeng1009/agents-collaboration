import {FIXTURE_ROOT} from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {observeControlledReadiness} from '../bridge/src/market-controlled-adapter.mjs';
import {readBoundedFile} from '../bridge/src/session-files.mjs';

const pid=7001;
const markers=[
 'Loaded plugin components for content-creator@inline: 1 agent(s), 0 command(s), 5 skill(s), 0 hook(s), 0 MCP server(s), 0 LSP server(s), 0 output style(s)',
 'Settings agent: applied "content-creator" config (instructions/tools) onto default agent "cli"',
 '[PluginRuntime] refresh completed (startup), active=1, changed=true'
];
const ready=markers.map(text=>`[fixture] [pid=${pid}] ${text}`).join('\n')+'\n';
let index=0;
function fixture(text=ready){
 const profile=path.join(FIXTURE_ROOT,'profiles',`log-${++index}`),folder=path.join(profile,'logs','2026-10-23');
 fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'synthetic.log');fs.writeFileSync(file,text);
 return {profile,file};
}
// 在真正的readSync返回后模拟同文件写入，准确覆盖读取与fstat之间的窗口。
function duringFirstRead(file,mutation,operation){
 const identity=fs.statSync(file,{bigint:true}),original=fs.readSync;let changed=false;
 fs.readSync=function(fd,...args){
  const count=original.call(fs,fd,...args),stat=fs.fstatSync(fd,{bigint:true});
  if(!changed&&stat.dev===identity.dev&&stat.ino===identity.ino){changed=true;mutation();}
  return count;
 };
 try{return operation();}finally{fs.readSync=original;}
}
const inspect=subject=>observeControlledReadiness(subject.profile,new Map(),pid);

test('就绪读取接受相同身份和稳定前缀上的合法尾部追加',()=>{
 const subject=fixture(),before=fs.statSync(subject.file,{bigint:true});
 const proof=duringFirstRead(subject.file,()=>fs.appendFileSync(subject.file,'[fixture] harmless appended startup record\n'),()=>inspect(subject));
 const after=fs.statSync(subject.file,{bigint:true});
 assert.equal(before.ino,after.ino);assert.ok(after.size>before.size);
 assert.equal(proof.cliPid,pid);assert.equal(proof.endOffset,Buffer.byteLength(ready));
 assert.equal(proof.readObservation.prefixRechecked,true);assert.equal(proof.readObservation.appendOnlyGrowthObserved,true);
 assert.equal(proof.readObservation.opened.size,String(before.size));assert.equal(proof.readObservation.afterPath.size,String(after.size));
});
test('稳定的完整三条同PID宿主信号给出有界前缀证明',()=>{
 const subject=fixture(),proof=inspect(subject);
 assert.equal(proof.cliPid,pid);assert.equal(proof.providerBodyVerified,false);
 assert.equal(proof.componentLine,1);assert.equal(proof.overlayLine,2);assert.equal(proof.refreshLine,3);
 assert.equal(proof.file,subject.file);
});
test('尾部未完成的refresh行不能提前构成就绪',()=>{
 assert.equal(inspect(fixture(ready.trimEnd())),null);
});
test('完整信号后仍未完成的尾部不进入证明范围',()=>{
 const subject=fixture(ready+'[fixture] partial record'),proof=inspect(subject);
 assert.equal(proof.endOffset,Buffer.byteLength(ready));
});
test('其他PID的完整信号不能构成本PID就绪',()=>{
 assert.equal(inspect(fixture(ready.replaceAll('[pid=7001]','[pid=7002]'))),null);
});
test('读取期间截断仍拒绝',()=>{
 const subject=fixture();assert.throws(()=>duringFirstRead(subject.file,()=>fs.truncateSync(subject.file,8),()=>inspect(subject)),error=>{assert.equal(error.code,'FILE_CHANGED');assert.equal(error.fileReadObservation.file,subject.file);assert.equal(error.fileReadObservation.afterPath.size,'8');return true;});
});
test('读取期间替换为相同字节的新文件仍拒绝',()=>{
 const subject=fixture();assert.throws(()=>duringFirstRead(subject.file,()=>{fs.renameSync(subject.file,subject.file+'.held');fs.writeFileSync(subject.file,ready);},()=>inspect(subject)),error=>['FILE_CHANGED','FILE_REPLACED'].includes(error.code));
});
test('前缀改写同时追加不能伪装成合法增长',()=>{
 const subject=fixture();assert.throws(()=>duringFirstRead(subject.file,()=>fs.writeFileSync(subject.file,'X'+ready.slice(1)+'[fixture] appended\n'),()=>inspect(subject)),error=>error.code==='FILE_CHANGED');
});
test('相同长度的前缀改写仍拒绝',()=>{
 const subject=fixture();assert.throws(()=>duringFirstRead(subject.file,()=>fs.writeFileSync(subject.file,'X'+ready.slice(1)),()=>inspect(subject)),error=>error.code==='FILE_CHANGED');
});
test('日志读取保留2MiB上限',()=>{
 assert.throws(()=>inspect(fixture('x'.repeat(2*1024*1024+1))),error=>error.code==='FILE_TOO_LARGE');
});
test('日志硬链接仍拒绝',()=>{
 const subject=fixture();fs.linkSync(subject.file,subject.file+'.alias');assert.throws(()=>inspect(subject),error=>error.code==='FILE_IDENTITY_INVALID');
});
test('普通固定输入读取继续拒绝合法追加，不放宽通用保护',()=>{
 const subject=fixture();assert.throws(()=>duringFirstRead(subject.file,()=>fs.appendFileSync(subject.file,'append\n'),()=>readBoundedFile(subject.file,2*1024*1024)),error=>{assert.equal(error.code,'FILE_CHANGED');assert.equal(error.fileReadObservation.file,subject.file);assert.ok(BigInt(error.fileReadObservation.afterPath.size)>BigInt(error.fileReadObservation.opened.size));return true;});
});
test('原前缀错误后文件删除且诊断补采失败，仍保留原FILE_CHANGED',()=>{
 const subject=fixture(),identity=fs.statSync(subject.file,{bigint:true}),originalRead=fs.readSync,originalStat=fs.fstatSync;let changed=false;
 fs.readSync=function(fd,...args){const count=originalRead.call(fs,fd,...args),stat=originalStat.call(fs,fd,{bigint:true});if(!changed&&stat.dev===identity.dev&&stat.ino===identity.ino){changed=true;fs.writeFileSync(subject.file,'X'+ready.slice(1)+'append\n');fs.unlinkSync(subject.file);fs.fstatSync=()=>{throw Object.assign(new Error('synthetic metadata failure'),{code:'EIO'});};}return count;};
 try{assert.throws(()=>inspect(subject),error=>{assert.equal(error.code,'FILE_CHANGED');assert.equal(error.fileReadObservation.file,subject.file);assert.equal(error.fileReadObservation.afterDescriptor,null);assert.equal(error.fileReadObservation.afterPath,null);return true;});}finally{fs.readSync=originalRead;fs.fstatSync=originalStat;}
});
test('诊断元数据不随通用错误JSON暴露主机路径，私有调用方仍可显式读取',()=>{
 const subject=fixture();assert.throws(()=>duringFirstRead(subject.file,()=>fs.appendFileSync(subject.file,'append\n'),()=>readBoundedFile(subject.file,2*1024*1024)),error=>{assert.equal(error.fileReadObservation.file,subject.file);assert.equal(Object.getOwnPropertyDescriptor(error,'fileReadObservation').enumerable,false);assert.equal(JSON.stringify(error).includes(FIXTURE_ROOT),false);assert.equal(JSON.stringify(error).includes('fileReadObservation'),false);return true;});
});
