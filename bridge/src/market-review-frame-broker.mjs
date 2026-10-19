import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inflateSync} from 'node:zlib';
import {PROJECT_ROOT,fail,sha256} from './policy.mjs';
import {sessionPath,readBoundedFile} from './session-files.mjs';
import {preparedRootIdentity} from './collaboration-workspaces.mjs';
import {evaluateMarketReviewPretool} from './market-pretool-policy.mjs';

const FRAME_LIMIT=512*1024,TOTAL_LIMIT=3*1024*1024;
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fileIdentity=stat=>Object.fromEntries(['dev','ino','birthtimeNs','mtimeNs','ctimeNs','size'].map(key=>[key,String(stat[key])]));
function ordinary(stat){if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1n)fail('REVIEW_FILE_IDENTITY','评审帧必须为单硬链接普通文件。');if(stat.size<57n||stat.size>BigInt(FRAME_LIMIT))fail('REVIEW_FILE_SIZE','PNG文件超过固定大小范围。');}
function parentPaths(root){const paths=[PROJECT_ROOT];let cursor=PROJECT_ROOT;for(const part of path.relative(PROJECT_ROOT,sessionPath(root)).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);paths.push(cursor);}return paths;}
function directories(root){return parentPaths(root).map(file=>{if(fs.lstatSync(file).isSymbolicLink())fail('REVIEW_DIRECTORY_CHANGED','评审目录不能是链接。');if(fs.existsSync(path.join(file,'.os-worker')))fail('REVIEW_OS_BOUNDARY_UNSUPPORTED','已有OS worker意图，不回退宿主PNG读取。');return preparedRootIdentity(file);});}
function rejectReparse(paths){
 if(process.platform!=='win32')return;
 // Node不能识别全部Windows重解析标签；只检查属性，不在子进程读取文件正文。
 const encoded=Buffer.from(JSON.stringify(paths),'utf8').toString('base64');
 const script=`$ErrorActionPreference='Stop';try{$items=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;foreach($item in $items){if(([IO.File]::GetAttributes($item)-band[IO.FileAttributes]::ReparsePoint)-ne 0){exit 23}}}catch{exit 24}`;
 const result=spawnSync('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{shell:false,windowsHide:true,timeout:5000,maxBuffer:4096});
 if(result.error||result.signal||result.status!==0)fail('REVIEW_REPARSE_UNVERIFIED','Windows重解析属性检查未通过。');
}

function pngDimensions(bytes){
 if(bytes.length<33||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')fail('REVIEW_PNG_INVALID','只接受具有PNG签名和IHDR的固定图片。');
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
 if(!width||!height||width>4096||height>4096||width*height>8*1024*1024)fail('REVIEW_PNG_DIMENSIONS','PNG尺寸超过固定范围。');
 // 原型只接受8位RGB/RGBA静态非交错PNG，CRC和有界像素流另核；不加载图片库或外部解码器。
 const channels=bytes[25]===2?3:bytes[25]===6?4:0;
 if(bytes[24]!==8||!channels||bytes[26]||bytes[27]||bytes[28])fail('REVIEW_PNG_INVALID','PNG编码不在本原型的已审范围。');
 let cursor=8,count=0,ended=false,sawData=false,dataEnded=false;const compressed=[];
 while(cursor<bytes.length){
  if(++count>256||cursor+12>bytes.length)fail('REVIEW_PNG_INVALID','PNG块数量或边界无效。');
  const length=bytes.readUInt32BE(cursor),end=cursor+12+length;
  if(end>bytes.length)fail('REVIEW_PNG_INVALID','PNG块越界。');
  const type=bytes.toString('ascii',cursor+4,cursor+8);
  if(!/^[A-Za-z]{4}$/.test(type)||crc32(bytes.subarray(cursor+4,end-4))!==bytes.readUInt32BE(end-4))fail('REVIEW_PNG_INVALID','PNG块CRC或类型无效。');
  if(type==='IHDR'){if(cursor!==8||length!==13)fail('REVIEW_PNG_INVALID','PNG头重复或无效。');}
  else if(type==='IDAT'){if(dataEnded)fail('REVIEW_PNG_INVALID','PNG像素块必须连续。');sawData=true;compressed.push(bytes.subarray(cursor+8,end-4));}
  else if(type==='IEND'){if(length||!sawData||end!==bytes.length)fail('REVIEW_PNG_INVALID','PNG终块或尾部无效。');ended=true;}
  else{if(sawData)dataEnded=true;if(['acTL','fcTL','fdAT'].includes(type)||/^[A-Z]/.test(type)&&type!=='PLTE')fail('REVIEW_PNG_INVALID','PNG含动画或未知关键块。');}
  cursor=end;
 }
 if(!ended)fail('REVIEW_PNG_INVALID','PNG缺少终块。');
 const stride=width*channels+1,expected=stride*height;let decoded;
 try{decoded=inflateSync(Buffer.concat(compressed),{maxOutputLength:expected});}catch{fail('REVIEW_PNG_INVALID','PNG像素流无效或超出尺寸。');}
 if(decoded.length!==expected)fail('REVIEW_PNG_INVALID','PNG像素流尺寸不同。');
 for(let row=0;row<height;row++)if(decoded[row*stride]>4)fail('REVIEW_PNG_INVALID','PNG扫描行滤波无效。');
 return{width,height};
}
function crc32(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;}

// 纯宿主离线原型。没有MCP注册、配置激活、SDK/CLI调用或运行入口。
// 可信宿主负责建立plan和认证context；read参数仅含frameId，不是认证接口。
export function createMarketReviewFrameBroker(trustedPlan){
 const plan=structuredClone(trustedPlan);
 if(!exact(plan,['root','rootIdentity','member','source','frames','maxReads','totalByteLimit'])||!exact(plan.member,['instanceId','groupId','taskId'])||!Object.values(plan.member).every(id)||!exact(plan.source,['artifactId','sourceResultId','sha256','byteLength'])||![plan.source.artifactId,plan.source.sourceResultId].every(id)||!digest(plan.source.sha256)||!Number.isSafeInteger(plan.source.byteLength)||plan.source.byteLength<1||!Number.isSafeInteger(plan.maxReads)||plan.maxReads<1||plan.maxReads>5||!Number.isSafeInteger(plan.totalByteLimit)||plan.totalByteLimit<1||plan.totalByteLimit>TOTAL_LIMIT||typeof plan.root!=='string'||!path.isAbsolute(plan.root)||plan.root!==path.resolve(plan.root)||plan.root.startsWith(path.sep.repeat(2))||plan.root.slice(path.parse(plan.root).root.length).includes(':')||!Array.isArray(plan.frames)||!plan.frames.length||plan.frames.length>5)fail('REVIEW_PLAN_INVALID','只接受可信宿主固定的任务、来源和最多五帧计划。');
 if(!same(preparedRootIdentity(plan.root),plan.rootIdentity)||fs.realpathSync(plan.root)!==plan.root)fail('REVIEW_DIRECTORY_CHANGED','帧根目录身份或规范真实路径不同。');
 const parents=directories(plan.root),frameIds=new Set(),names=new Set(),pins=new Map();let total=0;
 rejectReparse(parents.map(item=>item.path));
 for(const frame of plan.frames){
  if(!exact(frame,['frameId','relativePath','sha256','byteLength','width','height','pts'])||!id(frame.frameId)||frameIds.has(frame.frameId)||typeof frame.relativePath!=='string'||!(/^[a-z0-9][a-z0-9._-]{0,79}\.png$/).test(frame.relativePath)||names.has(frame.relativePath.toLowerCase())||!digest(frame.sha256)||!Number.isSafeInteger(frame.byteLength)||frame.byteLength<57||frame.byteLength>FRAME_LIMIT||![frame.width,frame.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096)||frame.width*frame.height>8*1024*1024||!exact(frame.pts,['numerator','denominator'])||!Number.isSafeInteger(frame.pts.numerator)||frame.pts.numerator<0||!Number.isSafeInteger(frame.pts.denominator)||frame.pts.denominator<1)fail('REVIEW_FRAME_PIN_INVALID','帧标识、固定文件名、SHA、尺寸或PTS不符合范围。');
  frameIds.add(frame.frameId);names.add(frame.relativePath.toLowerCase());total+=frame.byteLength;
  const file=sessionPath(path.join(plan.root,frame.relativePath));rejectReparse([file]);
  if(fs.realpathSync(file)!==file)fail('REVIEW_FILE_IDENTITY','文件真实路径大小写或来源不同。');
  const stat=fs.lstatSync(file,{bigint:true});ordinary(stat);
  const read=readBoundedFile(file,FRAME_LIMIT),dimensions=pngDimensions(read.bytes);
  if(read.byteLength!==frame.byteLength||read.sha256!==frame.sha256||dimensions.width!==frame.width||dimensions.height!==frame.height)fail('REVIEW_FRAME_PIN_MISMATCH','帧内容与可信计划不同。');
  pins.set(frame.frameId,{file,identity:fileIdentity(stat)});
 }
 if(total>plan.totalByteLimit)fail('REVIEW_BUDGET_INVALID','帧固定总大小超过可信预算。');
 let reads=0,bytesReturned=0,blocked=false;const used=new Set();
 const verifyParents=()=>{if(!same(directories(plan.root),parents))fail('REVIEW_DIRECTORY_CHANGED','评审父目录身份已变化。');};
 return Object.freeze({
  read(input,context){
   const decision=evaluateMarketReviewPretool('read_review_frame',input,{plan,context});if(!decision.candidateMatch)fail(decision.reason,'帧参数或可信任务身份不符合计划。');
   if(blocked)fail('REVIEW_BROKER_BLOCKED','此前读取未知或失败，停止交人工核查。');
   if(used.has(input.frameId))fail('REVIEW_FRAME_ALREADY_READ','同一帧不重复读取。');
   const frame=plan.frames.find(item=>item.frameId===input.frameId),pin=pins.get(input.frameId);
   if(reads>=plan.maxReads||bytesReturned+frame.byteLength>plan.totalByteLimit)fail('REVIEW_BUDGET_EXHAUSTED','评审图片次数或字节预算已耗尽。');
   used.add(input.frameId);
   let fd;
   try{
    verifyParents();rejectReparse([...parents.map(item=>item.path),pin.file]);
    const before=fs.lstatSync(sessionPath(pin.file),{bigint:true});ordinary(before);
    if(!same(fileIdentity(before),pin.identity)||fs.realpathSync(pin.file)!==pin.file)fail('REVIEW_FILE_CHANGED','帧打开前身份已变化。');
    fd=fs.openSync(pin.file,'r');const opened=fs.fstatSync(fd,{bigint:true});ordinary(opened);
    if(!same(fileIdentity(opened),pin.identity))fail('REVIEW_FILE_CHANGED','帧打开时已替换。');
    const bytes=Buffer.alloc(frame.byteLength);let offset=0;
    while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)fail('REVIEW_FILE_CHANGED','帧未读完整。');offset+=count;}
    const dimensions=pngDimensions(bytes);
    if(sha256(bytes)!==frame.sha256||dimensions.width!==frame.width||dimensions.height!==frame.height)fail('REVIEW_FRAME_PIN_MISMATCH','帧摘要或尺寸已变化。');
    verifyParents();rejectReparse([...parents.map(item=>item.path),pin.file]);
    for(const after of [fs.fstatSync(fd,{bigint:true}),fs.lstatSync(sessionPath(pin.file),{bigint:true})]){ordinary(after);if(!same(fileIdentity(after),pin.identity))fail('REVIEW_FILE_CHANGED','返回前帧身份已变化。');}
    fs.closeSync(fd);fd=undefined;reads++;bytesReturned+=bytes.length;
    const metadata={frameId:frame.frameId,source:structuredClone(plan.source),sha256:frame.sha256,byteLength:bytes.length,width:frame.width,height:frame.height,pts:{...frame.pts},reads,bytesReturned,evidenceKind:'offline_broker_return',actualModelReadVerified:false,expertRuntimeLoadedVerified:false,osIsolationVerified:false,launchAllowed:false};
    return{content:[{type:'image',mimeType:'image/png',data:bytes.toString('base64')},{type:'text',text:JSON.stringify(metadata)}],structuredContent:metadata};
   }catch(error){blocked=true;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
  },
  status(){return{reads,bytesReturned,blocked,launchAllowed:false,registeredAsMcpTool:false,actualModelReadVerified:false};}
 });
}
