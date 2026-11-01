import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialDocument } from "@better-me/storage";
import { projectResume } from "@better-me/core";
import { FactEditor } from "../../src/components/FactEditor";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import { ResumePreview } from "../../src/components/ResumePreview";
import { ResumeWritingCopilot } from "../../src/components/ResumeWritingCopilot";
import { applyResumeProposal, createResumeAgentContext } from "../../src/lib/resume-agent-context";
import { writingSources, writingTargetKey, parseWritingReply } from "../../src/lib/resume-copilot";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import type { PreviewFollowTarget } from "../../src/lib/preview-follow";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/components/resume-paper.css";
import "../../src/components/preview-toolbar.css";
import "../../src/themes/workspace-theme.css";

const initial = createInitialDocument();
initial.factBase.profile.displayName = { zh: "项目理解回归 · 虚构用户" };
initial.factBase.profile.email = "example@example.invalid";
initial.factBase.profile.phone = "";
initial.factBase.experiences = [{ ...initial.factBase.experiences[0]!, id: "understanding-fixture-exp", org: { zh: "虚构物流软件团队" }, claims: [{ id: "understanding-fixture-claim", kind: "action", text: { zh: "参与 RCS 搬运项目。" }, tags: [] }] }];
initial.resumeViews[0]!.includedExperienceIds = ["understanding-fixture-exp"];
initial.resumeViews[0]!.experienceSelection = "all";
const live = new URLSearchParams(location.search).get("live") === "true";
const chatGptMode = new URLSearchParams(location.search).get("chatgpt");
const liveModel = new URLSearchParams(location.search).get("model") === "cloud" ? "gemma4:31b-cloud" : "gemma4:e2b-it-qat";
function Lab() {
  const [doc, setDoc] = useState(initial), [follow, setFollow] = useState<PreviewFollowTarget | null>(null);
  const [focus, setFocus] = useState<React.ComponentProps<typeof FactEditor>["writingFocus"]>();
  const view = doc.resumeViews[0]!;
  const sources = useMemo(() => writingSources(createResumeAgentContext(doc.factBase, view)), [doc, view]);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 16, gap: 12, background: "var(--color-paper)" }}>
    <header style={{ fontSize: 13 }}><strong>隔离验收：现有简历编辑器 + 项目理解</strong> · {chatGptMode === "authorization" ? "官方 ChatGPT 通道 · 等待用户本人授权（未验证真实模型调用）" : chatGptMode ? "签名有效的虚构 OAuth / GPT 测试提供方 · 不调用 OpenAI" : live ? `真实 Ollama / ${liveModel}${liveModel.includes("cloud") ? "（云推理，仅虚构资料）" : "（本机推理）"}` : "确定性测试 Agent，用于故障和恢复验证"} · 不接触真实简历或岗位库</header>
    <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(280px,.6fr) minmax(0,1fr)", gap: 18 }}>
      <div id="resume-editor-panel" style={{ minHeight: 0, display: "flex" }}><FactEditor factBase={doc.factBase} onChange={factBase => setDoc(d => ({ ...d, factBase }))} onPreviewTargetChange={setFollow} writingFocus={focus} /></div>
      <div className="studio-preview-pane" style={{ minWidth: 0, minHeight: 0 }}>
        <ResumeWritingCopilot sessionKey={chatGptMode ? `isolated-chatgpt-${chatGptMode}-v1` : live ? `isolated-project-understanding-live-${liveModel}-v1` : "isolated-project-understanding-fixture-v1"} sources={sources}
          config={{ provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", apiKey: "", model: live ? liveModel : "test-fixture", temperature: 0.1 }} active
          generate={!live && !chatGptMode ? async (_config, source, answer, signal) => {
            signal.throwIfAborted();
            if (answer.includes("PRIVATE_CUSTOMER_SENTINEL")) throw new Error("Private client leaked into writing fixture");
            const action = answer.split("\n").find(line => line.startsWith("本人确认的动作："))?.slice("本人确认的动作：".length);
            return parseWritingReply(JSON.stringify({ questions: action ? [] : ["哪一部分是你亲手完成的？"], rationale: "隔离测试模型：只引用本人确认的动作，不复制设计目标或客户私有备注。", evidenceQuotes: action ? [action] : [], ...(action ? { proposedText: action } : {}) }), source, answer);
          } : undefined}
          onApply={async proposal => { const result = applyResumeProposal(doc, proposal); if (!result.ok) return { ok: false, message: "原文变化，拒绝覆盖。" }; setDoc(result.document); return { ok: true, message: "只修改当前页的内存测试文档。" }; }}
          onFocus={source => setFocus({ key: writingTargetKey(source.targetRef), locale: source.targetRef.locale, experienceId: source.targetRef.kind === "claim_text" ? source.targetRef.experienceId : undefined, requestId: Date.now() })}>
          <ResumePreview resume={projectResume(doc.factBase, view)} view={view} followTarget={follow} onViewChange={next => setDoc(d => ({ ...d, resumeViews: [next] }))} />
        </ResumeWritingCopilot>
      </div>
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><ConfirmationProvider><Lab /></ConfirmationProvider></UiPreferencesProvider>);
