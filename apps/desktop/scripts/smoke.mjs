import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const output = path.join(root, "release", `${process.platform}-${process.arch}`);
const executable = process.platform === "darwin" ? path.join(output, process.arch === "arm64" ? "mac-arm64" : "mac", "BetterMe.app/Contents/MacOS/BetterMe")
  : process.platform === "win32" ? path.join(output, "win-unpacked/BetterMe.exe") : path.join(output, "linux-unpacked/betterme");
await stat(executable);
const profile = await realpath(await mkdtemp(path.join(tmpdir(), "betterme-desktop-smoke-")));
const env = { ...process.env };
for (const key of Object.keys(env)) if (["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS", "NODE_PATH"].includes(key.toUpperCase())) delete env[key];
const child = spawn(executable, ["--betterme-smoke-test", `--betterme-smoke-profile=${profile}`], { cwd: profile, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let outputText = "";
child.stdout.on("data", data => { outputText = (outputText + data).slice(-12000); });
child.stderr.on("data", data => { outputText = (outputText + data).slice(-12000); });
const result = await new Promise((accept, reject) => {
  const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Packaged smoke timed out. " + outputText)); }, 90_000);
  child.once("error", error => { clearTimeout(timeout); reject(error); });
  child.once("close", (code, signal) => { clearTimeout(timeout); accept({ code, signal }); });
});
let report;
try { report = JSON.parse(await readFile(path.join(profile, "smoke-result.json"), "utf8")); }
catch {
  const error = await readFile(path.join(profile, "smoke-error.txt"), "utf8").catch(() => "No smoke result.");
  throw new Error(error + "\n" + outputText);
}
assert.equal(result.code, 0, outputText); assert.equal(result.signal, null);
assert.equal(report.rendererMounted, true); assert.equal(report.platform, process.platform); assert.equal(report.arch, process.arch);
assert.ok(Number(report.node.split(".")[0]) >= 24, "The bundled runtime must support node:sqlite.");
assert.throws(() => process.kill(report.runtimePid, 0), "Owned runtime must exit with its application.");
await assert.rejects(fetch(report.origin + "/healthz", { signal: AbortSignal.timeout(1000) }), "No owned HTTP listener may survive exit.");
console.log(JSON.stringify({ ...report, runtimePid: "exited", origin: "closed", profile, result }, null, 2));
