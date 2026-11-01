import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CareerCoachWorkspace } from "../../src/components/CareerCoachWorkspace";
import { BetterMeAgentCenter } from "../../src/components/BetterMeAgentCenter";
import { BetterMeAgentProvider, useBetterMeAgent } from "../../src/lib/betterme-agent/react";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import { createCoachGenerator } from "../../src/lib/career-coach/model";
import type { CoachPayload, CoachRequest } from "../../src/lib/career-coach/types";
import type { ChatGptClient } from "../../src/services/chatgpt-client";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

const qa = { calls: [] as unknown[], failNext: false, hangNext: false, delay: 750, forbidden: [] as string[], planCount: 0 };
Object.assign(window, { growthQa: qa });
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin !== location.origin) { qa.forbidden.push(`${url.origin}${url.pathname}`); throw new Error("隔离夹具阻止外部请求"); }
  return originalFetch(input, init);
};
const accountState = { profiles: [], usageUrl: "https://chatgpt.com/settings/usage" as const, automaticBillingFallback: false as const };
const accountClient: ChatGptClient = {
  state: async () => accountState, models: async () => [], signIn: async () => { throw new Error("本夹具不进行真实授权"); },
  signOut: async () => ({ state: accountState, remoteRevoked: false }), cancelSignIn: async () => accountState, retry: async () => accountState,
  respond: async () => { throw new Error("本夹具未连接 ChatGPT；不得回退 API"); },
};
const config = { provider: "ollama" as const, model: "isolated-fixture", baseUrl: "http://127.0.0.1:5203/synthetic-only/v1", apiKey: "", temperature: 0 };
const generator = createCoachGenerator(async (_config, messages, options) => {
  const text = String(messages.find(item => item.role === "user")!.content);
  const input = JSON.parse(text.slice(text.indexOf("{"))) as {
    operation: CoachRequest["mode"]; settings: CoachRequest["settings"]; input: string;
    drill?: CoachRequest["drill"]; interview?: { turns: Array<{ question: string; answer: string }>; totalRounds: number; adaptive: boolean };
  };
  qa.calls.push(input);
  if (qa.hangNext) { qa.hangNext = false; return new Promise(() => {}); }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, qa.delay);
    options?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("已停止", "AbortError")); }, { once: true });
  });
  if (qa.failNext) { qa.failNext = false; throw new Error("隔离模型暂不可用，输入保留，未切换提供方。"); }
  let payload: CoachPayload;
  if (input.operation === "analysis") payload = { kind: "analysis", summary: `对齐目标：${input.settings.goal}。仅验证状态建模与测试，不声称已有生产成果。`,
    directions: [{ title: "可靠的状态建模", reason: "依据本轮目标", evidence: [input.settings.goal], tradeoffs: ["先小练习，再讨论真实系统"] }],
    strengths: [], gaps: [{ skill: "失败边界", status: "unknown", reason: "目前没有可复现证据，未知不代表不会" }],
    questions: [{ question: "这次优先验证哪种边界？", why: "避免把系统背景当个人能力", options: ["重复操作", "非法迁移"] }], nextActions: ["确认理解后生成任务"] };
  else if (input.operation === "plan") {
    qa.planCount++;
    payload = { kind: "plan", title: qa.planCount > 1 ? "状态建模 · 复盘修订" : "状态建模 · 初始计划", goal: input.settings.goal,
      durationWeeks: input.settings.durationWeeks, weeklyHours: input.settings.weeklyHours,
      phases: [{ title: "隔离实践", startWeek: 1, endWeek: input.settings.durationWeeks, objective: "留下实际测试与解释",
        tasks: Array.from({ length: input.settings.durationWeeks }, (_, index) => ({ id: `task-${index + 1}`, title: qa.planCount > 1 ? `补充失败与重试说明 ${index + 1}` : `实现状态迁移 ${index + 1}`, week: index + 1, minutes: 30,
          deliverable: "练习代码、完整测试回执和本人解释", acceptanceCriteria: ["覆盖正常、重复、非法和未知状态", "本人解释边界"], resourceQueries: ["JavaScript 条件控制 MDN"] })) }], risks: ["测试通过不等于公司实践能力"], reviewCadence: "完成后本人复盘" };
  } else if (input.operation === "review") payload = { kind: "review", summary: "参考提交中的逐项测试回执；请解释为什么非法迁移要保留原状态。", evidenceAssessment: "ready_for_self_check",
    strengths: ["提供了实现和逐项回执"], improvements: ["还需本人解释设计取舍"], nextActions: ["补充失败与重试说明"], checkQuestions: ["能否独立解释不变量？"] };
  else if (input.operation === "drill") payload = input.drill?.answer
    ? { kind: "drill", feedback: { verdict: "needs_practice", quote: input.drill.answer.slice(0, 200), explanation: "引用属于本次回答；模型替身建议补充一个反例，不作能力认证。", nextAction: "补充重复请求的反例" } }
    : { kind: "drill", question: { text: "为什么重复请求应避免产生第二次副作用？", skill: input.drill?.topic || "幂等", why: "由目标中的可靠性要求出题", criteria: ["解释不变量", "给一个失败反例"] } };
  else if (input.operation === "interview") {
    const count = input.interview?.turns.length ?? 0, complete = count >= (input.interview?.adaptive ? 2 : input.interview?.totalRounds ?? 3);
    payload = { kind: "interview", complete, ...(complete ? { summary: "两轮材料已覆盖本场状态边界，生产并发实践仍未验证。" } : { question: { text: count ? "根据你刚才的回答，失败重试如何保持原状态？" : "请解释你在隔离练习中选择的状态迁移规则。", focus: "状态与恢复", evaluationCriteria: ["依据自己的实现解释"] } }),
      ...(count ? { feedback: { summary: "基于刚才实际提交的回答", strengths: ["提供了自己的解释"], improvements: ["补充失败边界"], rubric: [{ criterion: "依据与边界", score: 2, comment: `回答提及「${input.interview!.turns.at(-1)!.answer.slice(0, 80)}」；未验证生产能力。` }] } } : {}), nextActions: ["补充失败与重试说明"] };
  } else payload = { kind: "resume", summary: "没有授权真实简历，不生成修改", proposals: [] };
  return { content: JSON.stringify(payload), finishReason: "stop" };
});
function Lab() {
  const [hidden, setHidden] = useState(false), [collapsed, setCollapsed] = useState(false);
  const { theme, setTheme } = useUiPreferences();
  const { snapshot } = useBetterMeAgent();
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--ui-canvas)", color: "var(--ui-text)" }}>
    <header style={{ padding: 12, display: "flex", flexWrap: "wrap", gap: 12 }}>
      <strong>隔离验收 · 虚构目标 / 模型替身 · 练习代码真实执行</strong>
      <button onClick={() => setHidden(!hidden)}>切换页面</button><button onClick={() => setCollapsed(!collapsed)}>收起或展开成长区</button>
      <button onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>切换明暗</button>
      <button onClick={() => { qa.failNext = true; }}>下一次模型失败</button><button onClick={() => { qa.hangNext = true; }}>下一次模型无响应</button>
      <span>统一任务：{snapshot?.data.tasks.at(-1)?.status ?? "尚未开始"}</span>
    </header>
    {(hidden || collapsed) && <p>成长区仅隐藏，进行中任务与草稿保持；没有打开业务项目或真实资料。</p>}
    <div hidden={hidden || collapsed} style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
      <CareerCoachWorkspace workspaceKey="isolated-career-growth-v1" job={null} llmConfig={config} generate={generator} chatGptClient={accountClient}
        onOpenConfig={() => window.alert("验收只使用模型替身，不配置密钥")} requestTimeoutMs={5000} />
    </div>
    <BetterMeAgentCenter onNavigate={() => { setHidden(false); setCollapsed(false); }} />
  </div>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><BetterMeAgentProvider workspaceKey="isolated-career-growth-v1"><Lab /></BetterMeAgentProvider></UiPreferencesProvider>);
