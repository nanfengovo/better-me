import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const desktop = path.join(root, "apps/desktop");
const require = createRequire(path.join(desktop, "package.json"));
const { build, Platform, Arch } = require("electron-builder");
const pkg = JSON.parse(await readFile(path.join(desktop, "package.json"), "utf8"));
const rootPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (pkg.version !== rootPkg.version) throw new Error("Desktop and repository versions differ.");
const args = process.argv.slice(2).filter(arg => arg !== "--");
if (args.some(arg => !["--dir", "--x64", "--arm64"].includes(arg))) throw new Error("Usage: pnpm desktop:dist [--dir] [--x64|--arm64]; build on each target OS.");
const arch = args.includes("--x64") ? "x64" : args.includes("--arm64") ? "arm64" : process.arch;
if (arch !== process.arch) throw new Error("Use a native runner for each architecture; cross-built native dependencies are not release-validated.");
if (!["darwin", "win32", "linux"].includes(process.platform)) throw new Error("Unsupported desktop platform.");
for (const file of ["dist/main/index.cjs", "dist/preload/index.cjs", "dist/runtime/server.mjs", "dist/runtime/application-runtime-worker.js", "resources/icon.png"]) await stat(path.join(desktop, file));
await stat(path.join(root, "apps/web/dist/index.html"));
const stage = await mkdtemp(path.join(tmpdir(), "betterme-distribution-"));
const appDir = path.join(stage, "app"), runtime = path.join(stage, "runtime");
try {
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this script using pnpm desktop:dist.");
function command(executable, argv) {
  const result = spawnSync(executable, argv, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Distribution step failed (${result.status}).`);
}
// An isolated production dependency tree; no credentials, developer profile,
// .env, source checkout or real career data is added to the application.
command(process.execPath, [pnpm, "--filter", "@better-me/desktop", "deploy", "--prod", "--legacy", appDir]);
// pnpm 11 legacy deploy records its production-only settings in the source
// workspace state. Restore the existing frozen development tree offline so the
// next command does not try to purge/reinstall it as a production workspace.
command(process.execPath, [pnpm, "install", "--offline", "--frozen-lockfile"]);
await mkdir(runtime, { recursive: true });
await cp(path.join(root, "apps/web/dist"), path.join(runtime, "web"), { recursive: true });
await cp(path.join(desktop, "resources/icon.png"), path.join(runtime, "icon.png"));
const legal = path.join(runtime, "web/legal");
await mkdir(legal, { recursive: true });
command(process.execPath, ["docker/collect-licenses.mjs", path.join(legal, "dependencies")]);
await cp(path.join(root, "templates/licenses"), path.join(legal, "templates/licenses"), { recursive: true });
await cp(path.join(root, "apps/web/src/components/templates"), path.join(legal, "adapted-source/templates"), { recursive: true });
for (const name of ["README.md", "CATALOG.md", "catalog.json"]) await cp(path.join(root, "templates", name), path.join(legal, "templates", name));
await cp(path.join(root, "docker/legal.html"), path.join(legal, "index.html"));
const config = JSON.parse(await readFile(path.join(desktop, "electron-builder.json"), "utf8"));
const output = path.join(root, "release", `${process.platform}-${arch}`);
for (const key of ["CSC_LINK", "CSC_KEY_PASSWORD", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]) delete process.env[key];
process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
const platform = process.platform === "darwin" ? Platform.MAC : process.platform === "win32" ? Platform.WINDOWS : Platform.LINUX;
const targets = platform.createTarget(args.includes("--dir") ? ["dir"] : undefined, arch === "arm64" ? Arch.arm64 : Arch.x64);
const artifacts = await build({ targets, projectDir: appDir, publish: "never", config: { ...config, electronVersion: pkg.devDependencies.electron,
  directories: { app: appDir, output, buildResources: path.join(desktop, "resources") },
  // Bundled job modules resolve ../../../config from app.asar/dist/runtime.
  extraResources: [{ from: runtime, to: "runtime" }, { from: path.join(root, "config"), to: "config" }],
  mac: { ...config.mac, icon: path.join(desktop, "resources/icon.png") },
  win: { ...config.win, icon: path.join(desktop, "resources/icon.png") },
  linux: { ...config.linux, icon: path.join(desktop, "resources/icon.png"), artifactName: `BetterMe-\${version}-linux-${arch}.\${ext}` },
} });
const checksums = [];
for (const file of artifacts) {
  if (!/\.(dmg|zip|exe|AppImage)$/i.test(file)) continue;
  const info = await stat(file); if (!info.isFile()) continue;
  checksums.push(createHash("sha256").update(await readFile(file)).digest("hex") + "  " + path.basename(file));
}
await mkdir(output, { recursive: true });
await writeFile(path.join(output, `SHA256SUMS-${process.platform}-${arch}.txt`), checksums.join("\n") + "\n");
console.log(`Desktop distribution ready: ${output}`);
} finally {
  // This exact directory was created above by mkdtemp for this invocation only.
  await rm(stage, { recursive: true, force: true });
}
