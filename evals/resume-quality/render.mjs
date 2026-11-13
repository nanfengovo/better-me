import { createRequire } from "node:module";
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { ResumeTemplate } from "../../apps/web/src/components/ResumeTemplate.tsx";
import { getResumePrintCss } from "../../apps/web/src/lib/resume-print.ts";
import { getResumeLayout } from "../../packages/core/src/schema/resume.ts";

// Resolve the existing Web runtime; no new browser/React dependency or substitute template.
const requireWeb = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { createElement } = requireWeb("react");
const { renderToStaticMarkup } = requireWeb("react-dom/server");
const { chromium } = requireWeb("playwright-core");
const compact = text => text.normalize("NFKC").replace(/\s/g, "");

/** Creates an actual production-template PDF in an isolated offline browser. Never clips to page 1. */
export async function renderResumeQuality(resume, outputFile) {
  const css = await fs.readFile(new URL("../../apps/web/src/components/resume-paper.css", import.meta.url), "utf8");
  const pdfjs = await import(pathToFileURL(requireWeb.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);
  const margin = Math.max(12, Math.min(28, getResumeLayout(resume.layout).pageMargin));
  const browser = await chromium.launch({ headless: true, channel: process.platform === "win32" ? "msedge" : "chrome" });
  try {
    const page = await browser.newPage({ offline: true, viewport: { width: Math.round((210 - 2 * margin) * 96 / 25.4), height: 1123 } });
    let blockedRequests = 0;
    await page.route("**/*", route => { blockedRequests++; return route.abort(); });
    await page.emulateMedia({ media: "print", reducedMotion: "reduce" });
    const markup = renderToStaticMarkup(createElement(ResumeTemplate, { resume, templateId: resume.templateId }));
    await page.setContent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0;padding:0}${css}${getResumePrintCss(resume)}</style>${markup}`);
    await page.evaluate(() => document.fonts.ready);
    const dom = await page.evaluate(() => {
      const paper = document.querySelector(".resume-paper") ?? document.body;
      const rect = paper.getBoundingClientRect();
      const overflowing = [...paper.querySelectorAll("*")].filter(element => {
        const r = element.getBoundingClientRect(); return r.width > 0 && (r.left < rect.left - 1 || r.right > rect.right + 1);
      }).map(element => ({ tag: element.tagName, anchor: element.getAttribute("data-preview-anchor"), text: element.textContent }));
      const leadIns = [...paper.querySelectorAll(".resume-experience")].map(element => ({
        heading: element.querySelector(".resume-experience-heading h3")?.textContent ?? "",
        firstBody: [...element.querySelectorAll(".resume-claims>li")].find(li => !li.matches(".resume-claim-subheading,.resume-claim-project-title,.resume-claim-meta"))?.textContent ?? "",
      }));
      return { overflowing, leadIns };
    });
    const bytes = await page.pdf({ preferCSSPageSize: true, displayHeaderFooter: false, printBackground: true });
    if (outputFile) await fs.writeFile(outputFile, bytes, { flag: "wx" });
    const load = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
      const pdf = await load.promise, pages = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const p = await pdf.getPage(n), viewport = p.getViewport({ scale: 1 }), content = await p.getTextContent();
        const items = content.items.filter(item => "str" in item && item.str.trim());
        const ys = items.map(item => item.transform[5]);
        const top = ys.length ? Math.max(...ys) : 0, bottom = ys.length ? Math.min(...ys) : 0;
        const clippedText = items.filter(item => item.transform[4] < -1 || item.transform[4] + item.width > viewport.width + 1
          || item.transform[5] < -1 || item.transform[5] + item.height > viewport.height + 1)
          .map(item => ({ text: item.str, x: item.transform[4], baselineY: item.transform[5], width: item.width, height: item.height }));
        pages.push({ number: n, widthPt: viewport.width, heightPt: viewport.height, clippedText,
          text: items.map(item => item.str).join(""),
          // Vertical occupation, not an aesthetic quality score or character-count proxy.
          verticalOccupation: ys.length ? Number(((top - bottom) / ((297 - 2 * margin) * 72 / 25.4)).toFixed(4)) : 0 });
      }
      const all = compact(pages.map(p => p.text).join(""));
      const missingClaims = resume.experiences.flatMap(e => e.claims).filter(c => compact(c.text) && !all.includes(compact(c.text)))
        .map(c => ({ claimId: c.id, text: c.text }));
      const orphanHeadings = dom.leadIns.filter(entry => {
        if (!entry.heading || !entry.firstBody) return false;
        const headingPages = pages.filter(p => compact(p.text).includes(compact(entry.heading))).map(p => p.number);
        const bodyPages = pages.filter(p => compact(p.text).includes(compact(entry.firstBody))).map(p => p.number);
        return headingPages.length && bodyPages.length && !headingPages.some(n => bodyPages.includes(n));
      });
      const a4 = pages.every(p => Math.abs(p.widthPt - 595.28) < 2 && Math.abs(p.heightPt - 841.89) < 2);
      const passed = pages.length === 1 && a4 && !missingClaims.length && !orphanHeadings.length && !dom.overflowing.length && pages.every(p => !p.clippedText.length) && blockedRequests === 0;
      return { rendererVersion: "production-resume-a4-v1", passed, pageCount: pages.length, a4,
        marginMm: margin, pages, missingClaims, orphanHeadings, horizontalOverflow: dom.overflowing, blockedRequests,
        limitations: ["Orphan detection compares actual PDF pages for each unique experience heading and first body bullet; ambiguous repeated text needs visual review.",
          "PDF text extraction and horizontal geometry detect missing text/overflow, not every visual overlap; retain the complete PDF for inspection.",
          "Vertical occupation reports the printed text span within available A4 height; it is not a fabricated ideal-density score."] };
    } finally { await load.destroy(); }
  } finally { await browser.close(); }
}
