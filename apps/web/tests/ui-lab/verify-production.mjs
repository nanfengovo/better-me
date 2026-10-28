import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const output = fileURLToPath(new URL("../../../../output/atlas-ui-lab-production/", import.meta.url));
const audit = JSON.parse(await readFile(path.join(output, "__ui-lab-build.json"), "utf8"));
assert.equal(audit.kind, "atlas-ui-lab-production");
assert.equal(audit.mode, "production");
assert.equal(audit.workspacePackagesRebuilt, false);
const runtime = await readFile(new URL("../../../../packages/opportunities/dist/index.js", import.meta.url));
assert.equal(audit.opportunitiesRuntimeSha256, createHash("sha256").update(runtime).digest("hex"),
  "The opportunities runtime changed after this UI-only build; rebuild the lab before comparing.");
const html = await readFile(path.join(output, "tests/ui-lab/index.html"), "utf8");
assert.ok(!html.includes("/@vite/client") && !html.includes("@react-refresh"), "Preview must not load development clients.");
assert.match(html, /\/assets\/[^"']+\.js/, "Expected bundled production entry.");
const manifest = JSON.parse(await readFile(path.join(output, ".vite/manifest.json"), "utf8"));
const files = new Set(Object.values(manifest).flatMap(entry => [entry.file, ...(entry.assets ?? [])]).filter(file => typeof file === "string" && file.endsWith(".js")));
// Include dedicated Worker chunks, which need not have a top-level manifest entry.
for (const file of await readdir(path.join(output, "assets"))) if (file.endsWith(".js")) files.add(`assets/${file}`);
const forbidden = [/\bjsxDEV\b/, /react(?:-dom(?:-client)?|-jsx-runtime)?\.development\.js/, /@react-refresh/, /RefreshRuntime\.injectIntoGlobalHook/];
for (const file of files) {
  const source = await readFile(path.join(output, file), "utf8");
  for (const pattern of forbidden) assert.ok(!pattern.test(source), `${file} contains a development marker: ${pattern}`);
}
console.log(JSON.stringify({ ...audit, verifiedJavaScriptFiles: files.size,
  checks: ["production-mode build audit", "bundled HTML, no Vite/Refresh client", "no jsxDEV/development React markers", "existing opportunities runtime unchanged"],
  note: "Bundle verification is not a UI or performance pass. Drive real browser interactions on5190 separately." }, null, 2));
