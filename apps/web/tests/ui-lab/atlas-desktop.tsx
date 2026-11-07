import { createRoot } from "react-dom/client";
import { RecoverableModule } from "../../src/components/atlas/RecoverableModule";
const loadAtlas = () => import("../../src/components/AtlasWorkspace");
import { DesktopWindow } from "../../src/components/desktop/DesktopWindow";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/desktop/desktop.css";
const noService = async () => undefined;
createRoot(document.getElementById("root")!).render(
  <UiPreferencesProvider initialPreferences={{ locale: "zh", theme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light", workspaceThemeId: "graphite" }}>
    <ConfirmationProvider><div className="os-desktop" data-page="atlas"><header className="os-menubar">岗位地图 · 隔离窗口验收（不连接岗位服务）</header><div className="os-stage">
      <DesktopWindow title="岗位地图" layoutKey="atlas" onHide={() => {}}><div className="studio-app compact-chrome"><div className="studio-workspace"><div className="secondary-workspace"><RecoverableModule load={loadAtlas} label="岗位地图" componentProps={{ devJobIndex: noService, onSaveOpportunity: () => {}, onAnalyze: () => {} }} /></div></div></div></DesktopWindow>
    </div></div></ConfirmationProvider>
  </UiPreferencesProvider>,
);
