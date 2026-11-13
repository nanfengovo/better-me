import {
  A4_PAGE, DOM_ESTIMATE_LIMITATIONS, mmToCssPx, printGeometry, unavailableLayout,
  type LayoutBlock, type LayoutLine, type LayoutMeasurement, type LayoutRect, type LayoutRenderBinding, type LayoutScope, type PrintPageSpec,
} from "./types";

export interface DomLayoutOptions {
  scope: LayoutScope;
  renderBinding?: LayoutRenderBinding;
  page?: PrintPageSpec;
  /** A paper root includes the print margins. A content root starts at the content origin. */
  coordinateSpace?: "paper" | "content";
  signal?: AbortSignal;
  isCurrent?: () => boolean;
  timeoutMs?: number;
  settleFrames?: number;
  printWidthTolerancePx?: number;
  maxBlocks?: number;
  maxTextCharacters?: number;
  maxRangeRects?: number;
  /** CSS font descriptors, e.g. '12px "Resume Body"'. Missing fonts are reported, not concealed. */
  expectedFonts?: string[];
  selectBlocks?: (root: HTMLElement) => readonly Element[];
}

class MeasurementFailure extends Error {
  constructor(readonly reason: Parameters<typeof unavailableLayout>[1], message: string) { super(message); }
}

function visible(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let cursor: Element | null = element; cursor; cursor = cursor.parentElement) {
    if (cursor.hasAttribute("hidden")) return false;
    const style = view?.getComputedStyle(cursor);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse"
      || style?.contentVisibility === "hidden") return false;
  }
  return true;
}

function axisAligned(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let cursor: Element | null = element; cursor; cursor = cursor.parentElement) {
    const style = view?.getComputedStyle(cursor);
    const transform = style?.transform;
    if (style?.rotate && style.rotate !== "none" && !/^0(?:deg|rad|turn)?$/.test(style.rotate)) return false;
    if (!transform || transform === "none") continue;
    const matrix = /^matrix\(([^)]+)\)$/.exec(transform);
    if (matrix) {
      const entries = matrix[1]!.split(",").map(Number);
      if (entries.length !== 6 || entries.some(value => !Number.isFinite(value))
        || Math.abs(entries[1]!) > 0.0001 || Math.abs(entries[2]!) > 0.0001
        || entries[0]! <= 0 || entries[3]! <= 0) return false;
      continue;
    }
    const matrix3d = /^matrix3d\(([^)]+)\)$/.exec(transform);
    if (!matrix3d) return false;
    const entries = matrix3d[1]!.split(",").map(Number);
    const allowed = new Set([0, 5, 10, 12, 13, 14, 15]);
    if (entries.length !== 16 || entries.some((value, index) => !Number.isFinite(value)
      || (!allowed.has(index) && Math.abs(value) > 0.0001))
      || entries[0]! <= 0 || entries[5]! <= 0 || entries[15] !== 1) return false;
  }
  return true;
}

function rectUnion(left: LayoutRect, right: LayoutRect): LayoutRect {
  const x = Math.min(left.x, right.x), y = Math.min(left.y, right.y);
  return { x, y, width: Math.max(left.x + left.width, right.x + right.width) - x,
    height: Math.max(left.y + left.height, right.y + right.height) - y };
}

function defaultBlocks(root: HTMLElement): Element[] {
  const selector = "[data-layout-block], [data-preview-anchor^='claim:'], h1, h2, h3, h4, h5, h6, p, li, img";
  const candidates = Array.from(root.querySelectorAll(selector));
  if (root.matches(selector)) candidates.unshift(root);
  return candidates.filter(element => element.tagName.toLowerCase() === "img"
    || !candidates.some(child => child !== element && child.tagName.toLowerCase() !== "img" && element.contains(child)));
}

function clippedByAncestor(element: Element, normalize: (rect: DOMRect) => LayoutRect, box: LayoutRect, root: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  for (let cursor = element.parentElement; cursor && cursor !== root.parentElement; cursor = cursor.parentElement) {
    const style = view?.getComputedStyle(cursor);
    const clipX = /^(hidden|clip|scroll|auto)$/.test(style?.overflowX ?? "");
    const clipY = /^(hidden|clip|scroll|auto)$/.test(style?.overflowY ?? "");
    if (!clipX && !clipY) continue;
    const clip = normalize(cursor.getBoundingClientRect());
    if ((clipX && (box.x < clip.x - 1 || box.x + box.width > clip.x + clip.width + 1))
      || (clipY && (box.y < clip.y - 1 || box.y + box.height > clip.y + clip.height + 1))) return true;
  }
  return false;
}

interface TextBudget { characters: number; rects: number; maxCharacters: number; maxRects: number }

function measureLines(element: Element, normalize: (rect: DOMRect) => LayoutRect, budget: TextBudget, check: () => void): { text: string; lines: LayoutLine[] } {
  const document = element.ownerDocument;
  const range = document.createRange();
  if (typeof range.getClientRects !== "function") throw new MeasurementFailure("range-unavailable", "The renderer cannot measure text Range geometry");
  const walker = document.createTreeWalker(element, 4 /* SHOW_TEXT; avoid another realm's NodeFilter */);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  const text = nodes.map(node => node.data).join("");
  const lines: LayoutLine[] = [];
  let offset = 0;
  let lastGlyphEnd = -1;
  for (const node of nodes) {
    if (!node.parentElement || !visible(node.parentElement)) { offset += node.length; continue; }
    let nodeOffset = 0;
    // A code-point range keeps UTF-16 offsets correct. Combining glyphs with identical
    // geometry are merged below, rather than counted as separate lines.
    for (const character of node.data) {
      if (++budget.characters > budget.maxCharacters) throw new MeasurementFailure("measurement-budget", "The text measurement budget was exceeded");
      if (budget.characters % 64 === 0) check();
      range.setStart(node, nodeOffset);
      range.setEnd(node, nodeOffset + character.length);
      const rects = Array.from(range.getClientRects());
      budget.rects += rects.length;
      if (budget.rects > budget.maxRects) throw new MeasurementFailure("measurement-budget", "The Range geometry budget was exceeded");
      const start = offset + nodeOffset, end = start + character.length;
      for (const raw of rects) {
        if (![raw.left, raw.top, raw.width, raw.height].every(Number.isFinite) || raw.width <= 0 || raw.height <= 0) continue;
        const rect = normalize(raw);
        const previous = lines.at(-1);
        const overlap = previous ? Math.min(previous.rect.y + previous.rect.height, rect.y + rect.height)
          - Math.max(previous.rect.y, rect.y) : 0;
        const sameBaseline = previous && overlap >= Math.min(previous.rect.height, rect.height) * 0.5;
        // Text order normally changes baseline at a wrap; a large horizontal jump
        // on the same baseline represents another column, not one enormous line.
        const gap = previous ? Math.max(rect.x - (previous.rect.x + previous.rect.width), previous.rect.x - (rect.x + rect.width), 0) : 0;
        if (previous && sameBaseline && gap <= Math.max(40, rect.height * 4)) {
          previous.rect = rectUnion(previous.rect, rect);
          previous.end = end;
          previous.text = text.slice(previous.start, end);
        } else if (lastGlyphEnd !== end || !previous || !sameBaseline) {
          lines.push({ rect, text: text.slice(start, end), start, end });
        }
        lastGlyphEnd = end;
      }
      nodeOffset += character.length;
    }
    offset += node.length;
  }
  range.detach();
  return { text, lines };
}

/**
 * Read-only DOM Adapter. Call it on the actual print-sized sheet, after rendering
 * an isolated candidate. It never resizes the live preview or rewrites its text.
 */
export async function measureDomLayout(root: HTMLElement, options: DomLayoutOptions): Promise<LayoutMeasurement> {
  const { scope } = options;
  const page = options.page ?? A4_PAGE;
  const timeoutMs = Math.min(60000, Math.max(1, options.timeoutMs ?? 4000));
  const deadline = Date.now() + timeoutMs;
  const assetCleanups: (() => void)[] = [];
  const check = () => {
    if (options.signal?.aborted) throw new MeasurementFailure("cancelled", "Layout measurement was cancelled");
    if (options.isCurrent && !options.isCurrent()) throw new MeasurementFailure("stale", "The selected version or session changed");
    if (Date.now() >= deadline) throw new MeasurementFailure("timeout", "Layout measurement exceeded its deadline");
    if (!root.isConnected) throw new MeasurementFailure("detached", "The print root is not connected to a document");
    if (!visible(root)) throw new MeasurementFailure("hidden", "A hidden print root cannot supply layout evidence");
  };
  const wait = <T>(promise: PromiseLike<T>): Promise<T> => new Promise((resolve, reject) => {
    let done = false;
    const finish = (error?: unknown, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error); else resolve(value!);
    };
    const abort = () => finish(new MeasurementFailure("cancelled", "Layout measurement was cancelled"));
    const timer = setTimeout(() => finish(new MeasurementFailure("timeout", "Assets or layout did not settle before the deadline")), Math.max(1, deadline - Date.now()));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    Promise.resolve(promise).then(value => finish(undefined, value), error => finish(error));
  });

  try {
    check();
    const geometry = printGeometry(page);
    const fontSet = root.ownerDocument.fonts;
    if (fontSet) {
      try { await wait(fontSet.ready); }
      catch (error) {
        if (error instanceof MeasurementFailure) throw error;
        throw new MeasurementFailure("fonts-unavailable", "Document fonts failed to settle");
      }
    } else throw new MeasurementFailure("fonts-unavailable", "This environment cannot observe document font readiness");
    check();
    const images = [...root.querySelectorAll("img")].filter(image => visible(image));
    if (root.tagName.toLowerCase() === "img") images.unshift(root as unknown as HTMLImageElement);
    await wait(Promise.all(images.map(async image => {
      if (image.complete && image.naturalWidth > 0) return;
      if (typeof image.decode === "function") {
        try { await image.decode(); }
        catch { throw new MeasurementFailure("image-unavailable", "A visible image could not be decoded"); }
      } else {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { image.removeEventListener("load", load); image.removeEventListener("error", error); options.signal?.removeEventListener("abort", cancel); };
          assetCleanups.push(cleanup);
          const load = () => { cleanup(); resolve(); };
          const error = () => { cleanup(); reject(new MeasurementFailure("image-unavailable", "A visible image failed to load")); };
          const cancel = () => { cleanup(); reject(new MeasurementFailure("cancelled", "Image readiness was cancelled")); };
          image.addEventListener("load", load, { once: true });
          image.addEventListener("error", error, { once: true });
          options.signal?.addEventListener("abort", cancel, { once: true });
          if (image.complete) {
            if (image.naturalWidth > 0) load(); else error();
          }
        });
      }
      if (image.naturalWidth <= 0) throw new MeasurementFailure("image-unavailable", "A visible image has no decoded pixels");
    })));
    check();
    const view = root.ownerDocument.defaultView;
    for (let frame = 0; frame < Math.min(4, Math.max(0, options.settleFrames ?? 2)); frame++) {
      if (view?.requestAnimationFrame) await wait(new Promise<void>(resolve => view.requestAnimationFrame(() => resolve())));
      check();
    }
    if (!axisAligned(root)) throw new MeasurementFailure("unsupported-transform", "Rotation, skew, reflection or perspective cannot be normalized as print geometry");
    const rootRect = root.getBoundingClientRect();
    const layoutWidth = root.offsetWidth, layoutHeight = root.offsetHeight;
    if (![rootRect.left, rootRect.top, rootRect.width, rootRect.height, layoutWidth, layoutHeight].every(Number.isFinite)
      || rootRect.width <= 0 || rootRect.height <= 0 || layoutWidth <= 0 || layoutHeight <= 0) {
      throw new MeasurementFailure("zero-size", "The print root has no measurable layout box");
    }
    const expectedWidth = options.coordinateSpace === "content" ? geometry.width : geometry.paperWidth;
    // offsetWidth is integer-rounded. Never stretch a responsive preview into an
    // imaginary print layout: its line wraps were formed at a different width.
    if (Math.abs(layoutWidth - expectedWidth) > (options.printWidthTolerancePx ?? 2)) {
      throw new MeasurementFailure("print-width-mismatch", "The root was not laid out at the requested unzoomed print width");
    }
    const scale = { x: rootRect.width / layoutWidth, y: rootRect.height / layoutHeight };
    const origin = options.coordinateSpace === "content" ? { x: 0, y: 0 }
      : { x: mmToCssPx(page.marginMm.left), y: mmToCssPx(page.marginMm.top) };
    const normalize = (rect: DOMRect): LayoutRect => ({
      x: (rect.left - rootRect.left) / scale.x - origin.x,
      y: (rect.top - rootRect.top) / scale.y - origin.y,
      width: rect.width / scale.x, height: rect.height / scale.y,
    });
    const selected = [...new Set((options.selectBlocks ?? defaultBlocks)(root))];
    if (selected.length > Math.min(2000, options.maxBlocks ?? 400)) throw new MeasurementFailure("measurement-budget", "The block measurement budget was exceeded");
    const budget: TextBudget = { characters: 0, rects: 0, maxCharacters: Math.min(50000, options.maxTextCharacters ?? 18000), maxRects: Math.min(100000, options.maxRangeRects ?? 36000) };
    const blocks: LayoutBlock[] = [];
    let usesSingleLineFlowBox = false;
    for (const element of selected) {
      check();
      if (!(element === root || root.contains(element))) throw new MeasurementFailure("invalid-measurement", "A block selector escaped the authorized print root");
      if (!visible(element)) continue;
      if (!axisAligned(element)) throw new MeasurementFailure("unsupported-transform", "A content block has an unsupported print transform");
      const raw = element.getBoundingClientRect();
      if (raw.width <= 0 || raw.height <= 0) continue;
      const rect = normalize(raw);
      const tag = element.tagName.toLowerCase();
      const anchor = element.closest("[data-preview-anchor], [data-layout-anchor]")?.getAttribute("data-preview-anchor")
        ?? element.closest("[data-layout-anchor]")?.getAttribute("data-layout-anchor") ?? undefined;
      const heading = /^h[1-6]$/.test(tag) || element.getAttribute("role") === "heading";
      const kind = tag === "img" ? "image" : heading ? "heading" : anchor?.startsWith("claim:") ? "claim" : "text";
      const measured = kind === "image" ? { text: "", lines: [] } : measureLines(element, normalize, budget, check);
      if (kind !== "image" && !measured.lines.length) {
        if (measured.text.trim()) throw new MeasurementFailure("range-unavailable", "Visible text did not yield any measured line rectangles");
        continue;
      }
      const style = view?.getComputedStyle(element);
      const lineHeight = Number.parseFloat(style?.lineHeight ?? "");
      const singleLine = measured.lines.length === 1 ? measured.lines[0] : undefined;
      // A Range uses font em metrics, not glyph ink: Chromium's CJK heading can
      // have a 52px Range inside a real 44.8px CSS line box. Only use the ACTUAL
      // element's vertical flow box if it is demonstrably one line-height, with
      // no own/ancestor clipping. Preserve the raw Range and all horizontal
      // geometry. Fixed-height/overflow containers and final files get no rule.
      if (singleLine && Number.isFinite(lineHeight) && lineHeight > 0 && Math.abs(rect.height - lineHeight) <= 1
        && !/^(hidden|clip|scroll|auto)$/.test(style?.overflowY ?? "")
        && !clippedByAncestor(element, normalize, singleLine.rect, root)) {
        singleLine.flowRect = { ...singleLine.rect, y: rect.y, height: rect.height }; usesSingleLineFlowBox = true;
      }
      blocks.push({
        id: `${anchor ?? "layout-block"}:${blocks.length}`, anchor, kind, order: blocks.length,
        text: measured.text, rect, lines: measured.lines, keepWithNext: heading,
        keepTogether: heading || style?.breakInside === "avoid" || style?.breakInside === "avoid-page",
        clipped: clippedByAncestor(element, normalize, rect, root),
      });
    }
    check();
    if (!blocks.length) throw new MeasurementFailure("empty", "The print root contains no measurable visible content");
    const occupiedBottom = Math.max(...blocks.flatMap(block => block.lines.length ? block.lines.map(line => (line.flowRect ?? line.rect).y + (line.flowRect ?? line.rect).height) : [block.rect.y + block.rect.height]));
    const fontChecks = (options.expectedFonts ?? []).map(descriptor => ({ descriptor, available: fontSet?.check(descriptor) ?? false }));
    return {
      status: "measured", scope, source: "dom-estimate", page, blocks,
      pageCount: Math.max(1, Math.ceil(Math.max(0, occupiedBottom - 0.001) / geometry.height)),
      measuredAt: new Date().toISOString(), scale, fontChecks,
      renderBinding: options.renderBinding ? { ...options.renderBinding } : undefined,
      limitations: [...DOM_ESTIMATE_LIMITATIONS,
        ...(usesSingleLineFlowBox ? ["Single-line DOM flow uses the measured CSS line box vertically, retaining original font Range rectangles; em-box overhang is not proof of glyph clipping. Final files and visual ink still require independent checks."] : []),
        ...(fontChecks.some(font => !font.available) ? ["At least one requested font was unavailable; the measured layout may use a fallback font."] : [])],
    };
  } catch (error) {
    if (error instanceof MeasurementFailure) return unavailableLayout(scope, error.reason, error.message, [...DOM_ESTIMATE_LIMITATIONS]);
    return unavailableLayout(scope, "invalid-measurement", error instanceof Error ? error.message : "DOM measurement failed", [...DOM_ESTIMATE_LIMITATIONS]);
  } finally {
    for (const cleanup of assetCleanups) cleanup();
  }
}
