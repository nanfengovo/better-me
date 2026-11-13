import { useEffect, useState, type RefObject } from "react";
import type { WritingSource } from "./resume-copilot";
import { writingTargetKey } from "./resume-copilot";
import { resolveWritingQuote, writingTextRange } from "./writing-anchor";
import { showResumeEditor } from "./agent-navigation";
import { getPreviewScrollTop } from "./preview-follow";
import { writingPreviewAnchor, type WritingAnnotation } from "./writing-annotations";

export type WritingActivity = { key: string; start: number; end: number; text: string };

/** Editor adapter: IME-safe, no model calls and no layout reads on caret movement. */
export function observeResumeWriting(root: HTMLElement, onActivity: (activity: WritingActivity, check: boolean) => void) {
  let composing = false;
  const capture = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement) || !target.dataset.writingKey || composing) return;
    onActivity({ key: target.dataset.writingKey, text: target.value, start: target.selectionStart, end: target.selectionEnd },
      event.type === "input" || event.type === "focusout" || event.type === "compositionend");
  };
  const start = () => { composing = true; };
  const end = (event: Event) => { composing = false; capture(event); };
  for (const name of ["focusin", "focusout", "select", "keyup", "input"]) root.addEventListener(name, capture, true);
  root.addEventListener("compositionstart", start, true); root.addEventListener("compositionend", end, true);
  return () => {
    for (const name of ["focusin", "focusout", "select", "keyup", "input"]) root.removeEventListener(name, capture, true);
    root.removeEventListener("compositionstart", start, true); root.removeEventListener("compositionend", end, true);
  };
}

type Line = { x: number; y: number; width: number; height: number };
export type WritingGeometry = {
  annotations: (WritingAnnotation & { lines: Line[]; badge: { x: number; y: number }; active: boolean })[];
  visibility: "visible" | "above" | "below" | "unavailable";
  path?: string; x: number; y: number; tx: number; ty: number;
};

/** Viewport coordinates, intersected with every clipping ancestor, including hidden tabs. */
function visibleRect(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  let left = Math.max(0, rect.left), top = Math.max(0, rect.top);
  let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent);
    if (parent.hidden || style.display === "none" || style.visibility === "hidden") return { left: 0, top: 0, right: 0, bottom: 0 };
    const bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  return { left, top, right, bottom };
}

/** One DOM pass per scheduled frame; no DOM writes, model calls or resume mutations. */
export function measureWritingGeometry(root: HTMLElement, card: HTMLElement, source: WritingSource, annotations: WritingAnnotation[], activeId?: string): WritingGeometry | null {
  if (root.ownerDocument.querySelector('[role="dialog"][aria-modal="true"]:not(.agent-sidebar)')) return null;
  const to = visibleRect(card);
  if (to.right <= to.left || to.bottom <= to.top) return null;
  const geometry: WritingGeometry = { annotations: [], visibility: "unavailable", x: 0, y: 0, tx: 0, ty: 0 };
  const canvas = root.querySelector<HTMLElement>(".resume-preview-canvas");
  if (!canvas) return geometry;
  const clip = visibleRect(canvas);
  if (clip.right <= clip.left || clip.bottom <= clip.top) return geometry;
  const anchors = new Map([...root.querySelectorAll<HTMLElement>("[data-preview-anchor]")].map(element => [element.dataset.previewAnchor, element]));
  const activeKey = writingTargetKey(source.targetRef);
  for (const annotation of annotations) {
    const anchor = anchors.get(writingPreviewAnchor(annotation.source));
    if (!anchor || anchor.textContent !== annotation.source.text) continue;
    const quote = annotation.source.quote ? resolveWritingQuote(annotation.source.text, annotation.source.quote) : undefined;
    if (annotation.source.quote && !quote) continue;
    const range = writingTextRange(anchor, quote?.start ?? 0, quote?.end ?? annotation.source.text.length);
    if (!range) continue;
    const active = activeId ? annotation.id === activeId : writingTargetKey(annotation.source.targetRef) === activeKey
      && annotation.source.quote?.start === source.quote?.start && annotation.source.quote?.end === source.quote?.end;
    const rects = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
    const lines: Line[] = [];
    for (const rect of rects) {
      const x = Math.max(clip.left, rect.left), y = Math.max(clip.top, rect.top);
      const width = Math.min(clip.right, rect.right) - x, height = Math.min(clip.bottom, rect.bottom) - y;
      if (width <= 0 || height <= 0) continue;
      // Inline formatting can return overlapping rects for one line. Merge them.
      const previous = lines.at(-1);
      if (previous && Math.abs(previous.y - y) < 1 && Math.abs(previous.height - height) < 1 && x <= previous.x + previous.width + 3) {
        const left = Math.min(previous.x, x), right = Math.max(previous.x + previous.width, x + width);
        previous.x = left; previous.width = right - left;
      } else lines.push({ x, y, width, height });
    }
    if (active) {
      geometry.visibility = lines.length ? "visible" : rects.length && rects.every(rect => rect.bottom <= clip.top) ? "above"
        : rects.length && rects.every(rect => rect.top >= clip.bottom) ? "below" : "unavailable";
    }
    const first = lines[0], last = lines.at(-1);
    if (!first || !last) continue;
    geometry.annotations.push({ ...annotation, active, lines, badge: { x: Math.max(clip.left + 12, first.x - 23), y: Math.max(clip.top + 11, Math.min(clip.bottom - 11, first.y + first.height / 2)) } });
    if (!active) continue;
    const x = Math.min(clip.right - 3, last.x + last.width + 5), y = last.y + last.height / 2;
    const tx = to.left - 3, ty = Math.min(to.bottom - 12, to.top + 24);
    const paperRight = anchor.closest(".resume-preview-scale")?.getBoundingClientRect().right ?? x;
    const gutter = Math.min(tx - 12, Math.max(x + 8, paperRight + 10));
    Object.assign(geometry, { x, y, tx, ty });
    // Only the active note gets a connector, and never through an overlapping drawer.
    if (to.left >= clip.right && gutter > x && ty >= to.top) geometry.path = `M ${x} ${y} L ${gutter} ${y} L ${gutter} ${ty} L ${tx} ${ty}`;
  }
  return geometry;
}

/** Read an explicit preview selection or click on a preview anchor, including selections across formatting spans. */
export function readWritingPreviewSelection(root: HTMLElement, sources: WritingSource[], eventTarget?: EventTarget | null): WritingActivity | undefined {
  const selection = root.ownerDocument.getSelection();
  if (selection?.rangeCount && !selection.isCollapsed) {
    const range = selection.getRangeAt(0);
    const start = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
    const anchor = start?.closest<HTMLElement>("[data-preview-anchor]");
    if (!anchor || !root.contains(anchor) || !anchor.contains(range.endContainer)) return;
    const source = sources.find(s => anchor.dataset.previewAnchor === (s.targetRef.kind === "claim_text" ? `claim:${s.targetRef.claimId}` : "profile:headline") && anchor.textContent === s.text);
    if (!source) return;
    const before = range.cloneRange(); before.selectNodeContents(anchor); before.setEnd(range.startContainer, range.startOffset);
    const at = before.toString().length;
    return { key: writingTargetKey(source.targetRef), text: source.text, start: at, end: at + range.toString().length };
  }
  if (eventTarget instanceof Element) {
    const anchor = eventTarget.closest<HTMLElement>("[data-preview-anchor]");
    if (anchor && root.contains(anchor)) {
      const source = sources.find(s => anchor.dataset.previewAnchor === (s.targetRef.kind === "claim_text" ? `claim:${s.targetRef.claimId}` : "profile:headline") && anchor.textContent === s.text);
      if (source) return { key: writingTargetKey(source.targetRef), text: source.text, start: 0, end: 0 };
    }
  }
}

/** Overlay geometry is ephemeral, quote-checked, clipped and RAF-batched. */
export function useWritingGeometry(shell: RefObject<HTMLElement | null>, card: RefObject<HTMLElement | null>, source: WritingSource | undefined, annotations: WritingAnnotation[], activeId?: string) {
  const [geometry, setGeometry] = useState<WritingGeometry | null>(null);
  useEffect(() => {
    const root = shell.current;
    if (!root || !source) { setGeometry(null); return; }
    let frame = 0, disposed = false;
    const measure = () => {
      frame = 0;
      setGeometry(card.current ? measureWritingGeometry(root, card.current, source, annotations, activeId) : null);
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule); resize.observe(root);
    if (card.current) resize.observe(card.current);
    const canvas = root.querySelector<HTMLElement>(".resume-preview-canvas");
    if (canvas) resize.observe(canvas);
    const mutation = new MutationObserver(schedule);
    const paper = root.querySelector(".resume-preview-stage");
    if (paper) mutation.observe(paper, { attributes: true, childList: true, subtree: true, characterData: true });
    const layout = root.ownerDocument.body ?? root.closest(".agent-layout") ?? root;
    const visibility = new MutationObserver(schedule);
    visibility.observe(layout, { childList: true, attributes: true, subtree: true, attributeFilter: ["hidden", "class", "aria-hidden", "aria-modal", "open"] });
    document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    // Card/sidebar entrances may finish after the first geometry read.
    document.addEventListener("animationend", schedule, true); document.addEventListener("transitionend", schedule, true);
    document.fonts?.addEventListener("loadingdone", schedule); schedule();
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); visibility.disconnect(); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.removeEventListener("animationend", schedule, true); document.removeEventListener("transitionend", schedule, true); document.fonts?.removeEventListener("loadingdone", schedule); };
  }, [shell, card, source, annotations, activeId]);
  return geometry;
}

/** Explicit note navigation works even when automatic edit-follow is disabled.
 * Scroll only the paper canvas; never scrollIntoView() on a whole page. */
function scrollPreviewRect(canvas: HTMLElement | null, rect: DOMRect, anchor: string): boolean {
  if (!canvas || canvas.clientHeight <= 0) return false;
  canvas.scrollTop = getPreviewScrollTop({ anchorTop: rect.top, anchorHeight: rect.height, canvasTop: canvas.getBoundingClientRect().top,
    canvasBorderTop: canvas.clientTop, scrollTop: canvas.scrollTop, viewportHeight: canvas.clientHeight, scrollHeight: canvas.scrollHeight },
  { anchor, source: "focus" });
  return true;
}
export function revealEditionPreview(root: HTMLElement, key: string): boolean {
  const canvas = root.querySelector<HTMLElement>(".resume-preview-canvas");
  const anchor = [...(canvas?.querySelectorAll<HTMLElement>("[data-preview-anchor]") ?? [])].find(el => el.dataset.previewAnchor === key);
  return !!anchor && scrollPreviewRect(canvas, anchor.getBoundingClientRect(), key);
}
export function revealWritingPreview(root: HTMLElement, source: WritingSource): boolean {
  const canvas = root.querySelector<HTMLElement>(".resume-preview-canvas");
  const anchor = [...root.querySelectorAll<HTMLElement>("[data-preview-anchor]")].find(element => element.dataset.previewAnchor === writingPreviewAnchor(source) && element.textContent === source.text);
  if (!canvas || !anchor || canvas.clientHeight <= 0) return false;
  const quote = source.quote ? resolveWritingQuote(source.text, source.quote) : undefined;
  if (source.quote && !quote) return false;
  const rect = (quote && writingTextRange(anchor, quote.start, quote.end)?.getBoundingClientRect()) || anchor.getBoundingClientRect();
  return scrollPreviewRect(canvas, rect, writingPreviewAnchor(source));
}

export function focusWritingSource(source: WritingSource) {
  showResumeEditor();
  const key = writingTargetKey(source.targetRef);
  const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-writing-key]")].find(el => el.dataset.writingKey === key);
  if (input) {
    const focus = () => { if (input.isConnected) { input.focus({ preventScroll: true }); input.scrollIntoView({ block: "nearest", behavior: "instant" }); } };
    if (input.closest("[hidden]")) requestAnimationFrame(focus); else focus();
    return true;
  }
  return false;
}
