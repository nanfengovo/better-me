import { useRef, useState } from "react";
import {
  ImagePlus,
  Loader2,
  Trash2,
  Check,
  Sliders,
  RotateCcw,
} from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import { prepareWallpaper, type WallpaperFit } from "../../lib/desktop-wallpaper";
import { useDesktopWallpaper } from "../../lib/use-desktop-wallpaper";
import {
  PRESET_WALLPAPERS,
  WALLPAPER_CATEGORIES,
  type WallpaperCategoryId,
  type PresetWallpaperItem,
} from "../../lib/preset-wallpapers";
import { VorkStudioCard } from "./VorkStudioCard";

export function DesktopWallpaperSettings() {
  const {
    t,
    locale,
    wallpaper = "aurora",
    wallpaperOpacity = 1,
    wallpaperBlur = 0,
    windowOpacity = 0.92,
    windowBlur = 24,
    menuOpacity = 0.90,
    setDesktopPreferences,
  } = useUiPreferences();
  const { data, url, busy, isLoading, error, change } = useDesktopWallpaper();
  const input = useRef<HTMLInputElement>(null);
  const [activeCategory, setActiveCategory] = useState<WallpaperCategoryId>("all");

  const highResolution =
    data &&
    Math.max(data.width, data.height) >= 7680 &&
    Math.min(data.width, data.height) >= 4320;

  // Filter wallpapers by category
  const filteredWallpapers =
    activeCategory === "all"
      ? PRESET_WALLPAPERS
      : PRESET_WALLPAPERS.filter((item) => item.category === activeCategory);

  // Check if a wallpaper item is currently active
  const isWallpaperActive = (item: PresetWallpaperItem) => {
    if (data?.enabled) return false;
    if (item.url === "aurora" && (!wallpaper || wallpaper === "aurora")) return true;
    if (item.url === "midnight" && wallpaper === "midnight") return true;
    if (item.url === "warm" && wallpaper === "warm") return true;
    return wallpaper === item.url || wallpaper === item.id;
  };

  const handleSelectPreset = (item: PresetWallpaperItem) => {
    if (data?.enabled) {
      void change(
        async () => ({ ...data, enabled: false }),
        () => setDesktopPreferences({ wallpaper: item.url })
      );
    } else {
      setDesktopPreferences({ wallpaper: item.url });
    }
  };

  const handleResetEffects = () => {
    setDesktopPreferences({ wallpaperOpacity: 1, wallpaperBlur: 0 });
  };

  const handleResetWindowMenuEffects = () => {
    setDesktopPreferences({ windowOpacity: 0.92, windowBlur: 24, menuOpacity: 0.90 });
  };

  return (
    <div className="os-wallpaper-settings">
      <fieldset disabled={busy || isLoading} className="os-wallpaper-controls">
        {/* ====================================================================
            1. 分类切换标签栏 (Category Selector)
           ==================================================================== */}
        <div className="os-wallpaper-cat-bar" role="tablist" aria-label="壁纸分类">
          {WALLPAPER_CATEGORIES.map((cat) => {
            const count =
              cat.id === "all"
                ? PRESET_WALLPAPERS.length
                : PRESET_WALLPAPERS.filter((w) => w.category === cat.id).length;
            return (
              <button
                key={cat.id}
                type="button"
                role="tab"
                aria-selected={activeCategory === cat.id}
                className={`os-wallpaper-cat-btn ${activeCategory === cat.id ? "active" : ""}`}
                onClick={() => setActiveCategory(cat.id)}
              >
                <span>{cat.name[locale]}</span>
                <span className="os-cat-count">{count}</span>
              </button>
            );
          })}
        </div>

        {/* ====================================================================
            1.5 vork 3D 物理光追渲染工坊 (voyager-so/vork Metal GPU Raytracer)
           ==================================================================== */}
        {(activeCategory === "vork" || activeCategory === "all") && (
          <VorkStudioCard />
        )}

        {/* ====================================================================
            2. 8K 超高清精选壁纸卡片瀑布网格 (8K Preset Grid)
           ==================================================================== */}
        <div className="os-wallpaper-grid" role="group" aria-label={t("预设壁纸", "Built-in wallpapers")}>
          {filteredWallpapers.map((item) => {
            const active = isWallpaperActive(item);
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                className={`os-wallpaper-card ${active ? "is-active" : ""}`}
                onClick={() => handleSelectPreset(item)}
              >
                <div className="os-wallpaper-card-media">
                  {item.category === "classic" ? (
                    <span className={`os-wallpaper-thumb ${item.id}`} />
                  ) : (
                    <img
                      src={item.thumb}
                      alt={item.title[locale]}
                      loading="lazy"
                      className="os-wallpaper-card-img"
                    />
                  )}
                  {item.badge && <span className="os-wallpaper-badge">{item.badge}</span>}
                  {active && (
                    <div className="os-wallpaper-active-pill">
                      <Check size={11} strokeWidth={3} />
                      <span>{t("使用中", "Active")}</span>
                    </div>
                  )}
                </div>
                <div className="os-wallpaper-card-meta">
                  <strong className="os-wallpaper-card-title">{item.title[locale]}</strong>
                  <small className="os-wallpaper-card-desc">{item.subtitle[locale]}</small>
                </div>
              </button>
            );
          })}
        </div>

        {/* ====================================================================
            3. 壁纸透明度与质感精调 (Opacity & Glass Blur Controls)
           ==================================================================== */}
        <div className="os-wallpaper-effects-card">
          <div className="os-effects-header">
            <div className="os-effects-title">
              <Sliders size={14} />
              <strong>{t("壁纸质感与透明度调节", "Wallpaper Opacity & Glass Density")}</strong>
            </div>
            {(wallpaperOpacity !== 1 || wallpaperBlur !== 0) && (
              <button
                type="button"
                className="os-effects-reset"
                onClick={handleResetEffects}
                title="重置透明度与模糊度为默认"
              >
                <RotateCcw size={12} />
                <span>{t("恢复默认", "Reset")}</span>
              </button>
            )}
          </div>

          {/* 透明度 (Opacity) 滑块 */}
          <div className="os-effect-row">
            <div className="os-effect-label">
              <span>{t("壁纸不透明度 (透明度)", "Wallpaper Opacity")}</span>
              <small>{t("调低可让深空暗曜底色透出，降低视觉干扰", "Lower opacity reveals deep obsidian canvas")}</small>
            </div>
            <div className="os-effect-control">
              <input
                type="range"
                min="0.1"
                max="1.0"
                step="0.05"
                value={wallpaperOpacity}
                onChange={(e) => setDesktopPreferences({ wallpaperOpacity: parseFloat(e.target.value) })}
                className="os-effect-slider"
                aria-label="壁纸不透明度"
              />
              <span className="os-effect-val">{Math.round(wallpaperOpacity * 100)}%</span>
            </div>
          </div>

          {/* 快捷挡位选择 */}
          <div className="os-opacity-presets">
            {[
              { val: 1.0, label: t("100% 明晰", "100% Vivid") },
              { val: 0.85, label: t("85% 柔和", "85% Soft") },
              { val: 0.65, label: t("65% 半透", "65% Medium") },
              { val: 0.45, label: t("45% 幽邃", "45% Deep") },
              { val: 0.25, label: t("25% 极简", "25% Minimal") },
            ].map((p) => (
              <button
                key={p.val}
                type="button"
                aria-pressed={Math.abs(wallpaperOpacity - p.val) < 0.03}
                className={`os-opacity-pill ${Math.abs(wallpaperOpacity - p.val) < 0.03 ? "is-selected" : ""}`}
                onClick={() => setDesktopPreferences({ wallpaperOpacity: p.val })}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* 磨砂景深虚化 (Blur) 滑块 */}
          <div className="os-effect-row" style={{ marginTop: 12 }}>
            <div className="os-effect-label">
              <span>{t("背景磨砂虚化 (景深)", "Depth Blur")}</span>
              <small>{t("为超高清壁纸注入景深柔焦，文字更易阅读", "Soft optical blur to keep windows readable")}</small>
            </div>
            <div className="os-effect-control">
              <input
                type="range"
                min="0"
                max="24"
                step="2"
                value={wallpaperBlur}
                onChange={(e) => setDesktopPreferences({ wallpaperBlur: parseInt(e.target.value, 10) })}
                className="os-effect-slider"
                aria-label="背景磨砂虚化"
              />
              <span className="os-effect-val">{wallpaperBlur}px</span>
            </div>
          </div>
        </div>

        {/* ====================================================================
            3.5 窗口与菜单毛玻璃质感调节 (Window & Menu Acrylic Glass Controls)
           ==================================================================== */}
        <div className="os-wallpaper-effects-card">
          <div className="os-effects-header">
            <div className="os-effects-title">
              <Sliders size={14} />
              <strong>{t("窗口与菜单毛玻璃质感", "Window & Menu Glass Density")}</strong>
            </div>
            {(windowOpacity !== 0.92 || windowBlur !== 24 || menuOpacity !== 0.90) && (
              <button
                type="button"
                className="os-effects-reset"
                onClick={handleResetWindowMenuEffects}
                title="恢复窗口与菜单默认质感"
              >
                <RotateCcw size={12} />
                <span>{t("恢复默认", "Reset")}</span>
              </button>
            )}
          </div>

          {/* 全局窗口不透明度 (Window Opacity) */}
          <div className="os-effect-row">
            <div className="os-effect-label">
              <span>{t("全局窗口不透明度 (透明度)", "Global Window Opacity")}</span>
              <small>{t("可让底层 8K 壁纸若隐若现透出，通透灵动", "Allows 8K wallpaper to glow through all windows")}</small>
            </div>
            <div className="os-effect-control">
              <input
                type="range"
                min="0.30"
                max="1.0"
                step="0.05"
                value={windowOpacity}
                onChange={(e) => setDesktopPreferences({ windowOpacity: parseFloat(e.target.value) })}
                className="os-effect-slider"
                aria-label="全局窗口不透明度"
              />
              <span className="os-effect-val">{Math.round(windowOpacity * 100)}%</span>
            </div>
          </div>

          {/* 窗口快捷挡位选择 */}
          <div className="os-opacity-presets">
            {[
              { val: 1.0, label: t("100% 实体", "100% Solid") },
              { val: 0.90, label: t("90% 毛玻璃", "90% Glass") },
              { val: 0.80, label: t("80% 通透", "80% Translucent") },
              { val: 0.65, label: t("65% 晶莹", "65% Crystal") },
              { val: 0.50, label: t("50% 极透", "50% Ghost") },
            ].map((p) => (
              <button
                key={p.val}
                type="button"
                aria-pressed={Math.abs(windowOpacity - p.val) < 0.03}
                className={`os-opacity-pill ${Math.abs(windowOpacity - p.val) < 0.03 ? "is-selected" : ""}`}
                onClick={() => setDesktopPreferences({ windowOpacity: p.val })}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* 窗口毛玻璃景深柔焦 (Window Blur) */}
          <div className="os-effect-row" style={{ marginTop: 12 }}>
            <div className="os-effect-label">
              <span>{t("窗口毛玻璃景深虚化", "Window Glass Blur")}</span>
              <small>{t("调节底层壁纸在窗口后方的弥散半径", "Adjust dispersion radius behind windows")}</small>
            </div>
            <div className="os-effect-control">
              <input
                type="range"
                min="0"
                max="36"
                step="2"
                value={windowBlur}
                onChange={(e) => setDesktopPreferences({ windowBlur: parseInt(e.target.value, 10) })}
                className="os-effect-slider"
                aria-label="窗口毛玻璃虚化"
              />
              <span className="os-effect-val">{windowBlur}px</span>
            </div>
          </div>

          {/* 菜单与顶栏透明度 (Menu Opacity) */}
          <div className="os-effect-row" style={{ marginTop: 12 }}>
            <div className="os-effect-label">
              <span>{t("顶栏菜单与快捷菜单透明度", "Menubar & Menu Opacity")}</span>
              <small>{t("控制顶栏状态栏及所有下拉菜单的亚克力质感", "Acrylic transparency for top menubar and popup menus")}</small>
            </div>
            <div className="os-effect-control">
              <input
                type="range"
                min="0.40"
                max="1.0"
                step="0.05"
                value={menuOpacity}
                onChange={(e) => setDesktopPreferences({ menuOpacity: parseFloat(e.target.value) })}
                className="os-effect-slider"
                aria-label="顶栏与菜单透明度"
              />
              <span className="os-effect-val">{Math.round(menuOpacity * 100)}%</span>
            </div>
          </div>

          {/* 菜单快捷挡位 */}
          <div className="os-opacity-presets">
            {[
              { val: 1.0, label: t("100% 实体", "100% Solid") },
              { val: 0.90, label: t("90% 磨砂", "90% Frosted") },
              { val: 0.75, label: t("75% 通透", "75% Glass") },
              { val: 0.55, label: t("55% 极透", "55% Minimal") },
            ].map((p) => (
              <button
                key={p.val}
                type="button"
                aria-pressed={Math.abs(menuOpacity - p.val) < 0.03}
                className={`os-opacity-pill ${Math.abs(menuOpacity - p.val) < 0.03 ? "is-selected" : ""}`}
                onClick={() => setDesktopPreferences({ menuOpacity: p.val })}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* ====================================================================
            4. 自定义本地图片上传 (Local 8K Upload)
           ==================================================================== */}
        <div className="os-local-wallpaper">
          {data && url && (
            <button
              className="os-local-wallpaper-preview"
              type="button"
              aria-pressed={data.enabled}
              aria-label="使用这张本地壁纸"
              onClick={() => void change(async () => ({ ...data, enabled: true }))}
            >
              <img src={url} alt="已选择的本地壁纸预览" />
              <span>{data.enabled ? "正在使用" : "点击使用"}</span>
            </button>
          )}
          <div className="os-local-wallpaper-info">
            <strong>{data ? data.name : t("你的桌面，你的风景", "Your Desktop, Your View")}</strong>
            <span>
              {data
                ? `${data.width.toLocaleString()} × ${data.height.toLocaleString()} · ${(
                    data.blob.size /
                    1024 /
                    1024
                  ).toFixed(1)} MB${highResolution ? " · 8K 原图" : ""}`
                : t(
                    "支持 8K 原图 · 零损无压 · 本地私密直读",
                    "Supports 8K RAW · Zero compression · Local direct read"
                  )}
            </span>
            <div className="os-local-wallpaper-actions">
              <button type="button" onClick={() => input.current?.click()}>
                {busy ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
                {busy ? t("正在处理…", "Processing...") : data ? t("替换图片", "Replace") : t("选择本地图片", "Choose local image")}
              </button>
              {data && (
                <button
                  type="button"
                  aria-label="移除本地壁纸并恢复预设"
                  onClick={() => void change(async () => null)}
                >
                  <Trash2 size={15} />
                  {t("移除", "Remove")}
                </button>
              )}
            </div>
          </div>
          <input
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif"
            aria-label="选择本地壁纸图片"
            hidden
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file) void change(() => prepareWallpaper(file));
            }}
          />
        </div>

        {data && (
          <label className="os-wallpaper-fit">
            <span>{t("显示方式", "Display mode")}</span>
            <select
              value={data.fit}
              onChange={(event) => {
                const fit = event.target.value as WallpaperFit;
                void change(async () => ({ ...data, fit }));
              }}
            >
              <option value="cover">{t("铺满屏幕（裁切边缘）", "Fill screen (cover)")}</option>
              <option value="contain">{t("完整显示（保留留白）", "Fit screen (contain)")}</option>
              <option value="none">{t("原始尺寸（居中）", "Center original")}</option>
            </select>
          </label>
        )}
      </fieldset>

      <p className="os-setting-note">
        {t(
          "全库精选 8K/4K 超高清壁纸，涵盖自然雪山、深空星云、极简流体与赛博工业等高热度题材；支持透明度与磨砂景深实时调节。全量支持 Web 端与 macOS 桌面端同步渲染。",
          "Curated 8K/4K wallpapers across Nature, Space, Minimalist & Cyberpunk. Real-time opacity & blur controls synchronized across Web and Desktop."
        )}
      </p>
      <p className="os-setting-note" role="status">
        {busy ? t("正在解码并保存原图，请稍候。", "Decoding image...") : isLoading ? t("正在读取本地壁纸…", "Reading wallpaper...") : ""}
      </p>
      {error && <p role="alert" className="os-preference-error">{error}</p>}
    </div>
  );
}
