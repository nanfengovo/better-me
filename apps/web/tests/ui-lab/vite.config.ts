import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cesiumAssetsPlugin } from "../../server/cesium-assets";
import { syntheticTiles3d } from "./tiles3d-fixture";
import { advanceLab, createLabState, LAB_STREAM_MAX_BATCHES, syncLab, type LabScenario, type LabState } from "./data";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const sessions = new Map<string, LabState>();
const scenarios = new Set<LabScenario>(["ready", "empty", "unlocated", "attention", "loading"]);
const synthetic3d = syntheticTiles3d();
function labApi(): Plugin {
  return { name: "atlas-synthetic-ui-lab-only", configureServer(server) {
    server.httpServer?.once("close", () => { for (const state of sessions.values()) clearInterval(state.timer); sessions.clear(); });
    server.middlewares.use(async (request, response, next) => {
      // The real application and its Workers cannot reach the user's 5178/5179 services.
      response.setHeader("Content-Security-Policy", "connect-src 'self' https://tiles.openfreemap.org https://tile.openstreetmap.org; object-src 'none'; base-uri 'self'");
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!path.startsWith("/api/") && !path.startsWith("/__better-me/") && !path.startsWith("/__atlas-ui-lab/")) return next();
      const json = (value: unknown, status = 200) => { response.statusCode = status;
        response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store"); response.end(JSON.stringify(value)); };
      const envelope = (value: unknown) => json({ ok: true, requestId: "synthetic-ui-lab", value });
      try {
        if (request.method === "GET" && path === "/__atlas-ui-lab/3d-fixture/tileset.json") { json(synthetic3d.tileset); return; }
        if (request.method === "GET" && path === "/__atlas-ui-lab/3d-fixture/box.glb") { response.setHeader("content-type", "model/gltf-binary"); response.end(synthetic3d.bytes); return; }
        if (request.method === "GET" && path === "/__atlas-ui-lab/3d-fixture/quota.json") { json({error:"synthetic quota response"},429); return; }
        let raw = "";
        for await (const chunk of request) { raw += chunk.toString(); if (raw.length > 4096) { json({ error: "lab-input-too-large" }, 413); return; } }
        const body = raw ? JSON.parse(raw) : {};
        if (path === "/__atlas-ui-lab/session" && request.method === "POST") {
          const size = body.size === 15000 ? 15000 : 5000;
          const scenario = scenarios.has(body.scenario) ? body.scenario as LabScenario : "ready";
          const token = `ui-lab-${randomBytes(12).toString("hex")}`;
          sessions.set(token, createLabState(size, scenario, randomBytes(16).toString("hex")));
          // Never evict an open scenario just because another browser page starts.
          // Pages release their own session on non-bfcache pagehide; server close
          // releases the remaining test data. This is a local, short-lived QA server.
          json({ token, size, scenario }); return;
        }
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const state = token && sessions.get(token);
        if (!state) { json({ error: "isolated-ui-lab-session-required",
          reason: token ? "unknown-session" : "missing-authorization", activeSessions: sessions.size }, 401); return; }
        if (path === "/__atlas-ui-lab/close" && request.method === "POST") {
          clearInterval(state.timer); sessions.delete(token!); json({ closed: true }); return;
        }
        if (path === "/__atlas-ui-lab/control" && request.method === "POST") {
          if (body.action === "start") {
            clearInterval(state.timer); state.streaming = true; advanceLab(state);
            state.timer = setInterval(() => advanceLab(state), 2000);
          } else if (body.action === "stop") { state.streaming = false; clearInterval(state.timer); }
          else if (body.action === "attention") state.scenario = "attention";
          else if (body.action === "ready") state.scenario = "ready";
          else { json({ error: "unknown-lab-control" }, 400); return; }
          envelope({ revision: state.data.revision, jobs: state.data.jobs.length, batches: state.batches, streaming: state.streaming, scenario: state.scenario }); return;
        }
        if (path === "/__atlas-ui-lab/state") { envelope({ revision: state.data.revision, jobs: state.data.jobs.length,
          baselineSize: state.baselineSize, batches: state.batches, streaming: state.streaming, scenario: state.scenario,
          streamBudget: { maxBatches: LAB_STREAM_MAX_BATCHES, jobsPerBatch: 10, intervalMs: 2000 } }); return; }
        if (path === "/api/v1/dataset/sync") {
          if (state.scenario === "loading") await new Promise(resolve => setTimeout(resolve, 5000));
          envelope(syncLab(state, body.cursor)); return;
        }
        if (path === "/api/v1/dataset/export") { envelope(state.data); return; }
        if (path === "/api/v1/enrichment/status") {
          envelope({ revision: state.data.revision, pending: state.streaming ? 20 : 0, running: state.streaming ? 2 : 0,
            completed: state.batches * 10, failed: state.scenario === "attention" ? 3 : 0,
            workerState: state.scenario === "attention" ? "error" : state.streaming ? "running" : "idle",
            ...(state.scenario === "attention" ? { workerError: "UI 验收模拟：后台连接暂不可用" } : {}) }); return;
        }
        if (path === "/api/v1/locations/map-references") {
          const selected = state.data.locations.slice(0, Math.min(1000, body.limit ?? 1000));
          envelope({ schemaVersion: 1, snapshotRevision: body.expectedRevision, providerId: "synthetic-ui-lab", places: [], references: [],
            unresolved: selected.map(location => ({ locationId: location.id, reason: location.coordinates ? "existing-coordinate" : "no-exact-match" })),
            totalLocations: state.data.locations.length, processedLocations: selected.length, truncated: selected.length < state.data.locations.length,
            warnings: ["UI 验收合成样本：不推测办公位置"] }); return;
        }
        if (path === "/api/v1/sources") { envelope({ sources: state.data.sources, adapters: [] }); return; }
        // No fallback proxy: source collection, AI, authentication and user data writes fail closed.
        json({ ok: false, requestId: "synthetic-ui-lab", error: { code: "forbidden", message: "隔离 UI 验收页禁用真实采集、AI 和数据写入。" } }, 403);
      } catch (error) { json({ error: error instanceof Error ? error.message : "lab-error" }, 500); }
    });
  } };
}

export default defineConfig({ root: webRoot, plugins: [labApi(), react(), tailwindcss(), cesiumAssetsPlugin()],
  cacheDir: fileURLToPath(new URL("../../../../output/atlas-ui-lab-cache/", import.meta.url)),
  resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
  server: { host: "127.0.0.1", port: 5186, strictPort: true, hmr: false, fs: { allow: [repositoryRoot] } },
});
