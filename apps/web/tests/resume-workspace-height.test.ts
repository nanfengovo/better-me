import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";

test("a cold resume workspace fills the window and keeps the sheet scrollable with and without the sidebar", { timeout: 25_000 }, async () => {
  // These are the layout styles on a direct visit. Visiting another workspace first
  // used to supply the missing flex rule and conceal the zero-height preview.
  const styles = await Promise.all([
    "studio.css", "components/writing-workspace.css", "components/resume-writing-copilot.css",
    "components/responsive-workspace.css", "components/studio-workbench.css",
  ].map(file => readFile(new URL("../src/" + file, import.meta.url), "utf8")));
  const browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1424, height: 1067 } });
    await page.setContent(`<!doctype html><meta charset="utf-8">
      <style>*{box-sizing:border-box}body{margin:0}.flex{display:flex}.flex-col{flex-direction:column}.min-h-0{min-height:0}
        .flex-1{flex:1}.overflow-hidden{overflow:hidden}.overflow-y-auto{overflow-y:auto}
        ${styles.join("\n")}
      </style>
      <div class="agent-layout"><div class="os-desktop" data-studio="true">
        <div class="os-window-content" style="height:100dvh"><div class="studio-app compact-chrome"><div class="studio-workspace">
          <div class="resume-workspace-body">
            <header class="studio-document-bar">My resume</header>
            <main class="studio-main" data-workspace-layout="single" style="--studio-editor-share:40fr;--studio-preview-share:60fr">
              <div class="workspace-view-tabs"><button>Preview</button></div>
              <section class="studio-editor-pane" hidden><div class="studio-panel-slot">
                <div class="fact-editor flex min-h-0 flex-col overflow-hidden"><div>Editor sections</div>
                  <div class="fact-editor-scroller min-h-0 flex-1 overflow-y-auto"><article style="height:1800px">Experience</article></div>
                </div>
              </div></section><div class="studio-splitter" hidden></div>
              <section class="studio-preview-pane"><div class="writing-shell is-docked"><div class="writing-document">
                <section class="resume-preview flex min-h-0 flex-col">
                  <div class="preview-toolbar">Template</div>
                  <div class="resume-preview-canvas"><div class="resume-preview-stage"><article class="resume-preview-scale" style="height:1500px">First page</article></div></div>
                  <div class="preview-bottom">Pan</div>
                </section>
              </div></div></section>
            </main>
          </div>
          <div class="secondary-workspace" hidden>Other workspace</div><footer class="studio-footer">Saved locally</footer>
        </div></div></div>
      </div></div>`);

    const canvas = page.locator(".resume-preview-canvas");
    const footer = page.locator(".studio-footer");
    for (const scenario of [
      { width: 1424, height: 1067, layout: "single", sidebar: true }, { width: 1424, height: 1067, layout: "split" },
      { width: 390, height: 844, layout: "single" }, { width: 820, height: 1000, layout: "single" },
    ]) {
      const { width, height, layout } = scenario;
      await page.setViewportSize({ width, height });
      await page.evaluate(({ layout, sidebar }) => {
        document.querySelector<HTMLElement>(".studio-app")!.style.width = sidebar ? "840px" : "100%";
        document.querySelector<HTMLElement>(".studio-main")!.dataset.workspaceLayout = layout;
        document.querySelector<HTMLElement>(".workspace-view-tabs")!.hidden = layout === "split";
        document.querySelector<HTMLElement>(".studio-editor-pane")!.hidden = layout === "single";
        document.querySelector<HTMLElement>(".studio-splitter")!.hidden = layout === "single";
        document.querySelector<HTMLElement>(".studio-preview-pane")!.hidden = false;
      }, scenario);
      const label = `${width}×${height} ${layout}`;
      const bounds = await canvas.boundingBox();
      const footerBox = await footer.boundingBox();
      const windowBox = await page.locator(".studio-workspace").boundingBox();
      assert.ok(bounds && bounds.height > height * 0.4, label + " should leave room to read the sheet");
      assert.ok(windowBox && footerBox && footerBox.y + footerBox.height <= height + 1
        && Math.abs(footerBox.y + footerBox.height - windowBox.y - windowBox.height) <= 1, label + " footer should stay inside the workspace at its bottom");
      const controls = await page.locator(".preview-bottom").boundingBox();
      assert.ok(controls && controls.y >= bounds.y + bounds.height - 1
        && controls.y + controls.height <= footerBox.y + 1, label + " preview controls should fit between the canvas and footer");
      assert.ok(await canvas.locator("article").evaluate(el => {
        const canvas = el.closest(".resume-preview-canvas")!;
        canvas.scrollTop = 0;
        const first = el.getBoundingClientRect().top;
        const visible = first >= canvas.getBoundingClientRect().top && first < canvas.getBoundingClientRect().bottom;
        canvas.scrollTop = 200;
        return visible && first - el.getBoundingClientRect().top === 200 && window.scrollY === 0;
      }), label + " should show the top of the first page and scroll inside the preview");
      if (width <= 940) {
        await page.evaluate(() => {
          document.querySelector<HTMLElement>(".studio-preview-pane")!.hidden = true;
          document.querySelector<HTMLElement>(".studio-editor-pane")!.hidden = false;
        });
        const editor = page.locator(".fact-editor-scroller");
        const editorBox = await editor.boundingBox();
        assert.ok(editorBox && editorBox.height > height * 0.4 && editorBox.y + editorBox.height <= footerBox.y + 1,
          label + " should keep the editor above the footer");
        assert.ok(await editor.evaluate(el => {
          const first = el.firstElementChild!.getBoundingClientRect().top;
          el.scrollBy(0, 200);
          return first - el.firstElementChild!.getBoundingClientRect().top === 200 && window.scrollY === 0;
        }), label + " should scroll long content within the editor");
      }
    }
    assert.equal(await page.locator(".secondary-workspace").isVisible(), false);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>(".resume-workspace-body")!.hidden = true;
      document.querySelector<HTMLElement>(".secondary-workspace")!.hidden = false;
    });
    assert.equal(await page.locator(".resume-workspace-body").isVisible(), false);
    assert.equal(await page.locator(".secondary-workspace").isVisible(), true);
  } finally {
    await browser.close();
  }
});
