import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { jdExtractorPlugin } from "./server/jd-extractor";
import { opportunitySourcesPlugin } from "./server/opportunity-sources";
import { networkProxyPlugin } from "./server/network-proxy";
import { atlasAssetsPlugin } from "./server/atlas-assets";
import { atlasDevIndexPlugin } from "./server/atlas-dev-index";
import { agentHostDevPlugin } from "./server/agent-host-dev";
import { cesiumAssetsPlugin } from "./server/cesium-assets";

const isWin = process.platform === "win32";
const appDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss(), atlasAssetsPlugin(), cesiumAssetsPlugin(), agentHostDevPlugin(), atlasDevIndexPlugin(), networkProxyPlugin(), jdExtractorPlugin({ useNativeLiepin: isWin, useNativeBoss: isWin, useNative51Job: isWin }), opportunitySourcesPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(appDir, "./src"),
    },
  },
  server: {
    port: 5173,
    allowedHosts: [".vercel.run"],
    // The browser talks to this same-origin dev proxy. Normalize its upstream Origin so
    // preview hostnames do not need to be copied into the local Agent Host allowlist.
    proxy: { "/api/v1/agent": {
      target: "http://127.0.0.1:5179",
      changeOrigin: false,
      configure(proxy) {
        proxy.on("proxyReq", (request) => request.setHeader("Origin", "http://127.0.0.1:5173"));
        proxy.on("proxyRes", (response, request) => {
          if (!request.headers.origin?.startsWith("https://")) return;
          const cookies = response.headers["set-cookie"];
          if (!cookies) return;
          response.headers["set-cookie"] = cookies.map(cookie =>
            `${cookie.replace(/; SameSite=Strict/i, "; SameSite=None")}${/; Secure/i.test(cookie) ? "" : "; Secure"}`,
          );
        });
      },
    } },
    watch: {
      // Saving a test must not reload the workbench and end a live browser session.
      ignored: ["**/tests/**", "**/.agent-memory/.tmp/**"],
    },
    fs: {
      allow: [path.resolve(appDir, "../..")],
    },
  },
});
