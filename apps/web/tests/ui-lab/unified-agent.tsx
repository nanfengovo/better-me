import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialDocument } from "@better-me/storage";
import { projectResume, type LlmConfig } from "@better-me/core";
import { UnderstandingSessionSchema, type ChatGptResponseRequest, type ChatGptState } from "@better-me/agent-contracts";
import { ResumeWritingCopilot } from "../../src/components/ResumeWritingCopilot";
import { AgentCompanion } from "../../src/components/AgentCompanion";
import { CareerCoachWorkspace } from "../../src/components/CareerCoachWorkspace";
import { BetterMeAgentCenter, AgentContinuityButton } from "../../src/components/BetterMeAgentCenter";
import { BetterMeAgentProvider, AgentSourceBridge, useBetterMeAgent } from "../../src/lib/betterme-agent/react";
import { createResumeAgentContext } from "../../src/lib/resume-agent-context";
import { writingSources, writingTargetKey, type WritingReply } from "../../src/lib/resume-copilot";
import type { CoachRequest, CoachGeneration } from "../../src/lib/career-coach/types";
import type { UnderstandingClient } from "../../src/services/understanding-client";
import { ChatGptClientError, type ChatGptClient } from "../../src/services/chatgpt-client";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import { fixtureSession, fixtureUnderstanding } from "../fixtures/project-understanding";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

const fixture = { calls: [] as string[], requests: [] as unknown[], delay: 4500, failNext: false, quota: false, forbiddenRequests: [] as string[] };
Object.assign(window, { unifiedAgentFixture: fixture });
// Block all real host/provider access before it reaches the network.
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin !== location.origin) {
    if (/\/runtimes/.test(url.pathname)) return Response.json({ runtimes: [] });
    if (/\/health/.test(url.pathname)) return Response.json({ status: "ok" });
    fixture.forbiddenRequests.push(`${url.origin}${url.pathname}`); throw new Error("隔离夹具阻止访问真实服务。");
  }
  if (url.pathname.startsWith("/fixture-model")) return Response.json(url.pathname.endsWith("/models") ? { data: [{ id: "isolated-model" }] } : { choices: [{ message: { content: "隔离模型正常" }, finish_reason: "stop" }] });
  return originalFetch(input, init);
};
const stored = UnderstandingSessionSchema.safeParse(JSON.parse(sessionStorage.getItem("isolated-unified-project") || "null"));
let session = stored.success ? stored.data : fixtureSession();
const fresh = () => { sessionStorage.setItem("isolated-unified-project", JSON.stringify(session)); return structuredClone(session); };
const understanding: UnderstandingClient = {
  getCapabilities: async () => [], getSession: async () => fresh(),
  createSession: async input => { session = fixtureSession({ ...input, id: "unified-synthetic-project" }); return fresh(); },
  startTurn: async (_id, input) => {
    fixture.calls.push("understanding"); fixture.requests.push(input);
    const at = new Date().toISOString(), turn = session.turnCount + 1;
    session = { ...session, revision: session.revision + 1, turnCount: turn, phase: "running", updatedAt: at,
      confirmation: undefined, summaryHash: undefined,
      messages: [...session.messages, { id: `user-${turn}`, role: "user", text: input.answer || "请先理解这个合成项目", at }], events: [...session.events, { sequence: session.events.length + 1, kind: "thinking", label: "隔离提供方正在生成项目理解", at }] };
    setTimeout(() => {
      if (session.phase !== "running" || session.turnCount !== turn) return;
      const at = new Date().toISOString();
      session = { ...session, revision: session.revision + 1, phase: "awaiting-confirmation", updatedAt: at, understanding: fixtureUnderstanding, summaryHash: `synthetic-hash-${turn}`,
        messages: [...session.messages, { id: `agent-${turn}`, role: "agent", text: fixtureUnderstanding.summary, at }],
        events: [...session.events, { sequence: session.events.length + 1, kind: "waiting", label: "理解已生成，等待本人确认", at }] }; fresh();
    }, fixture.delay);
    return fresh();
  },
  confirm: async (_id, input) => { session = { ...session, phase: "confirmed", updatedAt: new Date().toISOString(), confirmation: { revision: input.expectedRevision, summaryHash: input.summaryHash, confirmedAt: new Date().toISOString() } }; return fresh(); },
  updateSource: async (_id, input) => { session = { ...session, sourceText: input.sourceText, revision: session.revision + 1, phase: "idle", confirmation: undefined }; return fresh(); },
  addGrant: async () => { throw new Error("此夹具不读取本机文件"); },
  revokeGrant: async () => { session = { ...session, revision: session.revision + 1, phase: "idle", confirmation: undefined, updatedAt: new Date().toISOString() }; return fresh(); },
  cancel: async () => { session = { ...session, phase: "cancelled", updatedAt: new Date().toISOString() }; return fresh(); },
};
const config: LlmConfig = { provider: "ollama", baseUrl: `${location.origin}/fixture-model/v1`, apiKey: "", model: "isolated-model", temperature: 0.2 };
async function wait(kind: string, input: unknown, signal?: AbortSignal) {
  fixture.calls.push(kind); fixture.requests.push(input);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, fixture.delay);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("隔离请求已取消", "AbortError")); }, { once: true });
  });
  if (fixture.failNext) { fixture.failNext = false; throw new Error("隔离提供方暂时不可用；输入保留，未切换提供方。"); }
}
const writingReply = (answer: string): WritingReply => ({ questions: answer ? [] : ["这个任务协调项目中，你本人实现了什么动作？"], rationale: "已使用授权的术语背景，个人贡献仍需你提供。", evidenceQuotes: answer ? [answer] : [], ...(answer ? { proposedText: answer } : {}) });
function coachResult(request: CoachRequest): CoachGeneration {
  return { model: { provider: "isolated", name: "fixture-model", generatedAt: new Date().toISOString() }, payload: request.mode === "plan" ? {
    kind: "plan", title: "合成项目接口证据计划", goal: request.settings.goal, durationWeeks: request.settings.durationWeeks, weeklyHours: request.settings.weeklyHours,
    phases: [{ title: "按周提交证据", startWeek: 1, endWeek: request.settings.durationWeeks, objective: "区分系统背景与本人贡献", tasks: Array.from({ length: request.settings.durationWeeks }, (_, index) => ({ id: `fixture-task-${index + 1}`, week: index + 1, title: `核对接口证据 ${index + 1}`, minutes: 30, deliverable: "可读说明与测试记录", acceptanceCriteria: ["本人核对动作和来源"], resourceQueries: ["接口回执 测试"] })) }], risks: ["提交不代表能力认证"], reviewCadence: "每周本人复盘",
  } : { kind: "analysis", summary: "已结合授权的项目共同理解与目标；先补本人动作证据，再调整方案。", directions: [{ title: "接口协调方向", reason: "项目背景只能解释边界", evidence: ["本轮授权的项目共同理解"], tradeoffs: ["个人成果尚待核对"] }], strengths: [], gaps: [{ skill: "个人实现范围", status: "unknown", reason: "没有提供依据，不等于不会" }], questions: [{ question: "你希望先核对哪一类个人成果？", why: "区分项目与本人贡献", options: ["接口行为", "异常回执", "自由补充"] }], nextActions: ["提供一段本人动作和验证记录"] } };
}
const accountState: ChatGptState = { profiles: [{ id: "isolated-account", label: "虚构账号 · 非真实授权", state: "connected" }], usageUrl: "https://chatgpt.com/settings/usage", automaticBillingFallback: false };
const accountClient: ChatGptClient = {
  state: async () => structuredClone(accountState), models: async () => [{ slug: "synthetic-gpt", displayName: "隔离 GPT 提供方" }], retry: async () => { fixture.quota = false; accountState.profiles[0]!.issue = undefined; return structuredClone(accountState); },
  signIn: async () => { throw new Error("隔离夹具不触发真实登录"); }, cancelSignIn: async () => structuredClone(accountState), signOut: async () => ({ remoteRevoked: true, state: { ...accountState, profiles: [] } }),
  respond: async (input: ChatGptResponseRequest, signal) => {
    await wait("chatgpt", input, signal);
    if (fixture.quota) { const issue = { kind: "limit" as const, code: "subscription_sharing_usage_limit_exceeded", message: "隔离额度不足，未切换付费 API。" }; accountState.profiles[0]!.issue = issue; throw new ChatGptClientError(issue.message, issue); }
    const data = input.instructions.includes("本轮操作") ? JSON.parse(input.input[0]!.content.slice(input.input[0]!.content.indexOf("{"))) : undefined;
    const text = input.instructions.includes("只分析本轮提供的一个字段") ? JSON.stringify(writingReply("")) : data
      ? JSON.stringify(coachResult({ ...data, mode: data.operation }).payload) : "隔离账号回复：我们沿用已确认的项目共同语言；个人实现范围仍需单独核对。";
    return { text, profileId: input.profileId, model: input.model };
  },
};
const doc = createInitialDocument(); doc.documentId = "unified-agent-fictional-document";
doc.factBase.profile.displayName = { zh: "隔离验证用户" }; doc.factBase.profile.email = "fixture@example.invalid";
doc.factBase.profile.phone = ""; doc.factBase.profile.headline = { zh: "参与接口开发，负责回执维护" };
doc.factBase.experiences = [{ ...doc.factBase.experiences[0]!, id: "isolated-exp", org: { zh: "虚构任务协调团队" }, title: { zh: "开发工程师" }, claims: [{ id: "isolated-claim", kind: "action", text: { zh: "负责合成项目接口开发，参与任务协调。" }, tags: [] }] }];
doc.resumeViews[0]!.experienceSelection = "all"; doc.resumeViews[0]!.includedExperienceIds = ["isolated-exp"];
const view = doc.resumeViews[0]!, resumeContext = createResumeAgentContext(doc.factBase, view), sources = writingSources(resumeContext);

function Fixture() {
  const [page, setPage] = useState("writing"), [error, setError] = useState("");
  const { theme, setTheme } = useUiPreferences();
  const { agent, snapshot } = useBetterMeAgent();
  const sourceBindings = useMemo(() => sources.map(source => ({ key: writingTargetKey(source.targetRef), text: source.text })), []);
  return <main style={{ padding: 24, maxWidth: 1600, margin: "auto" }}><AgentSourceBridge sources={sourceBindings} />
    <header><h1>统一 BetterMe Agent · 隔离浏览器回归</h1><p>正式模块 + 独立 IndexedDB + 虚构资料和可控提供方。不连接真实业务、简历、岗位或账号。</p><nav aria-label="隔离页面">{["writing", "companion", "growth"].map(id => <button type="button" key={id} onClick={() => setPage(id)} style={{ padding: 12 }}>{id === "writing" ? "简历页" : id === "companion" ? "伴侣页" : "职业成长页"}</button>)}<AgentContinuityButton /></nav></header>
    <button type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>切换隔离明暗主题</button><p role="status">当前任务：{snapshot?.data.tasks.at(-1)?.status ?? "尚未开始"} · 模型请求 {fixture.calls.length} 次</p>
    <div hidden={page !== "writing"}><div id="resume-editor-panel"><p>虚构项目说明</p><textarea aria-label="虚构原文" readOnly value={sources[0]?.text} /></div><div style={{ height: 760 }}><ResumeWritingCopilot sessionKey="synthetic-writing-scope" sources={sources} config={config} active={page === "writing"} understandingClient={understanding} chatGptClient={accountClient}
      onApply={async () => ({ ok: true, message: "隔离夹具仅记录确认，不写真实简历。" })} onFocus={() => {}} generate={async (_config, _source, answer, signal, _transport, _context, shared) => { await wait("writing", { answer, shared }, signal); return writingReply(answer); }}><div style={{ padding: 30, overflow: "auto" }}>虚构简历预览<p>只验证正式伴写的真实浏览器交互，不代表真实模型效果。</p></div></ResumeWritingCopilot></div></div>
    <div hidden={page !== "growth"}><CareerCoachWorkspace workspaceKey="synthetic-growth-scope" job={null} resumeEditContext={resumeContext} llmConfig={config} onOpenConfig={() => setError("隔离模型已明确配置，不打开真实设置")} chatGptClient={accountClient}
      generate={async (request, _config, signal) => { await wait("growth", request, signal); return coachResult(request); }} /></div>
    <AgentCompanion llmConfig={config} resume={projectResume(doc.factBase, view)} onOpenWorkspace={() => setPage("growth")} onOpenAiConfig={() => setError("不访问真实配置")} chatGptClient={accountClient}
      sendChat={async input => { await wait("companion", input, input.signal); return { id: crypto.randomUUID(), role: "assistant", content: "我们沿用同一份已授权项目共识；请继续补充本人动作。", createdAt: new Date().toISOString() }; }} />
    <BetterMeAgentCenter onNavigate={origin => { setPage(origin === "growth" ? "growth" : origin === "companion" ? "companion" : "writing"); if (origin === "companion") window.dispatchEvent(new Event("betterme:open-companion")); }} />
    <aside style={{ marginTop: 24 }}><h2>隔离故障控制</h2><button type="button" onClick={() => { fixture.failNext = true; }}>下一请求失败</button><button type="button" onClick={() => { fixture.quota = true; }}>账号额度不足</button><button type="button" onClick={() => { fixture.delay = 120; }}>快速响应</button><button type="button" onClick={() => { fixture.delay = 4500; }}>延迟响应</button><button type="button" onClick={() => { void understanding.revokeGrant("fixture", "fixture").then(() => agent?.refreshUnderstanding()); }}>撤销隔离材料授权</button>{error && <p role="alert">{error}</p>}</aside>
  </main>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider><BetterMeAgentProvider workspaceKey={doc.documentId!} understandingClient={understanding}><Fixture /></BetterMeAgentProvider></UiPreferencesProvider>);
