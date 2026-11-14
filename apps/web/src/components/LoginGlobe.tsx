import { useEffect, useRef, useState } from "react";

function shouldUseAnimatedGlobe(reducedMotion: MediaQueryList): boolean {
  if (reducedMotion.matches || navigator.webdriver || /HeadlessChrome|Playwright/i.test(navigator.userAgent)) return false;
  if ("connection" in navigator && (navigator.connection as { saveData?: boolean }).saveData) return false;
  const probe = document.createElement("canvas");
  const gl = probe.getContext("webgl");
  if (!gl) return false;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "";
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return Boolean(renderer) && !/swiftshader|llvmpipe|software rasterizer/i.test(renderer);
}

export function LoginGlobe({ paused }: { paused: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const pausedRef = useRef(paused);
  const [fallback, setFallback] = useState(false);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => {
    const element = canvas.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!element || typeof ResizeObserver === "undefined" || !shouldUseAnimatedGlobe(reduced)) {
      setFallback(true);
      return;
    }
    let active = true;
    let globe: ReturnType<(typeof import("cobe"))["default"]> | undefined;
    let observer: ResizeObserver | undefined;
    let resizeFrame: number | null = null;
    let animationFrame: number | null = null;
    const size = () => Math.max(1, Math.min(element.clientWidth, 640));
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const start = async () => {
      try {
        const createGlobe = (await import("cobe")).default;
        if (!active) return;
        let phi = 2.4;
        globe = createGlobe(element, {
          width: size() * dpr, height: size() * dpr, devicePixelRatio: dpr,
          phi, theta: .22, dark: 1, diffuse: 1.5, mapSamples: 8000, mapBrightness: 5,
          baseColor: [.12, .26, .31], markerColor: [.65, .95, .82], glowColor: [.13, .36, .37],
          markers: [], opacity: 1,
        });
        let lastFrame = performance.now(), lastUpdate = 0;
        const animate = (now: number) => {
          if (now - lastUpdate >= 33) {
            const delta = Math.min((now - lastFrame) / 1000, .1);
            lastFrame = now; lastUpdate = now;
            const focused = document.activeElement?.closest(".login-form-panel input");
            if (!pausedRef.current && !reduced.matches && !document.hidden && !focused) {
              phi += delta * .13;
              globe?.update({ phi });
            }
          }
          animationFrame = requestAnimationFrame(animate);
        };
        animationFrame = requestAnimationFrame(animate);
        let appliedSize = size();
        observer = new ResizeObserver(() => {
          if (resizeFrame !== null) return;
          resizeFrame = requestAnimationFrame(() => {
            resizeFrame = null;
            const next = size();
            if (next === appliedSize || !globe) return;
            appliedSize = next;
            globe.update({ width: next * dpr, height: next * dpr });
          });
        });
        observer.observe(element);
      } catch {
        if (active) setFallback(true);
      }
    };
    let idleHandle: number | undefined;
    const timerHandle = globalThis.setTimeout(() => {
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(() => void start(), { timeout: 1200 });
      } else {
        void start();
      }
    }, 1200);
    return () => {
      active = false;
      if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
      clearTimeout(timerHandle);
      if (resizeFrame !== null) cancelAnimationFrame(resizeFrame);
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      observer?.disconnect();
      globe?.destroy();
    };
  }, []);
  return <div className="login-globe-stage" aria-hidden="true"><div className="login-globe-halo" /><canvas ref={canvas} className="login-globe-canvas" hidden={fallback} />{fallback && <div className="login-globe-fallback" />}</div>;
}
