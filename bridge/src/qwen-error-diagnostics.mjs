// 仅处理明确失败响应的固定字段；不读取任意键、headers、input或完整响应正文。
const MAX_INSPECT_CHARS=65536;
export const MAX_ERROR_FIELD_CHARS=1024;
const SOURCES=['code','message','param','output.code','output.message','output.param','output.status_msg','base_resp.status_code','base_resp.status_msg','base_resp.param','output.base_resp.status_code','output.base_resp.status_msg','output.base_resp.param'];
const controls=/[\p{Cc}\p{Cf}]/u;
const escape=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function variants(token,{fragments=false}={}) {
 if(typeof token!=='string' || !token.length)return [];
 const bytes=Buffer.from(token);
 return [...new Set([token,encodeURIComponent(token),bytes.toString('base64'),bytes.toString('base64url'),bytes.toString('hex'),...(fragments?[token.slice(0,4),token.slice(-4),token.slice(0,8),token.slice(-8)]:[])])].sort((a,b)=>b.length-a.length);
}
function decodeVisible(value) {
 let decoded=value.normalize('NFKC');
 for(let round=0;round<3;round++) {
  const before=decoded;
  decoded=decoded.replace(/&(colon|sol|bsol|amp|quot|apos|percnt|newline|tab);/gi,(_,name)=>({colon:':',sol:'/',bsol:'\\',amp:'&',quot:'"',apos:"'",percnt:'%',newline:'\n',tab:'\t'})[name.toLowerCase()]);
  decoded=decoded.replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi,(_,wide,byte)=>String.fromCharCode(parseInt(wide??byte,16)));
  decoded=decoded.replace(/&#(x[0-9a-f]+|\d+);/gi,(match,digits)=>{const hexadecimal=/^x/i.test(digits),n=parseInt(hexadecimal?digits.slice(1):digits,hexadecimal?16:10);return Number.isInteger(n)&&n>=0&&n<=0x10ffff?String.fromCodePoint(n):match;});
  decoded=decoded.replace(/(?:%[0-9a-f]{2})+/gi,part=>{try{return decodeURIComponent(part);}catch{return '[encoded_value_redacted]';}});
  if(before===decoded)break;
 }
 return decoded;
}
export function containsCredentialMaterial(value,token,{fragments=false}={}) {
 if(value===undefined || value===null)return false;
 if(typeof value!=='string' && typeof value!=='number')return true;
 let text=decodeVisible(String(value));const candidates=variants(token,{fragments});
 for(let round=0;round<3;round++) {
  if(candidates.some(part=>text.toLowerCase().includes(part.toLowerCase())))return true;
  if(!/^[A-Za-z0-9_+/-]+={0,2}$/.test(text) || text.length<16 || text.length>8192)break;
  const bytes=Buffer.from(text,'base64url'),next=bytes.toString('utf8');
  if(!next.isWellFormed() || /[^\x20-\x7e]/.test(next) || bytes.toString('base64url')!==text.replace(/=+$/,'').replace(/\+/g,'-').replace(/\//g,'_'))break;
  text=decodeVisible(next);
 }
 return false;
}
function at(body,source) {
 let current=body;
 for(const key of source.split('.')) {
  if(!current || typeof current!=='object' || Array.isArray(current))return {present:false};
  const descriptor=Object.getOwnPropertyDescriptor(current,key);
  if(!descriptor)return {present:false};
  if(!Object.hasOwn(descriptor,'value'))return {present:true,invalid:true};
  current=descriptor.value;
 }
 return {present:current!==undefined && current!==null,value:current};
}
export function sanitizeErrorField(value,token,{parameter=false,structured=false}={}) {
 const hidden=()=>({value:null,state:'redacted',truncated:false});
 if(typeof value==='number')return Number.isSafeInteger(value) && !containsCredentialMaterial(value,token)?{value,state:'available',truncated:false}:hidden();
 if(typeof value!=='string')return hidden();
 if(!value.isWellFormed() || value.length>MAX_INSPECT_CHARS || controls.test(value))return hidden();
 let text=decodeVisible(value);
 if(!text.isWellFormed() || controls.test(text) || /^\s*[\[{]/.test(text))return hidden();
 // 路径、认证字段或单独签名query不做不可靠的局部裁剪，整项拒绝更可核验。
 if(/[A-Za-z]:[\\/]|\\\\[^\s]+\\|\/(?:Users|home|root|etc|var|tmp|private)\/|(?:^|[\s"'(=])(?:\.{1,2}[\\/]|\/[A-Za-z_.])/i.test(text) || /\b(?:authorization|proxy-authorization|api[_ -]?key|token|secret|password|signature|access_key|x-amz-[a-z-]+|ossaccesskeyid)\s*["']?\s*[:=]/i.test(text))return hidden();
 if(structured || parameter) {
  if(containsCredentialMaterial(text,token) || /^(?:sk|sess|rk|ak)-[A-Za-z0-9._~-]{6,}$/i.test(text))return hidden();
  const valid=parameter?text.length<=160 && /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d{1,4}\])*$/.test(text):/^[A-Za-z0-9_.:-]{1,128}$/.test(text);
  return valid?{value:text,state:'available',truncated:false}:hidden();
 }
 for(const part of variants(token,{fragments:true}))text=text.replace(new RegExp(escape(part),'gi'),'[credential_redacted]');
 text=text.replace(/\b(?:https?|wss?|ftp|file):\/\/[^\s"'<>]+/gi,'[url_redacted]').replace(/(?:^|\s)\/\/[^\s"'<>]+/g,' [url_redacted]');
 text=text.replace(/\b(?:www\.[a-z0-9.-]+(?:[/?#][^\s"'<>]*)?|[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?[/?#][^\s"'<>]*)/gi,'[url_redacted]');
 text=text.replace(/\bBearer\s+[^\s"'<>;,]+/gi,'[authorization_redacted]').replace(/\b(?:sk|sess|rk|ak)-[A-Za-z0-9._~-]{6,}/gi,'[credential_redacted]');
 text=text.replace(/[A-Za-z0-9_+\/=-]{24,}/g,'[opaque_value_redacted]');
 if(containsCredentialMaterial(text,token,{fragments:true}))return hidden();
 // 全字段脱敏完成后才能截断，禁止留下跨截断边界的半段凭据。
 const truncated=text.length>MAX_ERROR_FIELD_CHARS;
 return {value:text.slice(0,MAX_ERROR_FIELD_CHARS),state:truncated?'truncated':'available',truncated};
}
export function collectFailureDiagnostic(response,{token,kind,phase,context={}}) {
 const body=response.body,http=response.httpStatus,outStatus=at(body,'output.task_status').value;
 const businessCodes=[at(body,'output.base_resp.status_code').value,at(body,'base_resp.status_code').value];
 const reason=http<200 || http>=300?'http_failure':kind==='speech' && businessCodes.some(code=>Number.isSafeInteger(code)&&code!==0)?'speech_business_failure':kind==='video' && ['FAILED','UNKNOWN'].includes(outStatus)?'native_task_failure':null;
 if(!reason)return null;
 const fields=Object.fromEntries(SOURCES.map(source=>{
  const field=at(body,source);
  const item=!field.present?{value:null,state:'missing',truncated:false}:field.invalid?{value:null,state:'redacted',truncated:false}:sanitizeErrorField(field.value,token,{parameter:source.endsWith('param'),structured:source==='code'||source.endsWith('.code')||source.endsWith('.status_code')});
  return [source,{source,...item}];
 }));
 return {schema:'qwen_private_failure_diagnostic_v1',phase,kind,reason,httpStatus:http,...context,fields,fullBodyOrHeadersOrInputPersisted:false,credentialOrHashPersisted:false};
}
