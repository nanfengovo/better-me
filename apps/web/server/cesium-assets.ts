import { createRequire } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Plugin } from "vite";

const require = createRequire(import.meta.url);
const packageDirectory = path.dirname(require.resolve("cesium/package.json"));
const buildDirectory = path.join(packageDirectory, "Build/Cesium");
const publicDirectories = ["Workers", "Assets", "ThirdParty", "Widgets"] as const;
export function cesiumContentType(file: string) {
  const extension = path.extname(file).toLowerCase();
  return ({ ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".xml": "application/xml" } as Record<string, string>)[extension] ?? "application/octet-stream";
}
export async function collectCesiumAssets() {
  const files = new Map<string, Uint8Array>();
  async function visit(relative: string) {
    for (const entry of await readdir(path.join(buildDirectory, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await visit(name);
      else if (entry.isFile()) files.set(name, await readFile(path.join(buildDirectory, name)));
    }
  }
  await Promise.all(publicDirectories.map(visit));
  for (const file of ["LICENSE.md", "CHANGES.md", "ThirdParty.json", "ThirdParty.extra.json"]) files.set(file, await readFile(path.join(packageDirectory, file)));
  return files;
}
/** Exact SDK-owned static files, identical in dev/build/subpath deployments; not a proxy. */
export function cesiumAssetsPlugin(): Plugin {
  let files: Promise<Map<string, Uint8Array>> | undefined;
  const assets = () => files ??= collectCesiumAssets();
  return {
    name: "better-me-cesium-assets",
    config(config) { return { define: { CESIUM_BASE_URL: JSON.stringify(`${(config.base ?? "/").replace(/\/?$/, "/")}cesium/`) } }; },
    async generateBundle() { for (const [fileName, source] of await assets()) this.emitFile({ type: "asset", fileName: `cesium/${fileName}`, source }); },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const prefix = `${server.config.base.replace(/\/?$/, "/")}cesium/`;
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (!pathname.startsWith(prefix)) return next();
        if (!["GET", "HEAD"].includes(request.method ?? "GET")) { response.statusCode = 405; response.end(); return; }
        let relative: string;
        try { relative = decodeURIComponent(pathname.slice(prefix.length)); } catch { response.statusCode = 400; response.end(); return; }
        try {
          const bytes = (await assets()).get(relative);
          if (!bytes) { response.statusCode = 404; response.end("Not found"); return; }
          response.setHeader("Content-Type", cesiumContentType(relative)); response.setHeader("X-Content-Type-Options", "nosniff");
          response.setHeader("Cache-Control", "no-cache"); response.end(request.method === "HEAD" ? undefined : bytes);
        } catch (error) { next(error); }
      });
    },
  };
}
