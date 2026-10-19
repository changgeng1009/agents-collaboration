import {FIXTURE_ROOT} from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Client} from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import {startCollaborationService} from '../bridge/src/collaboration-service.mjs';

const tools=JSON.parse(fs.readFileSync(process.env.COLLAB_MEDIA_TOOL_PINS,'utf8'));
for(const tool of Object.values(tools))assert.equal(createHash('sha256').update(fs.readFileSync(tool.path)).digest('hex'),tool.sha256);
const peers=[],checks=[];let service,seq=0;
const directory=path.join(FIXTURE_ROOT,'logs/content-quality-mcp-tests');fs.mkdirSync(directory,{recursive:true});
async function connect(file){const peer=new Client({name:'quality_fixture',version:'0.2.14'});peers.push(peer);await peer.connect(new StreamableHTTPClientTransport(new URL(service.service.endpoint),{requestInit:{headers:{Authorization:`Bearer ${fs.readFileSync(file,'utf8')}`}}}));return peer;}
async function call(peer,name,args={}){const result=await peer.callTool({name,arguments:{...(!name.startsWith('get_')?{requestId:`quality_${++seq}`} : {}),...args}});const value=result.structuredContent??JSON.parse(result.content[0].text);assert.notEqual(result.isError,true,JSON.stringify(value));return value;}
try{
  service=await startCollaborationService({port:0,runtimeNamespace:'QualityFixture',contentMediaTools:tools});
  const admin=await connect(service.service.adminKeyFile),members={};
  for(const id of ['director','producer'])members[id]=await connect((await call(admin,'provision_member',{instanceId:id,platform:'fixture',mode:'offline'})).credentialFile);
  await call(admin,'create_group',{groupId:'quality_group',title:'有实际媒体的质量合成任务',memberIds:['director','producer'],managerId:'director',policy:{allowMemberTakeover:false}});
  const scope={groupId:'quality_group',taskId:'production_task'},acl={readers:['director','producer'],writers:['director','producer'],inputWriters:['director']},taskRoots={};
  for(const[taskId,assigneeId]of [['production_task','producer'],['expert_task','director']]){
    const created=await call(members.director,'create_task',{groupId:scope.groupId,taskId,title:'合成质量任务',assigneeId,participantIds:['director','producer'],fileAcl:acl});taskRoots[taskId]=created.task.taskRoot;
    await call(members.director,'write_task_file',{groupId:scope.groupId,taskId,area:'inputs',relativePath:'brief.json',text:'{"topic":"合成品牌，不含公司资料"}'});
  }
  const stages=['script','generation','collection','edit','subtitles','voiceover','review','revision','rereview'];
  const roles=Object.fromEntries(stages.map(stage=>[stage,['script','review','rereview'].includes(stage)?'director':'producer']));
  const stageTasks=Object.fromEntries(stages.map(stage=>[stage,{taskId:roles[stage]==='director'?'expert_task':'production_task',briefRef:{area:'inputs',relativePath:'brief.json'}}]));
  await call(members.director,'create_content_workflow',{...scope,briefRef:{area:'inputs',relativePath:'brief.json'},roles,stageTasks,requirements:{durationMs:1000,voiceoverRequired:true,subtitlesRequired:true}});
  async function complete(stage,inputs=[],files=[]){
    const owner=members[roles[stage]],taskId=stageTasks[stage].taskId,current=await call(owner,'get_content_workflow',scope);
    for(const versionId of inputs){const input=current.stages.find(item=>item.versionId===versionId);for(const artifactId of input.outputArtifactIds)await call(owner,'get_artifact',{groupId:scope.groupId,artifactId});}
    const reserved=await call(owner,'record_content_stage',{...scope,expectedRevision:current.workflow.revision,stage,status:'reserved',inputVersionIds:inputs});
    await call(owner,'start_task',{groupId:scope.groupId,taskId});
    const original=await call(owner,'submit_task_result',{groupId:scope.groupId,taskId,text:`${stage}本人合成原始回执，不是平台模型执行`});
    await call(owner,'write_task_file',{groupId:scope.groupId,taskId,area:'work',relativePath:`${stage}.json`,text:JSON.stringify(original)});
    if(stage==='edit'){fs.copyFileSync(path.join(taskRoots.production_task,'outputs/files/sample.mp4'),path.join(taskRoots.production_task,'outputs/files/secondary.mp4'));const ambiguous=await owner.callTool({name:'record_content_stage',arguments:{...scope,requestId:'ambiguous_primary_rejected',expectedRevision:reserved.workflow.revision,stage,stageId:reserved.stage.stageId,status:'succeeded',inputVersionIds:inputs,outputArtifactIds:[original.artifact.artifactId],outputFiles:[{relativePath:'sample.mp4'},{relativePath:'secondary.mp4'}],sourceReceiptRef:{area:'work',relativePath:`${stage}.json`}}});assert.equal(ambiguous.isError,true,'两个主视频不能由第一个静默代整版验收');assert.match(JSON.stringify(ambiguous),/CONTENT_PRIMARY_VIDEO_REQUIRED/);checks.push({name:'edit版本主成片必须唯一，拒绝多视频后原意图仍可按准确唯一文件完成',passed:true});}
    return call(owner,'record_content_stage',{...scope,expectedRevision:reserved.workflow.revision,stage,stageId:reserved.stage.stageId,status:'succeeded',inputVersionIds:inputs,outputArtifactIds:[original.artifact.artifactId],outputFiles:files.map(relativePath=>({relativePath})),sourceReceiptRef:{area:'work',relativePath:`${stage}.json`}});
  }
  const script=await complete('script');
  await call(members.producer,'get_artifact',{groupId:scope.groupId,artifactId:script.stage.outputArtifactIds[0]});
  const subtitle=path.join(taskRoots.production_task,'inputs/files/source.srt'),video=path.join(taskRoots.production_task,'outputs/files/sample.mp4');
  fs.writeFileSync(subtitle,'1\n00:00:00,000 --> 00:00:01,000\n合成字幕\n','utf8');
  const generation=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=128x128:rate=10','-f','lavfi','-i','sine=frequency=600:sample_rate=44100','-f','srt','-i',subtitle,'-t','1','-map','0:v:0','-map','1:a:0','-map','2:s:0','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-c:s','mov_text',video],{windowsHide:true,shell:false,timeout:15000,maxBuffer:65536});assert.equal(generation.status,0,generation.stderr?.toString());
  const produced=await complete('generation',[script.stage.versionId],['sample.mp4']);
  await call(members.director,'write_task_file',{groupId:scope.groupId,taskId:'expert_task',area:'work',relativePath:'audio-check.json',text:'{"source":"本人质量检查，技术事实另由宿主probe观察"}'});
  const originalQualityRequest={...scope,requestId:'quality_replay_acl_test',expectedRevision:produced.workflow.revision,versionId:produced.stage.versionId,checks:[{dimension:'audio_presence',status:'passed',method:'ffprobe',range:{startMs:0,endMs:1000},evidenceRef:{area:'work',relativePath:'audio-check.json'},note:'只检查实际音轨存在，不代表配音或听检'}]};
  const recorded=await call(members.director,'record_content_quality',originalQualityRequest);
  assert.equal(recorded.quality.mediaObservation.localProcessObserved,true);
  assert.equal(recorded.quality.mediaObservation.streams.some(stream=>stream.type==='audio'),true);
  assert.equal(recorded.quality.actualRangeVerified,true);
  assert.equal(recorded.quality.qualityVerified,false);
  assert.equal(recorded.quality.submittedBy,'director');
  assert.equal(recorded.quality.mediaObservation.actorActuallyCalledAgentTool,false);
  checks.push({name:'当前角色本人质量记录与实际宿主媒体探测分别存证，音轨不代听检',passed:true});
  const collected=await complete('collection',[produced.stage.versionId],['sample.mp4']);
  const wave=path.join(taskRoots.production_task,'outputs/files/voice.wav');
  const audio=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-nostdin','-n','-i',video,'-vn','-c:a','pcm_s16le',wave],{windowsHide:true,shell:false,timeout:15000,maxBuffer:65536});assert.equal(audio.status,0,audio.stderr?.toString());
  fs.copyFileSync(subtitle,path.join(taskRoots.production_task,'outputs/files/voice.srt'));
  const voiceStage=await complete('voiceover',[script.stage.versionId],['voice.wav']);
  const subtitleStage=await complete('subtitles',[script.stage.versionId],['voice.srt']);
  const edited=await complete('edit',[collected.stage.versionId,voiceStage.stage.versionId,subtitleStage.stage.versionId],['sample.mp4']);
  await call(members.director,'get_artifact',{groupId:scope.groupId,artifactId:edited.stage.outputArtifactIds[0]});
  const beforeReview=await call(members.director,'get_content_workflow',scope);
  const reviewIntent=await call(members.director,'record_content_stage',{...scope,expectedRevision:beforeReview.workflow.revision,stage:'review',status:'reserved',inputVersionIds:[edited.stage.versionId]});
  const failedQuality=await call(members.director,'record_content_quality',{...scope,expectedRevision:reviewIntent.workflow.revision,versionId:edited.stage.versionId,checks:[{dimension:'picture',status:'failed',method:'video_playback',range:{startMs:0,endMs:500},evidenceRef:{area:'work',relativePath:'audio-check.json'},note:'合成画面指定半段需返工，另半段不自动宣称已保全'}]});
  const reviewArtifact=await call(members.director,'publish_artifact',{groupId:scope.groupId,taskId:'expert_task',title:'本人合成评审',text:'仅前半秒需修订',readerIds:['director','producer']});
  await call(members.director,'write_task_file',{groupId:scope.groupId,taskId:'expert_task',area:'work',relativePath:'review.json',text:JSON.stringify(reviewArtifact)});
  const reviewDone=await call(members.director,'record_content_stage',{...scope,expectedRevision:failedQuality.workflow.revision,stage:'review',stageId:reviewIntent.stage.stageId,status:'succeeded',inputVersionIds:[edited.stage.versionId],outputArtifactIds:[reviewArtifact.artifact.artifactId],sourceReceiptRef:{area:'work',relativePath:'review.json'}});
  const rework=await call(members.director,'request_content_rework',{...scope,expectedRevision:reviewDone.workflow.revision,qualityId:failedQuality.quality.qualityId,issueIndexes:[0]});
  assert.equal(rework.rework.targetVersionId,edited.stage.versionId);
  assert.deepEqual(rework.rework.changedRanges,[{startMs:0,endMs:500}]);
  assert.deepEqual(rework.rework.preservedRanges,[{startMs:500,endMs:1000}]);
  assert.equal(rework.rework.preservationStatus,'claimed_preserved');
  assert.equal(rework.rework.contentPreservationVerified,false);
  checks.push({name:'manager仅能按原失败项请求一次返工，未检查范围保留为待核声明',passed:true});
  const repeatedRework=await members.director.callTool({name:'request_content_rework',arguments:{...scope,requestId:'second_rework_rejected',expectedRevision:rework.workflow.revision,qualityId:failedQuality.quality.qualityId,issueIndexes:[0]}});assert.equal(repeatedRework.isError,true);
  const revised=path.join(taskRoots.production_task,'outputs/files/revised.mp4');
  const revisionRun=spawnSync(tools.ffmpeg.path,['-hide_banner','-loglevel','error','-nostdin','-n','-i',video,'-vf',"hue=h=45:enable='lt(t,0.5)'",'-map','0:v:0','-map','0:a:0','-map','0:s:0','-c:v','libx264','-c:a','copy','-c:s','copy',revised],{windowsHide:true,shell:false,timeout:15000,maxBuffer:65536});assert.equal(revisionRun.status,0,revisionRun.stderr?.toString());
  const revisionStage=await complete('revision',[reviewDone.stage.versionId,edited.stage.versionId],['revised.mp4']);
  assert.equal(revisionStage.stage.preservation.contentPreservationVerified,false,'新文件不同且未独立比对，复述旧hash不能确认未变范围');
  assert.equal(revisionStage.stage.preservation.status,'claimed_preserved');
  await call(members.director,'get_artifact',{groupId:scope.groupId,artifactId:revisionStage.stage.outputArtifactIds[0]});
  const rereviewCurrent=await call(members.director,'get_content_workflow',scope);
  const rereviewIntent=await call(members.director,'record_content_stage',{...scope,expectedRevision:rereviewCurrent.workflow.revision,stage:'rereview',status:'reserved',inputVersionIds:[revisionStage.stage.versionId]});
  const rereviewQuality=await call(members.director,'record_content_quality',{...scope,expectedRevision:rereviewIntent.workflow.revision,versionId:revisionStage.stage.versionId,checks:[{dimension:'picture',status:'not_inspected',method:'not_inspected',range:{startMs:0,endMs:1000},evidenceRef:null,note:'复审合成记录不冒充实际已看全片'}]});
  const rereviewArtifact=await call(members.director,'publish_artifact',{groupId:scope.groupId,taskId:'expert_task',title:'本人合成复审',text:'仍有未检查维度，按预算停止',readerIds:['director','producer']});
  await call(members.director,'write_task_file',{groupId:scope.groupId,taskId:'expert_task',area:'work',relativePath:'rereview.json',text:JSON.stringify(rereviewArtifact)});
  const stopped=await call(members.director,'record_content_stage',{...scope,expectedRevision:rereviewQuality.workflow.revision,stage:'rereview',stageId:rereviewIntent.stage.stageId,status:'succeeded',inputVersionIds:[revisionStage.stage.versionId],outputArtifactIds:[rereviewArtifact.artifact.artifactId],sourceReceiptRef:{area:'work',relativePath:'rereview.json'}});
  assert.equal(stopped.workflow.state,'reviewed_with_gaps');
  assert.equal(stopped.workflow.businessCompletedVerified,false);
  checks.push({name:'一次修订与复审后未检查项仍停止，保留范围不由旧hash引用自动验真',passed:true});
  await call(members.director,'assign_task',{groupId:scope.groupId,taskId:'expert_task',assigneeId:'producer',participantIds:['director','producer'],fileAcl:{readers:['producer'],writers:['producer'],inputWriters:[]}});
  const replay=await call(members.director,'record_content_quality',originalQualityRequest);assert.equal(replay.deduplicated,true);assert.equal(replay.qualities.every(item=>item.redacted),true);assert.equal(replay.quality.redacted,true,'去重顶层quality也须受当前子任务ACL遮蔽');assert.equal(Object.hasOwn(replay.quality,'checks'),false);assert.equal(Object.hasOwn(replay.quality,'mediaObservation'),false);
  checks.push({name:'子任务读权撤销后原质量requestId重放，数组与顶层quality同时遮蔽，不回流旧检查正文',passed:true});
  fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify({status:'passed',checks,fixtureRoot:FIXTURE_ROOT,officialPlatformCalls:0,modelCalls:0,ttsCalls:0},null,2));console.log(JSON.stringify({status:'passed',checks:checks.length,fixtureRoot:FIXTURE_ROOT}));
}catch(error){fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({checks,error:error.message},null,2));throw error;}
finally{await Promise.allSettled(peers.map(peer=>peer.close()));if(service)await service.close();}
