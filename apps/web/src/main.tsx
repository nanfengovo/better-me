import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RecoverableModule } from "./components/atlas/RecoverableModule";
import { IdentityGate } from "./components/IdentityGate";
import { RecoverySpaceGate } from "./components/RecoveryArchives";
import { ConfirmationProvider } from "./components/ConfirmationDialog";
import { initializeUiAppearance, UiPreferencesProvider, useUiPreferences } from "./lib/ui-preferences";
import "./index.css";
import "./studio.css";
import "./components/confirmation.css";
import "./theme.css";
import "./components/workspace-ui.css";
import "./atelier.css";
import "./themes/workspace-theme.css";
import "./components/responsive-workspace.css";
import "./components/studio-workbench.css";
import "./components/studio-materials.css";

const loadApp = () => import("./App").then(module => ({ default: module.App }));
function App() {
  const { t } = useUiPreferences();
  return <RecoverableModule load={loadApp} componentProps={{}} label={t("工作区", "Workspace")} loadingHint={t("正在准备工作区资源，已保存的资料不会改变。", "Preparing workspace resources. Saved data will not change.")} />;
}

const uiPreferences = initializeUiAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiPreferencesProvider initialPreferences={uiPreferences}><IdentityGate><RecoverySpaceGate><ConfirmationProvider><App /></ConfirmationProvider></RecoverySpaceGate></IdentityGate></UiPreferencesProvider>
  </StrictMode>,
);
