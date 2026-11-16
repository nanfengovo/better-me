/** Offsets are UTF-16 textarea offsets in the displayed candidate, not audio timestamps. */
export type ReviewMark = {start:number;end:number;kind:"否定词"|"数值"|"术语"|"可能听错";text:string};
export type SpeechSegment = {text:string; result?:{word:string;conf?:number}[]};
const compact=(s:string)=>s.trim().replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu,"");

export function finishDictation(segments:SpeechSegment[]){
  let transcript="";const uncertain:ReviewMark[]=[];
  for(const segment of segments){
    const part=compact(segment.text);if(!part)continue;
    if(transcript&&!(/\p{Script=Han}$/u.test(transcript)&&/^\p{Script=Han}/u.test(part)))transcript+=" ";
    const base=transcript.length;transcript+=part;
    let cursor=0,matched=true;const aligned:ReviewMark[]=[];
    for(const token of segment.result??[]){
      while(cursor<part.length&&/\s/u.test(part[cursor]!))cursor++;
      if(typeof token.word!=="string"||!token.word||!part.startsWith(token.word,cursor)){matched=false;break;}
      if(typeof token.conf==="number"&&token.conf>=0&&token.conf<0.75)
        aligned.push({start:base+cursor,end:base+cursor+token.word.length,text:token.word,kind:"可能听错"});
      cursor+=token.word.length;
    }
    // Some engines omit or split punctuation differently. Never mark a guessed offset.
    if(matched&&cursor===part.length)uncertain.push(...aligned);
  }
  return {transcript,uncertain};
}

/** These are navigational cues, not a dictionary, fact checker or automatic correction. */
export function dictationReviewMarks(text:string,uncertain:readonly ReviewMark[]=[]):ReviewMark[]{
  const marks:ReviewMark[]=[];
  const add=(kind:ReviewMark["kind"],pattern:RegExp)=>{for(const m of text.matchAll(pattern)){
    const start=m.index,end=start+m[0].length;marks.push({start,end,text:m[0],kind});
  }};
  add("否定词",/并没有|没有|没能|并未|未曾|未能|从未|并不是|并非|不负责|不需要|无需|无须|不是|不能|不会|绝不|不|未|没/gu);
  add("数值",/百分之[零〇一二两三四五六七八九十百千万点\d.]+|(?<![a-z\d])[-+＋－]?[\d０-９]+(?:[.,．][\d０-９]+)*(?:\s*[%％]|年|月|天|次|人|台|倍|毫秒|分钟|秒)?|[零〇一二两三四五六七八九十百千万亿]+(?:点[零〇一二三四五六七八九]+)?(?:年|月|周|天|次|人|台|倍|毫秒|分钟|秒)/giu);
  add("术语",/(?<![A-Za-z0-9])(?:\.NET|C\+\+|C#|[A-Z][A-Za-z0-9]*(?:[.-][A-Za-z0-9]+)*)(?![A-Za-z0-9])/gu);
  const ordered=[...marks,...uncertain.filter(m=>m.kind==="可能听错"&&m.start>=0&&m.end>m.start&&text.slice(m.start,m.end)===m.text)]
    .sort((a,b)=>a.start-b.start||Number(a.kind==="可能听错")-Number(b.kind==="可能听错")||b.end-a.end);
  const result:ReviewMark[]=[];
  for(const m of ordered){if(!result.length||m.start>=result[result.length-1]!.end)result.push(m);}
  return result;
}
