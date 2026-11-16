import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { MemorySaver } from "../../../agent-host/tests/fixtures/checkpointer";
import { createAgentServer } from "../../../agent-host/src/server";

const origin="http://127.0.0.1:5341",token="synthetic_text_only_"+"x".repeat(43);
const root=fileURLToPath(new URL("../../",import.meta.url));
const isolated:Plugin={name:"isolated-resume-text-http",async configureServer(vite){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),"betterme-text-browser-"));
  let calls=0,restarts=0;const paths:string[]=[];
  const provider=http.createServer(async(req,res)=>{
    let bytes="";for await(const chunk of req)bytes+=chunk;
    const body=JSON.parse(bytes),state=JSON.parse(body.messages.at(-1).content.split("\n\n").at(-1));calls++;
    const field=state.resume.fields[0],own=state.evidence.find((e:{sourceId:string})=>e.sourceId===`resume:${field.id}`);
    const output=state.writingPhase==="plan"?{kind:"material_plan",selections:state.resume.fields.map((f:{id:string},i:number)=>({fieldId:f.id,include:i===0,reason:i===0?"缓存测试直接对应岗位要求。":"暂不改写旧资料；原稿保留，不冒充测试成果。",evidenceIds:[state.evidence.find((e:{sourceId:string})=>e.sourceId===`resume:${f.id}`).id]})),questions:[{id:"actual-work",fieldId:field.id,question:"你本人在缓存测试中补了什么？指标没有记录可写未知。",evidenceIds:[own.id]}]}:
      {kind:"draft",patches:[{fieldId:field.id,targetRef:field.targetRef,originalText:field.originalText,proposedText:"维护缓存测试并补充异常分支。",evidenceIds:[own.id,...state.evidence.filter((e:{sourceId:string})=>e.sourceId.startsWith("answer:")).map((e:{id:string})=>e.id)],rationale:"只采用本人已确认的异常分支补充，不新增数字或上线归属。"}],unknowns:["耗时和上线指标未知。"]};
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:"synthetic-text",object:"chat.completion",model:body.model,choices:[{index:0,finish_reason:"stop",message:{role:"assistant",content:JSON.stringify(output)}}]}));
  });provider.listen(0,"127.0.0.1");await once(provider,"listening");const providerAddress=provider.address();if(!providerAddress||typeof providerAddress==="string")throw Error("fixture provider missing");
  const config={provider:"custom",baseUrl:`http://127.0.0.1:${providerAddress.port}/v1`,model:"synthetic-http-text",apiKey:"synthetic-text-fixture-not-a-real-key"};
  const open=()=>createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never});
  let host=open();await once(host,"listening");let address=host.address();if(!address||typeof address==="string")throw Error("fixture host missing");
  const close=()=>new Promise<void>(resolve=>{host.close(()=>resolve());host.closeIdleConnections();});
  vite.httpServer?.once("close",()=>{void close().finally(()=>provider.close());});
  vite.middlewares.use((req,res,next)=>{
    res.setHeader("Content-Security-Policy","default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'");
    const route=new URL(req.url??"/",origin).pathname;
    if(route==="/__text-qa/config"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify(config));return;}
    if(route==="/__text-qa/state"){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({directory,calls,restarts,paths,externalModelCalls:0}));return;}
    if(route==="/__text-qa/restart"&&req.method==="POST"){
      void close().then(async()=>{host=open();await once(host,"listening");address=host.address();restarts++;res.setHeader("Content-Type","application/json");res.end(JSON.stringify({restarts}));});return;
    }
    if(!route.startsWith("/api/"))return next();
    if(!route.startsWith("/api/v1/agent/identity/")&&!route.startsWith("/api/v1/agent/tasks")){res.statusCode=404;res.end();return;}
    paths.push(`${req.method} ${route}`);
    const proxy=http.request({hostname:"127.0.0.1",port:(address as import("node:net").AddressInfo).port,path:req.url,method:req.method,headers:{...req.headers,host:`127.0.0.1:${(address as import("node:net").AddressInfo).port}`}},upstream=>{res.writeHead(upstream.statusCode??502,upstream.headers);upstream.pipe(res);});proxy.on("error",()=>{res.statusCode=502;res.end();});req.pipe(proxy);
  });
  console.log(JSON.stringify({isolatedTextOrigin:origin,directory,externalModelCalls:0}));
},transformIndexHtml(html){return html.replace("<head>",`<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})}</script>`);}};
export default defineConfig({root,plugins:[react(),tailwindcss(),isolated],resolve:{dedupe:["react","react-dom"]},optimizeDeps:{entries:["tests/ui-lab/resume-text.html"]},cacheDir:fileURLToPath(new URL("../../../../output/resume-text-lab-cache",import.meta.url)),server:{host:"127.0.0.1",port:5341,strictPort:true,hmr:false,fs:{allow:[fileURLToPath(new URL("../../../../",import.meta.url))]}}});
