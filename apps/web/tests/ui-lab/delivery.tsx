import { createRoot } from "react-dom/client";
import { OpportunityWorkspace } from "../../src/components/OpportunityWorkspace";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import { UiPreferencesProvider, useUiPreferences } from "../../src/lib/ui-preferences";
import { addOpportunity, emptyOpportunityLibrary, OPPORTUNITY_STORAGE_KEY, exportOpportunityJson, recordOpportunityMaterial } from "../../src/lib/opportunities";
import "../../src/studio.css";
import "../../src/components/confirmation.css";

// Only a dedicated test origin; no host service, real resume, account or model.
if (location.hostname !== "delivery-verification.localhost") throw new Error("仅允许隔离合成验证域名。");
if (localStorage.getItem(OPPORTUNITY_STORAGE_KEY) === null) {
  let library = emptyOpportunityLibrary();
  for (const [name, url] of [["BOSS", "https://www.zhipin.com/job_detail/synthetic-delivery.html"], ["51job", "https://jobs.51job.com/synthetic/delivery.html"], ["猎聘", "https://www.liepin.com/job/synthetic-delivery.shtml"]]) {
    const added = addOpportunity(library, { company: `合成${name}企业`, title: "合成全栈工程师", description: "虚构岗位，仅用于页面回归，不打开外站，不发送简历。", sourceUrl: url, sourcePlatform: name, market: "domestic" });
    library = recordOpportunityMaterial(added.library, added.job.id, { resumeViewId: "synthetic-view", resumeName: "合成简历 v1", resumeUpdatedAt: "2026-11-05T01:00:00Z", markdown: "# 合成简历\n\n这是合成测试资料，不属于用户。", locale: "zh" });
  }
  localStorage.setItem(OPPORTUNITY_STORAGE_KEY, exportOpportunityJson(library));
}
function Lab() {
  const { theme, setTheme, locale, setLocale } = useUiPreferences();
  return <><header style={{ padding: 14, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}><strong>合成验证 · 正式机会工作台</strong><button className="studio-button" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>切换明暗</button><button className="studio-button" onClick={() => setLocale(locale === "zh" ? "en" : "zh")}>中文 / English</button></header><OpportunityWorkspace onSeedConsumed={() => {}} onOpenJd={() => {}} onOpenNetworkSettings={() => {}} onAnalyze={() => {}} onCreateResume={() => {}} linkedResumeNames={{}} getCurrentResumeMaterial={() => ({ resumeViewId: "synthetic-view", resumeName: "合成简历 v1", resumeUpdatedAt: "2026-11-05T01:00:00Z", markdown: "# 合成简历", locale: "zh" })} /></>;
}
createRoot(document.getElementById("root")!).render(<UiPreferencesProvider><ConfirmationProvider><Lab /></ConfirmationProvider></UiPreferencesProvider>);
