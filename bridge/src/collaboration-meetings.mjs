import { randomUUID } from 'node:crypto';
import { fail, sha256 } from './policy.mjs';
import { coreText } from './collaboration-store.mjs';

const now=()=>new Date().toISOString();
function meeting(store,identity,args){store.group(identity,args.groupId);const value=store.get('meeting',`${args.groupId}:${args.meetingId}`);if(value.groupId!==args.groupId)fail('MEETING_FORBIDDEN','会议不属于当前组。');return value;}
function participant(value,identity){if(!value.participantIds.includes(identity.instanceId))fail('MEETING_FORBIDDEN','当前成员不是该会议的明确参与者。');}
function writable(value){if(Date.now()>Date.parse(value.deadlineAt))fail('MEETING_DEADLINE','会议已到截止时间，不再写入讨论或评审。');}
export function expireMeetingIfNeeded(store,identity,name,args){const value=meeting(store,identity,args);if(name==='stop_meeting'&&value.stopPolicy==='manager_only')store.manager(identity,args.groupId);else participant(value,identity);if(Date.now()>Date.parse(value.deadlineAt)&&!['completed','stopped'].includes(value.status)){value.status='stopped';value.closedReason='deadline';value.stoppedBy=null;value.stoppedAt=now();store.put('meeting',`${args.groupId}:${args.meetingId}`,value);store.event(identity,'meeting_deadline_observed',args.groupId,{meetingId:args.meetingId,origin:'infrastructure_deadline'});}}
function summary(store,value){const conclusions=value.conclusionIds.map(id=>{const conclusion=store.get('conclusion',id);return{...conclusion,allParticipantsApproved:conclusion.participantIds.every(memberId=>conclusion.reviews[memberId]?.verdict==='approve'),realPlatformConsensusVerified:false,businessCompletedVerified:false};});return{meeting:value,statements:value.statementIds.map(id=>store.get('statement',id)),conclusions};}
export function meetingOperation(store,identity,name,args){
 const self=identity.instanceId;
 if(name==='open_meeting'){
  const group=store.manager(identity,args.groupId),key=`${args.groupId}:${args.meetingId}`;
  if(store.get('meeting',key,false))fail('MEETING_EXISTS','会议已存在，不覆盖原讨论。');
  const participants=[...new Set(args.participantIds)];
  if(participants.length<2||participants.some(id=>!store.memberIds(group).includes(id)))fail('MEETING_PARTICIPANTS','会议参与者必须是当前组的明确成员。');
  const deadline=Date.parse(args.deadlineAt);if(deadline<=Date.now()||deadline>Date.now()+86400000)fail('MEETING_DEADLINE','会议截止须在未来24小时内。');
  const requiredApprovalCount=args.requiredApprovalCount??participants.length;if(requiredApprovalCount>participants.length)fail('MEETING_COMPLETION_INVALID','完成所需评审数不能超过明确参与人数。');
  store.checkSources(identity,args.groupId,args.sourceIds,participants);
  const value={groupId:args.groupId,meetingId:args.meetingId,topic:args.topic,participantIds:participants,maxRounds:args.maxRounds,maxStatements:args.maxStatements,deadlineAt:args.deadlineAt,stopPolicy:args.stopPolicy,completionCondition:{type:'approval_quorum',requiredApprovalCount},sourceIds:args.sourceIds,currentRound:1,statementIds:[],conclusionIds:[],status:'open',createdBy:self,createdAt:now(),evidence:'member_submitted'};
  store.put('meeting',key,value);store.event(identity,name,args.groupId,{meetingId:args.meetingId,participantIds:participants});return{meeting:value};
 }
 const value=meeting(store,identity,args),key=`${args.groupId}:${args.meetingId}`;
 if(name==='stop_meeting'){
  const group=store.group(identity,args.groupId);
  if(value.stopPolicy==='manager_only'?group.managerId!==self:!value.participantIds.includes(self))fail('MEETING_STOP_FORBIDDEN','当前停止政策未授权该成员。');
  if(value.status==='stopped')return{meeting:value,stopAlreadyRecorded:true};if(value.status==='completed')fail('MEETING_CLOSED','会议已经按明确完成条件结束，不能覆盖终态。');
  value.status='stopped';value.closedReason=args.reason;value.stoppedBy=self;value.stoppedAt=now();store.put('meeting',key,value);store.event(identity,name,args.groupId,{meetingId:args.meetingId});return{meeting:value};
 }
 participant(value,identity);
 if(name==='get_meeting'){
  for(const id of value.statementIds)store.markRead(identity,'statement',id,args.groupId);
  for(const id of value.conclusionIds)store.markRead(identity,'conclusion',id,args.groupId);
  return summary(store,value);
 }
 writable(value);
 if(['stopped','completed'].includes(value.status))fail('MEETING_CLOSED','会议已经停止或完成，不再新增发言、提案或评审。');
 if(name==='submit_statement'){
  if(value.status!=='open'||value.currentRound!==args.round||value.statementIds.length>=value.maxStatements)fail('MEETING_BOUNDED','会议已停止、轮次不符或达到发言上限。');
  const previous=value.statementIds.map(id=>store.get('statement',id));if(previous.some(item=>item.authorId===self&&item.round===args.round))fail('STATEMENT_ALREADY_SUBMITTED','每位成员每轮只提交自己的一个发言。');
  coreText(args.body,4096);store.checkSources(identity,args.groupId,args.sourceIds,value.participantIds);
  const statement={statementId:randomUUID(),groupId:args.groupId,meetingId:args.meetingId,authorId:self,round:args.round,body:args.body,sourceIds:args.sourceIds,participantIds:value.participantIds,at:now(),evidence:'member_submitted',platformIdentityVerified:false};
  store.put('statement',statement.statementId,statement);store.markRead(identity,'statement',statement.statementId,args.groupId);value.statementIds.push(statement.statementId);
  const thisRound=[...previous,statement].filter(item=>item.round===args.round);
  if(value.statementIds.length>=value.maxStatements||(thisRound.length===value.participantIds.length&&value.currentRound>=value.maxRounds))value.status='discussion_complete';
  else if(thisRound.length===value.participantIds.length)value.currentRound++;
  store.put('meeting',key,value);store.event(identity,name,args.groupId,{meetingId:args.meetingId,statementId:statement.statementId,round:args.round});return{statement,meeting:value};
 }
 if(name==='propose_conclusion'){
  if(value.status!=='discussion_complete'||value.conclusionIds.length>=3)fail('CONCLUSION_NOT_READY','讨论未结束、已停止或结论提案达到上限。');
  coreText(args.text,8192);store.checkSources(identity,args.groupId,args.sourceIds,value.participantIds);
  const conclusion={conclusionId:randomUUID(),groupId:args.groupId,meetingId:args.meetingId,authorId:self,text:args.text,sourceIds:args.sourceIds,participantIds:value.participantIds,createdAt:now(),reviews:{},sha256:sha256(Buffer.from(args.text)),evidence:'member_submitted'};
  store.put('conclusion',conclusion.conclusionId,conclusion);store.markRead(identity,'conclusion',conclusion.conclusionId,args.groupId);value.conclusionIds.push(conclusion.conclusionId);store.put('meeting',key,value);store.event(identity,name,args.groupId,{meetingId:args.meetingId,conclusionId:conclusion.conclusionId});return{conclusion,allParticipantsApproved:false,realPlatformConsensusVerified:false};
 }
 if(name==='review_conclusion'){
  if(!value.conclusionIds.includes(args.conclusionId))fail('CONCLUSION_FORBIDDEN','结论不属于该会议。');
  const conclusion=store.get('conclusion',args.conclusionId);
  if(!store.db.prepare('SELECT 1 FROM core_reads WHERE actor=? AND kind=? AND record_id=? AND group_id=?').get(self,'conclusion',conclusion.conclusionId,args.groupId))fail('SOURCE_NOT_READ','独立评审前须实际读取该结论。');
  if(conclusion.reviews[self])fail('REVIEW_ALREADY_RECORDED','不能代签或覆盖已有成员评审。');
  coreText(args.text,4096,true);conclusion.reviews[self]={authorId:self,verdict:args.verdict,text:args.text,at:now(),evidence:'member_submitted'};store.put('conclusion',conclusion.conclusionId,conclusion);
  if(Object.values(conclusion.reviews).filter(review=>review.verdict==='approve').length>=value.completionCondition.requiredApprovalCount){value.status='completed';value.completedAt??=now();value.completionConclusionId=conclusion.conclusionId;store.put('meeting',key,value);}
  store.event(identity,name,args.groupId,{meetingId:args.meetingId,conclusionId:args.conclusionId});return{conclusion,meeting:value,allParticipantsApproved:conclusion.participantIds.every(id=>conclusion.reviews[id]?.verdict==='approve'),realPlatformConsensusVerified:false,businessCompletedVerified:false};
 }
 fail('TOOL_FORBIDDEN','会议操作未登记。');
}
