import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import fixtureConfig from "./vite.config";

/** Production assets, the same synthetic API, and a separate origin from the dev lab. */
function previewApi(plugin: Plugin): Plugin {
  if (plugin.name !== "atlas-synthetic-ui-lab-only") return plugin;
  const install = plugin.configureServer;
  if (typeof install !== "function") throw new Error("Synthetic fixture API hook is missing.");
  return { ...plugin,
    configurePreviewServer(server) {
      // The fixture hook uses only these shared server surfaces: httpServer and
      // middlewares. It never accesses dev transforms, HMR or the module graph.
      return install.call(this, server as unknown as ViteDevServer);
    },
  };
}

function buildAudit(): Plugin {
  return { name: "atlas-ui-lab-production-audit",
    configResolved(config) {
      if (config.command === "build" && (!config.isProduction || config.mode !== "production")) {
        throw new Error("UI production lab requires a real production build.");
      }
    },
    generateBundle() {
      const packageRuntime = new URL("../../../../packages/opportunities/dist/index.js", import.meta.url);
      this.emitFile({ type: "asset", fileName: "__ui-lab-build.json", source: JSON.stringify({
        kind: "atlas-ui-lab-production", builtAt: new Date().toISOString(), mode: "production",
        jsxRuntime: "production", syntheticDataOnly: true,
        opportunitiesRuntimeSha256: createHash("sha256").update(readFileSync(packageRuntime)).digest("hex"),
        workspacePackagesRebuilt: false,
      }, null, 2) });
    },
  };
}

export default defineConfig({
  ...fixtureConfig,
  mode: "production",
  plugins: [...(fixtureConfig.plugins as Plugin[]).map(previewApi), buildAudit()],
  build: {
    outDir: fileURLToPath(new URL("../../../../output/atlas-ui-lab-production/", import.meta.url)),
    emptyOutDir: false,
    manifest: true,
    sourcemap: "hidden",
    rollupOptions: { input: fileURLToPath(new URL("./index.html", import.meta.url)) },
  },
  preview: { host: "127.0.0.1", port: 5190, strictPort: true },
});
