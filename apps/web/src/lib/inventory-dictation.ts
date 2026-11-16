/** A question-scoped, local Mandarin recognizer. Only its editable text leaves this module.
 * No audio Blob, persistence, remote speech API or task transport. */
import { finishDictation, type ReviewMark, type SpeechSegment } from "./dictation-review";
type Recognition = { on(event:"result"|"partialresult"|"error",cb:(e:{result?:Partial<SpeechSegment>})=>void):void;
  setWords(enabled:boolean):void;
  acceptWaveformFloat(samples:Float32Array,rate:number):void;retrieveFinalResult():void;remove():void };
type Model = { on(event:"load"|"error",cb:(e:{result?:boolean})=>void):void;
  KaldiRecognizer:new(rate:number)=>Recognition;worker:Worker };
type Engine = { Model:new(url:string,logLevel:number)=>Model };
type VoiceWindow = Window & {Vosk?:Engine;__BETTER_ME_DESKTOP__?:boolean;desktopApi?:{
  armInventoryMicrophone?:()=>Promise<boolean>;disarmInventoryMicrophone?:()=>void }};
const assets="/speech/vosk-cn-v1/", rate=16000, maxFrames=rate*30;
const integrity="sha384-nqyY8clHf93uBYFkgkACShMTuvE3U57yXSJaf0Ws+XgzcoUe6OB/1BiOfHqKOWeg";
let library:Promise<Engine>|undefined;
function loadEngine():Promise<Engine>{
  if(!library)library=new Promise<Engine>((ok,fail)=>{
    const tag=document.createElement("script");tag.src=new URL(assets+"vosk.js",location.origin).href;
    tag.integrity=integrity;tag.crossOrigin="anonymous";tag.async=true;
    tag.onload=()=>{const v=(window as VoiceWindow).Vosk;if(v?.Model)ok(v);else fail(Error("本机语音组件不可用。"));};
    tag.onerror=()=>fail(Error("未能加载或校验本机语音组件。"));document.head.append(tag);
  }).catch((e:unknown)=>{library=undefined;throw e;});
  return library;
}
export type DictationState={phase:"idle"|"loading"|"ready"|"opening"|"listening"|"finishing"|"review"|"error";message?:string;transcript?:string;uncertain?:ReviewMark[]};
export class InventoryDictation {
  private state:DictationState={phase:"idle"};
  private generation=0;
  private model?:Model;
  private rec?:Recognition;
  private stream?:MediaStream;
  private context?:AudioContext;
  private worklet?:AudioWorkletNode;
  private source?:MediaStreamAudioSourceNode;
  private timer?:ReturnType<typeof setTimeout>;
  private held=false;
  constructor(private notify:(s:DictationState)=>void,private authorize:()=>void){}
  private publish(phase:DictationState["phase"],message?:string,transcript?:string,uncertain?:ReviewMark[]){
    this.state={phase,message,transcript,uncertain};this.notify(this.state);
  }
  private valid(n:number){
    if(n!==this.generation)return false;
    try{this.authorize();return true;}catch{this.cancel();return false;}
  }
  private stopTracks(){
    (window as VoiceWindow).desktopApi?.disarmInventoryMicrophone?.();
    this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.stream=undefined;
  }
  private stopMic(){
    this.stopTracks();
    this.source?.disconnect();this.source=undefined;
    if(this.worklet){this.worklet.onprocessorerror=null;this.worklet.port.onmessage=null;this.worklet.port.close();this.worklet.disconnect();this.worklet=undefined;}
    const c=this.context;this.context=undefined;if(c&&c.state!=="closed")void c.close().catch(()=>{});
  }
  private stopTurn(){
    clearTimeout(this.timer);this.timer=undefined;this.held=false;
    this.stopMic();this.rec?.remove();this.rec=undefined;
  }
  cancel(emit=true){
    ++this.generation;this.stopTurn();
    // The pinned library's public terminate message touches model.delete() even
    // during asynchronous loading. Hard-close this question's dedicated worker,
    // including any queued PCM, when cancelled, unloaded or deauthorized.
    this.model?.worker.terminate();this.model=undefined;
    if(emit)this.publish("idle");
  }
  private failure(n:number,message:string){
    if(!this.valid(n))return;
    this.cancel(false);this.publish("error",message);
  }
  async prepare(){
    if(this.state.phase!=="idle"&&this.state.phase!=="error")return;
    const n=++this.generation;if(!this.valid(n))return;
    if(!window.isSecureContext||!navigator.mediaDevices?.getUserMedia||typeof AudioContext==="undefined"||typeof AudioWorkletNode==="undefined"){
      this.failure(n,"此环境不支持本机语音输入，请继续打字。");return;
    }
    this.publish("loading");this.timer=setTimeout(()=>this.failure(n,"本机普通话资源加载超时，请继续打字或重试。"),75000);
    try{
      const engine=await loadEngine();if(!this.valid(n))return;
      const model=new engine.Model(new URL(assets+"small-cn-0.22.tar.gz",location.origin).href,-2);this.model=model;
      const onError=()=>{if(this.model===model)this.failure(this.generation,"本机普通话资源不可用。没有改用在线听写。");};
      model.on("error",onError);model.worker.addEventListener("error",onError);
      model.on("load",e=>{if(!this.valid(n))return;
        if(!e.result){this.failure(n,"未能准备普通话模型。没有打开麦克风。");return;}
        clearTimeout(this.timer);this.publish("ready");});
    }catch{this.failure(n,"本机语音组件不可用。没有改用在线听写。");}
  }
  async press(){
    if(this.state.phase!=="ready"||!this.model)return;
    const n=++this.generation;if(!this.valid(n))return;
    const desktop=window as VoiceWindow;this.held=true;this.publish("opening");
    this.timer=setTimeout(()=>this.failure(n,"没有及时取得麦克风许可。请重新按住，或继续打字。"),15000);
    try{
      const audio=new AudioContext({sampleRate:rate});this.context=audio;
      const resume=audio.resume();void resume.catch(()=>{});
      const check=audio.audioWorklet.addModule(new URL(assets+"capture.js",location.origin).href);void check.catch(()=>{});
      if(desktop.__BETTER_ME_DESKTOP__ && !await desktop.desktopApi?.armInventoryMicrophone?.()){
        this.failure(n,"桌面窗口未允许本次麦克风访问。没有请求摄像头或切换到云端。");return;
      }
      if(!this.valid(n)||!this.held)return;
      const stream=await navigator.mediaDevices.getUserMedia({video:false,audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
      if(!this.valid(n)||!this.held){stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;
      await Promise.all([resume,check]);if(!this.valid(n)||!this.held)return;
      const mic=stream.getAudioTracks()[0];if(!mic||stream.getVideoTracks().length||audio.sampleRate!==rate)throw Error("invalid input");
      mic.onended=()=>this.failure(n,"麦克风已断开，本次未采用。");
      const rec=new this.model!.KaldiRecognizer(rate);this.rec=rec;rec.setWords(true);
      const chunks:SpeechSegment[]=[];let pending=0,frames=0,flushed=false,drained=false;
      // Normal utterances and retrieveFinalResult use the same result event.
      // Wait for the last worklet packet AND every per-packet acknowledgement.
      const flush=()=>{if(drained&&pending===0&&!flushed){flushed=true;rec.retrieveFinalResult();}};
      const response=(e:{result?:Partial<SpeechSegment>})=>{
        if(n!==this.generation)return;
        if(e.result?.text)chunks.push({text:e.result.text,result:e.result.result});
        if(flushed){
          if(!this.valid(n))return;
          ++this.generation;this.stopTurn();
          const {transcript,uncertain}=finishDictation(chunks);
          if(!transcript){this.publish("ready","没有识别到清楚的普通话，可以再说一次或打字。");return;}
          this.publish("review",undefined,transcript,uncertain);return;
        }
        pending=Math.max(0,pending-1);flush();
      };
      rec.on("result",response);rec.on("partialresult",response);
      rec.on("error",()=>this.failure(n,"本机识别中断，未填入回答。"));
      const worklet=new AudioWorkletNode(audio,"betterme-inventory-mono",{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      this.worklet=worklet;
      worklet.onprocessorerror=()=>this.failure(n,"本机声音采集失败，请重新开始。");
      worklet.port.onmessage=({data}:MessageEvent<unknown>)=>{
        // Owner/page cancellation invalidates the generation synchronously.
        // Do not re-project and hash a large resume for every 128 ms of PCM.
        if(n!==this.generation||drained)return;
        if(data==="drained"&&this.state.phase==="finishing"){drained=true;this.stopMic();flush();return;}
        if(!(data instanceof Float32Array)||!data.length)return;
        const count=Math.min(data.length,maxFrames-frames);
        if(count>0){pending++;frames+=count;
          try{rec.acceptWaveformFloat(data.subarray(0,count),rate);}catch{this.failure(n,"离线识别未能处理本段声音。");return;}}
        if(frames>=maxFrames)this.release();
      };
      this.source=audio.createMediaStreamSource(stream);this.source.connect(worklet);worklet.connect(audio.destination); // processor outputs silence
      this.publish("listening");clearTimeout(this.timer);this.timer=setTimeout(()=>this.release(),30000);
    }catch{this.failure(n,"未能使用麦克风。请核对系统/浏览器许可，或继续打字。");}
  }
  release(){
    if(!this.held)return;
    const n=this.generation;this.held=false;clearTimeout(this.timer);
    if(this.state.phase==="opening"){++this.generation;this.stopTurn();this.publish("ready","未开始收音。准备好后再按住说话。");return;}
    if(this.state.phase!=="listening")return;
    this.stopTracks();this.publish("finishing");
    this.timer=setTimeout(()=>this.failure(n,"本机转写未完成，未采用不完整结果。"),15000);
    this.worklet?.port.postMessage("finish");
  }
  next(){if(this.state.phase==="review"){this.publish("ready");}}
}
