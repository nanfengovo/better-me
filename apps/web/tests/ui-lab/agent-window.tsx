import { createRoot } from "react-dom/client";
import { DesktopWindow } from "../../src/components/desktop/DesktopWindow";
import "../../src/index.css";
import "../../src/theme.css";
import "../../src/components/desktop/desktop.css";
import "../../src/components/advisor-compact.css";

createRoot(document.getElementById("root")!).render(
  <div className="os-desktop" data-page="agent">
    <header className="os-menubar">Agent 窗口回归夹具</header>
    <div className="os-stage">
      <DesktopWindow layoutKey="agent" title="AI 顾问" onHide={() => {}}>
        <textarea aria-label="合成草稿" defaultValue="窗口缩放不应丢失此草稿" />
      </DesktopWindow>
    </div>
  </div>,
);
