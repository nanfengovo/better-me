import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createDefaultResumeView, careerTaskSourceFingerprint, createCareerTaskResume, type FactBase, type LlmConfig } from "@better-me/core";
import { DocumentSchema, type BetterMeDocument } from "@better-me/storage";
import { createResumeAgentContext } from "../../src/lib/resume-agent-context";
import CareerTaskPanel from "../../src/components/CareerTaskPanel";
import { resumeSaveCommand, inspectCareerTaskWorkspace } from "../../src/lib/career-task-reconciliation";
import { activatePrincipal, capturePrivateStorage } from "../../src/lib/identity";
import { readRuntimeConnection } from "../../src/lib/runtime-connection";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

const at="2026-11-14T00:00:00.000Z",l=(text:string)=>({zh:text,en:text});
const factBase:FactBase={schemaVersion:1,updatedAt:at,profile:{displayName:l("合成验收人"),headline:l("维护缓存测试。"),links:[],traits:[],targetRoles:[]},experiences:[{id:"synthetic-project",type:"other",org:l("原创合成项目"),title:l("资料整理"),start:"2025-01",end:null,techStack:[],claims:[{id:"synthetic-old",kind:"action",text:l("整理旧资料。"),tags:[]}]}]};
const view={...createDefaultResumeView(factBase,at),id:"synthetic-original",name:"合成原稿",locale:"zh" as const};
const original:BetterMeDocument=DocumentSchema.parse({documentId:"synthetic-text-workspace",factBase,activeResumeId:view.id,resumeViews:[view]});

async function start(){
  const runtime=readRuntimeConnection()!;const headers={Authorization:`Bearer ${runtime.agentToken}`,"Content-Type":"application/json"};
  const username=new URL(location.href).searchParams.get("user")==="desktop"?"synthetic-text-desktop":"synthetic-text-web";
  let account=await (await fetch("/api/v1/agent/identity/session",{headers})).json();
  if(!account.principal){const auth={username,displayName:"合成文本验收",password:"synthetic-text-acceptance-only-2026"};account=await (await fetch("/api/v1/agent/identity/register",{method:"POST",headers,body:JSON.stringify(auth)})).json();if(!account.principal)account=await (await fetch("/api/v1/agent/identity/sign-in",{method:"POST",headers,body:JSON.stringify({username,password:auth.password})})).json();}
  if(!account.principal)throw Error("Synthetic identity missing");activatePrincipal(account.principal);
  const storage=capturePrivateStorage(),docKey="synthetic-text-document";
  const doc=DocumentSchema.parse(JSON.parse(storage.getItem(docKey)??JSON.stringify(original)));
  const fingerprint=await careerTaskSourceFingerprint(doc,view.id),config:LlmConfig=await (await fetch("/__text-qa/config")).json();
  function Lab(){
    const [document,setDocument]=useState(doc),[state,setState]=useState("");
    const unchanged=JSON.stringify(document.factBase)===JSON.stringify(original.factBase)&&JSON.stringify(document.resumeViews[0])===JSON.stringify(original.resumeViews[0]);
    return <main style={{maxWidth:780,margin:"0 auto",padding:24,background:"var(--ui-canvas)",color:"var(--ui-text)"}}><h1>选材 → 追问 → 确认 → 成稿 → 导出</h1><p>独立合成账号 · 真实任务 HTTP 与 SDK · 本机脚本提供商 · 0 云端请求，不加载真实简历与求职数据库。</p>
      <p role="status">已保存独立版本：{document.resumeViews.length-1}；合成原稿与共享事实未变：{unchanged?"是":"否"}</p>
      <details><summary>隔离验收诊断</summary><button onClick={async()=>setState(JSON.stringify(await (await fetch("/__text-qa/state")).json(),null,2))}>查看调用计数</button><button onClick={async()=>{await fetch("/__text-qa/restart",{method:"POST"});setState("隔离 Host 已重启；只点击刷新状态，不启动模型。");}}>重启隔离 Host</button><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{state}</pre></details>
      <CareerTaskPanel initialTextWorkflow workspaceKey={original.documentId!} sourceResumeId={view.id} sourceResumeName={view.name} sourceFingerprint={fingerprint} resumeFields={createResumeAgentContext(original.factBase,view)} job={{title:"合成缓存测试岗位",company:"合成公司",description:"需要缓存测试和异常分支维护。"}} llmConfig={config}
        onSave={async(task,ids)=>{const saved=await createCareerTaskResume(document,resumeSaveCommand(task,ids));storage.setItem(docKey,JSON.stringify(saved.document));const reread=DocumentSchema.parse(JSON.parse(storage.getItem(docKey)!));setDocument(reread);return {versionId:saved.receipt.resumeId,receiptId:saved.receipt.id};}}
        onReconcile={(task,query)=>inspectCareerTaskWorkspace(document,task,query)}/>
    </main>;
  }
  createRoot(document.getElementById("root")!).render(<Lab/>);
}
void start().catch(()=>{document.getElementById("root")!.textContent="隔离验收初始化失败；未借用实际服务或账号。";});
