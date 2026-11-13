import path from "node:path";
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync } from "node:fs";

export type DesktopQaConfig = {
  readonly externalOnly: true;
  readonly host: { readonly endpoint: string; readonly token: string; readonly port: number };
  readonly web: { readonly endpoint: string; readonly port: number };
  readonly profileRoot: string;
  readonly workspaceUrl: string;
};

function invalid(): never { throw new Error("desktop_qa_configuration_invalid"); }
function endpoint(value: string | undefined): { endpoint: string; port: number } {
  if (!value || value.trim() !== value) return invalid();
  let url: URL; try { url = new URL(value); } catch { return invalid(); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password ||
    url.pathname !== "/" || url.search || url.hash || !url.port || ![url.origin, `${url.origin}/`].includes(value)) return invalid();
  const port = Number(url.port);
  if (port < 1024 || port > 65535 || [5173, 5179].includes(port)) return invalid();
  return { endpoint: url.origin, port };
}

export function assertDesktopQaEndpoint(value: string, port: number): void {
  const parsed = endpoint(value);
  if (parsed.port !== port || parsed.endpoint !== value) invalid();
}

export function assertDesktopQaToken(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 16 || value.length > 512 || [...value].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) invalid();
}

/** No overrides exist without an explicit test-only process environment. */
export function resolveDesktopQaConfig(input: { environment: NodeJS.ProcessEnv; isPackaged: boolean }): DesktopQaConfig | undefined {
  if (!Object.keys(input.environment).some(key => key.startsWith("BETTERME_DESKTOP_QA_"))) return undefined;
  const env = input.environment, allowed = new Set(["BETTERME_DESKTOP_QA_MODE", "BETTERME_DESKTOP_QA_HOST_URL", "BETTERME_DESKTOP_QA_WEB_URL", "BETTERME_DESKTOP_QA_TOKEN", "BETTERME_DESKTOP_QA_PROFILE_ROOT"]);
  if (input.isPackaged || env.NODE_ENV !== "test" || env.BETTERME_DESKTOP_QA_MODE !== "external-reuse-only" || Object.keys(env).some(key => key.startsWith("BETTERME_DESKTOP_QA_") && !allowed.has(key))) return invalid();
  const host = endpoint(env.BETTERME_DESKTOP_QA_HOST_URL), web = endpoint(env.BETTERME_DESKTOP_QA_WEB_URL);
  const token = env.BETTERME_DESKTOP_QA_TOKEN, profileRoot = env.BETTERME_DESKTOP_QA_PROFILE_ROOT;
  assertDesktopQaToken(token);
  if (host.port === web.port ||
    !profileRoot || !path.isAbsolute(profileRoot) || path.resolve(profileRoot) !== profileRoot || !/^betterme-desktop-qa-[A-Za-z0-9_-]{6,80}$/.test(path.basename(profileRoot))) return invalid();
  return Object.freeze({ externalOnly: true, host: Object.freeze({ ...host, token }), web: Object.freeze(web), profileRoot, workspaceUrl: new URL("/?workspace=autopilot", web.endpoint).href });
}

/** Called before app.whenReady()/any Session/BrowserWindow. A deliberate fresh
 * mktemp directory is required; neither a previous QA account nor the regular
 * Electron profile can be reused. Windows needs a separately reviewed ACL
 * boundary and is unavailable rather than treating POSIX mode bits as an ACL. */
export function prepareDesktopQaProfile(config: DesktopQaConfig, temporaryRoot: string): Readonly<Record<"userData" | "sessionData" | "logs" | "crashDumps", string>> {
  const reject = (): never => { throw new Error("desktop_qa_profile_not_fresh_private_temp"); };
  try {
    if (process.platform === "win32" || !process.getuid) return reject();
    const root = config.profileRoot, stat = lstatSync(root);
    if (!path.isAbsolute(root) || !/^betterme-desktop-qa-[A-Za-z0-9_-]{6,80}$/.test(path.basename(root)) ||
      !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 ||
      realpathSync(root) !== root || path.dirname(root) !== realpathSync(temporaryRoot) || readdirSync(root).length !== 0) return reject();
    closeSync(openSync(path.join(root, ".isolated-qa-profile"), "wx", 0o600));
    const paths = { userData: path.join(root, "userData"), sessionData: path.join(root, "sessionData"), logs: path.join(root, "logs"), crashDumps: path.join(root, "crashDumps") };
    for (const location of Object.values(paths)) mkdirSync(location, { mode: 0o700 });
    if (lstatSync(root).ino !== stat.ino || realpathSync(root) !== root) return reject();
    return Object.freeze(paths);
  } catch { return reject(); }
}
