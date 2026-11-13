import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Separate origin, no proxy, account, Host, document database or model.
export default defineConfig({ root: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [react(), tailwindcss(), { name: "speech-qa-no-real-services", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      response.setHeader("Content-Security-Policy", "connect-src 'self'; object-src 'none'; base-uri 'self'");
      if (!request.url?.startsWith("/api/") && !request.url?.startsWith("/__better-me/")) return next();
      response.statusCode = 403; response.end("synthetic-speech-only");
    });
  } }], resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: fileURLToPath(new URL("../../../../output/local-speech-vite-cache", import.meta.url)),
  optimizeDeps: { entries: ["tests/ui-lab/local-speech.html"] },
  server: { host: "127.0.0.1", port: 5326, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } } });
