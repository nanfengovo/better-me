import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SWRConfig } from "swr";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import { DynamicIsland } from "../../src/components/desktop/DynamicIsland";
import { OpportunityCard3D } from "../../src/components/OpportunityCard3D";
import { ResumeImportModal } from "../../src/components/ResumeImportModal";
import { ResourceLibrary } from "../../src/components/ResourceLibrary";
import { createOpportunity } from "../../src/lib/opportunities";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/components/workspace-ui.css";
import "../../src/components/opportunities.css";
import "../../src/components/identity.css";
import "../../src/components/desktop/desktop.css";

const model = { calls: 1, failures: 0, metered: true, outputTokens: 0, lastAt: "2026-11-14T00:00:00Z" };
const fallback = {
  "system-status:host": { id: "host", label: "Agent 服务", health: "ok", detail: "在线", badge: "在线" },
  "system-status:proxy": { id: "proxy", label: "网络代理", health: "unknown", detail: "未检测", badge: "未检测" },
  "system-status:engines": [],
  "system-status:usage": { day: "2026-11-14", since: "2026-11-14T00:00:00Z", active: [], models: Array.from({ length: 20 }, (_, index) => ({ ...model, label: `synthetic-long-model-name-for-layout-and-keyboard-verification-${index + 1}`, inputTokens: index * 31 })) },
};
const job = createOpportunity({ company: "隔离合成公司", title: "平台研发与可靠性工程师（长岗位名称与跨团队工程协作方向，合成验收）", description: "完整岗位正文，仅用于布局和键盘测试，不写入机会库。".repeat(30), salaryText: "未披露", applicationDeadlineDate: "2026-12-01" });
job.application.nextAction = "核对原始招聘页面、确认工作地点与薪资范围，再准备岗位专属材料。".repeat(3);
function Fixture() {
  const [tab, setTab] = useState(() => new URLSearchParams(window.location.search).get("panel") ?? "cards"), [modal, setModal] = useState(false), [compact, setCompact] = useState(false);
  const { t, locale, setLocale, theme, setTheme } = useUiPreferences();
  return <main style={{ minHeight: "100dvh", background: "var(--ui-canvas)", color: "var(--ui-text)", padding: 16 }}>
    <header style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 20 }}><strong>隔离合成验收 · 不读取私人资料</strong>
      {["cards", "island", "import", "resources"].map(value => <button type="button" key={value} onClick={() => setTab(value)}>{value}</button>)}
      <button type="button" onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>语言</button>
      <button type="button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>主题</button>
    </header>
    {tab === "cards" && <section className="opportunity-workspace"><button type="button" onClick={() => setCompact(value => !value)}>切换紧凑列表</button><div className={`opportunity-3d-grid${compact ? " is-compact" : ""}`}><OpportunityCard3D compact={compact} job={job} location="地点待核实" modeLabel="未知" statusLabel="待核实" stageLabel="已收藏" salaryFallback="未披露" nextActionFallback="添加下一步" detailsLabel="查看完整详情" frontLabel="返回正面" backLabel="查看背面" deadlineLabel="截止日期" disabled={false} stageOptions={[["saved", "已收藏"], ["evaluating", "评估中"]]} onOpen={() => window.alert("合成详情入口，不修改记录")} onStageChange={() => {}} /></div></section>}
    {tab === "island" && <div style={{ position: "relative", height: "calc(100dvh - 110px)" }}><DynamicIsland /></div>}
    {tab === "import" && <><button type="button" id="import-trigger" onClick={() => setModal(true)}>{t("打开导入窗口", "Open import dialog")}</button><button type="button">背景控件</button><ResumeImportModal isOpen={modal} onClose={() => setModal(false)} llmConfig={{ provider: "ollama", model: "synthetic", apiKey: "", baseUrl: "http://invalid.invalid" }} onImportSuccess={() => { throw new Error("Fixture never adopts private data"); }} onOpenAiConfig={() => {}} /></>}
    {tab === "resources" && <ResourceLibrary />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<SWRConfig value={{ provider: () => new Map(), fallback, revalidateOnMount: false, revalidateOnFocus: false, isPaused: () => true }}><UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "dark", reduceMotion: true }}><Fixture /></UiPreferencesProvider></SWRConfig>);
