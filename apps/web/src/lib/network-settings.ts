export type NetworkSettings = { mode: "auto" | "direct" | "manual"; proxyUrl: string; bypass: string; domesticProxyUrl?: string };
export type NetworkRoute = { mode: NetworkSettings["mode"]; source: string; proxyUrl?: string };
export type NetworkProxyCandidate = { url: string; source: string; reachable: boolean };
export type NetworkDetectionResult = { candidates: NetworkProxyCandidate[]; warnings: string[]; autoRoute: NetworkRoute };
export type NetworkTestTarget = "51job" | "boss" | "liepin" | "linkedin" | "greenhouse" | "lever" | "tencent";
export type NetworkTestResult = { ok: boolean; status?: number; message: string; route: NetworkRoute; elapsedMs: number };

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = { mode: "auto", proxyUrl: "", bypass: "localhost,127.0.0.1,::1" };

export function normalizeProxyUrl(value: string): string {
  if (value.length > 2048) throw new Error("代理地址过长。");
  if (/[?#]/.test(value)) throw new Error("代理地址不能包含查询参数或片段。");
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("请填写完整代理地址，例如 http://127.0.0.1:7890。"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("当前支持 HTTP / HTTPS 代理；暂不支持 SOCKS 或 PAC 地址。");
  if (url.username || url.password) throw new Error("当前不支持带用户名或密码的代理，请使用不含认证信息的本机代理地址。");
  if (url.search || url.hash || (url.pathname && url.pathname !== "/")) throw new Error("代理地址只应包含协议、主机与端口，不能包含路径、查询参数或片段。");
  if (!url.hostname) throw new Error("代理地址缺少主机。");
  return `${url.protocol}//${url.host}`;
}

export function validateNetworkSettings(value: unknown): NetworkSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("网络配置格式无效。");
  const input = value as Record<string, unknown>;
  if (input.mode !== "auto" && input.mode !== "direct" && input.mode !== "manual") throw new Error("请选择自动检测、直接连接或手动代理。");
  if (typeof input.proxyUrl !== "string" || typeof input.bypass !== "string") throw new Error("代理地址与绕过规则必须为文字。");
  if (input.domesticProxyUrl !== undefined && typeof input.domesticProxyUrl !== "string") throw new Error("国内招聘平台独立代理地址必须为文字。");
  // Inactive drafts are cleared so an invalid manual address cannot block selecting direct/auto.
  const proxyUrl = input.mode === "manual" && input.proxyUrl.trim() ? normalizeProxyUrl(input.proxyUrl) : "";
  if (input.mode === "manual" && !proxyUrl) throw new Error("手动代理模式需要填写代理地址。");
  let domesticProxyUrl: string | undefined;
  try { domesticProxyUrl = typeof input.domesticProxyUrl === "string" && input.domesticProxyUrl.trim() ? normalizeProxyUrl(input.domesticProxyUrl) : undefined; }
  catch (cause) { throw new Error(`国内招聘平台独立代理：${cause instanceof Error ? cause.message : "地址无效。"}`, { cause }); }
  if (input.bypass.length > 2048) throw new Error("绕过代理规则过长，请限制在 2048 字符以内。");
  const bypass = input.bypass.split(/[,;]/).map((item) => item.trim()).filter(Boolean);
  if (bypass.some((item) => /[\s/@\\?#]/.test(item))) throw new Error("绕过规则应填写主机或域名，用逗号分隔，例如 localhost,127.0.0.1,*.example.com。");
  return { mode: input.mode, proxyUrl, bypass: bypass.join(","), ...(domesticProxyUrl ? { domesticProxyUrl } : {}) };
}

async function networkApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api/network/${path}`, { ...init, credentials: "same-origin", cache: "no-store" }); }
  catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error("无法连接本机网络设置服务，请确认应用本地服务正在运行。", { cause: error });
  }
  let result: any;
  try { result = await response.json(); } catch { throw new Error("本机网络设置服务不可用；纯静态页面需要启动配套本地服务。"); }
  if (!response.ok) throw new Error(typeof result?.error === "string" ? result.error : "网络设置操作失败。");
  return result as T;
}

export async function getNetworkSettings(signal?: AbortSignal): Promise<NetworkSettings> {
  const result = await networkApi<{ settings: unknown }>("settings", { signal });
  return validateNetworkSettings(result.settings);
}

export async function saveNetworkSettings(settings: NetworkSettings, signal?: AbortSignal): Promise<NetworkSettings> {
  const result = await networkApi<{ settings: unknown }>("settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: validateNetworkSettings(settings) }), signal,
  });
  return validateNetworkSettings(result.settings);
}

export function detectNetworkProxies(signal?: AbortSignal): Promise<NetworkDetectionResult> {
  return networkApi("detect", { signal });
}

export function testNetworkConnection(settings: NetworkSettings, target: NetworkTestTarget, signal?: AbortSignal): Promise<NetworkTestResult> {
  return networkApi("test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ settings: validateNetworkSettings(settings), target }), signal });
}
