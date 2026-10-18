import { execFile, spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { connectNativeCdp, nativeUnavailable, type NativeCdp } from "./jd-native-cdp";

const exec = promisify(execFile);
type ProcessIdentity = { pid: number; parent: number; created: string; executable: string; command: string; window: number };
type MachineState = { processes: ProcessIdentity[]; listeners: Array<{ pid: number; address: string }> };
export type NativeEdge = {
  cdp: NativeCdp;
  stop(): Promise<void>;
  /** Restores only this startup's verified debugger transport; never adopts another process. */
  reconnect?(signal?: AbortSignal): Promise<boolean>;
  /** Read-only OS proof; a lost debugger connection alone does not prove exit. */
  confirmExited?(): Promise<boolean>;
  readonly alive: boolean;
};
export class NativeEdgeStartupError extends Error {
  constructor(readonly edge: NativeEdge) { super("岗位专用浏览器启动未完成，且尚未确认清理；请显式关闭工具浏览器重试。"); this.name = "NativeEdgeStartupError"; }
}
export function abortNative(signal?: AbortSignal) { if (signal?.aborted) throw signal.reason ?? nativeUnavailable("岗位操作已取消。"); }
export function nativePause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
const normalized = (value: string) => path.resolve(value).toLowerCase();
function hasProfile(command: string, profile: string) {
  const args = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  return args.map((arg) => arg.replaceAll('"', "")).some((arg) => arg.startsWith("--user-data-dir=") && normalized(arg.slice(16)) === normalized(profile));
}
export type NativeProfileOccupancy = "clear" | "occupied" | "unknown";
/** No ownership is inferred: an exact profile argument only prevents a false successful stop. */
export function nativeProfileOccupancySnapshot(value: unknown, profile: string): NativeProfileOccupancy {
  if (!profile || !path.isAbsolute(profile)) return "unknown";
  if (!value || typeof value !== "object" || Array.isArray(value)) return "unknown";
  const rows = (value as { processes?: unknown }).processes;
  if (!Array.isArray(rows) || rows.length > 10_000) return "unknown";
  let uncertain = false;
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) { uncertain = true; continue; }
    const command = (row as { command?: unknown }).command;
    if (typeof command !== "string" || !command.trim() || command.includes("\0") || (command.match(/"/g)?.length ?? 0) % 2) { uncertain = true; continue; }
    const args = (command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map(arg => arg.replaceAll('"', ""));
    if (!args.length || !args[0].trim()) uncertain = true;
    for (let index = 0; index < args.length; index++) {
      const argument = args[index]; const lower = argument.toLowerCase();
      if (lower !== "--user-data-dir" && !lower.startsWith("--user-data-dir=")) continue;
      const candidate = lower === "--user-data-dir" ? args[++index] : argument.slice(16);
      if (!candidate || candidate.startsWith("--") || !path.isAbsolute(candidate)) { uncertain = true; continue; }
      try { if (normalized(candidate) === normalized(profile)) return "occupied"; }
      catch { uncertain = true; }
    }
  }
  return uncertain ? "unknown" : "clear";
}
/** Read-only OS query. Never attaches, closes, kills, or reads the profile directory. */
export async function inspectNativeProfileOccupancy(profile: string): Promise<NativeProfileOccupancy> {
  if (process.platform !== "win32") return "unknown";
  try {
    const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [pscustomobject]@{processes=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"|ForEach-Object{[pscustomobject]@{command=$_.CommandLine}})}|ConvertTo-Json -Compress -Depth 3`;
    const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 });
    return nativeProfileOccupancySnapshot(JSON.parse(stdout.trim()) as unknown, profile);
  } catch { return "unknown"; }
}
/** Snapshot proof is conservative about unobserved children; suspicion never grants kill ownership. */
export function nativeExitSnapshotConfirmed(state: MachineState, before: MachineState, remembered: ProcessIdentity[], identity: ProcessIdentity | undefined, executable: string, profile: string, suspected = new Map<string, ProcessIdentity>()): boolean {
  return nativeExitSnapshotAbsent(state, before, remembered, identity, executable, profile, suspected) && !!identity;
}
/** Unknown-root startup cleanup additionally requires a failed or terminal launcher. */
export function nativeExitSnapshotAbsent(state: MachineState, before: MachineState, remembered: ProcessIdentity[], identity: ProcessIdentity | undefined, executable: string, profile: string, suspected = new Map<string, ProcessIdentity>()): boolean {
  const key = (item: ProcessIdentity) => `${item.pid}/${item.created}`;
  const existed = new Set(before.processes.map(key));
  // Remember suspicion across samples even while a listener is still present:
  // an observed orphan may itself exit before its child is sampled next time.
  let changed = true;
  while (changed) {
    changed = false;
    const parents = new Set([...remembered, ...suspected.values(), ...(identity ? [identity] : [])].map((item) => item.pid));
    for (const item of state.processes) {
      if (existed.has(key(item)) || suspected.has(key(item)) || normalized(item.executable ?? "") !== normalized(executable)) continue;
      if (hasProfile(item.command ?? "", profile) || parents.has(item.parent)) { suspected.set(key(item), item); changed = true; }
    }
  }
  if (state.listeners.length) return false;
  const possible = new Set([...remembered, ...suspected.values(), ...(identity ? [identity] : [])].map(key));
  return !state.processes.some((item) => possible.has(key(item)));
}
async function machine(port: number): Promise<MachineState> {
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [pscustomobject]@{processes=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'"|ForEach-Object{[pscustomobject]@{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;created=$_.CreationDate.ToUniversalTime().ToString('o');executable=$_.ExecutablePath;command=$_.CommandLine;window=[long](Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).MainWindowHandle}});listeners=@(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue|ForEach-Object{[pscustomobject]@{pid=[int]$_.OwningProcess;address=$_.LocalAddress}})}|ConvertTo-Json -Compress -Depth 4`;
  const { stdout } = await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, timeout: 8000, maxBuffer: 512 * 1024 });
  return JSON.parse(stdout.trim()) as MachineState;
}
async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); if (!address || typeof address === "string") throw nativeUnavailable();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return address.port;
}
/** The same live startup root must still own every listener on its reserved port. */
export function nativeReconnectSnapshotConfirmed(state: MachineState, identity: ProcessIdentity, executable: string, profile: string): boolean {
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.created || !identity.command || !path.isAbsolute(profile)) return false;
  const roots = state.processes.filter(item => !/(?:^|\s)--type=/.test(item.command ?? "") && hasProfile(item.command ?? "", profile));
  if (roots.length !== 1) return false;
  const root = roots[0]!;
  return root.pid === identity.pid && root.created === identity.created && root.command === identity.command
    && normalized(root.executable ?? "") === normalized(executable) && normalized(identity.executable ?? "") === normalized(executable)
    && state.listeners.length > 0 && state.listeners.every(listener => listener.pid === identity.pid && ["127.0.0.1", "::1"].includes(listener.address));
}
/** Dedicated persistent profile, ordinary installed Edge. Never attaches a daily browser. */
export async function startNativeEdge(profile: string, proxyUrl?: string, signal?: AbortSignal): Promise<NativeEdge> {
  if (process.platform !== "win32") throw nativeUnavailable("当前原生岗位浏览器需要本机 Microsoft Edge（Windows）。");
  abortNative(signal);
  const candidates = [path.join(process.env["ProgramFiles(x86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"), path.join(process.env.ProgramFiles ?? "C:/Program Files", "Microsoft/Edge/Application/msedge.exe")];
  let executable: string | undefined;
  for (const candidate of candidates) { if (await access(candidate).then(() => true, () => false)) { executable = candidate; break; } }
  if (!executable) throw nativeUnavailable("未找到 Microsoft Edge，请安装后再打开岗位。");
  if (proxyUrl) {
    const proxy = new URL(proxyUrl);
    if (!["http:", "https:"].includes(proxy.protocol) || proxy.username || proxy.password || proxy.pathname !== "/" || proxy.search || proxy.hash) throw nativeUnavailable("原生浏览器仅支持无认证的 HTTP / HTTPS 代理地址。");
  }
  await mkdir(profile, { recursive: true }); abortNative(signal);
  const port = await reservePort(); const before = await machine(port); abortNative(signal);
  if (before.processes.some((item) => hasProfile(item.command ?? "", profile))) throw nativeUnavailable("岗位专用目录仍被浏览器占用，请先显式关闭该工具浏览器。");
  let spawnFailed = false;
  const child = spawn(executable, ["--remote-debugging-address=127.0.0.1", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--lang=zh-CN", ...(proxyUrl ? [`--proxy-server=${proxyUrl}`, "--proxy-bypass-list=<-loopback>"] : ["--no-proxy-server"]), "about:blank"], { windowsHide: false, stdio: "ignore" });
  child.once("error", () => { spawnFailed = true; });
  let identity: ProcessIdentity | undefined; let cdp: NativeCdp | undefined; let stopping: Promise<void> | undefined; let reconnecting: Promise<boolean> | undefined; let exited = false;
  const tracked = new Map<string, ProcessIdentity>();
  // Read-only exit blockers, deliberately separate from exact kill ownership.
  const exitSuspicions = new Map<string, ProcessIdentity>();
  const key = (item: ProcessIdentity) => `${item.pid}/${item.created}`;
  function remember(state: MachineState) {
    if (identity) tracked.set(key(identity), identity);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of state.processes) {
        if (normalized(item.executable ?? "") !== normalized(executable!) || before.processes.some((old) => key(old) === key(item)) || tracked.has(key(item))) continue;
        if ([...tracked.values()].some((parent) => parent.pid === item.parent && state.processes.some((live) => key(live) === key(parent)))) { tracked.set(key(item), item); changed = true; }
      }
    }
    // All observed startup/shutdown samples retain possible orphan ancestry,
    // including samples taken before the final absence decision.
    nativeExitSnapshotConfirmed(state, before, [...tracked.values()], identity, executable!, profile, exitSuspicions);
  }
  const own = (item: ProcessIdentity) => !/(?:^|\s)--type=/.test(item.command ?? "") && normalized(item.executable ?? "") === normalized(executable!) && hasProfile(item.command ?? "", profile)
    && !before.processes.some((old) => old.pid === item.pid && old.created === item.created);
  async function stillOwned() {
    const state = await machine(port);
    if (!identity) {
      const roots = state.processes.filter(own);
      if (roots.length > 1) throw nativeUnavailable("专用目录所有者不唯一，无法确认关闭归属。");
      identity = roots[0];
    }
    remember(state);
    const process = identity && state.processes.find((item) => item.pid === identity!.pid && item.created === identity!.created && own(item));
    return { state, process, descendants: state.processes.filter((item) => tracked.has(key(item))) };
  }
  async function confirmExited(): Promise<boolean> {
    if (exited) return true;
    try {
      const checked = await stillOwned();
      // Successful startup remembers an exact root. Unknown startup ownership
      // remains reserved for explicit shutdown, even if this sample is empty.
      if (!nativeExitSnapshotConfirmed(checked.state, before, [...tracked.values()], identity, executable!, profile, exitSuspicions)) return false;
      exited = true;
      cdp?.close();
      return true;
    } catch { return false; }
  }
  async function stopImpl() {
    let checked = await stillOwned();
    if (!identity && !spawnFailed) {
      // Keep startup ownership while an ordinary Edge launcher can still produce its root.
      const lateDeadline = Date.now() + 5000;
      while (!identity && Date.now() < lateDeadline) { await nativePause(150); checked = await stillOwned(); }
    }
    if (checked.process && !cdp?.connected && checked.state.listeners.every((listener) => listener.pid === checked.process!.pid && ["127.0.0.1", "::1"].includes(listener.address)) && checked.state.listeners.length) cdp = await connectNativeCdp(port).catch(() => undefined);
    if (checked.process && cdp?.connected) await cdp.send("Browser.close", {}, undefined, 3000).catch(() => undefined);
    else if (checked.process) {
      // Only the re-verified exact executable/profile/PID+creation root from this startup.
      await exec("taskkill.exe", ["/PID", String(checked.process.pid), "/T", "/F"], { windowsHide: true, timeout: 5000, maxBuffer: 8192 }).catch(() => undefined);
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const checked = await stillOwned();
      const absent = identity ? nativeExitSnapshotConfirmed(checked.state, before, [...tracked.values()], identity, executable!, profile, exitSuspicions)
        : nativeExitSnapshotAbsent(checked.state, before, [...tracked.values()], undefined, executable!, profile, exitSuspicions);
      if (absent && (identity || spawnFailed || child.exitCode !== null || child.signalCode !== null)) { exited = true; cdp?.close(); return; }
      await nativePause(100);
    }
    throw nativeUnavailable("尚未确认岗位专用浏览器已退出；保留目录归属，请重试关闭。");
  }
  function reconnect(signal?: AbortSignal): Promise<boolean> {
    abortNative(signal);
    if (stopping || exited || !identity) return Promise.resolve(false);
    if (cdp?.connected) return Promise.resolve(true);
    if (reconnecting) return reconnecting;
    const expected = identity;
    const previous = cdp;
    const work = (async () => {
      let candidate: NativeCdp | undefined;
      try {
        const beforeReconnect = await machine(port); abortNative(signal);
        if (stopping || exited || cdp !== previous || !nativeReconnectSnapshotConfirmed(beforeReconnect, expected, executable!, profile)) return false;
        candidate = await connectNativeCdp(port); abortNative(signal);
        const afterReconnect = await machine(port); abortNative(signal);
        if (stopping || exited || cdp !== previous || !candidate.connected || !nativeReconnectSnapshotConfirmed(afterReconnect, expected, executable!, profile)) return false;
        // Old page sessions and event subscriptions are not transferred. The
        // idle factory must reinstall its base policy before creating a lease.
        previous?.close(); cdp = candidate; candidate = undefined;
        return true;
      } catch {
        abortNative(signal);
        return false;
      } finally { candidate?.close(); }
    })().finally(() => { if (reconnecting === work) reconnecting = undefined; });
    reconnecting = work;
    return work;
  }
  const handle: NativeEdge = {
    get cdp() { if (!cdp) throw nativeUnavailable(); return cdp; },
    get alive() { return !exited && cdp?.connected === true; },
    confirmExited,
    reconnect,
    stop() { if (!stopping) stopping = stopImpl().finally(() => { stopping = undefined; }); return stopping; },
  };
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const state = await machine(port); const roots = state.processes.filter(own);
      if (roots.length > 1) throw nativeUnavailable("岗位专用目录出现多个浏览器所有者，已停止连接。");
      identity = roots[0] ?? identity;
      remember(state);
      if (state.listeners.length) {
        if (!identity || !state.listeners.every((listener) => listener.pid === identity!.pid && ["127.0.0.1", "::1"].includes(listener.address))) throw nativeUnavailable("调试端口不属于本次专用浏览器，已拒绝连接。");
        cdp ??= await connectNativeCdp(port); abortNative(signal);
        if (roots.some((root) => root.pid === identity!.pid && root.created === identity!.created && Number.isSafeInteger(root.window) && root.window > 0)) return handle;
      }
      abortNative(signal); if (spawnFailed) throw nativeUnavailable(); await nativePause(100, signal);
    }
    throw nativeUnavailable(cdp?.connected ? "岗位专用浏览器尚未出现可操作窗口，未创建岗位会话；请关闭后重试。" : "岗位专用浏览器启动超时。");
  } catch (error) {
    try { await handle.stop(); }
    catch { throw new NativeEdgeStartupError(handle); }
    throw error;
  }
}
