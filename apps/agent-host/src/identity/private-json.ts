import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Dedicated private stores only. Never point this at a legacy or business directory. */
export async function privateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe_private_directory");
  await fs.chmod(directory, 0o700);
}
export async function readPrivateJson(filename: string): Promise<unknown | undefined> {
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024
      || process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error("unsafe_private_file");
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
export async function writePrivateJson(filename: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(filename));
  // Validate an existing target before atomic replacement; do not follow links.
  await readPrivateJson(filename);
  const temporary = path.join(path.dirname(filename), `.write-${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => undefined); }
}
