import { useState, type ReactNode } from "react";
import { Accessibility, ArrowUpRight, ChevronLeft, Globe, Monitor, Palette, Search, SlidersHorizontal } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import { WORKSPACE_THEMES } from "../../themes/workspace-theme";
import { DesktopWallpaperSettings } from "./DesktopWallpaperSettings";

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="os-setting-row"><span>{label}</span><div>{children}</div></div>;
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <button className="os-switch" type="button" role="switch" aria-label={label} aria-checked={value} onClick={() => onChange(!value)}><span /></button>;
}
export function DesktopSettings({ onAiConfig, onNetwork }: { onAiConfig: () => void; onNetwork: () => void }) {
  const { t, locale, theme, setLocale, setTheme, workspaceThemeId, setWorkspaceThemeId, dockAutoHide = true, reduceMotion = false, setDesktopPreferences, persistenceError } = useUiPreferences();
  const [tab, setTab] = useState("appearance");
  const [query, setQuery] = useState("");
  const [mobileDetail, setMobileDetail] = useState(false);
  const tabs = [
    { id: "appearance", name: t("外观", "Appearance"), icon: Palette },
    { id: "desktop", name: t("桌面与 Dock", "Desktop & Dock"), icon: Monitor },
    { id: "accessibility", name: t("辅助功能", "Accessibility"), icon: Accessibility },
    { id: "connections", name: t("模型与网络", "Models & network"), icon: Globe },
  ];
  const title = tabs.find(item => item.id === tab)!.name;
  return <div className="os-settings" data-detail={mobileDetail}>
    <aside className="os-settings-sidebar">
      <div className="os-settings-identity"><div className="os-avatar">b</div><div><strong>BetterMe</strong><small>{t("你的职业工作空间", "Your career workspace")}</small></div></div>
      <label className="os-settings-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} aria-label={t("搜索设置分类", "Search settings categories")} placeholder={t("搜索设置", "Search settings")} /></label>
      <nav aria-label={t("设置分类", "Settings categories")}>{tabs.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <button key={item.id} type="button" aria-current={tab === item.id ? "page" : undefined} onClick={() => { setTab(item.id); setMobileDetail(true); }}><span className={`os-category-icon ${item.id}`}><item.icon size={15} /></span>{item.name}</button>)}</nav>
      {query && !tabs.some(item => item.name.toLowerCase().includes(query.toLowerCase())) && <p className="os-setting-note">{t("没有匹配的设置分类", "No matching settings")}</p>}
    </aside>
    <div className="os-settings-content">
      <button type="button" className="os-settings-back" onClick={() => setMobileDetail(false)}><ChevronLeft size={17} />{t("设置", "Settings")}</button>
      <h1>{title}</h1>
      {tab === "appearance" && <>
        <p className="os-setting-intro">{t("让工作空间，成为你喜欢的样子。", "Make this space feel like yours.")}</p>
        <div className="os-settings-card os-appearance-options" role="group" aria-label={t("界面主题", "Workspace theme")}>
          {(["light", "dark"] as const).map(mode => <button key={mode} type="button" aria-pressed={theme === mode} onClick={() => setTheme(mode)}><span className={`os-appearance-preview ${mode}`}><i /><b /></span><span>{mode === "light" ? t("浅色", "Light") : t("深色", "Dark")}</span></button>)}
        </div>
        <h2>{t("个性化", "Personalization")}</h2>
        <div className="os-settings-card">
          <SettingRow label={t("工作台配色", "Workspace palette")}><select aria-label={t("工作台配色", "Workspace palette")} value={workspaceThemeId} onChange={e => { const item = WORKSPACE_THEMES.find(value => value.id === e.target.value); if (item) setWorkspaceThemeId(item.id); }}>{WORKSPACE_THEMES.map(item => <option key={item.id} value={item.id}>{item.name[locale]}</option>)}</select></SettingRow>
          <SettingRow label={t("界面语言", "Interface language")}><select aria-label={t("界面语言", "Interface language")} value={locale} onChange={e => setLocale(e.target.value === "en" ? "en" : "zh")}><option value="zh">简体中文</option><option value="en">English</option></select></SettingRow>
        </div>
        <p className="os-setting-note">{t("仅改变工作空间外观，简历纸张与导出保持不变。", "Resume paper and exports keep their own design.")}</p>
      </>}
      {tab === "desktop" && <>
        <p className="os-setting-intro">{t("留出空间，专注眼前。", "More space for what matters.")}</p>
        <h2>{t("桌面壁纸", "Wallpaper")}</h2>
        <DesktopWallpaperSettings />
        <h2>Dock</h2><div className="os-settings-card"><SettingRow label={t("自动隐藏与显示 Dock", "Automatically hide Dock")}><Toggle label={t("自动隐藏 Dock", "Auto-hide Dock")} value={dockAutoHide} onChange={value => setDesktopPreferences({ dockAutoHide: value })} /></SettingRow></div>
        <p className="os-setting-note">{t("鼠标靠近屏幕底部中央时唤出。触屏设备常驻显示，键盘聚焦也能唤出。", "Move to the bottom edge to reveal. Always visible on touch devices and accessible by keyboard.")}</p>
      </>}
      {tab === "accessibility" && <>
        <p className="os-setting-intro">{t("按你的节奏使用。", "Move at your own pace.")}</p>
        <div className="os-settings-card"><SettingRow label={t("减少动态效果", "Reduce motion")}><Toggle label={t("减少动态效果", "Reduce motion")} value={reduceMotion} onChange={value => setDesktopPreferences({ reduceMotion: value })} /></SettingRow></div>
        <p className="os-setting-note">{t("关闭窗口过渡、Dock 放大与回弹；始终尊重设备的减少动态设置。", "Disables window transitions and Dock magnification. Your device’s reduced-motion preference is always respected.")}</p>
      </>}
      {tab === "connections" && <>
        <p className="os-setting-intro">{t("沿用你已有的模型与连接配置。", "Manage your existing model and connection settings.")}</p>
        <div className="os-settings-card os-settings-links"><button type="button" onClick={onAiConfig}><SlidersHorizontal size={18} /><span>{t("模型与 AI 配置", "Models & AI configuration")}</span><ArrowUpRight size={16} /></button><button type="button" onClick={onNetwork}><Globe size={18} /><span>{t("网络与代理", "Network & proxy")}</span><ArrowUpRight size={16} /></button></div>
        <p className="os-setting-note">{t("打开现有设置表单；不会自动修改密钥、授权或模型选择。", "Opens the existing forms without changing credentials, permissions or model selection.")}</p>
      </>}
      {persistenceError && <p role="status" className="os-preference-error">{t("本次设置已生效，但浏览器未能保存偏好。", "Applied for this session, but preferences could not be saved.")}</p>}
    </div>
  </div>;
}
