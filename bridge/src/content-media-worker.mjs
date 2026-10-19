import fs from 'node:fs';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {PROJECT_ROOT,SOURCE_ROOT,inside,fail,sha256} from './policy.mjs';
import {readBoundedFile,sessionPath,validFileArguments} from './session-files.mjs';
import {downloadPinnedSource} from './content-download.mjs';

const LIMIT=64*1024*1024;
const id=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const exact=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function rejectReparse(paths){
  if(process.platform!=='win32')return;
  const encoded=Buffer.from(JSON.stringify(paths)).toString('base64');
  const script=`$ErrorActionPreference='Stop';try{$items=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))|ConvertFrom-Json;foreach($item in $items){if(([IO.File]::GetAttributes($item)-band[IO.FileAttributes]::ReparsePoint)-ne 0){exit 23}}}catch{exit 24}`;
  const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,shell:false,timeout:10000,maxBuffer:4096});
  if(result.error||result.status!==0)fail('CONTENT_MEDIA_REPARSE','媒体路径重解析检查未通过，不回退宿主读取。');
}

// 实例由可信宿主配置创建；消息不能提供工具路径、来源许可或认证。
export class ControlledContentMediaWorker{
  #config;#fixture;#rootIdentity;
  constructor(config,{fixture=false}={}){
    if(fixture&&(process.env.COLLAB_TEST_MODE!=='1'||PROJECT_ROOT===SOURCE_ROOT))fail('CONTENT_MEDIA_FIXTURE_FORBIDDEN','合成执行仅允许显式隔离测试根。');
    this.#config=structuredClone(config);this.#fixture=fixture;
    if(!id(config.groupId)||!id(config.taskId)||!id(config.actorId)||!/^[a-f0-9]{64}$/.test(config.briefSha256??'')||path.dirname(path.resolve(config.taskRoot??''))!==path.join(PROJECT_ROOT,'task-workspaces'))fail('CONTENT_MEDIA_TASK_INVALID','可信媒体计划须固定当前项目独立任务及brief。');
    const stat=fs.statSync(sessionPath(config.taskRoot),{bigint:true});
    this.#rootIdentity={dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)};
    this.#checkTask();
  }
  #checkTask(){
    const config=this.#config,root=sessionPath(config.taskRoot),stat=fs.statSync(root,{bigint:true});
    if(!same(this.#rootIdentity,{dev:String(stat.dev),ino:String(stat.ino),birthtimeNs:String(stat.birthtimeNs)}))fail('CONTENT_MEDIA_TASK_CHANGED','原任务根身份已变化。');
    const pin=readBoundedFile(path.join(root,'.task-binding.json'),4096),marker=JSON.parse(pin.bytes);
    if(pin.sha256!==config.markerSha256||marker.owner!=='collaboration-core'||marker.groupId!==config.groupId||marker.logicalTaskId!==config.taskId)fail('CONTENT_MEDIA_BINDING_CHANGED','原任务绑定不符。');
    const paths=[root,...['inputs','work','outputs'].flatMap(area=>[path.join(root,area),path.join(root,area,'files')])];
    for(const file of paths)sessionPath(file);
    if(fs.existsSync(path.join(root,'.os-worker')))fail('CONTENT_MEDIA_OS_UNSUPPORTED','已有OS worker意图，媒体候选不回退宿主文件访问。');
    rejectReparse(paths);
  }
  #target(reference,{mustExist=true}={}){
    if(!exact(reference,['area','relativePath'])||!validFileArguments('read_task_file',reference))fail('CONTENT_MEDIA_PATH_INVALID','仅接受绑定任务files内规范相对文件名。');
    const file=sessionPath(path.join(this.#config.taskRoot,reference.area,'files',reference.relativePath),mustExist);
    if(mustExist)rejectReparse([file]);
    return file;
  }
  #read(reference,expected=null,limit=LIMIT){
    this.#checkTask();const file=this.#target(reference),result=readBoundedFile(file,limit);
    if(expected&&(result.sha256!==expected.sha256||expected.byteLength!==undefined&&result.byteLength!==expected.byteLength))fail('CONTENT_MEDIA_INPUT_CHANGED','媒体输入SHA或大小与原计划不符。');
    this.#checkTask();return{...result,file,reference};
  }
  #tool(name){
    const pin=this.#config.tools?.[name];
    if(!exact(pin,['path','sha256',...(pin?.version!==undefined?['version']:[])])||!path.isAbsolute(pin.path)||path.basename(pin.path).toLowerCase()!==`${name}.exe`||!/^[a-f0-9]{64}$/.test(pin.sha256)||sha256(fs.readFileSync(pin.path))!==pin.sha256)fail('CONTENT_MEDIA_TOOL_CHANGED','媒体工具须由私有配置固定准确程序及SHA。');
    return pin;
  }
  async #toolRun(name,args,directory,label,{cwd=this.#config.taskRoot}={}){
    const pin=this.#tool(name),events=[],chunks=[],errors=[];
    let size=0,overflow=false,timedOut=false,child;
    const record=(type,data={})=>events.push({type,at:new Date().toISOString(),...data});
    child=spawn(pin.path,args,{cwd,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},30000);
    const collect=(target,bytes)=>{size+=bytes.length;if(size>256*1024){overflow=true;child.kill();return;}target.push(bytes);};
    child.stdout.on('data',bytes=>collect(chunks,bytes));child.stderr.on('data',bytes=>collect(errors,bytes));
    child.once('spawn',()=>record('spawn',{pid:child.pid}));
    child.once('error',error=>record('error',{code:error.code??'SPAWN_ERROR'}));
    child.once('exit',(code,signal)=>record('exit',{code,signal}));
    const closed=await new Promise(resolve=>child.once('close',(code,signal)=>{clearTimeout(timer);record('close',{code,signal});resolve({code,signal});}));
    const stdout=Buffer.concat(chunks),stderr=Buffer.concat(errors);
    for(const[file,bytes]of [[`${label}.stdout.log`,stdout],[`${label}.stderr.log`,stderr]])fs.writeFileSync(path.join(directory,file),bytes,{flag:'wx'});
    const lifecycle={tool:name,toolSha256:pin.sha256,pid:child.pid??null,args,...closed,timedOut,overflow,events,stdoutSha256:sha256(stdout),stderrSha256:sha256(stderr)};
    fs.writeFileSync(path.join(directory,`${label}.lifecycle.json`),JSON.stringify(lifecycle,null,2),{flag:'wx'});
    if(closed.code!==0||timedOut||overflow)fail('CONTENT_MEDIA_PROCESS_UNKNOWN','媒体子进程失败或未知，保留输出和意图，不自动重跑。');
    return{stdout,lifecycle};
  }
  async #operation(kind,request,action){
    this.#checkTask();
    if(!this.#fixture){
      if(process.env.COLLAB_TEST_MODE==='1')fail('CONTENT_MEDIA_TEST_REAL_FORBIDDEN','隔离测试禁止切换真实执行。');
      const plan=this.prepare(kind,request),pin=this.#config.approvalPin;
      if(!pin||!path.isAbsolute(pin.path??'')||!/^[a-f0-9]{64}$/.test(pin.sha256??''))fail('CONTENT_MEDIA_OWNER_APPROVAL_REQUIRED','真实执行须由可信宿主固定准确批准文件及SHA。');
      const read=readBoundedFile(sessionPath(pin.path),16384),approval=JSON.parse(read.bytes);
      if(read.sha256!==pin.sha256||!exact(approval,['schema','planSha256','approvedBy','expiresAt','permission'])||approval.schema!=='content_media_execute_once_v1'||approval.planSha256!==plan.planSha256||approval.approvedBy!==this.#config.ownerId||!id(approval.approvedBy)||approval.permission!=='execute_once'||!Number.isFinite(Date.parse(approval.expiresAt))||Date.parse(approval.expiresAt)<=Date.now())fail('CONTENT_MEDIA_APPROVAL_MISMATCH','批准不匹配当前任务、输入、工具、来源、操作或有效期。');
    }
    if(!id(request.operationId))fail('CONTENT_MEDIA_OPERATION_INVALID','媒体操作编号无效。');
    const directory=sessionPath(path.join(this.#config.taskRoot,'work','content-media',kind),false);
    fs.mkdirSync(directory,{recursive:true});
    rejectReparse([directory]);
    const intentFile=path.join(directory,'intent.json'),resultFile=path.join(directory,'result.json'),digest=this.prepare(kind,request).planSha256;
    try{fs.writeFileSync(intentFile,JSON.stringify({kind,request,digest,state:'unknown',automaticRetry:false}),{flag:'wx'});}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const prior=JSON.parse(readBoundedFile(intentFile,32768).bytes);
      if(prior.digest!==digest)fail('CONTENT_MEDIA_OPERATION_RESERVED','该任务阶段已有原意图，不换编号、输入或路径重做。');
      if(!fs.existsSync(resultFile))return{status:'unknown',reason:'CONTENT_MEDIA_LAUNCH_UNCONFIRMED',deduplicated:true,automaticRetry:false};
      const result=JSON.parse(readBoundedFile(resultFile,256*1024).bytes),stopFile=path.join(directory,'integrity-stop.json');
      if(fs.existsSync(stopFile))return{...JSON.parse(readBoundedFile(stopFile,4096).bytes),deduplicated:true};
      if(result.status==='succeeded')try{for(const output of [result.output,result.checkPng].filter(Boolean)){const current=this.#read(output.reference,output);if(output.fileIdentity&&!same(current.identity,output.fileIdentity))fail('CONTENT_MEDIA_OUTPUT_CHANGED','原输出身份变化。');}}
      catch{const stop={status:'unknown',reason:'CONTENT_MEDIA_OUTPUT_CHANGED',automaticRetry:false,originalResultFile:resultFile};fs.writeFileSync(stopFile,JSON.stringify(stop),{flag:'wx'});return{...stop,deduplicated:true};}
      return{...result,deduplicated:true};
    }
    let result;
    try{result={status:'succeeded',...(await action(directory))};}
    catch(error){result={status:'unknown',reason:error.code??'CONTENT_MEDIA_FAILED',message:error.message};}
    result={...result,kind,operationId:request.operationId,briefSha256:this.#config.briefSha256,groupId:this.#config.groupId,taskId:this.#config.taskId,observedBy:'controlled_local_media_worker',requestedActorId:this.#config.actorId,actorActuallyCalledAgentTool:false,evidenceLevel:this.#fixture?'local_test':'host_local_observation',modelExecutionVerified:false,businessCompletedVerified:false,automaticRetry:false,intentFile};
    fs.writeFileSync(resultFile,JSON.stringify(result,null,2),{flag:'wx'});return result;
  }
  prepare(kind,request){
    this.#checkTask();if(!['collection','edit','revision','voiceover'].includes(kind)||!id(request?.operationId))fail('CONTENT_MEDIA_OPERATION_INVALID','固定媒体阶段或操作编号无效。');
    const config=this.#config,context={contract:'content_media_execute_once_v1',kind,request,taskRoot:config.taskRoot,rootIdentity:this.#rootIdentity,groupId:config.groupId,taskId:config.taskId,actorId:config.actorId,ownerId:config.ownerId??null,briefSha256:config.briefSha256,markerSha256:config.markerSha256,tools:config.tools,fontPin:config.fontPin??null,voice:config.voice??null,sources:config.sources};
    return{context,planSha256:sha256(JSON.stringify(context)),launchAllowed:false,automaticRetry:false};
  }
  async recover(request){
    if(!exact(request,['operationId','sourceId','outputRelativePath']))fail('CONTENT_MEDIA_REQUEST_INVALID','回收请求只接受固定来源编号和输出相对名。');
    const source=this.#config.sources?.find(item=>item.sourceId===request.sourceId);
    if(!source||!['task_file','https'].includes(source.kind))fail('CONTENT_MEDIA_SOURCE_CONTRACT_UNAVAILABLE','缺少获准原结果的确切文件或HTTPS合同。');
    const outputRef={area:'outputs',relativePath:request.outputRelativePath};this.#target(outputRef,{mustExist:false});
    return this.#operation('collection',request,async directory=>{
      const receipt=this.#read({area:source.sourceReceipt.area,relativePath:source.sourceReceipt.relativePath},source.sourceReceipt,32768),original=JSON.parse(receipt.bytes);
      const sourceProducerId=source.producerId??this.#config.actorId,sourceTaskId=source.sourceTaskId??this.#config.taskId;
      if(original.actorId!==sourceProducerId||original.groupId!==this.#config.groupId||original.taskId!==sourceTaskId||original.sourceId!==source.sourceId||original.briefSha256!==this.#config.briefSha256)fail('CONTENT_MEDIA_SOURCE_OWNER_MISMATCH','原producer、来源任务、操作或brief不符，不能冒充回收worker本人。');
      const file=this.#target(outputRef,{mustExist:false});
      fs.mkdirSync(sessionPath(path.dirname(file),false),{recursive:true});rejectReparse([path.dirname(file)]);
      let transport=null;if(source.kind==='task_file'){const input=this.#read({area:source.area,relativePath:source.relativePath},source);fs.writeFileSync(file,input.bytes,{flag:'wx'});}
      else{if(original.url!==source.url)fail('CONTENT_MEDIA_SOURCE_URL_MISMATCH','URL须来自已固定原始回执，不接受消息替换。');transport=await downloadPinnedSource(source,file,{fixture:this.#fixture,traceFile:path.join(directory,'download-trace.json')});}
      this.#read({area:source.sourceReceipt.area,relativePath:source.sourceReceipt.relativePath},source.sourceReceipt,32768);
      const output=this.#read(outputRef,source.mode==='fresh'?null:source);let probe=null;
      if(source.mode==='fresh'){
        if(!output.bytes.subarray(4,8).equals(Buffer.from('ftyp')))fail('CONTENT_MEDIA_FRESH_TYPE_UNKNOWN','fresh回收结果不是支持的MP4，保留原文件停在未知。');
        const probed=await this.#toolRun('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],directory,'fresh-probe');probe=JSON.parse(probed.stdout);
        if(!probe.streams?.some(stream=>stream.codec_type==='video')||!Number.isFinite(Number(probe.format?.duration))||Number(probe.format.duration)<=0)fail('CONTENT_MEDIA_FRESH_PROBE_UNKNOWN','fresh回收没有可探测的视频与时长。');this.#read(outputRef,output);
      }
      return{output:{reference:outputRef,byteLength:output.byteLength,sha256:output.sha256,fileIdentity:output.identity},sourceProducerId,sourceTaskId,sourceReceiptSha256:receipt.sha256,transport,probe,originVerifiedAsPlatform:false};
    });
  }
  async compose(request){
    const subtitleMode=request?.subtitleMode??'embedded_track';
    if(!exact(request,['operationId','slot','video','voice','subtitles','startMs','durationMs','outputRelativePath',...(Object.hasOwn(request??{},'subtitleMode')?['subtitleMode']:[])])||!['embedded_track','burned'].includes(subtitleMode)||!['edit','revision'].includes(request.slot)||!Number.isSafeInteger(request.startMs)||request.startMs<0||!Number.isSafeInteger(request.durationMs)||request.durationMs<100||request.durationMs>600000)fail('CONTENT_MEDIA_REQUEST_INVALID','剪辑须使用固定有界区间、明确字幕模式和输入。');
    for(const ref of [request.video,request.voice,request.subtitles])if(!exact(ref,['area','relativePath','sha256'])||!/^[a-f0-9]{64}$/.test(ref.sha256))fail('CONTENT_MEDIA_INPUT_INVALID','每份剪辑输入必须固定原文件SHA。');
    const outputRef={area:'outputs',relativePath:request.outputRelativePath};this.#target(outputRef,{mustExist:false});
    if(path.extname(request.outputRelativePath).toLowerCase()!=='.mp4')fail('CONTENT_MEDIA_OUTPUT_INVALID','本地候选仅输出明确MP4版本。');
    return this.#operation(request.slot,request,async directory=>{
      const input=ref=>this.#read({area:ref.area,relativePath:ref.relativePath},ref),video=input(request.video),voice=input(request.voice),subtitles=input(request.subtitles);
      if(!video.bytes.subarray(4,8).equals(Buffer.from('ftyp'))||voice.bytes.toString('ascii',0,4)!=='RIFF'||voice.bytes.toString('ascii',8,12)!=='WAVE'||path.extname(subtitles.file).toLowerCase()!=='.srt')fail('CONTENT_MEDIA_FORMAT_UNSUPPORTED','候选固定MP4视频、WAV配音样本及SRT字幕，不解析任意播放列表。');
      const voiceProbe=await this.#toolRun('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',voice.file],directory,'voice-input-probe'),voiceMetadata=JSON.parse(voiceProbe.stdout),voiceDurationMs=Number(voiceMetadata.format?.duration)*1000;
      if(!voiceMetadata.streams?.some(stream=>stream.codec_type==='audio')||!Number.isFinite(voiceDurationMs)||voiceDurationMs<=0)fail('CONTENT_MEDIA_NARRATION_INVALID','必须先探测完整原配音实际时长。');
      if(voiceDurationMs>request.durationMs+1)fail('CONTENT_MEDIA_NARRATION_TOO_LONG','完整配音长于剪辑区间，停止交评审修改文案，不能用-t截断旁白。');
      const output=this.#target(outputRef,{mustExist:false});fs.mkdirSync(sessionPath(path.dirname(output),false),{recursive:true});rejectReparse([path.dirname(output)]);
      const duration=String(request.durationMs/1000),start=String(request.startMs/1000);
      const args=['-hide_banner','-loglevel','error','-nostdin','-n','-protocol_whitelist','file,pipe','-ss',start,'-i',video.file,'-protocol_whitelist','file,pipe','-i',voice.file];
      let fontSha256=null;
      if(subtitleMode==='embedded_track')args.push('-protocol_whitelist','file,pipe','-f','srt','-i',subtitles.file,'-map','0:v:0','-map','1:a:0','-map','2:s:0','-c:s','mov_text');
      else{
        const font=this.#config.fontPin;
        if(!font||!path.isAbsolute(font.path??'')||!/^[a-f0-9]{64}$/.test(font.sha256??'')||!/^[A-Za-z0-9\u4e00-\u9fff -]{1,80}$/.test(font.family??'')||!['.ttf','.ttc','.otf'].includes(path.extname(font.path).toLowerCase()))fail('CONTENT_MEDIA_FONT_REQUIRED','烧录字幕必须由私有配置固定字体文件及安全字族名。');
        const fontBytes=fs.readFileSync(font.path);if(sha256(fontBytes)!==font.sha256)fail('CONTENT_MEDIA_FONT_CHANGED','字体原文件与受审pin不符。');
        const captionText=new TextDecoder('utf-8',{fatal:true}).decode(subtitles.bytes),captionLines=captionText.split(/\r?\n/).filter(line=>line&&!/^\d+$/.test(line)&&!line.includes('-->'));
        if(captionText.length>32768||captionLines.some(line=>/[{}<>\\]/.test(line)))fail('CONTENT_MEDIA_SUBTITLE_CONTROL_FORBIDDEN','候选字幕只接受纯文字，不接受ASS/HTML控制或外部字体路径。');
        const fontDir=sessionPath(path.join(directory,'fonts'),false);fs.mkdirSync(fontDir);rejectReparse([fontDir]);
        fs.writeFileSync(path.join(fontDir,`font${path.extname(font.path).toLowerCase()}`),fontBytes,{flag:'wx'});fs.writeFileSync(path.join(directory,'subtitles.srt'),subtitles.bytes,{flag:'wx'});fontSha256=font.sha256;
        const filter=`subtitles=filename=subtitles.srt:fontsdir=fonts:force_style='FontName=${font.family},FontSize=16,Outline=1'`;
        args.push('-map','0:v:0','-map','1:a:0','-vf',filter);
      }
      args.push('-t',duration,'-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output);
      const execution=await this.#toolRun('ffmpeg',args,directory,'compose',{cwd:subtitleMode==='burned'?directory:this.#config.taskRoot});
      for(const ref of [request.video,request.voice,request.subtitles])input(ref);
      const probeRun=await this.#toolRun('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',output],directory,'probe'),probe=JSON.parse(probeRun.stdout);
      if(!['video','audio',...(subtitleMode==='embedded_track'?['subtitle']:[])].every(kind=>probe.streams?.some(stream=>stream.codec_type===kind)))fail('CONTENT_MEDIA_STREAM_MISSING','实际成片缺少本模式要求的视频、音频或字幕轨。');
      const videoDuration=Number(probe.streams.find(stream=>stream.codec_type==='video')?.duration??probe.format?.duration)*1000;
      if(!Number.isFinite(videoDuration)||Math.abs(videoDuration-request.durationMs)>100)fail('CONTENT_MEDIA_DURATION_MISMATCH','实际视频时长与请求区间不符，不能用短片冒充完成。');
      await this.#toolRun('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-protocol_whitelist','file,pipe','-i',output,'-f','null','-'],directory,'decode');
      const result=this.#read(outputRef);
      let checkPng=null;
      if(subtitleMode==='burned'){
        const reference={area:'outputs',relativePath:request.outputRelativePath.slice(0,-4)+'-check.png'},file=this.#target(reference,{mustExist:false}),requestedTimeMs=Math.min(200,Math.floor(request.durationMs/2));
        await this.#toolRun('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-protocol_whitelist','file,pipe','-ss',String(requestedTimeMs/1000),'-i',output,'-frames:v','1','-update','1',file],directory,'render-check');
        const image=this.#read(reference);if(!image.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))fail('CONTENT_RENDER_CHECK_INVALID','烧录检查图没有PNG签名。');
        checkPng={reference,byteLength:image.byteLength,sha256:image.sha256,sourceVideoSha256:result.sha256,requestedTimeMs,actualPtsIndependentlyVerified:false};
      }
      return{output:{reference:outputRef,byteLength:result.byteLength,sha256:result.sha256,fileIdentity:result.identity},probe,execution:execution.lifecycle,technicalDecodePassed:true,subtitleMode,fontSha256,checkPng,voiceDurationMs,fullNarrationPreserved:true,glyphReviewPassed:false,actualAudioListened:false,voiceInputEvidenceLevel:this.#fixture?'local_test':'host_local_file',fullVideoVisualReview:false};
    });
  }
  async synthesizeVoice(request){
    if(!exact(request,['operationId','text','outputRelativePath'])||!exact(request.text,['area','relativePath','sha256'])||!/^[a-f0-9]{64}$/.test(request.text.sha256)||path.extname(request.outputRelativePath??'').toLowerCase()!=='.wav')fail('CONTENT_VOICE_REQUEST_INVALID','配音只接受固定纯文本SHA和WAV相对输出名。');
    const voice=this.#config.voice;
    if(!voice||!['fixture','sapi'].includes(voice.engine)||voice.engine==='fixture'&&!this.#fixture||voice.engine==='sapi'&&this.#fixture||!Number.isInteger(voice.rate)||Math.abs(voice.rate)>2||typeof voice.tokenId!=='string'||!voice.tokenId.length||voice.tokenId.length>256)fail('CONTENT_VOICE_ENGINE_FORBIDDEN','真实SAPI和假引擎必须分开配置，固定准确token与有界语速。');
    const outputRef={area:'outputs',relativePath:request.outputRelativePath};this.#target(outputRef,{mustExist:false});
    return this.#operation('voiceover',request,async directory=>{
      const text=this.#read({area:request.text.area,relativePath:request.text.relativePath},request.text,8192),plain=new TextDecoder('utf-8',{fatal:true}).decode(text.bytes);
      if(!plain.trim()||plain.length>2000||/[<>\x00-\x08\x0b\x0c\x0e-\x1f]/.test(plain))fail('CONTENT_VOICE_TEXT_INVALID','配音输入仅为有界纯文字，不接受SSML或控制字符。');
      const pin=voice.scriptPin;if(!pin||!path.isAbsolute(pin.path??'')||readBoundedFile(sessionPath(pin.path),128*1024).sha256!==pin.sha256||this.#fixture&&!inside(this.#config.taskRoot,pin.path))fail('CONTENT_VOICE_SCRIPT_CHANGED','配音脚本须由宿主固定准确文件SHA；假脚本只在测试任务内。');
      const stagingFile=path.join(directory,'voice-staging.wav'),requestFile=path.join(directory,'voice-request.json'),payload=Buffer.from(JSON.stringify({schema:'content_local_voice_v1',taskRoot:this.#config.taskRoot,markerSha256:this.#config.markerSha256,textFile:text.file,textSha256:text.sha256,stagingFile,tokenId:voice.tokenId,rate:voice.rate}));fs.writeFileSync(requestFile,payload,{flag:'wx'});
      const name=this.#fixture?'node':'pwsh',args=this.#fixture?[pin.path,requestFile,sha256(payload)]:['-NoProfile','-NonInteractive','-File',pin.path,'-RequestFile',requestFile,'-RequestSha256',sha256(payload)];
      if(this.#fixture&&!inside(PROJECT_ROOT,this.#config.tools?.node?.path??''))fail('CONTENT_VOICE_FIXTURE_FORBIDDEN','假配音引擎必须复制到隔离根。');
      const execution=await this.#toolRun(name,args,directory,'voice'),reported=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(execution.stdout));
      if(reported.status!=='succeeded'||reported.textSha256!==text.sha256||reported.tokenId!==voice.tokenId)fail('CONTENT_VOICE_RECEIPT_UNKNOWN','配音原始进程回执不匹配文字和token。');
      this.#read(text.reference,request.text,8192);const generated=readBoundedFile(sessionPath(stagingFile),32*1024*1024);rejectReparse([stagingFile]);
      if(generated.bytes.toString('ascii',0,4)!=='RIFF'||generated.bytes.toString('ascii',8,12)!=='WAVE')fail('CONTENT_VOICE_WAV_INVALID','配音进程没有生成WAV文件。');
      const file=this.#target(outputRef,{mustExist:false});fs.mkdirSync(sessionPath(path.dirname(file),false),{recursive:true});rejectReparse([path.dirname(file)]);fs.writeFileSync(file,generated.bytes,{flag:'wx'});
      const probeRun=await this.#toolRun('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_streams','-show_format','-of','json',file],directory,'voice-probe'),probe=JSON.parse(probeRun.stdout),durationMs=Number(probe.format?.duration)*1000;
      if(probe.streams?.length!==1||probe.streams[0].codec_type!=='audio'||!Number.isFinite(durationMs)||durationMs<=0||durationMs>240000)fail('CONTENT_VOICE_PROBE_UNKNOWN','配音实际音轨或时长不符。');
      const output=this.#read(outputRef);return{output:{reference:outputRef,byteLength:output.byteLength,sha256:output.sha256,fileIdentity:output.identity},execution:execution.lifecycle,textSha256:text.sha256,tokenId:voice.tokenId,rate:voice.rate,durationMs,probe,nativeConversationId:null,localTtsExecutionObserved:!this.#fixture,speechVerified:false,listeningPerformed:false,subtitleTimingVerified:false};
    });
  }
}
