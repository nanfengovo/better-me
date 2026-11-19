import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

test("app sync prunes only verified complete backups and honors an in-progress sync", async t => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "betterme-sync-fixture-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const repo = join(parent, "repo");
  const target = join(parent, "BetterMe.app", "Contents", "Resources", "app", "dist");
  const web = join(repo, "apps", "web", "dist");
  const desktop = join(repo, "apps", "desktop", "dist");
  const script = join(repo, "scripts", "sync-local-desktop-dist.mjs");
  const partial = join(parent, ".unified-agent-app-incomplete", "candidate-dist");
  const legacy = join(parent, ".unified-agent-app-legacy", "previous-dist");
  await Promise.all([target, web, join(desktop, "main"), join(desktop, "preload"), join(repo, "scripts"), partial, legacy]
    .map(path => mkdir(path, { recursive: true })));
  await Promise.all([
    copyFile(new URL("../../../scripts/sync-local-desktop-dist.mjs", import.meta.url), script),
    writeFile(join(target, "index.html"), "original"),
    writeFile(join(desktop, "main", "index.cjs"), "fixture main"),
    writeFile(join(desktop, "preload", "index.cjs"), "fixture preload"),
    writeFile(join(partial, "keep.txt"), "partial copy"),
    writeFile(join(legacy, "keep.txt"), "unmarked rollback"),
  ]);
  await writeFile(join(web, "index.html"), "fixture web");
  const launch = () => run(process.execPath, [script], { cwd: repo });
  const lock = new DatabaseSync(join(parent, ".unified-agent-app-sync.sqlite"));
  try {
    lock.exec("BEGIN EXCLUSIVE;");
    await assert.rejects(launch(), /Another BetterMe resource sync is in progress/);
    assert.equal(await readFile(join(target, "index.html"), "utf8"), "original");
  } finally { lock.close(); }
  const receipts = [];
  for (let generation = 0; generation < 4; generation++) {
    await writeFile(join(web, "index.html"), `build ${generation}`);
    receipts.push(JSON.parse((await launch()).stdout));
  }
  assert.equal(receipts.at(-1).prunedBackups, 1);
  assert.equal(await readFile(join(target, "index.html"), "utf8"), "build 3");
  assert.equal(await readFile(join(receipts[3].backup, "index.html"), "utf8"), "build 2");
  assert.equal(await readFile(join(receipts[2].backup, "index.html"), "utf8"), "build 1");
  for (const receipt of receipts.slice(0, 2)) await assert.rejects(readFile(join(receipt.backup, "index.html")), { code: "ENOENT" });
  assert.equal(await readFile(join(partial, "keep.txt"), "utf8"), "partial copy");
  assert.equal(await readFile(join(legacy, "keep.txt"), "utf8"), "unmarked rollback");
});
