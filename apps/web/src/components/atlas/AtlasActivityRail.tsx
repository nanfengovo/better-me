import { Check, ChevronDown, CircleAlert, Database, Ellipsis, Layers3, MapPinned, Minus, Radio } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

export type AtlasActivity = {
  state: "idle" | "working" | "ready" | "attention";
  value?: number;
  detail: string;
};

const ACTIVITY_LABELS: Record<AtlasActivity["state"], string> = {
  idle: "待命",
  working: "处理中",
  ready: "可用",
  attention: "需关注",
};

/** Enable only visible, pointer-mode state feedback. Counters never schedule animation work. */
function useActivityMotion() {
  const railRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || typeof IntersectionObserver === "undefined" || !window.matchMedia) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let intersecting = false;
    let keyboardMode = false;
    const update = () => {
      const motion = intersecting && !document.hidden && !reducedMotion.matches && !keyboardMode ? "on" : "off";
      if (rail.dataset.motion !== motion) rail.dataset.motion = motion;
    };
    const observer = new IntersectionObserver(entries => {
      const entry = entries.find(candidate => candidate.target === rail);
      if (entry) intersecting = entry.isIntersecting;
      update();
    });
    const onKeyboard = () => { keyboardMode = true; update(); };
    const onPointer = () => { keyboardMode = false; update(); };
    observer.observe(rail);
    document.addEventListener("visibilitychange", update);
    document.addEventListener("keydown", onKeyboard, true);
    document.addEventListener("pointerdown", onPointer, true);
    reducedMotion.addEventListener("change", update);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", update);
      document.removeEventListener("keydown", onKeyboard, true);
      document.removeEventListener("pointerdown", onPointer, true);
      reducedMotion.removeEventListener("change", update);
      rail.dataset.motion = "off";
    };
  }, []);
  return railRef;
}

/** Presentation only. Counts are supplied by their own receipts, never inferred across lanes. */
export function AtlasActivityRail({ index, collection, enrichment, map }: {
  index: AtlasActivity;
  collection: AtlasActivity;
  enrichment: AtlasActivity;
  map: AtlasActivity;
}) {
  const railRef = useActivityMotion();
  const railId = useId();
  const [expanded, setExpanded] = useState(false);
  const lanes = [
    { id: "index", label: "岗位索引", icon: Database, activity: index, unit: "岗" },
    { id: "collection", label: "来源采集", icon: Radio, activity: collection, unit: "张卡片" },
    { id: "enrichment", label: "地区与企业", icon: Layers3, activity: enrichment, unit: "项待处理" },
    { id: "map", label: "地图落点", icon: MapPinned, activity: map, unit: "岗" },
  ];
  const attention = lanes.filter(lane => lane.activity.state === "attention");
  const indexSummary = index.value !== undefined ? `索引 ${index.value.toLocaleString("zh-CN")} 岗` : index.state === "working" ? "索引读取中" : "索引未读取";
  const summaryLabel = attention.length ? `${attention.length} 项需关注` : "状态详情";
  return <div className="atlas-activity-overview" data-expanded={expanded} data-attention={attention.length > 0}>
    <button type="button" className="atlas-activity-summary" aria-expanded={expanded} aria-controls={railId}
      aria-label={`${indexSummary}；${attention.length ? `${summaryLabel}：${attention.map(lane => lane.label).join("、")}；` : ""}${expanded ? "收起" : "展开"}状态详情`}
      onClick={() => setExpanded(value => !value)}>
      <span className="atlas-activity-summary-index"><Database size={15} aria-hidden="true" />{indexSummary}</span>
      <span className="atlas-activity-summary-status">{attention.length > 0 && <CircleAlert size={14} aria-hidden="true" />}{summaryLabel}</span>
      <ChevronDown className="atlas-activity-summary-chevron" size={16} aria-hidden="true" />
    </button>
    <ol id={railId} ref={railRef} className="atlas-activity-rail atlas-activity-rail--compact" aria-label="岗位工作区并行状态" data-motion="off">
    {lanes.map(({ id, label, icon: Icon, activity, unit }) => <li key={id} data-lane={id} data-state={activity.state} data-has-value={activity.value !== undefined}>
      <span className="atlas-activity-icon" aria-hidden="true">
        <Icon size={17} strokeWidth={1.6} />
        <span className="atlas-activity-signal">
          <Minus data-signal="idle" size={10} strokeWidth={2} />
          <Ellipsis data-signal="working" size={10} strokeWidth={2.4} />
          <Check data-signal="ready" size={10} strokeWidth={2.4} />
          <CircleAlert data-signal="attention" size={10} strokeWidth={2} />
        </span>
      </span>
      <div className="atlas-activity-content">
        <div className="atlas-activity-label"><span>{label}</span><span className="atlas-activity-state">{ACTIVITY_LABELS[activity.state]}</span></div>
        <div className="atlas-activity-value" role="group" aria-label={activity.value === undefined ? "数量尚未确认" : `已确认 ${activity.value.toLocaleString("zh-CN")} ${unit}`}>
          <strong>{activity.value === undefined ? "—" : activity.value.toLocaleString("zh-CN")}</strong>
          {activity.value !== undefined && <span>{unit}</span>}
        </div>
        <p>{activity.detail}</p>
      </div>
    </li>)}
    </ol>
  </div>;
}
