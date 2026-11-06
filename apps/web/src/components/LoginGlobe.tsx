import { useEffect, useRef, useState } from "react";
import createGlobe from "cobe";

export function LoginGlobe({ paused }: { paused: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  const [failed, setFailed] = useState(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let globe: ReturnType<typeof createGlobe>;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const size = () => Math.max(1, element.clientWidth);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    try {
      globe = createGlobe(element, { width: size() * dpr, height: size() * dpr, devicePixelRatio: dpr,
        phi: 2.4, theta: .22, dark: 1, diffuse: 1.5, mapSamples: 18000, mapBrightness: 5,
        baseColor: [.12, .26, .31], markerColor: [.65, .95, .82], glowColor: [.13, .36, .37],
        markers: [], opacity: 1 });
    } catch { setFailed(true); return; }
    let appliedSize = size();
    let resizeFrame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (resizeFrame !== null) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = null;
        const next = size();
        if (next === appliedSize) return;
        appliedSize = next;
        globe.update({ width: next * dpr, height: next * dpr });
      });
    });
    observer.observe(element);
    let frame = 0, last = 0, phi = 2.4;
    const animate = (now: number) => {
      const delta = Math.min((now - last) / 1000, .05); last = now;
      const focused = document.activeElement?.closest(".login-form-panel input");
      if (!pausedRef.current && !reduced.matches && !document.hidden && !focused) { phi += delta * .13; globe.update({ phi }); }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(frame); if (resizeFrame !== null) cancelAnimationFrame(resizeFrame); observer.disconnect(); globe.destroy(); };
  }, []);
  return <div className="login-globe-stage" aria-hidden="true"><div className="login-globe-halo" /><canvas ref={canvas} className="login-globe-canvas" />{failed && <div className="login-globe-fallback" />}</div>;
}
