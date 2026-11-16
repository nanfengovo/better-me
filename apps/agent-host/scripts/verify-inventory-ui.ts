/** Opt-in QA with disposable identities, local HTTP, the compiled product renderer and zero external inference. */
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { MemorySaver } from "@langchain/langgraph";
import { chromium,_electron,type Page } from "playwright-core";
import { createAgentServer } from "../src/server.js";
import { inventoryQaWav } from "./inventory-voice-qa-audio.js";
import { createDefaultResumeView, projectResume, projectedResumeToMarkdown, type FactBase } from "@better-me/core";

const root=fileURLToPath(new URL("../../../",import.meta.url)), installed=process.argv.includes("--installed"),
  dist=path.resolve(root,installed?"../BetterMe.app/Contents/Resources/app/dist":"apps/web/dist");
const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"betterme-inventory-qa-")));
const sound=process.argv.includes("--dictation")?await inventoryQaWav(dir):undefined, spoken:Record<string,string>={};
const onlyNative=process.argv.includes("--native-only"),onlyWeb=process.argv.includes("--web-only");
assert.ok(!(onlyWeb&&onlyNative),"select one platform or omit both flags for the two-platform gate");
const token="synthetic_inventory_"+"x".repeat(44), output=path.join(dir,"captures");
await fs.mkdir(output);const totals={model:0,blockedBrowserRequests:0},paths:string[]=[];
let backendPort=0, origin="";
const ui=http.createServer((req,res)=>{void (async()=>{
  const url=new URL(req.url??"/",origin);
  if(url.pathname.startsWith("/api/")){
    paths.push(req.method+" "+url.pathname);
    if(!/^\/api\/v1\/agent\/(?:identity|inventory|tasks|records|routing|chatgpt|understanding)(?:\/|$)/.test(url.pathname)){
      res.writeHead(404,{"Content-Type":"application/json"});res.end('{"error":"fixture_route_denied"}');return;
    }
    const proxy=http.request({host:"127.0.0.1",port:backendPort,path:req.url,method:req.method,headers:{...req.headers,host:"127.0.0.1:"+backendPort}}, upstream=>{res.writeHead(upstream.statusCode??502,upstream.headers);upstream.pipe(res);});
    req.pipe(proxy);proxy.on("error",()=>{res.statusCode=502;res.end();});return;
  }
  const file=path.resolve(dist,"."+decodeURIComponent(url.pathname==="/"?"/index.html":url.pathname));assert.ok(file.startsWith(dist+path.sep));
  const data=await fs.readFile(file), type=path.extname(file), mime:Record<string,string>={".html":"text/html;charset=utf-8",".js":"application/javascript",".css":"text/css",".jpg":"image/jpeg",".png":"image/png",".svg":"image/svg+xml",".woff2":"font/woff2"};
  res.setHeader("Content-Type",mime[type]??"application/octet-stream");
  res.end(type===".html"?data.toString().replace("<head>","<head><script>window.__BETTER_ME_RUNTIME__="+JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})+"</script>"):data);
})().catch(()=>{res.statusCode=404;res.end();});});
ui.listen(0,"127.0.0.1");await once(ui,"listening");const addr=ui.address();assert.ok(addr&&typeof addr!=="string");origin="http://127.0.0.1:"+addr.port;
let nativeDownload:string|undefined,nativeProfile:string|undefined;
const host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],
  identityDirectory:path.join(dir,"accounts"),runsDirectory:path.join(dir,"runs"),understandingDirectory:path.join(dir,"understanding"),checkpointer:new MemorySaver() as never,
  careerTaskReasoner:async()=>async(_prompt,_sig,phase)=>{assert.equal(phase,"career_inventory");totals.model++;return JSON.stringify({question:"你在回放器里亲手验证了哪个行为？"});}});
await once(host,"listening");const h=host.address();assert.ok(h&&typeof h!=="string");backendPort=h.port;
const facts:FactBase={schemaVersion:1,updatedAt:"2024-04-01T00:00:00.000Z",profile:{displayName:{zh:"合成用例"},links:[{label:"往年独立作品集",url:"https://example.invalid/portfolio"}],targetRoles:[],traits:[],constraints:[]},
  experiences:[{id:"w",type:"work",org:{zh:"示例团队"},title:{zh:"接口开发"},start:"2021-05",end:"2023-09",claims:[
    {id:"c",kind:"action",text:{zh:"参与接口维护"},tags:[]},{id:"retry",kind:"action",text:{zh:"记录重试接口的调用顺序"},tags:[]}],techStack:[]}],
  importSource:{fileName:"旧稿.txt",importedAt:"2024-04-01T00:00:00.000Z",rawText:"合成旧稿",unparsedLines:["旧稿未归位：开源命令行脚本"]}};
const baseMd=projectedResumeToMarkdown(projectResume(facts,createDefaultResumeView(facts)));
const json=JSON.stringify(facts), redline="可以短期出差，绝不接受长期驻场", blank="这条私密回答不选";
const press=(p:Page,s:string|RegExp)=>p.getByRole("button",{name:s,exact:typeof s==="string"}).click();
async function advance(p:Page,label:string){
  const before=await p.locator("#inventory-title").innerText();
  await press(p,label);await p.waitForFunction(s=>document.querySelector("#inventory-title")?.textContent!==s,before,{timeout:12000});
}
const save=(p:Page)=>advance(p,"保存回答并继续");
async function theme(p:Page,value:"dark"|"light"){
  await p.evaluate(value=>{const key="betterme.ui.preferences.v1";localStorage.setItem(key,JSON.stringify({theme:value}));
    window.dispatchEvent(new StorageEvent("storage",{key,storageArea:localStorage}));},value);
  await p.waitForFunction(v=>document.documentElement.dataset.theme===v,value);
}
async function setup(p:Page,name:string){
  await p.goto(origin);const ctx=p.context(), reg=await ctx.request.post(origin+"/api/v1/agent/identity/register",{headers:{Authorization:"Bearer "+token,Origin:origin},data:{username:name,password:"synthetic-only-inventory-fixture",displayName:"合成验收"}});
  assert.equal(reg.status(),200,await reg.text());const id=(await reg.json()).principal.id;
  await p.evaluate(id=>{localStorage.setItem("betterme.owner.v1:"+id+":betterme:onboarding:v1",'{"version":1,"state":"skipped"}');localStorage.setItem("betterme:onboarding:v1",'{"version":1,"state":"skipped"}');},id);
  await p.reload();await p.getByRole("button",{name:"盘点履历",exact:true}).waitFor({timeout:60000});
  if(name.endsWith("-bypass")){
    await press(p,"更多简历操作");await press(p,"导入简历");
    await p.locator('input[type=file][accept*=".pdf"]').setInputFiles({name:"另一份合成旧稿.json",mimeType:"application/json",buffer:Buffer.from(json)});
    await press(p,"确认替换简历并选择下一步");const before=paths.filter(s=>s.startsWith("POST /api/v1/agent/inventory")).length;
    await press(p,"直接进入编辑");await p.getByRole("button",{name:"一起盘点最近的变化",exact:true}).waitFor({state:"hidden"});assert.equal(paths.filter(s=>s.startsWith("POST /api/v1/agent/inventory")).length,before);return id;
  }
  await press(p,"更多简历操作");await press(p,"导入简历");
  await p.locator('input[type=file][accept*=".pdf"]').setInputFiles({name:"合成旧稿.json",mimeType:"application/json",buffer:Buffer.from(json)});
  await press(p,"确认替换简历并选择下一步");await p.getByRole("button",{name:"一起盘点最近的变化",exact:true}).waitFor();return id;
}
async function runFlow(p:Page,platform:string,focusWindow:()=>Promise<void>=async()=>{}){
  let err="";p.on("pageerror",e=>{err=e.message;});p.setDefaultTimeout(12000);
  const id=await setup(p,"synthetic-inventory-"+platform);
  await press(p,"一起盘点最近的变化");await press(p,"开始盘点");
  let savedBaseline="约 2023 年秋";
  if(sound){
    if(platform==="desktop")assert.equal(await p.evaluate(async()=>{
      try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(t=>t.stop());return "unexpected grant";}
      catch(e){return (e as Error).name;}
    }),"NotAllowedError","a real native media request without a press must be refused");
    const starts=await p.evaluate(pcm=>{const orig=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      const audit={requests:0,tracks:[] as MediaStreamTrack[]};Object.assign(window,{__voiceAudit:audit});
      navigator.mediaDevices.getUserMedia=async limits=>{audit.requests++;const stream=await orig(limits);audit.tracks.push(...stream.getTracks());return stream;};
      // Sandboxed macOS Electron cannot read a fake microphone WAV from arbitrary tmp paths.
      // Exercise the real native permission + track lifecycle, then feed known PCM at the
      // audio-source seam. Worklet, recognizer, end-of-stream and UI remain production code.
      if(pcm){
        const input=AudioContext.prototype.createMediaStreamSource;
        const raw=Uint8Array.from(atob(pcm),c=>c.charCodeAt(0)),samples=new Int16Array(raw.buffer);
        AudioContext.prototype.createMediaStreamSource=function(stream){
          const track=stream.getAudioTracks()[0];
          if(!track||!audit.tracks.includes(track)||track.readyState!=="live")throw Error("missing native grant");
          const native=input.call(this,stream),silent=this.createGain(),dest=this.createMediaStreamDestination();
          silent.gain.value=0;native.connect(silent).connect(dest);
          const src=this.createBufferSource(),buf=this.createBuffer(1,samples.length,16000);
          buf.copyToChannel(Float32Array.from(samples,n=>n/32768),0);src.buffer=buf;src.connect(dest);src.start();return input.call(this,dest.stream);
        };
      }
      return audit.requests;
    },platform==="desktop"?(await fs.readFile(sound.output)).subarray(44).toString("base64"):null);
    const before=paths.filter(s=>s.startsWith("POST /api/v1/agent/inventory")).length;
    const draft=p.getByLabel("我的回答");await draft.fill(savedBaseline);
    await press(p,"准备本机语音输入");
    const talk=p.getByRole("button",{name:"按住说话",exact:true});await talk.waitFor({timeout:65000});
    const requests=()=>p.evaluate(()=>(window as unknown as {__voiceAudit:{requests:number}}).__voiceAudit.requests);
    assert.equal(await requests(),starts);const candidate=p.getByLabel("核对本次转写");
    await focusWindow();await talk.focus();await p.keyboard.down("Space");await p.getByText("正在本机收音，松开结束。",{exact:true}).waitFor();
    await new Promise(r=>setTimeout(r,sound.duration*1000));await p.keyboard.up("Space");
    await candidate.waitFor({timeout:18000});const transcript=await candidate.inputValue();assert.match(transcript,/没有/);
    spoken[platform]=transcript;assert.equal(await draft.inputValue(),savedBaseline);
    await press(p,"定位否定词：没有");
    const selected=()=>candidate.evaluate(el=>{const input=el as HTMLTextAreaElement;
      return document.activeElement===input ? input.value.slice(input.selectionStart,input.selectionEnd) : "";});
    assert.equal(await selected(),"没有");assert.equal(await candidate.inputValue(),transcript);
    await p.getByRole("region",{name:"本机普通话输入"}).screenshot({path:path.join(output,platform+"-voice-review.png"),scale:"css"});
    assert.ok(await p.getByRole("button",{name:"保存回答并继续"}).isDisabled());
    assert.ok(await p.evaluate(()=>(window as unknown as {__voiceAudit:{tracks:MediaStreamTrack[]}}).__voiceAudit.tracks.every(t=>t.readyState==="ended")));
    await candidate.fill("只测试了 12.5%，未上线。");await press(p,"定位数值：12.5%");assert.equal(await selected(),"12.5%");
    assert.equal(await p.getByRole("button",{name:"定位否定词：没有",exact:true}).count(),0);
    assert.equal(await draft.inputValue(),savedBaseline);
    await candidate.fill("这条转写不要保存");await press(p,"丢弃转写");assert.equal(await draft.inputValue(),savedBaseline);
    await focusWindow();await talk.focus();await p.keyboard.down("Space");await p.getByText("正在本机收音，松开结束。",{exact:true}).waitFor();
    await p.keyboard.press("Escape");await p.keyboard.up("Space");await p.getByRole("dialog",{name:"底稿时效"}).waitFor({state:"hidden"});
    await press(p,"盘点履历");await p.getByRole("button",{name:"准备本机语音输入",exact:true}).waitFor();
    assert.equal(await draft.inputValue(),"");
    assert.equal(await requests(),starts+2);
    assert.ok(await p.evaluate(()=>(window as unknown as {__voiceAudit:{tracks:MediaStreamTrack[]}}).__voiceAudit.tracks.every(t=>t.readyState==="ended")));
    assert.equal(paths.filter(s=>s.startsWith("POST /api/v1/agent/inventory")).length,before);
    if(platform==="web")assert.equal(totals.model,0);
    await draft.fill(savedBaseline);await press(p,"准备本机语音输入");await talk.waitFor({timeout:70000});
    await focusWindow();const rect=await talk.boundingBox();assert.ok(rect);await p.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);await p.mouse.down();
    await p.getByText("正在本机收音，松开结束。",{exact:true}).waitFor();await new Promise(r=>setTimeout(r,sound.duration*1000));await p.mouse.up();
    await candidate.waitFor({timeout:18000});assert.match(await candidate.inputValue(),/没有/);
    await candidate.fill("我只设计了重试流程，没有上线。");await press(p,"填入回答");
    savedBaseline+="\n我只设计了重试流程，没有上线。";assert.equal(await draft.inputValue(),savedBaseline);
    assert.equal(await requests(),starts+3);
    assert.equal(paths.filter(s=>s.startsWith("POST /api/v1/agent/inventory")).length,before);
    if(platform==="web"){
      // Late permission completion: key-up invalidates this hold; no track may
      // reopen and no late result may reach the question after it was released.
      await p.evaluate(()=>{
        const previous=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        Object.assign(window,{__qaPreviousMedia:previous});
        navigator.mediaDevices.getUserMedia=async constraints=>{
          const stream=await previous(constraints);
          await new Promise<void>(resume=>Object.assign(window,{__finishQaPermission:resume}));
          return stream;
        };
      });
      await talk.focus();await p.keyboard.down("Space");
      await p.waitForFunction(()=>Object.hasOwn(window,"__finishQaPermission"));await p.keyboard.up("Space");
      await p.evaluate(()=>(window as unknown as {__finishQaPermission:()=>void}).__finishQaPermission());
      await p.waitForFunction(()=>(window as unknown as {__voiceAudit:{tracks:MediaStreamTrack[]}}).__voiceAudit.tracks.every(t=>t.readyState==="ended"));
      assert.equal(await draft.inputValue(),savedBaseline);assert.equal(await candidate.count(),0);
      // Real browser failure contract, with a test-only denial instead of asking a human.
      await p.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException("denied","NotAllowedError");};});
      await talk.focus();await p.keyboard.down("Space");await p.getByText(/未能使用麦克风/).waitFor();await p.keyboard.up("Space");
      assert.equal(await draft.inputValue(),savedBaseline);assert.ok(await draft.isEditable());
      assert.equal(paths.filter(s=>s.startsWith("POST /api/v1/agent/inventory")).length,before);
      assert.equal(totals.model,0);
      await p.evaluate(()=>{navigator.mediaDevices.getUserMedia=(window as unknown as {__qaPreviousMedia:MediaDevices["getUserMedia"]}).__qaPreviousMedia;});
    }
  }
  if(!sound)await p.getByLabel("我的回答").fill(savedBaseline);await save(p);
  await p.getByLabel("我的回答").fill("近来在做一个个人回放器");
  if(platform==="web"){await press(p,"请模型追问");assert.equal(totals.model,0);await press(p,"同意发送这两段 · 追问一次");
    const reply=p.getByLabel(/模型追问：/);await reply.fill("我验证了按序播放。");assert.equal(totals.model,1);
    if(sound){
      await press(p,"准备本机语音输入");const hold=p.getByRole("button",{name:"按住说话",exact:true});await hold.waitFor({timeout:70000});await hold.focus();
      await p.keyboard.down("Enter");await p.getByText("正在本机收音，松开结束。",{exact:true}).waitFor();
      await new Promise(r=>setTimeout(r,sound.duration*1000));await p.keyboard.up("Enter");
      const words=p.getByLabel("核对本次转写");await words.waitFor({timeout:18000});assert.match(await words.inputValue(),/没有/);
      await words.fill("没有上线。");await press(p,"填入回答");
      assert.equal(await reply.inputValue(),"我验证了按序播放。\n没有上线。");assert.equal(await p.getByLabel("我的回答").inputValue(),"近来在做一个个人回放器");assert.equal(totals.model,1);
    }}
  await save(p);
  await p.getByLabel("我的回答").fill("业余做了事件回放器");await p.getByLabel("材料类型").selectOption("portfolio");await save(p);
  await p.getByLabel("我的回答").fill("我只设计了重试流程，没有做生产上线。");await save(p);
  await p.getByRole("heading",{name:"往年独立作品集"}).waitFor();await advance(p,"跳过这项");
  await p.getByRole("heading",{name:"待归位材料 1"}).waitFor();await advance(p,"跳过这项");
  await p.getByLabel("我的回答").fill(blank);await save(p);
  for(const label of ["喜欢的工作","喜欢的团队氛围","不喜欢的工作或氛围"]){await p.getByRole("heading",{name:label,exact:true}).waitFor();await advance(p,"跳过这项");}
  await p.getByLabel("我的回答").fill(redline);await p.getByLabel(/希望核对的岗位原词/).fill("长期驻场");await save(p);
  const count=paths.filter(x=>x.startsWith("POST /api/v1/agent/inventory")).length, models=totals.model;
  await p.reload();await press(p,"盘点履历");await p.getByRole("heading",{name:"未来方向"}).waitFor();
  assert.equal(paths.filter(x=>x.startsWith("POST /api/v1/agent/inventory")).length,count);assert.equal(totals.model,models);
  await press(p,"先看共识卡");await press(p,"全选本次原话");await p.getByRole("checkbox",{name:"做事和协作方式"}).uncheck();
  if(platform==="web")await p.screenshot({path:path.join(output,"web-review.png"),scale:"css"});
  await press(p,/确认所选并生成选材策略/);await p.getByRole("heading",{name:"整份简历，先这样选材"}).waitFor();
  const dialog=p.getByRole("dialog");assert.match(await dialog.innerText(),/业余做了事件回放器/);assert.match(await dialog.innerText(),/往年独立作品集/);assert.doesNotMatch(await dialog.innerText(),new RegExp(blank));
  if(sound){assert.ok((await dialog.innerText()).includes("我只设计了重试流程，没有上线。"));assert.doesNotMatch(await dialog.innerText(),/这条转写不要保存/);}
  await p.screenshot({path:path.join(output,platform+"-strategy.png"),scale:"css"});
  if(platform==="web"){
    await p.setViewportSize({width:390,height:844});
    await theme(p,"dark");await p.screenshot({path:path.join(output,"mobile-dark.png"),scale:"css"});
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1 && el.getBoundingClientRect().right<=innerWidth &&
      Number(getComputedStyle(el).backgroundColor.match(/\d+/)?.[0])<100));
    await p.setViewportSize({width:1360,height:880});await theme(p,"light");
  }
  const writesBeforeRefine=paths.filter(x=>x.startsWith("POST /api/v1/agent/tasks")||x.startsWith("POST /api/v1/agent/inventory")).length;
  const material=dialog.locator(".iv-row").filter({has:p.getByText("示例团队 · 接口开发",{exact:true})});
  await material.getByText("选择要精修的原句",{exact:true}).click();
  assert.equal(await dialog.getByRole("button",{name:/精修原句/}).count(),2);
  const chosen=material.getByRole("button",{name:/精修原句.*记录重试接口的调用顺序/});
  if(platform==="web"){
    // Simulate another window archiving this receipt between rendering the list and clicking.
    await p.route("**/api/v1/agent/inventory/sessions/*",r=>r.fulfill({json:{ownerId:id,view:null}}),{times:1});
    await chosen.click();await dialog.getByRole("alert").filter({hasText:"策略或原句已变化"}).waitFor();
    const refreshed=p.waitForResponse(r=>r.url().includes("/inventory/sessions/")&&r.request().method()==="GET");
    await dialog.getByRole("button",{name:"重新读取"}).click();await refreshed;
    if(!await chosen.isVisible())await material.getByText("选择要精修的原句",{exact:true}).click();
  }
  await chosen.click();
  const note=p.getByRole("complementary",{name:"Agent 伴写批注"});await note.waitFor();
  const original=note.getByRole("group",{name:"本次精修原句"});
  await original.getByText("记录重试接口的调用顺序",{exact:true}).waitFor({state:"visible"});
  await original.getByText("本版策略：重点展开",{exact:true}).waitFor({state:"visible"});
  assert.equal(await note.getByText("我只设计了重试流程，没有做生产上线。",{exact:true}).count(),1);
  assert.doesNotMatch(await note.innerText(),/业余做了事件回放器|长期驻场|这条私密回答/);
  const answer=note.locator("textarea");assert.equal(await answer.inputValue(),"");
  await note.screenshot({path:path.join(output,platform+"-refine-source.png"),scale:"css"});
  await note.getByRole("button",{name:"引用到本轮补充，稍后核对"}).click();
  assert.equal(await answer.inputValue(),"我只设计了重试流程，没有做生产上线。");
  assert.equal(paths.filter(x=>x.startsWith("POST /api/v1/agent/tasks")||x.startsWith("POST /api/v1/agent/inventory")).length,writesBeforeRefine);
  assert.equal(totals.model,models);
  await press(p,"更多简历操作");
  let file:string|null=null;
  if(platform==="desktop"){assert.ok(nativeDownload);await press(p,"下载 JSON 备份");for(let n=0;n<120;n++){
    if(await fs.stat(nativeDownload).then(s=>s.size>0,()=>false)){file=nativeDownload;break;}await new Promise(r=>setTimeout(r,100));}
  } else {const downloaded=p.waitForEvent("download",{timeout:10000});await press(p,"下载 JSON 备份");file=await(await downloaded).path();}
  assert.ok(file,"the export click must deliver a JSON file in the isolated download directory");
  const backup=JSON.parse(await fs.readFile(file,"utf8"));assert.doesNotMatch(JSON.stringify(backup),/长期驻场|业余做了事件回放器|这条私密回答/);
  assert.equal(projectedResumeToMarkdown(projectResume(backup.factBase,backup.resumeViews[0])),baseMd);
  const profile=await(await p.context().request.get(origin+"/api/v1/agent/inventory/profile",{headers:{Authorization:"Bearer "+token,"X-BetterMe-Owner":id}})).json();
  assert.ok(profile.profile.entries.some((e:{quote:string})=>e.quote===redline));
  await p.getByRole("button",{name:"岗位",exact:true}).focus();await press(p,"岗位");await press(p,"导入 JD");
  const field=p.getByLabel("用于匹配的岗位正文");await field.fill("此岗位要求长期驻场。");await p.getByText("用我的私有偏好核对岗位",{exact:true}).click();
  await p.getByText("与本人偏好可能冲突",{exact:true}).waitFor();
  await field.fill("此岗位无须长期驻场。");await p.getByText("原句需核对",{exact:true}).waitFor();
  await field.fill("负责接口开发。");await p.getByText("岗位未明确 · 建议面试时问",{exact:true}).waitFor();
  assert.ok(!err,err);
}
let browser, app;
try{
  if(!onlyNative){
  browser=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--disable-background-networking","--disable-sync",...(sound?["--use-fake-device-for-media-stream","--use-fake-ui-for-media-stream","--use-file-for-fake-audio-capture="+sound.output]:[])]});
  const ctx=await browser.newContext({viewport:{width:1360,height:880},acceptDownloads:true});
  await ctx.route("**/*",r=>{const url=new URL(r.request().url());if(url.origin===origin||["blob:","data:","about:"].includes(url.protocol))return r.continue();totals.blockedBrowserRequests++;return r.abort();});
  await runFlow(await ctx.newPage(),"web");
  const direct=await browser.newContext();await direct.route("**/*",r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  await setup(await direct.newPage(),"synthetic-inventory-bypass");await direct.close();await browser.close();browser=undefined;}
  if(!onlyWeb){
  const profile=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"betterme-inventory-native-")));
  const qaRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"betterme-desktop-qa-")));
  nativeProfile=profile;nativeDownload=path.join(profile,"downloads","verified-backup.json");
  const executablePath=createRequire(path.join(root,"apps/desktop/package.json"))("electron") as string;
  app=await _electron.launch({executablePath,timeout:35000,args:[...(sound?["--use-fake-device-for-media-stream","--use-file-for-fake-audio-capture="+sound.output]:[]),path.join(root,"apps/desktop/tests/inventory-entry.cjs"),"--origin="+origin,"--profile="+profile,"--user-data-dir="+path.join(profile,"userData"),...(installed?["--installed"]:[]),...(sound?["--fake-inventory-audio="+sound.output]:[])],cwd:root,
    env:{PATH:process.env.PATH!,TMPDIR:os.tmpdir(),LANG:"en_US.UTF-8",NODE_ENV:"test",BETTERME_DESKTOP_QA_MODE:"external-reuse-only",
      BETTERME_DESKTOP_QA_WEB_URL:origin,BETTERME_DESKTOP_QA_HOST_URL:"http://127.0.0.1:"+backendPort,BETTERME_DESKTOP_QA_TOKEN:token,BETTERME_DESKTOP_QA_PROFILE_ROOT:qaRoot}});
  const native=app,window=await native.firstWindow({timeout:30000});
  // BrowserWindow exists before the actual main's initial loadURL resolves.
  // Navigating away during that load correctly triggers its fail-closed branch.
  await window.waitForURL(url=>url.origin===origin&&url.searchParams.get("workspace")==="autopilot",{waitUntil:"load",timeout:30000});
  await runFlow(window,"desktop",async()=>{
    await window.bringToFront();
    await native.evaluate(async({app,BrowserWindow})=>{
      const win=BrowserWindow.getAllWindows()[0];if(!win)throw Error("No isolated QA window.");
      win.show();app.focus({steal:true});win.focus();
      for(let n=0;n<50&&!win.isFocused();n++)await new Promise(r=>setTimeout(r,80));
      if(!win.isFocused())throw Error("Isolated native window is not focused; microphone remains disabled.");
    });await window.waitForFunction(()=>document.hasFocus());
  });}
  assert.equal(totals.model,onlyNative?0:1);
  console.log(JSON.stringify({passed:[...(!onlyNative?["web flow + refresh","bypass without inventory write","390px dark","stale strategy refused"]:[]),...(!onlyWeb?["native Electron flow + refresh"]:[]),"excluded answer","exact second claim, explicit quote, no new task or model call","unchanged exported resume","three JD reminders",...(sound?["local WASM: keyboard + pointer", "click selects the exact negation or value; editing removes old markers", "release tracks, discard, append corrected text only", ...(!onlyNative?["web: denied and late grants"]:[]), ...(!onlyWeb?["native: real permission gate + synthetic PCM"]:[])]:[])],...totals,spoken,output}));
}catch(e){console.error("Synthetic QA failure:",String(e),"captures:",output);if(nativeProfile)console.error(await fs.readFile(path.join(nativeProfile,"qa-main-error.txt"),"utf8").catch(()=>""));
  for(const p of [...(app?.windows()??[]),...(browser?.contexts().flatMap(c=>c.pages())??[])]){await p.screenshot({path:path.join(output,"failure.png"),timeout:3000}).catch(()=>{});console.error((await p.locator("body").innerText({timeout:3000}).catch(()=>"")).slice(-1200));}throw e;}
finally{await app?.close();await browser?.close();await Promise.all([host,ui].map(s=>new Promise<void>(resolve=>{s.close(()=>resolve());s.closeIdleConnections();})));}
