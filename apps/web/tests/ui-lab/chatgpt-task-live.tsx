import {createRoot} from "react-dom/client";
import {useEffect,useState} from "react";
import type {ProjectedResume} from "@better-me/core";
import {AgentWorkspace} from "../../src/components/AgentWorkspace";
import {AgentCompanion} from "../../src/components/AgentCompanion";
import {ResumeWritingCopilot} from "../../src/components/ResumeWritingCopilot";
import {ProjectUnderstandingPanel} from "../../src/components/ProjectUnderstandingPanel";
import {JdMatchDrawer} from "../../src/components/JdMatchDrawer";
import {JdMatchModal} from "../../src/components/JdMatchModal";
import {CareerCoachWorkspace} from "../../src/components/CareerCoachWorkspace";
import {AgentTaskLedger} from "../../src/components/AgentTaskLedger";
import {UiPreferencesProvider} from "../../src/lib/ui-preferences";
import {BetterMeAgentProvider,useBetterMeAgent} from "../../src/lib/betterme-agent/react";
import {activatePrincipal} from "../../src/lib/identity";
import {readRuntimeConnection} from "../../src/lib/runtime-connection";
import {useAgentTaskRuntime} from "../../src/lib/agent-task-runtime";
import {defaultFreeChatTaskClient} from "../../src/services/free-chat-task-client";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/betterme-agent-center.css";

async function start(){
  const headers={Authorization:`Bearer ${readRuntimeConnection()!.agentToken}`,"Content-Type":"application/json"};
  const session=await(await fetch("/api/v1/agent/identity/session",{headers})).json();
  const identity=session.principal?session:await(await fetch("/api/v1/agent/identity/register",{method:"POST",headers,body:JSON.stringify({username:"synthetic-account-browser",displayName:"隔离合成账号",password:"synthetic-only-browser-2026"})})).json();
  if(!identity.principal)throw Error("Synthetic login failed");activatePrincipal(identity.principal);
  const qa=await(await fetch("/__account-qa/state")).json(),choice={profileId:qa.profileId,model:"fixture-gpt",ready:true};
  const config={provider:"ollama" as const,model:"never-call-configured-model",baseUrl:"http://127.0.0.1:1/v1",apiKey:""};
  const text="负责接口开发，参与设备联调。",source={targetRef:{kind:"claim_text" as const,experienceId:"synthetic-account-exp",claimId:"synthetic-account-claim",locale:"zh" as const},text,label:"合成经历 · 要点 1"};
  const resume:ProjectedResume={locale:"zh",templateId:"zh-classic",profile:{displayName:"合成验收",links:[],targetRoles:[],traits:[]},experiences:[{id:"synthetic-account-exp",type:"work",org:"合成案例设备研发部",title:"软件工程师",start:"2025-01",end:null,techStack:["C#"],claims:[{id:"synthetic-account-claim",kind:"action",text,tags:[]}]}]};
  const job={title:"合成接口测试工程师",company:"合成企业",description:"岗位要求\n熟悉 C# 与 .NET 接口测试。"};
  function Selection(){
    const {agent,snapshot}=useBetterMeAgent();
    const runtime=useAgentTaskRuntime(config);
    useEffect(()=>{if(snapshot?.ready&&agent){agent.setSelection({kind:"chatgpt",profileId:choice.profileId,model:choice.model});agent.setChatGptReady(true);}},[agent,snapshot?.ready]);
    return snapshot?.ready?<output aria-label="合成账号选择" data-ready={snapshot.chatGptReady} data-runtime-ready={!runtime.error}>{snapshot.data.selection.kind} · {snapshot.data.selection.model}</output>:null;
  }
  function Workspace(){
    const [pane,setPane]=useState(new URLSearchParams(location.search).get("pane")??"companion");
    const [interviewDrawerOpen,setInterviewDrawerOpen]=useState(location.hash!=="#advisor");
    const openInterviewWorkspace=()=>{setInterviewDrawerOpen(false);history.replaceState(null,"",location.pathname+location.search+"#advisor");};
    return <UiPreferencesProvider><BetterMeAgentProvider workspaceKey="account-browser-scope"><main style={{height:"100dvh",display:"flex",flexDirection:"column",background:"var(--ui-canvas)",color:"var(--ui-text)"}}>
      <header style={{padding:12}}>隔离合成账号 · 真实 tasks / OAuth Adapter · 0 外部模型 <Selection/></header>
      <nav aria-label="账号任务验收入口" style={{display:"flex",flexWrap:"wrap",gap:12,padding:12}}>{["companion","advisor","writing","project","interview","report","coach","intake","outputs","legacy"].map(name=><button key={name} type="button" onClick={()=>setPane(name)}>{name}</button>)}</nav>
      {pane==="legacy"&&<Legacy/>}
      {pane==="outputs"&&<section style={{padding:16,overflow:"auto",width:"100%",maxWidth:760,marginInline:"auto"}} aria-label="共享根账与完整原始输出"><AgentTaskLedger rootScopeKey="account-browser-scope"/></section>}
      {pane==="intake"&&<AgentWorkspace workspaceKey="account-browser-scope" job={null} llmConfig={config} resume={resume} onOpenConfig={()=>{}} onNavigateToResume={()=>{}} onApplyToResume={()=>{throw Error("adoption forbidden");}}/>}
      {pane==="companion"&&<AgentCompanion workspaceKey="account-browser-scope" llmConfig={config} resume={resume} onOpenWorkspace={()=>{}} onOpenAiConfig={()=>{}}/>}
      {pane==="advisor"&&<AgentWorkspace workspaceKey="account-browser-scope" llmConfig={config} resume={resume} job={job} onOpenConfig={()=>{}} onNavigateToResume={()=>{}} onApplyToResume={()=>{throw Error("adoption forbidden");}}/>}
      {pane==="writing"&&<ResumeWritingCopilot sessionKey="account-browser-scope" sources={[source]} config={config} active onFocus={()=>{}} onApply={async()=>{throw Error("adoption forbidden");}}><section><p>{text}</p></section></ResumeWritingCopilot>}
      {pane==="project"&&<ProjectUnderstandingPanel workspaceKey="account-browser-scope" projectKey="account-project-field" label="合成项目" sourceText={text} config={config} chatGpt={choice} onClose={()=>setPane("writing")} onConfirmed={()=>{}}/>}
      {pane==="interview"&&<><AgentWorkspace workspaceKey="account-browser-scope" resume={resume} llmConfig={config} job={job} onActivate={openInterviewWorkspace} onOpenConfig={()=>{}} onNavigateToResume={()=>{}} onApplyToResume={()=>{throw Error("adoption forbidden");}}/>{interviewDrawerOpen&&<JdMatchDrawer isOpen onClose={openInterviewWorkspace} workspaceKey="account-browser-scope" resume={resume} llmConfig={config} job={job} onOpenConfig={()=>{}} onApplyToResume={()=>{throw Error("adoption forbidden");}}/>}</>}
      {pane==="report"&&<JdMatchModal isOpen workspaceKey="account-browser-scope" resume={resume} llmConfig={config} initialText={job.description} onClose={()=>setPane("advisor")} onOpenConfig={()=>{}} onOpenNetworkSettings={()=>{}}/>}
      {pane==="coach"&&<CareerCoachWorkspace workspaceKey="account-browser-scope" job={job} llmConfig={config} onOpenConfig={()=>{}} resumeEditContext={{locale:"zh",profile:{skills:[],headline:{targetRef:{kind:"profile_headline",locale:"zh"},text}},experiences:[]}}/>}
    </main></BetterMeAgentProvider></UiPreferencesProvider>;
  }
  function Legacy(){
    const selected=useAgentTaskRuntime(config),[busy,setBusy]=useState(false),[version,setVersion]=useState(0),[message,setMessage]=useState("");
    async function create(scoped:boolean){setBusy(true);try{selected.assertSelected();const id=crypto.randomUUID();await defaultFreeChatTaskClient.send({workspaceKey:`synthetic-${scoped?"scoped":"legacy"}-${id}`,rootScopeKey:scoped?"account-browser-scope":undefined,runtime:selected.runtime,preferredRuntimeId:selected.preferredRuntimeId,messages:[{id,role:"user",content:"  合成旧账原文😀\r\n只有本人明确点击才调用夹具模型，不代表真实简历。\r\nEND  "}]});setVersion(value=>value+1);setMessage(scoped?"同根新调用完成":"隔离旧任务已创建");}catch(error){setMessage(String(error));}finally{setBusy(false);}}
    return <section aria-label="合成旧账关联验收" style={{padding:16,overflow:"auto",width:"100%",maxWidth:760,marginInline:"auto"}}>
      <button type="button" disabled={busy||!!selected.error} onClick={()=>void create(false)}>创建隔离旧任务（合成模型）</button><button type="button" disabled={busy||!!selected.error} onClick={()=>void create(true)}>明确发送同根新任务（合成模型）</button><p role="status">{message}</p>
      <AgentTaskLedger key={version} rootScopeKey="account-browser-scope"/>
    </section>;
  }
  createRoot(document.getElementById("root")!).render(<Workspace/>);
}
void start().catch(error=>{document.getElementById("root")!.textContent=String(error);});
