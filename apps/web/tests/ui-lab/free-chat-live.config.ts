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

const origin="http://127.0.0.1:5296",token="synthetic_free_chat_only_"+"q".repeat(43);
const root=fileURLToPath(new URL("../../",import.meta.url));
function isolatedChat():Plugin{
  return {name:"isolated-free-chat-real-http",transformIndexHtml(html){return html.replace("<head>",`<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})}</script>`);},
    async configureServer(vite){
      const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-free-chat-browser-"));let modelCalls=0,adapterBuilds=0;
      const paths:string[]=[],phases:string[]=[],host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,
        careerTaskReasoner:async()=>{adapterBuilds++;return async(prompt,signal,phase)=>{signal.throwIfAborted();if(phase!=="free_chat"&&phase!=="jd_match"&&phase!=="mock_interview")throw Error("unexpected QA phase");modelCalls++;phases.push(phase);const data=JSON.parse(prompt.split("\n\n").at(-1)!);
          if(phase==="mock_interview")return {text:JSON.stringify(data.phase==="interview"?{kind:"question",content:data.conversation.messages.length?"你如何验证重复请求与异常重试，哪些范围尚未核实？":"请说明这段接口测试的本人职责和验证边界？",evidenceIds:data.evidence.filter((e:{sourceId:string})=>e.sourceId.startsWith("claim:")).map((e:{id:string})=>e.id)}:{kind:"receipt",receipt:{summary:"面试攻防评估回执：只评估本次合成作答，不认定个人能力。",answers:data.conversation.messages.filter((m:{role:string})=>m.role==="user").map((m:{id:string;content:string})=>({answerId:m.id,quote:m.content,assessment:"partial",gap:"还需核对失败样本和未覆盖范围。",improvedExpression:m.content,evidenceIds:[data.evidence.find((e:{sourceId:string})=>e.sourceId==="answer:"+m.id).id]})),nextSteps:["按实际观察补充验证边界，不编造生产规模。"]}}),finishReason:"stop"};
          if(phase==="jd_match")return {text:JSON.stringify({kind:"match",proposals:data.requiredItems.map((jdItem:string)=>({jdItem,evidenceType:"gap",suggestion:"请说明你是否有对应经历，以及本人实际承担的工作？",rationale:"合成验收不推断个人事实，需本人补充。",evidenceIds:[]})),
            ...(data.reportRequested?{report:{matchScore:0,scoreSummary:"合成脚本化报告，仅验证协议与恢复，不是模型能力成绩。",matchingStrengths:[],missingGaps:data.requiredItems.map((item:string)=>`请本人核对：${item}`),tailoredSuggestions:[],interviewDefenseTips:["请说明你实际参与的接口测试及验证边界。"]}}:{})}),finishReason:"stop"};
          return {text:JSON.stringify({kind:"reply",content:`合成任务第 ${data.turn} 轮：已保留最早的纠正“${data.conversation.messages.find((m:{role:string})=>m.role==="user")?.content}”。缺少本人项目细节时先问，不编造。`}),finishReason:"stop"};};}});
      await once(host,"listening");const address=host.address();if(!address||typeof address==="string")throw Error("QA host failed");
      vite.httpServer?.once("close",()=>host.close());
      vite.middlewares.use((request,response,next)=>{
        response.setHeader("Content-Security-Policy","connect-src 'self'; object-src 'none'; base-uri 'self'");
        const pathname=new URL(request.url??"/",origin).pathname;
        if(pathname==="/__free-chat-qa/state"){response.setHeader("Content-Type","application/json");response.end(JSON.stringify({modelCalls,adapterBuilds,phases,paths,directory}));return;}
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
export default defineConfig({root,plugins:[react(),tailwindcss(),isolatedChat()],resolve:{dedupe:["react","react-dom"]},optimizeDeps:{entries:["tests/ui-lab/free-chat-live.html"]},server:{host:"127.0.0.1",port:5296,strictPort:true,hmr:false,fs:{allow:[fileURLToPath(new URL("../../../../",import.meta.url))]}}});
