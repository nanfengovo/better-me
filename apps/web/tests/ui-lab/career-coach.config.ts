import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// A separate origin and no production Vite plugins: never starts 5178/5179 or reads user data.
export default defineConfig({
  root: fileURLToPath(new URL("../../", import.meta.url)),
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [{ name: "career-coach-isolated-qa", configureServer(server) {
    server.middlewares.use((_request, response, next) => {
      response.setHeader("Content-Security-Policy", "connect-src 'self'; object-src 'none'; base-uri 'self'"); next();
    });
  } }, react(), tailwindcss()],
  cacheDir: fileURLToPath(new URL("../../../../output/career-coach-lab-cache", import.meta.url)),
  server: { host: "127.0.0.1", port: 5192, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] } },
});
