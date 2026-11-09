import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const require = createRequire(import.meta.url);
const collector = fileURLToPath(new URL("../../../docker/collect-licenses.mjs", import.meta.url));
const esbuildRequire = createRequire(require.resolve("tsx/package.json"));
const actualParent = path.dirname(esbuildRequire.resolve("esbuild/package.json"));
const pinnedLicenseSha256 = "b40ec5baec7bb34fa5b1c09521fa3cd52d5fad7adafed74932a2010d3612a681";
const actualLicense = await readFile(path.join(actualParent, "LICENSE.md"));
assert.equal(JSON.parse(await readFile(path.join(actualParent, "package.json"), "utf8")).version, "0.28.2");
assert.equal(createHash("sha256").update(actualLicense).digest("hex"), pinnedLicenseSha256);

type FixtureOptions = {
  childName?: string; childVersion?: string; childLicense?: string;
  parentName?: string; parentVersion?: string; parentLicense?: string;
  parentAbsent?: boolean; mapping?: string | null; parentText?: Buffer | null;
  decoyParent?: boolean;
};

async function withFixture(options: FixtureOptions, check: (fixture: { run: () => ReturnType<typeof runFile>; output: string }) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "betterme-license-collector-"));
  try {
    const childName = options.childName ?? "@esbuild/linux-x64";
    const childVersion = options.childVersion ?? "0.28.2";
    const parentVersion = options.parentVersion ?? "0.28.2";
    const groups: Record<string, { name: string; versions: string[]; paths: string[]; license: string }[]> = { MIT: [] };
    const addPackage = async (folder: string, pkg: Record<string, unknown>, license: Buffer | null) => {
      const location = path.join(root, "packages", folder);
      await mkdir(location, { recursive: true });
      await writeFile(path.join(location, "package.json"), JSON.stringify(pkg));
      if (license) await writeFile(path.join(location, "LICENSE.md"), license);
      return location;
    };
    // Coverage fixtures contain no upstream code; only the parent's real, pinned
    // license is read from the isolated install. No fixture platform binary is installed or executed.
    for (const name of ["react", "react-dom", "lucide-react", "docx", "mammoth", "pdfjs-dist", "zod", "maplibre-gl", "three"]) {
      const location = await addPackage(name, { name, version: "0.0.0-fixture", license: "MIT" }, actualLicense);
      groups.MIT!.push({ name, versions: ["0.0.0-fixture"], paths: [location], license: "MIT" });
    }
    const child = await addPackage("platform", { name: childName, version: childVersion, license: options.childLicense ?? "MIT" }, null);
    groups.MIT!.push({ name: childName, versions: [childVersion], paths: [child], license: options.childLicense ?? "MIT" });
    if (!options.parentAbsent) {
      const parent = await addPackage("parent", {
        name: options.parentName ?? "esbuild", version: parentVersion, license: options.parentLicense ?? "MIT",
        optionalDependencies: options.mapping === null ? {} : { [childName]: options.mapping ?? childVersion },
      }, options.parentText === undefined ? actualLicense : options.parentText);
      const paths = [parent];
      if (options.decoyParent) {
        paths.unshift(await addPackage("older-parent", { name: "esbuild", version: "0.28.1", license: "MIT", optionalDependencies: {} }, actualLicense));
      }
      // Deliberately claim both versions: the collector must read each actual
      // package.json instead of treating paths[0] as the requested version.
      groups.MIT!.push({ name: "esbuild", versions: ["0.28.1", parentVersion], paths, license: "MIT" });
    }
    const inventory = path.join(root, "licenses.json");
    await writeFile(inventory, JSON.stringify(groups));
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const shim = path.join(bin, "pnpm-fixture.cjs");
    const script = `const assert=require("node:assert/strict");assert.deepEqual(process.argv.slice(2),["licenses","list","--prod","--json"]);process.stdout.write(require("node:fs").readFileSync(process.env.BETTERME_LICENSE_FIXTURE,"utf8"));\n`;
    await writeFile(shim, script);
    if (process.platform === "win32") {
      await writeFile(path.join(bin, "pnpm.cmd"), `@"${process.execPath}" "${shim}" %*\r\n`);
    } else {
      await writeFile(path.join(bin, "pnpm"), `#!/usr/bin/env node\n${script}`, { mode: 0o755 });
    }
    const env = { ...process.env, BETTERME_LICENSE_FIXTURE: inventory };
    const originalPath = Object.entries(env).find(([key]) => key.toLowerCase() === "path")?.[1] ?? "";
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.PATH = `${bin}${path.delimiter}${originalPath}`;
    const output = path.join(root, "collected");
    await check({ output, run: () => runFile(process.execPath, [collector, output], { cwd: root, env, timeout: 30_000, maxBuffer: 1024 * 1024 }) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

for (const childName of ["@esbuild/linux-x64", "@esbuild/darwin-arm64", "@esbuild/win32-x64"]) {
  test(`collector CLI retains the exact pinned parent MIT text for ${childName}@0.28.2`, async () => {
    await withFixture({ childName, decoyParent: true }, async ({ run, output }) => {
      const result = await run();
      assert.match(result.stdout, /Collected complete licenses\/notices/);
      const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
      const pkg = manifest.packages.find((entry: { name: string }) => entry.name === childName);
      assert.ok(pkg, "the platform dependency must be represented, not silently skipped");
      assert.equal(pkg.version, "0.28.2");
      assert.equal(pkg.license, "MIT");
      assert.equal(pkg.files.length, 1);
      assert.equal(pkg.files[0].sha256, pinnedLicenseSha256);
      assert.match(pkg.files[0].source, /esbuild@0\.28\.2/);
      assert.match(pkg.files[0].source, /optional platform binary/);
      assert.match(pkg.files[0].source, /SHA-256 pinned/);
      const copied = await readFile(path.join(output, pkg.files[0].path));
      assert.deepEqual(copied, actualLicense, "copyright, permission, conditions and warranty bytes must remain unchanged");
      assert.equal(createHash("sha256").update(copied).digest("hex"), pkg.files[0].sha256);
      assert.match(await readFile(path.join(output, "index.html"), "utf8"), /LICENSE\.md/);
    });
  });
}

const rejected: [string, FixtureOptions, RegExp][] = [
  ["unrelated package", { childName: "unrelated-binary" }, /Complete production dependency license missing/],
  ["unknown platform even when a parent mapping claims it", { childName: "@esbuild/not-a-platform" }, /esbuild|license/i],
  ["future version", { childVersion: "0.28.3", parentVersion: "0.28.3" }, /Complete production dependency license missing/],
  ["missing parent", { parentAbsent: true }, /esbuild|license/i],
  ["incorrect parent identity", { parentName: "not-esbuild" }, /esbuild|license/i],
  ["incorrect parent version despite inventory claims", { parentVersion: "0.28.1" }, /esbuild|license/i],
  ["non-MIT platform", { childLicense: "Apache-2.0" }, /esbuild|license/i],
  ["non-MIT parent", { parentLicense: "Apache-2.0" }, /esbuild|license/i],
  ["missing optional mapping", { mapping: null }, /esbuild|license/i],
  ["inexact optional mapping", { mapping: "^0.28.2" }, /esbuild|license/i],
  ["mismatched optional mapping", { mapping: "0.28.1" }, /esbuild|license/i],
  ["missing parent license text", { parentText: null }, /ENOENT|license/i],
  ["truncated parent MIT text", { parentText: Buffer.from("MIT License\nPermission is hereby granted\n") }, /Pinned esbuild upstream license changed/],
  ["changed bytes even if full MIT text remains", { parentText: Buffer.concat([actualLicense, Buffer.from("\n")]) }, /Pinned esbuild upstream license changed/],
];
for (const [name, options, error] of rejected) {
  test(`collector CLI fails closed for ${name}`, async () => {
    await withFixture(options, async ({ run, output }) => {
      await assert.rejects(run(), (failure: Error & { code?: number; stderr?: string }) => {
        assert.equal(failure.code, 1);
        assert.match(failure.stderr ?? failure.message, error);
        return true;
      });
      await assert.rejects(readFile(path.join(output, "manifest.json")), { code: "ENOENT" }, "a partial run must not publish a success manifest");
    });
  });
}
