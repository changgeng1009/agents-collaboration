import {FIXTURE_ROOT} from './test-context.mjs';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Client} from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import {StreamableHTTPClientTransport} from '../bridge/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';
import {startCollaborationService} from '../bridge/src/collaboration-service.mjs';
import {snapshotClosedRuntime,restoreClosedRuntime,assessUpgradeReadiness,logicalDatabaseDigest} from '../bridge/src/release-recovery.mjs';

const directory=path.join(FIXTURE_ROOT,'logs/content-tests');
fs.mkdirSync(directory,{recursive:true});
const clients=[],checks=[];
let service,sequence=0;
async function connect(file){
  const peer=new Client({name:'isolated_content_fixture',version:'0.2.14'});
  clients.push(peer);
  await peer.connect(new StreamableHTTPClientTransport(new URL(service.service.endpoint),{
    requestInit:{headers:{Authorization:`Bearer ${fs.readFileSync(file,'utf8')}`}}
  }));
  return peer;
}
async function call(peer,name,args={}){
  const reply=await peer.callTool({name,arguments:{...(!name.startsWith('get_')?{requestId:`content_${++sequence}`} : {}),...args}});
  const value=reply.structuredContent??JSON.parse(reply.content[0].text);
  assert.notEqual(reply.isError,true,JSON.stringify(value));
  return value;
}
try{
  service=await startCollaborationService({port:0,runtimeNamespace:'ContentFixture'});
  const admin=await connect(service.service.adminKeyFile),members={};
  for(const id of ['director','producer']){
    const created=await call(admin,'provision_member',{instanceId:id,platform:'fixture',mode:'offline'});
    members[id]=await connect(created.credentialFile);
  }
  await call(admin,'create_group',{groupId:'content_group',title:'隔离内容版本链',memberIds:['director','producer'],managerId:'director',policy:{allowMemberTakeover:false}});
  const scope={groupId:'content_group',taskId:'content_task'};
  const taskCreated=await call(members.director,'create_task',{...scope,title:'合成内容任务',assigneeId:'producer',participantIds:['director','producer'],fileAcl:{readers:['director','producer'],writers:['director','producer'],inputWriters:['director']}});
  const briefText=JSON.stringify({schema:'synthetic_content_brief',topic:'仅合成离线验证，不是真实公司brief'});
  const brief=await call(members.director,'write_task_file',{...scope,area:'inputs',relativePath:'brief.json',text:briefText});
  await call(members.director,'create_task',{...scope,taskId:'expert_task',title:'同brief专家任务',assigneeId:'director',participantIds:['director','producer'],fileAcl:{readers:['director','producer'],writers:['director','producer'],inputWriters:['director']}});
  await call(members.director,'write_task_file',{...scope,taskId:'expert_task',area:'inputs',relativePath:'brief.json',text:briefText});
  const roles=Object.fromEntries(['script','generation','collection','edit','subtitles','voiceover','review','revision','rereview'].map(stage=>[stage,['script','review','rereview'].includes(stage)?'director':'producer']));
  const stageTasks=Object.fromEntries(Object.entries(roles).map(([stage,owner])=>[stage,{taskId:owner==='director'?'expert_task':scope.taskId,briefRef:{area:'inputs',relativePath:'brief.json'}}]));
  const created=await call(members.director,'create_content_workflow',{...scope,briefRef:{area:'inputs',relativePath:'brief.json'},roles,stageTasks,requirements:{durationMs:30000,voiceoverRequired:true,subtitlesRequired:true}});
  const read=await call(members.producer,'get_content_workflow',scope);
  assert.equal(read.workflow.workflowId,created.workflow.workflowId);
  assert.equal(read.workflow.brief.sha256,brief.sha256);
  assert.equal(read.workflow.roles.script,'director');
  assert.equal(read.workflow.roles.generation,'producer');
  assert.equal(read.workflow.stageTasks.script.taskId,'expert_task');
  assert.equal(read.workflow.stageTasks.generation.taskId,'content_task');
  assert.equal(read.workflow.revision,1);
  assert.equal(read.workflow.businessCompletedVerified,false);
  assert.equal(read.task,undefined,'制作合同读回不能泄露内部目录scope对象');
  checks.push({name:'manager绑定实际brief，两名成员按原权限读回同一制作合同',passed:true});
  const scriptIntent=await call(members.director,'record_content_stage',{...scope,expectedRevision:1,stage:'script',status:'reserved'});
  await call(members.director,'start_task',{...scope,taskId:'expert_task'});
  const scriptArtifact=await call(members.director,'submit_task_result',{...scope,taskId:'expert_task',text:'本人合成脚本，不冒充真实专家'});
  const missingReceipt=await members.director.callTool({name:'record_content_stage',arguments:{...scope,requestId:'missing_receipt',expectedRevision:2,stage:'script',stageId:scriptIntent.stage.stageId,status:'succeeded',outputArtifactIds:[scriptArtifact.artifact.artifactId]}});
  assert.equal(missingReceipt.isError,true,'成功阶段必须有原始回执引用，文本artifact本身不代替');
  await call(members.director,'write_task_file',{...scope,taskId:'expert_task',area:'work',relativePath:'script-receipt.json',text:JSON.stringify(scriptArtifact)});
  const scriptStage=await call(members.director,'record_content_stage',{...scope,expectedRevision:2,stage:'script',stageId:scriptIntent.stage.stageId,status:'succeeded',outputArtifactIds:[scriptArtifact.artifact.artifactId],sourceReceiptRef:{area:'work',relativePath:'script-receipt.json'}});
  await call(members.producer,'get_artifact',{groupId:scope.groupId,artifactId:scriptArtifact.artifact.artifactId});
  const generationIntent=await call(members.producer,'record_content_stage',{...scope,expectedRevision:3,stage:'generation',status:'reserved',inputVersionIds:[scriptStage.stage.versionId]});
  await call(members.producer,'start_task',scope);
  const generationArtifact=await call(members.producer,'submit_task_result',{...scope,text:'本人合成生成来源回执，不证明模型执行'});
  await call(members.producer,'write_task_file',{...scope,area:'work',relativePath:'generation-receipt.json',text:JSON.stringify(generationArtifact)});
  const mediaBytes=Buffer.from([0,0,0,24,102,116,121,112,105,115,111,109,0,0,0,0,105,115,111,109,109,112,52,50]);
  fs.writeFileSync(path.join(taskCreated.task.taskRoot,'outputs/files/registered-generation.mp4'),mediaBytes);
  const falseNative=await members.producer.callTool({name:'record_content_stage',arguments:{...scope,requestId:'known_local_id_as_session',expectedRevision:4,stage:'generation',stageId:generationIntent.stage.stageId,status:'succeeded',inputVersionIds:[scriptStage.stage.versionId],outputArtifactIds:[generationArtifact.artifact.artifactId],sourceReceiptRef:{area:'work',relativePath:'generation-receipt.json'},nativeReferences:[{kind:'session',platform:'fixture',mode:'offline',fieldName:'session_id',value:scriptArtifact.artifact.artifactId}]}});
  assert.equal(falseNative.isError,true,'已有本地artifact编号不能冒充原生会话');
  const generationStage=await call(members.producer,'record_content_stage',{...scope,expectedRevision:4,stage:'generation',stageId:generationIntent.stage.stageId,status:'succeeded',inputVersionIds:[scriptStage.stage.versionId],outputArtifactIds:[generationArtifact.artifact.artifactId],sourceReceiptRef:{area:'work',relativePath:'generation-receipt.json'},outputFiles:[{relativePath:'registered-generation.mp4'}]});
  assert.equal(generationStage.stage.files[0].sha256,createHash('sha256').update(mediaBytes).digest('hex'));
  assert.equal(generationStage.stage.files[0].byteLength,24);
  assert.equal(generationStage.stage.files[0].playabilityVerified,false);
  const chain=await call(members.director,'get_content_workflow',scope);
  assert.equal(chain.stages.length,2);
  assert.equal(chain.stages[0].submittedBy,'director');
  assert.equal(chain.stages[1].submittedBy,'producer');
  assert.equal(chain.stages[0].taskId,'expert_task');
  assert.equal(chain.stages[1].taskId,'content_task');
  assert.deepEqual(chain.stages[1].inputVersionIds,[chain.stages[0].versionId]);
  for(const stage of chain.stages){assert.equal(stage.evidenceLevel,'member_submitted');assert.equal(stage.modelExecutionVerified,false);assert.deepEqual(stage.hostObservations,[]);}
  checks.push({name:'两个本人在显式阶段task提交原成果，宿主不代称专家调用新工具',passed:true});
  const quality=await call(members.director,'record_content_quality',{...scope,expectedRevision:5,versionId:generationStage.stage.versionId,checks:[{dimension:'picture',status:'not_inspected',method:'not_inspected',range:{startMs:0,endMs:30000},evidenceRef:null,note:'只有容器签名，尚未观看或解码'}]});
  assert.equal(quality.quality.submittedBy,'director');
  assert.equal(quality.quality.subjectFiles[0].sha256,generationStage.stage.files[0].sha256);
  assert.equal(quality.quality.qualityVerified,false);
  const collectionRequest={...scope,requestId:'collection_once',expectedRevision:6,stage:'collection',status:'reserved',inputVersionIds:[generationStage.stage.versionId]};
  const collection=await call(members.producer,'record_content_stage',collectionRequest);
  await call(members.producer,'record_content_stage',{...scope,expectedRevision:7,stage:'collection',stageId:collection.stage.stageId,status:'unknown',inputVersionIds:[generationStage.stage.versionId]});
  const repeated=await call(members.producer,'record_content_stage',collectionRequest);
  assert.equal(repeated.deduplicated,true);
  assert.equal(repeated.workflow.state,'unknown','历史请求去重不能用过时active回执遮住当前unknown');
  checks.push({name:'历史请求去重返回当前停点，不把旧active当恢复许可',passed:true});
  await call(members.director,'assign_task',{...scope,taskId:'expert_task',assigneeId:'producer',participantIds:['director','producer'],fileAcl:{readers:['director','producer'],writers:['director','producer'],inputWriters:['director']}});
  const historical=await call(members.director,'get_content_workflow',scope);
  assert.equal(historical.workflow.workflowId,created.workflow.workflowId);
  assert.equal(historical.stages.length,3);
  assert.ok(historical.bindingBlockers.some(item=>item.code==='CONTENT_BINDING_CHANGED'));
  assert.equal(historical.canRecordNextStage,false);
  checks.push({name:'阶段负责人变化后当前ACL允许读原历史，继续写入保持阻塞',passed:true});
  for(const id of ['spare_one','spare_two'])await call(admin,'provision_member',{instanceId:id,platform:'fixture',mode:'offline'});
  const runtimeRoot=path.dirname(service.service.dbPath),credentialFiles=[path.join(runtimeRoot,'admin-key.txt'),...fs.readdirSync(path.join(runtimeRoot,'credentials')).map(name=>path.join(runtimeRoot,'credentials',name))];assert.equal(credentialFiles.length,5);const originalCredentials=credentialFiles.map(file=>({relativePath:path.relative(runtimeRoot,file),sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
  await Promise.all(clients.splice(0).map(peer=>peer.close()));await service.close();service=null;
  const beforeDigest=logicalDatabaseDigest(path.join(runtimeRoot,'collaboration.sqlite')),snapshot=snapshotClosedRuntime({runtimeRoot,backupRoot:path.join(directory,'closed-backup'),credentialFiles});assert.equal(snapshot.files.length,6);
  service=await startCollaborationService({port:0,runtimeNamespace:'ContentFixture'});const directorFile=credentialFiles.find(file=>service.store.resolveCredential(fs.readFileSync(file,'utf8'))?.instanceId==='director'),reopenedDirector=await connect(directorFile);await call(reopenedDirector,'send_message',{groupId:scope.groupId,broadcast:true,body:'仅隔离恢复验证的后续新增记录'});await Promise.all(clients.splice(0).map(peer=>peer.close()));await service.close();service=null;
  const restored=restoreClosedRuntime({runtimeRoot,snapshotManifestPin:snapshot.manifestPin});assert.equal(restored.status,'restored');assert.deepEqual(logicalDatabaseDigest(path.join(runtimeRoot,'collaboration.sqlite')),beforeDigest);
  for(const pin of originalCredentials)assert.equal(createHash('sha256').update(fs.readFileSync(path.join(runtimeRoot,pin.relativePath))).digest('hex'),pin.sha256);
  service=await startCollaborationService({port:0,runtimeNamespace:'ContentFixture'});const directorCredential=credentialFiles.find(file=>{const identity=service.store.resolveCredential(fs.readFileSync(file,'utf8'));return identity?.instanceId==='director';}),producerCredential=credentialFiles.find(file=>{const identity=service.store.resolveCredential(fs.readFileSync(file,'utf8'));return identity?.instanceId==='producer';}),restoredDirector=await connect(directorCredential),restoredProducer=await connect(producerCredential);
  const recovered=await call(restoredDirector,'get_content_workflow',scope),replayed=await call(restoredProducer,'record_content_stage',collectionRequest);assert.equal(recovered.workflow.state,'unknown');assert.equal(replayed.workflow.state,'unknown');assert.equal(replayed.deduplicated,true);assert.equal(recovered.stages.length,historical.stages.length);assert.equal(assessUpgradeReadiness({contentStages:recovered.stages}).ready,false);
  const outside=path.join(FIXTURE_ROOT,'recovery-outside.txt');fs.writeFileSync(outside,'不能越界的恢复哨兵');const rejected=await restoredProducer.callTool({name:'read_task_file',arguments:{...scope,area:'inputs',relativePath:'../../../../recovery-outside.txt'}});assert.equal(rejected.isError,true);assert.equal(fs.readFileSync(outside,'utf8'),'不能越界的恢复哨兵');
  checks.push({name:'关闭的隔离SQLite逐表摘要与五份合成凭据完整备份恢复，未覆盖原证据',passed:true},{name:'公开服务恢复后unknown与去重停点保留，无重复阶段，升级就绪仍阻塞',passed:true},{name:'恢复后公开文件API仍拒绝越界且外部哨兵未改变',passed:true});
  fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify({status:'passed',checks,officialPlatformCalls:0,modelCalls:0,fixtureRoot:FIXTURE_ROOT},null,2));
  console.log(JSON.stringify({status:'passed',checks:checks.length,fixtureRoot:FIXTURE_ROOT}));
}catch(error){
  fs.writeFileSync(path.join(directory,'failure.json'),JSON.stringify({status:'failed',checks,message:error.message,code:error.code},null,2));
  throw error;
}finally{
  await Promise.allSettled(clients.map(peer=>peer.close()));
  if(service)await service.close();
}
