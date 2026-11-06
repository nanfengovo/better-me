import { useRef } from "react";
import { ImagePlus, Loader2, Trash2 } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import { prepareWallpaper, type WallpaperFit } from "../../lib/desktop-wallpaper";
import { useDesktopWallpaper } from "../../lib/use-desktop-wallpaper";

export function DesktopWallpaperSettings() {
  const { t, wallpaper = "aurora", setDesktopPreferences } = useUiPreferences();
  const { data, url, busy, isLoading, error, change } = useDesktopWallpaper();
  const input = useRef<HTMLInputElement>(null);
  const highResolution = data && Math.max(data.width, data.height) >= 7680 && Math.min(data.width, data.height) >= 4320;
  return <div className="os-wallpaper-settings">
    <fieldset disabled={busy || isLoading} className="os-wallpaper-controls">
      <div className="os-wallpapers" role="group" aria-label={t("预设壁纸", "Built-in wallpapers")}>
        {(["aurora", "midnight", "warm"] as const).map((value, i) => <button key={value} type="button" aria-pressed={!data?.enabled && wallpaper === value} onClick={() => { if (!data) setDesktopPreferences({ wallpaper: value }); else void change(async () => ({ ...data, enabled: false }), () => setDesktopPreferences({ wallpaper: value })); }}><span className={`os-wallpaper-thumb ${value}`} /><span>{[t("流光", "Aurora"), t("暮色", "Midnight"), t("暖沙", "Warm sand")][i]}</span></button>)}
      </div>
      <div className="os-local-wallpaper">
        {data && url && <button className="os-local-wallpaper-preview" type="button" aria-pressed={data.enabled} aria-label="使用这张本地壁纸" onClick={() => void change(async () => ({ ...data, enabled: true }))}><img src={url} alt="已选择的本地壁纸预览" /><span>{data.enabled ? "正在使用" : "点击使用"}</span></button>}
        <div className="os-local-wallpaper-info">
          <strong>{data ? data.name : "你的桌面，你的风景"}</strong>
          <span>{data ? `${data.width.toLocaleString()} × ${data.height.toLocaleString()} · ${(data.blob.size / 1024 / 1024).toFixed(1)} MB${highResolution ? " · 8K 尺寸" : ""}` : "支持 8K 原图 · 不压缩、不上传"}</span>
          <div className="os-local-wallpaper-actions">
            <button type="button" onClick={() => input.current?.click()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}{busy ? "正在处理…" : data ? "替换图片" : "选择本地图片"}</button>
            {data && <button type="button" aria-label="移除本地壁纸并恢复预设" onClick={() => void change(async () => null)}><Trash2 size={15} />移除</button>}
          </div>
        </div>
        <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/avif" aria-label="选择本地壁纸图片" hidden onChange={event => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void change(() => prepareWallpaper(file)); }} />
      </div>
      {data && <label className="os-wallpaper-fit"><span>显示方式</span><select value={data.fit} onChange={event => { const fit = event.target.value as WallpaperFit; void change(async () => ({ ...data, fit })); }}><option value="cover">铺满屏幕（裁切边缘）</option><option value="contain">完整显示（保留留白）</option><option value="none">原始尺寸（居中）</option></select></label>}
    </fieldset>
    <p className="os-setting-note">JPG、PNG、WebP、AVIF，最大 50 MB。保留原图细节，清晰度取决于图片和屏幕；低清图片不会自动变成 8K。仅保存在当前浏览器，清除站点数据后需重新选择。</p>
    <p className="os-setting-note" role="status">{busy ? "正在解码并保存原图，请稍候。" : isLoading ? "正在读取本地壁纸…" : ""}</p>
    {error && <p role="alert" className="os-preference-error">{error}</p>}
  </div>;
}
