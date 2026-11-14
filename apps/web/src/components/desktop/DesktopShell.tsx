import { useEffect, useRef, useState, type ReactNode } from "react";
import { Globe, History, Palette, Settings2, Sparkles } from "lucide-react";
import { useAgentSidebar } from "../AgentSidebar";
import { useUiPreferences } from "../../lib/ui-preferences";
import { DesktopDock, type DesktopPage } from "./DesktopDock";
import { DesktopWindow } from "./DesktopWindow";
import { DesktopSettings } from "./DesktopSettings";
import { DesktopAppMenu } from "./DesktopAppMenu";
import { DesktopMenuBar } from "./DesktopMenuBar";
import { useDesktopWallpaper } from "../../lib/use-desktop-wallpaper";
import { useInstalledMicroApps, type InstalledMicroApp } from "../../lib/micro-app-registry";
import { SandboxedAppHost } from "../SandboxedAppHost";
import { ProductMark } from "../ProductMark";

export function DesktopShell({ children, page, onNavigate, onDesign, onHistory, onAiConfig, onNetwork, resumeTab = "content", onContent, accountControls, focused = false }: {
  children: ReactNode; page: DesktopPage; onNavigate: (page: DesktopPage) => void;
  onDesign: () => void; onHistory: () => void; onAiConfig: () => void; onNetwork: () => void;
  resumeTab?: "content" | "design"; onContent?: () => void; accountControls?: ReactNode; focused?: boolean;
}) {
  const sidebar = useAgentSidebar();
  const { t, locale, wallpaper = "aurora", wallpaperOpacity = 1, wallpaperBlur = 0, reduceMotion = false } = useUiPreferences();
  const customWallpaper = useDesktopWallpaper();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState<{ section: string; id: number }>();
  const installedMicroApps = useInstalledMicroApps();
  const pinnedMicroApps = installedMicroApps.filter(app => app.pinnedToDock);
  const [activeMicroApp, setActiveMicroApp] = useState<InstalledMicroApp | null>(null);
  useEffect(() => {
    const openMicroApp = (event: Event) => {
      const detail = (event as CustomEvent<InstalledMicroApp | undefined>).detail;
      if (detail?.appId) setActiveMicroApp(detail);
    };
    window.addEventListener("betterme:open-micro-app", openMicroApp);
    return () => window.removeEventListener("betterme:open-micro-app", openMicroApp);
  }, []);
  useEffect(() => {
    const open = (event: Event) => {
      const section = (event as CustomEvent).detail;
      if (!["connections", "tools", "research", "desktop", "appearance", "accessibility"].includes(section)) return;
      setSettingsRequest(previous => ({ section, id: (previous?.id ?? 0) + 1 }));
      setSettingsOpen(true);
    };
    window.addEventListener("betterme:open-settings", open);
    return () => window.removeEventListener("betterme:open-settings", open);
  }, []);
  const [mainHidden, setMainHidden] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => { const timer = setInterval(() => setNow(new Date()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (settingsOpen) shell.current?.querySelector<HTMLButtonElement>(".os-settings-window .os-traffic button")?.focus({ preventScroll: true });
  }, [settingsOpen]);
  const titles: Record<DesktopPage, string> = { resume: t("简历工作室", "Resume studio"), agent: t("AI 顾问", "AI workspace"), opportunities: t("机会与投递", "Opportunities"), resources: t("资料库", "Resources"), atlas: t("岗位地图", "Opportunity atlas"), autopilot: t("自动化工坊", "Autopilot studio") };
  function focusDock(id: string) { shell.current?.querySelector<HTMLButtonElement>(`[data-dock-app="${id}"]`)?.focus({ preventScroll: true }); }
  function closeSettings() { setSettingsOpen(false); focusDock("settings"); }
  function navigate(next: DesktopPage) { setSettingsOpen(false); setMainHidden(false); onNavigate(next); }
  const isElectron = typeof window !== "undefined" && Boolean((window as any).desktopApi?.isElectron);
  const filterParts: string[] = [];
  if (wallpaper === "midnight") filterParts.push("brightness(.58) saturate(.8)");
  if (wallpaper === "warm") filterParts.push("hue-rotate(155deg) saturate(.65)");
  if (wallpaperBlur > 0) filterParts.push(`blur(${wallpaperBlur}px)`);
  const computedWallpaperFilter = filterParts.length > 0 ? filterParts.join(" ") : undefined;

  return <div ref={shell} className="os-desktop" data-page={page} data-studio={page === "resume"} data-focused={page === "resume" && focused} data-wallpaper={wallpaper} data-reduced-motion={reduceMotion} data-electron={isElectron} onKeyDown={event => {
    if (event.key === "Escape" && !event.defaultPrevented && settingsOpen && (event.target as HTMLElement).closest(".os-settings-window")) {
      event.stopPropagation(); closeSettings();
    }
  }}>
    <div
      className="os-wallpaper no-print"
      aria-hidden="true"
      data-custom={Boolean(customWallpaper.data?.enabled && customWallpaper.url)}
      style={{
        opacity: wallpaperOpacity,
        filter: computedWallpaperFilter,
        transform: wallpaperBlur > 0 ? "scale(1.04)" : undefined,
      }}
    >
      {customWallpaper.data?.enabled && customWallpaper.url ? (
        <img src={customWallpaper.url} alt="" draggable={false} decoding="async" style={{ objectFit: customWallpaper.data.fit }} />
      ) : wallpaper && wallpaper !== "aurora" && wallpaper !== "midnight" && wallpaper !== "warm" ? (
        <img
          src={wallpaper.startsWith("/") || wallpaper.startsWith("http") ? wallpaper : `/wallpapers/${wallpaper}.jpg`}
          alt=""
          draggable={false}
          decoding="async"
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : null}
    </div>
    <DesktopMenuBar>
      <div className="os-menubar-glass os-menubar-apps">
        <button type="button" className="os-system-brand" onClick={() => navigate("resume")} aria-label={t("返回简历工作室", "Go to resume studio")}><ProductMark size={22} />BetterMe</button>
        <DesktopAppMenu page={page} title={settingsOpen ? t("系统设置", "System settings") : titles[page]} onNavigate={navigate} />
      </div>
      <div className="os-menubar-glass os-menubar-status">
        <div className="os-menu-shortcuts"><button type="button" data-onboarding="atlas" onClick={() => navigate("atlas")}><Globe size={13} />{t("地图", "Atlas")}</button><button type="button" onClick={() => setSettingsOpen(true)} aria-label={t("打开系统设置", "Open system settings")}><Settings2 size={14} /></button></div>
        <time dateTime={now.toISOString()}>{new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(now)}</time>
      </div>
    </DesktopMenuBar>
    <div className="os-stage">
      <DesktopWindow layoutKey={page} title={titles[page]} hidden={mainHidden} onHide={() => { setMainHidden(true); focusDock(page); }} actions={<>{page === "resume" ? <><div className="studio-mode-switch" role="group" aria-label={t("工作室模式", "Studio mode")}><button type="button" aria-pressed={resumeTab === "content"} aria-controls="content-panel" onClick={() => onContent ? onContent() : navigate("resume")}>{t("内容", "Content")}</button><button type="button" aria-pressed={resumeTab === "design"} aria-controls="design-panel" onClick={onDesign}>{t("设计", "Design")}</button></div><button type="button" className="studio-writing-trigger" aria-expanded={sidebar?.open && sidebar.conversation === "writing"} onClick={() => sidebar?.open && sidebar.conversation === "writing" ? sidebar.hide() : sidebar?.show("conversation", "writing")}><Sparkles size={14} /><span>{t("写作助手", "Writing assistant")}</span></button></> : page === "atlas" || page === "opportunities" ? <div className="os-job-app-switch" role="group" aria-label={t("岗位应用", "Job applications")}><button type="button" aria-pressed={page === "opportunities"} onClick={() => navigate("opportunities")}>{t("岗位与投递", "Jobs")}</button><button type="button" aria-pressed={page === "atlas"} onClick={() => navigate("atlas")}>{t("地图", "Map")}</button></div> : <><button type="button" onClick={() => { navigate("resume"); onDesign(); }}><Palette size={14} /><span>{t("排版设计", "Design")}</span></button><button type="button" onClick={onHistory}><History size={14} /><span>{t("版本", "History")}</span></button></>}{accountControls}</>}>
        {children}
      </DesktopWindow>
      <DesktopWindow title={t("系统设置", "System settings")} settings layoutKey="settings" defaultSnap="centered" hidden={!settingsOpen} onHide={closeSettings}>
        <DesktopSettings request={settingsRequest} onAiConfig={onAiConfig} onNetwork={onNetwork} />
      </DesktopWindow>
      {activeMicroApp && (
        <SandboxedAppHost
          app={activeMicroApp}
          onClose={() => setActiveMicroApp(null)}
        />
      )}
    </div>
    <DesktopDock
      page={page}
      settingsOpen={settingsOpen}
      mainHidden={mainHidden}
      onNavigate={navigate}
      onMinimize={() => { setMainHidden(true); focusDock(page); }}
      onSettings={() => setSettingsOpen(true)}
      onCloseSettings={closeSettings}
      pinnedMicroApps={pinnedMicroApps}
      activeMicroAppId={activeMicroApp?.appId ?? null}
      onOpenMicroApp={app => setActiveMicroApp(current => current?.appId === app.appId ? null : app)}
    />
  </div>;
}
