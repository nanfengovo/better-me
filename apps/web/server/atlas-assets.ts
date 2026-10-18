import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

export const ATLAS_PUBLIC_GEOGRAPHY_FILES = [
  "world-countries-110m.geojson", "china-provinces-10m.geojson", "world-land-dots.geojson",
  "manifest.json", "dots-manifest.json", "NOTICE.md", "NATURAL-EARTH-LICENSE.md",
  "README.md", "RENDERER-NOTES.md", "build-assets.py", "build-dots.py", "requirements-build.txt",
] as const;
const prefix = "legal/geography/";
const directory = fileURLToPath(new URL("../src/components/atlas/geo/", import.meta.url));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const index = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BetterMe · 地图来源与许可</title><style>body{max-width:54rem;margin:3rem auto;padding:0 1.5rem;font:1rem/1.8 system-ui;color:#26352e}a{color:#185a43}code{overflow-wrap:anywhere}</style>
<h1>BetterMe 地图来源与许可</h1><p>Made with Natural Earth。此目录保留固定版本的概略边界、派生装饰点阵、原始许可、来源声明、SHA-256清单与可复现构建脚本。地理轮廓与装饰点不是岗位、公司或家庭地址的事实来源。</p>
<ul>${ATLAS_PUBLIC_GEOGRAPHY_FILES.map((file) => `<li><a href="${file}">${file}</a></li>`).join("")}</ul>
<p>Natural Earth 上游数据为公有领域。国内范围保留当前上游子集，缺少完整南海岛屿及相关线层，不是官方完整标准地图。详见 NOTICE 与 manifest。</p>
<p>在线街道详情由独立配置的地图服务提供，其瓦片、字体和图标不在本目录离线分发。默认服务 <a href="https://openfreemap.org/">OpenFreeMap</a> 需要保留 OpenMapTiles / OpenStreetMap 署名；<a href="https://openfreemap.org/tos/">服务条款</a>另行适用。可选 OpenStreetMap 标准瓦片遵循其<a href="https://operations.osmfoundation.org/policies/tiles/">瓦片使用政策</a>。服务覆盖和岗位位置精度分别记录，放大地图不提升城市估算坐标的证据精度。</p>
<p><a href="https://github.com/nanfengovo/better-me">项目源码与完整文档</a></p></html>\n`;

/** Exact public allowlist; never walks a workspace, private directory or runtime index. */
export async function collectAtlasPublicGeography(): Promise<ReadonlyMap<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>(await Promise.all(ATLAS_PUBLIC_GEOGRAPHY_FILES.map(async (file) => [file, await readFile(new URL(file, new URL("../src/components/atlas/geo/", import.meta.url)))] as const)));
  const manifest = JSON.parse(Buffer.from(files.get("manifest.json")!).toString("utf8"));
  const dots = JSON.parse(Buffer.from(files.get("dots-manifest.json")!).toString("utf8"));
  if (manifest.schemaVersion !== 1 || dots.schemaVersion !== 1 || !Array.isArray(manifest.assets)) throw new Error("Invalid geography distribution manifest.");
  for (const asset of [...manifest.assets, dots]) {
    const bytes = files.get(asset.file);
    if (!bytes || bytes.byteLength !== asset.bytes || sha256(bytes) !== asset.sha256) throw new Error(`Geography distribution hash mismatch: ${asset.file}`);
  }
  if (sha256(files.get("NATURAL-EARTH-LICENSE.md")!) !== manifest.upstream?.sources?.license?.sha256
    || sha256(files.get("build-assets.py")!) !== manifest.build?.scriptSha256
    || sha256(files.get("world-countries-110m.geojson")!) !== dots.sourceSha256) throw new Error("Geography distribution provenance mismatch.");
  files.set("index.html", Buffer.from(index));
  return files;
}

/** Shared build/dev distribution for root-path Docker and Pages subpath builds. */
export function atlasAssetsPlugin(): Plugin {
  return {
    name: "better-me-atlas-public-assets",
    async generateBundle() {
      for (const [filename, source] of await collectAtlasPublicGeography()) this.emitFile({ type: "asset", fileName: `${prefix}${filename}`, source });
    },
    configureServer(server) {
      let cached: Promise<ReadonlyMap<string, Uint8Array>> | undefined;
      server.watcher.add(directory);
      server.watcher.on("change", (file) => { if (file.startsWith(directory)) cached = undefined; });
      server.middlewares.use(async (request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const base = server.config.base.endsWith("/") ? server.config.base : `${server.config.base}/`;
        const route = `${base}${prefix}`;
        if (!pathname.startsWith(route)) return next();
        const filename = pathname.slice(route.length) || "index.html";
        if (!["GET", "HEAD"].includes(request.method ?? "GET")) { response.statusCode = 405; response.end(); return; }
        try {
          cached ??= collectAtlasPublicGeography();
          const bytes = (await cached).get(filename);
          if (!bytes) { response.statusCode = 404; response.end("Not found"); return; }
          response.setHeader("Content-Type", filename.endsWith(".html") ? "text/html; charset=utf-8" : filename.endsWith(".geojson") ? "application/geo+json" : filename.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8");
          response.setHeader("Cache-Control", "no-cache"); response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(request.method === "HEAD" ? undefined : bytes);
        } catch (error) { next(error); }
      });
    },
  };
}
