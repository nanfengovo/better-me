import {createRoot} from "react-dom/client";
import {ResumeWritingCopilot} from "../../src/components/ResumeWritingCopilot";
import {BetterMeAgentProvider} from "../../src/lib/betterme-agent/react";
import {UiPreferencesProvider} from "../../src/lib/ui-preferences";
import {activatePrincipal} from "../../src/lib/identity";
import {readRuntimeConnection} from "../../src/lib/runtime-connection";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

async function start(){
  const headers={Authorization:`Bearer ${readRuntimeConnection()!.agentToken}`,"Content-Type":"application/json"};
  const current=await (await fetch("/api/v1/agent/identity/session",{headers})).json();
  const account=current.principal?current:await (await fetch("/api/v1/agent/identity/register",{method:"POST",headers,body:JSON.stringify({username:"synthetic-browser-refine",displayName:"隔离伴写验收",password:"synthetic-only-browser-2026"})})).json();
  if(!account.principal)throw Error("Synthetic login failed");activatePrincipal(account.principal);
  const source={targetRef:{kind:"claim_text" as const,experienceId:"synthetic-exp",claimId:"synthetic-claim",locale:"zh" as const},text:"负责接口开发，参与设备联调。",label:"合成经历 · 要点 1"};
  createRoot(document.getElementById("root")!).render(<UiPreferencesProvider><BetterMeAgentProvider workspaceKey="browser-refine"><main style={{padding:24,minHeight:"100dvh",background:"var(--ui-canvas)",color:"var(--ui-text)"}}>
    <h1>隔离经历润色 · 真实 HTTP / AgentTaskKernel</h1><p>仅合成字段与脚本回答，0 外部模型请求；未注入 generate，不允许改写业务资料。</p>
    <ResumeWritingCopilot sessionKey="browser-refine" sources={[source]} config={{provider:"ollama",model:"synthetic-no-model",baseUrl:"http://127.0.0.1:1/v1",apiKey:""}} active onApply={async()=>{throw Error("adoption forbidden in this fixture");}} onFocus={()=>{}}>
      <section><h2>合成原文</h2><p>{source.text}</p></section>
    </ResumeWritingCopilot>
  </main></BetterMeAgentProvider></UiPreferencesProvider>);
}
void start().catch(error=>{document.getElementById("root")!.textContent=String(error);});
