import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {normalizeTranscriptTiming} from '../bridge/src/content-transcript-timing.mjs';
const base=()=>({schema:'transcript_word_timing_v1',sourceSha256:createHash('sha256').update('synthetic-pcm').digest('hex'),sourceDurationMs:19000,videoOffsetMs:800,videoDurationMs:30000,wordPositionBasis:'phrase_relative',phrases:[{sourceStartMs:270,durationMs:1000,words:[{text:'合成',confidence:.5,positionMs:0,durationMs:380},{text:'样本',confidence:.7,positionMs:380,durationMs:450}]},{sourceStartMs:16760,durationMs:1800,words:[{text:'尾句',confidence:.52,positionMs:0,durationMs:340}]}]});
test('词片段从零开始时，明确加所属phrase及成片offset，三个时基分列',()=>{
 const result=normalizeTranscriptTiming(base());assert.equal(result.words[0].phraseRelativeStartMs,0);assert.equal(result.words[0].sourceStartMs,270);assert.equal(result.words[0].videoStartMs,1070);assert.equal(result.words[2].sourceStartMs,16760);assert.equal(result.words[2].videoStartMs,17560);assert.equal(result.humanListeningVerified,false);assert.equal(result.semanticAlignmentVerified,false);
});
test('已为source绝对时码时不重复加phrase起点，结果等价',()=>{
 const a=base(),b=structuredClone(a);b.wordPositionBasis='source_absolute';for(const p of b.phrases)for(const w of p.words)w.positionMs+=p.sourceStartMs;assert.deepEqual(normalizeTranscriptTiming(a).words,normalizeTranscriptTiming(b).words);
});
test('缺失/auto时基、源pin或长度非法在候选生成前拒绝',()=>{
 for(const mutation of [x=>delete x.wordPositionBasis,x=>x.wordPositionBasis='auto',x=>x.sourceSha256='unknown',x=>x.sourceDurationMs=NaN,x=>x.videoOffsetMs=-1,x=>x.videoDurationMs=1000]){const x=base();mutation(x);assert.throws(()=>normalizeTranscriptTiming(x),{code:'TRANSCRIPT_TIMING_CONTRACT_INVALID'});}
});
test('错把相对词时码当source绝对值、短句/词倒序或越界拒绝',()=>{
 for(const mutation of [x=>x.wordPositionBasis='source_absolute',x=>x.phrases[1].sourceStartMs=1,x=>x.phrases[0].words[1].positionMs=1,x=>x.phrases[0].words[0].durationMs=2000,x=>x.phrases[1].sourceStartMs=18500]){const x=base();mutation(x);assert.throws(()=>normalizeTranscriptTiming(x));}
});
test('没有词时码不伪造为零，不把低置信度改为通过',()=>{
 const x=base();x.phrases[0].words[0].confidence=.001;assert.equal(normalizeTranscriptTiming(x).words[0].confidence,.001);x.phrases[0].words[0].positionMs=null;assert.throws(()=>normalizeTranscriptTiming(x),{code:'TRANSCRIPT_WORD_INVALID'});
});
test('跨短句合计词数也有界，不能用每段小于上限绕过',()=>{
 const x=base();x.phrases=[0,6000].map(sourceStartMs=>({sourceStartMs,durationMs:6000,words:Array.from({length:6000},(_,n)=>({text:'样',confidence:.5,positionMs:n,durationMs:1}))}));assert.throws(()=>normalizeTranscriptTiming(x),{code:'TRANSCRIPT_TIMING_LIMIT'});
});
test('非对象短句或词返回固定合同码，不暴露直接TypeError',()=>{
 for(const value of [null,'bad',1,[]]){const a=base();a.phrases=[value];assert.throws(()=>normalizeTranscriptTiming(a),{code:'TRANSCRIPT_PHRASE_RANGE_INVALID'});const b=base();b.phrases[0].words=[value];assert.throws(()=>normalizeTranscriptTiming(b),{code:'TRANSCRIPT_WORD_INVALID'});}
});
