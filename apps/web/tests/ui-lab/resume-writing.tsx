import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createInitialDocument } from "@better-me/storage";
import { projectResume } from "@better-me/core";
import { FactEditor } from "../../src/components/FactEditor";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import { ResumePreview } from "../../src/components/ResumePreview";
import { ResumeWritingCopilot } from "../../src/components/ResumeWritingCopilot";
import { applyResumeProposal, createResumeAgentContext } from "../../src/lib/resume-agent-context";
import { writingSources, writingTargetKey } from "../../src/lib/resume-copilot";
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
initial.factBase.profile.displayName = { zh: "伴写体验 · 虚构示例" };
initial.factBase.profile.email = "example@example.invalid";
initial.factBase.profile.phone = "";
initial.factBase.experiences = [{ ...initial.factBase.experiences[0]!, id: "writing-demo-exp", org: { zh: "示例软件团队（非真实经历）" }, claims: [{ id: "writing-demo-claim", kind: "action", text: { zh: "负责接口开发，参与系统维护。" }, tags: [] }] }];
initial.resumeViews[0]!.includedExperienceIds = ["writing-demo-exp"];
initial.resumeViews[0]!.experienceSelection = "all";
function Lab() {
  const [doc, setDoc] = useState(initial), [follow, setFollow] = useState<PreviewFollowTarget | null>(null);
  const [focus, setFocus] = useState<React.ComponentProps<typeof FactEditor>["writingFocus"]>();
  const view = doc.resumeViews[0]!;
  const sources = useMemo(() => writingSources(createResumeAgentContext(doc.factBase, view)), [doc, view]);
  return <div style={{ height: "100vh", display: "flex", flexDirection: "column", padding: 16, gap: 12, background: "var(--color-paper)" }}>
    <header style={{ fontSize: 13, display: "flex", gap: 12 }}><strong>BetterMe · 简历伴写体验</strong><span>仅虚构数据，不读取你的简历。连接本机 gemma4 模型；刷新保留批注，但示例正文重置。</span></header>
    <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(320px,.65fr) minmax(0,1fr)", gap: 18 }}>
      <div id="resume-editor-panel" style={{ minHeight: 0, display: "flex" }}><FactEditor factBase={doc.factBase} onChange={factBase => setDoc(d => ({ ...d, factBase }))} onPreviewTargetChange={setFollow} writingFocus={focus} /></div>
      <div className="studio-preview-pane" style={{ minWidth: 0, minHeight: 0 }}>
        <ResumeWritingCopilot sessionKey="synthetic-writing-lab-v1" sources={sources} config={{ provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "gemma4:e2b-it-qat", temperature: 0.2 }} active onApply={async proposal => {
          const result = applyResumeProposal(doc, proposal);
          if (!result.ok) return { ok: false, message: "示例原文已变化，本次没有写入。" };
          setDoc(result.document); return { ok: true, message: "仅修改此页内存中的虚构示例，可撤销；未写入真实简历。" };
        }} onFocus={source => { setFocus({ key: writingTargetKey(source.targetRef), locale: source.targetRef.locale, experienceId: source.targetRef.kind === "claim_text" ? source.targetRef.experienceId : undefined, requestId: Date.now() }); }}>
          <ResumePreview resume={projectResume(doc.factBase, view)} view={view} followTarget={follow} onViewChange={next => setDoc(d => ({ ...d, resumeViews: [next] }))} />
        </ResumeWritingCopilot>
      </div>
    </main>
  </div>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light" }}><ConfirmationProvider><Lab /></ConfirmationProvider></UiPreferencesProvider>);
