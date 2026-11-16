import assert from "node:assert/strict";
import test from "node:test";
import { dictationReviewMarks, finishDictation } from "../src/lib/dictation-review";

test("a transcript keeps the words actually heard; only locatable words, negations, quantities and terms are flagged",()=>{
  const sample=finishDictation([{text:"我 只 设计 了 重 是 流程",result:[
    {word:"我",conf:1},{word:"只",conf:1},{word:"设计",conf:1},{word:"了",conf:1},
    {word:"重",conf:0.43},{word:"是",conf:0.68},{word:"流程",conf:1}]},{text:"没有 上线"}]);
  assert.equal(sample.transcript,"我只设计了重是流程没有上线"); // must never silently turn 重是 into 重试
  const marks=dictationReviewMarks(sample.transcript,sample.uncertain);
  assert.deepEqual(marks.map(m=>[m.kind,m.text]),[["可能听错","重"],["可能听错","是"],["否定词","没有"]]);
  assert.deepEqual(dictationReviewMarks("🎙只测了 Redis 和 C++，耗时三十毫秒，不是 12.5%。").map(m=>[m.kind,m.text]),[
    ["术语","Redis"],["术语","C++"],["数值","三十毫秒"],["否定词","不是"],["数值","12.5%"]]);
  for(const mark of marks)assert.equal(sample.transcript.slice(mark.start,mark.end),mark.text);
  assert.deepEqual(finishDictation([{text:"不 是",result:[{word:"不是的",conf:0.1}]}]).uncertain,[]);
});

test("an exact prefix does not validate a result with additional mismatched words",()=>{
  assert.deepEqual(finishDictation([{text:"不是",result:[{word:"不",conf:0.4},{word:"是",conf:0.5},{word:"的",conf:0.1}]}]).uncertain,[]);
});
