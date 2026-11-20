import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map, ChevronRight, Compass, Layers, List, MapPin, Minus, Plus, Radar, X } from "lucide-react";
import type { AtlasPrototypeProps } from "../prototypes/types";
import type { CesiumAtlasHandle, NativeSceneCamera, SceneStats, SceneStatus } from "./cesium-runtime";
import type { SceneQuality, SceneSource, SceneSurface, SceneSurfaceStatus } from "./config";
import { describeSceneFailure } from "./config";
import { mapBucketPrecisionLabel } from "../prototypes/map-performance";
import { isSceneOffice } from "./scene-model";
import { activeMapFocus } from "../map-focus";
import "cesium/Build/Cesium/Widgets/widgets.css";

export type CesiumAtlasProps = AtlasPrototypeProps & {
  source: SceneSource; quality: SceneQuality; surface: SceneSurface; onStatus: (status: SceneStatus) => void;
  onSurfaceStatus: (status: SceneSurfaceStatus) => void;
  nativeCamera?: NativeSceneCamera; onNativeCamera: (view: NativeSceneCamera) => void;
};
export default function CesiumAtlas(props: CesiumAtlasProps) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props), runtime = useRef<CesiumAtlasHandle | undefined>(undefined);
  latest.current = props;
  const [candidates, setCandidates] = useState<string[]>([]);
  const [addressesOpen, setAddressesOpen] = useState(false);
  const [addressQuery, setAddressQuery] = useState("");
  const [visibleLimit, setVisibleLimit] = useState(100);
  const [stats, setStats] = useState<SceneStats>();
  const listTrigger = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLElement>(null);
  const closePicker = useCallback(() => {
    setCandidates([]); setAddressesOpen(false); listTrigger.current?.focus();
  }, []);
  const activate = useCallback((id: string, locate = false) => {
    const bucket = latest.current.buckets.find(bucket => bucket.id === id);
    if (!bucket || !isSceneOffice(bucket)) return;
    if (locate) runtime.current?.fitBuckets([id]);
    latest.current.onPick?.(bucket); latest.current.onActivateBucket?.(bucket);
    if (locate) closePicker();
    else { setCandidates([]); setAddressesOpen(false); }
  }, [closePicker]);
  useEffect(() => {
    let stopped = false;
    // Deferred import lets StrictMode's discarded mount exit without creating a Viewer/root request.
    void import("./cesium-runtime").then(({ createCesiumAtlas }) => {
      if (stopped || !host.current) return;
      const current = latest.current;
      const handle = createCesiumAtlas(host.current, current, { status: value => latest.current.onStatus(value),
        pick: ids => {
          if (ids.length === 1) activate(ids[0]!);
          else { setAddressesOpen(false); setCandidates(ids); setAddressQuery(""); setVisibleLimit(100); }
        }, camera: view => latest.current.onNativeCamera(view), stats: setStats, surfaceStatus: status => latest.current.onSurfaceStatus(status), initialCamera: current.nativeCamera });
      runtime.current = handle; handle.quality(current.quality); handle.source(current.source); handle.surface(current.surface);
    }).catch(error => { if (!stopped) latest.current.onStatus({ phase: "error", rootRequests: 0, failure: describeSceneFailure(error) }); });
    return () => { stopped = true; runtime.current?.dispose(); runtime.current = undefined; };
  }, [activate]);
  useEffect(() => { runtime.current?.update(props); }, [props]);
  useEffect(() => { runtime.current?.quality(props.quality); }, [props.quality]);
  useEffect(() => { runtime.current?.source(props.source); }, [props.source]);
  useEffect(() => { runtime.current?.surface(props.surface); }, [props.surface]);
  const office = useMemo(() => props.buckets.filter(isSceneOffice), [props.buckets]);
  const selectedCandidates = useMemo(() => {
    const ids = new Set(candidates);
    return office.filter(bucket => ids.has(bucket.id));
  }, [office, candidates]);
  const coordinateCount = useMemo(() => new Set(selectedCandidates.map(bucket => `${bucket.longitude},${bucket.latitude}`)).size, [selectedCandidates]);
  const candidateMode = candidates.length > 0;
  const pickerOpen = addressesOpen || candidateMode;
  const source = candidateMode ? selectedCandidates : office;
  const matches = useMemo(() => {
    const query = addressQuery.trim().toLocaleLowerCase();
    return query ? source.filter(bucket => bucket.label.toLocaleLowerCase().includes(query)) : source;
  }, [source, addressQuery]);
  useEffect(() => { if (pickerOpen) picker.current?.focus(); }, [pickerOpen]);
  const focus = activeMapFocus(props.focus, props.selectedJobId);
  return <div className="atlas-cesium" data-atlas-renderer="cesium">
    <div ref={host} className="atlas-cesium-canvas" aria-label="三维岗位地球，可拖动旋转、滚轮缩放" />
    <div className="atlas-cesium-head">{stats && <div className="atlas-cesium-overview">
      <Layers size={15} aria-hidden="true" />
      <div><strong>{stats.markers.toLocaleString()} 个岗位标记</strong><span>{stats.coordinates.toLocaleString()} 个来源坐标{stats.coordinates > stats.markers ? " · 区域聚合" : ""}{stats.nearby > 0 ? ` · 周边企业 ${stats.nearby}` : ""}</span></div>
    </div>}
    <button type="button" ref={listTrigger} className="atlas-cesium-addresses" onClick={() => {
      if (addressesOpen && !candidateMode) closePicker();
      else { setCandidates([]); setAddressQuery(""); setVisibleLimit(100); setAddressesOpen(true); }
    }} aria-expanded={pickerOpen}><List size={16} aria-hidden="true" /> <span>办公地址 <b>{office.length.toLocaleString()}</b></span></button>
    {stats?.canScan && props.onScanViewportArea && <button type="button" className="atlas-cesium-scan" title="以当前三维视野中心为目标探测周边企业" onClick={() => runtime.current?.scanViewport()}><Radar size={15} aria-hidden="true" /> 扫此区域企业</button>}
    {focus && <div className="atlas-cesium-focus-note">{focus.label ?? focus.locationLabel ?? "所选地点"}{focus.estimated ? " · 临时估算，不代表办公地址" : " · 来源坐标"}</div>}</div>
    <div className="atlas-cesium-navigation" role="group" aria-label="三维相机控制">
      <button type="button" title="放大" aria-label="放大三维地图" onClick={() => runtime.current?.navigate("in")}><Plus size={19}/></button>
      <button type="button" title="缩小" aria-label="缩小三维地图" onClick={() => runtime.current?.navigate("out")}><Minus size={19}/></button>
      <button type="button" title="朝北" aria-label="三维地图朝北" onClick={() => runtime.current?.navigate("north")}><Compass size={19}/></button>
      <span className="atlas-cesium-nav-divider" />
      <button type="button" title="俯视" aria-label="俯视三维地图" onClick={() => runtime.current?.navigate("overhead")}><Map size={19}/></button>
      <button type="button" title="倾斜视角" aria-label="倾斜三维地图" onClick={() => runtime.current?.navigate("tilt")}><Layers size={19}/></button>
    </div>
    {pickerOpen && <section ref={picker} tabIndex={-1} className="atlas-cesium-picker" role="dialog" aria-label={candidateMode ? "选择地图标记中的地址" : "选择办公地址"} onKeyDown={event => { if (event.key === "Escape") closePicker(); }}>
      <header><div><strong>{candidateMode ? coordinateCount > 1 ? "区域聚合地址" : "同坐标地址" : "来源办公地址"}</strong><span>{source.length.toLocaleString()} 个地址{candidateMode && coordinateCount > 1 ? ` · ${coordinateCount} 个坐标` : ""}</span></div><button type="button" aria-label="关闭地址列表" onClick={closePicker}><X size={18}/></button></header>
      {candidateMode && coordinateCount > 1 && <button className="atlas-cesium-fit" type="button" onClick={() => { runtime.current?.fitBuckets(selectedCandidates.map(bucket => bucket.id)); closePicker(); }}>放大到这组地址 <ChevronRight size={16}/></button>}
      <input aria-label="筛选办公地址" value={addressQuery} onChange={event => { setAddressQuery(event.target.value); setVisibleLimit(100); }} placeholder="搜索地址" />
      <div className="atlas-cesium-picker-list">{matches.slice(0, visibleLimit).map(bucket => <button type="button" key={bucket.id} onClick={() => activate(bucket.id, true)}><MapPin size={16} aria-hidden="true"/><div><strong>{bucket.label}</strong><span>{bucket.jobCount} 个岗位 · {mapBucketPrecisionLabel(bucket)}</span></div><ChevronRight size={16} aria-hidden="true"/></button>)}
        {matches.length > visibleLimit && <button type="button" className="atlas-cesium-more" onClick={() => setVisibleLimit(limit => limit + 100)}>显示更多地址（{Math.min(visibleLimit, matches.length).toLocaleString()} / {matches.length.toLocaleString()}）</button>}
        {!matches.length && <p>{source.length ? "没有匹配的地址。" : "当前结果中没有这组来源地址。"}</p>}
      </div>
    </section>}
  </div>;
}
