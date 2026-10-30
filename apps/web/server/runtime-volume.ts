import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";

/** Kernel-backed SQLite lease survives neither crashes nor PID/container reuse. */
export async function acquireRuntimeVolume(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("Runtime volume must be private (0700) and not a symlink.");
  const root = await realpath(directory);
  const db = new DatabaseSync(resolve(root, "runtime-lease.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;");
  } catch {
    db.close();
    throw new Error("This data volume is already owned by another BetterMe runtime. No service or data was replaced.");
  }
  return { root, close: () => db.close() };
}
