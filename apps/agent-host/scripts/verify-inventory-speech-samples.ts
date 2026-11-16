/** Offline diagnostic, not a real-speaker accuracy benchmark. No account, microphone, Host or model API. */
import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { dictationReviewMarks, finishDictation, type SpeechSegment } from "../../web/src/lib/dictation-review.js";
import { inventoryQaWav } from "./inventory-voice-qa-audio.js";

const cases=[
  {sentence:"我只设计了重试流程，没有上线。",anchors:[["否定","没有"],["术语","重试"]]},
  {sentence:"我不负责部署，只负责接口设计。",anchors:[["否定","不负责"],["术语","接口"]]},
  {sentence:"测试用了三台机器，耗时十二秒。",anchors:[["数值","三台|3台"],["数值","十二秒|12秒"]]},
  {sentence:"项目在二零二三年三月结束。",anchors:[["数值","二[零〇]二三年|2023年"],["数值","三月|3月"]]},
  {sentence:"我测试了 Redis 缓存，没有负责部署。",anchors:[["否定","没有"],["术语","Redis"]]},
];
const assetDir=fileURLToPath(new URL("../../../apps/web/dist/speech/vosk-cn-v1/",import.meta.url));
const root=await fs.mkdtemp(path.join(os.tmpdir(),"betterme-speech-samples-"));
const files=new Map([["/vosk.js","text/javascript"],["/small-cn-0.22.tar.gz","application/gzip"]]);
const server=http.createServer(async(req,res)=>{
  if(req.url==="/" && req.method==="GET"){res.writeHead(200,{"Content-Type":"text/html"}).end("<!doctype html><title>Synthetic offline speech</title>");return;}
  const type=req.url&&files.get(req.url);
  if(!type||req.method!=="GET"){res.writeHead(404).end();return;}
  try{const data=await fs.readFile(path.join(assetDir,req.url!.slice(1)));res.writeHead(200,{"Content-Type":type}).end(data);}
  catch{res.writeHead(503).end();}
});
server.listen(0,"127.0.0.1");await once(server,"listening");
const address=server.address();assert.ok(address&&typeof address==="object");
const origin="http://127.0.0.1:"+address.port;let browser;
try{
  browser=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--disable-background-networking","--disable-sync"]});
  const ctx=await browser.newContext({permissions:[]});
  await ctx.route("**/*",r=>{const u=new URL(r.request().url());return u.origin===origin||u.protocol==="blob:"||u.protocol==="data:"?r.continue():r.abort();});
  const page=await ctx.newPage();await page.goto(origin);await page.addScriptTag({url:origin+"/vosk.js"});
  type Recognizer={setWords:(b:boolean)=>void;acceptWaveformFloat:(f:Float32Array,rate:number)=>void;retrieveFinalResult:()=>void;remove:()=>void;
    on:(e:string,cb:(v:{result?:Partial<SpeechSegment>})=>void)=>void};
  type Model={on:(e:string,cb:(v:{result?:boolean})=>void)=>void;KaldiRecognizer:new(rate:number)=>Recognizer};
  await page.evaluate(()=>new Promise<void>((resolve,reject)=>{
    const w=window as Window&{Vosk:{Model:new(url:string,level:number)=>Model};sampleModel?:Model};
    const model=new w.Vosk.Model(location.origin+"/small-cn-0.22.tar.gz",-2);w.sampleModel=model;
    const timer=setTimeout(()=>reject(Error("本机模型加载超时")),75000);
    model.on("load",e=>{clearTimeout(timer);if(e.result)resolve();else reject(Error("无法读取模型"));});
    model.on("error",()=>{clearTimeout(timer);reject(Error("本机模型不可用"));});
  }));
  const records=[];
  for(const [i,c] of cases.entries()){
    const dir=path.join(root,String(i+1));await fs.mkdir(dir);
    const sound=await inventoryQaWav(dir,c.sentence), pcm=(await fs.readFile(sound.output)).subarray(44);
    const segments=await page.evaluate(input=>new Promise<SpeechSegment[]>((resolve,reject)=>{
      const w=window as Window&{sampleModel:Model},rec=new w.sampleModel.KaldiRecognizer(16000);
      const data=Uint8Array.from(atob(input),c=>c.charCodeAt(0)), raw=new Int16Array(data.buffer);
      const chunks:SpeechSegment[]=[];let count=0,final=false;
      const timer=setTimeout(()=>{rec.remove();reject(Error("未收到本机识别结果"));},20000);
      // Bind once without a named function initializer (tsx otherwise injects a Node helper into page.evaluate).
      const [receive]=[(v:{result?:Partial<SpeechSegment>})=>{
        if(v.result?.text)chunks.push({text:v.result.text,result:v.result.result});
        if(final){clearTimeout(timer);rec.remove();resolve(chunks);return;}
        if(--count===0){final=true;rec.retrieveFinalResult();}
      }];
      rec.setWords(true);rec.on("result",receive);rec.on("partialresult",receive);
      rec.on("error",()=>{clearTimeout(timer);rec.remove();reject(Error("识别失败"));});
      for(let i=0;i<raw.length;i+=2048){count++;rec.acceptWaveformFloat(Float32Array.from(raw.subarray(i,i+2048),n=>n/32768),16000);}
    }),pcm.toString("base64"));
    const {transcript,uncertain}=finishDictation(segments);assert.ok(transcript,"no synthetic speech recognized");
    const marks=dictationReviewMarks(transcript,uncertain);
    for(const m of marks)assert.equal(m.text,transcript.slice(m.start,m.end));
    records.push({expected:c.sentence,heard:transcript,anchors:c.anchors.map(([kind,pattern])=>({kind,pattern,preserved:new RegExp(pattern!,"iu").test(transcript)})),
      cues:marks.map(m=>[m.kind,m.text])});
  }
  console.log(JSON.stringify({speaker:"macOS Tingting, rate 145",samples:records,root},null,2));
}finally{await browser?.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});}
