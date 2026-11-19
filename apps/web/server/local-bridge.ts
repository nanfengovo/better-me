import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isTrustedLocalRequest } from "./network-proxy";

const TTL = 10 * 60_000;
const MAX_BYTES = 128 * 1024;
const transferRoutes = new Set(["/api/jd/sync-extension", "/api/jd/cookie-bridge"]);

export function isLocalBridgeTransfer(req: IncomingMessage): boolean {
  return (req.method === "POST" || req.method === "OPTIONS") && transferRoutes.has(req.url?.split("?")[0] ?? "");
}

const platforms: Record<string, string> = { boss: "zhipin.com", liepin: "liepin.com", "51job": "51job.com", linkedin: "linkedin.com" };
function platformDomain(value: string): string | undefined {
  return Object.values(platforms).find(domain => value === domain || value.endsWith(`.${domain}`));
}
function invalidCookieName(value: string): boolean {
  return /[\s;=]/.test(value) || [...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}
function parsedOrigin(value: string | undefined): URL | undefined {
  try {
    const url = new URL(value ?? "");
    if (url.username || url.password || url.pathname && url.pathname !== "/" || url.search || url.hash) return;
    if (!["http:", "https:", "chrome-extension:", "moz-extension:"].includes(url.protocol)) return;
    if (value !== `${url.protocol}//${url.host}`) return;
    return url;
  } catch { return; }
}
export function trustedBridgeWorkbench(req: IncomingMessage): boolean {
  // The custom header makes even origin-less GETs non-simple cross-origin requests.
  return req.headers["x-betterme-bridge"] === "1" && isTrustedLocalRequest(req);
}
class BridgeError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function readBridgeJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new BridgeError(415, "仅接受 JSON 请求。");
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    const cleanup = () => { clearTimeout(timer); req.off("data", data); req.off("end", end); req.off("error", error); req.off("aborted", error); };
    const fail = (failure: BridgeError) => { cleanup(); req.resume(); reject(failure); };
    const data = (chunk: Buffer) => { size += chunk.length; if (size > MAX_BYTES) fail(new BridgeError(413, "桥接请求超过 128 KB。")); else chunks.push(Buffer.from(chunk)); };
    const end = () => {
      cleanup();
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolve(value as Record<string, unknown>);
      } catch { reject(new BridgeError(400, "请求必须是 JSON 对象。")); }
    };
    const error = () => fail(new BridgeError(400, "桥接请求中断。"));
    const timer = setTimeout(() => fail(new BridgeError(408, "桥接请求读取超时。")), 5_000);
    req.on("data", data); req.on("end", end); req.on("error", error); req.on("aborted", error);
  });
}
export function bridgeReply(res: ServerResponse, status: number, value: unknown, origin?: string): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Origin",
    ...(origin ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "0" } : {}) });
  res.end(status === 204 ? undefined : JSON.stringify(value));
}
export function bridgeFailure(res: ServerResponse, error: unknown, origin?: string): void {
  bridgeReply(res, error instanceof BridgeError ? error.status : 500,
    { success: false, error: error instanceof BridgeError ? error.message : "本机桥接操作失败，请重新确认授权。" }, origin);
}
type SyncedJob = { title: string; company: string; salary?: string; location?: string; description: string; sourceUrl?: string; syncedAt: number };
type Cookie = { name: string; value: string; domain: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: string; expires?: number; expirationDate?: number };
type Grant = { purpose: "cookies" | "job"; owner: string; origin?: string; expiresAt: number };

/** Ephemeral service-local grants. No token, job or cookie is written to disk. */
export function createLocalBridge(options: {
  injectCookies: (cookies: Cookie[]) => Promise<{ success: boolean; count: number; error?: string }>;
  now?: () => number;
}) {
  const grants = new Map<string, Grant>();
  const jobs = new Map<string, { job: SyncedJob; expiresAt: number }>();
  const now = options.now ?? Date.now;
  const prune = () => { for (const [key, grant] of grants) if (grant.expiresAt <= now()) grants.delete(key); for (const [key, job] of jobs) if (job.expiresAt <= now()) jobs.delete(key); };
  const consume = (token: string | undefined) => {
    if (!token) return;
    const grant = grants.get(token);
    if (!grant || grant.expiresAt <= now()) throw new BridgeError(403, "桥接授权已被使用或过期。");
    grants.delete(token);
  };
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const route = req.url?.split("?")[0];
    if (route !== "/api/jd/bridge-grant" && !transferRoutes.has(route ?? "")) return false;
    prune();
    const trusted = trustedBridgeWorkbench(req);
    const owner = `http://${req.headers.host}`;
    const origin = req.headers.origin;
    const source = parsedOrigin(origin);
    const purpose = route === "/api/jd/cookie-bridge" ? "cookies" : "job";
    // Validate the local socket and Host even for a paired remote sender (DNS rebinding).
    const localTarget = isTrustedLocalRequest({ socket: req.socket, headers: { host: req.headers.host }, method: "GET" } as IncomingMessage);
    const cookieSource = source?.protocol === "https:" && !source.port && platformDomain(source.hostname);
    const permittedSource = !!source && (purpose === "cookies" ? !!cookieSource : [...grants.values()].some(grant => grant.purpose === "job" && grant.origin === origin && grant.owner === owner));
    let cors: string | undefined;
    try {
      if (!localTarget) throw new BridgeError(403, "桥接仅允许访问本机回环地址。");
      if (route === "/api/jd/bridge-grant") {
        if (!trusted) throw new BridgeError(403, "请从本机工作台申请桥接授权。");
        if (req.method !== "POST") throw new BridgeError(405, "请使用 POST 申请授权。");
        const body = await readBridgeJson(req);
        if (body.purpose !== "cookies" && body.purpose !== "job") throw new BridgeError(400, "桥接用途无效。");
        const target = typeof body.origin === "string" ? parsedOrigin(body.origin) : undefined;
        if (body.purpose === "job" && (!target || target.protocol === "http:" && target.hostname !== "localhost" && target.hostname !== "127.0.0.1")) throw new BridgeError(400, "请指定扩展或 HTTPS 同步来源。");
        for (const [key, grant] of grants) if (grant.owner === owner && grant.purpose === body.purpose) grants.delete(key);
        if (grants.size >= 64) throw new BridgeError(429, "桥接授权数量已达上限。");
        const token = randomBytes(32).toString("hex"); const expiresAt = now() + TTL;
        grants.set(token, { purpose: body.purpose, owner, origin: body.purpose === "job" ? body.origin as string : undefined, expiresAt });
        bridgeReply(res, 200, { token, expiresAt, singleUse: true }); return true;
      }
      if (req.method === "OPTIONS") {
        if (!permittedSource || req.headers["access-control-request-method"] !== "POST") throw new BridgeError(403, "来源或桥接方法未获授权。");
        const requested = String(req.headers["access-control-request-headers"] ?? "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
        if (requested.some(value => !["authorization", "content-type"].includes(value))) throw new BridgeError(403, "桥接请求头未获授权。");
        bridgeReply(res, 204, undefined, origin); return true;
      }
      if (req.method === "GET" && purpose === "job") {
        if (!trusted) throw new BridgeError(403, "同步结果仅允许本机工作台读取。");
        bridgeReply(res, 200, { ok: true, latest: jobs.get(owner)?.job ?? null }); return true;
      }
      if (req.method !== "POST") throw new BridgeError(405, "桥接仅支持 POST。");
      let grantToken: string | undefined;
      if (!trusted) {
        const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
        const grant = token ? grants.get(token) : undefined;
        if (!permittedSource || !grant || grant.owner !== owner || grant.purpose !== purpose || purpose === "job" && grant.origin !== origin) throw new BridgeError(403, "桥接授权无效或已过期，请回到工作台重新生成。");
        grantToken = token; cors = origin;
      }
      const body = await readBridgeJson(req);
      if (purpose === "job") {
        if (typeof body.description !== "string" || body.description.length > 100_000) throw new BridgeError(400, "请提供有效岗位正文。");
        const text = (key: string, limit: number) => { const value = body[key]; if (value === undefined) return undefined; if (typeof value !== "string" || value.length > limit) throw new BridgeError(400, "岗位字段格式无效。"); return value.trim(); };
        const sourceUrl = text("sourceUrl", 2048);
        if (sourceUrl) { try { if (!/^https?:$/.test(new URL(sourceUrl).protocol)) throw new Error(); } catch { throw new BridgeError(400, "岗位来源链接无效。"); } }
        const job: SyncedJob = { title: text("title", 300) || "目标职位", company: text("company", 300) || "目标企业", salary: text("salary", 300), location: text("location", 500), description: body.description.trim(), sourceUrl, syncedAt: now() };
        if (!jobs.has(owner) && jobs.size >= 64) throw new BridgeError(429, "同步槽位数量已达上限。");
        consume(grantToken);
        jobs.set(owner, { job, expiresAt: now() + TTL }); bridgeReply(res, 200, { ok: true }, cors);
      } else {
        let raw = body.cookies;
        if (typeof raw === "string") raw = raw.split(";").filter(value => value.trim()).map(value => { const i = value.indexOf("="); if (i < 1) throw new BridgeError(400, "Cookie 字符串格式无效。"); return { name: value.slice(0, i).trim(), value: value.slice(i + 1).trim() }; });
        if (!Array.isArray(raw) || !raw.length || raw.length > 256) throw new BridgeError(400, "请提供有效 Cookie 列表（最多 256 项）。");
        const selected = typeof body.platform === "string" ? platforms[body.platform] ?? platformDomain(body.platform) : undefined;
        const cookies: Cookie[] = raw.map(item => {
          if (!item || typeof item !== "object" || typeof item.name !== "string" || typeof item.value !== "string" || item.name.length > 256 || !item.name || invalidCookieName(item.name) || item.value.length > 16_384) throw new BridgeError(400, "Cookie 字段格式无效。");
          const fallback = selected ?? (item.name === "li_at" ? "linkedin.com" : item.name === "lt_token" || item.name === "user_id" ? "liepin.com" : "zhipin.com");
          const domain = typeof item.domain === "string" ? item.domain.replace(/^\./, "").toLowerCase() : fallback;
          if (!platformDomain(domain) || selected && platformDomain(domain) !== selected || !trusted && (!source || source.hostname !== domain && !source.hostname.endsWith(`.${domain}`))) throw new BridgeError(400, "Cookie 域名与授权招聘网站不匹配。");
          // Never honor remote CDP ports, URLs or unknown object fields.
          return { name: item.name, value: item.value, domain: `.${domain}`, path: typeof item.path === "string" ? item.path : "/", secure: item.secure === true, httpOnly: item.httpOnly === true,
            sameSite: typeof item.sameSite === "string" ? item.sameSite : undefined, expires: typeof item.expires === "number" && Number.isFinite(item.expires) ? item.expires : undefined,
            expirationDate: typeof item.expirationDate === "number" && Number.isFinite(item.expirationDate) ? item.expirationDate : undefined };
        });
        consume(grantToken);
        const result = await options.injectCookies(cookies);
        bridgeReply(res, result.success ? 200 : 400, { success: result.success, count: result.count, ...(result.success ? {} : { error: "Cookie 同步未完成，请检查独立浏览器后重新授权。" }) }, cors);
      }
    } catch (error) { bridgeFailure(res, error, cors); }
    return true;
  };
}
