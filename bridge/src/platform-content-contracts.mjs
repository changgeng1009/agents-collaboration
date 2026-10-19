import {fail} from './policy.mjs';
const BASE='https://www.workbuddy.cn/openapi/v2',opaque=value=>typeof value==='string'&&value.length>0&&value.length<=256&&!/[\x00-\x1f]/.test(value),text=value=>typeof value==='string'&&value.length>0&&Buffer.byteLength(value)<=32768;
// 只构造官方合同，不含令牌，不发网络请求，不复用桌面登录态。
export function buildWorkBuddyRequest(request){
 const {mode,operation}=request??{};let method,url,body=null,scopes=[];
 if(mode==='localassistant'){
  scopes=['user.localassistant.readable'];
  if(operation==='status'){method='GET';url=BASE+'/localassistant';}
  else if(operation==='history'){method='GET';url=BASE+'/localassistant/message';if(request.messageId!==undefined){if(!opaque(request.messageId))fail('PLATFORM_REQUEST_INVALID','增量消息游标无效。');url+='?message_id='+encodeURIComponent(request.messageId);}}
  else if(operation==='send'&&text(request.content)&&request.msgType==='text'){method='POST';url=BASE+'/localassistant/message';body={content:request.content,msg_type:request.msgType};scopes.push('user.localassistant.invokable');}
 }else if(mode==='cloud'){
  scopes=['user.task.readable'];
  if(operation==='create'&&text(request.prompt)&&(request.name===undefined||text(request.name))){method='POST';url=BASE+'/tasks';body={prompt:request.prompt,...(request.name?{name:request.name}:{})};scopes.push('user.task.invokable');}
  else if(operation==='get'&&opaque(request.taskId)){method='GET';url=BASE+'/tasks/'+encodeURIComponent(request.taskId);}
 }
 if(!method)fail('PLATFORM_CONTRACT_UNAVAILABLE','该平台模式或操作没有本候选支持的准确官方合同，不自动切换模式。');
 return{platform:'workbuddy',mode,operation,method,url,body,requiredScopes:scopes,requiresApprovedThirdPartyOAuth:true,launchAllowed:false,networkRequests:0};
}
export function nativeReference({platform,mode,fieldName,value}){
 if(platform!=='workbuddy'||!['localassistant','cloud'].includes(mode)||!opaque(value))fail('PLATFORM_NATIVE_REFERENCE_INVALID','须保留准确平台、模式、原生字段和值。');
 const kind=fieldName==='message_id'?'message':fieldName==='Acp-Connection-Id'?'connection':mode==='cloud'&&['task_id','sessionId'].includes(fieldName)?'session':null;if(!kind)fail('PLATFORM_NATIVE_REFERENCE_INVALID','该字段不能代表此模式的原生会话。');
 return{platform,mode,fieldName,value,kind,source:'original_field_only',runtimeVerified:false};
}
export function parseAcpPromptStream(stream,{requestId,sessionId,httpCompleted=false}={}){
 const unknown=reason=>({status:'unknown',reason,automaticRetry:false,modelExecutionVerified:false,businessCompletedVerified:false});
 if(typeof stream!=='string'||Buffer.byteLength(stream)>2*1024*1024||!opaque(sessionId)||!['string','number'].includes(typeof requestId))return unknown('ACP_STREAM_INVALID');
 const messages=[];let chunks=0;try{for(const record of stream.replaceAll('\r\n','\n').split('\n\n')){const data=record.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data)messages.push(JSON.parse(data));if(messages.length>4096)return unknown('ACP_STREAM_TOO_LARGE');}}catch{return unknown('ACP_STREAM_INVALID');}
 let terminal=null;for(const value of messages){if(value?.jsonrpc!=='2.0')return unknown('ACP_PROTOCOL_INVALID');if(value.method){if(value.method!=='session/update'||value.params?.sessionId!==sessionId)return unknown('ACP_SESSION_MISMATCH');const update=value.params.update;if(update?.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text'&&typeof update.content.text==='string')chunks++;}
  else{if(value.id!==requestId||terminal||value.error||!value.result||typeof value.result.stopReason!=='string')return unknown('ACP_TERMINAL_INVALID');terminal=value.result;}}
 if(!httpCompleted||!terminal)return unknown('ACP_TERMINAL_UNCONFIRMED');if(terminal.stopReason!=='end_turn')return{...unknown('ACP_TERMINAL_NOT_SUCCESS'),stopReason:terminal.stopReason};
 return{status:'succeeded',sessionId,nativeFieldName:'sessionId',stopReason:terminal.stopReason,chunks,protocolTerminalObserved:true,platformOriginVerified:false,modelExecutionVerified:false,businessCompletedVerified:false,automaticRetry:false};
}
export function platformContinuation({platform,mode}){
 const cloud=platform==='workbuddy'&&mode==='cloud',local=platform==='workbuddy'&&mode==='localassistant';return{platform,mode,externalWakeSupported:false,activeSessionCooperationCanBeObserved:true,explicitNativeContinuationContract:cloud,arbitraryDesktopSessionSelectionSupported:false,requiresOriginalNativeBinding:cloud,blocker:cloud?'APPROVED_OAUTH_AND_REAL_SESSION_RECEIPT_REQUIRED':local?'MESSAGE_CURSOR_IS_NOT_DESKTOP_CONVERSATION_ID':'PLATFORM_NATIVE_WAKE_CONTRACT_UNAVAILABLE',modeFallbackAllowed:false};
}
