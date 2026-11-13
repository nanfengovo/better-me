/** @jsxRuntime automatic */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { chromium } from "playwright-core";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectedResume } from "@better-me/core";
import { ResumeTemplate } from "../src/components/ResumeTemplate";
import { getResumePrintCss } from "../src/lib/resume-print";

// Render the same paper markup, print rules and selected A4 margins as Preview.
// A real PDF page boundary is not observable in a DOM screenshot.
test("an experience and its lead-in labels stay with the first actual bullet on A4; the rest can span pages", { timeout: 45_000 }, async t => {
  const resume: ProjectedResume = {
    locale: "zh", templateId: "zh-classic", layout: { pageMargin: 16 },
    profile: { displayName: "Print fixture", targetRoles: [], traits: [], links: [] },
    experiences: [
      { id: "previous", type: "work", org: "PreviousLab", title: "Role A", start: "2021-01", end: "2022-01", techStack: [],
        claims: [{ id: "previous-claim", kind: "action", text: "Earlier evidence.", tags: [] }] },
      {
        id: "target", type: "work", org: "TargetLab", title: "Role B", start: "2020-01", end: "2020-12", techStack: [],
        claims: ["内容：", "核心项目：LabelOnly", "DeliveredFirstEvidence.", ...Array.from({ length: 72 }, (_, i) => `Traceable contribution EvidenceMarker${i}.`)]
          .map((text, i) => ({ id: `bullet-${i}`, kind: "action" as const, text, tags: [] })),
      },
    ],
  };
  const paper = await readFile(new URL("../src/components/resume-paper.css", import.meta.url), "utf8");
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : "chrome" });
  try {
    // No persistent profile, URLs, user data, app server, or external fonts.
    const page = await browser.newPage({ offline: true, viewport: { width: Math.round((210 - 32) * 96 / 25.4), height: 1123 } });
    await page.emulateMedia({ media: "print" });
    for (const previousHasBody of [true, false]) {
      await t.test(previousHasBody ? "after an ordinary experience" : "after a heading-only experience", async () => {
        if (!previousHasBody) resume.experiences[0]!.claims = [];
        const markup = renderToStaticMarkup(<ResumeTemplate resume={resume} templateId="zh-classic" />);
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}${paper}${getResumePrintCss(resume)}</style>${markup}`);
        // Leave room for the company and labels but not the first body line.
        // Calibrate from fonts actually on this system; never force a page break.
        await page.evaluate(() => {
          const previous = document.querySelector<HTMLElement>('[data-preview-anchor="experience:previous"]')!;
          const label = document.querySelector<HTMLElement>('[data-preview-anchor="claim:bullet-1"]')!;
          const pageHeight = (297 - 32) * 96 / 25.4;
          previous.style.height = `${previous.getBoundingClientRect().height + pageHeight - label.getBoundingClientRect().bottom - 3}px`;
        });
        const bytes = await page.pdf({ preferCSSPageSize: true, displayHeaderFooter: false, printBackground: true });
        const load = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
        try {
          const pdf = await load.promise;
          const pages: string[] = [];
          for (let number = 1; number <= pdf.numPages; number++) {
            const current = await pdf.getPage(number);
            const { width, height } = current.getViewport({ scale: 1 });
            assert.ok(Math.abs(width - 595) < 2 && Math.abs(height - 842) < 2, "printed PDF must be A4");
            const content = await current.getTextContent();
            pages.push(content.items.map(item => "str" in item ? item.str : "").join("").replace(/\s+/g, ""));
          }
          assert.match(pages[0]!, /PreviousLab/);
          assert.doesNotMatch(pages[0]!, /TargetLab|LabelOnly|DeliveredFirstEvidence/);
          assert.match(pages[1]!, /TargetLab.*LabelOnly.*DeliveredFirstEvidence/);
          assert.ok(pages.length >= 3, "long experience should continue across pages");
          assert.match(pages.at(-1)!, /EvidenceMarker71/);
          assert.deepEqual([...pages.join("").matchAll(/EvidenceMarker(\d+)\./g)].map(match => Number(match[1])), Array.from({ length: 72 }, (_, i) => i));
        } finally { await load.destroy(); }
      });
    }
  } finally { await browser.close(); }
});
