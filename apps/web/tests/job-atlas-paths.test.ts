import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { resolveJobAtlasCacheFile, resolveJobAtlasDataDirectory } from "../server/job-atlas-paths";

test("resolveJobAtlasDataDirectory handles macOS, Windows, Linux, and explicit override", () => {
  assert.equal(
    resolveJobAtlasDataDirectory({ home: "/Users/alice", platform: "darwin", env: {} }),
    join("/Users/alice", "Library", "Application Support", "BetterMe", "job-atlas"),
  );
  assert.equal(
    resolveJobAtlasDataDirectory({ home: "C:\\Users\\alice", platform: "win32", env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming" } }),
    join("C:\\Users\\alice\\AppData\\Roaming", "BetterMe", "job-atlas"),
  );
  assert.equal(
    resolveJobAtlasDataDirectory({ home: "/home/alice", platform: "linux", env: { XDG_DATA_HOME: "/home/alice/.xdg" } }),
    join("/home/alice/.xdg", "BetterMe", "job-atlas"),
  );
  assert.equal(
    resolveJobAtlasDataDirectory({ home: "/home/alice", platform: "linux", env: {} }),
    join("/home/alice", ".local", "share", "BetterMe", "job-atlas"),
  );
  assert.equal(
    resolveJobAtlasCacheFile("company-intelligence-cache.json", { env: { BETTERME_JOB_DATA_DIR: "/custom/atlas-dir" } }),
    join("/custom/atlas-dir", "company-intelligence-cache.json"),
  );
});
