import { diagnoseLayout } from "./diagnostics";
import {
  sameLayoutScope, printGeometry, type LayoutBlock, type LayoutDiagnosis, type LayoutRenderBinding,
  type LayoutScope, type PrintPageSpec, type MeasuredLayout,
} from "./types";

export type FinalLayoutFormat = "pdf" | "docx";
export interface FinalLayoutExportContext {
  operationId: string;
  format: FinalLayoutFormat;
  scope: LayoutScope;
  renderBinding: LayoutRenderBinding;
}
export interface FinalLayoutArtifactBytes {
  bytes: Uint8Array;
  sha256: string;
  filename: string;
}
/** Only a trusted exporter/Host Adapter returns this envelope. There is no file
 * upload, user-entered geometry, model-provided receipt, path or URL to fetch. */
export interface FinalLayoutExportArtifact extends FinalLayoutExportContext {
  artifact: FinalLayoutArtifactBytes;
  /** Mandatory for DOCX; the Host must render these exact DOCX bytes to this PDF. */
  renderedPdf?: FinalLayoutArtifactBytes;
  receipt: { id: string; renderer: { name: string; version: string }; renderedAt: string };
}
export interface FinalLayoutExpectedBlock {
  id: string;
  anchor?: string;
  kind: "heading" | "claim" | "text";
  text: string;
  keepWithNext?: boolean;
  keepTogether?: boolean;
}
export interface FinalLayoutExpectedDocument {
  page: PrintPageSpec;
  /** Full text of the authorized source renderer, NOT text read back from the
   * produced file. Per-format serializer differences must remain mismatches. */
  bodyText: string;
  blocks: readonly FinalLayoutExpectedBlock[];
  links: readonly string[];
}
export interface FinalPdfObservation {
  parser: { name: string; version: string };
  pageCount: number;
  blocks: LayoutBlock[];
  bodyText: string;
  links: string[];
  fontChecks: { descriptor: string; available: boolean }[];
  limitations: string[];
}
/** Injection is an implementation/test seam, not an HTTP metrics input. The
 * default implementation parses the actual PDF bytes with PDF.js. */
export type FinalPdfParser = (bytes: Uint8Array, expected: FinalLayoutExpectedDocument, signal: AbortSignal) => Promise<FinalPdfObservation>;
export interface FinalLayoutIntegrityCheck {
  status: "verified" | "mismatch" | "unknown";
  method: string;
  expectedSha256?: string;
  actualSha256?: string;
}
export interface FinalLayoutLinkCheck {
  status: "verified" | "mismatch" | "unknown";
  method: string;
  expectedCount: number;
  actualCount: number;
  missingCount: number;
  unexpectedCount: number;
}
export type FinalLayoutInspectionResult = {
  status: "diagnosed";
  context: FinalLayoutExportContext;
  artifact: FinalLayoutArtifactBytes;
  renderedPdf?: FinalLayoutArtifactBytes;
  receipt: FinalLayoutExportArtifact["receipt"];
  report: LayoutDiagnosis;
  bodyTextCheck: FinalLayoutIntegrityCheck;
  linkCheck: FinalLayoutLinkCheck;
  limitations: string[];
} | {
  status: "unavailable" | "stale" | "cancelled" | "timeout";
  context: FinalLayoutExportContext;
  detail: string;
};
export interface FinalLayoutInspectionOptions {
  context: FinalLayoutExportContext;
  expected: FinalLayoutExpectedDocument;
  exportArtifact(context: FinalLayoutExportContext, signal: AbortSignal): Promise<FinalLayoutExportArtifact>;
  getCurrentScope(): LayoutScope;
  parser?: FinalPdfParser;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export const FINAL_LAYOUT_LIMITS = { artifactBytes: 20 * 1024 * 1024, bodyCharacters: 200_000, blocks: 2000, pages: 30, textItems: 20_000, operators: 200_000, images: 100, links: 1000 } as const;
export const FINAL_LAYOUT_LIMITATIONS = [
  "这是对该最终文件的页数、文本放置与链接的独立观察，不是DOM分页估计；PDF和DOCX的结果互不替代。",
  "PDF文本变换与字体度量不能证明每个像素都无裁切；字体缺字、视觉重叠、图像与留白仍需逐页图像核对。",
  "全文核对只忽略空白、不可见分隔符与常见列表圆点，并窄化兼容标准排版连字FB00–FB06和康熙部首2F00–2FD5的Unicode分解；不是通用NFKC，数字、单位、否定、限定词、实体与引用差异不会自动修复。",
  "文件与输入哈希绑定本次版本，不是作者身份、事实真实性、语义等价或发布授权证明。",
  "本模块不会由模型或用户上传的几何JSON生成最终文件通过状态，也不会在失败后改用DOM数值。",
] as const;
const bounded = (value: unknown, maximum: number): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const sha256 = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const sameRenderBinding = (left: LayoutRenderBinding, right: LayoutRenderBinding) => left.candidateId === right.candidateId && left.fingerprint === right.fingerprint;

export async function finalArtifactSha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("安全SHA-256接口不可用。");
  const copy = new Uint8Array(bytes);
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", copy))].map(value => value.toString(16).padStart(2, "0")).join("");
}
const normalizeRawFinalLayoutBody = (text: string): string => text.normalize("NFC").replace(/[\s\u200b\ufeff•◦▪\uf0b7]/gu, "");
/** Symmetric, source-independent extraction compatibility. NFKD is applied ONLY
 * to these two explicit Unicode ranges, whose decompositions represent standard
 * Latin presentation ligatures and Kangxi radical glyph variants. Never run a
 * general NFKC/NFKD, case-fold, width-fold, numeral or unit repair over the body.
 * Raw parser text remains intact; this is not pixel or factual certification. */
export function normalizeFinalLayoutBody(text: string): string {
  return normalizeRawFinalLayoutBody(text).replace(/[\ufb00-\ufb06\u2f00-\u2fd5]/gu, glyph => glyph.normalize("NFKD"));
}

function normalizeLink(value: string): string | undefined {
  try { const url = new URL(value); return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol) && !url.username && !url.password ? url.href : undefined; }
  catch { return undefined; }
}
function compareLinks(expected: readonly string[], actual: readonly string[]): FinalLayoutLinkCheck {
  const normalize = (values: readonly string[]) => values.map(normalizeLink), e = normalize(expected), a = normalize(actual);
  const allowed = new Set(e.filter((value): value is string => value !== undefined)), observed = new Set(a.filter((value): value is string => value !== undefined));
  const missing = [...allowed].filter(value => !observed.has(value)), unexpected = [...observed].filter(value => !allowed.has(value));
  return { status: e.includes(undefined) || a.includes(undefined) ? "unknown" : missing.length || unexpected.length ? "mismatch" : "verified",
    method: "Actual PDF URI annotations versus authorized source href set; wrapped annotations are deduplicated; no URL is opened.",
    expectedCount: allowed.size, actualCount: observed.size, missingCount: missing.length, unexpectedCount: unexpected.length };
}
function snapshotExpected(expected: FinalLayoutExpectedDocument): FinalLayoutExpectedDocument {
  return JSON.parse(JSON.stringify(expected)) as FinalLayoutExpectedDocument;
}
function snapshotContext(context: FinalLayoutExportContext): FinalLayoutExportContext {
  return { operationId: context.operationId, format: context.format, scope: { ...context.scope }, renderBinding: { ...context.renderBinding } };
}
function validArtifact(artifact: FinalLayoutArtifactBytes, format: FinalLayoutFormat): boolean {
  if (!artifact || !(artifact.bytes instanceof Uint8Array) || artifact.bytes.byteLength < 8 || artifact.bytes.byteLength > FINAL_LAYOUT_LIMITS.artifactBytes
    || !sha256(artifact.sha256) || !bounded(artifact.filename, 240) || /[\\/]/.test(artifact.filename)) return false;
  return format === "pdf" ? new TextDecoder().decode(artifact.bytes.subarray(0, 5)) === "%PDF-" && /\.pdf$/i.test(artifact.filename)
    : artifact.bytes[0] === 0x50 && artifact.bytes[1] === 0x4b && artifact.bytes[2] === 3 && artifact.bytes[3] === 4 && /\.docx$/i.test(artifact.filename);
}

/** Export → exact byte/hash binding → true final-page parsing → independent
 * diagnosis. No persistence, source mutation, file paths, network or auto-retry. */
export async function inspectFinalLayoutArtifact(options: FinalLayoutInspectionOptions): Promise<FinalLayoutInspectionResult> {
  const context = snapshotContext(options.context), controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined, cancelListener: (() => void) | undefined;
  const current = () => { try { return sameLayoutScope(context.scope, options.getCurrentScope()); } catch { return false; } };
  const unavailable = (detail: string): FinalLayoutInspectionResult => ({ status: "unavailable", context, detail });
  const terminal = (): FinalLayoutInspectionResult | undefined => !current() ? { status: "stale", context, detail: "账号、会话或原稿版本已变化，最终文件观察没有采用。" }
    : options.signal?.aborted ? { status: "cancelled", context, detail: "最终文件检查已取消；未将迟到文件作为成功结果。" } : undefined;
  const immediate = terminal(); if (immediate) return immediate;
  const timeout = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > 120_000) return unavailable("最终文件检查预算必须在10到120000毫秒之间。");
  let expected: FinalLayoutExpectedDocument;
  try {
    expected = snapshotExpected(options.expected); printGeometry(expected.page);
    if (!bounded(context.operationId, 240) || !["pdf", "docx"].includes(context.format) || !bounded(context.renderBinding.candidateId, 240)
      || !bounded(context.renderBinding.fingerprint, 1_000_000) || !bounded(expected.bodyText, FINAL_LAYOUT_LIMITS.bodyCharacters)
      || !Array.isArray(expected.blocks) || expected.blocks.length > FINAL_LAYOUT_LIMITS.blocks || expected.blocks.some(block => !bounded(block.id, 240)
        || typeof block.text !== "string" || block.text.length > FINAL_LAYOUT_LIMITS.bodyCharacters || !["heading", "claim", "text"].includes(block.kind))
      || !Array.isArray(expected.links) || expected.links.length > FINAL_LAYOUT_LIMITS.links || expected.links.some(link => !bounded(link, 10_000))) return unavailable("缺少完整且有界的授权源正文、链接或版本绑定。");
  } catch { return unavailable("源文档结构或打印尺寸不可用，没有生成文件通过状态。"); }
  const parse: FinalPdfParser = options.parser ?? (async (...args) => (await import("./pdfjs-final")).parseFinalPdfBytes(...args));
  const work = async (): Promise<FinalLayoutInspectionResult> => {
    const before = terminal(); if (before) return before; controller.signal.throwIfAborted();
    const exported = await options.exportArtifact(snapshotContext(context), controller.signal);
    const afterExport = terminal(); if (afterExport) return afterExport; controller.signal.throwIfAborted();
    if (!exported || exported.operationId !== context.operationId || exported.format !== context.format || !sameLayoutScope(exported.scope, context.scope)
      || !sameRenderBinding(exported.renderBinding, context.renderBinding) || !bounded(exported.receipt?.id, 240) || !bounded(exported.receipt?.renderer?.name, 240)
      || !bounded(exported.receipt?.renderer?.version, 240) || !Number.isFinite(Date.parse(exported.receipt.renderedAt))
      || !validArtifact(exported.artifact, context.format) || (context.format === "docx" ? !exported.renderedPdf || !validArtifact(exported.renderedPdf, "pdf") : exported.renderedPdf !== undefined)) {
      return unavailable("导出器没有返回绑定本次操作、版本与候选的真实文件回执；没有接受用户/模型自报的几何。");
    }
    const artifact = { ...exported.artifact, bytes: new Uint8Array(exported.artifact.bytes) }, renderedPdf = exported.renderedPdf ? { ...exported.renderedPdf, bytes: new Uint8Array(exported.renderedPdf.bytes) } : undefined;
    if (await finalArtifactSha256(artifact.bytes) !== artifact.sha256 || renderedPdf && await finalArtifactSha256(renderedPdf.bytes) !== renderedPdf.sha256) return unavailable("实际导出文件SHA-256与回执不符，未解析另一份文件冒充当前输出。");
    const beforeParse = terminal(); if (beforeParse) return beforeParse; controller.signal.throwIfAborted();
    const observation = await parse(new Uint8Array((renderedPdf ?? artifact).bytes), snapshotExpected(expected), controller.signal);
    const afterParse = terminal(); if (afterParse) return afterParse; controller.signal.throwIfAborted();
    if (!observation || !bounded(observation.parser?.name, 240) || !bounded(observation.parser?.version, 240)
      || !Number.isSafeInteger(observation.pageCount) || observation.pageCount < 1 || observation.pageCount > FINAL_LAYOUT_LIMITS.pages
      || typeof observation.bodyText !== "string" || observation.bodyText.length > FINAL_LAYOUT_LIMITS.bodyCharacters
      || !Array.isArray(observation.links) || observation.links.length > FINAL_LAYOUT_LIMITS.links || observation.links.some(link => !bounded(link, 10_000))) return unavailable("最终PDF解析器未提供有界的页级观察。");
    const expectedText = normalizeFinalLayoutBody(expected.bodyText), actualText = normalizeFinalLayoutBody(observation.bodyText);
    const reliable = !!expectedText && !!actualText && !/[\ufffd\ue000-\uf8ff]/u.test(actualText);
    // A radical can intentionally be a symbol, and an authored ligature can be
    // an intentional entity spelling. If the independent source already has
    // one, a reverse-fold collision is ambiguous, not a semantic equivalence.
    const sourceSymbolCollision = expectedText === actualText && /[\ufb00-\ufb06\u2f00-\u2fd5]/u.test(expected.bodyText)
      && normalizeRawFinalLayoutBody(expected.bodyText) !== normalizeRawFinalLayoutBody(observation.bodyText);
    const bodyTextCheck: FinalLayoutIntegrityCheck = { status: !reliable || sourceSymbolCollision ? "unknown" : expectedText === actualText ? "verified" : "mismatch",
      method: "Full authorized source text versus extracted final PDF text; NFC, whitespace/common list dots, and ONLY Unicode compatibility decomposition of standard ligatures U+FB00–U+FB06 and Kangxi radicals U+2F00–U+2FD5; no general NFKC, case/width/numeral/unit/entity/negation/qualifier repair. If the independent source contains those glyphs, unequal raw NFC/whitespace/list-dot text cannot be compatibility-verified.",
      expectedSha256: await finalArtifactSha256(new TextEncoder().encode(expectedText)), actualSha256: await finalArtifactSha256(new TextEncoder().encode(actualText)) };
    const linkCheck = compareLinks(expected.links, observation.links), measuredAt = new Date().toISOString();
    const measurement: MeasuredLayout = { status: "measured", scope: context.scope, source: context.format === "pdf" ? "pdf-final" : "docx-final", page: expected.page,
      pageCount: observation.pageCount, blocks: observation.blocks, measuredAt, renderBinding: context.renderBinding, fontChecks: observation.fontChecks,
      finalEvidence: { format: context.format, artifactSha256: artifact.sha256, ...(renderedPdf ? { renderedArtifactSha256: renderedPdf.sha256 } : {}),
        inputContentHash: context.scope.contentHash, renderer: { name: `${exported.receipt.renderer.name} → ${observation.parser.name}`, version: `${exported.receipt.renderer.version} / ${observation.parser.version}` },
        renderedAt: exported.receipt.renderedAt, pageCount: observation.pageCount, bodyTextCheck }, limitations: [...FINAL_LAYOUT_LIMITATIONS, ...observation.limitations,
          ...(sourceSymbolCollision ? ["独立源正文自身包含康熙部首或标准连字，且原始NFC/空白/圆点核对不同；它们可能是有意的符号或实体拼写，兼容分解碰撞不判完整性通过，正文保持未知。"] : [])] };
    const report = diagnoseLayout(measurement);
    if (report.status !== "diagnosed") return unavailable("最终文件的实际页级几何或回执不完整；没有退回DOM估计代替。");
    const complete = terminal(); if (complete) return complete;
    return { status: "diagnosed", context, artifact, ...(renderedPdf ? { renderedPdf } : {}), receipt: JSON.parse(JSON.stringify(exported.receipt)) as FinalLayoutExportArtifact["receipt"],
      report, bodyTextCheck, linkCheck, limitations: [...new Set([...measurement.limitations, "当前未完成逐页PNG/实际文件的人工视觉核对，不显示视觉验收通过。"])] };
  };
  try {
    return await new Promise<FinalLayoutInspectionResult>(resolve => {
      let settled = false;
      const finish = (result: FinalLayoutInspectionResult) => { if (!settled) { settled = true; resolve(result); } };
      cancelListener = () => { controller.abort(); finish(terminal() ?? { status: "cancelled", context, detail: "最终文件检查已取消。" }); };
      options.signal?.addEventListener("abort", cancelListener, { once: true });
      timer = setTimeout(() => { controller.abort(); finish(terminal() ?? { status: "timeout", context, detail: "最终文件导出或解析达到预算上限，未自动重试。" }); }, timeout);
      Promise.resolve().then(work).then(finish, () => finish(terminal() ?? unavailable("受信导出或实际PDF解析未完成；没有推断正文、链接或分页已通过。")));
    });
  } finally { if (timer) clearTimeout(timer); if (cancelListener) options.signal?.removeEventListener("abort", cancelListener); controller.abort(); }
}
