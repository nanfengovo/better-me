import { useEffect, useState, type RefObject } from "react";
import type { WritingSource } from "./resume-copilot";
import { writingTargetKey } from "./resume-copilot";
import { resolveWritingQuote, writingTextRange } from "./writing-anchor";

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
type Geometry = { lines: Line[]; path?: string; x: number; y: number };

/** Read an explicit preview selection, including selections across formatting spans. */
export function readWritingPreviewSelection(root: HTMLElement, sources: WritingSource[]): WritingActivity | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return;
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

/** Overlay geometry is ephemeral, quote-checked, clipped and RAF-batched. */
export function useWritingGeometry(shell: RefObject<HTMLElement | null>, card: RefObject<HTMLElement | null>, source?: WritingSource) {
  const [geometry, setGeometry] = useState<Geometry | null>(null);
  useEffect(() => {
    const root = shell.current;
    if (!root || !source) { setGeometry(null); return; }
    let frame = 0, disposed = false;
    const measure = () => {
      frame = 0;
      const anchorKey = source.targetRef.kind === "claim_text" ? `claim:${source.targetRef.claimId}` : "profile:headline";
      const anchor = [...root.querySelectorAll<HTMLElement>("[data-preview-anchor]")].find(el => el.dataset.previewAnchor === anchorKey && el.textContent === source.text);
      const canvas = root.querySelector<HTMLElement>(".resume-preview-canvas");
      if (!anchor || !canvas || !card.current) { setGeometry(null); return; }
      const clip = canvas.getBoundingClientRect(), to = card.current.getBoundingClientRect();
      const quote = source.quote ? resolveWritingQuote(source.text, source.quote) : undefined;
      if (source.quote && !quote) { setGeometry(null); return; }
      const range = writingTextRange(anchor, quote?.start ?? 0, quote?.end ?? source.text.length);
      if (!range) { setGeometry(null); return; }
      const lines = [...range.getClientRects()].map(r => ({
        x: Math.max(0, clip.left, r.left), y: Math.max(0, clip.top, r.top),
        width: Math.min(window.innerWidth, clip.right, r.right) - Math.max(0, clip.left, r.left),
        height: Math.min(window.innerHeight, clip.bottom, r.bottom) - Math.max(0, clip.top, r.top),
      })).filter(r => r.width > 0 && r.height > 0);
      const last = lines.at(-1);
      if (!last) { setGeometry(null); return; }
      const x = last.x + last.width + 4, y = last.y + last.height / 2, tx = to.left - 4, ty = to.top + 22;
      // Travel through the paper's outer gutter, not diagonally across other paragraphs.
      const paperRight = anchor.closest(".resume-preview-scale")?.getBoundingClientRect().right ?? x;
      const gutter = Math.min(tx - 8, Math.max(x + 8, paperRight + 8));
      const connected = root.getBoundingClientRect().width >= 780 && to.height > 0 && to.top >= 0 && ty < window.innerHeight;
      setGeometry({ lines, x, y, ...(connected ? { path: `M ${x} ${y} L ${gutter} ${y} L ${gutter} ${ty} L ${tx} ${ty}` } : {}) });
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule); resize.observe(root);
    if (card.current) resize.observe(card.current);
    const mutation = new MutationObserver(schedule);
    const paper = root.querySelector(".resume-preview-stage");
    if (paper) mutation.observe(paper, { attributes: true, childList: true, subtree: true, characterData: true });
    document.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule); schedule();
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); document.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); document.fonts?.removeEventListener("loadingdone", schedule); };
  }, [shell, card, source]);
  return geometry;
}

export function focusWritingSource(source: WritingSource) {
  const key = writingTargetKey(source.targetRef);
  const input = [...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-writing-key]")].find(el => el.dataset.writingKey === key);
  if (input) { input.focus({ preventScroll: true }); input.scrollIntoView({ block: "nearest", behavior: "instant" }); return true; }
  return false;
}
