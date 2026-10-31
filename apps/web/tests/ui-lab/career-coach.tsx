import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ResumeEditContext } from "@better-me/agent-contracts";
import { CareerCoachWorkspace } from "../../src/components/CareerCoachWorkspace";
import { createCoachGenerator } from "../../src/lib/career-coach/model";
import type { CoachMode, CoachPayload, CoachSettings, CoachInterviewTurn } from "../../src/lib/career-coach/types";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/themes/workspace-theme.css";

const initialContext: ResumeEditContext = { locale: "zh", profile: { skills: ["TypeScript", "React"], headline: {
  text: "参与内部工具的前端开发与维护。", targetRef: { kind: "profile_headline", locale: "zh" },
} }, experiences: [] };
const calls: string[] = [];
const generate = createCoachGenerator(async (_config, messages, options) => {
  options?.signal?.throwIfAborted();
  const raw = String(messages[1]!.content);
  const input = JSON.parse(raw.slice(raw.indexOf("{"))) as { operation: CoachMode; settings: CoachSettings;
    providedContext: { resume?: ResumeEditContext }; interview?: { turns: CoachInterviewTurn[]; totalRounds: number } };
  calls.push(input.operation);
  let payload: CoachPayload;
  if (input.operation === "analysis") payload = { kind: "analysis", summary: "合成验收：先补齐接口设计与质量验证，再评估全栈岗位。", directions: [
    { title: "前端深度与全栈协作", reason: "以已有前端经验为起点，逐步增加接口实现和质量证据。", evidence: ["用户提供的目标与合成资料"], tradeoffs: ["每周预算有限，优先做一个可验证项目。"] },
  ], strengths: ["已有前端开发背景（合成输入）"], gaps: [{ skill: "接口设计", status: "unknown", reason: "当前材料未提供独立接口设计的依据。" }],
    questions: [{ question: "更希望先补哪方面？", why: "影响第一阶段任务安排。", options: ["接口开发", "测试与质量"] }], nextActions: ["明确每周可用时间，再生成学习方案。"] };
  else if (input.operation === "plan") payload = { kind: "plan", title: "全栈协作能力 · 分阶段学习", goal: input.settings.goal,
    durationWeeks: input.settings.durationWeeks, weeklyHours: input.settings.weeklyHours,
    phases: Array.from({ length: Math.ceil(input.settings.durationWeeks / 8) }, (_, phaseIndex) => ({
      title: `阶段 ${phaseIndex + 1} · 从实践到证据`, startWeek: phaseIndex * 8 + 1,
      endWeek: Math.min((phaseIndex + 1) * 8, input.settings.durationWeeks), objective: "完成可阅读、可复现的小型实现和说明。",
      tasks: Array.from({ length: Math.min(8, input.settings.durationWeeks - phaseIndex * 8) }, (_, index) => ({
        id: `week-${phaseIndex * 8 + index + 1}`, title: `第 ${phaseIndex * 8 + index + 1} 周：实现与复盘`, week: phaseIndex * 8 + index + 1,
        minutes: Math.min(120, Math.floor(input.settings.weeklyHours * 60)), deliverable: "一段实现、两项测试和一份取舍说明。",
        acceptanceCriteria: ["说明输入、输出与错误处理。", "提供正常路径和失败路径的可读证据。"], resourceQueries: ["TypeScript 官方手册 类型收窄", "Node.js 官方文档 测试"] })),
    })), risks: ["时间不足时先减少任务范围，不以打卡替代成果。"], reviewCadence: "每周提交一次证据，双周复盘。" };
  else if (input.operation === "resume") {
    const headline = input.providedContext.resume?.profile.headline;
    payload = { kind: "resume", summary: "合成验收：仅调整表达，不添加经历。", proposals: headline ? [{ targetRef: headline.targetRef,
      originalText: headline.text, proposedText: "承担内部工具的前端开发及日常维护。", rationale: "使职责表达更直接；请本人核对。" }] : [] };
  } else if (input.operation === "review") payload = { kind: "review", summary: "合成验收反馈：已有实现说明，还需补充异常路径的证据。", evidenceAssessment: "needs_revision",
    strengths: ["提交包含实际工作说明。"], improvements: ["补充失败路径如何被处理。"], nextActions: ["增加一个异常输入测试。"], checkQuestions: ["是否能复现并解释错误处理结果？"] };
  else {
    const rounds = input.interview?.turns.length ?? 0;
    const complete = rounds >= (input.interview?.totalRounds ?? 3);
    payload = { kind: "interview", complete, ...(!complete ? { question: { text: `问题 ${rounds + 1}：如何设计并验证一个可靠的表单提交流程？`,
      focus: "错误处理与可验证性", evaluationCriteria: ["描述状态变化。", "解释异常和重复提交的处理。"] } } : {}),
    ...(rounds > 0 ? { feedback: { summary: "合成反馈：回答说明了思路，仍可补充具体验证方法。", strengths: ["有明确的处理顺序。"], improvements: ["补充失败场景。"], rubric: [{ criterion: "表达与证据", score: 2, comment: "基于本次实际输入的练习参考，非能力认证。" }] } } : {}),
    ...(complete ? { summary: "合成面试已完成；建议继续练习异常路径说明。" } : {}), nextActions: ["用一个具体项目重新组织答案。"] };
  }
  return { content: JSON.stringify(payload), finishReason: "stop" };
});

function Lab() {
  const { theme, setTheme } = useUiPreferences();
  const [context, setContext] = useState(initialContext);
  return <div style={{ minHeight: "100vh", background: "var(--ui-canvas)", color: "var(--ui-text)" }}>
    <aside style={{ padding: "12px 20px", borderBottom: "1px solid var(--ui-border)", display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
      <strong>隔离验收 · 合成简历 / 模型替身 / 无外部请求</strong>
      <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>切换明暗</button>
    </aside>
    <CareerCoachWorkspace workspaceKey="synthetic-career-lab-v1" resumeEditContext={context}
      job={{ title: "全栈开发工程师 · 合成岗位", company: "合成公司", description: "负责 TypeScript 应用、接口协作与自动化测试。" }}
      llmConfig={{ provider: "ollama", baseUrl: "https://synthetic-model.invalid/v1", model: "Synthetic QA (not a real model)", apiKey: "" }}
      generate={generate} onOpenConfig={() => window.alert("合成验收不连接真实模型。")}
      onApplyResumeProposal={async (proposal) => {
        if (proposal.originalText !== context.profile.headline?.text) return { ok: false, message: "合成原文已变化。" };
        setContext({ ...context, profile: { ...context.profile, headline: { targetRef: proposal.targetRef, text: proposal.proposedText } } });
        return { ok: true, message: "只更新了本验收页的合成简历，未访问真实简历。" };
      }} />
  </div>;
}
Object.assign(window, { __careerCoachQa: { calls, syntheticOnly: true } });
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><Lab /></UiPreferencesProvider>);
