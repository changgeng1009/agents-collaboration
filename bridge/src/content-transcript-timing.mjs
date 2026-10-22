import {fail} from './policy.mjs';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// 仅处理单音轨顺序短句，不支持同时说话；源摘要只作合同pin，实际文件须由调用者核对。
// ASR只能提供自动候选；时基必须显式声明，不从字段名、静音或参考稿猜测。
export function normalizeTranscriptTiming(input) {
 if(!plain(input)||input.schema!=='transcript_word_timing_v1'||!/^[a-f0-9]{64}$/.test(input.sourceSha256??'')||!['phrase_relative','source_absolute'].includes(input.wordPositionBasis)||!finite(input.sourceDurationMs)||input.sourceDurationMs<=0||!finite(input.videoOffsetMs)||input.videoOffsetMs<0||!finite(input.videoDurationMs)||input.videoDurationMs<input.videoOffsetMs+input.sourceDurationMs||!Array.isArray(input.phrases)||input.phrases.length>10000)fail('TRANSCRIPT_TIMING_CONTRACT_INVALID','词时码须绑定准确源、长度和明确时基，不能隐式推测。');
 const words=[];let priorPhraseEnd=0,totalWords=0;
 const phrases=input.phrases.map((phrase,index)=>{
  if(!plain(phrase)||!finite(phrase.sourceStartMs)||!finite(phrase.durationMs)||phrase.sourceStartMs<priorPhraseEnd||phrase.durationMs<=0||phrase.sourceStartMs+phrase.durationMs>input.sourceDurationMs||!Array.isArray(phrase.words)||phrase.words.length>10000)fail('TRANSCRIPT_PHRASE_RANGE_INVALID','短句时码须单调且位于同一源音轨范围。');
  totalWords+=phrase.words.length;if(totalWords>10000)fail('TRANSCRIPT_TIMING_LIMIT','全部短句合计最多一万个词，不能分段绕过总量限制。');
  const phraseEnd=phrase.sourceStartMs+phrase.durationMs;priorPhraseEnd=phraseEnd;let priorWordEnd=phrase.sourceStartMs;
  const normalized=phrase.words.map((word,wordIndex)=>{
   if(!plain(word)||typeof word.text!=='string'||!word.text.length||!word.text.isWellFormed()||Buffer.byteLength(word.text)>1024||!finite(word.confidence)||word.confidence<0||word.confidence>1||!finite(word.positionMs)||!finite(word.durationMs)||word.positionMs<0||word.durationMs<=0)fail('TRANSCRIPT_WORD_INVALID','识别词、置信度和实际音频时码须完整，缺失不能补成零。');
   const sourceStartMs=(input.wordPositionBasis==='phrase_relative'?phrase.sourceStartMs:0)+word.positionMs,sourceEndMs=sourceStartMs+word.durationMs;
   if(sourceStartMs<priorWordEnd||sourceStartMs<phrase.sourceStartMs||sourceEndMs>phraseEnd)fail('TRANSCRIPT_WORD_RANGE_INVALID','识别词必须保持原次序并落在所属短句内，禁止时基错用。');
   priorWordEnd=sourceEndMs;
   const row={phraseIndex:index,wordIndex,text:word.text,confidence:word.confidence,phraseRelativeStartMs:sourceStartMs-phrase.sourceStartMs,sourceStartMs,sourceEndMs,videoStartMs:sourceStartMs+input.videoOffsetMs,videoEndMs:sourceEndMs+input.videoOffsetMs};words.push(row);return row;
  });
  return{index,sourceStartMs:phrase.sourceStartMs,sourceEndMs:phraseEnd,videoStartMs:phrase.sourceStartMs+input.videoOffsetMs,videoEndMs:phraseEnd+input.videoOffsetMs,words:normalized};
 });
 return{schema:'normalized_transcript_timing_v1',sourceSha256:input.sourceSha256,wordPositionBasis:input.wordPositionBasis,sourceDurationMs:input.sourceDurationMs,videoOffsetMs:input.videoOffsetMs,videoDurationMs:input.videoDurationMs,phrases,words,evidence:'automatic_recognition_candidates',humanListeningVerified:false,semanticAlignmentVerified:false,businessCompletedVerified:false};
}
