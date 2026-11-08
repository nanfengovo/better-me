import { useRef } from "react";
import { ChevronDown, Check } from "lucide-react";
import { desktopIcons, type DesktopPage } from "./DesktopDock";
import { useUiPreferences } from "../../lib/ui-preferences";
import "./app-menu.css";

export function DesktopAppMenu({ page, title, onNavigate }: { page: DesktopPage; title: string; onNavigate: (page: DesktopPage) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const { t } = useUiPreferences();
  const apps = [
    { id: "resume", label: t("简历工作室", "Resume studio") },
    { id: "agent", label: t("AI 顾问", "AI workspace") },
    { id: "opportunities", label: t("岗位与投递", "Jobs & applications") },
    { id: "atlas", label: t("岗位地图", "Opportunity atlas") },
    { id: "resources", label: t("资料库", "Resources") },
    { id: "autopilot", label: t("自动化工坊", "Autopilot studio") },
  ] as const;
  function close() { if (ref.current) { ref.current.open = false; ref.current.querySelector("summary")?.focus(); } }
  return <details ref={ref} className="os-app-menu" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) event.currentTarget.open = false; }} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); } }}>
    <summary aria-label={t("应用菜单", "Applications")}>{title}<ChevronDown size={12} aria-hidden="true" /></summary>
    <nav aria-label={t("切换应用", "Switch application")}>
      {apps.map(app => <button key={app.id} type="button" aria-current={page === app.id ? "page" : undefined} onClick={() => { close(); onNavigate(app.id); }}><img src={desktopIcons[app.id]} alt="" width={28} height={28} /><span>{app.label}</span>{page === app.id && <Check size={14} aria-hidden="true" />}</button>)}
    </nav>
  </details>;
}
