import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { Maximize2, Minimize2, Minus, X, SlidersHorizontal, RotateCcw, Check, Layout } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import "./window-resize.css";

const edges = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Edge = typeof edges[number];
const edgeNames = { n: "上边缘", s: "下边缘", e: "右边缘", w: "左边缘", ne: "右上角", nw: "左上角", se: "右下角", sw: "左下角" };

export type SnapMode =
  | "maximized"
  | "split-left"
  | "split-right"
  | "centered"
  | "compact"
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right"
  | "custom";

export interface WindowLayoutState {
  snapMode: SnapMode;
  position: { x: number; y: number };
  size: { width: number; height: number };
  opacity?: number;
  blur?: number;
}

const STORAGE_KEY = "betterme.window.layouts.v2";

function initialLayout(settings: boolean, defaultSnap: SnapMode): WindowLayoutState {
  return {
    snapMode: settings ? "centered" : defaultSnap,
    position: { x: settings ? 80 : 20, y: settings ? 40 : 20 },
    size: { width: settings ? 820 : 1000, height: settings ? 620 : 680 },
  };
}

function windowBounds(element: HTMLElement) {
  const parent = element.parentElement;
  const rect = parent?.getBoundingClientRect();
  // Absolute window coordinates are relative to the stage padding box, not the viewport.
  const x = (rect?.left ?? 0) + (parent?.clientLeft ?? 0);
  const y = (rect?.top ?? 34) + (parent?.clientTop ?? 0);
  const left = Math.min(window.innerWidth - 1, Math.max(8, x + 8));
  const top = Math.min(window.innerHeight - 1, Math.max(38, y));
  const right = Math.max(left + 1, Math.min(window.innerWidth - 8, rect && rect.width > 0 ? rect.right - 8 : window.innerWidth - 8));
  const bottom = Math.max(top + 1, Math.min(window.innerHeight, rect && rect.height > 0 ? rect.bottom : window.innerHeight));
  return { x, y, left, top, right, bottom };
}
type WindowBounds = ReturnType<typeof windowBounds>;

function clampCustomLayout(layout: WindowLayoutState, bounds: WindowBounds): WindowLayoutState {
  if (layout.snapMode !== "custom") return layout;
  const width = Math.min(bounds.right - bounds.left, Math.max(Math.min(420, bounds.right - bounds.left), layout.size.width));
  const height = Math.min(bounds.bottom - bounds.top, Math.max(Math.min(300, bounds.bottom - bounds.top), layout.size.height));
  const x = Math.max(bounds.left, Math.min(bounds.right - width, bounds.x + layout.position.x)) - bounds.x;
  const y = Math.max(bounds.top, Math.min(bounds.bottom - height, bounds.y + layout.position.y)) - bounds.y;
  if (width === layout.size.width && height === layout.size.height && x === layout.position.x && y === layout.position.y) return layout;
  return {
    ...layout,
    size: { width, height },
    position: { x, y },
  };
}

function readSavedLayouts(): Record<string, WindowLayoutState> {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveLayout(key: string, state: WindowLayoutState) {
  if (typeof window === "undefined") return;
  try {
    const current = readSavedLayouts();
    current[key] = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch { /* A rejected layout preference must not block the workspace. */ }
}

let globalZIndexCounter = 30;

export function DesktopWindow({
  title,
  children,
  hidden = false,
  inactive = false,
  settings = false,
  onHide,
  actions,
  layoutKey = "window",
  defaultSnap = "maximized",
  onFocus,
}: {
  title: string;
  children: ReactNode;
  hidden?: boolean;
  inactive?: boolean;
  settings?: boolean;
  onHide: () => void;
  actions?: ReactNode;
  layoutKey?: string;
  defaultSnap?: SnapMode;
  onFocus?: () => void;
}) {
  const { t, windowOpacity: globalWindowOpacity = 0.92, windowBlur: globalWindowBlur = 24, setDesktopPreferences } = useUiPreferences();
  
  // 1. Initial State from Storage
  const [layouts, setLayouts] = useState<Record<string, WindowLayoutState>>(readSavedLayouts);
  const layoutState = layouts[layoutKey] ?? initialLayout(settings, defaultSnap);
  const { snapMode, position, size } = layoutState;
  const currentOpacity = layoutState.opacity ?? globalWindowOpacity;
  const currentBlur = layoutState.blur ?? globalWindowBlur;

  // Window Z-Index
  const [zIndex, setZIndex] = useState(() => (settings ? 40 : ++globalZIndexCounter));
  const bringToFront = () => {
    setZIndex(++globalZIndexCounter);
    onFocus?.();
  };

  // 2. Dragging & Snapping State
  const [dragging, setDragging] = useState(false);
  const [resizing, setResizing] = useState(false);
  const [snapGuide, setSnapGuide] = useState<"left" | "right" | "top" | null>(null);
  
  // Toolbar Popover Menus
  const [showSnapMenu, setShowSnapMenu] = useState(false);
  const [showOpacityMenu, setShowOpacityMenu] = useState(false);

  const node = useRef<HTMLElement>(null);
  const capture = useRef<{ element: HTMLElement; pointerId: number; layoutKey: string } | null>(null);
  const restoreModes = useRef<Record<string, SnapMode>>({});
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    wasSnapped: boolean;
    hasDetached: boolean;
    rect: { width: number; height: number };
    bounds: WindowBounds;
  } | null>(null);

  const resize = useRef<{
    edge: Edge;
    pointerId: number;
    x: number;
    y: number;
    rect: DOMRect;
    bounds: WindowBounds;
  } | null>(null);

  const interactiveTarget = "button, a, input, select, textarea, [role=button], [contenteditable=true]";

  // Helper to commit layout change
  function updateLayout(patch: Partial<WindowLayoutState>) {
    setLayouts((prev) => {
      const next = { ...(prev[layoutKey] ?? initialLayout(settings, defaultSnap)), ...patch };
      saveLayout(layoutKey, next);
      return { ...prev, [layoutKey]: next };
    });
  }

  const clearInteraction = useCallback(() => {
    dragRef.current = null;
    resize.current = null;
    const owned = capture.current;
    capture.current = null;
    try {
      if (owned?.element.hasPointerCapture?.(owned.pointerId)) owned.element.releasePointerCapture(owned.pointerId);
    } catch { /* A removed capture target must not retain the interaction. */ }
  }, []);
  const cancelInteraction = useCallback(() => {
    clearInteraction();
    setDragging(false);
    setResizing(false);
    setSnapGuide(null);
  }, [clearInteraction]);

  useEffect(() => {
    const onResize = () => {
      cancelInteraction();
      if (!node.current) return;
      const bounds = windowBounds(node.current);
      setLayouts(previous => {
        const layout = previous[layoutKey];
        if (!layout) return previous;
        const next = clampCustomLayout(layout, bounds);
        if (next === layout) return previous;
        saveLayout(layoutKey, next);
        return { ...previous, [layoutKey]: next };
      });
    };
    window.addEventListener("blur", cancelInteraction);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("blur", cancelInteraction);
      window.removeEventListener("resize", onResize);
      clearInteraction();
    };
  }, [layoutKey, cancelInteraction, clearInteraction]);
  useEffect(() => {
    cancelInteraction();
    if (!node.current || hidden || inactive) return;
    const bounds = windowBounds(node.current);
    setLayouts(previous => {
      const layout = previous[layoutKey];
      if (!layout) return previous;
      const next = clampCustomLayout(layout, bounds);
      if (next === layout) return previous;
      saveLayout(layoutKey, next);
      return { ...previous, [layoutKey]: next };
    });
  }, [layoutKey, hidden, inactive, cancelInteraction]);

  // 3. Snap Layout Helpers
  function applySnap(mode: SnapMode) {
    cancelInteraction();
    if (mode === "maximized" && snapMode !== "maximized") restoreModes.current[layoutKey] = snapMode;
    setShowSnapMenu(false);
    updateLayout({ snapMode: mode });
  }

  function toggleMaximize() {
    if (snapMode === "maximized") {
      applySnap(restoreModes.current[layoutKey] ?? "centered");
    } else {
      applySnap("maximized");
    }
  }

  // 4. Drag Lifecycle
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (hidden || inactive || event.button !== 0 || (event.target as HTMLElement).closest(interactiveTarget)) return;
    if (capture.current?.layoutKey === layoutKey && capture.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    cancelInteraction();
    bringToFront();

    const rect = node.current!.getBoundingClientRect();
    const bounds = windowBounds(node.current!);

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origX: rect.left - bounds.x,
      origY: rect.top - bounds.y,
      wasSnapped: snapMode !== "custom",
      hasDetached: false,
      rect,
      bounds,
    };

    capture.current = { element: event.currentTarget, pointerId: event.pointerId, layoutKey };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (hidden || inactive || capture.current?.layoutKey !== layoutKey || !d || d.pointerId !== event.pointerId) return;

    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    const dist = Math.hypot(dx, dy);

    // If snapped and dragged by > 8px, smoothly detach to floating custom layout
    if (d.wasSnapped && !d.hasDetached && dist > 8) {
      d.hasDetached = true;
      const floatWidth = Math.min(960, Math.round(window.innerWidth * 0.72), d.bounds.right - d.bounds.left);
      const floatHeight = Math.min(640, Math.round(window.innerHeight * 0.75), d.bounds.bottom - d.bounds.top);
      const newX = Math.max(d.bounds.left, Math.min(d.bounds.right - floatWidth, event.clientX - floatWidth / 2)) - d.bounds.x;
      const newY = Math.max(d.bounds.top, Math.min(d.bounds.bottom - floatHeight, event.clientY - 20)) - d.bounds.y;

      d.origX = newX;
      d.origY = newY;
      d.startX = event.clientX;
      d.startY = event.clientY;
      d.rect = { width: floatWidth, height: floatHeight };

      updateLayout({
        snapMode: "custom",
        position: { x: newX, y: newY },
        size: { width: floatWidth, height: floatHeight },
      });
      return;
    }

    if (!d.wasSnapped || d.hasDetached) {
      const nextX = Math.max(d.bounds.left, Math.min(d.bounds.right - d.rect.width, d.bounds.x + d.origX + dx)) - d.bounds.x;
      const nextY = Math.max(d.bounds.top, Math.min(d.bounds.bottom - d.rect.height, d.bounds.y + d.origY + dy)) - d.bounds.y;
      updateLayout({ position: { x: nextX, y: nextY } });

      // Edge Snap Detection
      if (event.clientX < 24) {
        setSnapGuide("left");
      } else if (event.clientX > window.innerWidth - 24) {
        setSnapGuide("right");
      } else if (event.clientY < 42) {
        setSnapGuide("top");
      } else {
        setSnapGuide(null);
      }
    }
  }

  function endDrag(event: PointerEvent<HTMLElement>, commitSnap = false) {
    if (!capture.current || capture.current.pointerId !== event.pointerId) return;
    if (commitSnap && !hidden && !inactive && capture.current.layoutKey === layoutKey && dragRef.current) {
      if (snapGuide === "left") {
        updateLayout({ snapMode: "split-left" });
      } else if (snapGuide === "right") {
        updateLayout({ snapMode: "split-right" });
      } else if (snapGuide === "top") {
        updateLayout({ snapMode: "maximized" });
      }
    }
    cancelInteraction();
  }

  // 5. Resizing
  function startResize(event: PointerEvent<HTMLButtonElement>, edge: Edge) {
    if (hidden || inactive || event.button !== 0) return;
    if (capture.current?.layoutKey === layoutKey && capture.current.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    cancelInteraction();
    event.currentTarget.focus({ preventScroll: true });
    bringToFront();

    const rect = node.current!.getBoundingClientRect();
    const bounds = windowBounds(node.current!);
    applyResize(edge, 0, 0, rect, bounds);
    resize.current = { edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, bounds };
    capture.current = { element: event.currentTarget, pointerId: event.pointerId, layoutKey };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    const r = resize.current;
    if (hidden || inactive || capture.current?.layoutKey !== layoutKey || !r || r.pointerId !== event.pointerId) return;

    applyResize(r.edge, event.clientX - r.x, event.clientY - r.y, r.rect, r.bounds);
  }

  function applyResize(edge: Edge, dx: number, dy: number, rect: DOMRect, bounds: WindowBounds) {
    const minWidth = Math.min(420, bounds.right - bounds.left);
    const minHeight = Math.min(300, bounds.bottom - bounds.top);
    let left = Math.max(bounds.left, Math.min(bounds.right - minWidth, rect.left));
    let right = Math.max(left + minWidth, Math.min(bounds.right, rect.right));
    let top = Math.max(bounds.top, Math.min(bounds.bottom - minHeight, rect.top));
    let bottom = Math.max(top + minHeight, Math.min(bounds.bottom, rect.bottom));

    if (edge.includes("w")) left = Math.max(bounds.left, Math.min(right - minWidth, left + dx));
    if (edge.includes("e")) right = Math.min(bounds.right, Math.max(left + minWidth, right + dx));
    if (edge.includes("n")) top = Math.max(bounds.top, Math.min(bottom - minHeight, top + dy));
    if (edge.includes("s")) bottom = Math.min(bounds.bottom, Math.max(top + minHeight, bottom + dy));

    const newWidth = Math.round(right - left);
    const newHeight = Math.round(bottom - top);
    const newX = Math.round(left - bounds.x);
    const newY = Math.round(top - bounds.y);

    updateLayout({
      snapMode: "custom",
      position: { x: newX, y: newY },
      size: { width: newWidth, height: newHeight },
    });
  }

  // 6. Opacity & Texture Helpers
  const handleSetOpacity = (val: number) => {
    updateLayout({ opacity: val });
  };

  const handleSetBlur = (val: number) => {
    updateLayout({ blur: val });
  };

  const handleApplyToAll = () => {
    setDesktopPreferences({
      windowOpacity: currentOpacity,
      windowBlur: currentBlur,
      menuOpacity: Math.min(currentOpacity, 0.95),
    });
    setShowOpacityMenu(false);
  };

  const handleResetWindowTexture = () => {
    updateLayout({ opacity: undefined, blur: undefined });
  };

  // Close popovers on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (!node.current?.contains(e.target as Node)) {
        setShowSnapMenu(false);
        setShowOpacityMenu(false);
      }
    }
    window.addEventListener("mousedown", handleClickOutside);
    return () => window.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <>
      {/* Edge Snap Overlay Preview */}
      {snapGuide && <div className={`os-snap-guide is-${snapGuide}`} aria-hidden="true" />}

      <section
        ref={node}
        onMouseDown={bringToFront}
        className={`os-window ${settings ? "os-settings-window" : "os-business-window"} is-${snapMode}${
          snapMode === "maximized" ? " is-maximized" : ""
        }`}
        aria-label={title}
        data-layout-key={layoutKey}
        data-snap-mode={snapMode}
        data-inactive={inactive}
        data-dragging={dragging}
        data-resizing={resizing}
        data-sized={snapMode === "custom"}
        data-hidden={hidden}
        inert={hidden || inactive}
        style={
          {
            "--window-x": `${position.x}px`,
            "--window-y": `${position.y}px`,
            "--window-width": size ? `${size.width}px` : undefined,
            "--window-height": size ? `${size.height}px` : undefined,
            "--window-local-opacity": currentOpacity,
            "--window-local-blur": `${currentBlur}px`,
            "--window-z": zIndex,
          } as CSSProperties
        }
      >
        <header
          className="os-window-toolbar no-print"
          onPointerDown={startDrag}
          onPointerMove={moveDrag}
          onPointerUp={event => endDrag(event, true)}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
          onDoubleClick={(event) => {
            if (!(event.target as HTMLElement).closest(interactiveTarget)) toggleMaximize();
          }}
        >
          {/* Mac Traffic Lights */}
          <div className="os-traffic" aria-label={t("窗口操作", "Window controls")}>
            <button
              type="button"
              aria-label={t(`关闭${title}窗口`, `Close ${title} window`)}
              title={t("关闭视图，保留草稿与任务", "Close view")}
              onClick={onHide}
            >
              <X size={10} />
            </button>
            <button
              type="button"
              aria-label={t(`最小化${title}`, `Minimize ${title}`)}
              onClick={onHide}
            >
              <Minus size={10} />
            </button>
            <button
              type="button"
              aria-label={t(snapMode === "maximized" ? "还原窗口大小" : "最大化窗口", "Maximize / Restore")}
              aria-pressed={snapMode === "maximized"}
              onClick={toggleMaximize}
            >
              {snapMode === "maximized" ? <Minimize2 size={9} /> : <Maximize2 size={9} />}
            </button>
          </div>

          {/* Quick Layout & Snap Popover Button */}
          <div className="os-toolbar-control-wrap">
            <button
              type="button"
              className={`os-toolbar-icon-btn ${showSnapMenu ? "is-active" : ""}`}
              onClick={() => {
                setShowSnapMenu((v) => !v);
                setShowOpacityMenu(false);
              }}
              title={t("分屏与智能窗口布局", "Window Snapping & Layouts")}
              aria-label={t("分屏布局", "Snap layouts")}
            >
              <Layout size={13} />
              <span className="os-snap-label-tag">
                {snapMode === "split-left"
                  ? "左半屏"
                  : snapMode === "split-right"
                  ? "右半屏"
                  : snapMode === "centered"
                  ? "居中"
                  : snapMode === "custom"
                  ? "自由"
                  : "铺满"}
              </span>
            </button>

            {/* Snap Layout Dropdown Popover */}
            {showSnapMenu && (
              <div className="os-snap-menu-popover" role="menu">
                <div className="os-snap-menu-header">
                  <strong>{t("分屏与多窗口布局", "Window Snap Layouts")}</strong>
                </div>
                <div className="os-snap-grid-tiles">
                  <button
                    type="button"
                    className={`os-snap-tile ${snapMode === "split-left" ? "is-active" : ""}`}
                    onClick={() => applySnap("split-left")}
                    title="靠左半屏对齐 (50%)"
                  >
                    <div className="os-tile-preview left-half" />
                    <span>{t("◧ 左半屏", "Left Half")}</span>
                  </button>
                  <button
                    type="button"
                    className={`os-snap-tile ${snapMode === "split-right" ? "is-active" : ""}`}
                    onClick={() => applySnap("split-right")}
                    title="靠右半屏对齐 (50%)"
                  >
                    <div className="os-tile-preview right-half" />
                    <span>{t("◨ 右半屏", "Right Half")}</span>
                  </button>
                  <button
                    type="button"
                    className={`os-snap-tile ${snapMode === "maximized" ? "is-active" : ""}`}
                    onClick={() => applySnap("maximized")}
                    title="铺满整个工作区 (100%)"
                  >
                    <div className="os-tile-preview full-screen" />
                    <span>{t("⤢ 最大化", "Maximize")}</span>
                  </button>
                  <button
                    type="button"
                    className={`os-snap-tile ${snapMode === "centered" ? "is-active" : ""}`}
                    onClick={() => applySnap("centered")}
                    title="居中沉浸式视窗 (75%)"
                  >
                    <div className="os-tile-preview centered-box" />
                    <span>{t("◰ 居中视窗", "Centered")}</span>
                  </button>
                  <button
                    type="button"
                    className={`os-snap-tile ${snapMode === "compact" ? "is-active" : ""}`}
                    onClick={() => applySnap("compact")}
                    title="精巧浮动小窗 (960×600)"
                  >
                    <div className="os-tile-preview compact-box" />
                    <span>{t("◲ 紧凑浮动", "Compact")}</span>
                  </button>
                  <button
                    type="button"
                    className={`os-snap-tile ${snapMode === "top-left" ? "is-active" : ""}`}
                    onClick={() => applySnap("top-left")}
                    title="左上四分屏"
                  >
                    <div className="os-tile-preview top-left-box" />
                    <span>{t("◱ 左上角", "Top-Left")}</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Opacity & Glass Texture Control Button */}
          <div className="os-toolbar-control-wrap">
            <button
              type="button"
              className={`os-toolbar-icon-btn ${showOpacityMenu ? "is-active" : ""}`}
              onClick={() => {
                setShowOpacityMenu((v) => !v);
                setShowSnapMenu(false);
              }}
              title={t(`调节此窗口透明度 (${Math.round(currentOpacity * 100)}%)`, "Adjust window opacity")}
              aria-label={t("窗口透明度", "Window opacity")}
            >
              <SlidersHorizontal size={13} />
              <span className="os-opacity-val-badge">{Math.round(currentOpacity * 100)}%</span>
            </button>

            {/* Opacity Dropdown Popover */}
            {showOpacityMenu && (
              <div className="os-window-opacity-popover" role="dialog" aria-label="窗口透明度调节">
                <div className="os-opacity-pop-header">
                  <strong>{t("窗口透明度与毛玻璃", "Window Glass Opacity")}</strong>
                  <button
                    type="button"
                    className="os-opacity-pop-reset"
                    onClick={handleResetWindowTexture}
                    title="重置为默认值"
                  >
                    <RotateCcw size={11} />
                    <span>{t("重置", "Reset")}</span>
                  </button>
                </div>

                {/* Opacity Slider */}
                <div className="os-opacity-pop-row">
                  <div className="os-opacity-pop-label">
                    <span>{t("当前窗口不透明度", "Window Opacity")}</span>
                    <b>{Math.round(currentOpacity * 100)}%</b>
                  </div>
                  <input
                    type="range"
                    min="0.30"
                    max="1.0"
                    step="0.05"
                    value={currentOpacity}
                    onChange={(e) => handleSetOpacity(parseFloat(e.target.value))}
                    className="os-effect-slider"
                    aria-label="窗口透明度滑块"
                  />
                </div>

                {/* Quick Presets */}
                <div className="os-opacity-pop-presets">
                  {[
                    { val: 1.0, label: t("100% 实体", "Solid") },
                    { val: 0.9, label: t("90% 毛玻璃", "Glass") },
                    { val: 0.8, label: t("80% 通透", "Translucent") },
                    { val: 0.65, label: t("65% 晶莹", "Crystal") },
                    { val: 0.5, label: t("50% 极透", "Ghost") },
                  ].map((p) => (
                    <button
                      key={p.val}
                      type="button"
                      className={`os-opacity-pill ${
                        Math.abs(currentOpacity - p.val) < 0.03 ? "is-selected" : ""
                      }`}
                      onClick={() => handleSetOpacity(p.val)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                {/* Blur Slider */}
                <div className="os-opacity-pop-row" style={{ marginTop: 10 }}>
                  <div className="os-opacity-pop-label">
                    <span>{t("毛玻璃景深柔焦", "Glass Blur")}</span>
                    <b>{currentBlur}px</b>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="36"
                    step="2"
                    value={currentBlur}
                    onChange={(e) => handleSetBlur(parseInt(e.target.value, 10))}
                    className="os-effect-slider"
                    aria-label="毛玻璃虚化滑块"
                  />
                </div>

                {/* Apply to All Windows & Menus Button */}
                <button
                  type="button"
                  className="os-opacity-apply-all-btn"
                  onClick={handleApplyToAll}
                >
                  <Check size={12} />
                  <span>{t("应用到所有窗口与菜单", "Apply to all windows & menus")}</span>
                </button>
              </div>
            )}
          </div>

          <strong>{title}</strong>
          <div className="os-window-actions">{actions}</div>
        </header>

        <div className="os-window-content">{children}</div>

        {/* 8-Way Edge & Corner Resizing Handles */}
        {edges.map((edge) => (
          <button
            key={edge}
            type="button"
            className={`os-resize-handle os-resize-${edge} no-print`}
            aria-label={t(`拖动${edgeNames[edge]}调整窗口大小`, `Resize window from ${edge}`)}
            title={t("拖动缩放；聚焦后用方向键微调，Shift 加速", "Drag to resize; use arrow keys, Shift for larger steps")}
            onPointerDown={(event) => startResize(event, edge)}
            onPointerMove={moveResize}
            onPointerUp={event => endDrag(event, true)}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
            onKeyDown={event => {
              if (hidden || inactive || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault(); event.stopPropagation();
              cancelInteraction();
              const step = event.shiftKey ? 40 : 10;
              const rect = node.current!.getBoundingClientRect();
              applyResize(edge, event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0, event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0, rect, windowBounds(node.current!));
            }}
          />
        ))}
      </section>
    </>
  );
}
