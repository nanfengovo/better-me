import { useEffect, useRef, useState } from "react";

export type AtlasPaneLayout = "wide" | "medium" | "narrow";

/** Measure the embedded workspace, whose width can differ from the browser viewport. */
export function useAtlasPaneLayout(active: boolean) {
  const workspace = useRef<HTMLElement>(null);
  // Until measured, keep details in normal flow so a hidden workspace cannot create an overlay.
  const [layout, setLayout] = useState<AtlasPaneLayout>("medium");
  useEffect(() => {
    const element = workspace.current;
    if (!element || !active) return;
    let disposed = false;
    const measure = () => {
      if (disposed) return;
      const width = element.getBoundingClientRect().width;
      // Hidden workspaces have no usable width; preserve their last measured layout.
      if (!Number.isFinite(width) || width <= 0) return;
      setLayout(width >= 900 ? "wide" : width >= 600 ? "medium" : "narrow");
    };
    const observer = typeof window.ResizeObserver === "function" ? new window.ResizeObserver(measure) : undefined;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    measure();
    return () => { disposed = true; observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [active]);
  return { workspace, layout };
}
