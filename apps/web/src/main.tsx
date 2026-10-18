import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmationProvider } from "./components/ConfirmationDialog";
import { initializeUiAppearance, UiPreferencesProvider } from "./lib/ui-preferences";
import "./index.css";
import "./studio.css";
import "./components/confirmation.css";
import "./theme.css";
import "./components/resume-paper.css";
import "./components/templates/rendercv-themes.css";
import "./components/templates/jsonresume-themes.css";
import "./components/templates/jsonresume-community-themes.css";
import "./components/templates/jsonresume-extra-themes.css";
import "./components/templates/newfuture-theme.css";
import "./components/templates/billryan-theme.css";
import "./components/templates/best-resume-themes.css";
import "./components/templates/community-themes.css";
import "./components/templates/lppl-community-themes.css";
import "./components/templates/cc-community-themes.css";
import "./components/templates/deedy-theme.css";
import "./components/templates/rickosborne-theme.css";
import "./atelier.css";
import "./components/preview-toolbar.css";
import "./components/template-gallery.css";
import "./components/resume-themes.css";
import "./themes/workspace-theme.css";

const uiPreferences = initializeUiAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiPreferencesProvider initialPreferences={uiPreferences}><ConfirmationProvider><App /></ConfirmationProvider></UiPreferencesProvider>
  </StrictMode>,
);
