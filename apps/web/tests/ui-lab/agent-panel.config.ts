import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Layout only: independent origin, no proxy, real Host or model startup.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [{ name: "isolated-panel-only", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      response.setHeader("Content-Security-Policy", "connect-src 'self'; object-src 'none'; base-uri 'self'");
      if (!request.url?.startsWith("/api/") && !request.url?.startsWith("/__better-me/")) return next();
      response.statusCode = 503; response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ error: "synthetic-layout-only" }));
    });
  } }, react(), tailwindcss()],
  resolve: { dedupe: ["react", "react-dom"] },
  optimizeDeps: { entries: ["tests/ui-lab/desktop-boundaries.html"] },
  cacheDir: fileURLToPath(new URL("../../../../output/agent-panel-vite-cache", import.meta.url)),
  server: { host: "127.0.0.1", port: 5297, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } },
});
