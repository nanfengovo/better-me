import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("wide maximized business windows meet the stage, without changing floating/settings/mobile geometry", async () => {
  const css = await readFile(new URL("../src/components/desktop/desktop.css", import.meta.url), "utf8");
  assert.ok(/@media screen and \(min-width:941px\) and \(min-height:501px\)\s*\{\s*\.os-business-window\.is-maximized\s*\{[^}]*inset:\s*0\s*!important;[^}]*width:\s*100%\s*!important;[^}]*height:\s*100%\s*!important;[^}]*border:\s*0\s*!important;[^}]*border-radius:\s*0\s*!important;[^}]*box-shadow:\s*none\s*!important;/.test(css), "wide business-only maximized frame must meet the stage");
  assert.ok(/\.os-business-window\.is-maximized>\.os-window-toolbar,\s*\.os-business-window\.is-maximized>\.os-window-content\s*\{\s*border-radius:\s*0\s*;/.test(css), "inner corners must not reveal wallpaper");
  assert.ok(/\.os-window\.is-centered\s*\{[^}]*left:\s*12\.5%\s*!important;/.test(css), "centered floating mode stays inset");
  assert.ok(/\.os-window\.is-split-left\s*\{[^}]*width:\s*calc\(50% - 15px\)\s*!important;/.test(css), "split mode retains its gutter");
});

test("desktop sidebar uses one quiet divider but retains the full keyboard/pointer resize target", async () => {
  const css = await readFile(new URL("../src/components/agent-sidebar.css", import.meta.url), "utf8");
  assert.ok(/\.agent-sidebar-resizer\s*\{[^}]*flex:0 0 12px;[^}]*width:12px;[^}]*margin:0 -6px;/.test(css), "keep the existing 12px resize target");
  assert.ok(/\.agent-layout:has\(>\.agent-layout-app \.os-desktop\)>\.agent-sidebar\s*\{[^}]*box-shadow:none;/.test(css), "docked sidebar must not cast a dark seam");
  assert.ok(/\.agent-layout:has\(>\.agent-layout-app \.os-desktop\)>\.agent-sidebar-resizer::before\s*\{[^}]*inset:0 5\.5px;[^}]*box-shadow:none[;}]/.test(css), "quiet divider is one pixel, without an extra shadow");
  assert.ok(/\.agent-sidebar-resizer:focus-visible\s*\{[^}]*outline:2px solid var\(--color-accent\);/.test(css), "keyboard focus stays visible");
});
