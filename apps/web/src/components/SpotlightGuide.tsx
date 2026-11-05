import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { placeGuide, type GuideRect } from "../lib/first-run-guide";
import "./first-run-guide.css";

export function useGuideEffects() {
  const [effects, setEffects] = useState(true);
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return { effects, setEffects, reduced, animated: effects && !reduced };
}

/** Clip to scroll containers as well as the viewport, so hidden controls never get a false spotlight. */
function visibleRect(element: HTMLElement): GuideRect | null {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height || element.closest("[hidden], [inert]")) return null;
  let left = Math.max(8, rect.left - 6), top = Math.max(8, rect.top - 6);
  let right = Math.min(window.innerWidth - 8, rect.right + 6), bottom = Math.min(window.innerHeight - 8, rect.bottom + 6);
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const style = window.getComputedStyle(parent), bounds = parent.getBoundingClientRect();
    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { left = Math.max(left, bounds.left); right = Math.min(right, bounds.right); }
    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { top = Math.max(top, bounds.top); bottom = Math.min(bottom, bounds.bottom); }
  }
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

type Props = {
  stepId: string; targets: readonly string[]; titleId: string; descriptionId: string;
  dialogRef: RefObject<HTMLDialogElement | null>; animated: boolean; cinematic?: boolean;
  className?: string; onClose: () => void; onNavigate: (offset: number) => void;
  children: (anchor: string | null) => ReactNode;
};

/** Shared native-modal shell for the workspace tour and contextual Agent walkthrough. No domain actions. */
export function SpotlightGuide({ stepId, targets, titleId, descriptionId, dialogRef, animated, cinematic = false, className = "", onClose, onNavigate, children }: Props) {
  const panel = useRef<HTMLElement>(null), motion = useRef<Animation | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [geometry, setGeometry] = useState<{ width: number; height: number; target: GuideRect | null; anchor: string | null; x: number; y: number; maxHeight: number | undefined; maxWidth: number | undefined } | null>(null);
  const positioned = geometry !== null;
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    if (panel.current) panel.current.scrollTop = 0;
    let frame = 0, scrolled = false;
    const observer = new window.ResizeObserver(() => schedule());
    let observed: HTMLElement | null = null;
    function measure() {
      const width = window.innerWidth, height = window.innerHeight;
      const candidates = targets.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)].map(element => ({ selector, element })));
      const match = candidates.find(({ element }) => !element.closest("[hidden], [inert]") && element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0);
      if (match && !scrolled) { match.element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" }); scrolled = true; }
      if (observed !== match?.element) { if (observed) observer.unobserve(observed); observed = match?.element ?? null; if (observed) observer.observe(observed); }
      const target = match ? visibleRect(match.element) : null;
      const size = { width: panel.current?.offsetWidth || 440, height: panel.current?.offsetHeight || 460 };
      let maxHeight: number | undefined, maxWidth: number | undefined;
      if (width >= 700 && target) {
        const room = Math.max(target.x - 40, width - target.x - target.width - 40);
        if (room >= 280) { maxWidth = Math.floor(room); size.width = Math.min(size.width, maxWidth); }
      }
      let position = placeGuide(target, { width, height }, size);
      // A phone cannot place the card beside a control. Use the room above/below it,
      // rather than keeping a viewport-sized card that covers the highlighted button.
      if (width < 700 && target && target.height < height * .35) {
        const above = target.y - 40, below = height - target.y - target.height - 40;
        const room = Math.max(above, below);
        if (room >= 240) {
          maxHeight = Math.floor(room);
          position = { x: 16, y: below >= above ? height - Math.min(size.height, maxHeight) - 16 : Math.max(16, target.y - Math.min(size.height, maxHeight) - 24) };
        }
      }
      const next = { width, height, target, anchor: target ? match!.selector : null, ...position, maxHeight, maxWidth };
      setGeometry(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    }
    function schedule() { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(measure); }
    measure();
    if (panel.current) observer.observe(panel.current);
    const mutations = new window.MutationObserver(schedule);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });
    window.addEventListener("resize", schedule); window.addEventListener("scroll", schedule, true);
    return () => { observer.disconnect(); mutations.disconnect(); window.cancelAnimationFrame(frame); window.removeEventListener("resize", schedule); window.removeEventListener("scroll", schedule, true); };
  }, [stepId, targets, dialogRef]);
  useLayoutEffect(() => { if (positioned) dialogRef.current?.querySelector<HTMLElement>(`#${titleId}`)?.focus({ preventScroll: true }); }, [stepId, positioned, titleId, dialogRef]);
  useEffect(() => {
    motion.current?.cancel();
    if (!animated || keyboard || !panel.current?.animate) return;
    const animation = panel.current.animate([{ opacity: .45, transform: "translateY(12px) scale(.97)" }, { opacity: 1, transform: "translateY(0) scale(1)" }], { duration: 250, easing: "cubic-bezier(.16, 1, .3, 1)" });
    motion.current = animation;
    void animation.finished.catch(() => { /* Navigating or closing intentionally interrupts motion. */ });
    return () => animation.cancel();
  }, [stepId, animated, keyboard]);
  useLayoutEffect(() => { const dialog = dialogRef.current; return () => { dialog?.close(); }; }, [dialogRef]);
  const cutout = geometry?.target;
  const path = geometry ? `M0 0H${geometry.width}V${geometry.height}H0Z${cutout ? `M${cutout.x} ${cutout.y}v${cutout.height}h${cutout.width}v-${cutout.height}Z` : ""}` : "";
  return createPortal(<dialog ref={dialogRef} className={`first-run-guide no-print ${cinematic ? "is-cinematic" : "is-spotlight"} ${animated && !keyboard ? "has-effects" : "reduced-effects"} ${geometry && (geometry.height < 540 || (geometry.maxHeight !== undefined && geometry.maxHeight < 540)) ? "is-constrained" : ""} ${className}`} aria-labelledby={titleId} aria-describedby={descriptionId} data-keyboard={keyboard} data-effects={animated && !keyboard}
    onCancel={event => { event.preventDefault(); onClose(); }} onKeyDownCapture={() => setKeyboard(true)} onPointerDownCapture={() => setKeyboard(false)}
    onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Tab") {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex="0"]')].filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0 && !node.closest("[hidden]"));
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
      // Arrow keys in an example answer must edit text, not silently change chapters.
      if (!(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable=true]")) && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault(); onNavigate(event.key === "ArrowRight" ? 1 : -1);
      }
    }}>
    <svg className="guide-shade" aria-hidden="true" viewBox={`0 0 ${geometry?.width ?? 1} ${geometry?.height ?? 1}`} preserveAspectRatio="none"><path d={path} fillRule="evenodd" /></svg>
    <div className="guide-atmosphere" aria-hidden="true"><i /><i /><i /></div>
    {cutout && <div className="guide-focus" data-guide-target={geometry?.anchor} aria-hidden="true" style={{ left: cutout.x, top: cutout.y, width: cutout.width, height: cutout.height }}><i /><b /><span /></div>}
    <section ref={panel} className="guide-panel" style={{ left: geometry?.x ?? 16, top: geometry?.y ?? 16, maxHeight: geometry?.maxHeight, maxWidth: geometry?.maxWidth, visibility: geometry ? "visible" : "hidden" }} data-step={stepId}>{children(geometry?.anchor ?? null)}</section>
  </dialog>, document.body);
}
