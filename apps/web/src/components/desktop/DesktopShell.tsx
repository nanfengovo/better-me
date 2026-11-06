import { useEffect, useRef, useState, type ReactNode } from "react";
import { Globe, History, Palette, Settings2 } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import { DesktopDock, type DesktopPage } from "./DesktopDock";
import { DesktopWindow } from "./DesktopWindow";
import { DesktopSettings } from "./DesktopSettings";

export function DesktopShell({ children, page, onNavigate, onDesign, onHistory, onAiConfig, onNetwork }: {
  children: ReactNode; page: DesktopPage; onNavigate: (page: DesktopPage) => void;
  onDesign: () => void; onHistory: () => void; onAiConfig: () => void; onNetwork: () => void;
}) {
  const { t, locale, wallpaper = "aurora", reduceMotion = false } = useUiPreferences();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [mainHidden, setMainHidden] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (settingsOpen) shell.current?.querySelector<HTMLButtonElement>(".os-settings-window .os-traffic button")?.focus({ preventScroll: true });
  }, [settingsOpen]);
  const titles: Record<DesktopPage, string> = { resume: t("简历工作室", "Resume studio"), agent: t("AI 顾问", "AI workspace"), opportunities: t("机会与投递", "Opportunities"), resources: t("资料库", "Resources"), atlas: t("岗位地图", "Opportunity atlas") };
  function focusDock(id: string) { shell.current?.querySelector<HTMLButtonElement>(`[data-dock-app="${id}"]`)?.focus({ preventScroll: true }); }
  function closeSettings() { setSettingsOpen(false); focusDock("settings"); }
  function navigate(next: DesktopPage) { setSettingsOpen(false); setMainHidden(false); onNavigate(next); }
  return <div ref={shell} className="os-desktop" data-wallpaper={wallpaper} data-reduced-motion={reduceMotion}>
    <div className="os-wallpaper no-print" aria-hidden="true" />
    <header className="os-menubar no-print">
      <button type="button" className="os-system-brand" onClick={() => navigate("resume")} aria-label={t("返回简历工作室", "Go to resume studio")}><span>b</span>BetterMe</button>
      <span className="os-menu-location">{settingsOpen ? t("系统设置", "System settings") : titles[page]}</span>
      <div className="os-menu-shortcuts"><button type="button" data-onboarding="atlas" onClick={() => navigate("atlas")}><Globe size={13} />{t("地图", "Atlas")}</button><button type="button" onClick={() => setSettingsOpen(true)} aria-label={t("打开系统设置", "Open system settings")}><Settings2 size={14} /></button></div>
      <time dateTime={now.toISOString()}>{new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(now)}</time>
    </header>
    <div className="os-stage">
      <div className="os-desktop-empty no-print" aria-hidden={!mainHidden}><span>BetterMe</span><p>{t("为下一步，留一点空间。", "A little space for your next step.")}</p>{mainHidden && <button type="button" onClick={() => setMainHidden(false)}>{t("返回工作空间", "Return to workspace")}</button>}</div>
      <DesktopWindow title={titles[page]} hidden={mainHidden} inactive={settingsOpen} onHide={() => { setMainHidden(true); focusDock(page === "atlas" ? "resume" : page); }} actions={<><button type="button" onClick={() => { navigate("resume"); onDesign(); }}><Palette size={14} /><span>{t("排版设计", "Design")}</span></button><button type="button" onClick={onHistory}><History size={14} /><span>{t("版本", "History")}</span></button></>}>
        {children}
      </DesktopWindow>
      <DesktopWindow title={t("系统设置", "System settings")} settings hidden={!settingsOpen} onHide={closeSettings}>
        <DesktopSettings onAiConfig={onAiConfig} onNetwork={onNetwork} />
      </DesktopWindow>
    </div>
    <DesktopDock page={page} settingsOpen={settingsOpen} onNavigate={navigate} onSettings={() => setSettingsOpen(true)} />
  </div>;
}
