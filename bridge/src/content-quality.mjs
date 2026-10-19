import {fail} from './policy.mjs';

export const QUALITY_DIMENSIONS=['picture','continuous_motion','subtitle_text','subtitle_timing','subtitle_rendering','voiceover_sync','audio_presence','audio_decode','audio_loudness','audio_listening'];
const methods={picture:['frame_view','video_playback'],continuous_motion:['video_playback'],subtitle_text:['subtitle_inspection'],subtitle_timing:['subtitle_source_timing'],subtitle_rendering:['subtitle_video_review'],voiceover_sync:['audiovisual_review'],audio_presence:['ffprobe'],audio_decode:['ffmpeg_decode'],audio_loudness:['loudness_measurement'],audio_listening:['audio_listening']};
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>plain(value)&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
export function validateTargetDuration(actualMs,targetMs){if(!Number.isSafeInteger(actualMs)||!Number.isSafeInteger(targetMs)||actualMs<1||targetMs<1||Math.abs(actualMs-targetMs)>100)fail('QUALITY_TARGET_DURATION_MISMATCH','主成片实际时长与原brief目标不符，不能缩短验收范围冒充完成。');return true;}
export function validateQualityRecord(record,context){
  if(!exact(record,['versionId','checks'])||record.versionId!==context.versionId||!Number.isSafeInteger(context.durationMs)||context.durationMs<1||!Array.isArray(record.checks)||!record.checks.length||record.checks.length>64)fail('QUALITY_VERSION_INVALID','质量记录须绑定有界确切版本及已知时长。');
  const checks=record.checks.map(check=>{
    if(!exact(check,['dimension','status','method','range','evidenceRef','note'])||!QUALITY_DIMENSIONS.includes(check.dimension)||!['checked','passed','failed','not_inspected'].includes(check.status)||typeof check.note!=='string'||Buffer.byteLength(check.note)>4096)fail('QUALITY_CHECK_INVALID','检查维度、状态和文字须符合严格合同。');
    if(!exact(check.range,['startMs','endMs'])||!Number.isSafeInteger(check.range.startMs)||!Number.isSafeInteger(check.range.endMs)||check.range.startMs<0||check.range.endMs<=check.range.startMs||check.range.endMs>context.durationMs)fail('QUALITY_RANGE_INVALID','检查区间越过确切版本时长。');
    if(check.status!=='not_inspected'&&!methods[check.dimension].includes(check.method))fail('QUALITY_METHOD_INSUFFICIENT','该检查方式不能证明此维度；静帧、技术探针和实际听检分别记录。');
    if(check.status!=='not_inspected'&&check.method==='frame_view'&&check.range.endMs-check.range.startMs!==1)fail('QUALITY_FRAME_RANGE_INVALID','单张抽帧只能记为一毫秒采样点，不能声明整段观看覆盖。');
    if(check.status!=='not_inspected'&&(!exact(check.evidenceRef,['area','relativePath'])||!['inputs','work','outputs'].includes(check.evidenceRef.area)||typeof check.evidenceRef.relativePath!=='string'))fail('QUALITY_EVIDENCE_REQUIRED','已检查项目必须引用本任务有归属的原始证据。');
    return structuredClone(check);
  });
  return{versionId:record.versionId,checks,evidence:'attributed_check_only',qualityVerified:false,businessCompletedVerified:false};
}

export function assessContentQuality(records,context){
  const checks=records.flatMap(record=>validateQualityRecord({versionId:record.versionId,checks:record.checks},context).checks);
  const requiredDimensions=['picture','continuous_motion',...(context.subtitlesRequired?['subtitle_text','subtitle_timing','subtitle_rendering']:[]),...(context.voiceoverRequired?['audio_presence','audio_decode','audio_loudness','audio_listening','voiceover_sync']:[])];
  const coverageGaps=requiredDimensions.filter(dimension=>{
    const rows=checks.filter(check=>check.dimension===dimension);
    if(rows.some(check=>check.status==='failed'))return true;
    const passed=rows.filter(check=>check.status==='passed'&&check.method!=='frame_view').map(check=>check.range).sort((a,b)=>a.startMs-b.startMs);
    let end=0;
    for(const range of passed){if(range.startMs>end)return true;end=Math.max(end,range.endMs);}
    return end<context.durationMs;
  });
  return{requiredDimensions,coverageGaps,allRequiredChecksReportedPassed:coverageGaps.length===0,qualityVerified:false,businessCompletedVerified:false,reportIsIndependentVerification:false};
}
