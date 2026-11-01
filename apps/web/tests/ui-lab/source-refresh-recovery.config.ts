import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createAtlasDemo } from "../../src/components/atlas/demo";

// In-memory HTTP fixture only: no production bootstrap, database or credentials.
const data = createAtlasDemo();
data.sources[0] = { ...data.sources[0]!, enabled: true, status: "active", capabilities: ["list-jobs"], entryUrl: "https://example.invalid/jobs",
  remoteFilters: ["roles"], name: "合成刷新测试源", attribution: { label: "合成刷新测试源", usage: "metadata", requiresAttribution: true } };
data.jobs[0]!.title.value = "C# 合成刷新回归岗位";
let synced = false, refreshReads = 0, writes = 0;
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../../../output/source-refresh-cache", import.meta.url)),
  plugins: [react(), tailwindcss(), { name: "isolated-source-refresh", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      response.setHeader("Content-Security-Policy", "connect-src 'self'; object-src 'none'; base-uri 'self'");
      const path = new URL(request.url ?? "/", "http://127.0.0.1:5196").pathname;
      const reply = (value: unknown, status = 200) => {
        response.statusCode = status; response.setHeader("content-type", "application/json");
        response.setHeader("cache-control", "no-store"); response.end(JSON.stringify({ ok: true, requestId: "synthetic-refresh", value }));
      };
      if (path === "/__source-refresh/state") { reply({ writes, refreshReads }); return; }
      if (!path.startsWith("/api/") && !path.startsWith("/__better-me/")) return next();
      if (path === "/api/v1/enrichment/status") { reply({ revision: 1, pending: 0, running: 0, completed: 0, failed: 0 }); return; }
      if (path === "/api/v1/dataset/export") {
        if (synced && ++refreshReads === 1) { reply({}, 503); return; }
        reply({ ...data, revision: synced ? 2 : 1 }); return;
      }
      if (path === "/api/v1/sources/atlas-demo/sync" && request.method === "POST") {
        writes++; synced = true;
        reply({ run: { runId: "synthetic-refresh-run", sourceId: "atlas-demo", actorScope: "synthetic-only", generation: 1,
          scope: {}, status: "completed", startedAt: "2026-11-01T00:00:00.000Z", summary: { records: 1, added: 0 } },
          localFilters: { roles: ["C#"], regions: [], companyNames: [] }, warnings: [] }); return;
      }
      // Unsupported paging falls back to this fixture's legacy export. All
      // collection/AI/resume/other mutation routes fail closed, never proxy.
      reply({}, 404);
    });
  } }],
  server: { host: "127.0.0.1", port: 5196, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } },
});
