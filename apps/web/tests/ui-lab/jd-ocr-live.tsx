import {useState} from "react";
import {createRoot} from "react-dom/client";
import {JdMatchModal} from "../../src/components/JdMatchModal";
import {AgentCompanion} from "../../src/components/AgentCompanion";
import {BetterMeAgentProvider} from "../../src/lib/betterme-agent/react";
import {UiPreferencesProvider} from "../../src/lib/ui-preferences";
import {activatePrincipal} from "../../src/lib/identity";
import {readRuntimeConnection} from "../../src/lib/runtime-connection";
import {useAgentTaskRuntime} from "../../src/lib/agent-task-runtime";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";
const config={provider:"ollama" as const,model:"synthetic-vision",baseUrl:"http://127.0.0.1:5301/__synthetic-model/v1",apiKey:""};
const resume={locale:"zh" as const,templateId:"zh-classic",profile:{displayName:"合成空资料",links:[],targetRoles:[],traits:[]},experiences:[]};
function Fixture(){
  const [open,setOpen]=useState(false),runtime=useAgentTaskRuntime(config);
  return <main style={{padding:24,minHeight:"100dvh",background:"var(--ui-canvas)",color:"var(--ui-text)"}}>
    <h1>隔离原图 OCR · 实际 Modal / tasks / Kernel</h1><p>仅合成图片与脚本回答；0 外部模型，不采用岗位或简历。</p>
    <div aria-label="合成底座就绪" data-ready={!runtime.error}>{runtime.label}</div>
    <button onClick={()=>setOpen(true)}>截图入口</button>
    <AgentCompanion workspaceKey="synthetic-ocr-live" llmConfig={config} onOpenAiConfig={()=>{}} onOpenWorkspace={()=>setOpen(true)} />
    <JdMatchModal workspaceKey="synthetic-ocr-live" isOpen={open} onClose={()=>setOpen(false)} resume={resume} llmConfig={config} onOpenConfig={()=>{}} onOpenNetworkSettings={()=>{}} />
  </main>;
}
async function start(){
  const headers={Authorization:`Bearer ${readRuntimeConnection()!.agentToken}`,"Content-Type":"application/json"};
  const current=await(await fetch("/api/v1/agent/identity/session",{headers})).json();
  const account=current.principal?current:await(await fetch("/api/v1/agent/identity/register",{method:"POST",headers,body:JSON.stringify({username:"synthetic-ocr-live",displayName:"隔离原图验收",password:"synthetic-only-ocr-2026"})})).json();
  if(!account.principal)throw Error("Synthetic login failed");activatePrincipal(account.principal);
  createRoot(document.getElementById("root")!).render(<UiPreferencesProvider><BetterMeAgentProvider workspaceKey="synthetic-ocr-live"><Fixture /></BetterMeAgentProvider></UiPreferencesProvider>);
}
void start().catch(error=>{document.getElementById("root")!.textContent=String(error);});
