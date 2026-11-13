import http from "node:http";
import {once} from "node:events";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {defineConfig,type Plugin} from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import {MemorySaver} from "../../../agent-host/tests/fixtures/checkpointer";
import {createAgentServer} from "../../../agent-host/src/server";

const origin="http://127.0.0.1:5298",token="synthetic_experience_refine_only_"+"q".repeat(43);
const root=fileURLToPath(new URL("../../",import.meta.url));
function isolatedChat():Plugin{
  return {name:"isolated-experience-refine-real-http",transformIndexHtml(html){return html.replace("<head>",`<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})}</script>`);},
    async configureServer(vite){
      const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-experience-refine-browser-"));let modelCalls=0,adapterBuilds=0;
      const paths:string[]=[],host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
        careerTaskReasoner:async()=>{adapterBuilds++;return async(prompt,signal,phase)=>{signal.throwIfAborted();if(phase!=="experience_refine")throw Error("unexpected QA phase");modelCalls++;const data=JSON.parse(prompt.split("\n\n").at(-1)!);
          const supplement=data.conversation.messages.filter((m:{role:string})=>m.role==="user").at(-1).content;
          return {text:JSON.stringify({questions:supplement?[]:["你亲手做了哪一步？可以补充对象和可观察行为，不必凑数字。"],rationale:"合成经历润色回执 · 所有候选待本人审阅。",evidenceQuotes:supplement?[supplement]:[],...(supplement?{proposedText:supplement}:{})}),finishReason:"stop"};};}});
      await once(host,"listening");const address=host.address();if(!address||typeof address==="string")throw Error("QA host failed");
      vite.httpServer?.once("close",()=>host.close());
      vite.middlewares.use((request,response,next)=>{
        response.setHeader("Content-Security-Policy","connect-src 'self'; object-src 'none'; base-uri 'self'");
        const pathname=new URL(request.url??"/",origin).pathname;
        if(pathname==="/__experience-refine-qa/state"){response.setHeader("Content-Type","application/json");response.end(JSON.stringify({modelCalls,adapterBuilds,paths,directory}));return;}
        if(!pathname.startsWith("/api/"))return next();
        paths.push(`${request.method} ${pathname}`);
        const forward=pathname.startsWith("/api/v1/agent/tasks")||pathname.startsWith("/api/v1/agent/identity/")||pathname==="/api/v1/agent/records/continuity"||pathname==="/api/v1/agent/routing"&&request.method==="GET";
        if(!forward){
          response.setHeader("Content-Type","application/json");response.end(JSON.stringify({status:"ok",runtimes:[],proposals:[],errors:[],threadId:"synthetic-only",backend:"agent-host"}));return;
        }
        const proxy=http.request({hostname:"127.0.0.1",port:address.port,path:request.url,method:request.method,headers:{...request.headers,host:`127.0.0.1:${address.port}`}},upstream=>{response.writeHead(upstream.statusCode??502,upstream.headers);upstream.pipe(response);});
        proxy.on("error",()=>{response.statusCode=502;response.end();});request.pipe(proxy);
      });
    }};
}
export default defineConfig({root,plugins:[react(),tailwindcss(),isolatedChat()],resolve:{dedupe:["react","react-dom"]},optimizeDeps:{entries:["tests/ui-lab/experience-refine-live.html"]},server:{host:"127.0.0.1",port:5298,strictPort:true,hmr:false,fs:{allow:[fileURLToPath(new URL("../../../../",import.meta.url))]}}});
