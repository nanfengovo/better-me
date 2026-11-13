import http from "node:http";
import {once} from "node:events";
import {mkdtemp} from "node:fs/promises";
import {createHash} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {defineConfig,type Plugin} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {MemorySaver} from "../../../agent-host/tests/fixtures/checkpointer";
import {createAgentServer} from "../../../agent-host/src/server";
const origin="http://127.0.0.1:5301",token="synthetic_ocr_tasks_"+"q".repeat(43),root=fileURLToPath(new URL("../../",import.meta.url));
const text="  \r\n合成岗位：工业软件 C# / .NET 工程师。\r\n"+"职责原文：实现输入校验与接口回归；截图文字不证明任何个人任职或贡献。\r\n".repeat(100)+"OCR-END  \r\n";
function isolatedOcr():Plugin{
  return {name:"isolated-ocr-real-http",transformIndexHtml(html){return html.replace("<head>",`<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})}</script>`);},async configureServer(vite){
    const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-ocr-browser-"));let modelCalls=0,adapterBuilds=0,ocrCalls=0,legacyPosts=0;
    const paths:string[]=[],images:{name:string;dataUrlLength:number;hash:string}[][]=[];
    const host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
      careerTaskReasoner:async()=>{adapterBuilds++;return async(_prompt,signal,phase,originals)=>{
        signal.throwIfAborted();modelCalls++;if(phase==="free_chat")return JSON.stringify({kind:"reply",content:"合成聊天根 · OCR-CHAT-END"});
        if(phase!=="jd_ocr")throw Error("unexpected synthetic phase");ocrCalls++;images.push((originals??[]).map(image=>({name:image.name,dataUrlLength:image.dataUrl.length,hash:createHash("sha256").update(image.dataUrl).digest("hex")})));
        return {text:JSON.stringify({kind:"ocr",text}),finishReason:ocrCalls===1?"length":"stop"};
      };}});
    await once(host,"listening");const address=host.address();if(!address||typeof address==="string")throw Error("QA Host failed");vite.httpServer?.once("close",()=>host.close());
    vite.middlewares.use((request,response,next)=>{
      response.setHeader("Content-Security-Policy","connect-src 'self'; object-src 'none'; base-uri 'self'");const pathname=new URL(request.url??"/",origin).pathname;
      if(pathname.startsWith("/__synthetic-model/")){response.setHeader("Content-Type","application/json");if(request.method!=="GET"){legacyPosts++;response.statusCode=410;response.end(JSON.stringify({error:"inference_requires_tasks"}));}else response.end(JSON.stringify({data:[{id:"synthetic-vision"}],models:[{name:"synthetic-vision"}]}));return;}
      if(pathname==="/__ocr-qa/state"){response.setHeader("Content-Type","application/json");response.end(JSON.stringify({modelCalls,adapterBuilds,ocrCalls,legacyPosts,paths,images,directory,text}));return;}
      if(!pathname.startsWith("/api/"))return next();paths.push(`${request.method} ${pathname}`);
      const forward=pathname.startsWith("/api/v1/agent/tasks")||pathname.startsWith("/api/v1/agent/identity/")||pathname==="/api/v1/agent/records/continuity"||pathname==="/api/v1/agent/routing"&&request.method==="GET";
      if(!forward){response.setHeader("Content-Type","application/json");if(request.method==="POST"){legacyPosts++;response.statusCode=410;response.end(JSON.stringify({error:"outside_task_fixture"}));}else response.end(JSON.stringify({status:"ok",runtimes:[],profiles:[],proposals:[],errors:[],backend:"agent-host"}));return;}
      const proxy=http.request({hostname:"127.0.0.1",port:address.port,path:request.url,method:request.method,headers:{...request.headers,host:`127.0.0.1:${address.port}`}},upstream=>{response.writeHead(upstream.statusCode??502,upstream.headers);upstream.pipe(response);});proxy.on("error",()=>{response.statusCode=502;response.end();});request.pipe(proxy);
    });
  }};
}
export default defineConfig({root,plugins:[react(),tailwindcss(),isolatedOcr()],resolve:{dedupe:["react","react-dom"]},optimizeDeps:{entries:["tests/ui-lab/jd-ocr-live.html"]},server:{host:"127.0.0.1",port:5301,strictPort:true,hmr:false,fs:{allow:[fileURLToPath(new URL("../../../../",import.meta.url))]}}});
