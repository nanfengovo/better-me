import {useState} from "react";
import {createRoot} from "react-dom/client";
import {ProjectUnderstandingPanel} from "../../src/components/ProjectUnderstandingPanel";
import {BetterMeAgentProvider} from "../../src/lib/betterme-agent/react";
import {UiPreferencesProvider} from "../../src/lib/ui-preferences";
import {activatePrincipal} from "../../src/lib/identity";
import {readRuntimeConnection} from "../../src/lib/runtime-connection";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";
function Lab(){
  const [confirmed,setConfirmed]=useState(false);
  return <main style={{height:"100dvh",padding:16,display:"flex",flexDirection:"column",background:"var(--ui-canvas)",color:"var(--ui-text)",overflow:"hidden"}}>
    <header style={{flexShrink:0}}><h1>项目理解 · 真实 HTTP / AgentTaskKernel</h1><p>仅合成项目与脚本回答，0 外部模型请求；不注入客户端，不修改简历。</p>{confirmed&&<p role="status">已确认项目摘要 · 不代表个人贡献或上线采用</p>}</header>
    <div style={{flex:1,minHeight:0,overflow:"hidden"}}><ProjectUnderstandingPanel workspaceKey="browser-project-kernel" projectKey="synthetic-claim" label="合成设备协调项目" sourceText="参与任务回执接口，先理解项目边界。" config={{provider:"ollama",model:"synthetic-no-model",baseUrl:"http://127.0.0.1:1/v1",apiKey:""}} onClose={()=>{}} onConfirmed={context=>setConfirmed(Boolean(context))}/></div>
  </main>;
}
async function start(){
  const headers={Authorization:`Bearer ${readRuntimeConnection()!.agentToken}`,"Content-Type":"application/json"};
  const current=await(await fetch("/api/v1/agent/identity/session",{headers})).json();
  const account=current.principal?current:await(await fetch("/api/v1/agent/identity/register",{method:"POST",headers,body:JSON.stringify({username:"synthetic-browser-project",displayName:"隔离项目任务验收",password:"synthetic-only-browser-2026"})})).json();
  if(!account.principal)throw Error("Synthetic login failed");activatePrincipal(account.principal);
  createRoot(document.getElementById("root")!).render(<UiPreferencesProvider><BetterMeAgentProvider workspaceKey="browser-project-kernel"><Lab/></BetterMeAgentProvider></UiPreferencesProvider>);
}
void start().catch(error=>{document.getElementById("root")!.textContent=String(error);});
