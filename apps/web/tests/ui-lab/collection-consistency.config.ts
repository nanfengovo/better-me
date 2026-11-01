import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createJobApplication } from "../../../job-service/src/application";
import { createJobHttpServer } from "../../../job-service/src/http";
import { openJobRepository } from "../../../job-service/src/repository";
import { createAtlasDemo } from "../../src/components/atlas/demo";
import { cesiumAssetsPlugin } from "../../server/cesium-assets";

// Deliberately independent of the production Vite config, dev bootstrap,
// browser profiles, service token files and the user's job-service directory.
const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const origin = "http://127.0.0.1:5197";
function isolatedApi(): Plugin {
  let shutdown: (() => Promise<void>) | undefined;
  return { name: "collection-consistency-temporary-sqlite", async closeBundle() { await shutdown?.(); }, async configureServer(server) {
    const directory = await mkdtemp(join(tmpdir(), "betterme-collection-consistency-"));
    const token = randomBytes(32).toString("hex");
    const repository = openJobRepository(join(directory, "jobs.sqlite"));
    const seed = createAtlasDemo();
    seed.jobs[0]!.title.value = "C# 历史合成岗位";
    seed.jobs[1]!.title.value = "WPF 历史合成岗位";
    seed.jobs[1]!.locationIds = [...seed.jobs[0]!.locationIds];
    seed.sources = seed.sources.map(source => ({ ...source, enabled: false, status: "disabled" as const }));
    await repository.importSnapshot(seed, { actorScope: "local-owner", idempotencyKey: "synthetic-seed" });
    const application = createJobApplication({ repository, transport: { async request() {
      throw new Error("Network collection is forbidden in this isolated fixture");
    } } });
    const http = createJobHttpServer({ registry: application.registry, token, allowedOrigins: [origin], port: 0 });
    const { url } = await http.listen();
    let closing: Promise<void> | undefined;
    shutdown = () => closing ??= (async () => {
      await application.shutdown(); await http.close(); repository.close();
      await rm(directory, { recursive: true, force: true });
    })();
    server.httpServer?.once("close", () => { void shutdown?.(); });
    server.middlewares.use(async (request, response, next) => {
      response.setHeader("Content-Security-Policy", "connect-src 'self' https://tiles.openfreemap.org https://tile.openstreetmap.org; object-src 'none'; base-uri 'self'");
      const path = new URL(request.url ?? "/", origin).pathname;
      const json = (value: unknown, status = 200) => {
        response.statusCode = status; response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "no-store"); response.end(JSON.stringify(value));
      };
      if (path === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
      if (path === "/api/jd/real-chrome" && request.method === "GET") {
        json({ running: false, port: 0, binaryFound: false, message: "隔离验收不接管任何真实浏览器" }); return;
      }
      if (path === "/__collection-consistency/session" && request.method === "POST") {
        json({ token, seedJobs: seed.jobs.length }); return;
      }
      if (path === "/__collection-consistency/close" && request.method === "POST") {
        if (request.headers.authorization !== `Bearer ${token}`) { json({ error: "fixture-session-required" }, 401); return; }
        response.once("finish", () => { void server.close(); });
        json({ closing: true }); return;
      }
      if (!path.startsWith("/api/") && !path.startsWith("/__better-me/")) return next();
      // The browser fixture supplies only /api/jd/search-session SSE events.
      // All other collection, AI, resume and index mutation routes fail closed.
      const permitted = /^\/api\/v1\/(?:dataset\/(?:export|sync|sync-page|baseline|baseline\/close)|enrichment\/status|sources|locations\/map-references|jobs\/(?:search|reviewed-cards\/(?:preview|import)|[^/]+))$/u.test(path);
      if (!permitted || (path === "/api/v1/sources" && request.method !== "GET")) {
        json({ error: "isolated-fixture-route-forbidden" }, 403); return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) { json({ error: "fixture-session-required" }, 401); return; }
      try {
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString();
          if (body.length > 2 * 1024 * 1024) { json({ error: "fixture-input-too-large" }, 413); return; }
        }
        const upstream = await fetch(`${url}${request.url}`, { method: request.method, headers: {
          authorization: `Bearer ${token}`, origin, "content-type": "application/json",
          ...(request.headers["idempotency-key"] ? { "idempotency-key": String(request.headers["idempotency-key"]) } : {}),
        }, ...(body ? { body } : {}) });
        response.statusCode = upstream.status;
        response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
        response.end(await upstream.text());
      } catch (error) { json({ error: error instanceof Error ? error.message : "fixture-proxy-failure" }, 500); }
    });
  } };
}

export default defineConfig({ root: webRoot, plugins: [isolatedApi(), react(), tailwindcss(), cesiumAssetsPlugin()],
  cacheDir: fileURLToPath(new URL("../../../../output/collection-consistency-cache/", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5197, strictPort: true, hmr: false, fs: { allow: [repositoryRoot] } },
});
