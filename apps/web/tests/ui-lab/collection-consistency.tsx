import { createRoot } from "react-dom/client";
import AtlasWorkspace from "../../src/components/AtlasWorkspace";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import { ConfirmationProvider } from "../../src/components/ConfirmationDialog";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/themes/workspace-theme.css";
import "../../src/components/confirmation.css";
import "./ui-lab.css";

const session = fetch("/__collection-consistency/session", { method: "POST" }).then(async response => {
  if (!response.ok) throw new Error("Isolated fixture session unavailable");
  return response.json() as Promise<{ token: string; seedJobs: number }>;
});
const bootstrap = async (signal: AbortSignal) => {
  const { token } = await session; signal.throwIfAborted();
  return { ok: true as const, endpoint: location.origin, token };
};
createRoot(document.getElementById("root")!).render(
  <UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light", workspaceThemeId: "graphite" }}>
    <ConfirmationProvider><div className="atlas-ui-lab">
      <header className="atlas-ui-lab-toolbar"><strong>岗位一致性 · 隔离回归</strong>
        <span>仅合成岗位 · 真实临时 SQLite / HTTP / Worker · 不连接真实简历、岗位库或招聘平台</span></header>
      <AtlasWorkspace active devJobIndex={bootstrap} onSaveOpportunity={() => {}} onAnalyze={() => {}} />
    </div></ConfirmationProvider>
  </UiPreferencesProvider>,
);
