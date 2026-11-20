import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Plugin } from "vite";
import { AGENT_HOST_DEV_ENDPOINT, AGENT_HOST_DEV_TOKEN } from "./agent-host-dev.js";
import { defaultJobAtlasDataDirectory, readJobServiceToken } from "./atlas-dev-index.js";
import { ATLAS_DEV_JOB_INDEX_PATH, ATLAS_OWNER_HEADER, isAtlasOwnerId, PREVIEW_ATLAS_BOOTSTRAP_PATH, PREVIEW_ATLAS_PATH } from "../src/lib/atlas-preview.js";

type Service = { endpoint: string; token: string; close(): Promise<void> };
type Slot = { service: Promise<Service>; users: number; idle?: ReturnType<typeof setTimeout>; draining?: Promise<void> };
const LOCAL_ORIGIN = "http://127.0.0.1:5173";
const MAX_ACTIVE_INDEXES = 3;
const IDLE_MS = 10 * 60_000;
const JOB_PATH = /^\/api\/v1\/(?:atlas|dataset|enrichment|jobs|locations|sources|companies|runs|leads)(?:\/[A-Za-z0-9._~:%-]+)*$/;

async function openOwnerIndex(owner: string): Promise<Service> {
  const root = fileURLToPath(new URL("../../job-service/", import.meta.url));
  const require = createRequire(join(root, "package.json"));
  // Load the source from its original location so the job worker entry points resolve there, not in Vite's bundle.
  const loader = pathToFileURL(require.resolve("tsx/esm/api")).href;
  const { tsImport } = await import(/* @vite-ignore */ loader) as { tsImport(url: string, parent: string): Promise<unknown> };
  const { startLocalJobService } = await tsImport(pathToFileURL(join(root, "src/lifecycle.ts")).href, import.meta.url) as typeof import("../../job-service/src/lifecycle.js");
  const index = await startLocalJobService({
    dataDirectory: join(defaultJobAtlasDataDirectory(), "preview-owners", owner),
    allowedOrigins: [LOCAL_ORIGIN], port: 0, proxy: "auto",
  });
  try {
    const token = await readJobServiceToken(index.dataDirectory);
    if (!token) throw new Error("Missing job index credential");
    return { endpoint: index.url, token, close: index.close };
  } catch (error) {
    await index.close();
    throw error;
  }
}

async function sessionOwner(cookie: string): Promise<string | undefined> {
  const response = await fetch(`${AGENT_HOST_DEV_ENDPOINT}/api/v1/agent/identity/session`, {
    headers: { cookie, authorization: `Bearer ${AGENT_HOST_DEV_TOKEN}`, origin: LOCAL_ORIGIN },
    signal: AbortSignal.timeout(5_000), redirect: "error", cache: "no-store",
  });
  if (!response.ok) throw new Error("Identity service unavailable");
  const { principal } = await response.json() as { principal?: { id?: unknown } | null };
  return isAtlasOwnerId(principal?.id) ? principal.id : undefined;
}

function send(response: ServerResponse, status: number, message: object) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(JSON.stringify(message));
}

function proxyJob(request: IncomingMessage, response: ServerResponse, path: string, service: Service) {
  const headers: Record<string, string> = { authorization: `Bearer ${service.token}` };
  for (const key of ["content-type", "content-length", "idempotency-key", "x-request-id"]) {
    const value = request.headers[key];
    if (typeof value === "string") headers[key] = value;
  }
  const upstream = httpRequest(`${service.endpoint}${path}`, { method: request.method, headers }, (result) => {
    result.on("error", () => response.destroy());
    response.writeHead(result.statusCode ?? 502, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    result.pipe(response);
  });
  upstream.setTimeout(130_000, () => upstream.destroy());
  upstream.on("error", () => response.headersSent ? response.destroy() : send(response, 503, { error: "预览岗位服务暂不可用，请重试。" }));
  response.once("close", () => { if (!response.writableEnded) upstream.destroy(); });
  request.once("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

export function createAtlasPreviewGateway(options: {
  previewHost: string;
  getSessionOwner?: typeof sessionOwner;
  openIndex?: typeof openOwnerIndex;
  idleMs?: number;
}) {
  const origins = new Set([`https://${options.previewHost}`, LOCAL_ORIGIN, "http://localhost:5173"]);
  const hosts = new Set([...origins].map(origin => new URL(origin).host));
  const getSessionOwner = options.getSessionOwner ?? sessionOwner;
  const openIndex = options.openIndex ?? openOwnerIndex;
  const slots = new Map<string, Slot>();
  let closing = false;

  const release = (owner: string, slot: Slot) => {
    if (--slot.users || closing || slots.get(owner) !== slot) return;
    slot.idle = setTimeout(() => {
      slot.draining = slot.service.then(index => index.close()).then(() => {
        if (slots.get(owner) === slot) slots.delete(owner);
      }).catch(() => { delete slot.draining; });
    }, options.idleMs ?? IDLE_MS);
    slot.idle.unref();
  };

  return {
    async handle(request: IncomingMessage, response: ServerResponse, next: () => void) {
      const path = request.url ?? "";
      if (path === ATLAS_DEV_JOB_INDEX_PATH) return send(response, 404, { error: "预览通过登录会话连接岗位服务。" });
      const bootstrap = path === PREVIEW_ATLAS_BOOTSTRAP_PATH;
      if (!bootstrap && !path.startsWith(`${PREVIEW_ATLAS_PATH}/`)) return next();
      const origin = request.headers.origin;
      const method = request.method;
      if (!hosts.has(request.headers.host ?? "") || (origin && !origins.has(origin))
          || request.headers["sec-fetch-site"] === "cross-site" || (method === "POST" && !origin)) {
        return send(response, 403, { error: "当前预览来源不允许访问岗位服务。" });
      }
      if (bootstrap ? method !== "GET" : method !== "GET" && method !== "POST") return send(response, 405, { error: "不支持的岗位请求方法。" });
      const upstreamPath = bootstrap ? "" : path.slice(PREVIEW_ATLAS_PATH.length);
      if (!bootstrap && (!JOB_PATH.test(upstreamPath) || new URL(upstreamPath, LOCAL_ORIGIN).pathname !== upstreamPath)) {
        return send(response, 404, { error: "未找到岗位服务接口。" });
      }
      const expected = request.headers[ATLAS_OWNER_HEADER];
      if (!request.headers.cookie || !isAtlasOwnerId(expected)) return send(response, 401, { error: "请先登录当前 BetterMe 预览。" });
      try {
        const owner = await getSessionOwner(request.headers.cookie);
        if (owner !== expected) return send(response, owner ? 409 : 401, { error: "登录会话已失效或切换，请重新登录。" });
        if (bootstrap) return send(response, 200, { mode: "preview" });
        if (closing || response.destroyed) return send(response, 503, { error: "预览岗位服务正在恢复。" });
        let slot = slots.get(owner);
        if (!slot) {
          if (slots.size >= MAX_ACTIVE_INDEXES) return send(response, 503, { error: "预览岗位服务繁忙，请稍后重试。" });
          const service = openIndex(owner);
          slot = { service, users: 0 };
          slots.set(owner, slot);
          void service.catch(() => { if (slots.get(owner)?.service === service) slots.delete(owner); });
        }
        if (slot.draining) return send(response, 503, { error: "预览岗位服务正在恢复。" });
        clearTimeout(slot.idle);
        slot.users++;
        const lease = slot;
        response.once("close", () => release(owner, lease));
        const service = await slot.service;
        if (!response.destroyed) proxyJob(request, response, upstreamPath, service);
      } catch {
        send(response, 503, { error: "预览岗位服务暂不可用，请重试。" });
      }
    },
    async close() {
      closing = true;
      await Promise.allSettled([...slots.values()].map(async slot => {
        clearTimeout(slot.idle);
        if (slot.draining) await slot.draining;
        else await (await slot.service).close();
      }));
    },
  };
}

export function atlasPreviewPlugin(previewHost: string): Plugin {
  return {
    name: "better-me-atlas-preview",
    apply: (_config, environment) => environment.command === "serve" && !environment.isPreview,
    config: () => ({
      define: { "import.meta.env.VITE_BETTERME_PREVIEW_JOBS": "true" },
      server: { allowedHosts: [previewHost] },
    }),
    configureServer(server) {
      const gateway = createAtlasPreviewGateway({ previewHost });
      server.middlewares.use((request, response, next) => { void gateway.handle(request, response, next).catch(next); });
      server.httpServer?.once("close", () => { void gateway.close(); });
    },
  };
}
