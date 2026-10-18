import type { BrowserSnapshot, SearchProjectionDiagnostics } from "./jd-browser-snapshot";
import { JOB_SEARCH_CAPTURE_CONFIGS } from "./jd-search-capture";
import { allowedJobUrl } from "../src/lib/jd-source";
import type { SnapshotVisibilityDetail, SnapshotFailureDetail } from "../src/lib/jd-capture-diagnostics";
import { isLiepinDescriptionHeading, isLiepinRequirementsHeading } from "./jd-liepin-description";

/** The capture caller must use this exact order, includeDOMRects and includeTextColorOpacities. */
export const NATIVE_SNAPSHOT_STYLES = [
  "display", "visibility", "opacity", "content-visibility", "overflow-x", "overflow-y",
  "text-overflow", "-webkit-line-clamp", "clip", "clip-path", "transform", "filter",
  "mask-image", "-webkit-mask-image", "color",
] as const;
/** Candidate-only capture sequence. The existing fifteen-column contract stays unchanged. */
export const NATIVE_ROOT_SCROLL_STYLES = [...NATIVE_SNAPSHOT_STYLES, "zoom", "direction", "writing-mode", "position", "contain"] as const;
/** Optional paragraph evidence; the original fifteen/twenty-column contracts remain valid. */
export const NATIVE_LIEPIN_PARAGRAPH_STYLES = [...NATIVE_ROOT_SCROLL_STYLES, "white-space"] as const;
const hasRootStyleColumns = (length: number) => length === NATIVE_ROOT_SCROLL_STYLES.length || length === NATIVE_LIEPIN_PARAGRAPH_STYLES.length;

export type NativeDomSnapshotCode =
  | "snapshot_shape" | "snapshot_string" | "main_document_count" | "document_url"
  | "node_arrays" | "node_parent" | "attributes" | "layout_arrays" | "layout_entry"
  | "text_box_arrays" | "text_box_entry" | "text_box_range" | "snapshot_limit_exceeded"
  | "projection_depth_limit" | "snapshot_visibility_unsupported" | "document_body_missing";

/** Codes are fixed local strings. Never attach a raw snapshot, URL or protocol error as a cause. */
export class NativeDomSnapshotError extends Error {
  constructor(readonly code: NativeDomSnapshotCode, readonly detail?: SnapshotFailureDetail) { super(code); this.name = "NativeDomSnapshotError"; }
}

type RecordValue = Record<string, unknown>;
type Rect = [number, number, number, number];
type Layout = { bounds: Rect; styles: string[]; text: string; opacity?: number; offsetRect?: Rect; clientRect?: Rect; scrollRect?: Rect; boxes: { bounds: Rect; start: number; end: number }[] };
type Node = { type: number; name: string; value: string; parent: number; children: number[]; attrs: Map<string, string>; layouts: Layout[]; depth: number; special: boolean };
type ReadyState = NonNullable<BrowserSnapshot["pageLoad"]>["readyState"];
/** rootDocument must come from a fresh protocol document node, never a DOM doctype inference. */
export type NativeProjectionOptions = { scope?: "boss-share" | "liepin-job"; sourceUrl?: string; rootScroll?: "liepin"; rootDocument?: unknown; detect51JobWaf?: boolean; purpose?: "search" };

export function isOriginalLiepinJob(frameUrl: string, sourceUrl: string | undefined): boolean {
  if (!sourceUrl) return false;
  const identity = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || !["liepin.com", "m.liepin.com", "www.liepin.com"].includes(url.hostname) || url.username || url.password || (url.port && url.port !== "443")) return undefined;
      return url.pathname.match(/^\/job\/(\d+)\.shtml\/?$/)?.[1];
    } catch { return undefined; }
  };
  const original = identity(sourceUrl);
  return !!original && identity(frameUrl) === original;
}

function isOriginalBossShare(frameUrl: string, sourceUrl: string | undefined): boolean {
  if (!sourceUrl) return false;
  const identity = (value: string): string | undefined => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.hostname !== "m.zhipin.com" || url.username || url.password || (url.port && url.port !== "443")) return undefined;
      return url.pathname.match(/^\/mpa\/html\/weijd\/weijd-job\/([a-z\d_-]+)\/?$/i)?.[1];
    } catch { return undefined; }
  };
  const original = identity(sourceUrl);
  return !!original && identity(frameUrl) === original;
}

const MAX_NODES = 25_000;
const MAX_DEPTH = 512;
const MAX_STRINGS = 200_000;
const MAX_CODE_UNITS = 8 * 1024 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const EXCLUDED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "FRAME", "FORM", "INPUT", "TEXTAREA", "SELECT", "OPTION", "NAV", "ASIDE", "FOOTER"]);
const EXCLUDED_CLASSES = new Set(["recommend", "recommendation", "recommendations", "job-recommend", "job-recommend-list", "related-jobs"]);
const VOID_TAGS = new Set(["BR", "HR", "IMG", "META", "LINK", "INPUT", "WBR", "AREA", "BASE", "COL", "EMBED", "PARAM", "SOURCE", "TRACK"]);
const fail = (code: NativeDomSnapshotCode, detail?: SnapshotFailureDetail): never => { throw new NativeDomSnapshotError(code, detail); };
const record = (value: unknown, code: NativeDomSnapshotCode): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : fail(code);
const array = (value: unknown, code: NativeDomSnapshotCode): unknown[] => Array.isArray(value) ? value : fail(code);
const integer = (value: unknown, min: number, max: number, code: NativeDomSnapshotCode): number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(code);
const rectangle = (value: unknown, code: NativeDomSnapshotCode, detail?: SnapshotFailureDetail): Rect => {
  const bounds = Array.isArray(value) ? value : fail(code, detail);
  if (bounds.length !== 4 || !bounds.every(item => typeof item === "number" && Number.isFinite(item)) || (bounds[2] as number) < 0 || (bounds[3] as number) < 0) fail(code, detail);
  return bounds as Rect;
};
const escapeText = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (value: string) => escapeText(value).replaceAll('"', "&quot;");

/**
 * Pure projection: no protocol calls, logs or persistence. Raw CDP includes hidden/form values;
 * receiving them is unavoidable with DOMSnapshot, but they are never copied to this result.
 * Text boxes establish rendered text, not freedom from overlays. Known clipping, transforms,
 * line clamp, masks and shadow/pseudo text are rejected instead of claiming full visibility.
 */
export function projectNativeDomSnapshot(
  value: unknown,
  frame: { id: string; url: string },
  load: { readyState: ReadyState },
  options: NativeProjectionOptions = {},
): BrowserSnapshot {
  if (!frame || typeof frame.id !== "string" || !frame.id || typeof frame.url !== "string" || !frame.url
      || !load || !["loading", "interactive", "complete", "unknown"].includes(load.readyState)) fail("snapshot_shape");
  const rootScrollMode = options.rootScroll === "liepin" && isOriginalLiepinJob(frame.url, options.sourceUrl);
  const snapshot = record(value, "snapshot_shape");
  const strings = array(snapshot.strings, "snapshot_shape");
  const documents = array(snapshot.documents, "snapshot_shape");
  if (documents.length > 50 || strings.length > MAX_STRINGS) fail("snapshot_limit_exceeded");
  let stringUnits = 0;
  for (const item of strings) {
    if (typeof item !== "string") fail("snapshot_string");
    stringUnits += (item as string).length;
    if (stringUnits > MAX_CODE_UNITS) fail("snapshot_limit_exceeded");
  }
  const stringAt = (index: unknown): string => strings[integer(index, 0, strings.length - 1, "snapshot_string")] as string;
  const optionalString = (index: unknown): string => index === -1 ? "" : stringAt(index);
  const matching = documents.map(item => record(item, "snapshot_shape")).filter(doc => stringAt(doc.frameId) === frame.id);
  if (matching.length !== 1) fail("main_document_count");
  const doc = matching[0];
  if (stringAt(doc.documentURL) !== frame.url) fail("document_url");
  const title = optionalString(doc.title);
  const rawNodes = record(doc.nodes, "node_arrays");
  const nodeTypes = array(rawNodes.nodeType, "node_arrays");
  if (!nodeTypes.length || nodeTypes.length > MAX_NODES) fail("snapshot_limit_exceeded");
  const count = nodeTypes.length;
  const columns = ["parentIndex", "nodeName", "nodeValue", "backendNodeId", "attributes"] as const;
  for (const key of columns) if (array(rawNodes[key], "node_arrays").length !== count) fail("node_arrays");
  const parents = rawNodes.parentIndex as unknown[];
  const names = rawNodes.nodeName as unknown[];
  const values = rawNodes.nodeValue as unknown[];
  const backendIds = rawNodes.backendNodeId as unknown[];
  const rawAttributes = rawNodes.attributes as unknown[];
  const special = new Set<number>();
  // Snapshot flattens shadow DOM and pseudo nodes. Never adopt their text without verified support.
  for (const key of ["shadowRootType", "pseudoType"] as const) {
    if (rawNodes[key] === undefined) continue;
    const rare = record(rawNodes[key], "node_arrays");
    const indices = array(rare.index, "node_arrays");
    const entries = array(rare.value, "node_arrays");
    if (indices.length !== entries.length || indices.length > count) fail("node_arrays");
    for (let i = 0; i < indices.length; i++) { special.add(integer(indices[i], 0, count - 1, "node_arrays")); stringAt(entries[i]); }
  }
  const nodes: Node[] = [];
  let attributeUnits = 0;
  let nodeUnits = 0;
  const seenBackendIds = new Set<number>();
  for (let i = 0; i < count; i++) {
    const parent = integer(parents[i], -1, i - 1, "node_parent");
    if ((i === 0 && parent !== -1) || (i > 0 && parent === -1)) fail("node_parent");
    const type = integer(nodeTypes[i], 1, 12, "node_arrays");
    if ((i === 0 && type !== 9) || (i > 0 && type === 9)) fail("node_arrays");
    const backendId = integer(backendIds[i], 1, Number.MAX_SAFE_INTEGER, "node_arrays");
    if (seenBackendIds.has(backendId)) fail("node_arrays");
    seenBackendIds.add(backendId);
    const depth = parent < 0 ? 0 : nodes[parent].depth + 1;
    if (depth > MAX_DEPTH) fail("projection_depth_limit");
    const pairs = array(rawAttributes[i], "attributes");
    if (pairs.length % 2 || pairs.length > 2048) fail("attributes");
    const attrs = new Map<string, string>();
    for (let j = 0; j < pairs.length; j += 2) {
      const name = stringAt(pairs[j]);
      const text = optionalString(pairs[j + 1]);
      attributeUnits += name.length + text.length;
      if (attributeUnits > MAX_CODE_UNITS) fail("snapshot_limit_exceeded");
      if (attrs.has(name)) fail("attributes");
      attrs.set(name, text);
    }
    const rawName = stringAt(names[i]);
    const node: Node = { type, name: type === 1 ? rawName.toUpperCase() : rawName, value: optionalString(values[i]), parent, children: [], attrs, layouts: [], depth, special: special.has(i) };
    nodeUnits += node.name.length + node.value.length;
    if (nodeUnits > MAX_CODE_UNITS) fail("snapshot_limit_exceeded");
    nodes.push(node);
    if (parent >= 0) nodes[parent].children.push(i);
  }

  const rawLayout = record(doc.layout, "layout_arrays");
  const layoutIndices = array(rawLayout.nodeIndex, "layout_arrays");
  if (layoutIndices.length > MAX_NODES) fail("snapshot_limit_exceeded");
  const layouts = layoutIndices.length;
  for (const key of ["styles", "bounds", "text"] as const) if (array(rawLayout[key], "layout_arrays").length !== layouts) fail("layout_arrays");
  const layoutStyles = rawLayout.styles as unknown[];
  const layoutBounds = rawLayout.bounds as unknown[];
  const layoutTexts = rawLayout.text as unknown[];
  const opacity = rawLayout.textColorOpacities === undefined ? undefined : array(rawLayout.textColorOpacities, "layout_arrays");
  if (opacity && opacity.length !== layouts) fail("layout_arrays");
  const geometry = ["offsetRects", "clientRects", "scrollRects"].map(key => rawLayout[key] === undefined ? undefined : array(rawLayout[key], "layout_arrays"));
  for (const column of geometry) if (column && column.length !== layouts) fail("layout_arrays");
  const byLayout: Layout[] = [];
  let layoutUnits = 0;
  for (let i = 0; i < layouts; i++) {
    const rawIndex = layoutIndices[i];
    const index = typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) && rawIndex >= 0 && rawIndex < count ? rawIndex : fail("layout_entry", "node_index");
    const node = nodes[index];
    const styles = Array.isArray(layoutStyles[i]) ? layoutStyles[i] as unknown[] : fail("layout_entry", "style_count");
    if (styles.length !== NATIVE_SNAPSHOT_STYLES.length && !((rootScrollMode || options.purpose === "search") && hasRootStyleColumns(styles.length)) && !(styles.length === 0 && node.type !== 1)) fail("layout_entry", "style_count");
    const alpha = opacity?.[i];
    if (alpha !== undefined && (typeof alpha !== "number" || !Number.isFinite(alpha) || alpha < 0 || alpha > 1)) fail("layout_entry", "text_opacity");
    const computed = styles.map(optionalString);
    if (node.type === 1 && (!computed[0] || !["visible", "hidden", "collapse"].includes(computed[1]) || !computed[2]
        || !Number.isFinite(Number(computed[2])) || Number(computed[2]) < 0 || Number(computed[2]) > 1)) fail("layout_entry", "computed_style");
    const layout: Layout = { bounds: rectangle(layoutBounds[i], "layout_entry", "bounds"), styles: computed, text: optionalString(layoutTexts[i]), boxes: [], ...(typeof alpha === "number" ? { opacity: alpha } : {}) };
    for (const [at, key] of ["offsetRect", "clientRect", "scrollRect"].entries()) {
      const value = geometry[at]?.[i];
      if (value !== undefined && !(Array.isArray(value) && value.length === 0)) layout[key as "offsetRect" | "clientRect" | "scrollRect"] = rectangle(value, "layout_entry", "bounds");
    }
    layoutUnits += layout.text.length + layout.styles.reduce((sum, text) => sum + text.length, 0);
    if (layoutUnits > MAX_CODE_UNITS) fail("snapshot_limit_exceeded");
    // A DOM node can own several LayoutObjects (e.g. generated content). Keep every
    // protocol row: textBoxes.layoutIndex refers to this table, not a DOM node index.
    node.layouts.push(layout); byLayout.push(layout);
  }
  const boxes = record(doc.textBoxes, "text_box_arrays");
  const boxIndices = array(boxes.layoutIndex, "text_box_arrays");
  if (boxIndices.length > 100_000) fail("snapshot_limit_exceeded");
  for (const key of ["bounds", "start", "length"] as const) if (array(boxes[key], "text_box_arrays").length !== boxIndices.length) fail("text_box_arrays");
  const boxBounds = boxes.bounds as unknown[]; const starts = boxes.start as unknown[]; const lengths = boxes.length as unknown[];
  for (let i = 0; i < boxIndices.length; i++) {
    const layout = byLayout[integer(boxIndices[i], 0, layouts - 1, "text_box_entry")];
    const start = integer(starts[i], 0, layout.text.length, "text_box_range");
    const amount = integer(lengths[i], 0, layout.text.length - start, "text_box_range");
    const bounds = rectangle(boxBounds[i], "text_box_entry");
    if (amount && bounds[2] && bounds[3]) layout.boxes.push({ bounds, start, end: start + amount });
  }

  // The observed 51job challenge marks its main-document HEAD. Keep only a
  // fixed gate/marker; names can carry opaque suffixes and content is private.
  let official51Job = false;
  if (options.detect51JobWaf) {
    try {
      const url = new URL(frame.url);
      official51Job = url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
        && (url.hostname === "51job.com" || url.hostname.endsWith(".51job.com"));
    } catch { /* Unrecognized sources receive the ordinary projection. */ }
  }
  if (official51Job && nodes.some(node => {
    const head = nodes[node.parent]; const html = head && nodes[head.parent];
    return node.type === 1 && node.name === "META" && !node.special && /^aliyun_waf(?:_|$)/i.test(node.attrs.get("name") ?? "")
      && head?.name === "HEAD" && !head.special && html?.name === "HTML" && nodes[html.parent]?.type === 9;
  })) return { html: '<html><head><meta name="aliyun_waf"></head><body></body></html>', url: frame.url, title,
    gate: "verification_required", pageLoad: { readyState: load.readyState, content: "unknown", visibleFrames: 0 } };

  const hidden = (index: number): boolean => {
    for (let i = index; i >= 0; i = nodes[i].parent) {
      const { attrs, layouts } = nodes[i];
      if (attrs.has("hidden") || attrs.get("aria-hidden")?.toLowerCase() === "true" || layouts.some(({ styles }) => styles[0] === "none" || styles[3] === "hidden"
          || ["hidden", "collapse"].includes(styles[1] ?? "") || (styles[2] !== undefined && styles[2] !== "" && Number(styles[2]) === 0))) return true;
    }
    return false;
  };
  const excluded = (index: number): boolean => {
    for (let i = index; i >= 0; i = nodes[i].parent) {
      const node = nodes[i];
      if (EXCLUDED_TAGS.has(node.name) || (node.attrs.get("class") ?? "").split(/\s+/).some(name => EXCLUDED_CLASSES.has(name))) return true;
    }
    return false;
  };
  const transparent = (index: number): boolean => {
    for (let i = index; i >= 0; i = nodes[i].parent) {
      const color = nodes[i].layouts.find(layout => layout.styles[14])?.styles[14];
      if (!color) continue;
      return color === "transparent" || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color) || /\/\s*0(?:\.0+)?%?\s*\)$/.test(color);
    }
    return false;
  };
  // A bounded root-only compatibility proof, gated by a fresh protocol document
  // mode and identity. The native Liepin caller supplies evidence only for the
  // owned original job, checks it before/after capture, and leaves others closed.
  // This does not support local scrolling, zoom, RTL or fixed/sticky text.
  const rootDocument = options.rootDocument && typeof options.rootDocument === "object" && !Array.isArray(options.rootDocument) ? options.rootDocument as RecordValue : undefined;
  const identifiedHtmlRoot = rootDocument?.nodeType === 9 && rootDocument.backendNodeId === backendIds[0]
    && (rootDocument.frameId === undefined || rootDocument.frameId === frame.id)
    && rootDocument.documentURL === frame.url && rootDocument.compatibilityMode === "NoQuirksMode";
  const ordinaryElementChain = (index: number): boolean => {
    for (let at = index; at >= 0; at = nodes[at].parent) {
      const node = nodes[at];
      if (node.type !== 1) continue;
      if (node.layouts.length !== 1) return false;
      const row = node.layouts[0];
      if (!hasRootStyleColumns(row.styles.length) || row.styles[15] !== "1" || row.styles[16] !== "ltr" || row.styles[17] !== "horizontal-tb"
        || !["static", "relative", "absolute"].includes(row.styles[18]) || row.styles[3] !== "visible" || row.styles[19] !== "none") return false;
    }
    return true;
  };
  let rootProof: { width: number; height: number; root: number } | false | undefined;
  const ordinaryRootText = (index: number): boolean => {
    if (!rootScrollMode || !identifiedHtmlRoot) return false;
    if (rootProof === undefined) {
      rootProof = false;
      const htmls = nodes.flatMap((node, at) => node.type === 1 && node.name === "HTML" && node.parent === 0 ? [at] : []);
      const bodies = nodes.flatMap((node, at) => node.type === 1 && node.name === "BODY" ? [at] : []);
      const finite = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= 10_000_000;
      if (htmls.length !== 1 || bodies.length !== 1 || nodes[bodies[0]].parent !== htmls[0]) return false;
      const root = nodes[htmls[0]], body = nodes[bodies[0]];
      if (root.layouts.length !== 1 || body.layouts.length !== 1) return false;
      const row = root.layouts[0], bodyRow = body.layouts[0];
      const offset = row.offsetRect, client = row.clientRect, scroll = row.scrollRect;
      if (!offset || !client || !scroll || !bodyRow.offsetRect || !bodyRow.clientRect || !bodyRow.scrollRect) return false;
      if (!["visible", "auto", "scroll"].includes(row.styles[4]) || !["visible", "auto", "scroll"].includes(row.styles[5]) || bodyRow.styles[4] !== "visible" || bodyRow.styles[5] !== "visible") return false;
      if (![root, body].every(node => hasRootStyleColumns(node.layouts[0].styles.length) && node.layouts[0].styles[15] === "1" && node.layouts[0].styles[16] === "ltr" && node.layouts[0].styles[17] === "horizontal-tb" && node.layouts[0].styles[18] === "static")) return false;
      if (row.bounds[0] !== 0 || row.bounds[1] !== 0 || offset[0] !== 0 || offset[1] !== 0 || client[0] !== 0 || client[1] !== 0 || offset[2] < 64 || offset[3] < 64 || client[2] < 64 || client[3] < 64) return false;
      const scale = row.bounds[2] / offset[2];
      if (!Number.isFinite(scale) || scale < .25 || scale > 8) return false;
      if (![offset, client, scroll, bodyRow.offsetRect, bodyRow.clientRect, bodyRow.scrollRect].every(rect => finite(rect[2], 1) && finite(rect[3], 1))) return false;
      // HTML client dimensions are the viewport and may exceed its offset box.
      if (bodyRow.clientRect[2] > bodyRow.offsetRect[2] + 1 || bodyRow.clientRect[3] > bodyRow.offsetRect[3] + 1) return false;
      if (bodyRow.scrollRect[0] !== 0 || bodyRow.scrollRect[1] !== 0 || bodyRow.scrollRect[2] < bodyRow.clientRect[2] || bodyRow.scrollRect[3] < bodyRow.clientRect[3]) return false;
      // CSSOM dimensions are integers. Permit at most one CSS pixel of rounding
      // in independent unit cross-checks; containment itself uses document units.
      const near = (actual: number, expected: number) => Math.abs(actual - expected) <= scale + 1e-6;
      if (!near(row.bounds[3], offset[3] * scale) || !finite(doc.contentWidth, 1) || !finite(doc.contentHeight, 1) || !finite(doc.scrollOffsetX) || !finite(doc.scrollOffsetY)) return false;
      if (!near(doc.contentWidth, scroll[2] * scale) || !near(doc.contentHeight, scroll[3] * scale) || !near(doc.scrollOffsetX, scroll[0] * scale) || !near(doc.scrollOffsetY, scroll[1] * scale)) return false;
      if (scroll[0] < 0 || scroll[1] < 0 || scroll[2] < client[2] || scroll[3] < client[3] || scroll[0] > scroll[2] - client[2] + 1 || scroll[1] > scroll[3] - client[3] + 1) return false;
      if (!near(bodyRow.bounds[2], bodyRow.offsetRect[2] * scale) || !near(bodyRow.bounds[3], bodyRow.offsetRect[3] * scale) || bodyRow.offsetRect[2] < 64 || bodyRow.offsetRect[3] < 64) return false;
      rootProof = { width: doc.contentWidth, height: doc.contentHeight, root: htmls[0] };
    }
    if (!rootProof) return false;
    const proof = rootProof;
    if (!ordinaryElementChain(index)) return false;
    let reachedRoot = false;
    for (let at = index; at >= 0; at = nodes[at].parent) {
      if (at === proof.root) reachedRoot = true;
    }
    if (!reachedRoot) return false;
    // Root boxes remain document coordinates during ordinary root scrolling.
    // Do not subtract the current root scroll offset as for a child scroller.
    return nodes[index].layouts.filter(row => row.opacity !== 0).flatMap(row => row.boxes).every(({ bounds: [x, y, width, height] }) => x >= 0 && y >= 0 && x + width <= proof.width + 1e-6 && y + height <= proof.height + 1e-6);
  };
  const unsupported = (index: number, foldedCandidate?: number): SnapshotVisibilityDetail | undefined => {
    for (let i = index; i >= 0; i = nodes[i].parent) {
      const node = nodes[i];
      if (node.special) return "shadow_or_pseudo";
      for (const { styles } of node.layouts) {
        if (node.type === 1 && styles.slice(0, NATIVE_ROOT_SCROLL_STYLES.length).some(value => !value)) return "computed_style_incomplete";
        // CDP can repeat an element's exact computed box styles on its direct
        // text LayoutObject. They identify the same fold, never a child box.
        const foldedStyles = foldedCandidate === undefined ? undefined : nodes[foldedCandidate].layouts[0]?.styles;
        const sameFoldBox = i === foldedCandidate || (node.type === 3 && node.parent === foldedCandidate
          && foldedStyles?.length === styles.length && styles.every((value, key) => value === foldedStyles[key]));
        // Geometry for padding clips, ellipsis and scroll containers cannot be proved by textBoxes.
        // Reject these effects instead of returning hidden suffixes as complete visible text.
        if ([styles[4], styles[5]].some(value => value && !["visible", "unset", "initial"].includes(value))
          && !(sameFoldBox && [styles[4], styles[5]].every(value => ["visible", "hidden"].includes(value)))
          && !(node.name === "HTML" && [styles[4], styles[5]].every(value => ["visible", "auto", "scroll"].includes(value)) && ordinaryRootText(index))) return "overflow_clip_or_scroll";
        if (styles[6] && styles[6] !== "clip") return "text_ellipsis";
        if (styles[7] && !["none", "0"].includes(styles[7]) && !(sameFoldBox && styles[7] === "4")) return "line_clamp";
        if (styles[8] && styles[8] !== "auto") return "legacy_clip";
        if (styles[9] && styles[9] !== "none") return "clip_path";
        if (styles[10] && styles[10] !== "none") return "transform";
        if (styles[11] && styles[11] !== "none") return "filter";
        if ([12, 13].some(key => styles[key] && styles[key] !== "none")) return "mask";
      }
    }
    return undefined;
  };
  const visibleLayouts = (index: number, forGate = false): Layout[] => {
    const node = nodes[index];
    if (forGate) for (let i = index; i >= 0; i = nodes[i].parent) {
      if (["INPUT", "TEXTAREA", "SELECT", "OPTION", "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "IFRAME", "FRAME"].includes(nodes[i].name)) return [];
    }
    if (transparent(index) || hidden(index) || (!forGate && excluded(index))) return [];
    return node.layouts.filter(layout => !!layout.bounds[2] && !!layout.bounds[3] && !!layout.boxes.length && layout.opacity !== 0 && layout.text.length > 0);
  };
  const visible = (index: number, forGate = false): boolean => visibleLayouts(index, forGate).length > 0;
  const preservesParagraphBreaks = (index: number, layouts: Layout[]): boolean => {
    // Text inherits this property from its nearest element. Never skip an
    // element with missing evidence to borrow a permissive ancestor's value.
    let parent = nodes[index].parent;
    while (parent >= 0 && nodes[parent].type !== 1) parent = nodes[parent].parent;
    if (parent < 0) return false;
    const rows = nodes[parent].layouts;
    if (rows.length !== 1 || rows[0].styles.length !== NATIVE_LIEPIN_PARAGRAPH_STYLES.length) return false;
    const whiteSpace = rows[0].styles[NATIVE_ROOT_SCROLL_STYLES.length];
    return ["pre-line", "pre", "pre-wrap", "break-spaces"].includes(whiteSpace)
      && layouts.every(layout => layout.styles.length !== NATIVE_LIEPIN_PARAGRAPH_STYLES.length || layout.styles[NATIVE_ROOT_SCROLL_STYLES.length] === whiteSpace);
  };
  const renderedText = (index: number, forGate = false, preserveParagraphs = false): string => {
    const layouts = visibleLayouts(index, forGate);
    if (!layouts.length) return "";
    const text = layouts[0].text;
    if (layouts.some(layout => layout.text !== text)) {
      if (forGate) return layouts.map(layout => layout.boxes.map(box => layout.text.slice(box.start, box.end)).join(" ")).join(" ");
      // CDP provides offsets within each LayoutObject, not offsets into a shared
      // DOM string. Different fragments cannot safely be ordered or deduplicated.
      fail("snapshot_visibility_unsupported", "text_fragment_mapping");
    }
    const ranges = layouts.flatMap(layout => layout.boxes).sort((a, b) => a.start - b.start);
    const merged: { start: number; end: number }[] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end); else merged.push({ start: range.start, end: range.end });
    }
    if (!forGate) {
      let previous = 0;
      for (const range of merged) {
        if (text.slice(previous, range.start).trim()) fail("snapshot_visibility_unsupported", "text_range_gap");
        previous = range.end;
      }
      if (text.slice(previous).trim()) fail("snapshot_visibility_unsupported", "text_range_gap");
    }
    // Only final scoped Liepin output can preserve LF from a whitespace-only
    // layout gap. Visual wrapping, raw DOM values and gate text never add LF.
    if (!forGate && preserveParagraphs && preservesParagraphBreaks(index, layouts)) {
      return merged.map((range, at) => {
        const gap = at ? text.slice(merged[at - 1].end, range.start) : "";
        const separator = at ? (gap.includes("\n") ? gap.replace(/[^\n]/g, "") : " ") : "";
        return separator + text.slice(range.start, range.end);
      }).join("");
    }
    // A gap is rendered as a separator; never join two nonadjacent words into a new fact.
    return merged.map(range => text.slice(range.start, range.end)).join(" ");
  };
  const descendants = (index: number): string => renderedText(index, true) + nodes[index].children.map(descendants).join("");
  let gate: BrowserSnapshot["gate"];
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    if (node.type !== 1 || hidden(i) || !(node.attrs.get("role") === "dialog" || node.attrs.get("aria-modal") === "true" || (node.name === "DIALOG" && node.attrs.has("open")))) continue;
    const text = descendants(i);
    if (/安全验证|人机验证|访问验证|验证码/.test(text)) { gate = "verification_required"; break; }
    if (/请先登录|请登录|登录后查看/.test(text)) gate = "login_required";
  }
  const bodyIndices = nodes.flatMap((node, index) => node.type === 1 && node.name === "BODY" ? [index] : []);
  if (bodyIndices.length !== 1) fail("document_body_missing");
  const bodyIndex = bodyIndices[0];
  let visibleFrames = 0;
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    if (["IFRAME", "FRAME"].includes(node.name) && node.layouts.some(layout => layout.bounds[2] && layout.bounds[3]) && !hidden(i)) visibleFrames++;
  }
  if (visibleFrames > 1000) fail("snapshot_limit_exceeded");
  // Return a real gate even when all its text lives inside an excluded form and body is empty.
  if (gate) return { html: "<html><head></head><body></body></html>", url: frame.url, title, gate, pageLoad: { readyState: load.readyState, content: "unknown", visibleFrames } };

  if (options.purpose === "search") {
    // Do not let a hidden row conceal contradictory visible gate evidence.
    for (const node of nodes) {
      const styled = node.layouts;
      if (styled.some(row => row.styles.length !== styled[0].styles.length || row.styles.some((value, at) => value !== styled[0].styles[at]))) fail("snapshot_visibility_unsupported", "layout_style_conflict");
    }
    // A list is a partial excerpt. Check the entire rendered page for gates
    // before omitting any unsafe field, including text inside navigation/forms.
    const gateText = descendants(bodyIndex).replace(/\s+/g, " ").trim();
    const rawTitle = (index: number): string => nodes[index].type === 3 ? nodes[index].value : nodes[index].children.map(rawTitle).join("");
    const titles = [title.trim(), ...nodes.flatMap((node, index) => node.name === "TITLE" && node.parent >= 0 && nodes[node.parent].name === "HEAD" ? [rawTitle(index).trim()] : [])];
    if (/安全验证|人机验证|访问验证|请.{0,12}验证码|拖动.{0,12}滑块|verify.{0,25}(?:human|identity)|checking your browser|猎聘安全中心发现您的(?:帐号|账号)或IP可能存在异常/i.test(gateText)
      || titles.some(value => /^(?:安全验证|访问验证|人机验证|验证码|security verification|just a moment|access denied|robot check)(?:\s|[|·:：_—-]|$)/i.test(value))) gate = "verification_required";
    else if (/请先登录|请登录后|登录后(?:查看|浏览|继续)|sign in to (?:view|continue|see)|join to (?:view|see)/i.test(gateText)
      || titles.some(value => /^(?:(?:用户|账号|帐号|会员)?登录|sign[ -]?in|log[ -]?in)(?:\s*(?:[|·:：_—-]|$))/i.test(value))) gate = "login_required";
    if (gate) return { html: "<html><head></head><body></body></html>", url: frame.url, title, gate, pageLoad: { readyState: load.readyState, content: "unknown", visibleFrames } };

    const ordinary = (row: Layout) => hasRootStyleColumns(row.styles.length) && row.styles[15] === "1" && row.styles[16] === "ltr"
      && row.styles[17] === "horizontal-tb" && ["static", "relative", "absolute"].includes(row.styles[18]) && row.styles[19] === "none";
    const sameStyles = (node: Node) => node.layouts.every(row => row.styles.length === node.layouts[0].styles.length && row.styles.every((value, at) => value === node.layouts[0].styles[at]));
    const finite = (number: unknown): number is number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 10_000_000;
    const rootIndex = nodes[bodyIndex].parent, root = nodes[rootIndex];
    let rootArea: Rect | undefined;
    if (identifiedHtmlRoot && root?.name === "HTML" && root.parent === 0 && root.layouts.length === 1 && ordinary(root.layouts[0])) {
      const row = root.layouts[0], offset = row.offsetRect, client = row.clientRect, scroll = row.scrollRect;
      if (offset && client && scroll && offset[2] > 0 && offset[3] > 0 && client[2] > 0 && client[3] > 0) {
        const scale = row.bounds[2] / offset[2], near = (actual: number, expected: number) => Math.abs(actual - expected) <= scale + 1e-6;
        if (scale >= .25 && scale <= 8 && row.bounds[0] === 0 && row.bounds[1] === 0 && offset[0] === 0 && offset[1] === 0
          && client[0] === 0 && client[1] === 0 && scroll[0] >= 0 && scroll[1] >= 0 && scroll[2] >= client[2] && scroll[3] >= client[3]
          && scroll[0] <= scroll[2] - client[2] + 1 && scroll[1] <= scroll[3] - client[3] + 1 && near(row.bounds[3], offset[3] * scale)
          && finite(doc.contentWidth) && finite(doc.contentHeight) && finite(doc.scrollOffsetX) && finite(doc.scrollOffsetY)
          && near(doc.contentWidth, scroll[2] * scale) && near(doc.contentHeight, scroll[3] * scale)
          && near(doc.scrollOffsetX, scroll[0] * scale) && near(doc.scrollOffsetY, scroll[1] * scale)) rootArea = [0, 0, doc.contentWidth, doc.contentHeight];
      }
    }
    const clientArea = (row: Layout): Rect | undefined => {
      const offset = row.offsetRect, client = row.clientRect, scroll = row.scrollRect;
      if (!ordinary(row) || !offset || !client || !scroll || offset[2] <= 0 || offset[3] <= 0 || client[0] < 0 || client[1] < 0 || client[2] <= 0 || client[3] <= 0) return;
      const scale = row.bounds[2] / offset[2];
      if (scale < .25 || scale > 8 || Math.abs(row.bounds[3] - offset[3] * scale) > scale + 1e-6
        || client[0] + client[2] > offset[2] + 1 || client[1] + client[3] > offset[3] + 1
        || scroll[0] < 0 || scroll[1] < 0 || scroll[2] < client[2] || scroll[3] < client[3]
        || scroll[0] > scroll[2] - client[2] + 1 || scroll[1] > scroll[3] - client[3] + 1) return;
      // clientLeft/Top are border offsets in CSS units. Text boxes already
      // reflect local scrolling, so never subtract scrollLeft/Top a second time.
      return [row.bounds[0] + client[0] * scale, row.bounds[1] + client[1] * scale, client[2] * scale, client[3] * scale];
    };
    const contained = (box: Rect, area: Rect, axis: 0 | 1) => box[axis] >= area[axis] && box[axis] + box[axis + 2] <= area[axis] + area[axis + 2];
    const snippets = new Map<number, string>();
    for (let index = 0; index < count; index++) {
      if (nodes[index].type !== 3 || !visible(index)) continue;
      const layouts = visibleLayouts(index), text = layouts[0].text;
      if (layouts.some(row => row.text !== text)) continue;
      const ranges = layouts.flatMap(row => row.boxes).sort((first, second) => first.start - second.start);
      let safe = true;
      for (let at = index; at >= 0 && safe; at = nodes[at].parent) {
        const node = nodes[at];
        if (node.special || !sameStyles(node)) { safe = false; break; }
        if (node.type !== 1) continue;
        if (node.layouts.length !== 1) { safe = false; break; }
        const row = node.layouts[0], styles = row.styles;
        if (styles.some(value => !value) || styles[3] !== "visible" || (styles[8] && styles[8] !== "auto") || styles.slice(9, 14).some(value => value !== "none")
          || (styles.length > NATIVE_SNAPSHOT_STYLES.length && !ordinary(row))) { safe = false; break; }
        const clipX = !["visible", "unset", "initial"].includes(styles[4]), clipY = !["visible", "unset", "initial"].includes(styles[5]);
        const decorated = styles[6] !== "clip" || !["none", "0"].includes(styles[7]);
        if (clipX || clipY || decorated) {
          if (!["visible", "unset", "initial", "hidden", "clip", "auto", "scroll"].includes(styles[4]) || !["visible", "unset", "initial", "hidden", "clip", "auto", "scroll"].includes(styles[5])) { safe = false; break; }
          const area = at === rootIndex ? rootArea : clientArea(row);
          if (!area) { safe = false; break; }
          // An ellipsis or line fold can cover otherwise intersecting glyphs.
          // Adopt it only when independent scroll metrics prove no overflow.
          if (decorated && (!row.clientRect || !row.scrollRect || row.scrollRect[2] > row.clientRect[2] || row.scrollRect[3] > row.clientRect[3])) { safe = false; break; }
          if (ranges.some(range => (clipX || decorated) && !contained(range.bounds, area, 0) || (clipY || decorated) && !contained(range.bounds, area, 1))) { safe = false; break; }
        }
      }
      if (!safe) continue;
      const merged: Array<{ start: number; end: number }> = [];
      for (const range of ranges) { const previous = merged.at(-1); if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end); else merged.push({ start: range.start, end: range.end }); }
      let previous = 0;
      for (const range of merged) { if (text.slice(previous, range.start).trim()) safe = false; previous = range.end; }
      if (text.slice(previous).trim()) safe = false;
      // Omit incomplete semantic fields rather than publishing a title/salary
      // prefix as a complete value. Other safe fields in the card survive.
      if (safe) snippets.set(index, merged.map(range => text.slice(range.start, range.end)).join(" "));
    }
    // A field can span several text nodes. Suppressing only its clipped suffix
    // would turn the retained prefix into a full-looking title or salary.
    // These are the scalar wrappers used by the built-in search configurations.
    const fieldClasses = new Set([
      "jobname", "job-name", "job-title", "jname", "company-name", "companyName", "cname", "com_name",
      "job-area", "jobarea", "workarea", "work-area", "job-location", "job-dq-box", "job-dq",
      // The observed Liepin build's salary span must remain a whole scalar,
      // including when only its suffix is clipped or visually unsupported.
      "salary", "job-salary", "sal", "text-warning", "_40108qjbMk", "job-publish-time", "published-time", "job-published-time",
      "base-search-card__title", "job-card-list__title--link", "job-card-list__title", "job-card-container__link",
      "base-search-card__subtitle", "job-card-container__primary-description", "job-search-card__location", "job-card-container__location",
      "job-search-card__salary-info", "job-card-container__salary-info",
    ]);
    const classes = nodes.map(node => (node.attrs.get("class") ?? "").split(/\s+/));
    // The current Liepin card places the title and location in distinct
    // ellipsis wrappers. Keep each scalar atomic when only a prefix renders.
    const currentLiepinTitleField = (index: number): boolean => {
      const node = nodes[index], parent = node.parent;
      if (!classes[index].includes("ellipsis-1") || parent < 0) return false;
      if (classes[parent].includes("jobTitleBox")) return true;
      const grandparent = nodes[parent].parent;
      return node.name === "SPAN" && nodes[parent].name === "DIV" && grandparent >= 0 && classes[grandparent].includes("jobTitleBox");
    };
    const fields = nodes.map((node, index) => node.type === 1 && (/^(?:H[1-6]|TIME)$/.test(node.name) || classes[index].some(name => fieldClasses.has(name))
      || currentLiepinTitleField(index)
      || classes[index].includes("name") && (() => { for (let at = node.parent; at >= 0; at = nodes[at].parent) if (classes[at].some(name => name === "company-info" || name === "company-text")) return true; return false; })()));
    const nestedFields = new Set<number>();
    for (let index = count - 1; index >= 0; index--) if (fields[index] || nestedFields.has(index)) { const parent = nodes[index].parent; if (parent >= 0) nestedFields.add(parent); }
    // A bare title link is atomic. A link surrounding independently identified
    // card fields keeps the complete fields when another scalar field is omitted.
    for (let index = 0; index < count; index++) if (nodes[index].name === "A" && !nestedFields.has(index)) fields[index] = true;
    const incomplete = new Set<number>();
    for (let index = 0; index < count; index++) {
      const node = nodes[index];
      if (node.type !== 3 || snippets.has(index) || hidden(index) || excluded(index) || transparent(index)) continue;
      const uncertain = node.layouts.length ? node.layouts.some(row => row.opacity !== 0 && !!row.text.trim()) : !!node.value.trim();
      if (!uncertain) continue;
      for (let at = node.parent; at >= 0; at = nodes[at].parent) if (fields[at]) incomplete.add(at);
    }
    const contentCache = new Map<number, boolean>();
    const hasContent = (index: number): boolean => {
      if (contentCache.has(index)) return contentCache.get(index)!;
      const node = nodes[index], result = !incomplete.has(index) && (node.type === 3 ? !!snippets.get(index)?.trim() : node.children.some(hasContent));
      contentCache.set(index, result); return result;
    };
    let units = 0;
    // Only the configured class/tag root selectors are inspected. Do not retain
    // class names, attributes, text or URLs in the diagnostic result.
    let searchPlatform: SearchProjectionDiagnostics["platform"] | undefined;
    try { searchPlatform = allowedJobUrl(frame.url).platform; } catch { /* Unrecognized pages receive no platform diagnostic. */ }
    const diagnosticSelectors = searchPlatform ? JOB_SEARCH_CAPTURE_CONFIGS[searchPlatform].cardSelectors : [];
    const simpleMatch = (index: number, selector: string): boolean => {
      const node = nodes[index];
      if (!node || node.type !== 1) return false;
      if (/^\.[\w-]+$/.test(selector)) return classes[index].includes(selector.slice(1));
      return /^[a-z][a-z0-9-]*$/i.test(selector) && node.name.toLowerCase() === selector.toLowerCase();
    };
    const diagnosticRoots = new Set<number>();
    for (let index = 0; index < count; index++) if (nodes[index].type === 1 && diagnosticSelectors.some(selector => {
      const parts = selector.split(/\s*>\s*/);
      return parts.length === 1 ? simpleMatch(index, parts[0]) : parts.length === 2 && simpleMatch(index, parts[1]) && simpleMatch(nodes[index].parent, parts[0]);
    })) diagnosticRoots.add(index);
    const projectedRoots = new Set<number>();
    const renderSearch = (index: number): string => {
      const node = nodes[index];
      if (incomplete.has(index)) return "";
      if (node.type === 3) { const text = escapeText(snippets.get(index) ?? ""); units += text.length; if (units > MAX_HTML_BYTES) fail("snapshot_limit_exceeded"); return text; }
      if (node.type !== 1) return node.children.map(renderSearch).join("");
      if (hidden(index) || excluded(index) || ["HEAD", "TITLE"].includes(node.name)) return "";
      const name = node.name.toLowerCase(); if (!/^[a-z][a-z0-9-]*$/.test(name)) return "";
      if (diagnosticRoots.has(index)) projectedRoots.add(index);
      const keys = ["class", "id", "role", "aria-modal", "open", ...(hasContent(index) && node.name === "A" ? ["href"] : []), ...(hasContent(index) && node.name === "TIME" ? ["datetime"] : [])];
      const attrs = keys.filter(key => node.attrs.has(key)).map(key => ` ${key}="${escapeAttribute(node.attrs.get(key)!)}"`).join("");
      const result = `<${name}${attrs}>${node.children.map(renderSearch).join("")}${VOID_TAGS.has(node.name) ? "" : `</${name}>`}`;
      units += name.length * 2 + attrs.length + 5; if (units > MAX_HTML_BYTES) fail("snapshot_limit_exceeded"); return result;
    };
    // Search never copies hidden JSON-LD, canonical tags or DOM text as fallback.
    const html = `<html><head></head>${renderSearch(bodyIndex)}</html>`;
    if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) fail("snapshot_limit_exceeded");
    let searchDiagnostics: SearchProjectionDiagnostics | undefined;
    if (searchPlatform) {
      searchDiagnostics = { schemaVersion: 1, platform: searchPlatform, rawRoots: diagnosticRoots.size,
        hiddenRoots: 0, excludedRoots: 0, incompleteRoots: 0, otherRemovedRoots: 0,
        projectedRoots: projectedRoots.size, projectedRootsWithText: [...projectedRoots].filter(hasContent).length };
      for (const index of diagnosticRoots) {
        if (projectedRoots.has(index)) continue;
        if (hidden(index)) searchDiagnostics.hiddenRoots++;
        else if (excluded(index)) searchDiagnostics.excludedRoots++;
        else {
          let incompleteAncestor = false;
          for (let at = index; at >= 0; at = nodes[at].parent) if (incomplete.has(at)) { incompleteAncestor = true; break; }
          if (incompleteAncestor) searchDiagnostics.incompleteRoots++;
          else searchDiagnostics.otherRemovedRoots++;
        }
      }
    }
    return { html, url: frame.url, title, ...(searchDiagnostics ? { searchDiagnostics } : {}), pageLoad: { readyState: load.readyState, content: hasContent(bodyIndex) ? "visible_text" : visibleFrames ? "embedded_content" : "empty", visibleFrames } };
  }

  // Scope only explicitly identified original jobs. Decode the whole protocol
  // table and retain full-page gate and text semantics in every mode.
  let adopted: Set<number> | undefined;
  let liepinParagraphNodes: Set<number> | undefined;
  const liepinRequirements: number[] = [];
  let bossDescriptionCandidates: number[] = [];
  const bossScoped = options.scope === "boss-share" && isOriginalBossShare(frame.url, options.sourceUrl);
  const liepinScoped = options.scope === "liepin-job" && rootScrollMode && identifiedHtmlRoot;
  if (bossScoped || liepinScoped) {
    const hasClass = (index: number, name: string) => (nodes[index].attrs.get("class") ?? "").split(/\s+/).includes(name);
    const withinBody = (index: number) => {
      for (let i = index; i >= 0; i = nodes[i].parent) if (i === bodyIndex) return true;
      return false;
    };
    const hasShareAncestor = (index: number) => {
      for (let i = nodes[index].parent; i >= 0; i = nodes[i].parent) if (nodes[i].type === 1 && hasClass(i, "share-position")) return true;
      return false;
    };
    const publicText = (index: number): string => {
      const node = nodes[index];
      if (node.type === 3) return renderedText(index, true);
      if (node.type === 1 && (hidden(index) || excluded(index) || ["HEAD", "TITLE"].includes(node.name))) return "";
      const text = node.children.map(publicText).join("");
      if (node.name === "BR") return "\n";
      return (node.name === "LI" ? "• " : "") + text + (/^(?:P|DIV|LI|H[1-6]|SECTION|ARTICLE|TR)$/.test(node.name) ? "\n" : "");
    };
    const candidates = nodes.flatMap((node, index) => {
      if (node.type !== 1 || !withinBody(index)) return [];
      if (bossScoped) return node.name === "DIV" && hasClass(index, "detail-text")
        && node.parent >= 0 && nodes[node.parent].type === 1 && nodes[node.parent].name === "DIV" && hasClass(node.parent, "rec-detail")
        && hasShareAncestor(index) ? [index] : [];
      if (["job-intro-content", "job-description", "job-desc-content"].some(name => hasClass(index, name))) return [index];
      const parent = nodes[node.parent];
      return node.name === "DL" && hasClass(index, "paragraph") && parent?.type === 1 && parent.name === "SECTION" && hasClass(node.parent, "job-intro-container")
        && node.children.some(child => nodes[child].type === 1 && nodes[child].name === "DT" && isLiepinDescriptionHeading(publicText(child))) ? [index] : [];
    });
    if (liepinScoped) {
      // Retain explicit requirements beside identified duties in their own
      // section. The extractor combines only one duties DL and rejects an
      // ambiguous owner; never infer a hidden label or merge separate sections.
      const dutiesBySection = new Map<number, number[]>();
      for (const index of candidates) {
        const node = nodes[index], parent = nodes[node.parent];
        if (node.name !== "DL" || !hasClass(index, "paragraph") || parent?.name !== "SECTION" || !hasClass(node.parent, "job-intro-container")
            || !node.children.some(child => nodes[child].name === "DT" && isLiepinDescriptionHeading(publicText(child)))) continue;
        const duties = dutiesBySection.get(node.parent) ?? [];
        duties.push(index); dutiesBySection.set(node.parent, duties);
      }
      for (const [section, duties] of dutiesBySection) {
        for (const index of nodes[section].children) {
          const node = nodes[index];
          if (node.type !== 1 || node.name !== "DL" || !hasClass(index, "paragraph") || duties.includes(index)
              || !node.children.some(child => nodes[child].name === "DT" && isLiepinRequirementsHeading(publicText(child)))) continue;
          liepinRequirements.push(index);
          if (!candidates.includes(index)) candidates.push(index);
        }
      }
    }
    if (candidates.length) {
      // Keep every previously supported BOSS description too. Scoping must not
      // turn two independent jobs into an apparently unambiguous single job.
      const existingCandidates = bossScoped ? nodes.flatMap((node, index) => node.type === 1 && hasClass(index, "job-sec-text") && withinBody(index) ? [index] : []) : [];
      if (bossScoped) bossDescriptionCandidates = [...candidates, ...existingCandidates];
      // Prefix/title gates are normally detected later by the extractor. Preserve
      // that full-page rejection evidence before unrelated siblings are omitted.
      const normalize = (text: string) => text.replace(/\u00a0/g, " ").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      const bodyText = normalize(publicText(bodyIndex));
      const hasVisibleText = (index: number): boolean => visible(index) || nodes[index].children.some(hasVisibleText);
      const heading = nodes.findIndex((node, index) => node.name === "H1" && node.type === 1 && withinBody(index) && !hidden(index) && !excluded(index) && hasVisibleText(index));
      const headingText = heading >= 0 ? normalize(publicText(heading)) : "";
      const loginTitle = /^(?:(?:用户|账号|帐号|会员)?登录|sign[ -]?in|log[ -]?in)(?:\s*(?:[|·:：_—-]|$))/i;
      const verificationTitle = /^(?:安全验证|访问验证|人机验证|验证码|security verification|just a moment|access denied|robot check)(?:\s|[|·:：_—-]|$)/i;
      const loginPrefix = /^(?:请先登录|请登录后查看|登录后查看|sign in to continue)/i;
      const verificationPrefix = /^(?:请完成(?:安全|访问|人机)验证|请(?:输入|填写)验证码|verify (?:that )?you are human|checking your browser)/i;
      const rawContent = (index: number): string => nodes[index].type === 3 ? nodes[index].value : nodes[index].children.map(rawContent).join("");
      const firstTitle = nodes.findIndex((node) => {
        if (node.name !== "TITLE") return false;
        for (let i = node.parent; i >= 0; i = nodes[i].parent) if (nodes[i].name === "HEAD") return true;
        return false;
      });
      const pageTitles = [title.trim(), ...(firstTitle >= 0 ? [rawContent(firstTitle).trim()] : [])];
      if (pageTitles.some(text => loginTitle.test(text)) || loginTitle.test(headingText) || loginPrefix.test(bodyText)) gate = "login_required";
      if (!gate && (pageTitles.some(text => verificationTitle.test(text)) || verificationTitle.test(headingText) || verificationPrefix.test(bodyText))) gate = "verification_required";
      const bossLoginTitle = /^(?:【BOSS直聘注册登录】BOSS直聘在线注册登录|BOSS直聘注册登录|(?:注册[/·]?登录|登录[/·]?注册|登录))(?:[-—_|]BOSS直聘)?$/i;
      const compactBody = bodyText.replace(/\s+/g, "");
      if (!gate && bossScoped && pageTitles.some(text => bossLoginTitle.test(text.replace(/\s+/g, ""))) && (/(?:微信|手机|账号密码|账号|密码|短信|验证码|扫码)登录|(?:注册[/·]登录|登录[/·]注册)/.test(compactBody)
        || (/(?:手机号|手机号码)/.test(compactBody) && /(?:验证码|密码)/.test(compactBody)))) gate = "login_required";
      // Keep the existing observed Liepin notice before scoped output removes
      // unrelated siblings. Regression cases compare this exact text rule to
      // isObservedLiepinVerification without importing its browser dependency.
      if (!gate && liepinScoped && /猎聘安全中心发现您的(?:帐号|账号)或IP可能存在异常[，,。；;：:]*为了保障您的(?:帐号|账号)及资源安全[，,。；;：:]*请进行安全验证/i.test(compactBody)) gate = "verification_required";
      if (gate) return { html: "<html><head></head><body></body></html>", url: frame.url, title, gate, pageLoad: { readyState: load.readyState, content: "unknown", visibleFrames } };
      adopted = new Set<number>();
      const includeSubtree = (index: number) => { adopted!.add(index); for (const child of nodes[index].children) includeSubtree(child); };
      const includeAncestors = (index: number) => { for (let i = index; i >= 0; i = nodes[i].parent) adopted!.add(i); };
      for (const index of [...candidates, ...existingCandidates, ...(heading >= 0 ? [heading] : [])]) { includeSubtree(index); includeAncestors(index); }
      if (liepinScoped) {
        liepinParagraphNodes = new Set<number>();
        const includeParagraph = (index: number) => { liepinParagraphNodes!.add(index); for (const child of nodes[index].children) includeParagraph(child); };
        for (const index of candidates) {
          const legacyDescription = ["job-intro-content", "job-description", "job-desc-content"].some(name => hasClass(index, name));
          if (nodes[index].name === "DL" && !legacyDescription) {
            for (const child of nodes[index].children) if (nodes[child].name === "DD") includeParagraph(child);
          } else includeParagraph(index);
        }
      }
    }
  }

  // Resolve conflicting visibility styles before using any one row to hide a
  // subtree. Otherwise a transparent first row could conceal a visible second row.
  for (const node of nodes) {
    const styled = node.layouts;
    if (styled.some(layout => layout.styles.length !== styled[0].styles.length || layout.styles.some((value, key) => value !== styled[0].styles[key]))) fail("snapshot_visibility_unsupported", "layout_style_conflict");
  }
  // Recognize only the observed mobile description fold. This never permits
  // output: defer its diagnostic until every other text/CSS check has passed.
  // Missing, conflicting or unrelated evidence keeps the ordinary failure.
  let foldedBossCandidate: number | undefined;
  if (bossScoped && bossDescriptionCandidates.length === 1) {
    const index = bossDescriptionCandidates[0], node = nodes[index];
    const classes = (node.attrs.get("class") ?? "").split(/\s+/);
    const row = node.layouts.length === 1 ? node.layouts[0] : undefined;
    const client = row?.clientRect, scroll = row?.scrollRect, offset = row?.offsetRect;
    const hasPublicText = (at: number): boolean => nodes[at].type === 3
      ? visibleLayouts(at).some(layout => !!layout.text.trim()) : nodes[at].children.some(hasPublicText);
    if (node.name === "DIV" && ["detail-text", "show-switch", "four-lines"].every(name => classes.includes(name))
      && !hidden(index) && !excluded(index) && !transparent(index) && hasPublicText(index)
      && row && ["-webkit-box", "flow-root"].includes(row.styles[0]) && row.styles[7] === "4" && row.styles[5] === "hidden"
      && ["visible", "hidden"].includes(row.styles[4]) && row.bounds[2] > 0 && row.bounds[3] > 0
      && client && scroll && offset && client[0] === 0 && client[1] === 0 && scroll[0] === 0 && scroll[1] === 0
      && client[2] > 0 && client[3] > 0 && offset[2] > 0 && offset[3] > 0
      && client[2] <= offset[2] + 1 && client[3] <= offset[3] + 1
      && scroll[2] >= client[2] && scroll[3] > client[3] + 1) foldedBossCandidate = index;
  }
  const foldedDirectSuffixGap = (index: number): boolean => {
    if (foldedBossCandidate === undefined || nodes[index].type !== 3 || nodes[index].parent !== foldedBossCandidate || nodes[index].layouts.length !== 1) return false;
    const layouts = visibleLayouts(index);
    if (layouts.length !== 1) return false;
    const row = layouts[0], ranges = [...row.boxes].sort((a, b) => a.start - b.start);
    let previous = 0, renderedMeaningful = false;
    for (const range of ranges) {
      // Only an omitted suffix of the observed single text LayoutObject can
      // explain this fold. Meaningful prefix/internal omissions remain errors.
      if (row.text.slice(previous, range.start).trim()) return false;
      if (row.text.slice(range.start, range.end).trim()) renderedMeaningful = true;
      previous = Math.max(previous, range.end);
    }
    return renderedMeaningful && !!row.text.slice(previous).trim();
  };
  for (let i = 0; i < count; i++) if (visible(i)) {
    // Gate evidence anywhere on the page must retain complete, ordered text.
    // Scope only relaxes unrelated CSS geometry effects, never text semantics.
    for (let ancestor = i; ancestor >= 0; ancestor = nodes[ancestor].parent) if (nodes[ancestor].special) fail("snapshot_visibility_unsupported", "shadow_or_pseudo");
    if (!adopted || adopted.has(i)) {
      if (liepinScoped && adopted && !ordinaryRootText(i)) fail("snapshot_visibility_unsupported", "overflow_clip_or_scroll");
      const detail = unsupported(i, foldedBossCandidate);
      if (detail) fail("snapshot_visibility_unsupported", detail);
    }
    // Non-text LayoutObjects can carry generated text of their own. They must
    // never silently disappear because their pseudo tag is not serialized.
    if (nodes[i].type !== 3) fail("snapshot_visibility_unsupported", "text_fragment_mapping");
    try { renderedText(i); }
    catch (error) {
      if (!(error instanceof NativeDomSnapshotError) || error.code !== "snapshot_visibility_unsupported" || error.detail !== "text_range_gap" || !foldedDirectSuffixGap(i)) throw error;
      // The observed four-line fold can omit its direct text suffix entirely.
      // Continue validating every other node, then return only the fold failure.
    }
  }
  // Once a visible requirements DT is identified, a hidden/empty DD cannot be
  // discarded and leave an apparently complete duties-only result. Raw DOM
  // text is used only to reject missing non-whitespace evidence, never as a
  // heading classifier, output, or replacement for rendered text ranges.
  const completeRequirements = (index: number): string => {
    const node = nodes[index];
    if (excluded(index)) return "";
    if (hidden(index) || transparent(index)) fail("snapshot_visibility_unsupported", "text_range_gap");
    if (node.type === 3) {
      if ((node.value.trim() || node.layouts.some(layout => layout.text.trim())) && !visible(index)) fail("snapshot_visibility_unsupported", "text_range_gap");
      return renderedText(index, false, ordinaryRootText(index));
    }
    return node.children.map(completeRequirements).join("");
  };
  for (const index of liepinRequirements) {
    const paragraphs = nodes[index].children.filter(child => nodes[child].name === "DD" && !excluded(child));
    if (!paragraphs.length) fail("snapshot_visibility_unsupported", "text_range_gap");
    for (const paragraph of paragraphs) if (!completeRequirements(paragraph).trim()) fail("snapshot_visibility_unsupported", "text_range_gap");
  }
  if (foldedBossCandidate !== undefined) fail("snapshot_visibility_unsupported", "boss_description_collapsed");
  const metadata: string[] = [];
  const content = (index: number): string => nodes[index].type === 3 ? nodes[index].value : nodes[index].children.map(content).join("");
  const hasAncestor = (index: number, name: string): boolean => {
    for (let i = nodes[index].parent; i >= 0; i = nodes[i].parent) if (nodes[i].name === name) return true;
    return false;
  };
  for (let i = 0; i < count; i++) {
    const node = nodes[i];
    if (node.name === "TITLE" && hasAncestor(i, "HEAD")) metadata.push(`<title>${escapeText(content(i))}</title>`);
    if (node.name === "LINK" && hasAncestor(i, "HEAD") && (node.attrs.get("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) metadata.push(`<link rel="canonical" href="${escapeAttribute(node.attrs.get("href") ?? "")}">`);
    if (node.name === "SCRIPT" && node.attrs.get("type")?.trim().toLowerCase() === "application/ld+json" && !hasAncestor(i, "FORM")) metadata.push(`<script type="application/ld+json">${content(i).replace(/<\/script/gi, "<\\/script")}</script>`);
  }
  let outputUnits = metadata.join("").length;
  let hasText = false;
  const visibleSearchContent = (index: number): boolean => {
    const node = nodes[index];
    if (adopted && !adopted.has(index)) return false;
    if (node.type === 3) return visible(index);
    if (node.type === 1 && (hidden(index) || excluded(index))) return false;
    return node.children.some(visibleSearchContent);
  };
  const render = (index: number): string => {
    if (adopted && !adopted.has(index)) return "";
    const node = nodes[index];
    if (node.type === 3) {
      const text = renderedText(index, false, liepinScoped && liepinParagraphNodes?.has(index) === true && ordinaryRootText(index)); if (text.trim()) hasText = true;
      const escaped = escapeText(text); outputUnits += escaped.length;
      if (outputUnits > MAX_HTML_BYTES) fail("snapshot_limit_exceeded");
      return escaped;
    }
    if (node.type !== 1) return node.children.map(render).join("");
    if (hidden(index) || excluded(index) || ["HEAD", "TITLE"].includes(node.name)) return "";
    const name = node.name.toLowerCase();
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return "";
    const attributeNames = ["class", "id", "role", "aria-modal", "open"];
    // Search metadata remains exact untrusted text, never resolved URLs or inferred dates.
    if (options.purpose === "search" && ((node.name === "A" && node.attrs.has("href")) || (node.name === "TIME" && node.attrs.has("datetime"))) && visibleSearchContent(index)) {
      if (node.name === "A") attributeNames.push("href");
      if (node.name === "TIME") attributeNames.push("datetime");
    }
    const attrs = attributeNames.filter(key => node.attrs.has(key)).map(key => ` ${key}="${escapeAttribute(node.attrs.get(key)!)}"`).join("");
    const result = `<${name}${attrs}>${node.children.map(render).join("")}${VOID_TAGS.has(node.name) ? "" : `</${name}>`}`;
    outputUnits += name.length * 2 + attrs.length + 5;
    if (outputUnits > MAX_HTML_BYTES) fail("snapshot_limit_exceeded");
    return result;
  };
  const html = `<html><head>${metadata.join("")}</head>${render(bodyIndex)}</html>`;
  if (Buffer.byteLength(html, "utf8") > MAX_HTML_BYTES) fail("snapshot_limit_exceeded");
  return { html, url: frame.url, title, pageLoad: { readyState: load.readyState, content: hasText ? "visible_text" : visibleFrames ? "embedded_content" : "empty", visibleFrames } };
}
