import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { connectNativeCdp } from "./jd-native-cdp";

/** Brings up a browser for this runtime's profile under its own debug port. */
export function createDesktopChrome(profile: string) {
  let child: ChildProcess | undefined;
  let port: number | undefined;
  let starting: Promise<number | undefined> | undefined;
  let stopping: Promise<void> | undefined;
  const alive = (process: ChildProcess | undefined): process is ChildProcess => Boolean(process?.pid && process.exitCode === null && process.signalCode === null);
  const endpoint = () => alive(child) ? port : undefined;

  function launch(binary: string, url: string): Promise<number | undefined> {
    if (stopping) return Promise.resolve(undefined);
    if (alive(child)) return starting ?? Promise.resolve(port);
    return starting ??= (async () => {
      await mkdir(profile, { recursive: true, mode: 0o700 });
      const portFile = join(profile, "DevToolsActivePort");
      await rm(portFile, { force: true });
      if (stopping) return undefined;
      const owned = spawn(binary, ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
        `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", url], { stdio: "ignore", windowsHide: true });
      const forget = () => { if (child === owned) { child = undefined; port = undefined; } };
      child = owned;
      owned.once("error", forget);
      owned.once("exit", forget);
      const deadline = Date.now() + 8_000;
      while (alive(owned) && !stopping && Date.now() < deadline) {
        await wait(150);
        if (!alive(owned) || stopping) break;
        const [number, path] = (await readFile(portFile, "utf8").catch(() => "")).split(/\r?\n/);
        const candidate = Number(number);
        if (Number.isInteger(candidate) && candidate > 0 && candidate <= 65535 && /^\/devtools\/browser\/[\w-]+$/.test(path ?? "")) {
          port = candidate;
          return port;
        }
      }
      if (alive(owned)) {
        owned.kill();
        await once(owned, "exit", { signal: AbortSignal.timeout(1_500) }).catch(() => undefined);
      }
      return undefined;
    })().finally(() => { starting = undefined; });
  }

  function stop() {
    return stopping ??= (async () => {
      await starting?.catch(() => undefined);
      const owned = child;
      if (!alive(owned)) return;
      if (port) {
        const cdp = await connectNativeCdp(port).catch(() => undefined);
        if (cdp) {
          try { await cdp.send("Browser.close", {}, undefined, 1_500); } catch { /* The owned browser may already have disconnected. */ }
          finally { cdp.close(); }
        }
      }
      if (alive(owned)) await once(owned, "exit", { signal: AbortSignal.timeout(1_500) }).catch(() => undefined);
      if (alive(owned)) {
        owned.kill();
        await once(owned, "exit", { signal: AbortSignal.timeout(2_500) }).catch(() => undefined);
      }
      if (alive(owned)) {
        owned.kill("SIGKILL");
        await once(owned, "exit", { signal: AbortSignal.timeout(2_000) });
      }
    })().finally(() => { stopping = undefined; });
  }
  return { endpoint, launch, stop };
}
