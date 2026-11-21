import { lazy, StrictMode, Suspense, useEffect, useState, type ReactNode } from "react";
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
import "./design-system/tokens.css";
import "./design-system/primitives.css";
import "./components/skill-evidence-atlas.css";

const loadApp = () => import("./App").then(module => ({ default: module.App }));
const PublicLanding = lazy(() => import("./components/PublicLanding").then(m => ({ default: m.PublicLanding })));
const AtsDiagnosticTool = lazy(() => import("./components/AtsDiagnosticTool").then(m => ({ default: m.AtsDiagnosticTool })));

type PublicView = "landing" | "ats" | null;

function readPublicViewFromLocation(): PublicView {
  try {
    const view = new URLSearchParams(window.location.search).get("view");
    if (view === "landing" || view === "ats") return view;
  } catch {
    /* Ignore invalid URL contexts. */
  }
  return null;
}

function updateUrlPublicView(next: PublicView) {
  try {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("view", next);
    else url.searchParams.delete("view");
    window.history.pushState({}, "", url.toString());
  } catch {
    /* Ignore restricted history environments. */
  }
}

function PublicSurfaceRouter({ children }: { children: ReactNode }) {
  const { t } = useUiPreferences();
  const [publicView, setPublicView] = useState<PublicView>(() => readPublicViewFromLocation());

  useEffect(() => {
    const onPopState = () => setPublicView(readPublicViewFromLocation());
    const onCustom = (event: Event) => {
      const detail = (event as CustomEvent<PublicView>).detail ?? null;
      updateUrlPublicView(detail);
      setPublicView(detail);
      window.scrollTo({ top: 0, behavior: "instant" });
    };
    window.addEventListener("popstate", onPopState);
    window.addEventListener("betterme:open-public-view", onCustom);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener("betterme:open-public-view", onCustom);
    };
  }, []);

  function navigateTo(next: PublicView) {
    updateUrlPublicView(next);
    setPublicView(next);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  if (publicView === "landing") {
    return (
      <Suspense fallback={<div className="studio-loading">{t("正在加载产品主页…", "Loading landing page…")}</div>}>
        <PublicLanding
          onEnterStudio={() => navigateTo(null)}
          onOpenStandaloneAts={() => navigateTo("ats")}
        />
      </Suspense>
    );
  }

  if (publicView === "ats") {
    return (
      <Suspense fallback={<div className="studio-loading">{t("正在加载 ATS 诊断工具…", "Loading ATS diagnostics…")}</div>}>
        <AtsDiagnosticTool standalone onOpenStudio={() => navigateTo(null)} />
      </Suspense>
    );
  }

  return <>{children}</>;
}

function App() {
  const { t } = useUiPreferences();
  return <RecoverableModule load={loadApp} componentProps={{}} label={t("工作区", "Workspace")} loadingHint={t("正在准备工作区资源，已保存的资料不会改变。", "Preparing workspace resources. Saved data will not change.")} />;
}

const uiPreferences = initializeUiAppearance();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UiPreferencesProvider initialPreferences={uiPreferences}>
      <PublicSurfaceRouter>
        <IdentityGate>
          <RecoverySpaceGate>
            <ConfirmationProvider>
              <App />
            </ConfirmationProvider>
          </RecoverySpaceGate>
        </IdentityGate>
      </PublicSurfaceRouter>
    </UiPreferencesProvider>
  </StrictMode>,
);
