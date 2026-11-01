import { useEffect, useRef, useState } from "react";
import { ChevronDown, Compass, Settings2 } from "lucide-react";
import { WorkspacePreferences } from "./WorkspacePreferences";
import { useUiPreferences } from "../lib/ui-preferences";
import "./workspace-chrome.css";

export function WorkspaceMenu({ initial, onGuide, onAiConfig }: { initial: string; onGuide: () => void; onAiConfig: () => void }) {
  const { t } = useUiPreferences();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const launch = (action: () => void) => { setOpen(false); trigger.current?.focus(); action(); };
  return <div className="workspace-menu" ref={root} onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); setOpen(false); trigger.current?.focus(); } }}>
    <button ref={trigger} className="workspace-menu-trigger" type="button" aria-label={t("工作台设置", "Workspace settings")} aria-expanded={open} onClick={() => setOpen(value => !value)}><span>{initial}</span><ChevronDown size={12} /></button>
    <section className="workspace-menu-panel" hidden={!open} aria-label={t("工作台偏好", "Workspace preferences")}>
      <h2>{t("工作台设置", "Workspace settings")}</h2><WorkspacePreferences />
      <div className="workspace-menu-links"><button type="button" onClick={() => launch(onGuide)}><Compass size={15} />{t("新手引导", "Workspace tour")}</button><button data-onboarding="ai" type="button" onClick={() => launch(onAiConfig)}><Settings2 size={15} />{t("AI 配置", "AI settings")}</button></div>
    </section>
  </div>;
}
