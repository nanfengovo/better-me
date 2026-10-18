import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ConfirmationProvider } from "./components/ConfirmationDialog";
import { initializeUiAppearance, UiPreferencesProvider } from "./lib/ui-preferences";
import "./index.css";
import "./studio.css";
import "./components/confirmation.css";
import "./theme.css";

const uiPreferences = initializeUiAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiPreferencesProvider initialPreferences={uiPreferences}><ConfirmationProvider><App /></ConfirmationProvider></UiPreferencesProvider>
  </StrictMode>,
);
