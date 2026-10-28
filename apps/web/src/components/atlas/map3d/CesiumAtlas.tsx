import { useEffect, useMemo, useRef, useState } from "react";
import type { AtlasPrototypeProps } from "../prototypes/types";
import type { CesiumAtlasHandle, NativeSceneCamera, SceneStatus } from "./cesium-runtime";
import type { SceneQuality, SceneSource } from "./config";
import { describeSceneFailure } from "./config";
import { mapBucketPrecisionLabel } from "../prototypes/map-performance";
import { isMappableOfficeBucket } from "../prototypes/map-performance";
import { activeMapFocus } from "../map-focus";
import "cesium/Build/Cesium/Widgets/widgets.css";

export type CesiumAtlasProps = AtlasPrototypeProps & {
  source: SceneSource; quality: SceneQuality; onStatus: (status: SceneStatus) => void;
  nativeCamera?: NativeSceneCamera; onNativeCamera: (view: NativeSceneCamera) => void;
};
export default function CesiumAtlas(props: CesiumAtlasProps) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props), runtime = useRef<CesiumAtlasHandle | undefined>(undefined);
  latest.current = props;
  const [candidates, setCandidates] = useState<string[]>([]);
  const [addressesOpen, setAddressesOpen] = useState(false);
  const [addressQuery, setAddressQuery] = useState("");
  useEffect(() => {
    let stopped = false;
    // Deferred import lets StrictMode's discarded mount exit without creating a Viewer/root request.
    void import("./cesium-runtime").then(({ createCesiumAtlas }) => {
      if (stopped || !host.current) return;
      const current = latest.current;
      const handle = createCesiumAtlas(host.current, current, { status: value => latest.current.onStatus(value),
        pick: ids => {
          if (ids.length === 1) activate(ids[0]!);
          else setCandidates(ids);
        }, camera: view => latest.current.onNativeCamera(view), initialCamera: current.nativeCamera });
      runtime.current = handle; handle.quality(current.quality); handle.source(current.source);
    }).catch(error => { if (!stopped) latest.current.onStatus({ phase: "error", rootRequests: 0, failure: describeSceneFailure(error) }); });
    return () => { stopped = true; runtime.current?.dispose(); runtime.current = undefined; };
  }, []);
  useEffect(() => { runtime.current?.update(props); }, [props]);
  useEffect(() => { runtime.current?.quality(props.quality); }, [props.quality]);
  useEffect(() => { runtime.current?.source(props.source); }, [props.source]);
  function activate(id: string) {
    const bucket = latest.current.buckets.find(bucket => bucket.id === id);
    if (!bucket) return;
    latest.current.onPick?.(bucket); latest.current.onActivateBucket?.(bucket); setCandidates([]); setAddressesOpen(false);
  }
  const office = useMemo(() => props.buckets.filter(bucket => isMappableOfficeBucket(bucket) && Number.isFinite(bucket.latitude) && Number.isFinite(bucket.longitude) && Math.abs(bucket.longitude) <= 180 && Math.abs(bucket.latitude) <= 90 && bucket.jobCount > 0), [props.buckets]);
  const matches = useMemo(() => { const query = addressQuery.trim().toLocaleLowerCase(); return query ? office.filter(bucket => bucket.label.toLocaleLowerCase().includes(query)) : office; }, [office, addressQuery]);
  const focus = activeMapFocus(props.focus, props.selectedJobId);
  return <div className="atlas-cesium" data-atlas-renderer="cesium">
    <div ref={host} className="atlas-cesium-canvas" aria-label="三维岗位地球，可拖动旋转、滚轮缩放" />
    <button type="button" className="atlas-cesium-addresses" onClick={() => setAddressesOpen(value => !value)} aria-expanded={addressesOpen}>办公地址 {office.length.toLocaleString()}</button>
    {focus && <div className="atlas-cesium-focus-note">{focus.label ?? focus.locationLabel ?? "所选地点"}{focus.estimated ? " · 临时估算，不代表办公地址" : " · 来源坐标"}</div>}
    <div className="atlas-cesium-navigation" role="group" aria-label="三维相机控制"><button type="button" aria-label="放大三维地图" onClick={() => runtime.current?.navigate("in")}>＋</button><button type="button" aria-label="缩小三维地图" onClick={() => runtime.current?.navigate("out")}>−</button><button type="button" aria-label="三维地图朝北" onClick={() => runtime.current?.navigate("north")}>N</button></div>
    {(addressesOpen || candidates.length > 0) && <section className="atlas-cesium-picker" role="dialog" aria-label={candidates.length ? "选择同址岗位地点" : "选择办公地址"} onKeyDown={event => { if (event.key === "Escape") { setCandidates([]); setAddressesOpen(false); } }}>
      <header><strong>{candidates.length ? `同一坐标 · ${candidates.length} 个来源地址` : "来源办公地址"}</strong><button type="button" aria-label="关闭地址列表" onClick={() => { setCandidates([]); setAddressesOpen(false); }}>关闭</button></header>
      {!candidates.length && <input aria-label="筛选办公地址" value={addressQuery} onChange={event => setAddressQuery(event.target.value)} placeholder="搜索地址" />}
      <div className="atlas-cesium-picker-list">{(candidates.length ? office.filter(bucket => candidates.includes(bucket.id)) : matches.slice(0, 100)).map(bucket => <button type="button" key={bucket.id} onClick={() => activate(bucket.id)}><strong>{bucket.label}</strong><span>{bucket.jobCount} 个岗位 · {mapBucketPrecisionLabel(bucket)}</span></button>)}</div>
      {!candidates.length && matches.length > 100 && <p>前 100 / {matches.length.toLocaleString()} 个地址，搜索可查其余。</p>}
      {!office.length && <p>尚无来源精确坐标；不会以城市中心生成办公室。</p>}
    </section>}
  </div>;
}
