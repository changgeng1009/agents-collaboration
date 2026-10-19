import {randomUUID} from 'node:crypto';
import {fail} from './policy.mjs';
import {operateTaskFile} from './collaboration-file-boundary.mjs';
import {SessionFiles} from './session-files.mjs';
import {validateQualityRecord,assessContentQuality,validateTargetDuration} from './content-quality.mjs';

export const CONTENT_TOOLS=['create_content_workflow','get_content_workflow','record_content_stage','record_content_quality','request_content_rework'];
export const CONTENT_STAGES=['script','generation','collection','edit','subtitles','voiceover','review','revision','rereview'];

export class CollaborationContent{
  constructor(store){this.store=store;}
  task(identity,args){
    const task=this.store.task(identity,args.groupId,args.taskId);
    if(!task.workspace||!task.scope)fail('WORKSPACE_NOT_READY','制作合同需要已绑定的任务目录。');
    if(!task.fileAcl.readers.includes(identity.instanceId))fail('FILE_ACL_FORBIDDEN','制作合同及来源仅向当前任务文件读者开放。');
    new SessionFiles({workspace:task.workspace,scope:task.scope});
    return task;
  }
  workflow(identity,args){
    const task=this.task(identity,args),workflow=this.store.get('content_workflow',`${args.groupId}:${args.taskId}`);
    if(workflow.workspaceBinding!==task.workspace.markerSha256)fail('CONTENT_BINDING_CHANGED','协调任务原目录已变化，禁止自动接管制作链。');
    const brief=operateTaskFile(this.store,task,'read',workflow.brief.reference);
    if(brief.sha256!==workflow.brief.sha256)fail('CONTENT_BRIEF_CHANGED','原brief已变化，原合同保留，不以新输入继续原制作链。');
    for(const stage of CONTENT_STAGES)this.stageTask(identity,workflow,stage);
    return{task,workflow};
  }
  stageTask(identity,workflow,stage){
    const binding=workflow.stageTasks[stage],task=this.task(identity,{groupId:workflow.groupId,taskId:binding.taskId});
    if(task.assignmentRevision!==binding.assignmentRevision||task.assigneeId!==workflow.roles[stage]||task.workspace.markerSha256!==binding.workspaceBinding)fail('CONTENT_BINDING_CHANGED','阶段任务负责人或原目录改变，不自动改派或接管。');
    const brief=operateTaskFile(this.store,task,'read',binding.briefRef);
    if(brief.sha256!==workflow.brief.sha256)fail('CONTENT_BRIEF_CHANGED','阶段任务的brief不再与原合同一致。');
    return task;
  }
  view(workflow){return{workflow,stages:workflow.stageIds.map(id=>this.store.get('content_stage',id)),qualities:workflow.qualityIds.map(id=>this.store.get('content_quality',id)),rework:workflow.reworkId?this.store.get('content_rework',workflow.reworkId):null};}
  history(identity,args){
    const anchor=this.store.task(identity,args.groupId,args.taskId);
    if(!anchor.fileAcl.readers.includes(identity.instanceId))fail('FILE_ACL_FORBIDDEN','当前协调任务ACL不允许读取历史制作记录。');
    const workflow=this.store.get('content_workflow',`${args.groupId}:${args.taskId}`),bindingBlockers=[];
    try{this.workflow(identity,args);}catch(error){bindingBlockers.push({code:error.code??'CONTENT_BINDING_UNVERIFIED',message:'原历史保留；当前任务、brief或阶段绑定不允许继续。'});}
    const stages=workflow.stageIds.map(id=>{
      const record=this.store.get('content_stage',id);
      try{const task=this.store.task(identity,args.groupId,record.taskId);if(!task.fileAcl.readers.includes(identity.instanceId))throw new Error('revoked');return record;}
      catch{return{stageId:id,stage:record.stage,redacted:true,blocker:'FILE_ACL_FORBIDDEN'};}
    });
    const visibleVersions=new Set(stages.filter(stage=>!stage.redacted).map(stage=>stage.versionId));
    const qualities=workflow.qualityIds.map(id=>{const record=this.store.get('content_quality',id);let readable=false;try{readable=this.store.task(identity,args.groupId,record.sourceTaskId).fileAcl.readers.includes(identity.instanceId);}catch{}return readable&&visibleVersions.has(record.versionId)?record:{qualityId:id,redacted:true,blocker:'FILE_ACL_FORBIDDEN'};});
    const originalRework=workflow.reworkId?this.store.get('content_rework',workflow.reworkId):null;
    const rework=originalRework?(visibleVersions.has(originalRework.targetVersionId)&&qualities.some(item=>!item.redacted&&item.qualityId===originalRework.qualityId)?originalRework:{reworkId:originalRework.reworkId,redacted:true,blocker:'FILE_ACL_FORBIDDEN'}):null;
    return{workflow,stages,qualities,rework,bindingBlockers,canRecordNextStage:bindingBlockers.length===0&&workflow.state==='active'};
  }
  recordStage(identity,args,workflow){
    const store=this.store,owner=workflow.roles[args.stage],task=this.stageTask(identity,workflow,args.stage);
    if(workflow.revision!==args.expectedRevision)fail('CONTENT_REVISION_CONFLICT','制作版本已变化，请先读回当前版本。');
    if(workflow.state!=='active')fail('CONTENT_WORKFLOW_STOPPED','制作链已停止或未知，不能换请求或阶段继续。');
    if(identity.instanceId!==owner)fail('CONTENT_ROLE_REQUIRED','只有原阶段角色本人可提交自己的阶段回执。');
    if(!task.fileAcl.writers.includes(owner))fail('FILE_ACL_FORBIDDEN','阶段本人没有当前任务文件写权限，合同不扩权。');
    const stages=workflow.stageIds.map(id=>store.get('content_stage',id)),inputs=args.inputVersionIds.map(id=>{
      const version=stages.find(item=>item.versionId===id&&item.status==='succeeded');
      if(!version)fail('CONTENT_INPUT_VERSION_INVALID','输入版本须为本合同已完成的明确阶段版本。');
      for(const artifactId of version.outputArtifactIds)store.checkSources(identity,workflow.groupId,[{kind:'artifact',id:artifactId}],store.get('task',`${workflow.groupId}:${workflow.taskId}`).fileAcl.readers);
      for(const file of version.files){const current=store.media.inspectContentOutput(identity,{groupId:workflow.groupId,taskId:version.taskId,relativePath:file.relativePath},{write:false});if(current.sha256!==file.sha256||JSON.stringify(current.fileIdentity)!==JSON.stringify(file.fileIdentity))fail('CONTENT_VERSION_FILE_CHANGED','输入版本的实际文件已变化，不能沿用旧hash继续制作。');}
      return version;
    });
    const dependencies={script:[],generation:['script'],collection:['generation'],voiceover:['script'],subtitles:['script'],edit:['collection',...(workflow.requirements.voiceoverRequired?['voiceover']:[]),...(workflow.requirements.subtitlesRequired?['subtitles']:[])],review:['edit'],revision:['review'],rereview:['revision']};
    if(dependencies[args.stage].some(stage=>!inputs.some(input=>input.stage===stage)))fail('CONTENT_PREDECESSOR_REQUIRED','缺少本阶段必需的已完成输入版本。');
    if(args.stage==='revision'){
      const rework=workflow.reworkId?store.get('content_rework',workflow.reworkId):null;
      if(!rework||!args.inputVersionIds.includes(rework.targetVersionId))fail('CONTENT_REWORK_REQUIRED','修订必须引用manager明确失败项及目标原版本。');
    }
    let record;
    if(args.status==='reserved'){
      if(args.stageId!==null||stages.some(item=>item.stage===args.stage))fail('CONTENT_STAGE_ALREADY_RESERVED','阶段已有原意图，不换编号重复执行。');
      if(args.outputArtifactIds.length||args.outputFiles.length||args.sourceReceiptRef||args.nativeReferences.length)fail('CONTENT_RESERVATION_INVALID','阶段意图必须先于结果登记，不接受事后伪造占位。');
      record={stageId:randomUUID(),workflowId:workflow.workflowId,stage:args.stage,groupId:workflow.groupId,taskId:task.taskId,workspaceBinding:task.workspace.markerSha256,assignmentRevision:task.assignmentRevision,briefSha256:workflow.brief.sha256,status:'reserved',inputVersionIds:args.inputVersionIds,outputArtifactIds:[],files:[],versionId:null,submittedBy:identity.instanceId,createdAt:new Date().toISOString(),events:[],hostObservations:[],evidenceLevel:'member_submitted',modelExecutionVerified:false,businessCompletedVerified:false};
      workflow.stageIds.push(record.stageId);
    }else{
      record=stages.find(item=>item.stageId===args.stageId&&item.stage===args.stage);
      if(!record||record.submittedBy!==identity.instanceId)fail('CONTENT_STAGE_INTENT_REQUIRED','必须引用本人本阶段原意图。');
      if(JSON.stringify(record.inputVersionIds)!==JSON.stringify(args.inputVersionIds))fail('CONTENT_STAGE_INPUT_CHANGED','原阶段输入版本不可改变。');
      const transitions={reserved:['submitted','succeeded','failed','blocked','unknown'],submitted:['running','succeeded','failed','unknown'],running:['succeeded','failed','unknown']};
      if(!transitions[record.status]?.includes(args.status))fail('CONTENT_STAGE_TERMINAL','原阶段已终止或未知，不倒退重做。');
      record.status=args.status;
      for(const artifactId of args.outputArtifactIds){
        const artifact=store.artifact(identity,workflow.groupId,artifactId);
        if(artifact.taskId!==task.taskId||artifact.authorId!==identity.instanceId)fail('CONTENT_OUTPUT_AUTHOR_REQUIRED','阶段成果必须来自本阶段明确任务及角色本人。');
        store.checkSources(identity,workflow.groupId,[{kind:'artifact',id:artifactId}],store.get('task',`${workflow.groupId}:${workflow.taskId}`).fileAcl.readers);
      }
      if(args.status==='succeeded'&&!args.outputArtifactIds.length)fail('CONTENT_OUTPUT_REQUIRED','完成声明须引用本人原始成果。');
      if(args.status==='succeeded'&&!args.sourceReceiptRef)fail('CONTENT_RECEIPT_REQUIRED','成功阶段必须引用原始回执文件，成员声明仍不提升真实平台执行。');
      record.outputArtifactIds=args.outputArtifactIds;
      record.files=args.outputFiles.map(file=>store.media.inspectContentOutput(identity,{groupId:workflow.groupId,taskId:task.taskId,...file}));
      const requiredFileType={collection:'video',edit:'video',revision:'video',voiceover:'audio',subtitles:'subtitles'}[args.stage];
      if(args.status==='succeeded'&&requiredFileType&&!record.files.some(file=>file.contentType===requiredFileType))fail('CONTENT_MEDIA_OUTPUT_REQUIRED','该制作阶段必须绑定broker实际读回的媒体文件版本。');
      if(args.status==='succeeded'&&['edit','revision'].includes(args.stage)&&record.files.filter(file=>file.contentType==='video').length!==1)fail('CONTENT_PRIMARY_VIDEO_REQUIRED','edit与revision必须绑定恰好一个主成片，不能默选首个视频代表整个版本。');
      record.sourceReceipt=args.sourceReceiptRef?{reference:args.sourceReceiptRef,...((({sha256,byteLength})=>({sha256,byteLength}))(operateTaskFile(store,task,'read',args.sourceReceiptRef))),platformOriginVerified:false}:null;
      for(const ref of args.nativeReferences)if(ref.kind==='session'){
        if(ref.platform!==identity.platform||ref.mode!==identity.mode||!['session_id','sessionId','conversationId','conversation_id',...(ref.platform==='workbuddy'&&ref.mode==='cloud'?['task_id']:[])].includes(ref.fieldName))fail('CONTENT_NATIVE_FIELD_INVALID','原生字段须属于本人平台模式，消息或连接编号不能代替。');
        if([workflow.workflowId,workflow.groupId,workflow.taskId,task.workspace.taskId,identity.instanceId,...workflow.stageIds].includes(ref.value)||['message','artifact','execution','statement'].some(kind=>store.get(kind,ref.value,false)))fail('CONTENT_NATIVE_ID_CONFLICT','已知本地消息、成果或执行编号不能冒充原生会话。');
      }
      record.nativeReferences=args.nativeReferences.map(ref=>({...ref,evidence:'member_reported',runtimeVerified:false}));
      if(args.status==='succeeded')record.versionId=randomUUID();
      if(args.status==='succeeded'&&args.stage==='revision'){
        const rework=store.get('content_rework',workflow.reworkId);
        record.preservation={status:'claimed_preserved',sourceVersionId:rework.targetVersionId,preservedRanges:rework.preservedRanges,originalFiles:rework.targetFiles,revisedFiles:record.files,originalSourceStillIntact:true,contentPreservationVerified:false,reason:'原版本文件已独立重核；新版本对应范围尚无可信内容比较，不以复述hash验真'};
      }
      if(args.status==='succeeded'&&['review','rereview'].includes(args.stage)){
        const target=inputs.find(input=>input.stage===(args.stage==='review'?'edit':'revision'));
        const quality=workflow.qualityIds.map(id=>store.get('content_quality',id)).find(item=>item.versionId===target?.versionId&&item.submittedBy===identity.instanceId);
        if(!quality)fail('CONTENT_QUALITY_REQUIRED','评审完成须有同一目标版本和本人质量记录。');
        record.qualityId=quality.qualityId;
        const assessment=assessContentQuality([quality],{versionId:quality.versionId,...workflow.requirements,durationMs:quality.durationMs});
        record.assessment=assessment;
        if(args.stage==='rereview'||assessment.allRequiredChecksReportedPassed||!quality.checks.some(check=>check.status==='failed'))workflow.state=assessment.allRequiredChecksReportedPassed?'reviewed_reported_pass':'reviewed_with_gaps';
      }
      if(['unknown','failed','blocked'].includes(args.status))workflow.state=args.status;
    }
    record.events.push({status:args.status,submittedBy:identity.instanceId,at:new Date().toISOString(),sourceReceipt:record.sourceReceipt??null});
    workflow.revision++;
    store.put('content_stage',record.stageId,record);store.put('content_workflow',`${workflow.groupId}:${workflow.taskId}`,workflow);
    store.event(identity,'content_stage_recorded',workflow.groupId,{taskId:workflow.taskId,stageId:record.stageId,status:record.status});
    return{...this.view(workflow),stage:record};
  }
  recordQuality(identity,args,workflow){
    const store=this.store;
    if(args.expectedRevision!==workflow.revision)fail('CONTENT_REVISION_CONFLICT','质量记录引用的制作版本已变化。');
    if(workflow.state!=='active')fail('CONTENT_WORKFLOW_STOPPED','未知或停止制作链不能继续质量验收。');
    const version=workflow.stageIds.map(id=>store.get('content_stage',id)).find(stage=>stage.versionId===args.versionId&&stage.status==='succeeded');
    if(!version?.files.some(file=>file.contentType==='video'))fail('CONTENT_QUALITY_MEDIA_REQUIRED','质量记录必须绑定broker核过的具体视频版本。');
    if(version.files.filter(file=>file.contentType==='video').length!==1)fail('CONTENT_PRIMARY_VIDEO_REQUIRED','质量主体须为唯一视频文件；多份素材不能合并套用一个探测。');
    const role=version.stage==='revision'?'rereview':'review',reviewTask=this.stageTask(identity,workflow,role);
    if(identity.instanceId!==workflow.roles[role]||!reviewTask.fileAcl.writers.includes(identity.instanceId))fail('CONTENT_QUALITY_ROLE_REQUIRED','只有原评审角色本人及其当前文件权限可记录检查。');
    if(workflow.qualityIds.some(id=>store.get('content_quality',id).versionId===version.versionId))fail('CONTENT_QUALITY_ALREADY_RECORDED','该版本已有原质量记录，不追加评审轮次或覆盖原判断。');
    if(['edit','revision'].includes(version.stage)&&!workflow.stageIds.some(id=>{const stage=store.get('content_stage',id);return stage.stage===role&&['reserved','submitted','running'].includes(stage.status)&&stage.inputVersionIds.includes(version.versionId);}))fail('CONTENT_REVIEW_INTENT_REQUIRED','完整评审须先有本人本版本的阶段意图。');
    for(const file of version.files){const current=store.media.inspectContentOutput(identity,{groupId:workflow.groupId,taskId:version.taskId,relativePath:file.relativePath},{write:false});if(current.sha256!==file.sha256||current.byteLength!==file.byteLength)fail('CONTENT_VERSION_FILE_CHANGED','质量目标文件已偏离原登记版本。');}
    const needsProbe=args.checks.some(check=>check.status==='passed')||store.contentMediaTools&&args.checks.some(check=>check.status!=='not_inspected');
    const mediaObservation=needsProbe?store.media.probeContentOutput(identity,{groupId:workflow.groupId,taskId:version.taskId,relativePath:version.files.find(file=>file.contentType==='video').relativePath}):null;
    if(mediaObservation&&['edit','revision'].includes(version.stage))validateTargetDuration(mediaObservation.durationMs,workflow.requirements.durationMs);
    if(mediaObservation&&args.checks.some(check=>check.dimension==='audio_presence'&&check.status==='passed')&&!mediaObservation.streams.some(stream=>stream.type==='audio'))fail('QUALITY_AUDIO_MISSING','实际版本没有音轨，不能登记音轨存在通过。');
    const context={versionId:args.versionId,...workflow.requirements,durationMs:mediaObservation?.durationMs??workflow.requirements.durationMs};
    const validated=validateQualityRecord({versionId:args.versionId,checks:args.checks},context);
    const receipts=args.checks.map(check=>check.evidenceRef?{reference:check.evidenceRef,...((({sha256,byteLength})=>({sha256,byteLength}))(operateTaskFile(store,reviewTask,'read',check.evidenceRef))),platformOriginVerified:false}:null);
    const quality={qualityId:randomUUID(),workflowId:workflow.workflowId,versionId:args.versionId,sourceTaskId:reviewTask.taskId,submittedBy:identity.instanceId,subjectFiles:version.files,checks:validated.checks,receipts,mediaObservation,createdAt:new Date().toISOString(),durationMs:context.durationMs,durationBasis:mediaObservation?'trusted_host_probe':'brief_target_not_verified_media_duration',actualRangeVerified:mediaObservation!==null,evidenceLevel:'member_submitted',qualityVerified:false,businessCompletedVerified:false};
    workflow.qualityIds.push(quality.qualityId);workflow.revision++;
    store.put('content_quality',quality.qualityId,quality);store.put('content_workflow',`${workflow.groupId}:${workflow.taskId}`,workflow);store.event(identity,'content_quality_recorded',workflow.groupId,{taskId:workflow.taskId,qualityId:quality.qualityId,versionId:quality.versionId});
    return{...this.view(workflow),quality};
  }
  requestRework(identity,args,workflow){
    const store=this.store;store.manager(identity,workflow.groupId);
    if(args.expectedRevision!==workflow.revision)fail('CONTENT_REVISION_CONFLICT','返工依据版本已变化。');
    if(workflow.state!=='active'||workflow.reworkId)fail('CONTENT_REWORK_LIMIT','制作链停止或已用过一次返工，不换请求追加。');
    const quality=workflow.qualityIds.includes(args.qualityId)?store.get('content_quality',args.qualityId):null;
    const target=quality?workflow.stageIds.map(id=>store.get('content_stage',id)).find(stage=>stage.versionId===quality.versionId&&stage.stage==='edit'):null;
    if(!quality||!target||!workflow.stageIds.some(id=>{const stage=store.get('content_stage',id);return stage.stage==='review'&&stage.status==='succeeded'&&stage.qualityId===quality.qualityId;}))fail('CONTENT_REWORK_QUALITY_REQUIRED','返工必须引用原成片的已交付评审和质量记录。');
    if(new Set(args.issueIndexes).size!==args.issueIndexes.length||args.issueIndexes.some(index=>quality.checks[index]?.status!=='failed'))fail('CONTENT_REWORK_ISSUE_INVALID','只能选择原质量记录中的失败项。');
    const selected=args.issueIndexes.map(index=>({index,...quality.checks[index]})),sorted=selected.map(check=>check.range).sort((a,b)=>a.startMs-b.startMs),changedRanges=[];
    for(const range of sorted){const last=changedRanges.at(-1);if(last&&range.startMs<=last.endMs)last.endMs=Math.max(last.endMs,range.endMs);else changedRanges.push({...range});}
    const preservedRanges=[];let cursor=0;for(const range of changedRanges){if(range.startMs>cursor)preservedRanges.push({startMs:cursor,endMs:range.startMs});cursor=range.endMs;}if(cursor<quality.durationMs)preservedRanges.push({startMs:cursor,endMs:quality.durationMs});
    const rework={reworkId:randomUUID(),workflowId:workflow.workflowId,qualityId:quality.qualityId,targetVersionId:target.versionId,requestedBy:identity.instanceId,assignedTo:workflow.roles.revision,targetFiles:target.files,selectedIssues:selected.map(check=>({index:check.index,dimension:check.dimension,range:check.range})),changedRanges,preservedRanges,preservationStatus:'claimed_preserved',contentPreservationVerified:false,createdAt:new Date().toISOString()};
    workflow.reworkId=rework.reworkId;workflow.revision++;store.put('content_rework',rework.reworkId,rework);store.put('content_workflow',`${workflow.groupId}:${workflow.taskId}`,workflow);store.event(identity,'content_rework_requested',workflow.groupId,{taskId:workflow.taskId,reworkId:rework.reworkId});
    return{...this.view(workflow),rework};
  }
  async invoke(identity,name,args){
    const result=await this.store.perform(identity,name,args,()=>{
      const store=this.store,key=`${args.groupId}:${args.taskId}`;
      if(name==='create_content_workflow'){
        store.manager(identity,args.groupId);
        const task=this.task(identity,args);
        if(store.get('content_workflow',key,false))fail('CONTENT_WORKFLOW_EXISTS','该任务已有制作合同，禁止换编号绕过历史或未知状态。');
        for(const memberId of Object.values(args.roles)){
          store.member(memberId);
          if(!task.participantIds.includes(memberId)||!task.fileAcl.readers.includes(memberId))fail('CONTENT_ROLE_FORBIDDEN','制作角色须为本任务已有文件读者，创建合同不扩权。');
        }
        const brief=operateTaskFile(store,task,'read',args.briefRef);
        const stageTasks={};
        for(const stage of CONTENT_STAGES){
          const requested=args.stageTasks[stage],child=this.task(identity,{groupId:args.groupId,taskId:requested.taskId});
          if(child.assigneeId!==args.roles[stage]||!child.fileAcl.writers.includes(args.roles[stage])||task.fileAcl.readers.some(id=>!child.fileAcl.readers.includes(id)))fail('CONTENT_STAGE_TASK_FORBIDDEN','阶段须显式绑定本人负责且已有足够ACL的任务，不自动改派或扩权。');
          if(operateTaskFile(store,child,'read',requested.briefRef).sha256!==brief.sha256)fail('CONTENT_BRIEF_MISMATCH','阶段任务必须由manager预先提供同一份brief。');
          stageTasks[stage]={...requested,workspaceBinding:child.workspace.markerSha256,assignmentRevision:child.assignmentRevision};
        }
        const workflow={workflowId:randomUUID(),groupId:args.groupId,taskId:args.taskId,workspaceBinding:task.workspace.markerSha256,brief:{reference:args.briefRef,sha256:brief.sha256,byteLength:brief.byteLength},roles:args.roles,stageTasks,requirements:args.requirements,revision:1,state:'active',stageIds:[],qualityIds:[],reworkId:null,createdBy:identity.instanceId,createdAt:new Date().toISOString(),evidenceLevel:'contract_only',modelExecutionVerified:false,businessCompletedVerified:false};
        store.put('content_workflow',key,workflow);
        store.event(identity,name,args.groupId,{taskId:args.taskId,workflowId:workflow.workflowId,briefSha256:brief.sha256});
        return{workflow};
      }
      if(name==='get_content_workflow')return this.history(identity,args);
      const{workflow}=this.workflow(identity,args);
      if(name==='record_content_stage')return this.recordStage(identity,args,workflow);
      if(name==='record_content_quality')return this.recordQuality(identity,args,workflow);
      if(name==='request_content_rework')return this.requestRework(identity,args,workflow);
      fail('CONTENT_TOOL_UNSUPPORTED','制作操作尚未登记。');
    });
    if(result.deduplicated){
      const current=this.history(identity,args);
      return{...current,deduplicated:true,...(result.stage?{stage:current.stages.find(stage=>stage.stageId===result.stage.stageId)??{stageId:result.stage.stageId,redacted:true,blocker:'FILE_ACL_FORBIDDEN'}}:{}),...(result.quality?{quality:current.qualities.find(quality=>quality.qualityId===result.quality.qualityId)??{qualityId:result.quality.qualityId,redacted:true,blocker:'FILE_ACL_FORBIDDEN'}}:{})};
    }
    return result;
  }
}
