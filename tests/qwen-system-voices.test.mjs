import test from 'node:test';
import assert from 'node:assert/strict';
import {createSystemVoiceCatalogRequest, inspectSystemVoiceCatalogResponse} from '../bridge/src/qwen-system-voices.mjs';

// 全部为合成数据；没有真实请求编号、音色、认证、账号或响应正文。
const token = ['synthetic', 'catalog', 'credential', 'fixture'].join('_');
const requestId = [8,4,4,4,12].map((length, index) => String(index + 1).repeat(length)).join('-');
const ids = ['synthetic-voice-a', 'synthetic-voice-b'];
const options = {token, selectedVoiceIds:ids};
const fixture = () => ({httpStatus:200, body:{request_id:requestId, output:{
  base_resp:{status_code:0, status_msg:'synthetic success'},
  system_voice:[
    {voice_id:ids[0], voice_name:'合成女声甲', description:['合成标签'], created_time:'synthetic date'},
    {voice_id:'synthetic-unselected', voice_name:'合成其他音色', description:[]}
  ]
}}});

test('synthetic：请求固定为只读 system get_voice，无法从参数引入生成字段', () => {
  const request = createSystemVoiceCatalogRequest({model:'synthetic-other', text:'合成文本'});
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://maas.qianwenaiapi.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(JSON.stringify(request.body), '{"model":"MiniMax/speech-2.8-turbo","input":{"action":"get_voice","voice_type":"system"}}');
  assert.deepEqual(request.limits, {maxManagementPosts:1, maxGenerationPosts:0, autoRetry:false});
  assert.ok(Object.isFrozen(request.body.input));
});

test('synthetic：合法目录只保留所选音色的必要字段和准确总数', () => {
  const result = inspectSystemVoiceCatalogResponse(fixture(), options);
  assert.equal(result.state, 'system_directory_verified');
  assert.equal(result.audit.request_id, requestId);
  assert.equal(result.totalSystemVoices, 2);
  assert.deepEqual(result.voices, [
    {voice_id:ids[0], present:true, voice_name:'合成女声甲', description:['合成标签']},
    {voice_id:ids[1], present:false}
  ]);
  assert.equal(result.hdGenerationVerified, false);
  assert.equal(result.voiceQualityVerified, false);
  assert.ok(!JSON.stringify(result).includes('created_time'));
  assert.ok(!JSON.stringify(result).includes('synthetic-unselected'));
});

test('synthetic：附带空元数据和安全未知元数据不改变合法目录结果，也不持久化其值', () => {
  const response = fixture();
  Object.assign(response.body.output, {voice_cloning:[], voice_generation:[], metadata:{instruction:'synthetic ignored instruction', url:'https://example.invalid/ignored'}});
  response.body.usage = {syntheticCounter:7};
  const result = inspectSystemVoiceCatalogResponse(response, options);
  assert.deepEqual(result, inspectSystemVoiceCatalogResponse(fixture(), options));
  assert.ok(!JSON.stringify(result).includes('example.invalid'));
});

test('synthetic：真正非空 audio 负载被拒绝，保留安全编号，不回传负载', () => {
  const response = fixture();
  response.body.output.data = {audio:'synthetic audio payload'};
  const result = inspectSystemVoiceCatalogResponse(response, options);
  assert.equal(result.state, 'rejected');
  assert.equal(result.reason, 'media_payload_rejected');
  assert.equal(result.audit.request_id, requestId);
  assert.equal(result.totalSystemVoices, null);
  assert.deepEqual(result.voices, []);
  assert.ok(!JSON.stringify(result).includes('synthetic audio payload'));
});

test('synthetic：HTTP、平台状态或目录类型不符均拒绝，不把空结果当成功', () => {
  const responses = [fixture(), fixture(), fixture(), fixture()];
  responses[0].httpStatus = 403;
  responses[1].body.output.base_resp.status_code = 9;
  responses[2].body.output.system_voice = {};
  delete responses[3].body.output.system_voice;
  for (const response of responses) {
    const result = inspectSystemVoiceCatalogResponse(response, options);
    assert.equal(result.state, 'rejected');
    assert.equal(result.totalSystemVoices, null);
    assert.deepEqual(result.voices, []);
  }
});

test('synthetic：明文或编码认证回显、需保存的不安全文本均拒绝且不回传', () => {
  for (const value of [token, Buffer.from(token).toString('base64'), 'https://example.invalid/unsafe']) {
    const response = fixture();
    response.body.output.system_voice[0].description = [value];
    const result = inspectSystemVoiceCatalogResponse(response, options);
    assert.equal(result.state, 'rejected');
    assert.deepEqual(result.voices, []);
    assert.ok(!JSON.stringify(result).includes(value));
  }
  const response = fixture();
  response.body.output.metadata = {ignoredSecret:token};
  assert.equal(inspectSystemVoiceCatalogResponse(response, options).reason, 'credential_material_rejected');
});

test('synthetic：安全检查后完整保留非UUID原生编号，失败时维持预审UUID限制', () => {
  const nativeId = 'synthetic-native-request-opaque-007';
  const response = fixture();
  response.body.request_id = nativeId;
  const accepted = inspectSystemVoiceCatalogResponse(response, options);
  assert.equal(accepted.state, 'system_directory_verified');
  assert.equal(accepted.audit.request_id, nativeId);
  response.body.output.data = {audio:'synthetic rejected audio'};
  const rejected = inspectSystemVoiceCatalogResponse(response, options);
  assert.equal(rejected.state, 'rejected');
  assert.equal(rejected.reason, 'media_payload_rejected');
  assert.equal(rejected.audit.request_id, null);
});
