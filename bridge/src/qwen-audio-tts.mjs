import {containsCredentialMaterial} from './qwen-error-diagnostics.mjs';
// 只描述已核的单一模型合同；不包含账号、授权、公司稿件或网络副作用。
export const QWEN_AUDIO_TTS = Object.freeze({model:'qwen-audio-3.1-tts-flash',voice:'yuxiaoyun_v3.1',pathname:'/api/v1/services/audio/tts/SpeechSynthesizer',format:'wav',sampleRate:24000});
export const QWEN_AUDIO_TTS_PRICE = Object.freeze({currency:'CNY',unit:'million-tokens',input:1.5,output:12,totalEstimate:null,accountDiscountVerified:false,hardCostLimitEnforced:false});
const stop = code => {throw Object.assign(new Error('千问语音合同未满足，操作停止。'),{code});};
const exact = (value,keys) => value && typeof value==='object' && !Array.isArray(value) && keys.length===Object.keys(value).length && keys.every(key=>Object.hasOwn(value,key));
export function validateAudioTtsBody(body) {
 if(!exact(body,['model','input']) || body.model!==QWEN_AUDIO_TTS.model || !exact(body.input,['text','voice','instruction','format','sample_rate']))stop('QWEN_AUDIO_TTS_REQUEST_INVALID');
 const i=body.input;
 // 长度为本地审查上限，不宣称是上游服务限额。
 if(typeof i.text!=='string' || !i.text.trim() || [...i.text].length>10000 || typeof i.instruction!=='string' || !i.instruction.trim() || [...i.instruction].length>2000 || i.voice!==QWEN_AUDIO_TTS.voice || i.format!==QWEN_AUDIO_TTS.format || i.sample_rate!==QWEN_AUDIO_TTS.sampleRate)stop('QWEN_AUDIO_TTS_REQUEST_INVALID');
 return body;
}
export function audioTtsUsage(usage) {
 return Object.fromEntries(['input_tokens','output_tokens','total_tokens','characters'].filter(key=>Number.isSafeInteger(usage?.[key]) && usage[key]>=0).map(key=>[key,usage[key]]));
}
export function audioTtsExpiry(value) {
 if(value===undefined || value===null)return null;
 if(!Number.isSafeInteger(value) || value<=0 || value>253402300799)stop('QWEN_AUDIO_TTS_EXPIRY_INVALID');
 return new Date(value*1000).toISOString();
}
// 私有原生回执保留正文结构；认证字段移除、凭据及URL敏感值遮盖。
// 未遮盖的原URL仅进入独立私有source合同，绝不进入共享结果或stdout。
export function redactAudioTtsResponse(response,token) {
 const visit=(value,depth=0)=>{
  if(depth>100)return '[depth_redacted]';
  if(typeof value==='string') {
   if(containsCredentialMaterial(value,token) || /\b(?:Bearer|Basic)\s+\S+|\b(?:sk|sess)-[A-Za-z0-9._~-]{6,}|\b(?:api[_-]?key|password|secret|token)\s*[:=]/i.test(value))return '[credential_redacted]';
   return value.replace(/https?:\/\/[^\s"'<>]+/gi,part=>{try{const url=new URL(part);return url.origin+url.pathname+(url.search?'?[query_redacted]':'')+(url.hash?'#[fragment_redacted]':'');}catch{return '[url_redacted]';}});
  }
  if(Array.isArray(value))return value.map(item=>visit(item,depth+1));
  if(typeof value==='number' && containsCredentialMaterial(value,token))return '[credential_redacted]';
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!containsCredentialMaterial(key,token) && !/^(?:authorization|proxy-authorization|headers?|cookie|set-cookie|api[_-]?key|access[_-]?token|token|secret|password|credentials?|signature|ossaccesskeyid|security[_-]?token)$/i.test(key)).map(([key,item])=>[key,visit(item,depth+1)]));
  return value??null;
 };
 return {schema:'qwen_audio_tts_private_native_response_v1',httpStatus:Number.isInteger(response?.httpStatus)?response.httpStatus:null,body:visit(response?.body),redactionApplied:true,authenticationPersisted:false};
}
// WAV结构读回不是解码或人工听感验收；未知编码拒绝，不伪造通过。
export function inspectAudioTtsWav(bytes) {
 if(!Buffer.isBuffer(bytes) || bytes.length<44 || bytes.toString('ascii',0,4)!=='RIFF' || bytes.toString('ascii',8,12)!=='WAVE' || bytes.readUInt32LE(4)!==bytes.length-8)stop('QWEN_AUDIO_WAV_INVALID');
 let offset=12,format=null,dataBytes=0,dataSeen=false;
 while(offset<bytes.length) {
  if(offset+8>bytes.length)stop('QWEN_AUDIO_WAV_INVALID');
  const name=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8,end=start+size;
  if(end>bytes.length || end+(size%2)>bytes.length)stop('QWEN_AUDIO_WAV_INVALID');
  if(name==='fmt ') {
   if(format || size<16)stop('QWEN_AUDIO_WAV_INVALID');
   format={formatTag:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),blockAlign:bytes.readUInt16LE(start+12),bitsPerSample:bytes.readUInt16LE(start+14)};
  }
  if(name==='data'){if(dataSeen || !size)stop('QWEN_AUDIO_WAV_INVALID');dataSeen=true;dataBytes=size;}
  offset=end+(size%2);
 }
 if(!format || !dataSeen || ![1,3].includes(format.formatTag) || format.channels<1 || format.channels>8 || format.sampleRate!==QWEN_AUDIO_TTS.sampleRate || ![8,16,24,32].includes(format.bitsPerSample) || format.formatTag===3 && format.bitsPerSample!==32 || format.blockAlign!==format.channels*format.bitsPerSample/8 || format.byteRate!==format.sampleRate*format.blockAlign || dataBytes%format.blockAlign!==0)stop('QWEN_AUDIO_WAV_INVALID');
 return {...format,dataBytes,structuralReadbackVerified:true,technicalDecodeVerified:false};
}
