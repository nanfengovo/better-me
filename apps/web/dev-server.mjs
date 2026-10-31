import { spawn } from "node:child_process";
import { existsSync, watch, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webDirectory = path.dirname(fileURLToPath(import.meta.url));
const workspacePackages = ["core", "storage", "opportunities", "source-adapters"];

export function isRuntimeBuildFile(filename) {
  const relative = filename.replaceAll("\\", "/");
  return relative.startsWith("dist/") && /\.(?:[cm]?js|json)$/.test(relative);
}

/** Vite reloads bundled middleware itself; external workspace ESM needs a fresh process. */
export function watchWorkspaceBuilds(workspaceDirectory, onBuild, debounceMs = 500) {
  let timer;
  const watchers = [];
  const fingerprints = new Map();
  const changed = new Set();
  const fingerprint = (file) => {
    try { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  const remember = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) remember(file);
      else if (entry.isFile() && /\.(?:[cm]?js|json)$/.test(entry.name)) fingerprints.set(file, fingerprint(file));
    }
  };
  const close = () => {
    clearTimeout(timer);
    for (const watcher of watchers) watcher.close();
  };
  try {
    for (const name of workspacePackages) {
      const directory = path.join(workspaceDirectory, "packages", name);
      if (!existsSync(directory)) continue;
      const dist = path.join(directory, "dist");
      if (existsSync(dist)) remember(dist);
      watchers.push(watch(directory, { recursive: true }, (_event, filename) => {
        if (!filename || !isRuntimeBuildFile(filename.toString())) return;
        changed.add(path.join(directory, filename.toString()));
        clearTimeout(timer);
        timer = setTimeout(() => {
          let rebuilt = false;
          for (const file of changed) {
            const current = fingerprint(file);
            if ((fingerprints.get(file) ?? null) !== current) rebuilt = true;
            fingerprints.set(file, current);
          }
          changed.clear();
          if (rebuilt) onBuild();
        }, debounceMs);
      }));
    }
  } catch (error) {
    close();
    throw error;
  }
  return close;
}

/** Only owns the child Vite process; it never stops Chrome or the job-index service. */
export function startDevServer({
  cwd = webDirectory,
  workspaceDirectory = path.resolve(webDirectory, "../.."),
  args = [],
  viteCliPath = path.join(path.dirname(createRequire(import.meta.url).resolve("vite/package.json")), "bin/vite.js"),
  stdio = "inherit",
  debounceMs = 500,
  onSpawn = () => {},
  log = (message) => console.info(message),
} = {}) {
  let child;
  let closing = false;
  let restarting = false;
  let settled = false;
  let forceStopTimer;
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const unwatch = watchWorkspaceBuilds(workspaceDirectory, () => {
    if (closing || restarting || settled) return;
    restarting = true;
    log("[betterme-dev] Workspace runtime rebuilt; restarting Vite to load fresh server modules.");
    stopChild();
  }, debounceMs);

  function finish(code) {
    if (settled) return;
    settled = true;
    clearTimeout(forceStopTimer);
    unwatch();
    resolveDone(code);
  }

  function stopChild() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const ownedChild = child;
    ownedChild.kill("SIGTERM");
    // Do not leave a second Vite listening if a middleware cleanup fails to finish.
    forceStopTimer = setTimeout(() => {
      if (ownedChild.exitCode === null && ownedChild.signalCode === null) ownedChild.kill("SIGKILL");
    }, 5000);
    forceStopTimer.unref();
  }

  function launch() {
    child = spawn(process.execPath, [viteCliPath, ...args], { cwd, stdio });
    onSpawn(child);
    child.once("error", (error) => {
      log(`[betterme-dev] Vite could not start: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(forceStopTimer);
      if (closing) finish(0);
      else if (restarting) { restarting = false; launch(); }
      else finish(code ?? (signal ? 1 : 0));
    });
  }

  launch();
  return {
    done,
    close: () => {
      if (!closing && !settled) {
        closing = true;
        unwatch();
        stopChild();
      }
      return done;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = startDevServer({ args: process.argv.slice(2) });
  const close = () => { void server.close(); };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  process.exitCode = await server.done;
  process.off("SIGINT", close);
  process.off("SIGTERM", close);
}
