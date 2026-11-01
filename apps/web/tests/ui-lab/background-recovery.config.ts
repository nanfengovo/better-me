import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// No production plugins, service bootstrap, database, browser or credentials.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../../../../output/background-recovery-cache", import.meta.url)),
  plugins: [react(), { name: "synthetic-background-recovery", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      response.setHeader("Content-Security-Policy", "connect-src 'self'; object-src 'none'; base-uri 'self'");
      if (!request.url?.startsWith("/api/")) return next();
      response.setHeader("content-type", "application/json");
      response.setHeader("cache-control", "no-store");
      if (request.url === "/api/v1/enrichment/status") response.end(JSON.stringify({ ok: true, requestId: "synthetic",
        value: { revision: 11, pending: 1, running: 0, completed: 0, failed: 0 } }));
      else { response.statusCode = 503; response.end(JSON.stringify({ ok: false })); }
    });
  } }],
  server: { host: "127.0.0.1", port: 5198, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } },
});
