export type WallpaperFit = "cover" | "contain" | "none";
export interface LocalWallpaper {
  blob: Blob;
  name: string;
  width: number;
  height: number;
  fit: WallpaperFit;
  enabled: boolean;
}
export const WALLPAPER_MAX_BYTES = 50 * 1024 * 1024;
export function validateWallpaperFile(file: Blob) {
  if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(file.type)) throw new Error("请选择 JPG、PNG、WebP 或 AVIF 图片。");
  if (!file.size || file.size > WALLPAPER_MAX_BYTES) throw new Error("图片不能为空，且不能超过 50 MB。");
}
export async function prepareWallpaper(file: File): Promise<LocalWallpaper> {
  validateWallpaperFile(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.src = url;
    try { await image.decode(); } catch { throw new Error("无法解码图片，请选择完整且浏览器支持的图片。"); }
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height || width > 16384 || height > 16384 || width * height > 64000000) throw new Error("图片尺寸过大，请使用不超过 16384 边长、6400 万像素的图片。");
    return { blob: file, name: file.name, width, height, fit: "cover", enabled: true };
  } finally { URL.revokeObjectURL(url); }
}
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("betterme-desktop-wallpaper", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("wallpaper");
    request.onerror = () => reject(new Error("无法打开本地图片存储。请检查浏览器隐私设置。"));
    request.onblocked = () => reject(new Error("图片存储暂被其他标签页占用，请关闭其他页面后重试。"));
    request.onsuccess = () => resolve(request.result);
  });
}
export async function readWallpaper(): Promise<LocalWallpaper | null> {
  const db = await openDatabase();
  try {
    return await new Promise<LocalWallpaper | null>((resolve, reject) => {
      const tx = db.transaction("wallpaper", "readonly");
      const request = tx.objectStore("wallpaper").get("current");
      tx.oncomplete = () => resolve(request.result ?? null);
      tx.onabort = () => reject(new Error("读取本地壁纸失败，请重试。"));
    });
  } finally { db.close(); }
}
export async function writeWallpaper(value: LocalWallpaper | null): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("wallpaper", "readwrite");
      if (value) tx.objectStore("wallpaper").put(value, "current");
      else tx.objectStore("wallpaper").delete("current");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(new Error("保存失败，可能是浏览器空间不足。原壁纸保持不变。"));
    });
  } finally { db.close(); }
}
