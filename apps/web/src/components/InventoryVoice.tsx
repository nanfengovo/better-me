import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { InventoryDictation, type DictationState } from "../lib/inventory-dictation";
import { dictationReviewMarks, type ReviewMark } from "../lib/dictation-review";

type Props={disabled:boolean;signal:AbortSignal;authorize:()=>void;append:(text:string)=>boolean;onPending:(v:boolean)=>void};
export function InventoryVoice({disabled,signal,authorize,append,onPending}:Props){
  const [v,show]=useState<DictationState>({phase:"idle"}),[words,setWords]=useState("");
  const candidate=useRef<HTMLTextAreaElement>(null);
  const marks=useMemo(()=>dictationReviewMarks(words,words===v.transcript?v.uncertain:[]),[words,v.transcript,v.uncertain]);
  const markButton=(m:ReviewMark)=><button type="button" key={m.start} aria-label={`定位${m.kind}：${m.text}`} onClick={()=>{
    const field=candidate.current;if(!field||field.value.slice(m.start,m.end)!==m.text)return;
    field.focus();field.setSelectionRange(m.start,m.end);
  }}>{m.kind} · {m.text}</button>;
  const current=useRef({authorize,disabled});current.current={authorize,disabled};
  const [input]=useState(()=>new InventoryDictation(s=>{
    show(s);setWords(s.transcript??"");onPending(!["idle","ready","error"].includes(s.phase));
  },()=>{if(current.current.disabled||document.hidden||signal.aborted)throw Error("语音输入已失效");current.current.authorize();}));
  useLayoutEffect(()=>{
    const cancel=()=>input.cancel(),hidden=()=>{if(document.hidden)cancel();};
    signal.addEventListener("abort",cancel);window.addEventListener("pagehide",cancel);window.addEventListener("blur",cancel);
    document.addEventListener("visibilitychange",hidden);
    return()=>{signal.removeEventListener("abort",cancel);window.removeEventListener("pagehide",cancel);window.removeEventListener("blur",cancel);
      document.removeEventListener("visibilitychange",hidden);input.cancel(false);onPending(false);};
  },[input,signal,onPending]);
  useLayoutEffect(()=>{if(disabled)input.cancel();},[disabled,input]);
  const holding=v.phase==="opening"||v.phase==="listening", ready=v.phase==="ready"||holding;
  return <section className="iv-voice" aria-label="本机普通话输入">
    {(v.phase==="idle"||v.phase==="error")&&<button type="button" disabled={disabled} onClick={()=>void input.prepare()}><Mic size={15} aria-hidden="true"/>准备本机语音输入</button>}
    {v.phase==="idle"&&<small>普通话 · 仅本机识别。准备不会打开麦克风。</small>}
    {ready&&<button type="button" className="iv-voice-hold" aria-label="按住说话" aria-pressed={holding}
      onPointerDown={e=>{if(disabled||e.button!==0||!e.isPrimary)return;e.currentTarget.setPointerCapture(e.pointerId);void input.press();}}
      onPointerUp={()=>input.release()} onPointerCancel={()=>input.cancel()} onLostPointerCapture={()=>input.release()}
      onContextMenu={e=>e.preventDefault()}
      onKeyDown={e=>{if(e.key===" "||e.key==="Enter"){e.preventDefault();if(!e.repeat)void input.press();}}}
      onKeyUp={e=>{if(e.key===" "||e.key==="Enter"){e.preventDefault();input.release();}}}
      onBlur={()=>input.release()}><Mic size={15} aria-hidden="true"/>{holding?"松开结束":"按住说话"}</button>}
    <small role="status">{v.message??({idle:"",error:"",loading:"正在准备本机普通话模型…",ready:"按住按钮或空格键说话，松开核对，最长 30 秒。",opening:"等待麦克风许可…",listening:"正在本机收音，松开结束。",finishing:"麦克风已关闭，正在整理最后一句…",review:marks.length?"点下方提示，逐处核对原词；没标出的词也可能听错。":"请核对整段，尤其是否定、数字和术语。"})[v.phase]}</small>
    {(holding||v.phase==="loading"||v.phase==="finishing")&&<button type="button" onClick={()=>input.cancel()}>取消本次语音</button>}
    {v.phase==="review"&&<><label className="iv-field">核对本次转写<textarea ref={candidate} value={words} maxLength={7000} onChange={e=>setWords(e.target.value)}/></label>
      {marks.length>0&&<div className="iv-review-marks" role="group" aria-label="定位需要核对的原词">
        {marks.slice(0,6).map(markButton)}
        {marks.length>6&&<details><summary>另外 {marks.length-6} 处</summary>{marks.slice(6).map(markButton)}</details>}
      </div>}
      <div className="iv-actions"><button type="button" disabled={!words.trim()||disabled} onClick={()=>{
        try{current.current.authorize();if(!signal.aborted&&append(words.trim()))input.next();}catch{input.cancel();}
      }}>填入回答</button><button type="button" onClick={()=>input.next()}>丢弃转写</button></div></>}
  </section>;
}
