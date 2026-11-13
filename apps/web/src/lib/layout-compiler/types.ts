/** A version binding, not an authorization grant or a statement of fact ownership. */
export interface LayoutScope {
  ownerId: string;
  sessionGeneration: number;
  documentId: string;
  revision: string;
  contentHash: string;
}

export function sameLayoutScope(left: LayoutScope, right: LayoutScope): boolean {
  return left.ownerId === right.ownerId
    && left.sessionGeneration === right.sessionGeneration
    && left.documentId === right.documentId
    && left.revision === right.revision
    && left.contentHash === right.contentHash;
}

export interface PrintPageSpec {
  widthMm: number;
  heightMm: number;
  marginMm: { top: number; right: number; bottom: number; left: number };
}

export const A4_PAGE: Readonly<PrintPageSpec> = Object.freeze({
  widthMm: 210,
  heightMm: 297,
  marginMm: Object.freeze({ top: 16, right: 16, bottom: 16, left: 16 }),
});

/** CSS absolute lengths use 96 px/in; devicePixelRatio is deliberately irrelevant. */
export const mmToCssPx = (mm: number): number => mm * 96 / 25.4;

export function printGeometry(page: PrintPageSpec) {
  const values = [page.widthMm, page.heightMm, ...Object.values(page.marginMm)];
  if (!values.every(Number.isFinite) || page.widthMm <= 0 || page.heightMm <= 0
    || Object.values(page.marginMm).some(value => value < 0)) {
    throw new Error("Invalid print page dimensions");
  }
  const width = mmToCssPx(page.widthMm - page.marginMm.left - page.marginMm.right);
  const height = mmToCssPx(page.heightMm - page.marginMm.top - page.marginMm.bottom);
  if (width <= 0 || height <= 0) throw new Error("Print margins leave no content area");
  return { width, height, paperWidth: mmToCssPx(page.widthMm), paperHeight: mmToCssPx(page.heightMm) };
}

/** All rectangles are unzoomed CSS px, relative to the printable content origin. */
export interface LayoutRect { x: number; y: number; width: number; height: number }
export interface LayoutLine {
  rect: LayoutRect;
  /** DOM-only single-line CSS flow box. The original font Range rect stays in
   * rect; this measured line box cannot certify glyph ink or final-file layout. */
  flowRect?: LayoutRect;
  text: string;
  /** UTF-16 offsets in the block text, when the renderer can provide them. */
  start?: number;
  end?: number;
}

export interface LayoutBlock {
  id: string;
  anchor?: string;
  kind: "heading" | "claim" | "text" | "image";
  order: number;
  text: string;
  rect: LayoutRect;
  lines: LayoutLine[];
  keepWithNext?: boolean;
  keepTogether?: boolean;
  clipped?: boolean;
  /** Required for final-file measurements; DOM flow uses continuous y instead. */
  pageNumber?: number;
}

/** Supplied by a trusted final-file renderer, never by a rewriting model. */
export interface FinalOutputEvidence {
  format: "pdf" | "docx";
  artifactSha256: string;
  /** DOCX must identify the paginated rendering as well as the source ZIP. */
  renderedArtifactSha256?: string;
  inputContentHash: string;
  renderer: { name: string; version: string };
  renderedAt: string;
  pageCount: number;
  bodyTextCheck: { status: "verified" | "mismatch" | "unknown"; method: string };
}

export type LayoutSource = "dom-estimate" | "pdf-final" | "docx-final";
/** A deterministic payload key for stale-result detection, not a signature or fact proof. */
export interface LayoutRenderBinding { candidateId: string; fingerprint: string }
export type LayoutUnavailableReason = "cancelled" | "stale" | "timeout" | "hidden" | "zero-size"
  | "detached" | "unsupported-transform" | "print-width-mismatch" | "fonts-unavailable"
  | "image-unavailable" | "range-unavailable" | "measurement-budget" | "empty"
  | "invalid-measurement" | "invalid-final-evidence";

export interface UnavailableLayout {
  status: "unavailable";
  scope: LayoutScope;
  reason: LayoutUnavailableReason;
  detail: string;
  limitations: string[];
}

export interface MeasuredLayout {
  status: "measured";
  scope: LayoutScope;
  source: LayoutSource;
  page: PrintPageSpec;
  blocks: LayoutBlock[];
  /** An estimate for DOM flow, an observed count for a final-file renderer. */
  pageCount: number;
  measuredAt: string;
  scale?: { x: number; y: number };
  fontChecks?: { descriptor: string; available: boolean }[];
  finalEvidence?: FinalOutputEvidence;
  renderBinding?: LayoutRenderBinding;
  limitations: string[];
}

export type LayoutMeasurement = MeasuredLayout | UnavailableLayout;
export type LayoutIssueKind = "trailing-whitespace" | "orphan-page" | "stranded-heading"
  | "short-last-line" | "overflow";

export interface LayoutIssue {
  id: string;
  kind: LayoutIssueKind;
  severity: "notice" | "warning" | "error";
  pageNumber: number;
  blockId?: string;
  anchor?: string;
  detail: string;
  metrics: Record<string, number>;
}

export interface LayoutPageSummary {
  pageNumber: number;
  lineCount: number;
  occupiedBottom: number;
  trailingWhitespaceRatio: number;
  hasImage: boolean;
}

export interface LayoutDiagnosis {
  status: "diagnosed";
  scope: LayoutScope;
  source: LayoutSource;
  issues: LayoutIssue[];
  pages: LayoutPageSummary[];
  /** A reproducible issue penalty, not a resume-quality or hiring score. */
  penalty: number;
  finalFileCheck: "not-performed" | "geometry-only" | "body-text-verified";
  limitations: string[];
}

export type LayoutReport = LayoutDiagnosis | UnavailableLayout;

export interface LayoutDiagnosticOptions {
  trailingWhitespaceRatio?: number;
  orphanPageMaxLines?: number;
  shortLineMaxCjkCharacters?: number;
  shortLineMaxWords?: number;
  shortLineWidthRatio?: number;
  tolerancePx?: number;
}

export function unavailableLayout(scope: LayoutScope, reason: LayoutUnavailableReason, detail: string,
  limitations: string[] = []): UnavailableLayout {
  return { status: "unavailable", scope, reason, detail, limitations };
}

export const DOM_ESTIMATE_LIMITATIONS = [
  "DOM geometry estimates print pagination; @media print, fragmentation, fonts and exporters may change it.",
  "PDF and DOCX require separate measurements of the final rendered files, including body text and links.",
];
