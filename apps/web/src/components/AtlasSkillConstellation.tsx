import { useEffect, useId, useMemo, useRef, useState } from "react";
import { describeSceneFailure } from "./atlas/map3d/config";
import {
  prepareSkillConstellation, sameSkillConstellationBinding, skillConstellationFingerprint,
  type SkillConstellationBinding, type SkillConstellationInput, type SkillConstellationModel,
  type SkillConstellationSceneFactory, type SkillConstellationSceneHandle,
  type SkillConstellationSceneOptions, type SkillConstellationSceneStatus,
} from "../lib/skill-constellation";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./AtlasSkillConstellation.css";

export interface AtlasSkillConstellationProps extends SkillConstellationInput {
  getCurrentBinding(): SkillConstellationBinding;
  onSelectJob?(jobId: string): void;
  onInspectBadge?(badgeId: string): void;
  /** Injection is for the real scene Host or isolated tests, not a static mock
   * pretending to be a working globe. ready must observe a rendered frame. */
  sceneFactory?: SkillConstellationSceneFactory;
  sharedViewer?: SkillConstellationSceneOptions["sharedViewer"];
}

const defaultSceneFactory: SkillConstellationSceneFactory = async (...args) => {
  const { createSkillConstellationScene } = await import("../lib/skill-constellation/cesium-scene");
  return createSkillConstellationScene(...args);
};
const idleStatus: SkillConstellationSceneStatus = { phase: "loading", renderedFrame: false };

/** Changing the authority snapshot discards selected jobs, filters, callbacks and
 * any deferred Viewer mount. It does not reuse the previous owner's scene. */
export default function AtlasSkillConstellation(props: AtlasSkillConstellationProps) {
  return <Constellation key={JSON.stringify(props.binding)} {...props} />;
}

function Constellation(props: AtlasSkillConstellationProps) {
  const id = useId(), host = useRef<HTMLDivElement>(null), runtime = useRef<SkillConstellationSceneHandle | undefined>(undefined);
  const { binding, badge, links, jobMetadata, excludedJobs, limitations } = props;
  const model = useMemo(() => prepareSkillConstellation({ binding, badge, links, jobMetadata, excludedJobs, limitations }), [binding, badge, links, jobMetadata, excludedJobs, limitations]);
  const [query, setQuery] = useState(""), [skill, setSkill] = useState(""), [visibleCount, setVisibleCount] = useState(25);
  const [selectedJobId, setSelectedJobId] = useState<string>(), [candidates, setCandidates] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<SkillConstellationSceneStatus>(idleStatus), [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState(""), [receiptOpen, setReceiptOpen] = useState(false);
  const latest = useRef({ props, model, selectedJobId }); latest.current = { props, model, selectedJobId };
  const sceneFactory = props.sceneFactory ?? defaultSceneFactory;
  const isCurrent = () => {
    try { return sameSkillConstellationBinding(latest.current.props.binding, latest.current.props.getCurrentBinding()); }
    catch { return false; }
  };
  const current = isCurrent(), valid = current && model.status !== "invalid", canRender = valid && model.entries.length > 0;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = useMemo(() => model.entries.filter(entry => (!skill || entry.skillIds.includes(skill))
    && (!normalizedQuery || [entry.label, entry.company, entry.officeLabel, entry.jobId, ...entry.skillIds].some(value => value?.toLocaleLowerCase().includes(normalizedQuery)))), [model.entries, skill, normalizedQuery]);
  const filteredModel: SkillConstellationModel = useMemo(() => ({ ...model, entries: filtered, status: model.status === "invalid" ? "invalid" : filtered.length ? "ready" : "empty" }), [model, filtered]);
  const sceneInput = useRef(filteredModel); sceneInput.current = filteredModel;
  const selected = model.entries.find(entry => entry.jobId === selectedJobId), usableScene = canRender && status.phase === "ready" && status.renderedFrame;

  function selectJob(jobId: string, focus = false) {
    if (!isCurrent()) { setNotice("身份、会话或授权版本已变化，旧岗位选择没有采用。"); return; }
    if (!latest.current.model.entries.some(entry => entry.jobId === jobId)) return;
    setSelectedJobId(jobId); setCandidates([]);
    if (focus) runtime.current?.focus(jobId);
    try { latest.current.props.onSelectJob?.(jobId); }
    catch { setNotice("岗位已在本组件选中；工作区选择未完成，请重新打开该岗位。未发出投递命令。"); }
  }
  function inspectBadge() {
    if (!isCurrent()) return;
    setReceiptOpen(true);
    try { latest.current.props.onInspectBadge?.(latest.current.model.badge.id); }
    catch { setNotice("证据定位暂不可用；本次徽章回执仍可在下方查看。"); }
  }
  const actions = useRef({ selectJob, inspectBadge }); actions.current = { selectJob, inspectBadge };

  useEffect(() => {
    if (!canRender || !host.current) return;
    const abort = new AbortController(); let stopped = false, handle: SkillConstellationSceneHandle | undefined;
    const active = () => !stopped && !abort.signal.aborted && isCurrent();
    const fail = (error: unknown) => {
      if (!active()) return;
      setStatus({ phase: "error", renderedFrame: false, failure: describeSceneFailure(error) });
      clearTimeout(mountDeadline); abort.abort(); handle?.dispose();
    };
    setStatus(idleStatus);
    const mountDeadline = setTimeout(() => {
      fail(new Error("WebGL scene initialization timeout"));
    }, 10_000);
    // A microtask defers StrictMode's discarded mount without opening a Viewer.
    void Promise.resolve().then(() => {
      if (!active() || !host.current) return;
      return sceneFactory(host.current, latest.current.model, {
        status(value) {
          if (!active()) return;
          if (value.phase === "ready" && !value.renderedFrame) { fail(new Error("WebGL renderer did not observe a rendered frame")); return; }
          if (value.phase !== "loading") clearTimeout(mountDeadline);
          setStatus(value);
          if (value.phase === "error") { abort.abort(); handle?.dispose(); }
        },
        pick(jobIds) {
          if (!active()) return;
          const authorized = [...new Set(jobIds)].filter(jobId => sceneInput.current.entries.some(entry => entry.jobId === jobId));
          if (authorized.length === 1) actions.current.selectJob(authorized[0]!);
          else if (authorized.length > 1) { setCandidates(authorized); setNotice(`命中${authorized.length}个重叠岗位；请选择具体来源，不会默认采用第一项。`); }
        },
        inspectBadge() { if (active()) actions.current.inspectBadge(); },
      }, { signal: abort.signal, isCurrent: active, ...(props.sharedViewer ? { sharedViewer: props.sharedViewer } : {}) });
    }).then(value => {
      if (!value) return;
      if (!active()) { value.dispose(); return; }
      handle = value; runtime.current = value;
      value.update(sceneInput.current, latest.current.selectedJobId);
    }).catch(error => { clearTimeout(mountDeadline); fail(error); });
    return () => {
      stopped = true; clearTimeout(mountDeadline); abort.abort(); handle?.dispose();
      if (runtime.current === handle) runtime.current = undefined;
    };
    // Data/selection updates use the same Viewer; only mount policy or authority
    // changes rebuild it. latest/sceneInput make a late import use current data.
  }, [canRender, sceneFactory, props.sharedViewer, attempt]);
  useEffect(() => { if (isCurrent()) runtime.current?.update(filteredModel, selectedJobId); }, [filteredModel, selectedJobId]);

  if (!current) return <section className="atlas-skill-constellation" aria-label="技能岗位星图"><h2>技能岗位星图</h2><p role="status">身份、会话或授权版本已变化，旧徽章、坐标和连线已隐藏。请重新授权当前目标池。</p></section>;
  if (model.status === "invalid") return <section className="atlas-skill-constellation" aria-label="技能岗位星图"><h2>技能岗位星图</h2><p role="alert">{model.detail}</p><p>没有创建三维场景，也没有根据城市文本补点。</p></section>;

  return <section className="atlas-skill-constellation" aria-labelledby={`${id}-title`} data-scene-phase={canRender ? status.phase : "empty"}>
    <header className="asc-header"><div><p className="asc-eyebrow">VERIFIED INPUT · EXPLICIT SKILL OVERLAP</p><h2 id={`${id}-title`}>技能证据，连接真实岗位点</h2><p>从这枚徽章的授权技能出发，查看同一目标池中的显式交集。连线不是录用概率，也不证明岗位仍在招聘。</p></div><span>{model.entries.length}条有效连线</span></header>
    <div className="asc-badge-strip"><span className="asc-virtual-symbol" aria-hidden="true">◇</span><div><strong>{model.badge.label}</strong><span>虚拟技能节点 · 非个人地址 · 非光追渲染</span></div><button type="button" onClick={inspectBadge} aria-expanded={receiptOpen} aria-controls={`${id}-receipt`}>查看版本与证据回执</button></div>
    <div className="asc-workspace">
      <div className="asc-map-column">
        <div className={`asc-globe ${props.sharedViewer ? "asc-shared" : ""}`} aria-describedby={`${id}-map-state`}>
          <div ref={host} className="asc-scene-host" aria-label={props.sharedViewer ? "共享Job Atlas技能连线图层，完整操作可用下方岗位列表" : "三维技能岗位地球，可拖动旋转和滚轮缩放；下方列表提供完整键盘操作"} />
          {!canRender && <div className="asc-scene-fallback"><strong>暂无可上图的证据交集</strong><p>需要同时具备本人实现的技能证据，以及持久化、已索引、办公坐标已核对的目标岗位。未知信息不会补成坐标。</p></div>}
          {canRender && status.phase === "loading" && <div className="asc-scene-fallback"><strong>正在准备真实三维场景</strong><p>尚未观察到渲染帧，岗位列表仍可使用。</p></div>}
          {canRender && status.phase === "error" && <div className="asc-scene-fallback"><strong>{status.failure?.title ?? "三维场景暂不可用"}</strong><p>{status.failure?.detail ?? "可以继续使用岗位列表；没有伪造三维预览。"}</p><button type="button" onClick={() => { if (isCurrent()) setAttempt(value => value + 1); }}>重新初始化三维场景</button></div>}
          {usableScene && props.sharedViewer && <div className="asc-shared-note">连线绘制在现有 Job Atlas 场景中；此处不重复创建地球。</div>}
          <div className="asc-map-controls" role="group" aria-label="技能星图相机控制"><button type="button" aria-label="放大技能星图" disabled={!usableScene} onClick={() => { if (isCurrent()) runtime.current?.navigate("in"); }}>＋</button><button type="button" aria-label="缩小技能星图" disabled={!usableScene} onClick={() => { if (isCurrent()) runtime.current?.navigate("out"); }}>−</button><button type="button" disabled={!usableScene} onClick={() => { if (isCurrent()) runtime.current?.navigate("reset"); }}>总览</button></div>
        </div>
        <p className="asc-map-state" id={`${id}-map-state`} role="status">{!canRender ? "未请求三维引擎。" : usableScene ? "已观察到三维渲染帧。" : status.phase === "error" ? "三维不可用，已保留完整岗位列表。" : "三维正在准备，列表可独立操作。"} 当前筛选：{filtered.length}/{model.entries.length}条连线。</p>
        <p className="asc-legend"><span aria-hidden="true">●</span>来源办公坐标 <span aria-hidden="true">◇</span>虚拟证据节点 · 线宽只编码规则交集权重，不是能力分或物理引力。</p>
        {candidates.length > 1 && <section className="asc-overlaps" aria-label="选择重叠岗位" onKeyDown={event => { if (event.key === "Escape") setCandidates([]); }}><header><strong>请选择具体岗位</strong><button type="button" onClick={() => setCandidates([])}>关闭重叠选择</button></header>{candidates.map(jobId => { const entry = model.entries.find(item => item.jobId === jobId); return entry && <button key={jobId} type="button" onClick={() => selectJob(jobId)}>{entry.label} · {entry.company ?? entry.jobId}</button>; })}</section>}
        {selected && <section className="asc-selected" aria-labelledby={`${id}-selected`}><h3 id={`${id}-selected`}>{selected.label}</h3><p>{selected.company ?? "公司：未提供"} · {selected.officeLabel ?? "办公地址文字：未提供"}</p><p>交集技能：{selected.skillIds.join("、")}；规则连线权重：{selected.strength.toFixed(3)}，不是录用概率。</p><dl><div><dt>原始来源坐标</dt><dd>{selected.longitude}, {selected.latitude}</dd></div><div><dt>岗位快照SHA-256</dt><dd><code>{selected.sourceHash}</code></dd></div></dl><div className="asc-actions"><button type="button" disabled={!usableScene || !filtered.some(entry => entry.jobId === selected.jobId)} onClick={() => { if (isCurrent()) runtime.current?.focus(selected.jobId); }}>在地球定位所选岗位</button><button type="button" onClick={() => { setSelectedJobId(undefined); setCandidates([]); }}>清除选择</button></div></section>}
      </div>
      <section className="asc-list-column" aria-labelledby={`${id}-list-title`}><h3 id={`${id}-list-title`}>岗位连线列表</h3><p>与地图使用同一份授权连线；无 WebGL 时仍可筛选、选择和核对版本。</p><div className="asc-filters"><label htmlFor={`${id}-query`}>搜索岗位、公司或技能<input id={`${id}-query`} type="search" value={query} onChange={event => { setQuery(event.target.value); setVisibleCount(25); setCandidates([]); }} placeholder="搜索当前目标池" /></label><label htmlFor={`${id}-skill`}>交集技能<select id={`${id}-skill`} value={skill} onChange={event => { setSkill(event.target.value); setVisibleCount(25); setCandidates([]); }}><option value="">全部技能</option>{model.badge.skillIds.map(item => <option value={item} key={item}>{item}</option>)}</select></label></div>
        <p className="asc-list-count" aria-live="polite">筛选结果{filtered.length}条；显示前{Math.min(filtered.length, visibleCount)}条。</p>
        {filtered.length > 0 ? <ul className="asc-job-list">{filtered.slice(0, visibleCount).map(entry => <li key={entry.jobId}><button type="button" aria-pressed={selected?.jobId === entry.jobId} onClick={() => selectJob(entry.jobId)}><strong>{entry.label}</strong><span>{entry.company ?? "公司未提供"} · {entry.officeLabel ?? "采用已核对的来源办公坐标"}</span><span>{entry.skillIds.length}项技能交集 · 权重{entry.strength.toFixed(3)}</span></button></li>)}</ul> : <p className="asc-list-empty">{model.entries.length ? "当前筛选没有连线；清空搜索或选择全部技能可恢复。不会据此判断岗位关闭。" : "本次目标池没有满足上图条件的技能岗位连线。"}</p>}
        {visibleCount < filtered.length && <button type="button" className="asc-more" onClick={() => setVisibleCount(value => Math.min(500, value + 25))}>再显示25条</button>}
        {(query || skill) && <button type="button" onClick={() => { setQuery(""); setSkill(""); setVisibleCount(25); setCandidates([]); }}>清空筛选</button>}
      </section>
    </div>
    {notice && <p className="asc-notice" role="status">{notice}</p>}
    <section id={`${id}-receipt`} className="asc-receipt" hidden={!receiptOpen} aria-label="徽章来源版本与回执"><h3>本次徽章证据边界</h3><dl><div><dt>徽章</dt><dd>{model.badge.id}</dd></div><div><dt>Verification Receipt</dt><dd>{model.badge.verificationReceiptId}</dd></div><div><dt>来源SHA-256</dt><dd><code>{model.badge.sourceHash}</code></dd></div><div><dt>目标池版本</dt><dd>{model.binding.revision}</dd></div></dl><p>回执只绑定所检查的版本和范围；不独立证明作者身份、生产业绩或个人能力。真实 Vork 图片应同时核对其独立渲染文件回执。</p><button type="button" onClick={() => setReceiptOpen(false)}>收起回执</button></section>
    <details className="asc-boundaries"><summary>排除项与使用边界</summary><p>Host未生成连线的岗位：{model.excludedJobs === null ? "未提供数量" : model.excludedJobs}；本组件拒绝或去重的连线：{model.rejectedLinks.length}。不把缺失信息当成岗位关闭。</p>{model.rejectedLinks.length > 0 && <ul>{model.rejectedLinks.map((item, index) => <li key={`${item.id}-${index}`}>{item.id}：{item.reason}</li>)}</ul>}<ul>{model.limitations.map(item => <li key={item}>{item}</li>)}</ul></details>
  </section>;
}

// Exporting the stable key is useful to a Host acceptance harness. It is a
// payload-identity check only, not a receipt or permission credential.
export { skillConstellationFingerprint };
