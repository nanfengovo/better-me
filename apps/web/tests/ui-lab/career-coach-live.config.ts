import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig, type UserConfig } from "vite";
import baseConfig from "../../vite.config";

// Full application, real model transport, separate browser origin. Attach the
// same owned/reused local services as the normal dev entry without importing
// the user's document into this origin or replacing an unknown service.
export default defineConfig(mergeConfig(baseConfig as UserConfig, {
  root: fileURLToPath(new URL("../../", import.meta.url)),
  resolve: { dedupe: ["react", "react-dom"] },
  cacheDir: fileURLToPath(new URL("../../../../output/career-coach-live-cache", import.meta.url)),
  server: {
    host: "127.0.0.1", port: 5193, strictPort: true, hmr: false,
    fs: { allow: [fileURLToPath(new URL("../../../../", import.meta.url))] },
  },
}));
