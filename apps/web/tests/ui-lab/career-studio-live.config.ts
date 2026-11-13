import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cesiumAssetsPlugin } from "../../server/cesium-assets";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
/** Full application on a separate origin. No auto-start of production Host,
 * Casdoor, Job Service, browser profile or real account/document storage. */
export default defineConfig({
  root: webRoot, plugins: [react(), tailwindcss(), cesiumAssetsPlugin()],
  resolve: { alias: { "@": path.join(webRoot, "src") }, dedupe: ["react", "react-dom"] },
  cacheDir: path.join(webRoot, "../../output/career-studio-vite-cache"),
  server: { host: "127.0.0.1", port: 5273, strictPort: true, hmr: false,
    fs: { allow: [path.resolve(webRoot, "../..")] },
    proxy: { "/api/v1/agent": { target: "http://127.0.0.1:5279", changeOrigin: false,
      configure(proxy) { proxy.on("proxyReq", request => request.setHeader("Origin", "http://127.0.0.1:5273")); },
    } },
  },
});
