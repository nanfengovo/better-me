import { useEffect, useRef, useState, type PointerEvent } from "react";
import { useUiPreferences } from "../../lib/ui-preferences";
import type { InstalledMicroApp } from "../../lib/micro-app-registry";

export type DesktopPage = "resume" | "agent" | "opportunities" | "resources" | "atlas" | "autopilot";
const AUTOPILOT_ICON_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0a1624"/>
        <stop offset="100%" stop-color="#050b12"/>
      </linearGradient>
      <linearGradient id="ring" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#22d3ee"/>
        <stop offset="100%" stop-color="#f97316"/>
      </linearGradient>
    </defs>
    <rect width="232" height="232" x="12" y="12" rx="54" fill="url(#bg)" stroke="#1e3a52" stroke-width="6"/>
    <rect width="164" height="116" x="46" y="70" rx="18" fill="none" stroke="url(#ring)" stroke-width="8" stroke-dasharray="14 8"/>
    <rect width="46" height="32" x="105" y="52" rx="8" fill="#0d2538" stroke="#22d3ee" stroke-width="5"/>
    <circle cx="128" cy="128" r="18" fill="#f97316"/>
    <path d="M128 84v22" stroke="#22d3ee" stroke-width="5" stroke-dasharray="4 4"/>
  </svg>`
)}`;
const MICROAPP_ICON_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
    <rect width="232" height="232" x="12" y="12" rx="54" fill="#121024" stroke="#a78bfa" stroke-width="6"/>
    <polygon points="128,48 196,88 196,168 128,208 60,168 60,88" fill="#1e1b3a" stroke="#22d3ee" stroke-width="6"/>
    <circle cx="128" cy="128" r="22" fill="#a78bfa"/>
  </svg>`
)}`;
export const desktopIcons = {
  atlas: new URL("./assets/icon-atlas.png", import.meta.url).href,
  resume: new URL("./assets/icon-resume.png", import.meta.url).href,
  agent: new URL("./assets/icon-agent.png", import.meta.url).href,
  opportunities: new URL("./assets/icon-opportunities.png", import.meta.url).href,
  resources: new URL("./assets/icon-files.png", import.meta.url).href,
  autopilot: AUTOPILOT_ICON_SVG,
  settings: new URL("./assets/icon-settings.png", import.meta.url).href,
};
export function DesktopDock({
  page,
  settingsOpen,
  mainHidden,
  onNavigate,
  onMinimize,
  onSettings,
  onCloseSettings,
  pinnedMicroApps = [],
  activeMicroAppId = null,
  onOpenMicroApp,
}: {
  page: DesktopPage;
  settingsOpen: boolean;
  mainHidden: boolean;
  onNavigate: (page: DesktopPage) => void;
  onMinimize: () => void;
  onSettings: () => void;
  onCloseSettings: () => void;
  pinnedMicroApps?: InstalledMicroApp[];
  activeMicroAppId?: string | null;
  onOpenMicroApp?: (app: InstalledMicroApp) => void;
}) {
  const {
    t,
    dockAutoHide = true,
    dockPosition = "bottom",
    dockSize = 48,
    dockMagnification = true,
    dockMagScale = 1.45,
    dockOpacity = 0.85,
    dockBlur = 24,
    reduceMotion = false,
  } = useUiPreferences();
  const [visible, setVisible] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);
  const dock = useRef<HTMLElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointer = useRef<number | null>(null);
  const hovered = useRef(false);
  const animate = useRef<() => void>(() => {});
  const isVertical = dockPosition === "left" || dockPosition === "right";

  const items = [
    { id: "resume", label: t("简历", "Resume") },
    { id: "agent", label: "Agent" },
    { id: "opportunities", label: t("岗位", "Jobs") },
    { id: "atlas", label: t("岗位地图", "Atlas") },
    { id: "resources", label: t("资料", "Resources") },
    { id: "autopilot", label: t("自动化", "Autopilot") },
    { id: "settings", label: t("系统设置", "System settings") },
  ] as const;

  useEffect(() => {
    const element = dock.current;
    if (!element) return;
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>("button"));
    const states = buttons.map(() => ({ value: 1, velocity: 0 }));
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(hover: hover) and (pointer: fine) and (min-width: 941px)");
    let frame = 0, previous = 0;

    function reset() {
      cancelAnimationFrame(frame);
      frame = 0;
      pointer.current = null;
      buttons.forEach((button, i) => {
        states[i] = { value: 1, velocity: 0 };
        button.style.removeProperty("transform");
      });
      element?.style.setProperty("--dock-expansion", "0px");
    }

    function tick(now: number) {
      const dt = Math.min((now - previous) / 1000 || 1 / 60, 1 / 30);
      previous = now;
      let moving = false;
      const rect = element!.getBoundingClientRect();
      const origin = isVertical ? rect.top : rect.left;
      const maxBoost = dockMagnification ? Math.max(0, dockMagScale - 1) : 0;

      states.forEach((state, i) => {
        const offset = isVertical ? buttons[i]!.offsetTop : buttons[i]!.offsetLeft;
        const dimension = isVertical ? buttons[i]!.offsetHeight : buttons[i]!.offsetWidth;
        const center = origin + offset + dimension / 2;
        const distance = pointer.current === null ? 1 : Math.min(1, Math.abs(pointer.current - center) / 120);
        const target = 1 + maxBoost * (1 + Math.cos(distance * Math.PI)) / 2;
        state.velocity += ((target - state.value) * 240 - state.velocity * 26) * dt;
        state.value += state.velocity * dt;
        if (Math.abs(state.value - target) < 0.001 && Math.abs(state.velocity) < 0.005) {
          state.value = target;
          state.velocity = 0;
        } else {
          moving = true;
        }
      });

      if (isVertical) {
        const extras = states.map((s, i) => (s.value - 1) * buttons[i]!.offsetHeight);
        const expansion = extras.reduce((a, b) => a + b, 0) / 2;
        let y = -expansion;
        states.forEach((s, i) => {
          const popX = dockPosition === "left" ? (s.value - 1) * 20 : -(s.value - 1) * 20;
          buttons[i]!.style.transform = `translate3d(${popX}px,${y + extras[i]! / 2}px,0) scale(${s.value})`;
          y += extras[i]!;
        });
        element!.style.setProperty("--dock-expansion", `${expansion}px`);
      } else {
        const extras = states.map((s, i) => (s.value - 1) * buttons[i]!.offsetWidth);
        const expansion = extras.reduce((a, b) => a + b, 0) / 2;
        let x = -expansion;
        states.forEach((s, i) => {
          buttons[i]!.style.transform = `translate3d(${x + extras[i]! / 2}px,${-(s.value - 1) * 24}px,0) scale(${s.value})`;
          x += extras[i]!;
        });
        element!.style.setProperty("--dock-expansion", `${expansion}px`);
      }

      frame = moving ? requestAnimationFrame(tick) : 0;
    }

    animate.current = () => {
      if (reduceMotion || media.matches || !fine.matches) {
        reset();
        return;
      }
      if (!frame) {
        previous = performance.now();
        frame = requestAnimationFrame(tick);
      }
    };

    media.addEventListener("change", reset);
    fine.addEventListener("change", reset);
    return () => {
      reset();
      clearTimeout(timer.current);
      media.removeEventListener("change", reset);
      fine.removeEventListener("change", reset);
      animate.current = () => {};
    };
  }, [reduceMotion, pinnedMicroApps.length, isVertical, dockPosition, dockMagnification, dockMagScale, dockSize]);

  function reveal() {
    clearTimeout(timer.current);
    setVisible(true);
  }

  function hideLater() {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!hovered.current && !dock.current?.contains(document.activeElement)) setVisible(false);
    }, 200);
  }

  function enter() {
    hovered.current = true;
    reveal();
  }

  function leave() {
    hovered.current = false;
    pointer.current = null;
    animate.current();
    hideLater();
  }

  function move(event: PointerEvent) {
    if (event.pointerType === "mouse") {
      pointer.current = isVertical ? event.clientY : event.clientX;
      animate.current();
    }
  }

  function activate(id: typeof items[number]["id"]) {
    setLaunching(id);
    window.setTimeout(() => setLaunching(current => current === id ? null : current), 620);
    if (id === "settings") {
      if (settingsOpen) onCloseSettings(); else onSettings();
      return;
    }
    if (!settingsOpen && page === id && !mainHidden) onMinimize();
    else onNavigate(id);
  }

  return (
    <div
      className="os-dock-system no-print"
      data-position={dockPosition}
      data-auto-hide={dockAutoHide}
      data-visible={visible}
      style={
        {
          "--dock-local-size": `${dockSize}px`,
          "--dock-local-opacity": dockOpacity,
          "--dock-local-blur": `${dockBlur}px`,
        } as React.CSSProperties
      }
    >
      <div
        className={`os-dock-edge is-${dockPosition}`}
        aria-hidden="true"
        onPointerEnter={enter}
        onPointerLeave={leave}
      />
      <nav
        className={`os-dock is-${dockPosition}`}
        ref={dock}
        aria-label={t("应用程序 Dock", "Application Dock")}
        onPointerEnter={enter}
        onPointerMove={move}
        onPointerLeave={leave}
        onFocus={reveal}
        onBlur={hideLater}
      >
        {items.map(item => (
          <button
            key={item.id}
            type="button"
            data-dock-app={item.id}
            data-launching={launching === item.id}
            aria-label={item.label}
            aria-pressed={item.id === "settings" ? settingsOpen : page === item.id && !mainHidden}
            onClick={() => activate(item.id)}
            style={{ width: dockSize, height: dockSize + 4 }}
          >
            <span className="os-app-icon" style={{ width: dockSize, height: dockSize }}>
              <img src={desktopIcons[item.id]} width={256} height={256} alt="" draggable={false} />
            </span>
            <span className="os-dock-label">{item.label}</span>
            <span className="os-running-dot" />
          </button>
        ))}
        {pinnedMicroApps.map(microApp => (
          <button
            key={microApp.appId}
            type="button"
            data-dock-microapp={microApp.appId}
            data-launching={launching === microApp.appId}
            aria-label={microApp.name}
            aria-pressed={activeMicroAppId === microApp.appId}
            onClick={() => {
              setLaunching(microApp.appId);
              window.setTimeout(() => setLaunching(current => current === microApp.appId ? null : current), 620);
              onOpenMicroApp?.(microApp);
            }}
            style={{ width: dockSize, height: dockSize + 4 }}
          >
            <span className="os-app-icon" style={{ width: dockSize, height: dockSize }}>
              <img src={MICROAPP_ICON_SVG} width={256} height={256} alt="" draggable={false} />
            </span>
            <span className="os-dock-label">{microApp.name}</span>
            <span className="os-running-dot" />
          </button>
        ))}
      </nav>
    </div>
  );
}
