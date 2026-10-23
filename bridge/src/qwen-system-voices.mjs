import {containsCredentialMaterial} from './qwen-error-diagnostics.mjs';

// 纯合同模块：不认证、不联网、不分配次数。宿主仍须校验放行、固定传输并持久占位。
export function createSystemVoiceCatalogRequest() {
  return Object.freeze({
    method:'POST',
    url:'https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation',
    body:Object.freeze({model:'MiniMax/speech-2.8-turbo', input:Object.freeze({action:'get_voice', voice_type:'system'})}),
    limits:Object.freeze({maxManagementPosts:1, maxGenerationPosts:0, autoRetry:false})
  });
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => object(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const controls = /[\p{Cc}\p{Cf}]/u;
const stop = reason => {throw Object.assign(new Error('系统音色目录未通过离线合同检查。'), {reason});};
function safeText(value, token, limit) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > limit || controls.test(value) || containsCredentialMaterial(value, token)) return false;
  return !/(?:https?|file|data|wss?):|Bearer\s|(?:api[_-]?key|token|secret|password)\s*[:=]|[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|root|tmp|private)\//i.test(value);
}
function hasPayload(value) {
  if (value === null || value === undefined || value === '' || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (object(value)) return Object.keys(value).length > 0;
  return true;
}
function inspectSafety(body, token) {
  const seen = new WeakSet();
  let nodes = 0, characters = 0;
  const visit = (value, depth) => {
    if (++nodes > 50000 || depth > 12) stop('response_limit_rejected');
    if (typeof value === 'string') {
      characters += value.length;
      if (characters > 1048576 || value.length > 8192) stop('response_limit_rejected');
      if (containsCredentialMaterial(value, token)) stop('credential_material_rejected');
      if (/^data:(?:audio|video|image)\//i.test(value)) stop('media_payload_rejected');
    } else if (value && typeof value === 'object') {
      if (seen.has(value) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) stop('response_type_rejected');
      seen.add(value);
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
        if (!Object.hasOwn(descriptor, 'value')) stop('response_type_rejected');
        const child = descriptor.value;
        // 元数据的存在不等于执行了生成；只拒绝确实携带的非空媒体负载。
        if (/^(?:audio|video|image)(?:_(?:data|hex|base64|url|file|bytes))?$/i.test(key) && hasPayload(child)) stop('media_payload_rejected');
        if (/^(?:audio|video|image)\//i.test(key) && hasPayload(child)) stop('media_payload_rejected');
        if (key === 'data' && typeof child === 'string' && hasPayload(child)) stop('media_payload_rejected');
        visit(child, depth + 1);
      }
    } else if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || typeof value === 'number' && !Number.isFinite(value)) stop('response_type_rejected');
  };
  visit(body, 0);
}

// 仅返回必要字段；附带元数据只经过安全检查，不复制、不解释、不执行其中内容或 URL。
export function inspectSystemVoiceCatalogResponse(response, {token, selectedVoiceIds = []} = {}) {
  const body = own(response, 'body'), httpStatus = own(response, 'httpStatus');
  const nativeId = own(body, 'request_id');
  const guarded = typeof token === 'string' && token.length >= 16 && token.length <= 4096;
  const result = {
    state:'rejected',
    reason:null,
    audit:{httpStatus:Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null,
      request_id:guarded && typeof nativeId === 'string' && uuid.test(nativeId) && !containsCredentialMaterial(nativeId, token) ? nativeId : null,
      status_code:null, status_msg:null},
    totalSystemVoices:null,
    voices:[],
    hdGenerationVerified:false,
    voiceQualityVerified:false
  };
  try {
    if (!guarded) stop('credential_guard_required');
    if (!Array.isArray(selectedVoiceIds) || selectedVoiceIds.length > 8 || new Set(selectedVoiceIds).size !== selectedVoiceIds.length || selectedVoiceIds.some(value => !safeText(value, token, 256) || !value.length)) stop('selection_invalid');
    inspectSafety(body, token);
    // 完整安全检查通过后，保留有界的实际字符串编号，不再局限 UUID。
    if (typeof nativeId === 'string' && nativeId.length > 0 && safeText(nativeId, token, 128)) result.audit.request_id = nativeId;
    const output = own(body, 'output'), base = own(output, 'base_resp');
    const status = own(base, 'status_code'), message = own(base, 'status_msg');
    if (Number.isSafeInteger(status) && !containsCredentialMaterial(status, token)) result.audit.status_code = status;
    if (safeText(message, token, 1024)) result.audit.status_msg = message;
    if (httpStatus !== 200) stop('http_status_rejected');
    if (!object(body) || !object(output) || !object(base) || status !== 0 || typeof message !== 'string') stop('provider_status_rejected');
    if (result.audit.status_msg === null) stop('unsafe_persisted_field');
    const rows = own(output, 'system_voice');
    if (!Array.isArray(rows) || rows.length > 10000) stop('system_directory_type_rejected');
    const seenIds = new Set(), selected = new Map();
    for (const row of rows) {
      const voiceId = own(row, 'voice_id'), name = own(row, 'voice_name'), description = own(row, 'description');
      if (!object(row) || !safeText(voiceId, token, 256) || !voiceId.length || seenIds.has(voiceId) || typeof name !== 'string' || !Array.isArray(description) || description.length > 20 || description.some(value => typeof value !== 'string')) stop('system_directory_row_rejected');
      seenIds.add(voiceId);
      if (!selectedVoiceIds.includes(voiceId)) continue;
      if (!safeText(name, token, 256) || !Array.isArray(description) || description.length > 20 || description.some(value => !safeText(value, token, 512))) stop('unsafe_persisted_field');
      selected.set(voiceId, {voice_id:voiceId, present:true, voice_name:name, description:[...description]});
    }
    result.state = 'system_directory_verified';
    result.totalSystemVoices = rows.length;
    result.voices = selectedVoiceIds.map(voice_id => selected.get(voice_id) ?? {voice_id, present:false});
  } catch (failure) {
    result.reason = typeof failure.reason === 'string' && /^[a-z_]{1,64}$/.test(failure.reason) ? failure.reason : 'response_type_rejected';
  }
  return result;
}
