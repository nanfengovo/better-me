/** Opt-in GUI protocol test. Built/installed renderer, disposable identities, no provider network or real secrets. */
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {once} from "node:events";
import {fileURLToPath} from "node:url";
import {createRequire} from "node:module";
import {_electron,chromium,type Page} from "playwright-core";
import {MemorySaver} from "@langchain/langgraph";
import {PDF_CLOUD_BACKEND,PDF_CLOUD_ORIGIN,pdfCloudModel} from "@better-me/agent-contracts";
import {createAgentServer} from "../src/server.js";

const root=fileURLToPath(new URL("../../../",import.meta.url)),installed=process.argv.includes("--installed"),
  dist=path.resolve(root,installed?"../BetterMe.app/Contents/Resources/app/dist":"apps/web/dist");
const temp=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"betterme-pdf-cloud-ui-")));
const key="SYNTHETIC_ONLY_PDF_CLOUD_KEY",token="synthetic_pdf_cloud_"+"t".repeat(45),state={calls:0,posts:0},receipts:unknown[]=[];
let origin="",backendPort=0,dropNextCreateResponse=false;
const ui=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url??"/",origin);
    if(u.pathname.startsWith("/api/")){
      if(!/^\/api\/v1\/agent\/(?:identity|growth\/learning|tasks|records|routing|chatgpt|understanding)(?:\/|$)/.test(u.pathname)){res.writeHead(404).end();return;}
      const creating=req.method==="POST"&&u.pathname.endsWith("/learning/translations");
      if(creating)state.posts++;
      const drop=creating && dropNextCreateResponse;
      if(drop)dropNextCreateResponse=false;
      const upstream=http.request({host:"127.0.0.1",port:backendPort,path:req.url,method:req.method,headers:{...req.headers,host:"127.0.0.1:"+backendPort}},
        r=>{if(drop){r.resume();r.on("end",()=>res.writeHead(502,{"Content-Type":"application/json","Cache-Control":"no-store"}).end('{"error":"fixture_receipt_lost"}'));return;}
          res.writeHead(r.statusCode??502,r.headers);r.pipe(res);});upstream.on("error",()=>res.end());req.pipe(upstream);return;
    }
    const f=path.resolve(dist,"."+decodeURIComponent(u.pathname==="/"?"/index.html":u.pathname));assert.ok(f.startsWith(dist+path.sep));
    const data=await fs.readFile(f),ext=path.extname(f);
    const types:Record<string,string>={".html":"text/html;charset=utf-8",".js":"application/javascript",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".woff2":"font/woff2"};
    res.setHeader("Content-Type",types[ext]??"application/octet-stream");
    res.end(ext===".html"?data.toString().replace("<head>","<head><script>window.__BETTER_ME_RUNTIME__="+JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})+"</script>"):data);
  }catch{res.writeHead(404).end();}
});
ui.listen(0,"127.0.0.1");await once(ui,"listening");const addr=ui.address();assert.ok(addr&&typeof addr==="object");origin="http://127.0.0.1:"+addr.port;
const host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],identityDirectory:path.join(temp,"accounts"),
  runsDirectory:path.join(temp,"runs"),understandingDirectory:path.join(temp,"understanding"),checkpointer:new MemorySaver() as never,
  learningTranslationEngine:{abortSettles:true,backend:async channel=>channel==="cloud"?{id:PDF_CLOUD_BACKEND,engine:"Synthetic consent fixture",location:channel,recipientOrigin:PDF_CLOUD_ORIGIN,
    ready:true,simulation:true,models:[pdfCloudModel("deepseek-v4-pro")]}:{id:"local-fixture",engine:"Synthetic local fixture",location:"local",ready:true,simulation:true,models:[]},
    run:async input=>{assert.equal(input.cloudKey,key);await input.modelCall("fixture paragraph only",async()=>{state.calls++;return "fixture";});
      return {mono:input.source,...(input.request.bilingual?{dual:input.source}:{})};}}});
await once(host,"listening");const addr2=host.address();assert.ok(addr2&&typeof addr2==="object");backendPort=addr2.port;
const auth={Authorization:"Bearer "+token,Origin:origin};
async function flow(page:Page,label:string){
  page.setDefaultTimeout(15000);await page.goto(origin);
  const registered=await page.context().request.post(origin+"/api/v1/agent/identity/register",{headers:auth,
    data:{username:"synthetic-pdf-cloud-"+label,password:"synthetic-only-pdf-pass",displayName:"合成翻译验收"}});
  assert.equal(registered.status(),200);const id=(await registered.json()).principal.id;
  const headers={...auth,"X-BetterMe-Owner":id};
  const bytes=await fs.readFile(path.join(root,"apps/agent-host/tests/fixtures/learning/checkpoint-notes-v1.pdf"));
  const imp=await page.context().request.post(origin+"/api/v1/agent/growth/learning/materials",{headers,data:{
    requestId:"qa-original",consent:true,name:"合成技术讲义.pdf",mediaType:"application/pdf",base64:bytes.toString("base64")}});
  assert.equal(imp.status(),201);
  await page.evaluate(({id,key,label})=>{const prefix="betterme.owner.v1:"+id+":";
    if(label==="desktop")localStorage.setItem(prefix+"better-me:llm-config",JSON.stringify({provider:"openai-compatible",baseUrl:"https://api.deepseek.com",model:"deepseek-flash",apiKey:key}));
    for(const k of [prefix+"betterme:onboarding:v1","betterme:onboarding:v1"])localStorage.setItem(k,'{"version":1,"state":"skipped"}');
  },{id,key,label});
  const open=async()=>{
    await page.goto(origin+"/?workspace=agent");await page.getByRole("button",{name:"成长闭环",exact:true}).click();
    await page.getByRole("button",{name:/合成技术讲义\.pdf/}).click();
    const panel=page.getByText("PDF 中译英 · 独立试点",{exact:true});
    if(!await page.locator(".translation-setup").isVisible())await panel.click();
  };
  await page.reload();await open();
  const channel=page.getByRole("combobox",{name:/翻译通道/});assert.equal(await channel.inputValue(),"local");
  const initial={...state};await channel.selectOption("cloud");await page.getByRole("combobox",{name:/本次云端模型/}).selectOption("deepseek-v4-pro");
  if(label==="web")await page.getByLabel("仅本作业的 DeepSeek API 密钥",{exact:true}).fill(key);
  const share=page.getByRole("checkbox",{name:/允许将上述文本和术语/}),confirm=page.getByRole("checkbox",{name:/启动这一次云端作业/});
  const start=page.getByRole("button",{name:"开始本次中译英",exact:true});
  assert.equal(await start.isEnabled(),false);assert.deepEqual(state,initial);
    await share.check();await confirm.check();await page.getByLabel(/本作业术语表/).fill("断点 = checkpoint");
  assert.equal(await share.isChecked(),false);assert.equal(await start.isEnabled(),false);
  await page.getByLabel("本作业最多请求数").fill("2");await share.check();await confirm.check();
  await page.locator(".translation-setup").screenshot({path:path.join(temp,label+"-grant.png")});
  await start.click();const results=page.getByRole("region",{name:"译稿作业详情"});await results.getByText("译稿待审阅",{exact:true}).waitFor();
  assert.equal(state.calls,initial.calls+1);assert.equal(state.posts,initial.posts+1);
  const jobs=await (await page.context().request.get(origin+"/api/v1/agent/growth/learning/translations",{headers})).json();
  const job=jobs.jobs[0];assert.equal(job.request.cloudGrant.maxCalls,2);assert.equal(job.request.model.name,"deepseek-v4-pro");
  assert.ok(!JSON.stringify(job).includes(key));assert.equal(job.backend.simulation,true);
  assert.ok(await page.evaluate(key=>Object.entries(localStorage).filter(([k])=>k.includes("recovery")).every(([,v])=>!String(v).includes(key)),key));
  if(label==="web")assert.ok(await page.evaluate(key=>Object.values(localStorage).every(v=>!String(v).includes(key)),key));
  await page.reload();await open();assert.equal(await channel.inputValue(),"local");
  await results.getByText("译稿待审阅",{exact:true}).waitFor();await channel.selectOption("cloud");
  if(label==="web")assert.equal(await page.getByLabel("仅本作业的 DeepSeek API 密钥",{exact:true}).inputValue(),"");
  assert.equal(await share.isChecked(),false);assert.equal(await confirm.isChecked(),false);assert.equal(await start.isEnabled(),false);
  assert.equal(state.calls,initial.calls+1);assert.equal(state.posts,initial.posts+1);
  receipts.push({platform:label,id:job.id,model:job.request.model.name,maxCalls:2,calls:job.usage.modelCalls,simulation:true});
  if(label==="web"){
    // The Host has persisted the job, but the renderer never receives the POST response.
    dropNextCreateResponse=true;
    await page.getByLabel("仅本作业的 DeepSeek API 密钥",{exact:true}).fill(key);
    await page.getByRole("combobox",{name:/本次云端模型/}).selectOption("deepseek-v4-pro");await share.check();await confirm.check();
    await start.click();await page.getByText("上次动作尚待核对",{exact:true}).waitFor();
    await page.getByRole("button",{name:"只读核对上次翻译动作"}).waitFor();
    await page.waitForFunction(()=>Array.from(document.querySelectorAll("button")).some(b=>b.textContent?.includes("只读核对上次翻译动作")&&!b.disabled));
    const pending=await page.evaluate(()=>Object.entries(localStorage).filter(([k])=>k.endsWith(":learning-translation:v1"))
      .map(([,v])=>JSON.parse(v).value.pending).find(Boolean));
    assert.deepEqual(Object.keys(pending).sort(),["id","kind"]);assert.equal(pending.kind,"cloud-create");
    await page.reload();await open();
    await page.getByRole("button",{name:"只读核对上次翻译动作"}).click();
    await page.getByText("上次动作尚待核对",{exact:true}).waitFor({state:"hidden"});
    assert.equal(state.calls,initial.calls+2);assert.equal(state.posts,initial.posts+2);
    receipts.push({platform:label,lostReceipt:true,extraPostsAfterReload:0,journalOnly:["id","kind"]});
  }
}
let browser,app;
try{
  browser=await chromium.launch({executablePath:"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true,args:["--disable-background-networking","--disable-sync"]});
  const ctx=await browser.newContext({viewport:{width:1340,height:900}});await ctx.route("**/*",r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  await flow(await ctx.newPage(),"web");await browser.close();browser=undefined;
  const profile=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"betterme-inventory-native-"))),qaRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),"betterme-desktop-qa-")));
  app=await _electron.launch({executablePath:createRequire(path.join(root,"apps/desktop/package.json"))("electron") as string,
    args:[path.join(root,"apps/desktop/tests/inventory-entry.cjs"),"--origin="+origin,"--profile="+profile,"--user-data-dir="+path.join(profile,"userData"),...(installed?["--installed"]:[])],cwd:root,
    env:{PATH:process.env.PATH!,TMPDIR:os.tmpdir(),NODE_ENV:"test",BETTERME_DESKTOP_QA_MODE:"external-reuse-only",BETTERME_DESKTOP_QA_WEB_URL:origin,
      BETTERME_DESKTOP_QA_HOST_URL:"http://127.0.0.1:"+backendPort,BETTERME_DESKTOP_QA_TOKEN:token,BETTERME_DESKTOP_QA_PROFILE_ROOT:qaRoot}});
  const native=await app.firstWindow();await native.waitForURL(url=>url.origin===origin&&url.searchParams.get("workspace")==="autopilot");
  await flow(native,"desktop");console.log(JSON.stringify({installed,receipts,externalRequests:0,output:temp}));
}catch(e){for(const page of [...(app?.windows()??[]),...(browser?.contexts().flatMap(c=>c.pages())??[])])console.error((await page.locator("body").innerText().catch(()=>"")).slice(-2500));throw e;}
finally{await app?.close();await browser?.close();for(const server of [host,ui])await new Promise<void>(r=>{server.close(()=>r());server.closeIdleConnections();});}
