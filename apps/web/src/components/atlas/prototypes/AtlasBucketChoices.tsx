import { useLayoutEffect, useRef } from "react";
import type { MapBucket } from "@better-me/opportunities";
import "./bucket-choices.css";

export function AtlasBucketChoices({ buckets, light, onPick, onPickMany, onClose, returnFocus }: {
  buckets: readonly MapBucket[]; light: boolean; onPick: (bucket: MapBucket) => void;
  onPickMany?: (buckets: readonly MapBucket[]) => void; onClose: () => void; returnFocus: () => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const restore = useRef(returnFocus); restore.current = returnFocus;
  useLayoutEffect(() => {
    const element = panel.current;
    element?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => { if (element?.contains(document.activeElement)) restore.current(); };
  }, []);
  const total = new Set(buckets.flatMap(bucket => bucket.jobIds)).size;
  return <section ref={panel} className={`atlas-bucket-choices${light ? " light" : ""}`} aria-label="选择重叠地图标记"
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <div className="atlas-bucket-choices-heading"><strong>地图标记重叠 · {buckets.length} 组</strong><button type="button" onClick={onClose} aria-label="关闭重叠标记选择">×</button></div>
    <p>当前视角重叠不代表同一办公室。请选择地点组，或查看这些标记下的全部岗位。</p>
    {onPickMany && <button type="button" className="atlas-bucket-choices-all" onClick={() => onPickMany(buckets)}>查看全部 {total} 个岗位<span>按岗位去重 · 保留各地点精度</span></button>}
    <div className="atlas-bucket-choices-list">{buckets.map((bucket, index) => <button type="button" key={bucket.id} onClick={() => onPick(bucket)}>
      <strong>{index + 1}. {bucket.label} <span>{bucket.jobCount} 岗</span></strong>
      <small>{bucket.positionBasis === "city-reference" ? "城市分布参考 · 估算" : "来源地点组 · 精度见岗位详情"}</small>
      <small>WGS84 {bucket.longitude.toFixed(5)}, {bucket.latitude.toFixed(5)}</small>
    </button>)}</div>
  </section>;
}
