import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
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
  } catch {}
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
  const [layoutState, setLayoutState] = useState<WindowLayoutState>(() => {
    const saved = readSavedLayouts()[layoutKey];
    if (saved) return saved;
    return {
      snapMode: settings ? "centered" : defaultSnap,
      position: { x: settings ? 80 : 20, y: settings ? 40 : 20 },
      size: { width: settings ? 820 : 1000, height: settings ? 620 : 680 },
      opacity: undefined,
      blur: undefined,
    };
  });

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
  const dragRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
    wasSnapped: boolean;
    hasDetached: boolean;
    rect: DOMRect;
  } | null>(null);

  const resize = useRef<{
    edge: Edge;
    pointerId: number;
    x: number;
    y: number;
    rect: DOMRect;
    position: { x: number; y: number };
  } | null>(null);

  const interactiveTarget = "button, a, input, select, textarea, [role=button], [contenteditable=true]";

  // Helper to commit layout change
  function updateLayout(patch: Partial<WindowLayoutState>) {
    setLayoutState((prev) => {
      const next = { ...prev, ...patch };
      saveLayout(layoutKey, next);
      return next;
    });
  }

  // 3. Snap Layout Helpers
  function applySnap(mode: SnapMode) {
    setShowSnapMenu(false);
    updateLayout({ snapMode: mode });
  }

  function toggleMaximize() {
    if (snapMode === "maximized") {
      updateLayout({ snapMode: "centered" });
    } else {
      updateLayout({ snapMode: "maximized" });
    }
  }

  // 4. Drag Lifecycle
  function startDrag(event: PointerEvent<HTMLElement>) {
    if (event.button !== 0 || (event.target as HTMLElement).closest(interactiveTarget)) return;
    event.preventDefault();
    bringToFront();

    const rect = node.current!.getBoundingClientRect();
    const parent = node.current!.parentElement?.getBoundingClientRect() ?? { left: 0, top: 34 };

    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      origX: rect.left - parent.left,
      origY: rect.top - parent.top,
      wasSnapped: snapMode !== "custom",
      hasDetached: false,
      rect,
    };

    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLElement>) {
    const d = dragRef.current;
    if (!d) return;

    const dx = event.clientX - d.startX;
    const dy = event.clientY - d.startY;
    const dist = Math.hypot(dx, dy);

    // If snapped and dragged by > 8px, smoothly detach to floating custom layout
    if (d.wasSnapped && !d.hasDetached && dist > 8) {
      d.hasDetached = true;
      const floatWidth = Math.min(960, Math.round(window.innerWidth * 0.72));
      const floatHeight = Math.min(640, Math.round(window.innerHeight * 0.75));
      const newX = Math.max(8, Math.min(window.innerWidth - floatWidth - 8, event.clientX - floatWidth / 2));
      const newY = Math.max(38, Math.min(window.innerHeight - floatHeight - 40, event.clientY - 20));

      d.origX = newX;
      d.origY = newY;
      d.startX = event.clientX;
      d.startY = event.clientY;

      updateLayout({
        snapMode: "custom",
        position: { x: newX, y: newY },
        size: { width: floatWidth, height: floatHeight },
      });
      return;
    }

    if (!d.wasSnapped || d.hasDetached) {
      const nextX = Math.max(8, Math.min(window.innerWidth - 120, d.origX + dx));
      const nextY = Math.max(38, Math.min(window.innerHeight - 80, d.origY + dy));
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

  function endDrag() {
    if (dragRef.current) {
      if (snapGuide === "left") {
        updateLayout({ snapMode: "split-left" });
      } else if (snapGuide === "right") {
        updateLayout({ snapMode: "split-right" });
      } else if (snapGuide === "top") {
        updateLayout({ snapMode: "maximized" });
      }
    }
    dragRef.current = null;
    resize.current = null;
    setDragging(false);
    setResizing(false);
    setSnapGuide(null);
  }

  // 5. Resizing
  function startResize(event: PointerEvent<HTMLButtonElement>, edge: Edge) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    bringToFront();

    const rect = node.current!.getBoundingClientRect();
    const parent = node.current!.parentElement?.getBoundingClientRect() ?? { left: 0, top: 34 };
    const origin = { x: rect.left - parent.left, y: rect.top - parent.top };

    // Detach into custom layout if resizing from a snap mode
    if (snapMode !== "custom") {
      updateLayout({
        snapMode: "custom",
        position: origin,
        size: { width: rect.width, height: rect.height },
      });
    }

    resize.current = { edge, pointerId: event.pointerId, x: event.clientX, y: event.clientY, rect, position: origin };
    setResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    const r = resize.current;
    if (!r || r.pointerId !== event.pointerId) return;

    const dx = event.clientX - r.x;
    const dy = event.clientY - r.y;
    let { left, right, top, bottom } = r.rect;

    const minWidth = 420;
    const minHeight = 300;
    const rightLimit = window.innerWidth - 8;
    const bottomLimit = window.innerHeight - 30;

    if (r.edge.includes("w")) left = Math.max(8, Math.min(right - minWidth, left + dx));
    if (r.edge.includes("e")) right = Math.min(rightLimit, Math.max(left + minWidth, right + dx));
    if (r.edge.includes("n")) top = Math.max(38, Math.min(bottom - minHeight, top + dy));
    if (r.edge.includes("s")) bottom = Math.min(bottomLimit, Math.max(top + minHeight, bottom + dy));

    const newWidth = Math.round(right - left);
    const newHeight = Math.round(bottom - top);
    const newX = Math.round(r.position.x + (left - r.rect.left));
    const newY = Math.round(r.position.y + (top - r.rect.top));

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
          onPointerUp={endDrag}
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
            onPointerDown={(event) => startResize(event, edge)}
            onPointerMove={moveResize}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onLostPointerCapture={endDrag}
          />
        ))}
      </section>
    </>
  );
}
