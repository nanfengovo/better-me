import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { MemorySaver } from "../../../agent-host/tests/fixtures/checkpointer";
import { createAgentServer } from "../../../agent-host/src/server";
import type { LearningTranslationEngine } from "../../../agent-host/src/growth/learning-translations";

const token = "synthetic_growth_only_" + "x".repeat(43);
const root = fileURLToPath(new URL("../../", import.meta.url));

function isolatedGrowthLoop(origin: string, clock?: () => number, advanceWeek?: () => number,
  translationEngine?: LearningTranslationEngine, qaState?: () => Record<string, number>): Plugin {
  return { name: "isolated-growth-loop-real-http",
    transformIndexHtml(html) { return html.replace("<head>", `<head><script>window.__BETTER_ME_RUNTIME__=${JSON.stringify({ mode: "docker", origin, agentToken: token, jobToken: token })}</script>`); },
    async configureServer(vite) {
      const directory = await mkdtemp(path.join(os.tmpdir(), "betterme-growth-browser-"));
      const paths: string[] = [];
      let restarts = 0;
      let host = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [origin], runtimeDefinitions: [],
        identityDirectory: path.join(directory, "identity"), runsDirectory: path.join(directory, "runs"),
        understandingDirectory: path.join(directory, "understanding"), learningClock: clock, learningTranslationEngine: translationEngine, checkpointer: new MemorySaver() as never });
      await once(host, "listening"); let address = host.address(); if (!address || typeof address === "string") throw new Error("Growth QA host failed");
      const closeHost = () => new Promise<void>((resolve, reject) => { host.close(error => error ? reject(error) : resolve()); host.closeIdleConnections(); });
      const restartHost = async () => {
        await closeHost();
        host = createAgentServer({ host: "127.0.0.1", port: 0, authToken: token, allowedOrigins: [origin], runtimeDefinitions: [],
          identityDirectory: path.join(directory, "identity"), runsDirectory: path.join(directory, "runs"),
          understandingDirectory: path.join(directory, "understanding"), learningClock: clock, learningTranslationEngine: translationEngine, checkpointer: new MemorySaver() as never });
        await once(host, "listening"); address = host.address(); if (!address || typeof address === "string") throw new Error("Growth QA host restart failed"); restarts++;
      };
      vite.httpServer?.once("close", () => { void closeHost().finally(() => rm(directory, { recursive: true, force: true })); });
      vite.middlewares.use((request, response, next) => {
        response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
        const pathname = new URL(request.url ?? "/", origin).pathname;
        if (pathname === "/__growth-loop-qa/advance-week" && advanceWeek && request.method === "POST") {
          response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ controlledTime: new Date(advanceWeek()).toISOString(), syntheticOnly: true })); return;
        }
        if (pathname === "/__growth-loop-qa/state") { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ directory, paths, restarts, externalModelCalls: 0, ...qaState?.() })); return; }
        if (pathname === "/__growth-loop-qa/restart-host") {
          if (request.method !== "POST") { response.statusCode = 405; response.end(); return; }
          void restartHost().then(() => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ directory, restarts })); }, error => {
            response.statusCode = 500; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ error: String(error) }));
          }); return;
        }
        if (!pathname.startsWith("/api/")) return next();
        paths.push(`${request.method} ${pathname}`);
        const allowed = pathname.startsWith("/api/v1/agent/identity/") || pathname.startsWith("/api/v1/agent/growth/")
          || pathname === "/api/v1/agent/tasks" && request.method === "GET";
        if (!allowed) { response.statusCode = 404; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ error: "fixture_route_denied" })); return; }
        const proxy = http.request({ hostname: "127.0.0.1", port: address.port, path: request.url, method: request.method,
          headers: { ...request.headers, host: `127.0.0.1:${address.port}` } }, upstream => { response.writeHead(upstream.statusCode ?? 502, upstream.headers); upstream.pipe(response); });
        proxy.on("error", () => { response.statusCode = 502; response.end(); }); request.pipe(proxy);
      });
    },
  };
}

export function growthLoopLab({ port = 5316, entry = "tests/ui-lab/growth-loop-live.html", clock, advanceWeek, translationEngine, qaState }: {
  port?: number; entry?: string; clock?: () => number; advanceWeek?: () => number;
  translationEngine?: LearningTranslationEngine; qaState?: () => Record<string, number>;
} = {}) {
  return defineConfig({ root, plugins: [react(), tailwindcss(), isolatedGrowthLoop(`http://127.0.0.1:${port}`, clock, advanceWeek, translationEngine, qaState)], resolve: { dedupe: ["react", "react-dom"] },
    optimizeDeps: { entries: [entry] }, cacheDir: fileURLToPath(new URL(`../../../../output/growth-lab-${port}-cache`, import.meta.url)),
    server: { host: "127.0.0.1", port, strictPort: true, hmr: false,
      fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } } });
}
export default growthLoopLab();
