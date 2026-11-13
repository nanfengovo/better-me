import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeRegistry, type RuntimeProbeOptions } from "../src/runtime/registry.js";
import { BUILTIN_RUNTIME_DEFINITIONS } from "../src/runtime/definitions.js";

const bundled = "ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const codex = BUILTIN_RUNTIME_DEFINITIONS.find(item => item.id === "codex")!;

async function fixture(t: { mock: { method: typeof test.mock.method } }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "betterme-bundled-codex-"));
  const applications = path.join(root, "Applications"), home = path.join(root, "home");
  const access = fs.access.bind(fs);
  t.mock.method(fs, "access", async (file, mode) => {
    if (!String(file).startsWith(root + path.sep)) throw Object.assign(new Error("outside synthetic installation"), { code: "ENOENT" });
    return access(file, mode);
  });
  const options: RuntimeProbeOptions = { platform: "darwin", env: { PATH: "" }, homeDirectory: home, applicationDirectories: [applications, path.join(home, "Applications")] };
  async function binary(relative: string, executable = true) {
    const file = path.join(root, relative); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "SYNTHETIC: discovery must not execute or read this file", { mode: executable ? 0o700 : 0o600 });
    return file;
  }
  return { root, applications, home, options, binary, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("executable-only discovery finds ChatGPT's bundled Codex without probing auth or starting it", async t => {
  const f = await fixture(t);
  try {
    const file = await f.binary(`Applications/${bundled}`);
    const registry = new RuntimeRegistry({ ...f.options, definitions: [codex] });
    const [item] = await registry.discoverExecutables();
    assert.equal(item?.status, "available"); assert.equal(item.resolvedCommand, file);
    assert.equal(item.canRun, false); assert.deepEqual(item.checks, { version: "skipped", protocol: "skipped", auth: "unknown" });
  } finally { await f.cleanup(); }
});

test("per-user Codex app is a fallback and an explicit CLI installation keeps priority", async t => {
  const f = await fixture(t);
  try {
    const file = await f.binary("home/Applications/Codex.app/Contents/Resources/codex");
    const registry = new RuntimeRegistry({ ...f.options, definitions: [codex] });
    assert.equal((await registry.discoverExecutables())[0]?.resolvedCommand, file);
    const explicit = await f.binary("home/.local/bin/codex");
    assert.equal((await registry.discoverExecutables())[0]?.resolvedCommand, explicit);
  } finally { await f.cleanup(); }
});

test("macOS bundle lookup does not discover other runtimes or affect other platforms", async t => {
  const f = await fixture(t);
  try {
    await f.binary(`Applications/${bundled}`);
    const linux = new RuntimeRegistry({ ...f.options, platform: "linux", definitions: [codex] });
    assert.equal((await linux.discoverExecutables())[0]?.status, "not-installed");
    const other = new RuntimeRegistry({ ...f.options, definitions: [{ ...codex, id: "pi", name: "Pi", command: "pi" }] });
    assert.equal((await other.discoverExecutables())[0]?.status, "not-installed");
  } finally { await f.cleanup(); }
});

test("a bundle directory or non-executable file is not an installed Codex CLI", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  try {
    await f.binary(`Applications/${bundled}`, false);
    await fs.mkdir(path.join(f.home, "Applications/Codex.app/Contents/Resources/codex"), { recursive: true });
    const registry = new RuntimeRegistry({ ...f.options, definitions: [codex] });
    assert.equal((await registry.discoverExecutables())[0]?.status, "not-installed");
  } finally { await f.cleanup(); }
});
