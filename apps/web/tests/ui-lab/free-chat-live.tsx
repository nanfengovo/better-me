import {createRoot} from "react-dom/client";
import {projectResume} from "@better-me/core";
import {createInitialDocument} from "@better-me/storage";
import {AgentWorkspace} from "../../src/components/AgentWorkspace";
import {AgentCompanion} from "../../src/components/AgentCompanion";
import {AgentTaskLedger} from "../../src/components/AgentTaskLedger";
import {JdMatchDrawer} from "../../src/components/JdMatchDrawer";
import {JdMatchModal} from "../../src/components/JdMatchModal";
import {AiConfigModal} from "../../src/components/AiConfigModal";
import {defaultFreeChatTaskClient} from "../../src/services/free-chat-task-client";
import {understandingModelRuntime} from "../../src/services/understanding-client";
import type {ProjectedResume} from "@better-me/core";
import {useState} from "react";
import {UiPreferencesProvider} from "../../src/lib/ui-preferences";
import {BetterMeAgentProvider} from "../../src/lib/betterme-agent/react";
import {activatePrincipal} from "../../src/lib/identity";
import {readRuntimeConnection} from "../../src/lib/runtime-connection";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/betterme-agent-center.css";

async function start(){
  const headers={Authorization:`Bearer ${readRuntimeConnection()!.agentToken}`,"Content-Type":"application/json"};
  const current=await (await fetch("/api/v1/agent/identity/session",{headers})).json();
  const account=current.principal?current:await (await fetch("/api/v1/agent/identity/register",{method:"POST",headers,body:JSON.stringify({username:"synthetic-browser-chat",displayName:"隔离合成验收",password:"synthetic-only-browser-2026"})})).json();
  if(!account.principal)throw Error("Synthetic login failed");activatePrincipal(account.principal);
  const document=createInitialDocument();document.factBase.profile.displayName={zh:"合成验收",en:"Synthetic"};document.factBase.profile.email="";document.factBase.profile.phone="";
  const resume=projectResume(document.factBase,document.resumeViews[0]!),llmConfig={provider:"ollama" as const,model:"synthetic-no-model",baseUrl:"http://127.0.0.1:1/v1",apiKey:"",temperature:0.3};
  const pane=new URLSearchParams(location.search).get("pane"),companion=pane==="companion";
  const job={title:"合成测试工程师",company:"合成企业",description:"岗位要求\n了解 C# 与 .NET 接口测试。\n能核对测试环境行为。"};
  const reportResume:ProjectedResume={locale:"zh",templateId:"zh-classic",profile:{displayName:"合成验收",links:[],targetRoles:[],traits:[]},experiences:[{id:"synthetic-report-exp",type:"work",org:"合成案例设备研发部",title:"软件工程师",start:"2025-01",end:null,techStack:["C#"],claims:[{id:"synthetic-report-claim",kind:"action",text:"为设备告警接口编写输入校验，并补充自动化回归测试。",tags:[]}]}]};
  function SyntheticWorkspace(){
  const [applied,setApplied]=useState(0);
  const [configOpen,setConfigOpen]=useState(false),[probeRoot,setProbeRoot]=useState("");
  const [interviewDrawerOpen,setInterviewDrawerOpen]=useState(location.hash!=="#advisor");
  const openInterviewWorkspace=()=>{setInterviewDrawerOpen(false);history.replaceState(null,"",location.pathname+location.search+"#advisor");};
  return <UiPreferencesProvider initialPreferences={{theme:new URLSearchParams(location.search).get("theme")==="dark"?"dark":"light"}}><BetterMeAgentProvider workspaceKey="browser-chat"><div style={{height:"100dvh",display:"flex",flexDirection:"column",background:"var(--ui-canvas)"}}>
    <header style={{padding:12,borderBottom:"1px solid var(--ui-border)",fontSize:12}}>隔离合成验收 · 真实 HTTP / AgentTaskKernel · 脚本化回答，0 外部模型调用</header>
    <nav aria-label="合成验收入口" style={{display:"flex",gap:16,padding:12}}><a href="?pane=advisor">顾问入口</a><a href="?pane=companion">伴侣入口</a><a href="?pane=drawer">抽屉入口</a><a href="?pane=interview">真实对练子会话</a><a href="?pane=report">完整报告</a><a href="?pane=ledger">共享根账</a><output aria-label="合成采用次数">{applied}</output></nav>
    {pane==="interview"&&<><AgentWorkspace workspaceKey="browser-chat" resume={reportResume} llmConfig={llmConfig} job={job} onActivate={openInterviewWorkspace} onOpenConfig={()=>{}} onNavigateToResume={()=>{}} onApplyToResume={()=>{}}/>{interviewDrawerOpen&&<JdMatchDrawer isOpen onClose={openInterviewWorkspace} workspaceKey="browser-chat" resume={reportResume} llmConfig={llmConfig} job={job} onOpenConfig={()=>{}} onApplyToResume={()=>{}}/>}</>}
    {pane==="report"&&<JdMatchModal isOpen workspaceKey="browser-chat" resume={reportResume} llmConfig={llmConfig} initialText={job.description} onClose={()=>{}} onOpenConfig={()=>{}} onOpenNetworkSettings={()=>{}}/>}
    {pane==="config-probe"&&<section style={{padding:24}}><button onClick={()=>void defaultFreeChatTaskClient.send({workspaceKey:"advisor:probe-browser",rootScopeKey:"browser-chat",runtime:understandingModelRuntime(llmConfig),messages:[{id:"probe-browser-prior",role:"user",content:"PRIVATE-PRIOR-CHAT：先前合成对话，不应进入配置测试。"}]}).then(reply=>{setProbeRoot(reply.meta!.taskId!);setConfigOpen(true);})}>创建合成根对话并打开配置</button><button onClick={()=>setConfigOpen(true)}>打开模型配置</button><output aria-label="配置测试原根">{probeRoot}</output><AiConfigModal isOpen={configOpen} onClose={()=>setConfigOpen(false)} rootScopeKey="browser-chat" config={llmConfig} onSave={()=>{}}/></section>}
    {pane!=="interview"&&pane!=="config-probe"&&(pane==="ledger"?<section className="betterme-agent-center" style={{position:"static",width:"min(620px,100%)",margin:"16px auto",padding:16}}><h1>跨入口共享根账验收</h1><AgentTaskLedger rootScopeKey="browser-chat"/></section>:companion?<AgentCompanion workspaceKey="browser-chat" resume={resume} llmConfig={llmConfig} onOpenWorkspace={()=>{}} onOpenAiConfig={()=>{}} initialReference={{type:"resume_text",sourceLabel:"合成原文",text:"只参与测试，不负责上线。"}}/>:pane==="drawer"?<JdMatchDrawer isOpen onClose={()=>{}} workspaceKey="browser-chat" resume={resume} llmConfig={llmConfig} job={job} onOpenConfig={()=>{}} onApplyToResume={()=>setApplied(x=>x+1)}/>:<AgentWorkspace workspaceKey="browser-chat" resume={resume} llmConfig={llmConfig} job={job} onOpenConfig={()=>{}} onNavigateToResume={()=>{}} onApplyToResume={()=>setApplied(x=>x+1)}/>) }
  </div></BetterMeAgentProvider></UiPreferencesProvider>;
  }
  createRoot(window.document.getElementById("root")!).render(<SyntheticWorkspace/>);
}
void start().catch(error=>{document.getElementById("root")!.textContent=String(error);});
