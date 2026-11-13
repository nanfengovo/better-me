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

const origin="http://127.0.0.1:5299",token="synthetic_project_understanding_only_"+"q".repeat(43);
const root=fileURLToPath(new URL("../../",import.meta.url));
function isolatedProject():Plugin{
  return {name:"isolated-project-task-real-http",transformIndexHtml(html){return html.replace("<head>",`<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})}</script>`);},
    async configureServer(vite){
      const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-project-task-browser-"));let modelCalls=0,adapterBuilds=0;
      const paths:string[]=[],host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
        careerTaskReasoner:async()=>{adapterBuilds++;return async(prompt,signal,phase)=>{signal.throwIfAborted();if(phase!=="project_understanding")throw Error("unexpected QA phase");modelCalls++;const part=prompt.split("\n\n").find(item=>item.startsWith('{"project":'));if(!part)throw Error("Missing project context");const data=JSON.parse(part),users=data.context.messages.filter((m:{role:string})=>m.role==="user"),latest=users.at(-1),ready=users.length>1;
          return {text:JSON.stringify({kind:"reply",message:ready?"已按你的纠正整理，等待你核对完整项目理解。":"先核对回执的业务含义，不推断个人贡献。",understanding:{summary:ready?"合成项目协调设备任务回执；业务完成指设备动作完成。":"合成项目协调设备任务回执，完成语义待确认。",terms:[{term:"回执",meaning:ready?"设备动作完成的返回信息":"业务含义仍待本人说明",evidenceIds:[latest.id]}],boundaries:["项目实现不证明个人贡献或生产使用"],claims:[{id:"project-scope",kind:"user",text:ready?"本人说明：完成指设备动作完成。":"本人描述项目涉及回执接口。",evidenceIds:[latest.id]}],unknowns:["上线阶段及本人负责范围尚未确认"]},readyForConfirmation:ready,...(!ready?{question:{id:"completion",text:"这里的回执表示哪一步完成？",why:"先对齐完成语义，再谈本人经历。",options:[{id:"accept",label:"设备接受任务"},{id:"done",label:"设备动作完成"}],allowMultiple:false}}:{})}),finishReason:"stop"};};}});
      await once(host,"listening");const address=host.address();if(!address||typeof address==="string")throw Error("QA host failed");
      vite.httpServer?.once("close",()=>host.close());
      vite.middlewares.use((request,response,next)=>{
        response.setHeader("Content-Security-Policy","connect-src 'self'; object-src 'none'; base-uri 'self'");
        const pathname=new URL(request.url??"/",origin).pathname;
        if(pathname==="/__project-task-qa/state"){response.setHeader("Content-Type","application/json");response.end(JSON.stringify({modelCalls,adapterBuilds,paths,directory}));return;}
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
export default defineConfig({root,plugins:[react(),tailwindcss(),isolatedProject()],resolve:{dedupe:["react","react-dom"]},optimizeDeps:{entries:["tests/ui-lab/project-task-live.html"]},server:{host:"127.0.0.1",port:5299,strictPort:true,hmr:false,fs:{allow:[fileURLToPath(new URL("../../../../",import.meta.url))]}}});
