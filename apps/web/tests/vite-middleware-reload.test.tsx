import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, get } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { isRuntimeBuildFile, startDevServer } from "../dev-server.mjs";

const viteCliPath = path.join(path.dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js");

function readBody(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve(body));
    });
    request.on("error", reject);
    request.setTimeout(500, () => request.destroy(new Error("fixture HTTP timeout")));
  });
}

async function waitForBody(url: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let actual = "";
  while (Date.now() < deadline) {
    actual = await readBody(url).catch(() => "not-listening");
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(actual, expected);
}

test("only compiled runtime files trigger a process restart", () => {
  for (const file of ["dist/index.js", "dist/platform-search-regions.json", "dist/nested/module.mjs", "dist\\index.cjs"]) {
    assert.equal(isRuntimeBuildFile(file), true);
  }
  for (const file of ["src/index.ts", "tests/test.js", "dist/index.js.map", "dist/index.d.ts", "README.md"]) {
    assert.equal(isRuntimeBuildFile(file), false);
  }
});

// The middleware is bundled with Vite's config, while workspace package imports
// are external Node modules. Rebuilding them must not silently keep old exports.
test("development middleware reloads changed workspace package exports", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "betterme-vite-reload-"));
  const webDirectory = path.join(directory, "web");
  const packageDirectory = path.join(directory, "packages", "core");
  const configPath = path.join(webDirectory, "vite.config.mjs");
  const packageFile = path.join(packageDirectory, "dist", "index.mjs");
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as AddressInfo).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  let service: ReturnType<typeof startDevServer> | undefined;
  let spawns = 0;
  let running = 0;
  let maxRunning = 0;
  let output = "";
  try {
    await mkdir(path.join(webDirectory, "node_modules"), { recursive: true });
    await mkdir(path.join(packageDirectory, "dist"), { recursive: true });
    await writeFile(path.join(packageDirectory, "package.json"), JSON.stringify({ name: "fixture-package", type: "module", exports: "./dist/index.mjs" }));
    await symlink(packageDirectory, path.join(webDirectory, "node_modules", "fixture-package"), process.platform === "win32" ? "junction" : "dir");
    await writeFile(packageFile, 'export const generation = "before";\n');
    await writeFile(configPath, `import { generation } from "fixture-package";
export default { server: { hmr: false }, plugins: [{ name: "fixture", configureServer(server) {
  server.middlewares.use((req, res) => { res.end(generation); });
} }] };\n`);
    service = startDevServer({
      cwd: webDirectory, workspaceDirectory: directory, viteCliPath,
      args: ["--host", "127.0.0.1", "--port", String(port), "--strictPort"],
      stdio: ["ignore", "pipe", "pipe"], debounceMs: 100, log: () => {},
      onSpawn(child) {
        spawns += 1;
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        child.once("exit", () => { running -= 1; });
        child.stdout?.on("data", (chunk) => { output += chunk.toString(); });
        child.stderr?.on("data", (chunk) => { output += chunk.toString(); });
      },
    });
    const url = `http://127.0.0.1:${port}/generation`;
    await waitForBody(url, "before");
    await writeFile(packageFile, 'export const generation = "after";\n');
    await waitForBody(url, "after");
    assert.equal(spawns, 2, output);
    assert.equal(maxRunning, 1, "the old process must exit before a replacement is launched");
    await writeFile(packageFile, 'export const generation = "after";\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(spawns, 2, "duplicate filesystem events and byte-identical rebuilds do not restart Vite again");
    await writeFile(path.join(packageDirectory, "dist", "index.d.ts"), "export const generation: string;\n");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(spawns, 2, "declaration-only builds do not restart Vite");
  } finally {
    await service?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
