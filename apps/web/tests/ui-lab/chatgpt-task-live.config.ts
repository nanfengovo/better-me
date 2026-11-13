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
import {ChatGptPlanService} from "../../../agent-host/src/chatgpt/service";
import {chatGptProviderFixture} from "../../../agent-host/tests/fixtures/chatgpt-provider";
import {coachPayload,coachPromptRequest} from "../../../agent-host/tests/fixtures/career-coach";
import {metadataPromptRequest,metadataResult} from "../../../agent-host/tests/fixtures/jd-intake";

const origin="http://127.0.0.1:5299",token="synthetic_account_tasks_"+"q".repeat(43);
const root=fileURLToPath(new URL("../../",import.meta.url));
function isolatedAccount():Plugin{
  return {name:"isolated-account-tasks-http",transformIndexHtml(html){return html.replace("<head>",`<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({mode:"docker",origin,agentToken:token,jobToken:token})}</script>`);},
    async configureServer(vite){
      const directory=await mkdtemp(path.join(os.tmpdir(),"betterme-account-browser-")),provider=await chatGptProviderFixture();let modelCalls=0,fallbackCalls=0;
      const phases:string[]=[],paths:string[]=[];let coachPauseOnce=true,intakePauseOnce=true;
      const account=new ChatGptPlanService({directory:path.join(directory,"oauth"),fetch:async(url,init)=>{
        if(String(url).endsWith("/responses")){
          modelCalls++;const body=JSON.parse(String(init?.body)),data=body.instructions.includes("exact job metadata")?undefined:JSON.parse(body.input[0].content.split("\n\n").at(-1));
          if(body.model!=="fixture-gpt")throw Error("wrong explicit model");
          let answer:unknown;
          provider.settings.incomplete=false;
          if(body.instructions.includes("exact job metadata")){
            const request=metadataPromptRequest(body.input[0].content);phases.push("jd_intake");answer=metadataResult(request.text);
            if(request.text.includes("PAUSE-INTAKE")&&intakePauseOnce){intakePauseOnce=false;provider.settings.incomplete=true;}
          }else if(body.instructions.includes("learning coach")){
            const request=coachPromptRequest(body.input[0].content);
            phases.push("career_coach");answer=coachPayload(request);
            if(request.input.includes("COACH-PAUSE-ONCE")&&coachPauseOnce){coachPauseOnce=false;provider.settings.incomplete=true;}
          }else if(body.instructions.includes("experience editor")){
            phases.push("experience_refine");const supplement=data.conversation.messages.filter((m:{role:string})=>m.role==="user").at(-1).content;
            answer={questions:supplement?[]:["本人实际做了什么，观察到什么结果？"],rationale:"先核对本人动作，不编造。",evidenceQuotes:supplement?[supplement]:[],...(supplement?{proposedText:supplement}:{})};
          }else if(body.instructions.includes("project understanding")){
            phases.push("project_understanding");answer={kind:"reply",message:"合成账号项目理解：先核对术语。",readyForConfirmation:false,understanding:{summary:"项目只协调设备任务回执。",terms:[],boundaries:["项目范围不证明个人贡献"],claims:[],unknowns:["本人职责待确认"]},question:{id:"scope",text:"本人实际参与哪一部分？",why:"分清项目与个人。",options:[{id:"test",label:"接口测试"}],allowMultiple:false}};
          }else if(body.instructions.includes("mock interviewer")){
            phases.push("mock_interview");answer=data.phase==="interview"?{kind:"question",content:data.conversation.messages.length?"如何验证重复回执，哪些范围未核实？":"请说明接口测试中的本人动作？",evidenceIds:data.evidence.filter((e:{sourceId:string})=>e.sourceId.startsWith("claim:")).map((e:{id:string})=>e.id)}:{kind:"receipt",receipt:{summary:"合成账号面试攻防评估回执。",answers:data.conversation.messages.filter((m:{role:string})=>m.role==="user").map((m:{id:string;content:string})=>({answerId:m.id,quote:m.content,assessment:"partial",gap:"缺少未覆盖范围说明。",improvedExpression:m.content,evidenceIds:[data.evidence.find((e:{sourceId:string})=>e.sourceId==="answer:"+m.id).id]})),nextSteps:["根据实际观察补充，不编造。"]}};
          }else if(body.instructions.includes("JD")){
            phases.push("jd_match");answer={kind:"match",proposals:data.requiredItems.map((jdItem:string)=>({jdItem,evidenceType:"gap",suggestion:"请核对本人实际承担的工作。",rationale:"合成检查不推断事实。",evidenceIds:[]})),...(data.reportRequested?{report:{matchScore:0,scoreSummary:"合成账号协议报告，不代表模型能力。",matchingStrengths:[],missingGaps:data.requiredItems,tailoredSuggestions:[],interviewDefenseTips:["核对本人动作。"]}}:{})};
          }else{phases.push("free_chat");answer={kind:"reply",content:"合成账号完整回答。\n"+data.conversation.messages.filter((m:{role:string})=>m.role==="user").at(-1).content+"\nACCOUNT-REPLY-END"};}
          const oversized=body.instructions.includes("职业对话")||phases.at(-1)==="free_chat";
          provider.settings.responseText=oversized&&body.input[0].content.includes("SYNTHETIC-OVERSIZED-OUTPUT")?"\ufeff  合成原始输出😀\r\n"+"完整原文，不截取、不自动续答。\r\n".repeat(12000)+"OUTPUT-ARTIFACT-END  ":JSON.stringify(answer);
        }
        return provider.fetch(url,init);
      }});
      const login=await provider.login(account),profileId=login.state.profiles[0]!.id;
      const host=createAgentServer({host:"127.0.0.1",port:0,authToken:token,allowedOrigins:[origin],runtimeDefinitions:[],identityDirectory:path.join(directory,"identity"),runsDirectory:path.join(directory,"runs"),understandingDirectory:path.join(directory,"understanding"),checkpointer:new MemorySaver() as never,chatGptService:account,
        careerTaskReasoner:async()=>{fallbackCalls++;throw Error("configured/native fallback forbidden");}});
      await once(host,"listening");const address=host.address();if(!address||typeof address==="string")throw Error("QA host failed");
      vite.httpServer?.once("close",()=>{host.close();account.dispose();});
      vite.middlewares.use((request,response,next)=>{
        response.setHeader("Content-Security-Policy","connect-src 'self'; object-src 'none'; base-uri 'self'");
        const pathname=new URL(request.url??"/",origin).pathname;
        if(pathname==="/__account-qa/state"){response.setHeader("Content-Type","application/json");response.end(JSON.stringify({modelCalls,fallbackCalls,phases,paths,directory,profileId}));return;}
        if(!pathname.startsWith("/api/"))return next();paths.push(`${request.method} ${pathname}`);
        const allowed=pathname.startsWith("/api/v1/agent/tasks")||pathname.startsWith("/api/v1/agent/identity/")||/^\/api\/v1\/agent\/records\/(continuity|growth)$/.test(pathname)||pathname.startsWith("/api/v1/agent/chatgpt/")&&!pathname.endsWith("/response")||request.method==="GET"&&["/api/v1/agent/routing","/api/v1/agent/runtimes","/api/v1/agent/understanding/capabilities"].includes(pathname);
        if(!allowed){response.writeHead(410,{"Content-Type":"application/json"});response.end(JSON.stringify({error:"fixture_forbids_legacy_inference"}));return;}
        const proxy=http.request({hostname:"127.0.0.1",port:address.port,path:request.url,method:request.method,headers:{...request.headers,host:`127.0.0.1:${address.port}`}},upstream=>{response.writeHead(upstream.statusCode??502,upstream.headers);upstream.pipe(response);});
        proxy.on("error",()=>{response.statusCode=502;response.end();});request.pipe(proxy);
      });
    }};
}
export default defineConfig({root,plugins:[react(),tailwindcss(),isolatedAccount()],resolve:{dedupe:["react","react-dom"]},optimizeDeps:{entries:["tests/ui-lab/chatgpt-task-live.html"]},server:{host:"127.0.0.1",port:5299,strictPort:true,hmr:false,fs:{allow:[fileURLToPath(new URL("../../../../",import.meta.url))]}}});
