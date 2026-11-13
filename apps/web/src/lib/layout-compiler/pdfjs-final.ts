/// <reference types="vite/client" />
import type { PDFOperatorList, PDFPageProxy, TextItem } from "pdfjs-dist/types/src/display/api";
import { FINAL_LAYOUT_LIMITS, normalizeFinalLayoutBody, type FinalLayoutExpectedDocument, type FinalPdfParser } from "./final-artifact";
import { mmToCssPx, printGeometry, type LayoutBlock, type LayoutLine, type LayoutRect } from "./types";

type PdfJsSdk = Pick<typeof import("pdfjs-dist"), "getDocument" | "Util" | "OPS" | "version">;
type Matrix = [number, number, number, number, number, number];
interface TextAtom { text: string; rect: LayoutRect; pageNumber: number; order: number; start: number; end: number }
const matrix = (value: unknown): value is Matrix => Array.isArray(value) && value.length === 6 && value.every(item => typeof item === "number" && Number.isFinite(item));
const union = (rects: readonly LayoutRect[]): LayoutRect => {
  const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
  return { x, y, width: Math.max(...rects.map(rect => rect.x + rect.width)) - x, height: Math.max(...rects.map(rect => rect.y + rect.height)) - y };
};

const loadBrowserPdfJs = async (): Promise<PdfJsSdk> => {
  const sdk = await import("pdfjs-dist");
  if (typeof window !== "undefined") {
    const { default: workerUrl } = await import("pdfjs-dist/build/pdf.worker.min.mjs?url");
    sdk.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return sdk;
};

function visualLines(atoms: readonly TextAtom[]): LayoutLine[] {
  const lines: { atoms: TextAtom[]; rect: LayoutRect }[] = [];
  for (const atom of atoms) {
    const candidate = lines.find(line => Math.abs(line.rect.y - atom.rect.y) <= Math.max(1.2, Math.min(line.rect.height, atom.rect.height) * .12)
      && atom.rect.x <= line.rect.x + line.rect.width + Math.max(10, atom.rect.height)
      && atom.rect.x + atom.rect.width >= line.rect.x - Math.max(10, atom.rect.height));
    if (candidate) { candidate.atoms.push(atom); candidate.rect = union(candidate.atoms.map(item => item.rect)); }
    else lines.push({ atoms: [atom], rect: { ...atom.rect } });
  }
  return lines.map(line => ({ rect: line.rect, text: line.atoms.sort((a, b) => a.order - b.order).map(atom => atom.text).join("") }));
}

function textBlocks(atoms: readonly TextAtom[], expected: FinalLayoutExpectedDocument, bodyText: string, limitations: Set<string>): LayoutBlock[] {
  const normalizedBody = normalizeFinalLayoutBody(bodyText), matches = expected.blocks.flatMap((block, index) => {
    const normalized = normalizeFinalLayoutBody(block.text); if (!normalized) return [];
    const start = normalizedBody.indexOf(normalized);
    if (start < 0 || normalizedBody.indexOf(normalized, start + 1) >= 0) return [];
    return [{ block, index, start, end: start + normalized.length }];
  });
  const groups = new Map<string, { atoms: TextAtom[]; match?: typeof matches[number] }>();
  for (const atom of atoms) {
    const candidates = matches.filter(match => atom.start >= match.start && atom.end <= match.end);
    const match = candidates.length === 1 ? candidates[0] : undefined;
    const key = match ? `${atom.pageNumber}:${match.index}` : `unmatched:${atom.pageNumber}:${atom.order}`;
    let group = groups.get(key); if (!group) { group = { atoms: [], ...(match ? { match } : {}) }; groups.set(key, group); } group.atoms.push(atom);
  }
  if (matches.length < expected.blocks.length) limitations.add("部分源文本块在最终文件中未能唯一定位；相应几何不冒充精确Claim引用，完整性结果另列。");
  return [...groups.entries()].map(([key, group]) => {
    const lines = visualLines(group.atoms), source = group.match?.block;
    return { id: `final:${key}`, ...(source?.anchor ? { anchor: source.anchor } : {}), kind: source?.kind ?? "text", order: group.atoms[0]!.order,
      text: group.atoms.map(atom => atom.text).join(""), rect: union(lines.map(line => line.rect)), lines, pageNumber: group.atoms[0]!.pageNumber,
      ...(source?.keepTogether ? { keepTogether: true } : {}), ...(source?.keepWithNext ? { keepWithNext: true } : {}) };
  });
}

/** Read actual PDF graphics-state transforms, not guessed avatar positions.
 * Unsupported annotation/image transforms fail closed instead of adding a fake
 * page-sized image that would suppress orphan-page diagnostics. */
async function imageBlocks(sdk: PdfJsSdk, viewport: ReturnType<PDFPageProxy["getViewport"]>, pageNumber: number,
  margins: { x: number; y: number }, signal: AbortSignal, list: PDFOperatorList): Promise<LayoutBlock[]> {
  signal.throwIfAborted();
  if (list.fnArray.length > FINAL_LAYOUT_LIMITS.operators) throw new Error("PDF图形操作超出有界预算。");
  const images = new Set([sdk.OPS.paintImageXObject, sdk.OPS.paintInlineImageXObject, sdk.OPS.paintImageMaskXObject, sdk.OPS.paintSolidColorImageMask,
    sdk.OPS.paintImageXObjectRepeat, sdk.OPS.paintImageMaskXObjectRepeat, sdk.OPS.paintInlineImageXObjectGroup, sdk.OPS.paintImageMaskXObjectGroup]);
  if (!list.fnArray.some(operator => images.has(operator))) return [];
  let transform = [...viewport.transform] as Matrix;
  const stack: Matrix[] = [], blocks: LayoutBlock[] = [];
  const multiply = (next: Matrix) => { transform = sdk.Util.transform(transform, next) as Matrix; };
  const push = () => { if (stack.length > 128) throw new Error("PDF图形状态深度超出预算。"); stack.push([...transform]); };
  const pop = () => { const value = stack.pop(); if (!value) throw new Error("PDF图形状态栈无效。"); transform = value; };
  const add = (extra?: Matrix) => {
    if (blocks.length >= FINAL_LAYOUT_LIMITS.images) throw new Error("PDF图像数量超出预算。");
    const current = extra ? sdk.Util.transform(transform, extra) as Matrix : transform;
    const points = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => ({ x: current[0] * x! + current[2] * y! + current[4] - margins.x,
      y: current[1] * x! + current[3] * y! + current[5] - margins.y, width: 0, height: 0 }));
    const rect = union(points); if (rect.width <= 0 || rect.height <= 0) return;
    blocks.push({ id: `final-image:${pageNumber}:${blocks.length + 1}`, kind: "image", text: "", rect, lines: [], order: 1_000_000 + blocks.length, pageNumber });
  };
  for (let index = 0; index < list.fnArray.length; index++) {
    if (index % 100 === 0) signal.throwIfAborted();
    const op = list.fnArray[index], args: unknown[] = list.argsArray[index] ?? [];
    if (op === sdk.OPS.save) push();
    else if (op === sdk.OPS.restore) pop();
    else if (op === sdk.OPS.transform) { if (!matrix(args)) throw new Error("PDF变换无效。"); multiply(args); }
    else if (op === sdk.OPS.paintFormXObjectBegin) { push(); if (args[0] !== null) { if (!matrix(args[0])) throw new Error("PDF Form变换不可用。"); multiply(args[0]); } }
    else if (op === sdk.OPS.paintFormXObjectEnd) pop();
    else if (op === sdk.OPS.beginGroup) {
      push(); const value = args[0] as { matrix?: unknown } | undefined;
      if (value?.matrix !== undefined && value.matrix !== null) { if (!matrix(value.matrix)) throw new Error("PDF Group变换不可用。"); multiply(value.matrix); }
    } else if (op === sdk.OPS.endGroup) pop();
    else if (op === sdk.OPS.beginAnnotation || op === sdk.OPS.endAnnotation) throw new Error("含图像的注释变换尚不支持精确观测。");
    else if (op === sdk.OPS.paintImageXObjectRepeat || op === sdk.OPS.paintImageMaskXObjectRepeat) {
      const mask = op === sdk.OPS.paintImageMaskXObjectRepeat, positions = args[mask ? 5 : 3], values = mask ? [args[1], args[2], args[3], args[4]] : [args[1], 0, 0, args[2]];
      if (!values.every(value => typeof value === "number" && Number.isFinite(value)) || !(Array.isArray(positions) || ArrayBuffer.isView(positions))) throw new Error("PDF重复图像变换不可用。");
      const coordinates = Array.from(positions as ArrayLike<number>);
      if (coordinates.length % 2 || coordinates.some(value => !Number.isFinite(value))) throw new Error("PDF重复图像坐标无效。");
      for (let offset = 0; offset < coordinates.length; offset += 2) add([...values, coordinates[offset], coordinates[offset + 1]] as Matrix);
    } else if (op === sdk.OPS.paintInlineImageXObjectGroup || op === sdk.OPS.paintImageMaskXObjectGroup) {
      const group = args[op === sdk.OPS.paintInlineImageXObjectGroup ? 1 : 0];
      if (!Array.isArray(group)) throw new Error("PDF图像组变换不可用。");
      for (const item of group as { transform?: unknown }[]) { if (!matrix(item.transform)) throw new Error("PDF图像组变换无效。"); add(item.transform); }
    } else if (images.has(op!)) add();
  }
  if (stack.length) throw new Error("PDF图形状态栈未闭合。");
  return blocks;
}

/** Type3 subsets emitted by Chromium/Skia legitimately have no TextStyle
 * ascent. PDF.js exposes their exact embedded FontBBox/FontMatrix after the
 * operator-list dependencies resolve. Feature-detect and transform those values;
 * do not substitute an arbitrary ascent, DOM box, system font or pixel claim.
 * This uses the installed PDF.js 6 FontFaceObject seam and fails closed if that
 * SDK seam or the actual embedded metrics are absent/invalid in another version. */
function type3VerticalBounds(page: PDFPageProxy, fontName: string, sdk: PdfJsSdk, transform: number[]): { top: number; height: number } | undefined {
  let font: unknown; try { font = page.commonObjs.get(fontName); } catch { return undefined; }
  if (!font || typeof font !== "object") return undefined;
  const source = font as { isType3Font?: unknown; bbox?: unknown; fontMatrix?: unknown };
  const bbox = source.bbox;
  if (source.isType3Font !== true || !Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(value => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1_000_000)
    || bbox[2] <= bbox[0] || bbox[3] <= bbox[1] || !matrix(source.fontMatrix)) return undefined;
  const combined = sdk.Util.transform(transform, source.fontMatrix), ys = [[bbox[0], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[1]], [bbox[2], bbox[3]]]
    .map(([x, y]) => combined[1]! * x! + combined[3]! * y! + combined[5]!);
  const top = Math.min(...ys), height = Math.max(...ys) - top, em = Math.hypot(transform[2]!, transform[3]!);
  if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0 || height > em * 4) return undefined;
  return { top, height };
}

/** Production parser always consumes bytes with the installed PDF.js engine;
 * the injected SDK seam allows Node tests to use the same actual engine with its
 * local worker. No UI/API accepts text boxes or arbitrary measured-page JSON. */
export function createPdfJsFinalParser(loadSdk: () => Promise<PdfJsSdk> = loadBrowserPdfJs): FinalPdfParser {
  return async (bytes, expected, signal) => {
    signal.throwIfAborted(); const sdk = await loadSdk(); signal.throwIfAborted();
    const loading = sdk.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: false, enableXfa: false,
      stopAtErrors: true, useWorkerFetch: false, disableAutoFetch: true, disableRange: true, disableStream: true, verbosity: 0 });
    const abort = () => { void loading.destroy().catch(() => {}); }; signal.addEventListener("abort", abort, { once: true });
    try {
      const document = await loading.promise; signal.throwIfAborted();
      if (document.numPages < 1 || document.numPages > FINAL_LAYOUT_LIMITS.pages) throw new Error("实际PDF页数超出检查范围。");
      const geometry = printGeometry(expected.page), margins = { x: mmToCssPx(expected.page.marginMm.left), y: mmToCssPx(expected.page.marginMm.top) };
      const atoms: TextAtom[] = [], pictures: LayoutBlock[] = [], parts: string[] = [], links: string[] = [], limitations = new Set<string>();
      const fonts = new Map<string, { descriptor: string; available: boolean }>();
      let offset = 0, order = 0, textItems = 0, characters = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
        signal.throwIfAborted(); const page = await document.getPage(pageNumber); signal.throwIfAborted();
        const viewport = page.getViewport({ scale: 96 / 72 });
        if (Math.abs(viewport.width - geometry.paperWidth) > 2 || Math.abs(viewport.height - geometry.paperHeight) > 2) throw new Error("实际PDF纸张尺寸与本次打印范围不符；混合/旋转纸张不能套用单页模板。");
        const text = await page.getTextContent({ disableNormalization: true }); signal.throwIfAborted();
        // Resolves the exact embedded font objects as well as image operators.
        // Reuse this real list rather than executing a second render or fetch.
        const operators = await page.getOperatorList(); signal.throwIfAborted();
        if (operators.fnArray.length > FINAL_LAYOUT_LIMITS.operators) throw new Error("PDF图形操作超出有界预算。");
        for (const item of text.items) {
          if (!("str" in item)) continue; const value: TextItem = item;
          if (++textItems > FINAL_LAYOUT_LIMITS.textItems || (characters += value.str.length) > FINAL_LAYOUT_LIMITS.bodyCharacters) throw new Error("PDF文本观察预算已达到上限。");
          if (!value.str) continue;
          if (!matrix(value.transform) || !Number.isFinite(value.width) || value.width < 0) throw new Error("PDF文本变换不可用。");
          const tx = sdk.Util.transform(viewport.transform, value.transform), style = text.styles[value.fontName];
          if (!style || style.vertical || Math.abs(Math.atan2(tx[1]!, tx[0]!)) > .01) throw new Error("竖排、旋转或缺少字体度量的文本尚不能精确诊断。");
          const fontHeight = Math.hypot(tx[2]!, tx[3]!), ascent = style.ascent;
          if (!Number.isFinite(fontHeight) || fontHeight <= 0) throw new Error("最终PDF字体度量不足，不能编造文本矩形。");
          const type3 = !Number.isFinite(ascent) || ascent <= 0 || ascent > 1.5 ? type3VerticalBounds(page, value.fontName, sdk, tx) : undefined;
          if ((!Number.isFinite(ascent) || ascent <= 0 || ascent > 1.5) && !type3) throw new Error("最终PDF字体度量不足，不能编造文本矩形。");
          if (type3) limitations.add("部分Chromium Type3字体没有TextStyle ascent；其纵向范围来自该最终PDF实际嵌入字体的FontBBox和FontMatrix，不是默认上升量或DOM代填，也不是逐像素字形认证。");
          fonts.set(value.fontName, { descriptor: `${value.fontName}: ${style.fontFamily} (PDF text metrics, not a font-fallback certification)`, available: true });
          const normalized = normalizeFinalLayoutBody(value.str); parts.push(value.str);
          if (normalized) atoms.push({ text: value.str, rect: { x: tx[4]! - margins.x, y: (type3?.top ?? tx[5]! - fontHeight * ascent) - margins.y, width: value.width * viewport.scale, height: type3?.height ?? fontHeight },
            pageNumber, order: order++, start: offset, end: offset + normalized.length });
          offset += normalized.length;
        }
        for (const annotation of await page.getAnnotations({ intent: "any" }) as { subtype?: unknown; url?: unknown; unsafeUrl?: unknown; dest?: unknown }[]) {
          if (annotation.subtype !== "Link") continue;
          if (typeof annotation.url === "string") links.push(annotation.url);
          else if (typeof annotation.unsafeUrl === "string") links.push(annotation.unsafeUrl);
          else if (annotation.dest !== undefined) limitations.add("内部PDF跳转不是外部URI，尚未作为源href完整性通过证据。");
          if (links.length > FINAL_LAYOUT_LIMITS.links) throw new Error("PDF链接数量超出预算。");
        }
        pictures.push(...await imageBlocks(sdk, viewport, pageNumber, margins, signal, operators));
        if (pictures.length > FINAL_LAYOUT_LIMITS.images) throw new Error("PDF图像总量超出预算。");
        page.cleanup();
      }
      signal.throwIfAborted(); const bodyText = parts.join("");
      if (!atoms.length) throw new Error("最终PDF没有可观测文本；未用OCR猜测或DOM内容代填。");
      if (/[\ufb00-\ufb06\u2f00-\u2fd5]/u.test(bodyText)) limitations.add("该PDF的原始提取文本包含标准排版连字或康熙部首；仅在正文对照和锚点定位时对FB00–FB06/2F00–2FD5使用对称Unicode兼容分解。原始文本未由源稿倒填，未对全角、圈数字、罗马数字、单位或其他实体作通用NFKC修复。");
      const blocks = [...textBlocks(atoms, expected, bodyText, limitations), ...pictures].sort((left, right) => left.pageNumber! - right.pageNumber! || left.order - right.order);
      if (blocks.length > FINAL_LAYOUT_LIMITS.blocks) throw new Error("最终PDF文本块数量超出预算。");
      limitations.add("文本矩形来自最终PDF中的变换、字宽和字体上升量，不是逐像素字形边界；图像裁剪与复杂矢量装饰仍需视觉核对。");
      return { parser: { name: "PDF.js final-byte parser", version: sdk.version }, pageCount: document.numPages, blocks, bodyText, links,
        fontChecks: [...fonts.values()], limitations: [...limitations] };
    } finally { signal.removeEventListener("abort", abort); await loading.destroy().catch(() => {}); }
  };
}

export const parseFinalPdfBytes: FinalPdfParser = createPdfJsFinalParser();
