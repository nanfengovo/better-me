/** The same-origin gateway owns backend credentials; browser requests never receive them. */
export const DEFAULT_ATLAS_BACKEND_ENDPOINT = "/api/atlas";

export class AtlasClientError extends Error {
  constructor(public readonly code: "invalid-endpoint" | "missing-token" | "http-error" | "too-large" | "invalid-response", message: string) {
    super(message);
    this.name = "AtlasClientError";
  }
}

export function isDefaultAtlasEndpoint(endpoint: string): boolean {
  return endpoint === DEFAULT_ATLAS_BACKEND_ENDPOINT;
}

export function resolveAtlasServiceTarget(endpoint: string, token: string): { apiRoot: URL; headers: Record<string, string> } {
  if (isDefaultAtlasEndpoint(endpoint)) {
    if (token !== "") throw new AtlasClientError("invalid-endpoint", "默认后端由宿主管理连接，请清除浏览器中的访问令牌。");
    let origin: URL;
    try { origin = new URL(window.location.origin); } catch { throw new AtlasClientError("invalid-endpoint", "当前网页没有可用的同源后端地址。"); }
    if (!["http:", "https:"].includes(origin.protocol)) throw new AtlasClientError("invalid-endpoint", "当前网页没有可用的同源后端地址。");
    return { apiRoot: new URL(`${DEFAULT_ATLAS_BACKEND_ENDPOINT}/api/v1/`, origin), headers: {} };
  }
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new AtlasClientError("invalid-endpoint", "请输入有效的本机服务地址。"); }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || !["http:", "https:"].includes(url.protocol) || url.username || url.password
      || url.search || url.hash || url.pathname !== "/") {
    throw new AtlasClientError("invalid-endpoint", "请输入本机 loopback 服务地址，例如 http://127.0.0.1:5178。");
  }
  if (!token.trim() || token.length > 4096 || /[\r\n\0]/.test(token)) throw new AtlasClientError("missing-token", "请填写本机服务的有效访问令牌。");
  return { apiRoot: new URL("/api/v1/", url), headers: { Authorization: `Bearer ${token.trim()}` } };
}

/** Form controls may enable a request only after its connection shape is valid. */
export function hasAtlasServiceTarget(endpoint: string, token: string): boolean {
  try { resolveAtlasServiceTarget(endpoint, token); return true; } catch { return false; }
}
