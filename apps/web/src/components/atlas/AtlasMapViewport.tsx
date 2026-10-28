import { Component, lazy, Suspense, useRef, useState, type ReactNode } from "react";
import type { AtlasCamera, AtlasPrototypeProps } from "./prototypes/types";
import type { NativeSceneCamera, SceneStatus } from "./map3d/cesium-runtime";
import { SCENE_QUALITY, validateSceneSource, type SceneSource, type SceneQuality } from "./map3d/config";
import "./map3d/map3d.css";

const WorkMap = lazy(() => import("./prototypes/MapLibrePrototype"));
const CesiumMap = lazy(() => import("./map3d/CesiumAtlas"));

class RendererBoundary extends Component<{ children: ReactNode; onRetry: () => void; onWork: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <div className="atlas-scene-status is-error" role="alert"><strong>地图引擎未能启动</strong><span>可能是资源加载或图形环境异常，岗位列表仍可继续使用。</span><div><button type="button" onClick={this.props.onRetry}>重新启动地图</button><button type="button" onClick={this.props.onWork}>返回工作地图</button></div></div>;
  }
}

/** Both real renderers share the query/selection interface. Configuration stays tab-memory only. */
export default function AtlasMapViewport(props: AtlasPrototypeProps) {
  const [engine, setEngine] = useState<"work" | "globe" | "real">("work");
  const [source, setSource] = useState<SceneSource>({ kind: "globe" });
  const [quality, setQuality] = useState<SceneQuality>("balanced");
  const [settings, setSettings] = useState(false), [provider, setProvider] = useState<"google" | "tileset">("google");
  const [key, setKey] = useState(""), [url, setUrl] = useState(""), [credit, setCredit] = useState("");
  const [consent, setConsent] = useState(false), [configError, setConfigError] = useState("");
  const [status, setStatus] = useState<SceneStatus>({ phase: "loading", rootRequests: 0 });
  const [attempt, setAttempt] = useState(0);
  const nativeCamera = useRef<NativeSceneCamera | undefined>(undefined);
  const workCamera = useRef<AtlasCamera | undefined>(props.initialView);
  const revision = useRef(props.resetRevision);
  if (revision.current !== props.resetRevision) { revision.current = props.resetRevision; workCamera.current = undefined; nativeCamera.current = undefined; }
  const flat = props.visual?.viewMode === "flat";
  const showWork = engine === "work" || flat;
  function useRealScene() {
    if (!consent) { setConfigError("请先确认该数据源的使用权限、网络请求与可能的费用。"); return; }
    try {
      const next = validateSceneSource(provider === "google" ? { kind: "google", apiKey: key } : { kind: "tileset", url, attribution: credit });
      setSource(next); setStatus({ phase: "loading", rootRequests: 0 }); setEngine("real"); setSettings(false); setConfigError("");
    } catch (error) { setConfigError(error instanceof Error ? error.message : "配置无效。"); }
  }
  return <div className={`atlas-map-viewport ${props.visual?.theme ?? "light"}`} data-atlas-renderer="viewport">
    <div className="atlas-scene-sourcebar" aria-label="地图渲染来源">
      <div role="group" aria-label="选择地图模式">
        <button type="button" aria-pressed={showWork} onClick={() => setEngine("work")}>工作地图</button>
        <button type="button" aria-pressed={engine === "globe"} disabled={flat} title={flat ? "先切换上方 3D 视角" : "Cesium 地球与本地概略边界，不请求实景数据"} onClick={() => { setSource({ kind: "globe" }); setEngine("globe"); setStatus({ phase: "loading", rootRequests: 0 }); }}>三维地球</button>
        <button type="button" aria-pressed={engine === "real"} disabled={flat} onClick={() => { if (source.kind !== "globe") { setEngine("real"); } else setSettings(true); }}>实景 3D</button>
      </div>
      <button type="button" className="atlas-scene-config-trigger" onClick={() => setSettings(value => !value)} aria-expanded={settings}>数据与画质</button>
    </div>
    {settings && <section className="atlas-scene-config" aria-label="三维地图配置">
      <header><strong>实景数据与画质</strong><button type="button" aria-label="关闭三维配置" onClick={() => setSettings(false)}>关闭</button></header>
      <label>三维画质<select value={quality} onChange={event => setQuality(event.target.value as SceneQuality)}>{Object.entries(SCENE_QUALITY).map(([value, profile]) => <option value={value} key={value}>{profile.label}</option>)}</select></label>
      <label>实景数据源<select value={provider} onChange={event => { setProvider(event.target.value as "google" | "tileset"); setConsent(false); setConfigError(""); }}><option value="google">Google Photorealistic 3D Tiles</option><option value="tileset">自有 / 获准使用的 3D Tiles</option></select></label>
      {provider === "google" ? <><label>Map Tiles API Key<input type="password" autoComplete="off" spellCheck={false} value={key} onChange={event => setKey(event.target.value)} placeholder="仅保留在当前页面内存" /></label><p>需启用 Map Tiles API 与计费。Key 会随地图请求发送至 Google，浏览器可见；请按实际接入方式限制 Key。不会读取简历、岗位正文或家庭地址。</p><p className="atlas-scene-coverage-note">上海等国内街区的摄影测量覆盖尚未验证；接入成功不代表该街区有实景建筑。三维地球本身不等于卫星影像。</p><a href="https://developers.google.com/maps/documentation/tile/3d-tiles" target="_blank" rel="noreferrer">服务设置、覆盖与使用要求 ↗</a></> : <><label>tileset.json 地址<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://your-provider/tileset.json" /></label><label>数据来源署名<input value={credit} onChange={event => setCredit(event.target.value)} maxLength={500} /></label><p>数据需允许浏览器跨域加载并拥有使用许可；应用不会下载离线包或提取网格作为岗位事实。</p></>}
      <label className="atlas-scene-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />我已确认使用权限与请求范围，了解供应商可能计费。</label>
      {configError && <p role="alert">{configError}</p>}
      <div className="atlas-scene-config-actions"><button type="button" onClick={useRealScene} disabled={flat}>加载实景数据</button><button type="button" onClick={() => { setEngine("work"); setSource({ kind: "globe" }); setKey(""); setUrl(""); setCredit(""); setConsent(false); setConfigError(""); }}>清除本页凭据并返回工作地图</button></div>
    </section>}
    <div className="atlas-scene-stage">
      <RendererBoundary key={`${showWork ? "work" : "cesium"}:${attempt}`} onRetry={() => setAttempt(value => value + 1)} onWork={() => setEngine("work")}><Suspense fallback={<div className="atlas-scene-preparing" role="status">正在准备地图引擎，岗位列表可继续使用。</div>}>
        {showWork ? <WorkMap key={`${props.resetRevision}:${attempt}`} {...props} initialView={workCamera.current} onViewChange={view => { workCamera.current = view; props.onViewChange?.(view); }} />
          : <CesiumMap key={attempt} {...props} source={engine === "globe" ? { kind: "globe" } : source} quality={quality} nativeCamera={nativeCamera.current} onNativeCamera={view => { nativeCamera.current = view; }} onStatus={setStatus} />}
      </Suspense></RendererBoundary>
      {!showWork && status.phase === "loading" && <div className="atlas-scene-status" role="status"><strong>正在加载三维数据</strong><span>岗位列表与搜索可继续使用，不必等待地图。</span></div>}
      {!showWork && status.phase === "error" && <div className="atlas-scene-status is-error" role="alert"><strong>{status.failure?.title}</strong><span>{status.failure?.detail}</span><div><button type="button" onClick={() => { setStatus({ phase: "loading", rootRequests: status.rootRequests }); setAttempt(value => value + 1); }}>重试三维场景</button><button type="button" onClick={() => setEngine("work")}>返回工作地图</button></div></div>}
    </div>
    {!showWork && <div className="atlas-scene-caption"><span>{engine === "globe" ? "Cesium · 本地地球底图与概略边界，非卫星实景" : `${source.kind === "google" ? "Google Photorealistic 3D Tiles" : "授权 3D Tiles"} · 街区覆盖待核验`}</span><span>按需渲染 · {SCENE_QUALITY[quality].label}</span></div>}
  </div>;
}
