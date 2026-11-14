import { useEffect, useState, type ReactNode } from "react";
import { AgentSettingsPanel } from "../AgentSidebar";
import { Accessibility, ArrowUpRight, ChevronLeft, Globe, Monitor, Palette, Search, SlidersHorizontal } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import { WORKSPACE_THEMES } from "../../themes/workspace-theme";
import { DesktopWallpaperSettings } from "./DesktopWallpaperSettings";
import { ProductMark } from "../ProductMark";

function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="os-setting-row"><span>{label}</span><div>{children}</div></div>;
}
function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (value: boolean) => void }) {
  return <button className="os-switch" type="button" role="switch" aria-label={label} aria-checked={value} onClick={() => onChange(!value)}><span /></button>;
}
export function DesktopSettings({ onAiConfig, onNetwork, request }: { onAiConfig: () => void; onNetwork: () => void; request?: { section: string; id: number } }) {
  const {
    t,
    locale,
    theme,
    setLocale,
    setTheme,
    workspaceThemeId,
    setWorkspaceThemeId,
    dockAutoHide = true,
    menuBarAutoHide = false,
    dockPosition = "bottom",
    dockSize = 48,
    dockMagnification = true,
    dockMagScale = 1.45,
    dockOpacity = 0.85,
    dockBlur = 24,
    reduceMotion = false,
    setDesktopPreferences,
    persistenceError,
  } = useUiPreferences();
  const [tab, setTab] = useState("appearance");
  const [query, setQuery] = useState("");
  const [mobileDetail, setMobileDetail] = useState(false);
  useEffect(() => {
    if (request) { setTab(request.section); setMobileDetail(true); }
  }, [request]);
  const tabs = [
    { id: "appearance", name: t("外观", "Appearance"), icon: Palette },
    { id: "desktop", name: t("桌面与 Dock", "Desktop & Dock"), icon: Monitor },
    { id: "accessibility", name: t("辅助功能", "Accessibility"), icon: Accessibility },
    { id: "connections", name: t("模型与推理", "Models & inference"), icon: SlidersHorizontal },
    { id: "tools", name: t("工具与授权", "Tools & permissions"), icon: Accessibility },
    { id: "research", name: t("联网与外部协作", "Research & handoff"), icon: Globe },
  ];
  const title = tabs.find(item => item.id === tab)!.name;
  return <div className="os-settings" data-detail={mobileDetail}>
    <aside className="os-settings-sidebar">
      <div className="os-settings-identity"><ProductMark size={38} /><div><strong>BetterMe</strong><small>{t("你的职业工作空间", "Your career workspace")}</small></div></div>
      <label className="os-settings-search"><Search size={14} /><input value={query} onChange={e => setQuery(e.target.value)} aria-label={t("搜索设置分类", "Search settings categories")} placeholder={t("搜索分类名称", "Search category names")} /></label>
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
        <h2>Dock</h2>
        <div className="os-settings-card">
          {/* 1. 屏幕上的位置 (Position on screen) */}
          <div className="os-setting-row">
            <div>
              <span style={{ fontWeight: 600 }}>{t("屏幕上的位置", "Position on screen")}</span>
              <small style={{ display: "block", color: "var(--os-muted)", fontSize: 11, marginTop: 2 }}>
                {t("选择 Dock 栏停靠在屏幕的哪个边缘", "Choose which screen edge to pin the Dock")}
              </small>
            </div>
            <div className="os-dock-position-switch" role="radiogroup" aria-label={t("Dock 屏幕位置", "Dock position")}>
              {[
                { id: "left", label: t("左侧", "Left") },
                { id: "bottom", label: t("底部", "Bottom") },
                { id: "right", label: t("右侧", "Right") },
              ].map((pos) => (
                <button
                  key={pos.id}
                  type="button"
                  role="radio"
                  aria-checked={dockPosition === pos.id}
                  tabIndex={dockPosition === pos.id ? 0 : -1}
                  onKeyDown={event => {
                    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
                    event.preventDefault();
                    const positions = ["left", "bottom", "right"] as const;
                    const current = positions.indexOf(dockPosition);
                    const next = event.key === "Home" ? 0 : event.key === "End" ? 2 : (current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? 2 : 1)) % 3;
                    setDesktopPreferences({ dockPosition: positions[next] });
                    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]")[next]?.focus();
                  }}
                  className={`os-dock-pos-btn ${dockPosition === pos.id ? "is-active" : ""}`}
                  onClick={() => setDesktopPreferences({ dockPosition: pos.id as any })}
                >
                  {pos.label}
                </button>
              ))}
            </div>
          </div>

          {/* 2. Dock 大小 (Icon Size) */}
          <div className="os-setting-row">
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{t("大小", "Size")}</span>
                <b style={{ fontVariantNumeric: "tabular-nums", fontSize: 11 }}>{dockSize}px</b>
              </div>
              <small style={{ display: "block", color: "var(--os-muted)", fontSize: 11, marginTop: 2 }}>
                {t("调整 Dock 栏和图标的显示尺寸", "Adjust the icon and Dock size")}
              </small>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180 }}>
              <span style={{ fontSize: 10, color: "var(--os-muted)" }}>{t("小", "Small")}</span>
              <input
                type="range"
                min="36"
                max="68"
                step="2"
                value={dockSize}
                onChange={(e) => setDesktopPreferences({ dockSize: parseInt(e.target.value, 10) })}
                className="os-effect-slider"
                aria-label={t("Dock 大小", "Dock size")} aria-valuetext={`${dockSize} px`}
              />
              <span style={{ fontSize: 10, color: "var(--os-muted)" }}>{t("大", "Large")}</span>
            </div>
          </div>

          {/* 3. 悬浮放大效果 (Magnification) */}
          <SettingRow label={t("放大效果", "Magnification")}>
            <Toggle
              label={t("开启 Dock 悬浮放大", "Enable Dock magnification")}
              value={dockMagnification}
              onChange={(value) => setDesktopPreferences({ dockMagnification: value })}
            />
          </SettingRow>

          {/* 放大倍率微调 */}
          {dockMagnification && (
            <div className="os-setting-row" style={{ paddingLeft: 16, background: "rgba(255, 255, 255, 0.03)" }}>
              <div style={{ flex: 1 }}>
                <span style={{ fontSize: 11.5 }}>{t("放大倍率", "Magnification scale")}</span>
                <small style={{ display: "block", color: "var(--os-muted)", fontSize: 10, marginTop: 1 }}>
                  {t("鼠标悬停在图标上方时的缩放幅度", "Scale factor when pointer hovers over an icon")}
                </small>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 180 }}>
                <input
                  type="range"
                  min="1.1"
                  max="1.8"
                  step="0.05"
                  value={dockMagScale}
                  onChange={(e) => setDesktopPreferences({ dockMagScale: parseFloat(e.target.value) })}
                  className="os-effect-slider"
                  aria-label={t("Dock 放大倍率", "Dock magnification")} aria-valuetext={t(`${dockMagScale} 倍`, `${dockMagScale} times`)}
                />
                <span style={{ fontSize: 11, fontWeight: 700, minWidth: 32, textAlign: "right" }}>
                  {dockMagScale.toFixed(2)}x
                </span>
              </div>
            </div>
          )}

          {/* 4. Dock 不透明度 (Opacity) */}
          <div className="os-setting-row">
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{t("Dock 不透明度", "Dock Opacity")}</span>
                <b style={{ fontVariantNumeric: "tabular-nums", fontSize: 11 }}>{Math.round(dockOpacity * 100)}%</b>
              </div>
              <small style={{ display: "block", color: "var(--os-muted)", fontSize: 11, marginTop: 2 }}>
                {t("调节底座透光度，展现 8K 壁纸与晶莹亚克力质感", "Adjust transparency to reveal the 8K wallpaper")}
              </small>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180 }}>
              <input
                type="range"
                min="0.2"
                max="1.0"
                step="0.05"
                value={dockOpacity}
                onChange={(e) => setDesktopPreferences({ dockOpacity: parseFloat(e.target.value) })}
                className="os-effect-slider"
                aria-label={t("Dock 不透明度", "Dock opacity")} aria-valuetext={`${Math.round(dockOpacity * 100)}%`}
              />
            </div>
          </div>

          {/* Dock 透明度预设挡位 */}
          <div className="os-opacity-presets" role="group" aria-label={t("Dock 透明度预设", "Dock opacity presets")} style={{ padding: "0 15px 12px", marginTop: -4 }}>
            {[
              { val: 1.0, label: t("100% 实体", "100% Solid") },
              { val: 0.85, label: t("85% 毛玻璃", "85% Frosted") },
              { val: 0.65, label: t("65% 晶莹", "65% Crystal") },
              { val: 0.40, label: t("40% 极透", "40% Ghost") },
            ].map((p) => (
              <button
                key={p.val}
                type="button"
                className={`os-opacity-pill ${Math.abs(dockOpacity - p.val) < 0.03 ? "is-selected" : ""}`}
                aria-pressed={Math.abs(dockOpacity - p.val) < 0.03}
                onClick={() => setDesktopPreferences({ dockOpacity: p.val })}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* 5. Dock 毛玻璃景深虚化 (Blur) */}
          <div className="os-setting-row">
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600 }}>{t("Dock 毛玻璃景深虚化", "Dock Glass Blur")}</span>
                <b style={{ fontVariantNumeric: "tabular-nums", fontSize: 11 }}>{dockBlur}px</b>
              </div>
              <small style={{ display: "block", color: "var(--os-muted)", fontSize: 11, marginTop: 2 }}>
                {t("底座后方壁纸的光学弥散半径", "Optical dispersion radius behind the Dock")}
              </small>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 180 }}>
              <input
                type="range"
                min="0"
                max="36"
                step="2"
                value={dockBlur}
                onChange={(e) => setDesktopPreferences({ dockBlur: parseInt(e.target.value, 10) })}
                className="os-effect-slider"
                aria-label={t("Dock 虚化度", "Dock blur")} aria-valuetext={`${dockBlur} px`}
              />
              <span style={{ fontSize: 11, fontWeight: 700, minWidth: 32, textAlign: "right" }}>{dockBlur}px</span>
            </div>
          </div>

          <SettingRow label={t("自动隐藏与显示菜单栏", "Automatically hide menu bar")}>
            <Toggle label={t("自动隐藏菜单栏", "Auto-hide menu bar")} value={menuBarAutoHide} onChange={value => setDesktopPreferences({ menuBarAutoHide: value })} />
          </SettingRow>
          {/* 6. 自动隐藏与显示 Dock */}
          <SettingRow label={t("自动隐藏与显示 Dock", "Automatically hide Dock")}>
            <Toggle
              label={t("自动隐藏 Dock", "Auto-hide Dock")}
              value={dockAutoHide}
              onChange={(value) => setDesktopPreferences({ dockAutoHide: value })}
            />
          </SettingRow>
        </div>
        <p className="os-setting-note">{t("菜单栏隐藏后，鼠标移到顶部或按 F10 唤出；也可右击菜单栏切换。触屏和窄屏保持常显。", "Reveal the hidden menu bar at the top edge or press F10. Right-click it to toggle. It stays visible on touch and narrow screens.")}</p>
        <p className="os-setting-note">
          {dockPosition === "left"
            ? t("鼠标靠近屏幕左边缘时唤出。支持毛玻璃质感、悬浮放大和图标大小任意调节。", "Hover near left screen edge to reveal. Supports acrylic glass, magnification, and sizing.")
            : dockPosition === "right"
            ? t("鼠标靠近屏幕右边缘时唤出。支持毛玻璃质感、悬浮放大和图标大小任意调节。", "Hover near right screen edge to reveal. Supports acrylic glass, magnification, and sizing.")
            : t("鼠标靠近屏幕底部中央时唤出。支持毛玻璃质感、悬浮放大和图标大小任意调节。", "Hover near bottom edge to reveal. Supports acrylic glass, magnification, and sizing.")}
        </p>
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
      <section hidden={tab !== "tools"}><p className="os-setting-intro">{t("所有任务共用一份配置，资料授权仍由你逐项决定。", "Shared configuration, with explicit access to each source.")}</p><AgentSettingsPanel active={tab === "tools"} /></section>
      {tab === "research" && <>
        <p className="os-setting-intro">{t("推理不等于检索，来源与时效需要单独核对。", "Inference is not retrieval. Verify sources and freshness separately.")}</p>
        <div className="os-settings-card">
          <SettingRow label={t("岗位网页读取", "Job page extraction")}><span>{t("使用现有读取服务", "Existing extraction service")}</span></SettingRow>
          <SettingRow label={t("实时搜索 API", "Live search API")}><span>{t("尚未接入", "Not connected")}</span></SettingRow>
          <SettingRow label={t("网页模型协作", "Web model handoff")}><span>{t("手动任务包 · 本人确认", "Manual, reviewed task package")}</span></SettingRow>
        </div>
        <p className="os-setting-note">{t("GPT / Claude / Gemini / DeepSeek 网页账号不等于 API 权限。在顾问工作区预览任务包后手动分享，结果带回后仍需核对。", "Web accounts do not grant API access. Review a task package before sharing and verify returned results.")}</p>
        <div className="os-settings-card os-settings-links"><button type="button" onClick={onNetwork}><Globe size={18} /><span>{t("网络与代理", "Network & proxy")}</span><ArrowUpRight size={16} /></button></div>
      </>}
      {persistenceError && <p role="status" className="os-preference-error">{t("本次设置已生效，但浏览器未能保存偏好。", "Applied for this session, but preferences could not be saved.")}</p>}
    </div>
  </div>;
}
