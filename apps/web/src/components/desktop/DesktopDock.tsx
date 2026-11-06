import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useUiPreferences } from "../../lib/ui-preferences";

export type DesktopPage = "resume" | "agent" | "opportunities" | "resources" | "atlas";
export const desktopIcons = {
  resume: new URL("./assets/icon-resume.png", import.meta.url).href,
  agent: new URL("./assets/icon-agent.png", import.meta.url).href,
  opportunities: new URL("./assets/icon-opportunities.png", import.meta.url).href,
  resources: new URL("./assets/icon-files.png", import.meta.url).href,
  settings: new URL("./assets/icon-settings.png", import.meta.url).href,
};
export function DesktopDock({ page, settingsOpen, onNavigate, onSettings }: { page: DesktopPage; settingsOpen: boolean; onNavigate: (page: DesktopPage) => void; onSettings: () => void }) {
  const { t, dockAutoHide = true, reduceMotion = false } = useUiPreferences();
  const [visible, setVisible] = useState(false);
  const dock = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef<number | null>(null);
  const hovered = useRef(false);
  const animate = useRef<() => void>(() => {});
  const items = [
    { id: "resume", label: t("简历", "Resume") }, { id: "agent", label: "Agent" },
    { id: "opportunities", label: t("机会", "Opportunities") }, { id: "resources", label: t("资料", "Resources") },
    { id: "settings", label: t("系统设置", "System settings") },
  ] as const;
  useEffect(() => {
    const element = dock.current!;
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>("button"));
    const states = buttons.map(() => ({ value: 1, velocity: 0 }));
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 941px)");
    let frame = 0, previous = 0;
    function reset() {
      cancelAnimationFrame(frame); frame = 0; pointer.current = null;
      buttons.forEach((button, i) => { states[i] = { value: 1, velocity: 0 }; button.style.removeProperty("transform"); });
      element.style.setProperty("--dock-expansion", "0px");
    }
    function tick(now: number) {
      const dt = Math.min((now - previous) / 1000 || 1 / 60, 1 / 30); previous = now;
      let moving = false;
      const left = element.getBoundingClientRect().left;
      states.forEach((state, i) => {
        const center = left + buttons[i]!.offsetLeft + buttons[i]!.offsetWidth / 2;
        const distance = pointer.current === null ? 1 : Math.min(1, Math.abs(pointer.current - center) / 120);
        const target = 1 + .45 * (1 + Math.cos(distance * Math.PI)) / 2;
        state.velocity += ((target - state.value) * 240 - state.velocity * 26) * dt;
        state.value += state.velocity * dt;
        if (Math.abs(state.value - target) < .001 && Math.abs(state.velocity) < .005) { state.value = target; state.velocity = 0; }
        else moving = true;
      });
      const extras = states.map((s, i) => (s.value - 1) * buttons[i]!.offsetWidth);
      const expansion = extras.reduce((a, b) => a + b, 0) / 2;
      let x = -expansion;
      states.forEach((s, i) => {
        buttons[i]!.style.transform = `translate3d(${x + extras[i]! / 2}px,${-(s.value - 1) * 24}px,0) scale(${s.value})`;
        x += extras[i]!;
      });
      element.style.setProperty("--dock-expansion", `${expansion}px`);
      frame = moving ? requestAnimationFrame(tick) : 0;
    }
    animate.current = () => {
      if (reduceMotion || media.matches || !fine.matches) { reset(); return; }
      if (!frame) { previous = performance.now(); frame = requestAnimationFrame(tick); }
    };
    media.addEventListener("change", reset); fine.addEventListener("change", reset);
    return () => { reset(); clearTimeout(timer.current); media.removeEventListener("change", reset); fine.removeEventListener("change", reset); animate.current = () => {}; };
  }, [reduceMotion]);
  function reveal() { clearTimeout(timer.current); setVisible(true); }
  function hideLater() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!hovered.current && !dock.current?.contains(document.activeElement)) setVisible(false);
    }, 200);
  }
  function enter() { hovered.current = true; reveal(); }
  function leave() { hovered.current = false; pointer.current = null; animate.current(); hideLater(); }
  function move(event: PointerEvent) { if (event.pointerType === "mouse") { pointer.current = event.clientX; animate.current(); } }
  return <div className="os-dock-system no-print" data-auto-hide={dockAutoHide} data-visible={visible}>
    <div className="os-dock-edge" aria-hidden="true" onPointerEnter={enter} onPointerLeave={leave} />
    <nav className="os-dock" ref={dock} aria-label={t("应用程序 Dock", "Application Dock")} onPointerEnter={enter} onPointerMove={move} onPointerLeave={leave} onFocus={reveal} onBlur={hideLater}>
      {items.map(item => <button key={item.id} type="button" data-dock-app={item.id} aria-label={item.label} aria-pressed={item.id === "settings" ? settingsOpen : !settingsOpen && page === item.id} onClick={() => item.id === "settings" ? onSettings() : onNavigate(item.id)}>
        <span className="os-app-icon"><img src={desktopIcons[item.id]} width={256} height={256} alt="" draggable={false} /></span>
        <span className="os-dock-label">{item.label}</span><span className="os-running-dot" />
      </button>)}
    </nav>
  </div>;
}
