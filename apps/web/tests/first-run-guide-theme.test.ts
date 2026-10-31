import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";
import { WORKSPACE_THEMES, workspaceThemeVariables } from "../src/themes/workspace-theme.ts";

// Use the real CSS cascade: a DOM-only test cannot detect an opaque dialog
// painting over the editor inside the SVG spotlight's transparent cutout.
test("tour spotlight stays transparent without opting ordinary dialogs out of theming", { timeout: 25_000 }, async t => {
  const styles = await Promise.all([
    "../src/components/first-run-guide.css",
    "../src/theme.css",
    "../src/themes/workspace-theme.css",
  ].map(file => readFile(new URL(file, import.meta.url), "utf8")));
  const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : "chrome" });
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${styles.join("\n")}</style>
      <main>Visible workspace behind the spotlight</main>
      <dialog id="ordinary">An ordinary themed dialog</dialog>
      <div id="aria-dialog" role="dialog">An ordinary portal dialog</div>
      <dialog class="first-run-guide is-spotlight reduced-effects">
        <svg class="guide-shade"><path fill-rule="evenodd" d="M0 0H1280V720H0Z M20 20v400h400v-400Z" /></svg>
        <section class="guide-panel"><h2>Tour explanation</h2></section>
      </dialog>`);
    await page.locator(".first-run-guide").evaluate((node: HTMLDialogElement) => node.showModal());
    for (const theme of WORKSPACE_THEMES) {
      for (const mode of ["light", "dark"] as const) {
        await t.test(`${theme.id}/${mode}`, async () => {
          await page.evaluate(({ id, mode, variables }) => {
            const root = document.documentElement;
            root.dataset.workspaceTheme = id;
            root.dataset.theme = mode;
            for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
          }, { id: theme.id, mode, variables: workspaceThemeVariables(theme.id, mode) });
          const styles = await page.evaluate(() => {
            const guide = document.querySelector(".first-run-guide")!;
            const css = getComputedStyle(guide);
            const color = document.createElement("span");
            color.style.color = "var(--ui-surface)";
            document.body.append(color);
            const surface = getComputedStyle(color).color;
            color.remove();
            return {
              background: css.backgroundColor, image: css.backgroundImage, shadow: css.boxShadow,
              backdrop: getComputedStyle(guide, "::backdrop").backgroundColor,
              ordinary: getComputedStyle(document.querySelector("#ordinary")!).backgroundColor,
              portal: getComputedStyle(document.querySelector("#aria-dialog")!).backgroundColor,
              surface,
            };
          });
          assert.equal(styles.background, "rgba(0, 0, 0, 0)", "the full-screen tour must not paint over its spotlight target");
          assert.equal(styles.image, "none");
          assert.equal(styles.backdrop, "rgba(0, 0, 0, 0)", "only the SVG may dim the workspace; its cutout must stay clear");
          assert.equal(styles.shadow, "none", "the viewport-sized tour is not an ordinary modal card");
          if (theme.id !== "atelier" || mode === "dark") {
            assert.equal(styles.ordinary, styles.surface, "ordinary native dialogs must remain themed");
            assert.equal(styles.portal, styles.surface, "ordinary portal dialogs must remain themed");
          }
        });
      }
    }
  } finally {
    await browser.close();
  }
});
