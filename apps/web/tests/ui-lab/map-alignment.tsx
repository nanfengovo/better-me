import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { MapLibrePrototype } from "../../src/components/atlas/prototypes/MapLibrePrototype";
import { AtlasViewControls } from "../../src/components/atlas/AtlasViewControls";
import { resolveAdminBoundaryHighlight, type AdminBoundaryHighlight, type AdminGeoJson } from "../../src/components/atlas/admin-boundary-service";
import { UiPreferencesProvider } from "../../src/lib/ui-preferences";
import rawBoundaryUrl from "../../src/components/atlas/geo/shanghai-official-boundary.geojson?url";
import "../../src/index.css";
import "../../src/studio.css";
import "../../src/theme.css";
import "../../src/atelier.css";
import "../../src/themes/workspace-theme.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "../../src/components/atlas/atlas.css";
import "../../src/components/atlas/atlas-experience.css";

const CLOSE_BOUNDS = [121.10, 31.24, 121.20, 31.32] as const;
const NO_JOBS = [] as const;

function firstCoordinate(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number") return value;
  for (const child of value) {
    const coordinate = firstCoordinate(child);
    if (coordinate) return coordinate;
  }
  return undefined;
}

function firstVertex(geometry: AdminGeoJson | undefined) {
  const feature = geometry?.type === "FeatureCollection" ? geometry.features[0] : geometry;
  return firstCoordinate(feature?.geometry.coordinates)?.slice(0, 2).map(value => value.toFixed(9)).join(", ") ?? "尚未载入";
}

const fixtureStyle = `
.map-alignment-lab{min-height:100dvh;background:var(--color-paper);color:var(--color-ink);padding:20px;font-family:system-ui,sans-serif}
.map-alignment-lab h1{font-size:20px;line-height:1.4;margin:0 0 6px}
.map-alignment-lab>p{font-size:14px;line-height:1.6;margin:4px 0 14px;color:var(--color-ink-muted)}
.map-alignment-layout{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:18px;align-items:start}
.map-alignment-scene{height:calc(100dvh - 128px);min-height:400px;overflow:hidden;border:1px solid var(--color-line);border-radius:20px;background:var(--color-panel)}
/* Preserve native control geometry when this standalone fixture's broad
   workspace button styles load last. Keep this compatibility reset local. */
.map-alignment-lab .map-alignment-scene .maplibregl-ctrl-top-right{top:12px;right:12px}
.map-alignment-scene .maplibregl-ctrl-group>button{display:block;width:44px;height:44px;min-height:0;padding:0;border:0;border-radius:0;gap:0}
.map-alignment-scene .maplibregl-ctrl-group>button+button{border-top:1px solid #ddd}
.map-alignment-scene .maplibregl-ctrl button .maplibregl-ctrl-icon{display:block;width:100%;height:100%;flex:none}
.map-alignment-controls{padding:18px;border:1px solid var(--color-line);border-radius:16px;background:var(--color-panel);display:grid;gap:16px}
.map-alignment-controls fieldset{margin:0;padding:0;border:0;display:flex;gap:8px;flex-wrap:wrap}
.map-alignment-controls legend{font-weight:600;font-size:14px;line-height:1.5;margin-bottom:8px}
.map-alignment-controls button{min-height:44px;border:1px solid var(--color-line);background:var(--color-paper);color:var(--color-ink);border-radius:8px;padding:8px 10px;font:inherit;font-size:14px;cursor:pointer}
.map-alignment-controls button[aria-pressed=true]{border-color:var(--color-accent);background:var(--color-accent-soft)}
.map-alignment-controls button:focus-visible{outline:2px solid var(--color-accent);outline-offset:3px}
.map-alignment-controls p,.map-alignment-controls output{font-size:13px;line-height:1.6;margin:0;overflow-wrap:anywhere}
.map-alignment-controls code{display:block;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.map-alignment-controls dl{display:grid;gap:9px;margin:0;font-size:13px;line-height:1.6}
.map-alignment-controls dd{margin:0}.map-alignment-controls dt{font-weight:600}
@media(max-width:760px){.map-alignment-lab{padding:10px}.map-alignment-layout{grid-template-columns:minmax(0,1fr)}.map-alignment-scene{height:66dvh;min-height:350px}.map-alignment-controls{padding:14px}}
`;

function AlignmentLab() {
  const parameters = new URLSearchParams(location.search);
  const [raw, setRaw] = useState(parameters.get("source") === "raw");
  const [extent, setExtent] = useState<"close" | "city">(parameters.get("extent") === "city" ? "city" : "close");
  const [view, setView] = useState<"flat" | "spatial">("flat");
  const [frame, setFrame] = useState(0);
  const [normalized, setNormalized] = useState<AdminBoundaryHighlight | null>(null);
  const [original, setOriginal] = useState<AdminGeoJson>();
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    void Promise.all([
      resolveAdminBoundaryHighlight({ provinceCode: "31" }, "light"),
      fetch(rawBoundaryUrl, { signal: abort.signal }).then(async response => {
        if (!response.ok) throw new Error(`Bundled comparison boundary failed: ${response.status}`);
        return response.json() as Promise<AdminGeoJson>;
      }),
    ]).then(([boundary, source]) => {
      if (abort.signal.aborted) return;
      if (!boundary) throw new Error("Shanghai boundary is unavailable.");
      setNormalized(boundary); setOriginal(source);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Boundary fixture failed."); });
    return () => abort.abort();
  }, []);
  const boundary = useMemo<AdminBoundaryHighlight | null>(() => {
    if (!normalized || !original) return null;
    return raw ? { ...normalized, name: "上海市 · 原始 DataV 对照", geoJson: original } : normalized;
  }, [normalized, original, raw]);
  const bounds = extent === "city" ? normalized?.bounds : CLOSE_BOUNDS;
  return <div className="map-alignment-lab">
    <style>{fixtureStyle}</style>
    <h1>行政边界坐标对照</h1>
    <p>真实地图组件与本地边界资产 · 无岗位、无简历、无采集请求。此页仅用于坐标对齐验收。</p>
    <main className="map-alignment-layout">
      <section className="map-alignment-scene atlas-workspace atlas-experience" data-map-alignment-scene data-pane-layout="wide">
        {boundary && <MapLibrePrototype mode="domestic" buckets={NO_JOBS} selectedRegionId="CN-SH"
          adminBoundary={boundary} bounds={bounds} boundsMaxZoom={extent === "city" ? 9 : 13}
          framingKey={`alignment:${extent}:${frame}`}
          visual={{ theme: "light", viewMode: view, animateViewChange: false, entrance: false, autoRotate: false, maxDpr: 1 }}
          onReady={() => setReady(true)} onError={reason => setError(reason.message)} />}
      </section>
      <aside className="map-alignment-controls" aria-label="坐标对照控制">
        <fieldset><legend>叠加边界</legend>
          <button type="button" aria-pressed={!raw} onClick={() => setRaw(false)}>生产边界 · 目标 WGS84</button>
          <button type="button" aria-pressed={raw} onClick={() => setRaw(true)}>原始 DataV · 仅对照</button>
        </fieldset>
        <fieldset><legend>范围</legend>
          <button type="button" aria-pressed={extent === "close"} onClick={() => setExtent("close")}>上海西侧近景</button>
          <button type="button" aria-pressed={extent === "city"} onClick={() => setExtent("city")}>上海全市</button>
          <button type="button" onClick={() => setFrame(value => value + 1)}>重置当前范围</button>
        </fieldset>
        <AtlasViewControls value={view} onChange={next => setView(next)} />
        <dl>
          <div><dt>当前叠加首顶点</dt><dd><code data-current-vertex>{firstVertex(boundary?.geoJson)}</code></dd></div>
          <div><dt>生产边界首顶点</dt><dd><code data-normalized-vertex>{firstVertex(normalized?.geoJson)}</code></dd></div>
          <div><dt>DataV 原始首顶点</dt><dd><code data-raw-vertex>{firstVertex(original)}</code></dd></div>
        </dl>
        <output aria-live="polite">{error ? `验收错误：${error}` : ready ? "地图已就绪；切换边界不会重置当前相机。" : "正在载入本地边界与在线底图…"}</output>
        <p>原始坐标按钮仅作故障对照，不能作为生产地图输入。行政范围可能包含水域，不能按海岸线吸附；数据版本和概化误差不会因为坐标转换而消失，本页不证明测绘精度。</p>
      </aside>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<UiPreferencesProvider initialPreferences={{ locale: "zh", theme: "light", workspaceThemeId: "atelier" }}><AlignmentLab /></UiPreferencesProvider>);
