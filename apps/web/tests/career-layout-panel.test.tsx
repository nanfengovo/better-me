import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { setImmediate as next, setTimeout as delay } from "node:timers/promises";
import test, { after, afterEach } from "node:test";
import { Window } from "happy-dom";
import type { ProjectedResume } from "@better-me/core";
import type { CareerLayoutPanelProps } from "../src/components/CareerLayoutPanel";
import { REQUIRED_SEMANTIC_CHECKS, layoutCandidateFingerprint, mmToCssPx, finalArtifactSha256, type LayoutScope, type FinalPdfParser } from "../src/lib/layout-compiler";
import type { CareerLayoutModelAdapter } from "../src/lib/career-studio-layout";

const cssHook = registerHooks({ load(url, context, step) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : step(url, context); } });
const win = new Window({ url: "https://layout-panel-fixture.invalid" });
const React = await import("react");
const originals = new Map<string, PropertyDescriptor | undefined>();
let attemptedNetwork = 0, geometryReads = 0;
for (const [key, value] of Object.entries({ window: win, document: win.document, navigator: win.navigator, HTMLElement: win.HTMLElement,
  HTMLTextAreaElement: win.HTMLTextAreaElement, HTMLInputElement: win.HTMLInputElement, Element: win.Element, Node: win.Node, React, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => { attemptedNetwork++; throw Error("No network in synthetic layout UI fixture"); } })) {
  originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
const { default: Panel } = await import("../src/components/CareerLayoutPanel");
const scope: LayoutScope = { ownerId: "synthetic-panel-owner", sessionGeneration: 1, documentId: "synthetic-resume", revision: "1", contentHash: "synthetic-input" };
const originalClaim = "参与实现 SQLite 并发控制与回执核对机制，延迟约 10ms。";
const compactClaim = "参与实现 SQLite 并发与回执校验机制，延迟约 10ms。";
const resume: ProjectedResume = { locale: "zh", templateId: "zh-classic", profile: { displayName: "合成候选人", headline: "可靠工程实践", links: [], targetRoles: ["平台工程师"], traits: [] },
  experiences: [{ id: "p1", type: "opensource", org: "合成团队", title: "平台实践", start: "2025", end: "2026", techStack: ["SQLite"], claims: [{ id: "c1", kind: "responsibility", text: originalClaim, tags: [] }] }] };
let currentScope = scope, root: ReturnType<typeof createRoot> | undefined;
const props: CareerLayoutPanelProps = { resume, scope, getCurrentScope: () => currentScope };

/** happy-dom无排版引擎。以下提供可重复的观测矩形，只检验真实Template→DOM
 * Adapter→UI生命周期；不作为实际字体、换行、打印或浏览器视觉的验收。 */
const blockSelector = "h1,h2,h3,p,li";
function metrics(element: InstanceType<typeof win.HTMLElement>) {
  const sheet = element.closest(".resume-sheet");
  const margin = sheet ? mmToCssPx(Number.parseFloat((sheet as InstanceType<typeof win.HTMLElement>).style.padding) || 16) : 0;
  const index = sheet ? [...sheet.querySelectorAll(blockSelector)].indexOf(element) : 0;
  const font = sheet ? Number.parseFloat((sheet as InstanceType<typeof win.HTMLElement>).style.fontSize) || 10 : 10;
  const count = element.textContent?.length ?? 0, lines = Math.max(1, Math.ceil(count / 31));
  return { x: margin, y: margin + 40 + Math.max(0, index) * 44, width: Math.min(31, count) * font * 0.7, height: lines * 14, font };
}
win.HTMLElement.prototype.getBoundingClientRect = function () {
  geometryReads++;
  if (this.classList.contains("resume-sheet")) return new win.DOMRect(-10000, 0, 794, 1300);
  const measured = metrics(this); return new win.DOMRect(-10000 + measured.x, measured.y, measured.width, measured.height);
};
Object.defineProperties(win.HTMLElement.prototype, { offsetWidth: { configurable: true, get() { return (this as InstanceType<typeof win.HTMLElement>).classList.contains("resume-sheet") ? 794 : 100; } },
  offsetHeight: { configurable: true, get() { return (this as InstanceType<typeof win.HTMLElement>).classList.contains("resume-sheet") ? 1300 : 20; } } });
(win.Range.prototype as unknown as { getClientRects(): DOMRectList }).getClientRects = function () {
  geometryReads++;
  const range = this as unknown as { startOffset: number; startContainer: { parentElement: InstanceType<typeof win.HTMLElement> } };
  const block = range.startContainer.parentElement.closest(blockSelector) as InstanceType<typeof win.HTMLElement> | null;
  if (!block) return [] as unknown as DOMRectList;
  const measured = metrics(block), line = Math.floor(range.startOffset / 31), column = range.startOffset % 31;
  return [new win.DOMRect(-10000 + measured.x + column * measured.font * 0.7, measured.y + line * 14, measured.font * 0.7, 14)] as unknown as DOMRectList;
};
function fonts(ready: Promise<void> = Promise.resolve()) { Object.defineProperty(win.document, "fonts", { configurable: true, value: { ready, check: () => true } }); }
fonts();
async function settle(action = () => {}) { await React.act(async () => { action(); await next(); await next(); }); }
async function waitUntil(condition: () => boolean) { for (let index = 0; index < 200 && !condition(); index++) await React.act(async () => { await delay(10); }); assert.equal(condition(), true, "UI did not settle within the synthetic test deadline"); }
async function mount(changes: Partial<CareerLayoutPanelProps> = {}) { if (!root) { const host = win.document.createElement("div"); win.document.body.append(host); root = createRoot(host as unknown as HTMLElement); } await settle(() => root!.render(React.createElement(Panel, { ...props, ...changes }))); }
afterEach(async () => { await settle(() => { root?.unmount(); root = undefined; }); win.document.body.replaceChildren(); currentScope = scope; fonts(); geometryReads = 0; assert.equal(attemptedNetwork, 0); });
after(async () => { cssHook.deregister(); await win.happyDOM.abort(); for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } });
function button(pattern: RegExp) { const element = [...win.document.querySelectorAll("button")].find(item => pattern.test(item.textContent ?? "")); assert.ok(element, `missing button ${pattern}`); return element; }
async function click(pattern: RegExp) { await settle(() => button(pattern).click()); }
async function check(pattern: RegExp) { const label = [...win.document.querySelectorAll("label")].find(item => pattern.test(item.textContent ?? "") && item.querySelector("input[type=checkbox]")); assert.ok(label, `missing checkbox ${pattern}`); await settle(() => label.querySelector("input")!.click()); }
async function fill(pattern: RegExp, value: string) { const label = [...win.document.querySelectorAll("label")].find(item => pattern.test(item.firstChild?.textContent ?? "") && item.querySelector("input:not([type=checkbox])")); const element = label?.querySelector("input"); assert.ok(element); await settle(() => { Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new win.Event("input", { bubbles: true })); }); }
async function chooseMode(value: string) { const label = [...win.document.querySelectorAll("label")].find(item => item.textContent?.startsWith("建议模式")); const select = label?.querySelector("select"); assert.ok(select); await settle(() => { select.value = value; select.dispatchEvent(new win.Event("change", { bubbles: true })); }); }
function model(count?: { rewrites: number; reviews: number }): CareerLayoutModelAdapter {
  return { label: "合成固定模型", location: "local", runtimeBinding: "synthetic-model-context-1", rewrite: async request => { if (count) count.rewrites++; return [{ id: `compact-${request.iteration}`, baseScope: request.input.scope, replacements: [{ anchor: "claim:c1", before: originalClaim, after: compactClaim }] }]; },
    verifySemantics: async ({ input, candidate }) => { if (count) count.reviews++; return { verdict: "equivalent", method: "independent-review", verifierId: "synthetic-reviewer", scope: input.scope, candidateId: candidate.id, candidateFingerprint: layoutCandidateFingerprint(candidate), checks: REQUIRED_SEMANTIC_CHECKS, detail: "Synthetic unit fixture only" }; } };
}

test("mounting does not render extra resume images or call a model; numeric inputs allow normal clear-and-type", async () => {
  const calls = { rewrites: 0, reviews: 0 }; await mount({ model: model(calls) });
  assert.equal(win.document.querySelector(".career-layout-measurement .resume-sheet"), null); assert.equal(calls.rewrites, 0);
  await fill(/^正文字号/, ""); await click(/^生成手动布局提案$/); assert.match(win.document.body.textContent!, /必须在/);
  await fill(/^正文字号/, "11"); await click(/^生成手动布局提案$/);
  assert.ok(win.document.querySelector('[aria-label="候选差异确认"]')); assert.equal(calls.rewrites, 0);
  assert.match(win.document.body.textContent!, /最终PDF：尚未核对；最终DOCX：尚未核对/);
});

test("manual layout is genuinely re-rendered in the existing Template and cannot adopt before checkbox and review", async () => {
  let adopted = 0;
  await mount({ onAdopt: async (_candidate, context) => { adopted++; return { versionId: "business-r2", receiptId: "receipt-r2", baseScope: context.baseScope, candidateFingerprint: context.candidateFingerprint }; } });
  await fill(/^正文字号/, "11"); await click(/^生成手动布局提案$/);
  assert.equal(button(/^复测已勾选差异$/).disabled, true);
  await check(/确认这组布局参数差异/); await click(/^复测已勾选差异$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="已勾选差异的独立复测"]'));
  assert.ok(geometryReads > 30); assert.equal((win.document.querySelector(".career-layout-measurement .resume-sheet") as unknown as HTMLElement).style.fontSize, "11pt");
  assert.equal(resume.layout, undefined); assert.equal(button(/^确认采用所选差异$/).disabled, true);
  await check(/我已阅读所选差异/); await click(/^确认采用所选差异$/); await waitUntil(() => win.document.body.textContent!.includes("business-r2"));
  assert.equal(adopted, 1); assert.match(win.document.body.textContent!, /PDF与DOCX仍需分别核对/);
});

test("bounded wording proposals require consent, independent review, exact Claim diff and a new subset re-review", async () => {
  const calls = { rewrites: 0, reviews: 0 }; await mount({ model: model(calls) }); await chooseMode("wording");
  assert.equal(button(/^测量并生成建议$/).disabled, true); await check(/允许本次将简历原句/); await click(/^测量并生成建议$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="候选差异确认"]'));
  assert.equal(calls.rewrites <= 3, true); assert.ok(calls.reviews >= 1); assert.match(win.document.querySelector(".clp-text-diff")?.textContent ?? "", /claim:c1/);
  await check(/确认第1条文案差异/); const before = calls.reviews; await click(/^复测已勾选差异$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="已勾选差异的独立复测"]'));
  assert.equal(calls.reviews, before + 1); assert.match(win.document.body.textContent!, /尚未接入工作区业务版本命令/);
});

test("cancelled font readiness never produces a clean report or applies a proposal", async () => {
  fonts(new Promise(() => {})); await mount(); await fill(/^正文字号/, "11"); await click(/^生成手动布局提案$/); await check(/确认这组布局参数差异/); await click(/^复测已勾选差异$/);
  assert.ok(button(/^取消本次操作$/)); await click(/^取消本次操作$/);
  await waitUntil(() => !win.document.querySelector('[role="status"]')?.textContent?.includes("正在复测"));
  assert.equal(win.document.querySelector('[aria-label="已勾选差异的独立复测"]'), null); assert.equal(win.document.querySelector(".clp-receipt"), null);
});

test("source changes clear old proposals, and stale account leases hide the measurement root", async () => {
  await mount(); await fill(/^正文字号/, "11"); await click(/^生成手动布局提案$/); assert.ok(win.document.querySelector(".clp-proposal"));
  currentScope = { ...scope, revision: "2" }; await mount({ scope: currentScope }); assert.equal(win.document.querySelector(".clp-proposal"), null);
  currentScope = { ...scope, ownerId: "other-owner", sessionGeneration: 2 }; await mount();
  assert.equal(win.document.querySelector(".career-layout-measurement"), null); assert.match(win.document.body.textContent!, /旧候选未展示/);
});

test("missing or mismatched adoption receipts lock this original version against automatic retry", async () => {
  let attempts = 0;
  await mount({ onAdopt: async () => { attempts++; return undefined; } }); await fill(/^正文字号/, "11"); await click(/^生成手动布局提案$/); await check(/确认这组布局参数差异/); await click(/^复测已勾选差异$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="已勾选差异的独立复测"]')); await check(/我已阅读所选差异/); await click(/^确认采用所选差异$/);
  await waitUntil(() => win.document.body.textContent!.includes("未取得绑定所选差异的版本回执"));
  assert.equal(attempts, 1); assert.equal(button(/^确认采用所选差异$/).disabled, true); assert.equal(win.document.querySelector(".clp-receipt"), null);
});

test("measurement CSS remains print-sized and observable, inert and excluded from actual printing", () => {
  const css = readFileSync(new URL("../src/components/CareerLayoutPanel.css", import.meta.url), "utf8");
  const measurementRule = /\.career-layout-measurement\s*\{([^}]+)\}/.exec(css)?.[1] ?? "";
  assert.match(measurementRule, /width: 210mm/); assert.match(measurementRule, /content-visibility: visible/);
  assert.equal(/display:\s*none|visibility:\s*hidden/.test(measurementRule), false);
  assert.match(css, /@media print.*display: none !important/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /:focus-visible/);
});

function finalFileFixture() {
  const calls: Parameters<NonNullable<CareerLayoutPanelProps["exportFinalArtifact"]>>[0][] = [];
  const pdf = new TextEncoder().encode("%PDF-1.7 SYNTHETIC_UI_ENVELOPE_ONLY"), docx = new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 1]);
  // Geometry is an explicit UI-only Adapter fixture, not actual browser PDF
  // evidence. layout-compiler-pdfjs-final.test.ts exercises real final PDF bytes.
  const parser: FinalPdfParser = async (_bytes, expected) => ({ parser: { name: "Synthetic UI lifecycle fixture", version: "1" }, pageCount: 1,
    bodyText: expected.bodyText, links: [...expected.links], fontChecks: [], limitations: ["UI geometry fixture, NOT real final-file acceptance"],
    blocks: expected.blocks.map((block, index) => ({ ...block, order: index, pageNumber: 1, rect: { x: 0, y: index * 24, width: 300, height: 16 },
      lines: [{ rect: { x: 0, y: index * 24, width: 300, height: 16 }, text: block.text }] })) });
  const exportFinalArtifact: NonNullable<CareerLayoutPanelProps["exportFinalArtifact"]> = async request => {
    calls.push(request); return { operationId: request.operationId, format: request.format, scope: request.scope, renderBinding: request.renderBinding,
      artifact: request.format === "pdf" ? { bytes: pdf, sha256: await finalArtifactSha256(pdf), filename: "synthetic-final.pdf" }
        : { bytes: docx, sha256: await finalArtifactSha256(docx), filename: "synthetic-final.docx" },
      ...(request.format === "docx" ? { renderedPdf: { bytes: pdf, sha256: await finalArtifactSha256(pdf), filename: "synthetic-docx-pagination.pdf" } } : {}),
      receipt: { id: `synthetic-${request.format}-receipt`, renderer: { name: "Synthetic UI exporter", version: "1" }, renderedAt: "2026-11-09T00:00:00Z" } };
  };
  return { calls, parser, exportFinalArtifact };
}

test("final PDF and DOCX have independent actual-file states, separate consent and hashes, never silently replacing DOM estimates", async () => {
  const fixture = finalFileFixture(); await mount({ exportFinalArtifact: fixture.exportFinalArtifact, finalPdfParser: fixture.parser });
  assert.equal(fixture.calls.length, 0); assert.equal(button(/^生成并检查PDF$/).disabled, true);
  await check(/允许本次调用接入的受信导出器/); await click(/^生成并检查PDF$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="最终PDF诊断"] [aria-label="最终PDF页级观察"]'));
  assert.equal(fixture.calls.length, 1); assert.equal(fixture.calls[0]!.candidate, undefined); assert.deepEqual(fixture.calls[0]!.resume, resume);
  const pdf = win.document.querySelector('[aria-label="最终PDF诊断"]')!, docx = win.document.querySelector('[aria-label="最终DOCX诊断"]')!;
  assert.match(pdf.textContent!, /实际1页/); assert.match(pdf.textContent!, /视觉：尚未核对/); assert.match(pdf.textContent!, /字符\/链接核对一致/);
  assert.match(docx.textContent!, /未执行该格式/); assert.match(win.document.body.textContent!, /最终DOCX：尚未核对/);
  assert.equal(button(/^生成并检查DOCX$/).disabled, true, "consent is consumed by the first file operation");
  await check(/允许本次调用接入的受信导出器/); await click(/^生成并检查DOCX$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="最终DOCX页级观察"]'));
  assert.equal(fixture.calls.length, 2); assert.match(pdf.textContent!, /synthetic-pdf-receipt/); assert.match(docx.textContent!, /DOCX分页PDF SHA-256/);
  assert.ok(button(/^下载本次实际PDF文件$/)); assert.ok(button(/^下载本次实际DOCX文件$/)); assert.ok(button(/^下载本次DOCX分页PDF$/));
  assert.equal(resume.layout, undefined); assert.match(win.document.body.textContent!, /绝不把DOM估算改名为最终文件通过/);
});

test("final output of a reviewed subset uses that exact candidate without adopting or writing the original resume", async () => {
  const fixture = finalFileFixture(); let adopted = 0;
  await mount({ exportFinalArtifact: fixture.exportFinalArtifact, finalPdfParser: fixture.parser, onAdopt: async () => { adopted++; } });
  await fill(/^正文字号/, "11"); await click(/^生成手动布局提案$/); await check(/确认这组布局参数差异/); await click(/^复测已勾选差异$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="已勾选差异的独立复测"]'));
  const select = [...win.document.querySelectorAll("select")].find(element => element.parentElement?.textContent?.startsWith("最终文件检查对象"))!;
  await settle(() => { select.value = "selection"; select.dispatchEvent(new win.Event("change", { bubbles: true })); });
  await check(/允许本次调用接入的受信导出器/); await click(/^生成并检查PDF$/); await waitUntil(() => fixture.calls.length === 1 && !!win.document.querySelector('[aria-label="最终PDF页级观察"]'));
  const request = fixture.calls[0]!; assert.ok(request.candidate); assert.equal(request.resume.layout!.bodyFontSize, 11); assert.equal(request.renderBinding.fingerprint, layoutCandidateFingerprint(request.candidate));
  assert.equal(adopted, 0); assert.equal(resume.layout, undefined); assert.match(win.document.querySelector('[aria-label="最终PDF诊断"]')!.textContent!, /已复测候选（未因此采用）/);
});

test("final-byte integrity mismatch is visible; a cancelled second format cannot overwrite the first format's observation", async () => {
  const fixture = finalFileFixture(); let hangDocx = false;
  await mount({ finalPdfParser: async (bytes, expected, signal) => ({ ...await fixture.parser(bytes, expected, signal), bodyText: expected.bodyText.replace("10ms", "100ms") }),
    exportFinalArtifact: request => request.format === "docx" && hangDocx ? new Promise(() => {}) : fixture.exportFinalArtifact(request) });
  await check(/允许本次调用接入的受信导出器/); await click(/^生成并检查PDF$/);
  await waitUntil(() => !!win.document.querySelector('[aria-label="最终PDF页级观察"]'));
  assert.match(win.document.querySelector('[aria-label="最终PDF诊断"]')!.textContent!, /发现不一致，未通过完整性核对/);
  hangDocx = true; await check(/允许本次调用接入的受信导出器/); await click(/^生成并检查DOCX$/); await click(/^取消本次操作$/);
  await waitUntil(() => win.document.querySelector('[aria-label="最终DOCX诊断"]')!.textContent!.includes("已取消"));
  assert.ok(win.document.querySelector('[aria-label="最终PDF页级观察"]')); assert.equal(win.document.querySelector('[aria-label="最终DOCX页级观察"]'), null);
});

test("a callback with mismatched source provenance cannot turn uploaded metrics into a final-file success", async () => {
  const fixture = finalFileFixture(); await mount({ finalPdfParser: fixture.parser,
    exportFinalArtifact: async request => ({ ...await fixture.exportFinalArtifact(request), renderBinding: { ...request.renderBinding, fingerprint: "foreign-file" } }) });
  await check(/允许本次调用接入的受信导出器/); await click(/^生成并检查PDF$/);
  await waitUntil(() => win.document.querySelector('[aria-label="最终PDF诊断"]')!.textContent!.includes("观察不可用"));
  assert.equal(win.document.querySelector('[aria-label="最终PDF页级观察"]'), null); assert.equal([...win.document.querySelectorAll("button")].some(item => /^下载本次实际/.test(item.textContent ?? "")), false);
});
