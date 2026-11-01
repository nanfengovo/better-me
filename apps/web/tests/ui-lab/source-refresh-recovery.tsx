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
if (location.origin !== "http://127.0.0.1:5196") throw new Error("Isolated fixture origin required");
createRoot(document.getElementById("root")!).render(
  <UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light", workspaceThemeId: "graphite" }}>
    <ConfirmationProvider><header style={{ padding: 12 }}>来源刷新 · 纯合成内存 HTTP / Worker · 不连接真实岗位、简历或招聘平台</header>
      <AtlasWorkspace active devJobIndex={async () => ({ ok: true, endpoint: location.origin, token: "synthetic-only" })}
        onSaveOpportunity={() => {}} onAnalyze={() => {}} />
    </ConfirmationProvider>
  </UiPreferencesProvider>,
);
