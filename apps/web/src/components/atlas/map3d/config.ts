export type SceneSource = { kind: "globe" } | { kind: "google"; apiKey: string } | { kind: "tileset"; url: string; attribution: string };
export type SceneQuality = "economy" | "balanced" | "sharp";
export const SCENE_QUALITY = {
  economy: { label: "流畅", maxDpr: 1, maximumScreenSpaceError: 32, cacheBytes: 64 * 1024 ** 2, maximumCacheOverflowBytes: 32 * 1024 ** 2 },
  balanced: { label: "均衡", maxDpr: 1.5, maximumScreenSpaceError: 16, cacheBytes: 128 * 1024 ** 2, maximumCacheOverflowBytes: 64 * 1024 ** 2 },
  sharp: { label: "精细", maxDpr: 2, maximumScreenSpaceError: 8, cacheBytes: 256 * 1024 ** 2, maximumCacheOverflowBytes: 128 * 1024 ** 2 },
} as const;

/** Validation is deliberately before importing/creating a renderer or requesting a root. */
export function validateSceneSource(source: SceneSource): SceneSource {
  if (source.kind === "globe") return source;
  if (source.kind === "google") {
    const apiKey = source.apiKey.trim();
    if (!apiKey || apiKey.length > 512 || /\s/.test(apiKey)) throw new Error("请输入有效的 Google Map Tiles API Key；未配置时不会请求 Google 或 ion。");
    return { kind: "google", apiKey };
  }
  let url: URL;
  try { url = new URL(source.url); } catch { throw new Error("请输入完整的 3D Tiles tileset.json 地址。"); }
  if (url.username || url.password || url.hash || !(url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("3D Tiles 只允许 HTTPS 或本机 HTTP 地址，不能在地址中嵌入账户密码。");
  }
  if (!source.attribution.trim() || source.attribution.length > 500) throw new Error("请填写该数据源要求的署名，并确认你拥有使用权限。");
  return { kind: "tileset", url: url.toString(), attribution: source.attribution.trim() };
}

export type SceneFailure = { kind: "credentials" | "quota" | "network" | "gpu" | "unknown"; title: string; detail: string };
/** Never display upstream URLs/messages: they may include a key or a session token. */
export function describeSceneFailure(error: unknown): SceneFailure {
  const value = error && typeof error === "object" ? error as { statusCode?: unknown; status?: unknown; message?: unknown } : {};
  const message = typeof value.message === "string" ? value.message : typeof error === "string" ? error : "";
  const status = Number(value.statusCode ?? value.status ?? message.match(/(?:HTTP|status(?:\s*code)?)\s*[:=]?\s*(\d{3})/i)?.[1]);
  if ([400, 401, 403].includes(status)) return { kind: "credentials", title: "地图服务未允许这次请求", detail: "检查 Key、Map Tiles API、账单与应用限制；403 也可能与账户地区条款有关，不能据此判定城市没有覆盖。" };
  if (status === 429) return { kind: "quota", title: "地图配额或请求频率已达上限", detail: "请在供应商控制台检查用量与配额；不会自动重试创建新会话。可继续使用工作地图。" };
  if (/webgl|context.*lost|gpu|rendering.*stopped/i.test(message)) return { kind: "gpu", title: "三维图形环境暂不可用", detail: "请检查浏览器硬件加速，或降低画质后重试。岗位与列表仍然保留。" };
  if (/network|fetch|timeout|timed out|load|connect/i.test(message)) return { kind: "network", title: "三维地图数据未能加载", detail: "检查网络与数据源跨域设置后重试；加载超时不代表该地区没有实景覆盖。" };
  return { kind: "unknown", title: "三维场景暂不可用", detail: "可以重试或返回工作地图；岗位列表和已选岗位不受影响。上游错误已脱敏。" };
}

export function zoomToHeight(zoom: number, latitude = 0): number {
  return Math.max(80, Math.min(24_000_000, 40_075_016 * Math.max(.2, Math.cos(latitude * Math.PI / 180)) / 2 ** Math.max(0, zoom)));
}
export function heightToZoom(height: number, latitude = 0): number {
  return Math.max(0, Math.min(22, Math.log2(40_075_016 * Math.max(.2, Math.cos(latitude * Math.PI / 180)) / Math.max(1, height))));
}
