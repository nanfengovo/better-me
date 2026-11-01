import { useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialDocument } from "@better-me/storage";
import { projectResume } from "@better-me/core";
import { FactEditor } from "../../src/components/FactEditor";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import { ResumePreview } from "../../src/components/ResumePreview";
import { ResumeWritingCopilot } from "../../src/components/ResumeWritingCopilot";
import { ResizableWorkspace } from "../../src/components/ResizableWorkspace";
import { applyResumeProposal, createResumeAgentContext } from "../../src/lib/resume-agent-context";
import { writingSources, writingTargetKey, type generateWritingReply } from "../../src/lib/resume-copilot";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import { UnderstandingClientError, type UnderstandingClient } from "../../src/services/understanding-client";
import { UnderstandingSessionSchema, type ChatGptState } from "@better-me/agent-contracts";
import type { ChatGptClient } from "../../src/services/chatgpt-client";
import type { PreviewFollowTarget } from "../../src/lib/preview-follow";
import { fixtureSession, fixtureUnderstanding } from "../fixtures/project-understanding";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/components/opportunities.css";
import "../../src/components/resume-paper.css";
import "../../src/components/preview-toolbar.css";
import "../../src/themes/workspace-theme.css";

const initial = createInitialDocument();
initial.factBase.profile.displayName = { zh: "布局回归 · 虚构用户" };
initial.factBase.profile.email = "layout@example.invalid";
initial.factBase.profile.phone = "";
initial.factBase.profile.headline = { zh: "参与接口开发，负责系统维护" };
initial.factBase.experiences = Array.from({ length: 3 }, (_, index) => ({
  ...initial.factBase.experiences[0]!, id: `layout-exp-${index}`, org: { zh: `虚构物流团队 ${index + 1}` },
  claims: Array.from({ length: 10 }, (_, claim) => ({ id: `layout-claim-${index}-${claim}`, kind: "action" as const,
    text: { zh: `参与项目接口开发，负责回执维护。隔离测试要点 ${index + 1}-${claim + 1}，仅用于验证长内容滚动。` }, tags: [] })),
}));
initial.resumeViews[0]!.includedExperienceIds = initial.factBase.experiences.map(item => item.id);
initial.resumeViews[0]!.experienceSelection = "all";
const fresh = () => { sessionStorage.setItem("isolated-layout-session", JSON.stringify(session)); return structuredClone(session); };
const saved = UnderstandingSessionSchema.safeParse(JSON.parse(sessionStorage.getItem("isolated-layout-session") || "null"));
let session = saved.success ? saved.data : fixtureSession();
const client: UnderstandingClient = {
  getCapabilities: async () => [], getSession: async id => { if (id !== session.id) throw new UnderstandingClientError("隔离内存会话已重建，输入仍保留。", 404); return fresh(); },
  createSession: async input => { session = fixtureSession({ ...input, id: "isolated-layout-dialogue" }); return fresh(); },
  startTurn: async (_id, input) => {
    const count = session.turnCount + 1, at = new Date().toISOString();
    session = { ...session, revision: session.revision + 1, turnCount: count, phase: "awaiting-answer", updatedAt: at, understanding: fixtureUnderstanding,
      question: { id: `layout-question-${count}`, text: "在这个虚构项目中，任务协调与车辆调度如何区分？", why: "先核对术语边界，不推断个人贡献。", allowMultiple: false,
        options: [{ id: "handoff", label: "只提交搬运任务，车辆路线由其他系统负责" }, { id: "other", label: "都不符合，我自己补充" }] },
      messages: [...session.messages, ...Array.from({ length: 12 }, (_, index) => ({ id: `layout-history-${count}-${index}`, at, role: index % 2 ? "agent" as const : "user" as const,
        text: index === 0 ? input.answer || "先澄清这个项目的职责边界。" : `隔离对话历史 ${count}-${index + 1}：核对订单、任务和回执的含义；这不是个人贡献证明。` }))],
      events: [...session.events, { sequence: session.events.length + 1, kind: "waiting", at, label: "隔离响应已完成，等待用户纠正" }],
    }; return fresh();
  },
  updateSource: async (_id, input) => { session = { ...session, sourceText: input.sourceText }; return fresh(); },
  addGrant: async () => { throw new Error("布局夹具不读取本机文件"); }, revokeGrant: async () => fresh(),
  confirm: async () => fresh(), cancel: async () => fresh(),
};
const emptyAccountState: ChatGptState = { profiles: [], usageUrl: "https://chatgpt.com/settings/usage", automaticBillingFallback: false };
const chatGptClient: ChatGptClient = {
  state: async () => emptyAccountState, models: async () => [], retry: async () => emptyAccountState,
  cancelSignIn: async () => emptyAccountState, signOut: async () => ({ remoteRevoked: true, state: emptyAccountState }),
  signIn: async () => { throw new Error("布局夹具不进行真实授权"); },
  respond: async () => { throw new Error("布局夹具不调用真实模型"); },
};

function Lab() {
  const [doc, setDoc] = useState(initial), [follow, setFollow] = useState<PreviewFollowTarget | null>(null);
  const [focus, setFocus] = useState<React.ComponentProps<typeof FactEditor>["writingFocus"]>();
  const response = useRef<((reply: Awaited<ReturnType<typeof generateWritingReply>>) => void) | undefined>(undefined);
  const view = doc.resumeViews[0]!;
  const sources = useMemo(() => writingSources(createResumeAgentContext(doc.factBase, view)), [doc, view]);
  return <div className="studio-app">
    <aside className="studio-rail" aria-label="隔离测试导航"><span className="studio-monogram">bm.</span><span>内容</span></aside>
    <div className="studio-workspace">
      <header className="studio-header"><div className="studio-brand"><strong>BetterMe</strong><span>滚动布局 · 隔离回归</span></div><span>仅虚构数据 · 无真实服务连接</span></header>
      <div className="resume-workspace-body">
        <div className="studio-document-bar"><strong>虚构简历 · 仅内存</strong><button className="studio-button" onClick={() => response.current?.({ questions: ["虚构回执链路里，你具体编写了哪一段校验？", "结果如何验证？"], rationale: "这只是隔离 UI 响应，不是模型效果验收。", evidenceQuotes: [] })}>完成隔离测试响应</button></div>
        <div className="studio-notices"><div className="persistence-notice">模拟长页面通知：隔离文档，不会读取或保存真实简历、岗位、凭据。</div><details><summary>导入原文与待补录 · 隔离占位</summary><p>只用于复现顶部空间占用。</p></details></div>
        <ResizableWorkspace>
          <div className="studio-editor-pane" id="resume-editor-panel"><FactEditor factBase={doc.factBase} onChange={factBase => setDoc(d => ({ ...d, factBase }))} onPreviewTargetChange={setFollow} writingFocus={focus} /></div>
          <div className="studio-preview-pane" id="resume-preview-panel">
            <ResumeWritingCopilot sessionKey="isolated-resume-layout-v1" sources={sources} config={{ provider: "ollama", baseUrl: "http://unused.invalid", model: "fixture-only", apiKey: "", temperature: 0 }} active understandingClient={client} chatGptClient={chatGptClient}
              generate={() => new Promise(resolve => { response.current = resolve; })}
              onApply={async proposal => { const result = applyResumeProposal(doc, proposal); if (!result.ok) return { ok: false, message: "隔离原文已变化，拒绝覆盖。" }; setDoc(result.document); return { ok: true, message: "只更新隔离页内存文档。" }; }}
              onFocus={source => setFocus({ key: writingTargetKey(source.targetRef), locale: source.targetRef.locale, experienceId: source.targetRef.kind === "claim_text" ? source.targetRef.experienceId : undefined, requestId: Date.now() })}>
              <ResumePreview resume={projectResume(doc.factBase, view)} view={view} followTarget={follow} onViewChange={next => setDoc(d => ({ ...d, resumeViews: [next] }))} />
            </ResumeWritingCopilot>
          </div>
        </ResizableWorkspace>
      </div>
      <footer className="studio-footer">独立 5198 origin · 本页不挂载正常应用的数据与服务</footer>
    </div>
  </div>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><ConfirmationProvider><Lab /></ConfirmationProvider></UiPreferencesProvider>);
