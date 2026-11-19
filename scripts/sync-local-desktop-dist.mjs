/** Refresh only the explicit local source-linked BetterMe.app resources.
 * No running process, profile, account, credential, or service is touched.
 * Keeps the complete previous dist next to the app for an explicit rollback.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const app=path.resolve(root,"../BetterMe.app");
const target=path.join(app,"Contents/Resources/app/dist");
const web=path.join(root,"apps/web/dist"),desktop=path.join(root,"apps/desktop/dist");
async function manifest(directory){
  const files=[];
  async function visit(relative=""){
    const location=path.join(directory,relative),stat=await fs.lstat(location);
    assert.ok(!stat.isSymbolicLink(),"resource links cannot be silently followed");
    if(stat.isDirectory()){for(const name of (await fs.readdir(location)).sort())await visit(path.join(relative,name));}
    else{assert.ok(stat.isFile(),"unexpected resource type");files.push([relative,stat.size,createHash("sha256").update(await fs.readFile(location)).digest("hex")]);}
  }
  await visit();return {files,hash:createHash("sha256").update(JSON.stringify(files)).digest("hex")};
}
const parentDir = path.dirname(app);
const markerName = "backup.complete.json";
async function completedBackup(dir) {
  try {
    const entries = (await fs.readdir(dir)).sort();
    if (entries.length !== 2 || entries[0] !== markerName || entries[1] !== "previous-dist") return;
    const marker = path.join(dir, markerName);
    const metadata = await fs.lstat(marker);
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 4096) return;
    const receipt = JSON.parse(await fs.readFile(marker, "utf8"));
    if (receipt.version !== 1 || receipt.target !== target || !Number.isSafeInteger(receipt.completedAt)) return;
    const backup = path.join(dir, "previous-dist");
    if (!(await fs.lstat(backup)).isDirectory() || (await manifest(backup)).hash !== receipt.previousHash) return;
    return { dir, completedAt: receipt.completedAt };
  } catch {
    // Legacy, incomplete, edited or unreadable backups remain available.
    return undefined;
  }
}

assert.equal(await fs.realpath(app), app, "only the explicit adjacent app may be refreshed");
const lockPath = path.join(parentDir, ".unified-agent-app-sync.sqlite");
try { await (await fs.open(lockPath, "wx", 0o600)).close(); }
catch (error) { if (error.code !== "EEXIST") throw error; }
const lockStat = await fs.lstat(lockPath);
assert.ok(lockStat.isFile() && lockStat.nlink === 1, "invalid app sync lock");
const lock = new DatabaseSync(lockPath);
try {
  try { lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;"); }
  catch { throw new Error("Another BetterMe resource sync is in progress. Retry after it finishes."); }
  for (const directory of [web, desktop, target]) assert.equal(await fs.realpath(directory), directory);
  for (const file of [path.join(web, "index.html"), path.join(desktop, "main/index.cjs"), path.join(desktop, "preload/index.cjs")]) {
    assert.ok((await fs.stat(file)).isFile());
  }
  const before = await manifest(target);
  const webBefore = await manifest(web);
  const desktopDirs = ["main", "preload"];
  const desktopBefore = await Promise.all(desktopDirs.map(directory => manifest(path.join(desktop, directory))));
  const staging = await fs.mkdtemp(path.join(parentDir, ".unified-agent-app-"));
  const candidate = path.join(staging, "candidate-dist");
  const backup = path.join(staging, "previous-dist");
  const copy = { recursive: true, errorOnExist: true, force: false, mode: constants.COPYFILE_FICLONE };
  await fs.cp(web, candidate, copy);
  for (const directory of desktopDirs) await fs.cp(path.join(desktop, directory), path.join(candidate, directory), copy);
  const built = await manifest(candidate);
  assert.equal((await manifest(web)).hash, webBefore.hash, "web build changed during sync");
  for (const [index, directory] of desktopDirs.entries()) {
    assert.equal((await manifest(path.join(desktop, directory))).hash, desktopBefore[index].hash, "desktop build changed during sync");
  }
  assert.equal((await manifest(target)).hash, before.hash, "installed resources changed concurrently; refusing overwrite");
  await fs.rename(target, backup);
  try { await fs.rename(candidate, target); }
  catch (error) { await fs.rename(backup, target); throw error; }
  assert.equal((await manifest(target)).hash, built.hash);
  assert.equal((await manifest(backup)).hash, before.hash);
  await fs.writeFile(path.join(staging, markerName), JSON.stringify({
    version: 1, target, previousHash: before.hash, completedAt: Date.now(),
  }), { mode: 0o600, flag: "wx" });

  const backups = [];
  for (const entry of await fs.readdir(parentDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^\.unified-agent-app-[A-Za-z0-9_-]+$/.test(entry.name)) {
      const valid = await completedBackup(path.join(parentDir, entry.name));
      if (valid) backups.push(valid);
    }
  }
  backups.sort((a, b) => Number(b.dir === staging) - Number(a.dir === staging) || b.completedAt - a.completedAt);
  const staleBackups = backups.slice(2);
  for (const stale of staleBackups) await fs.rm(stale.dir, { recursive: true, force: true });
  console.log(JSON.stringify({
    target, backup, prunedBackups: staleBackups.length, files: built.files.length,
    installedHash: built.hash, previousHash: before.hash, webHash: webBefore.hash, processesOrUserDataChanged: false,
  }));
} finally {
  lock.close();
}
