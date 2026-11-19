import { homedir } from "node:os";
import { join } from "node:path";

export type JobAtlasPathOptions = {
  home?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

/**
 * Resolves the user-private BetterMe job-atlas data directory across macOS,
 * Windows, and Linux while honoring BETTERME_JOB_DATA_DIR overrides.
 */
export function resolveJobAtlasDataDirectory(options: JobAtlasPathOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.BETTERME_JOB_DATA_DIR?.trim();
  if (override) {
    return override;
  }

  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "BetterMe", "job-atlas");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "BetterMe", "job-atlas");
  }
  const xdgDataHome = env.XDG_DATA_HOME?.trim() || join(home, ".local", "share");
  return join(xdgDataHome, "BetterMe", "job-atlas");
}

export function resolveJobAtlasCacheFile(filename: string, options?: JobAtlasPathOptions): string {
  return join(resolveJobAtlasDataDirectory(options), filename);
}
