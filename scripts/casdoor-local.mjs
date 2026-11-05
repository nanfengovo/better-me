#!/usr/bin/env node
/** Opt-in loopback self-hosting. No Docker daemon, shared user data, or known bootstrap secrets. */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

process.umask(0o077);
const VERSION = "4.25.0", SHA256 = "32bce6998280364964eb95affbc9aa4f3f547721e5fdf8e86ea9535299dacb17";
const root = path.join(os.homedir(), "Library/Application Support/BetterMe/casdoor", `v${VERSION}`);
const issuer = "http://127.0.0.1:18000", callbackUrl = "http://localhost:5173/api/v1/agent/identity/oidc/callback";
const command = process.argv[2] ?? "status";
const exists = async file => { try { await fs.lstat(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
const secret = () => randomBytes(32).toString("base64url");
async function privateRoot() {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("unsafe_casdoor_directory");
}
async function init() {
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("This pinned native installer supports macOS ARM64 only. Use the documented Casdoor container for other platforms.");
  if (await exists(root)) throw new Error("Casdoor installation already exists. Refusing to replace configuration, users or keys.");
  const input = process.argv[3];
  const archive = input ? await fs.readFile(path.resolve(input)) : Buffer.from(await (await fetch(`https://github.com/casdoor/casdoor/releases/download/v${VERSION}/casdoor_Darwin_arm64.tar.gz`, { signal: AbortSignal.timeout(120_000) })).arrayBuffer());
  if (createHash("sha256").update(archive).digest("hex") !== SHA256) throw new Error("Casdoor release checksum mismatch; not extracted or executed.");
  await fs.mkdir(root, { recursive: true, mode: 0o700 }); await privateRoot();
  const archivePath = path.join(root, "release.tar.gz"); await fs.writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
  const entries = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" }).trim().split("\n");
  if (entries.some(entry => entry.startsWith("/") || entry.split("/").includes(".."))) throw new Error("Unsafe release archive path.");
  execFileSync("tar", ["-xzf", archivePath, "-C", root]);
  await fs.mkdir(path.join(root, "data"), { mode: 0o700 }); await fs.mkdir(path.join(root, "logs"), { mode: 0o700 });
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:3072", "-sha256", "-nodes", "-days", "3650", "-subj", "/CN=BetterMe local Casdoor", "-keyout", path.join(root, "data/signing.key"), "-out", path.join(root, "data/signing.crt")], { stdio: "ignore" });
  const clientId = "betterme-" + randomBytes(12).toString("hex"), clientSecret = secret(), adminPassword = secret();
  const signupItems = [
    { name: "ID", visible: false, required: true, rule: "Random" },
    ...["Username", "Display name", "Password", "Confirm password"].map(name => ({ name, visible: true, required: true, rule: "None" })),
  ];
  const application = { owner: "admin", name: "app-betterme", displayName: "BetterMe 统一账号", organization: "betterme", cert: "cert-betterme",
    enablePassword: true, enableSignUp: true, clientId, clientSecret, providers: [],
    signinMethods: [{ name: "Password", displayName: "密码登录", rule: "All" }], signupItems,
    grantTypes: ["authorization_code"], redirectUris: [callbackUrl], tokenFormat: "JWT", expireInHours: 1, failedSigninLimit: 5, failedSigninFrozenTime: 15 };
  const data = { organizations: [{ owner: "admin", name: "betterme", displayName: "BetterMe", passwordType: "bcrypt", passwordOptions: ["AtLeast12"],
    countryCodes: ["CN"], languages: ["zh", "en"], defaultApplication: "app-betterme", isProfilePublic: false, dcrPolicy: "disabled" }],
    applications: [application, { ...application, name: "app-built-in", displayName: "Casdoor 管理", organization: "built-in", enableSignUp: false,
      clientId: "admin-" + secret(), clientSecret: secret(), redirectUris: [] }],
    users: [], providers: [], certs: [{ owner: "admin", name: "cert-betterme", displayName: "BetterMe 本机独立签名证书", scope: "JWT", type: "x509", cryptoAlgorithm: "RS256", bitSize: 3072, expireInYears: 10,
      certificate: await fs.readFile(path.join(root, "data/signing.crt"), "utf8"), privateKey: await fs.readFile(path.join(root, "data/signing.key"), "utf8") }] };
  await fs.writeFile(path.join(root, "init_data.json"), JSON.stringify(data, null, 2), { flag: "wx", mode: 0o600 });
  // v4.25 unconditionally starts RADIUS on 0.0.0.0. An invalid port disables that unused server.
  const config = ["appname = casdoor", "httpaddr = 127.0.0.1", "httpport = 18000", "radiusServerPort = -1", "runmode = prod", "copyrequestbody = true", "driverName = sqlite3", "dataSourceName = ./data/casdoor.db?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)", "dbName = casdoor", "showSql = false", "socks5Proxy =", `origin = ${issuer}`, `originFrontend = ${issuer}`, "isDemoMode = false", "showGithubCorner = false", "defaultLanguage = zh", "defaultApplication = app-betterme", "enableErrorMask = true", "enableGzip = true", "initDataNewOnly = true", "initDataFile = ./init_data.json", "frontendBaseDir = ./web", "logPostOnly = true", 'logConfig = {"adapter":"file","filename":"logs/casdoor.log","perm":"0600"}', `initAdminPassword = ${adminPassword}`, ""].join("\n");
  await fs.writeFile(path.join(root, "conf/app.conf"), config, { mode: 0o600 }); await fs.chmod(path.join(root, "conf/app.conf"), 0o600);
  const oidc = { issuer, clientId, clientSecret, callbackUrl, allowLoopbackHttp: true };
  const oidcPath = path.join(os.homedir(), "Library/Application Support/BetterMe/agent/oidc.json");
  await fs.mkdir(path.dirname(oidcPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(oidcPath, JSON.stringify(oidc, null, 2), { flag: "wx", mode: 0o600 });
  const bootstrapPath = path.join(root, "bootstrap-private.json");
  await fs.writeFile(bootstrapPath, JSON.stringify({ admin: { organization: "built-in", username: "admin", password: adminPassword }, issuer, application: "app-betterme", oidcPath }, null, 2), { flag: "wx", mode: 0o600 });
  await fs.writeFile(path.join(root, "installation.json"), JSON.stringify({ version: VERSION, archiveSha256: SHA256, issuer, createdAt: new Date().toISOString(), oidcPath, bootstrapPath }), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ status: "initialized-no-existing-data-replaced", root, issuer, oidcPath, bootstrapPath }));
}
async function start() {
  await privateRoot();
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once("error", reject); probe.listen(18000, "127.0.0.1", () => probe.close(resolve)); });
  const log = await fs.open(path.join(root, "logs/process.log"), "a", 0o600);
  const child = spawn(path.join(root, "casdoor"), [], { cwd: root, stdio: ["ignore", log.fd, log.fd] });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => child.kill(signal));
  child.once("error", () => { console.error("Casdoor did not start. Inspect the private process log."); process.exitCode = 1; });
  child.once("exit", code => { process.exitCode = code ?? 1; void log.close(); });
  await fs.writeFile(path.join(root, "process.json"), JSON.stringify({ pid: child.pid, issuer }), { mode: 0o600 });
  console.log(JSON.stringify({ status: "starting", issuer, pid: child.pid, log: path.join(root, "logs/process.log") }));
}
try {
  if (command === "init") await init();
  else if (command === "start") await start();
  else if (command === "status") {
    const response = await fetch(issuer + "/.well-known/openid-configuration", { signal: AbortSignal.timeout(3000) });
    const data = await response.json(); console.log(JSON.stringify({ ready: response.ok && data.issuer === issuer, issuer }));
  } else throw new Error("Usage: pnpm auth:casdoor init [verified-release.tar.gz] | start | status");
} catch (error) { console.error(error instanceof Error ? error.message : "Casdoor operation failed"); process.exitCode = 1; }
