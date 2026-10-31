import assert from "node:assert/strict";
import test from "node:test";
import type { UserConfig } from "vite";
import { readFileSync } from "node:fs";
import previewConfig from "./ui-lab/career-coach-live.config";
import { AGENT_HOST_DEV_ORIGINS } from "../server/agent-host-dev";
import { ATLAS_DEV_PAGE_ORIGINS } from "../server/atlas-dev-index";

test("the isolated full-app preview starts both local services and allows only its loopback page", () => {
  const config = previewConfig as UserConfig;
  assert.equal(config.server?.host, "127.0.0.1");
  assert.equal(config.server?.port, 5193);
  assert.equal(config.server?.strictPort, true);
  const plugins = (config.plugins ?? []).flat();
  assert.ok(plugins.some((plugin) => plugin && typeof plugin === "object" && plugin.name === "better-me-agent-host-dev"));
  assert.ok(plugins.some((plugin) => plugin && typeof plugin === "object" && plugin.name === "better-me-atlas-dev-index"));
  assert.ok(plugins.some((plugin) => plugin && typeof plugin === "object" && plugin.name === "betterme-public-jd-extractor"), "the isolated page must register the real Chrome status and launch route");
  assert.ok(plugins.some((plugin) => plugin && typeof plugin === "object" && plugin.name === "betterme-opportunity-sources"));
  assert.ok(AGENT_HOST_DEV_ORIGINS.includes("http://127.0.0.1:5193"));
  assert.ok(ATLAS_DEV_PAGE_ORIGINS.includes("http://127.0.0.1:5193"));
});

test("isolated entry builds workspace contracts and restarts Vite when runtime modules change", () => {
  const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
  assert.match(rootPackage.scripts["dev:isolated"] ?? "", /turbo run build --filter=@better-me\/web\^\.\.\./);
  assert.match(rootPackage.scripts["dev:isolated"] ?? "", /node dev-server\.mjs --config tests\/ui-lab\/career-coach-live\.config\.ts/);
});
