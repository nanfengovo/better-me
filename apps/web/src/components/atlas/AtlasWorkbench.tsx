import { Fragment, useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Columns3, Ellipsis, Expand, FileText, GripHorizontal, GripVertical, LayoutGrid, List, Map as MapIcon, RotateCcw, Shrink } from "lucide-react";
import { useUiPreferences } from "../../lib/ui-preferences";
import {
  allocatePaneSizes, clampPaneHeight, clampWorkbenchHeight, defaultWorkbenchLayout, moveWorkbenchPane,
  paneGridTemplate, parseWorkbenchLayout, PANE_MIN_HEIGHT, PANE_MIN_WIDTH, resizePanePair, SPLITTER_SIZE,
  weightsFromSizes, WORKBENCH_LAYOUT_KEY, WORKBENCH_PRESETS,
  type WorkbenchLayout, type WorkbenchPaneId,
} from "./workbench-layout";
import type { AtlasPaneLayout } from "./use-atlas-pane-layout";
import "./atlas-workbench.css";

type Gesture = {
  pointerId: number; element: HTMLElement; x: number; y: number; startX: number; startY: number;
  kind: "width" | "height" | "reorder"; sizes: number[]; ids: WorkbenchPaneId[]; index: number;
  gridWidth: number; viewportWidth: number; viewportHeight: number;
  pane?: WorkbenchPaneId; height: number; nextHeight: number; target?: WorkbenchPaneId; moved: boolean;
};

/** Owns only presentation. Child nodes keep their keys/instances; no job/query dependencies. */
export function AtlasWorkbench({ map, jobs, detail, hasDetail, layout, active = true, empty = false }: {
  map: ReactNode; jobs: ReactNode; detail: ReactNode; hasDetail: boolean;
  layout: AtlasPaneLayout; active?: boolean; empty?: boolean;
}) {
  const { t } = useUiPreferences();
  const prefix = useId();
  const grid = useRef<HTMLDivElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const panes = useRef(new Map<WorkbenchPaneId, HTMLElement>());
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const cancelRef = useRef<() => void>(() => {});
  const [preferences, setPreferences] = useState(() => {
    try { return parseWorkbenchLayout(localStorage.getItem(WORKBENCH_LAYOUT_KEY)); }
    catch { return defaultWorkbenchLayout(); }
  });
  const [width, setWidth] = useState(layout === "wide" ? 1200 : layout === "medium" ? 760 : 390);
  const [viewportHeight, setViewportHeight] = useState(() => typeof window === "undefined" ? 1000 : window.innerHeight);
  const [focused, setFocused] = useState<WorkbenchPaneId | null>(null);
  const [status, setStatus] = useState("");
  const [saveFailed, setSaveFailed] = useState(false);
  const labels = { map: t("地图", "Map"), jobs: t("岗位列表", "Jobs"), detail: t("JD / 详情", "JD / details") };
  const visible = preferences.order.filter(id => (id !== "detail" || hasDetail) && (!focused || focused === id));
  const columns = !focused && preferences.arrangement !== "rows" && layout !== "narrow"
    && width >= visible.reduce((n,id)=>n+PANE_MIN_WIDTH[id],0) + SPLITTER_SIZE * (visible.length-1);
  const sizes = allocatePaneSizes(visible, preferences.weights, width);
  const height = preferences.height ?? clampWorkbenchHeight(viewportHeight - 480);
  const content = { map, jobs, detail };
  const icons = { map: MapIcon, jobs: List, detail: FileText };

  function commit(next: WorkbenchLayout, message?: string) {
    setPreferences(next);
    try { localStorage.setItem(WORKBENCH_LAYOUT_KEY, JSON.stringify(next)); setSaveFailed(false); }
    catch { setSaveFailed(true); }
    if (message) setStatus(message);
  }
  function clearVisuals() {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    if (ghost.current) ghost.current.hidden = true;
    grid.current?.removeAttribute("data-gesture");
    for (const element of panes.current.values()) {
      element.removeAttribute("data-drop-target");
      element.removeAttribute("data-drag-source");
    }
  }
  function restoreSize() {
    if (!grid.current) return;
    grid.current.style.gridTemplateColumns = columns ? paneGridTemplate(sizes) : "minmax(0, 1fr)";
    grid.current.style.height = columns || focused ? height + "px" : "auto";
    for (const id of preferences.order) if (!columns && !focused) {
      const element = panes.current.get(id);
      if (element) element.style.height = preferences.rowHeights[id] + "px";
    }
    // React may not rewrite an attribute whose virtual value has not changed.
    grid.current.querySelectorAll<HTMLElement>('.atlas-workbench-divider').forEach((element,index) => {
      element.setAttribute("aria-valuenow", String(Math.round(sizes[index]!/(sizes[index]!+sizes[index+1]!)*100)));
    });
    grid.current.querySelectorAll<HTMLElement>('.atlas-workbench-height').forEach(element => {
      const pane = element.closest<HTMLElement>('[data-workbench-pane]')?.dataset.workbenchPane as WorkbenchPaneId | undefined;
      element.setAttribute("aria-valuenow", String(pane ? preferences.rowHeights[pane] : height));
    });
    const overall = grid.current.parentElement?.querySelector<HTMLElement>(':scope > .atlas-workbench-height');
    overall?.setAttribute("aria-valuenow", String(height));
  }
  function finish(event?: PointerEvent<HTMLElement>, cancel = false) {
    const current = gesture.current;
    if (!current || (event && event.pointerId !== current.pointerId)) return;
    // A resize can beat ResizeObserver/React by one frame. Never persist a drag
    // calculated for a different container or viewport.
    const measured = grid.current?.getBoundingClientRect().width;
    if (!active || (measured && Math.abs(measured-current.gridWidth)>.5)
      || current.viewportWidth!==window.innerWidth || current.viewportHeight!==window.innerHeight) cancel=true;
    if (!cancel && event) {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      current.x = event.clientX; current.y = event.clientY; paintGesture();
    }
    gesture.current = null;
    clearVisuals();
    try { if (current.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId); } catch { /* Already released by the UA. */ }
    if (cancel) { restoreSize(); setStatus(t("已取消布局调整", "Layout change cancelled")); return; }
    if (current.kind === "width") {
      commit({ ...preferences, weights: weightsFromSizes(current.ids, current.sizes, preferences.weights) }, t("模块宽度已调整", "Pane widths updated"));
    } else if (current.kind === "height") {
      commit(current.pane ? { ...preferences, rowHeights: { ...preferences.rowHeights, [current.pane]: current.nextHeight } }
        : { ...preferences, height: current.nextHeight }, t("模块高度已调整", "Pane height updated"));
    } else if (current.moved && current.pane && current.target && current.pane !== current.target) {
      commit({ ...preferences, order: moveWorkbenchPane(preferences.order, current.pane, current.target) }, labels[current.pane] + t("已移动", " moved"));
      requestAnimationFrame(() => panes.current.get(current.pane!)?.querySelector<HTMLButtonElement>(".atlas-pane-drag")?.focus({ preventScroll: true }));
    }
  }
  cancelRef.current = () => finish(undefined, true);

  useEffect(() => {
    const element = grid.current;
    if (!element || !active) return;
    const measure = () => {
      const next = element.getBoundingClientRect().width;
      if (Number.isFinite(next) && next > 0) setWidth(previous => Math.abs(previous-next) < .5 ? previous : next);
      setViewportHeight(window.innerHeight);
    };
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    observer?.observe(element); window.addEventListener("resize", measure); measure();
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [active]);
  useEffect(() => { if (focused === "detail" && !hasDetail) setFocused(null); }, [hasDetail, focused]);
  useEffect(() => { cancelRef.current(); }, [layout, width, hasDetail, active, focused, preferences.arrangement]);
  useEffect(() => {
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !event.isComposing && gesture.current) {
        event.preventDefault(); event.stopPropagation(); cancelRef.current();
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => {
      window.removeEventListener("keydown", escape, true);
      const current = gesture.current; gesture.current = null; clearVisuals();
      try { if (current?.element.hasPointerCapture?.(current.pointerId)) current.element.releasePointerCapture(current.pointerId); } catch { /* Unmount cleanup only. */ }
    };
  }, []);

  function begin(event: PointerEvent<HTMLElement>, kind: Gesture["kind"], index = 0, pane?: WorkbenchPaneId) {
    if (event.button !== 0 || event.isPrimary === false || gesture.current) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true });
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { return; }
    const startHeight = pane ? preferences.rowHeights[pane] : height;
    const gridWidth = grid.current?.getBoundingClientRect().width || width;
    gesture.current = { pointerId: event.pointerId, element: event.currentTarget, x: event.clientX, y: event.clientY,
      startX: event.clientX, startY: event.clientY, kind, sizes: [...sizes], ids: [...visible], index, pane,
      height: startHeight, nextHeight: startHeight, moved: false, gridWidth, viewportWidth:window.innerWidth, viewportHeight:window.innerHeight };
    grid.current?.setAttribute("data-gesture", kind);
  }
  function paintGesture() {
    frame.current = null;
    const current = gesture.current;
    if (!current) return;
    if (current.kind === "width") {
      // Baseline sizes come from the pointer-down layout, never a moving divider.
      current.sizes = resizePanePair(sizes, current.ids, current.index, current.x-current.startX);
      if (grid.current) grid.current.style.gridTemplateColumns = paneGridTemplate(current.sizes);
      current.element.setAttribute("aria-valuenow", String(Math.round(current.sizes[current.index]! / (current.sizes[current.index]!+current.sizes[current.index+1]!) * 100)));
    } else if (current.kind === "height") {
      current.nextHeight = current.pane ? clampPaneHeight(current.height+current.y-current.startY,current.pane) : clampWorkbenchHeight(current.height+current.y-current.startY);
      const target = current.pane ? panes.current.get(current.pane) : grid.current;
      if (target) target.style.height = current.nextHeight + "px";
      current.element.setAttribute("aria-valuenow", String(current.nextHeight));
    } else {
      if (!current.moved && Math.hypot(current.x-current.startX,current.y-current.startY) < 6) return;
      current.moved = true;
      const hit = current.ids.find(id => {
        const rect = panes.current.get(id)?.getBoundingClientRect();
        return rect && current.x >= rect.left && current.x <= rect.right && current.y >= rect.top && current.y <= rect.bottom;
      });
      current.target = hit;
      for (const [id,element] of panes.current) {
        element.toggleAttribute("data-drop-target", id === hit && id !== current.pane);
        element.toggleAttribute("data-drag-source", id === current.pane);
      }
      if (ghost.current) {
        ghost.current.hidden = false;
        ghost.current.textContent = labels[current.pane!];
        ghost.current.style.transform = "translate3d(" + (current.x+16) + "px," + (current.y+12) + "px,0)";
      }
    }
  }
  function move(event: PointerEvent<HTMLElement>) {
    if (gesture.current?.pointerId !== event.pointerId) return;
    gesture.current.x = event.clientX; gesture.current.y = event.clientY;
    if (frame.current === null) frame.current = requestAnimationFrame(paintGesture);
  }
  const pointerHandlers = { onPointerMove: move, onPointerUp: (event: PointerEvent<HTMLElement>) => finish(event),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => finish(event,true),
    onLostPointerCapture: (event: PointerEvent<HTMLElement>) => finish(event,true) };

  function reorder(id: WorkbenchPaneId, delta: number) {
    const index = visible.indexOf(id), neighbour = visible[index+delta];
    if (neighbour) {
      commit({ ...preferences, order: moveWorkbenchPane(preferences.order,id,neighbour) }, labels[id] + t("已移动", " moved"));
      requestAnimationFrame(()=>panes.current.get(id)?.querySelector<HTMLButtonElement>(".atlas-pane-drag")?.focus({preventScroll:true}));
    }
  }
  function resizeKey(event: KeyboardEvent<HTMLElement>, index: number) {
    const step = event.shiftKey ? 80 : 16;
    let delta: number;
    if (event.key === "ArrowLeft") delta = -step;
    else if (event.key === "ArrowRight") delta = step;
    else if (event.key === "Home") delta = -Infinity;
    else if (event.key === "End") delta = Infinity;
    else if (event.key === "Enter") { event.preventDefault(); commit({ ...preferences, weights: { ...WORKBENCH_PRESETS.balanced } }); return; }
    else return;
    event.preventDefault();
    const next = resizePanePair(sizes,visible,index,Number.isFinite(delta) ? delta : delta > 0 ? width : -width);
    commit({ ...preferences, weights: weightsFromSizes(visible,next,preferences.weights) });
  }
  function heightKey(event: KeyboardEvent<HTMLElement>, pane?: WorkbenchPaneId) {
    const current = pane ? preferences.rowHeights[pane] : height;
    let next: number;
    if (event.key === "ArrowUp") next = current-(event.shiftKey ? 80 : 24);
    else if (event.key === "ArrowDown") next = current+(event.shiftKey ? 80 : 24);
    else if (event.key === "Home") next = pane ? PANE_MIN_HEIGHT[pane] : 520;
    else if (event.key === "End") next = 1400;
    else if (event.key === "Enter") next = pane ? defaultWorkbenchLayout().rowHeights[pane] : clampWorkbenchHeight(viewportHeight-480);
    else return;
    event.preventDefault();
    commit(pane ? { ...preferences, rowHeights: { ...preferences.rowHeights, [pane]: clampPaneHeight(next,pane) } }
      : { ...preferences, height: clampWorkbenchHeight(next) });
  }
  function heightHandle(pane?: WorkbenchPaneId) {
    return <div className="atlas-workbench-height" role="separator" tabIndex={0} aria-orientation="horizontal"
      aria-label={pane ? t("调整", "Resize ") + labels[pane] + t("高度", " height") : t("调整工作区高度", "Resize workbench height")}
      aria-valuemin={pane ? PANE_MIN_HEIGHT[pane] : 520} aria-valuemax={1400} aria-valuenow={pane ? preferences.rowHeights[pane] : height}
      aria-controls={pane ? prefix+"-"+pane : prefix+"-grid"} title={t("上下拖动；方向键微调，Enter 还原高度", "Drag vertically; arrow keys adjust, Enter resets")}
      onPointerDown={event=>begin(event,"height",0,pane)} {...pointerHandlers} onKeyDown={event=>heightKey(event,pane)}>
      <GripHorizontal size={18} aria-hidden="true" />
    </div>;
  }

  return <div className="atlas-workbench" data-arrangement={columns ? "columns" : "rows"} data-focused={focused ?? ""}>
    <div className="atlas-workbench-toolbar" role="group" aria-label={t("工作区布局", "Workbench layout")}>
      <span><LayoutGrid size={16} aria-hidden="true" />{t("工作区", "Workbench")}</span>
      <div className="atlas-workbench-presets">
        {(["balanced","map","reading"] as const).map(preset=><button key={preset} type="button" disabled={preset==="reading"&&!hasDetail}
          aria-pressed={preferences.arrangement==="auto" && !focused && Object.keys(WORKBENCH_PRESETS[preset]).every(key=>Math.abs(preferences.weights[key as WorkbenchPaneId]-WORKBENCH_PRESETS[preset][key as WorkbenchPaneId])<.01)}
          onClick={()=>{setFocused(null);commit({...preferences,weights:{...WORKBENCH_PRESETS[preset]},arrangement:"auto"});}}>
          {preset==="balanced" ? t("均衡", "Balanced") : preset==="map" ? t("地图优先", "Map first") : t("JD 精读", "Read JD")}
        </button>)}
      </div>
      <button type="button" className="atlas-workbench-arrange" aria-pressed={preferences.arrangement==="rows"}
        onClick={()=>{setFocused(null);commit({...preferences,arrangement:preferences.arrangement==="rows" ? "auto" : "rows"});}}>
        <Columns3 size={15} aria-hidden="true" />{preferences.arrangement==="rows" ? t("恢复并排", "Side by side") : t("上下排列", "Stack panes")}
      </button>
      <button type="button" aria-label={t("还原默认工作区布局", "Reset workbench layout")} title={t("还原默认布局", "Reset layout")}
        onClick={()=>{setFocused(null);commit(defaultWorkbenchLayout(),t("已还原默认布局", "Default layout restored"));}}><RotateCcw size={15} aria-hidden="true" /></button>
      {saveFailed && <small role="status">{t("布局暂未保存，当前仍可调整", "Layout could not be saved; changes still work")}</small>}
    </div>
    <p id={prefix+"-help"} className="atlas-workbench-sr">{t("拖动模块标题旁的手柄换位，或用 Alt 加方向键移动。拖动分隔条调整大小，Escape 取消。", "Drag a pane handle to reorder, or use Alt plus arrow keys. Drag separators to resize. Escape cancels.")}</p>
    <div ref={grid} id={prefix+"-grid"} className={"atlas-main-grid atlas-workbench-grid " + (hasDetail ? "has-detail" : "is-detail-collapsed") + (empty ? " is-empty-index" : "")}
      style={{gridTemplateColumns:columns ? paneGridTemplate(sizes) : "minmax(0, 1fr)",height:columns||focused ? height : "auto"}}>
      {preferences.order.map(id=>{
        const Icon = icons[id], index = visible.indexOf(id), shown = index >= 0;
        return <Fragment key={id}>
          <section ref={element=>{if(element)panes.current.set(id,element);else panes.current.delete(id);}}
            id={prefix+"-"+id} data-workbench-pane={id} className="atlas-workbench-pane" hidden={!shown}
            aria-label={labels[id]} style={{height:!columns&&!focused ? preferences.rowHeights[id] : undefined}}>
            <header className="atlas-workbench-pane-heading">
              <button className="atlas-pane-drag" type="button" aria-label={t("拖动", "Move ") + labels[id] + t("模块换位", " pane")}
                aria-describedby={prefix+"-help"} title={t("拖动换位；Alt + 方向键移动", "Drag to reorder; Alt + arrow keys")}
                onPointerDown={event=>begin(event,"reorder",0,id)} {...pointerHandlers} onKeyDown={event=>{
                  if(event.altKey&&["ArrowLeft","ArrowUp","ArrowRight","ArrowDown"].includes(event.key)){event.preventDefault();reorder(id,["ArrowLeft","ArrowUp"].includes(event.key)?-1:1);}
                }}><GripVertical size={17} aria-hidden="true" /></button>
              <strong><Icon size={15} aria-hidden="true" />{labels[id]}</strong>
              <button type="button" aria-label={(focused===id ? t("还原", "Restore ") : t("放大", "Focus ")) + labels[id] + t("模块", " pane")}
                onClick={()=>setFocused(focused===id?null:id)}>{focused===id ? <Shrink size={16} /> : <Expand size={16} />}</button>
              <details className="atlas-pane-menu" onKeyDown={event=>{
                if(event.key==="Escape"&&event.currentTarget.open){event.preventDefault();event.stopPropagation();event.currentTarget.open=false;event.currentTarget.querySelector("summary")?.focus();}
              }} onBlur={event=>{if(!event.currentTarget.contains(event.relatedTarget as Node|null))event.currentTarget.open=false;}}><summary aria-label={labels[id]+t("模块选项", " pane options")}><Ellipsis size={18} /></summary>
                <div><button type="button" disabled={index<=0} onClick={event=>{reorder(id,-1);event.currentTarget.closest("details")?.removeAttribute("open");}}><ArrowUp size={14} />{t("移到前一个位置", "Move earlier")}</button>
                  <button type="button" disabled={index<0||index===visible.length-1} onClick={event=>{reorder(id,1);event.currentTarget.closest("details")?.removeAttribute("open");}}><ArrowDown size={14} />{t("移到后一个位置", "Move later")}</button></div>
              </details>
            </header>
            <div className="atlas-workbench-pane-body">{content[id]}</div>
            {!columns&&!focused&&heightHandle(id)}
          </section>
          {shown&&columns&&index<visible.length-1&&<div className="atlas-workbench-divider" role="separator" tabIndex={0} aria-orientation="vertical"
            aria-label={labels[id]+t("与", " and ")+labels[visible[index+1]!]+t("分隔条", " splitter")} aria-valuemin={Math.round(PANE_MIN_WIDTH[id]/(sizes[index]!+sizes[index+1]!)*100)}
            aria-valuemax={Math.round((1-PANE_MIN_WIDTH[visible[index+1]!]/(sizes[index]!+sizes[index+1]!))*100)}
            aria-valuenow={Math.round(sizes[index]!/(sizes[index]!+sizes[index+1]!)*100)} aria-controls={prefix+"-"+id+" "+prefix+"-"+visible[index+1]}
            title={t("左右拖动；方向键微调，双击或 Enter 还原比例", "Drag horizontally; arrows adjust, double-click or Enter resets")}
            onPointerDown={event=>begin(event,"width",index)} {...pointerHandlers} onKeyDown={event=>resizeKey(event,index)}
            onDoubleClick={()=>commit({...preferences,weights:{...WORKBENCH_PRESETS.balanced}})}><span /></div>}
        </Fragment>;
      })}
    </div>
    {(columns||focused)&&heightHandle()}
    <div ref={ghost} className="atlas-workbench-drag-ghost" hidden aria-hidden="true" />
    <p className="atlas-workbench-sr" role="status" aria-live="polite">{status}</p>
  </div>;
}
