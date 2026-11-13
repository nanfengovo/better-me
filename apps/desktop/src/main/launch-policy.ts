import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** A smoke run may only claim a new, empty, private directory directly in temp. */
export function validateSmokeProfile(input: string): string {
  const profile = path.resolve(input), info = lstatSync(profile);
  // The async realpath used by the launcher expands Windows 8.3 aliases; the
  // non-native sync implementation may retain RUNNER~1. Compare native paths
  // consistently, and let path.relative apply the platform's case semantics.
  const canonical = realpathSync.native(profile), temp = realpathSync.native(tmpdir());
  if (path.relative(temp, path.dirname(canonical)) !== "" || !path.basename(profile).startsWith("betterme-desktop-smoke-")
    || info.isSymbolicLink() || !info.isDirectory() || path.relative(canonical, profile) !== "" || readdirSync(profile).length
    || process.platform !== "win32" && (info.mode & 0o077 || process.getuid && info.uid !== process.getuid())) throw new Error("Smoke profile must be new, empty and private; no existing account directory is adopted.");
  return profile;
}

export function externalUrl(input: unknown): string | undefined {
  if (typeof input !== "string" || input.length > 4096) return;
  try {
    const url = new URL(input);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* malformed external URL is not opened */ }
}
