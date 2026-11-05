import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createInitialDocument } from "@better-me/storage";
import { projectResume } from "@better-me/core";
import { FactEditor } from "../../src/components/FactEditor";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import { ResumePreview } from "../../src/components/ResumePreview";
import { ResumeWritingCopilot } from "../../src/components/ResumeWritingCopilot";
import { ResizableWorkspace } from "../../src/components/ResizableWorkspace";
import { AgentSidebarProvider } from "../../src/components/AgentSidebar";
import { AgentCompanion } from "../../src/components/AgentCompanion";
import { AgentTopBarStatus } from "../../src/components/AgentTopBarStatus";
import { AgentContinuityButton, BetterMeAgentCenter } from "../../src/components/BetterMeAgentCenter";
import { FirstRunGuide } from "../../src/components/FirstRunGuide";
import { AgentSourceBridge, BetterMeAgentProvider, useBetterMeAgent } from "../../src/lib/betterme-agent/react";
import { createMemoryAgentRepository, IndexedDbAgentRepository } from "../../src/lib/betterme-agent/storage";
import { applyResumeProposal, createResumeAgentContext } from "../../src/lib/resume-agent-context";
import { writingSources, writingTargetKey, type generateWritingReply } from "../../src/lib/resume-copilot";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import { UnderstandingClientError, type UnderstandingClient } from "../../src/services/understanding-client";
import { UnderstandingSessionSchema, type ChatGptState } from "@better-me/agent-contracts";
import type { ChatGptClient } from "../../src/services/chatgpt-client";
import type { PreviewFollowTarget } from "../../src/lib/preview-follow";
import { fixtureSession, fixtureUnderstanding } from "../fixtures/project-understanding";
import { syntheticPersistence } from "../fixtures/synthetic-persistence";
import { DocumentSaveStatus } from "../../src/components/DocumentSaveStatus";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/components/opportunities.css";
import "../../src/components/resume-paper.css";
import "../../src/components/preview-toolbar.css";
import "../../src/themes/workspace-theme.css";

const unified = new URLSearchParams(location.search).has("unified");
const storageTest = new URLSearchParams(location.search).has("storage");
if (storageTest && (location.hostname !== "127.0.0.1" || location.port !== "5231")) throw new Error("存储故障夹具仅允许隔离5231源");
let lastConnection: IDBDatabase | undefined, failStorage = false;
const factory = new Proxy(indexedDB, { get(target, key) {
  if (key === "open") return (...args: Parameters<IDBFactory["open"]>) => {
    const request = target.open(...args);
    request.addEventListener("success", () => {
      const db = request.result; lastConnection = db;
      const transaction = db.transaction.bind(db);
      db.transaction = (...params: Parameters<IDBDatabase["transaction"]>) => {
        if (failStorage) throw new DOMException("Injected isolated connection failure", "InvalidStateError");
        return transaction(...params);
      };
    });
    return request;
  };
  const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
} });
const repository = storageTest ? new IndexedDbAgentRepository(factory) : createMemoryAgentRepository();
const isolatedConfig = { provider: "ollama" as const, baseUrl: `${location.origin}/fixture-model/v1`, model: "fixture-only", apiKey: "", temperature: 0 };
if (unified) {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname.endsWith("/runtimes")) return Response.json({ runtimes: [] });
    if (url.pathname.endsWith("/health")) return Response.json({ status: "ok" });
    if (url.origin === location.origin && url.pathname.startsWith("/fixture-model/")) return Response.json({ data: [{ id: "fixture-only" }] });
    if (url.origin !== location.origin || /\/api\//.test(url.pathname)) throw new Error("隔离布局验证禁止访问真实服务。");
    return originalFetch(input, init);
  };
}

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
  getCapabilities: async () => [{ id: "fixture-reader", name: "隔离只读测试 Agent", available: true, supported: true }, { id: "fixture-unsupported", name: "未适配测试工具", available: true, supported: false, reason: "测试不兼容边界" }], getSession: async id => { if (id !== session.id) throw new UnderstandingClientError("隔离内存会话已重建，输入仍保留。", 404); return fresh(); },
  createSession: async input => { session = fixtureSession({ ...input, id: "isolated-layout-dialogue" }); return fresh(); },
  startTurn: async (_id, input) => {
    const count = session.turnCount + 1, at = new Date().toISOString();
    session = { ...session, revision: session.revision + 1, turnCount: count, phase: count >= 2 ? "awaiting-confirmation" : "awaiting-answer", updatedAt: at, summaryHash: `fixture-hash-${count}`, understanding: { ...fixtureUnderstanding, contributionLeads: [{ id: "receipt", title: "任务回执校验", category: "responsibility", hypothesis: "该项目有回执校验，但个人贡献尚未确认", evidenceIds: [`layout-history-${count}-0`], question: "你本人实现了哪段校验？", options: ["本人实现边界校验与测试", "不是我实现的，需要进一步核对"] }] },
      question: { id: `layout-question-${count}`, text: "在这个虚构项目中，任务协调与车辆调度如何区分？", why: "先核对术语边界，不推断个人贡献。", allowMultiple: false,
        options: [{ id: "handoff", label: "只提交搬运任务，车辆路线由其他系统负责" }, { id: "other", label: "都不符合，我自己补充" }] },
      messages: [...session.messages, ...Array.from({ length: 12 }, (_, index) => ({ id: `layout-history-${count}-${index}`, at, role: index % 2 ? "agent" as const : "user" as const,
        text: index === 0 ? input.answer || "先澄清这个项目的职责边界。" : `隔离对话历史 ${count}-${index + 1}：核对订单、任务和回执的含义；这不是个人贡献证明。` }))],
      events: [...session.events, ...Array.from({ length: 6 }, (_, index) => ({ sequence: session.events.length + index + 1, kind: "reading" as const, at, label: "列出授权源码已完成。" })), { sequence: session.events.length + 7, kind: "waiting", at, label: "隔离响应已完成，等待用户纠正" }],
    }; return fresh();
  },
  updateSource: async (_id, input) => { session = { ...session, sourceText: input.sourceText }; return fresh(); },
  addGrant: async () => { throw new Error("布局夹具不读取本机文件"); }, revokeGrant: async () => fresh(),
  confirm: async (_id, input) => { session = { ...session, phase: "confirmed", confirmation: { revision: input.expectedRevision, summaryHash: input.summaryHash, confirmedAt: new Date().toISOString() } }; return fresh(); }, cancel: async () => fresh(),
};
const emptyAccountState: ChatGptState = { profiles: [], usageUrl: "https://chatgpt.com/settings/usage", automaticBillingFallback: false };
const chatGptClient: ChatGptClient = {
  state: async () => emptyAccountState, models: async () => [], retry: async () => emptyAccountState,
  cancelSignIn: async () => emptyAccountState, signOut: async () => ({ remoteRevoked: true, state: emptyAccountState }),
  signIn: async () => { throw new Error("布局夹具不进行真实授权"); },
  respond: async () => { throw new Error("布局夹具不调用真实模型"); },
};

function Lab() {
  const [persistence] = useState(() => syntheticPersistence(initial));
  const { controller } = persistence;
  const savedState = useSyncExternalStore(notify => controller.subscribe(notify), () => controller.getState());
  useEffect(() => { void controller.load(); return () => controller.dispose(); }, [controller]);
  const doc = savedState.doc ?? initial;
  const setDoc = (update: React.SetStateAction<typeof initial>) => controller.update(typeof update === "function" ? update(controller.getState().doc ?? initial) : update);
  const [follow, setFollow] = useState<PreviewFollowTarget | null>(null);
  const [page, setPage] = useState("resume");
  const { theme, setTheme } = useUiPreferences();
  const { agent, snapshot } = useBetterMeAgent();
  const [focus, setFocus] = useState<React.ComponentProps<typeof FactEditor>["writingFocus"]>();
  const response = useRef<((reply: Awaited<ReturnType<typeof generateWritingReply>>) => void) | undefined>(undefined);
  const companionResponse = useRef<(() => void) | undefined>(undefined);
  const view = doc.resumeViews[0]!;
  const sources = useMemo(() => writingSources(createResumeAgentContext(doc.factBase, view)), [doc, view]);
  const bindings = useMemo(() => sources.map(source => ({ key: writingTargetKey(source.targetRef), text: source.text })), [sources]);
  return <div className="studio-app">
    {unified && <AgentSourceBridge sources={bindings} />}
    <aside className="studio-rail" aria-label="隔离测试导航"><span className="studio-monogram">bm.</span><button onClick={() => setPage("resume")}>简历</button><button onClick={() => setPage("other")}>切页</button><button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>明暗</button></aside>
    <div className="studio-workspace">
      <header className="studio-header"><div className="studio-brand"><strong>BetterMe</strong><span>布局 · 隔离回归</span></div>{unified && <><FirstRunGuide eligible={false} onPrepare={() => setPage("resume")} /><AgentContinuityButton /><AgentTopBarStatus config={null} active={false} onNavigateToAgent={() => setPage("other")} onOpenAiConfig={() => {}} /></>}</header>
      <div className="studio-document-bar"><strong>虚构简历 · 仅内存</strong><DocumentSaveStatus status={savedState.status} autoSaveEnabled={false} /><button className="studio-button" onClick={() => void controller.flush(true)}>保存合成简历</button><button className="studio-button" onClick={() => response.current?.({ questions: ["虚构回执链路里，你具体编写了哪一段校验？", "结果如何验证？"], rationale: "这只是隔离 UI 响应，不是模型效果验收。", evidenceQuotes: [] })}>完成隔离测试响应</button>{unified && <button className="studio-button" onClick={() => companionResponse.current?.()}>完成伴侣测试响应</button>}</div>
      {storageTest && <div className="persistence-notice"><button onClick={() => { lastConnection?.close(); agent?.setGoal("关闭连接后安全重连"); }}>关闭隔离连接并保存</button><button disabled={Boolean(snapshot?.error)} onClick={() => { failStorage = true; agent?.record({ id: crypto.randomUUID(), role: "user", origin: "companion", text: "故障期间的隔离记录，需要保留。" }); }}>模拟持续连接故障</button><button onClick={() => { failStorage = false; }}>解除隔离故障</button><span>本页内存：{snapshot?.data.messages.length ?? 0} 条 · {snapshot?.data.goal}</span></div>}
      <div className="resume-workspace-body" hidden={page !== "resume"}>
        <div className="studio-notices"><div className="persistence-notice">模拟长页面通知：隔离文档，不会读取或保存真实简历、岗位、凭据。</div><details><summary>导入原文与待补录 · 隔离占位</summary><p>只用于复现顶部空间占用。</p></details></div>
        <ResizableWorkspace>
          <div className="studio-editor-pane" id="resume-editor-panel" data-onboarding="editor"><FactEditor factBase={doc.factBase} onChange={factBase => setDoc(d => ({ ...d, factBase }))} onPreviewTargetChange={setFollow} writingFocus={focus} /></div>
          <div className="studio-preview-pane" id="resume-preview-panel">
            <ResumeWritingCopilot sessionKey="isolated-resume-layout-v1" sources={sources} config={isolatedConfig} active={page === "resume"} understandingClient={client} chatGptClient={chatGptClient}
              generate={() => new Promise(resolve => { response.current = resolve; })}
              onApply={async proposal => { const result = applyResumeProposal(doc, proposal); if (!result.ok) return { ok: false, message: "隔离原文已变化，拒绝覆盖。" }; setDoc(result.document); return { ok: true, message: "只更新隔离页内存文档。" }; }}
              onFocus={source => setFocus({ key: writingTargetKey(source.targetRef), locale: source.targetRef.locale, experienceId: source.targetRef.kind === "claim_text" ? source.targetRef.experienceId : undefined, requestId: Date.now() })}>
              <ResumePreview resume={projectResume(doc.factBase, view)} view={view} followTarget={follow} onViewChange={next => setDoc(d => ({ ...d, resumeViews: [next] }))} />
            </ResumeWritingCopilot>
          </div>
        </ResizableWorkspace>
      </div>
      {page === "other" && <section style={{ padding: 32, flex: 1 }}><h1>隔离的其他页面</h1><p>离开简历仍保留原组件。侧栏任务不会因切页停止。</p></section>}
      <footer className="studio-footer">独立测试 origin · 真实简历、岗位和自动保存设置不在此页范围<span role="status">最近任务：{snapshot?.data.tasks.at(-1)?.status ?? "无"}</span></footer>
    </div>
    {unified && <><AgentCompanion llmConfig={isolatedConfig} resume={projectResume(doc.factBase, view)} onOpenWorkspace={() => setPage("other")} onOpenAiConfig={() => {}} chatGptClient={chatGptClient}
      sendChat={async input => { await new Promise<void>((resolve, reject) => { companionResponse.current = resolve; input.signal?.addEventListener("abort", () => reject(new Error("隔离请求被停止")), { once: true }); }); return { id: crypto.randomUUID(), role: "assistant", content: "隔离回复：切换页面与面板后任务继续完成，未调用真实模型。", createdAt: new Date().toISOString() }; }} />
      <BetterMeAgentCenter onNavigate={origin => setPage(origin === "growth" ? "other" : "resume")} /></>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><ConfirmationProvider>{unified ? <BetterMeAgentProvider workspaceKey="isolated-sidebar-layout" repository={repository} understandingClient={client}><AgentSidebarProvider understandingClient={client}><Lab /></AgentSidebarProvider></BetterMeAgentProvider> : <Lab />}</ConfirmationProvider></UiPreferencesProvider>);
