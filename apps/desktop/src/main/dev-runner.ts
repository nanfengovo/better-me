import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "../..");

async function buildMainAndPreload() {
  console.log("[dev-runner] Compiling Electron main and preload scripts...");

  await esbuild.build({
    entryPoints: [path.join(desktopRoot, "src/main/index.ts")],
    outfile: path.join(desktopRoot, "dist/main/index.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  });

  await esbuild.build({
    entryPoints: [path.join(desktopRoot, "src/preload/index.ts")],
    outfile: path.join(desktopRoot, "dist/preload/index.cjs"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  });

  console.log("[dev-runner] Compilation complete!");
}

async function run() {
  await buildMainAndPreload();

  const electronPath = path.join(desktopRoot, "node_modules/.bin/electron");
  const mainScript = path.join(desktopRoot, "dist/main/index.cjs");

  console.log(`[dev-runner] Launching Electron: ${electronPath} ${mainScript}`);
  const child = spawn(electronPath, [mainScript], {
    cwd: desktopRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });

  child.on("exit", (code) => {
    console.log(`[dev-runner] Electron exited with code ${code}`);
    process.exit(code ?? 0);
  });
}

run().catch((err) => {
  console.error("[dev-runner] Failed:", err);
  process.exit(1);
});
