import { createRoot } from "react-dom/client";
import { RecoverableModule } from "../../src/components/atlas/RecoverableModule";
const loadAtlas = () => import("../../src/components/AtlasWorkspace");
import { DesktopShell } from "../../src/components/desktop/DesktopShell";
import { useState } from "react";
import type { DesktopPage } from "../../src/components/desktop/DesktopDock";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/desktop/desktop.css";
const noService = async () => undefined;
function Fixture() {
  const [page, setPage] = useState<DesktopPage>("atlas");
  return <DesktopShell page={page} onNavigate={setPage} onDesign={() => {}} onHistory={() => {}} onAiConfig={() => {}} onNetwork={() => {}}>
    <div className="studio-app compact-chrome" style={{ display: page === "atlas" ? undefined : "none" }}><div className="studio-workspace"><div className="secondary-workspace"><RecoverableModule load={loadAtlas} label="岗位地图" componentProps={{ active: page === "atlas", devJobIndex: noService, onSaveOpportunity: () => {}, onAnalyze: () => {} }} /></div></div></div>
    {page !== "atlas" && <p style={{ padding: 24 }}>应用切换验收：{page}。本入口仅挂载真实地图组件，不连接岗位服务。</p>}
  </DesktopShell>;
}
createRoot(document.getElementById("root")!).render(
  <UiPreferencesProvider initialPreferences={{ locale: "zh", theme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light", workspaceThemeId: "graphite", dockAutoHide: false }}>
    <ConfirmationProvider><Fixture /></ConfirmationProvider>
  </UiPreferencesProvider>,
);
