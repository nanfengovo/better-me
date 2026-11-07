import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, LocateFixed, X } from "lucide-react";
import { AGENT_LESSONS, tutorialInstruction, type AgentLesson } from "../lib/agent-tutorial";
import type { GuideRect } from "../lib/first-run-guide";

/** The tour's spotlight pattern, without a modal: the real controls remain usable. */
export function AgentGuideCoach({ lessonId, active, onBack, onClose, onNavigate }: {
  lessonId: AgentLesson; active: boolean; onBack: () => void; onClose: () => void; onNavigate: () => void;
}) {
  const lesson = AGENT_LESSONS.find(item => item.id === lessonId)!;
  const [rect, setRect] = useState<GuideRect | null>(null), [anchor, setAnchor] = useState("");
  const coach = useRef<HTMLElement>(null), target = useRef<HTMLElement | null>(null);
  const locate = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    if (!active) { setRect(null); return; }
    const root = coach.current?.closest(".agent-sidebar-work");
    if (!root) return;
    let frame = 0;
    function measure() {
      target.current = null;
      for (const name of lesson.targets) {
        const items = root!.querySelectorAll<HTMLElement>(`[data-agent-guide="${name}"]`);
        const found = [...items].find(item => !item.closest("[hidden], [inert]") && item.getClientRects().length > 0);
        if (found) { target.current = found; setAnchor(name); break; }
      }
      const node = target.current, box = node?.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      // Clip the highlight to every scrolling ancestor, as well as the viewport.
      let left = 4, top = 4, right = viewport.width - 4, bottom = viewport.height - 4;
      for (let parent = node?.parentElement; parent; parent = parent.parentElement) {
        const style = window.getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(`${style.overflowX} ${style.overflowY}`)) {
          const clip = parent.getBoundingClientRect(); left = Math.max(left, clip.left); top = Math.max(top, clip.top); right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
        }
      }
      const next = box && right > left && bottom > top && box.width > 0 && box.height > 0 && box.bottom > top && box.top < bottom && box.right > left && box.left < right
        ? { x: Math.max(left, box.left - 4), y: Math.max(top, box.top - 4), width: Math.min(right, box.right + 4) - Math.max(left, box.left - 4), height: Math.min(bottom, box.bottom + 4) - Math.max(top, box.top - 4) } : null;
      setRect(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      if (!node) setAnchor("");
    }
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    locate.current = () => { measure(); target.current?.scrollIntoView?.({ block: "center", behavior: "auto" }); target.current?.focus({ preventScroll: true }); schedule(); };
    measure();
    const observer = new MutationObserver(schedule); observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "open"] });
    const resize = new ResizeObserver(schedule); resize.observe(root);
    window.addEventListener("scroll", schedule, true); window.addEventListener("resize", schedule);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); resize.disconnect(); window.removeEventListener("scroll", schedule, true); window.removeEventListener("resize", schedule); target.current = null; locate.current = () => {}; };
  }, [active, lesson]);
  return <section ref={coach} className="agent-guide-coach" tabIndex={-1} aria-label="实操定位引导">
    <div className="agent-guide-coach-copy"><strong>{lesson.label}</strong><p role="status">{!active ? "已切换视图，可回到本节入口。" : tutorialInstruction(lessonId, anchor)}</p></div>
    <div className="agent-guide-coach-actions"><button type="button" title={active ? "重新定位入口" : "回到本节入口"} aria-label={active ? "重新定位入口" : "回到本节入口"} onClick={active ? () => locate.current() : onNavigate}><LocateFixed size={15} /></button><button type="button" title="返回本节教程" aria-label="返回本节教程" onClick={onBack}><ArrowLeft size={15} /></button><button type="button" title="结束本次定位" aria-label="结束本次定位" onClick={onClose}><X size={15} /></button></div>
    {active && anchor && !rect && <small>入口暂未显示，可重新定位。</small>}
    {active && rect && createPortal(<div className="agent-guide-spotlight no-print" aria-hidden="true" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}><span /></div>, document.body)}
  </section>;
}
