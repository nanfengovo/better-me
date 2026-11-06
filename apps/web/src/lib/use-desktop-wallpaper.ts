import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { readWallpaper, writeWallpaper, type LocalWallpaper } from "./desktop-wallpaper";

export function useDesktopWallpaper() {
  const { data, error, isLoading, mutate } = useSWR("desktop-wallpaper-local-v1", readWallpaper, { shouldRetryOnError: false });
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState("");
  const locked = useRef(false);
  const blob = data?.blob;
  useEffect(() => {
    if (!blob) { setUrl(""); return; }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  async function change(create: () => Promise<LocalWallpaper | null>, after?: () => void) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setActionError("");
    try {
      const next = await create();
      await writeWallpaper(next);
      await mutate(next, { revalidate: false });
      after?.();
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : "壁纸保存失败，请重试。"); }
    finally { locked.current = false; setBusy(false); }
  }
  return { data, url, busy, isLoading, error: actionError || (error ? "无法读取本地壁纸，请检查浏览器存储权限。" : ""), change };
}
