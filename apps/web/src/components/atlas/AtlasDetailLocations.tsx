/** @jsxRuntime automatic */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FileSearch, Loader2, MapPin, X } from "lucide-react";
import type { AtlasDataset, JobLocation } from "@better-me/opportunities";
import { REVIEWED_PLATFORM_NAMES, reviewedCardIdentity, type DetailLocationsPreview, type ImportDetailLocationsInput, type PlatformDetailLocations } from "@better-me/source-adapters/browser-contracts";
import { extractJdLink, startJdBrowserSession, readJdBrowserSession, closeJdBrowserSession, cancelJdBrowserStartRequest, type JdBrowserSession, type JdImportResult } from "../../lib/jd-import";
import { JdBrowserStartCleanupError } from "../../lib/jd-errors";
import { jdBrowserCleanupTracker } from "../../lib/jd-browser-cleanup";
import { createAtlasSourceClient, AtlasSourceServiceError } from "./service-client";
import "./AtlasDetailLocations.css";

export type AtlasDetailLocationsProps = {
  endpoint: string; token: string; data: AtlasDataset; jobId: string;
  onSnapshot: (snapshot: AtlasDataset) => void;
  onClose: () => void;
  onOfficeSnapshot: (snapshot: AtlasDataset, location: JobLocation) => void;
};
const OfficeConfirmation = lazy(() => import("./AtlasOfficeAddressConfirmation").then(module => ({ default: module.AtlasOfficeAddressConfirmation })));
type Target = { listingId: string; jobId: string; url: string; provider: PlatformDetailLocations["provider"]; label: string };
type PendingWrite = { input: ImportDetailLocationsInput; key: string };
type SavedWrite = { revision: number; locationIds: string[] };
// Keep an uncertain write available across panel/job switches in this page. Credentials,
// captured addresses and requests are never persisted to disk or shared across connections.
const recoverableWrites = new Map<string, { pending?: PendingWrite; saved?: SavedWrite; capture?: PlatformDetailLocations; preview?: DetailLocationsPreview }>();
async function closeOwnedSession(session: JdBrowserSession) {
  const key = `session:${session.sessionId}`;
  try { await closeJdBrowserSession(session.sessionId); jdBrowserCleanupTracker.confirm(key); }
  catch (error) { jdBrowserCleanupTracker.record(key, () => closeJdBrowserSession(session.sessionId)); throw error; }
}
export function detailLocationTargets(data: AtlasDataset, jobId: string): Target[] {
  const job = data.jobs.find(entry => entry.id === jobId);
  if (!job) return [];
  return data.listings.flatMap(listing => {
    if (!job.listingIds.includes(listing.id) || listing.canonicalJobId !== jobId || !listing.canonicalUrl) return [];
    const provider = (Object.keys(REVIEWED_PLATFORM_NAMES) as PlatformDetailLocations["provider"][]).find(value => listing.sourceId === `reviewed-platform-${value}`);
    const identity = provider && reviewedCardIdentity(listing.canonicalUrl, provider);
    if (!identity || !provider || listing.sourceRecordId !== identity.id) return [];
    const source = data.sources.find(entry => entry.sourceId === listing.sourceId);
    return source ? [{ listingId: listing.id, jobId, url: listing.canonicalUrl, provider, label: source.attribution.label }] : [];
  });
}

/** A normal document section, independent of filtering after a successful address import. */
export function AtlasDetailLocations(props: AtlasDetailLocationsProps) {
  const targets = detailLocationTargets(props.data, props.jobId);
  const [selected, setSelected] = useState("");
  const onClose = useRef(props.onClose); onClose.current = props.onClose;
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing) onClose.current(); };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, []);
  const target = targets.find(entry => entry.listingId === selected) ?? targets[0];
  if (!target) return null;
  return <section className="atlas-detail-locations" aria-label="原岗位办公地点读取">
    <header><h2>核对岗位办公地点</h2><button type="button" aria-label="关闭原岗位地址核对" onClick={props.onClose}><X size={16} /></button></header>
    <p>{props.data.jobs.find(job => job.id === props.jobId)?.title.value}</p>
    {targets.length > 1 && <label>地址来源<select aria-label="办公地点来源" value={target.listingId} onChange={event => setSelected(event.target.value)}>{targets.map(entry => <option key={entry.listingId} value={entry.listingId}>{entry.label}</option>)}</select></label>}
    <DetailLocationReader key={`${props.endpoint}:${props.token}:${target.jobId}:${target.listingId}:${target.url}`} {...props} target={target} />
  </section>;
}

function DetailLocationReader({ endpoint, token, data, target, onSnapshot, onOfficeSnapshot }: AtlasDetailLocationsProps & { target: Target }) {
  const client = useMemo(() => createAtlasSourceClient(endpoint, token), [endpoint, token]);
  const scope = JSON.stringify([endpoint, token, target.jobId, target.listingId]);
  const [recovery] = useState(() => recoverableWrites.get(scope));
  const cleanupStatus = useSyncExternalStore(jdBrowserCleanupTracker.subscribe, jdBrowserCleanupTracker.getSnapshot, jdBrowserCleanupTracker.getSnapshot);
  const [expanded, setExpanded] = useState(true);
  const [capture, setCapture] = useState<PlatformDetailLocations | undefined>(recovery?.capture);
  const [preview, setPreview] = useState<DetailLocationsPreview | undefined>(recovery?.preview);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState<PendingWrite | undefined>(recovery?.pending);
  const [saved, setSaved] = useState<SavedWrite | undefined>(recovery?.saved);
  const [fresh, setFresh] = useState<AtlasDataset>();
  const [officeId, setOfficeId] = useState<string>();
  const [session, setSession] = useState<JdBrowserSession>();
  const [operation, setOperation] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const ownedSession = useRef<JdBrowserSession | undefined>(undefined);
  const latest = useRef({ revision: data.revision, onSnapshot, onOfficeSnapshot, closed: false });
  latest.current.revision = data.revision; latest.current.onSnapshot = onSnapshot; latest.current.onOfficeSnapshot = onOfficeSnapshot;
  useEffect(() => {
    const lifecycle = latest.current;
    lifecycle.closed = false;
    return () => {
      lifecycle.closed = true; active.current?.abort(); active.current = null;
      const owned = ownedSession.current; ownedSession.current = undefined;
      if (owned) void closeOwnedSession(owned).catch(() => { /* Shared exact-session recovery remains available after this pane unmounts. */ });
    };
  }, []);
  const busy = !!operation;
  const alive = (signal: AbortSignal) => { signal.throwIfAborted(); if (latest.current.closed || active.current?.signal !== signal) throw new Error("岗位读取范围已改变。"); };
  async function run(label: string, task: (signal: AbortSignal) => Promise<void>) {
    if (active.current || latest.current.closed) return;
    const controller = new AbortController(); active.current = controller; setOperation(label); setError("");
    const timer = setTimeout(() => controller.abort(), 60_000);
    try { await task(controller.signal); }
    catch (problem) {
      if (problem instanceof JdBrowserStartCleanupError) jdBrowserCleanupTracker.record(`start:${problem.requestId}`, () => cancelJdBrowserStartRequest(problem.input, problem.requestId));
      if (!latest.current.closed && active.current === controller) {
        setError(controller.signal.aborted ? "已停止等待；若已经提交保存，请使用原请求核对回执。" : problem instanceof Error ? problem.message : "本次操作未完成。");
      }
    } finally { clearTimeout(timer); if (active.current === controller) { active.current = null; if (!latest.current.closed) setOperation(""); } }
  }
  function accept(result: JdImportResult) {
    const value = result.detailLocations;
    const identity = value && reviewedCardIdentity(value.url, target.provider), expected = reviewedCardIdentity(target.url, target.provider);
    if (result.provenance.edited || !value || !identity || identity.id !== expected?.id || value.provider !== target.provider || !value.locations.length) {
      setMessage("原岗位正文已读取，但没有可核对的结构化工作地址。当前地点保持不变；可打开原文核对工作地址。"); return;
    }
    setCapture(value); setMessage(`已读取 ${value.locations.length} 个来源地点，请核对后预览。尚未保存地址或坐标。`);
  }
  function readStatic() { return run("正在读取原岗位地址…", async signal => {
    setCapture(undefined); setPreview(undefined); setConfirmed(false); setMessage("");
    const result = await extractJdLink(target.url, signal); alive(signal); accept(result);
  }); }
  function openBrowser() { return run("正在打开专用岗位页…", async signal => {
    const next = await startJdBrowserSession(target.url, signal);
    // A late start belongs to this request, never to the newly selected job.
    if (latest.current.closed || signal.aborted) { await closeOwnedSession(next); return; }
    alive(signal); ownedSession.current = next; setSession(next);
    setMessage("请在专用窗口核对原岗位，自行完成登录或验证，然后点击“读取当前岗位页”。如已有搜索会话，请先在来源面板结束该搜索。");
  }); }
  function readBrowser() { return run("正在读取当前岗位页…", async signal => {
    if (!session) return;
    setCapture(undefined); setPreview(undefined); setConfirmed(false); setMessage("");
    const result = await readJdBrowserSession(session, signal); alive(signal); accept(result);
  }); }
  function endBrowser() { return run("正在结束本次岗位页…", async signal => {
    if (session) { await closeOwnedSession(session); alive(signal); ownedSession.current = undefined; setSession(undefined); }
  }); }
  function readPreview() { return run("正在预览地点变化…", async signal => {
    if (!capture) return;
    const value = await client.previewDetailLocations({ jobId: target.jobId, listingId: target.listingId, capture, expectedRevision: data.revision }, { signal });
    alive(signal); if (value.expectedRevision !== latest.current.revision) throw new Error("索引已更新，请重新预览地点变化。");
    setPreview(value); setConfirmed(false);
  }); }
  function publish(next: AtlasDataset, minimumRevision = saved?.revision ?? 0) {
    if (next.revision < Math.max(latest.current.revision, minimumRevision)) throw new Error("读取的索引早于已保存或当前版本，请重新读取索引。");
    recoverableWrites.delete(scope); setFresh(next); latest.current.onSnapshot(next);
  }
  function refresh() { return run("正在重新读取索引…", async signal => { const next = await client.snapshot({ signal }); alive(signal); publish(next); }); }
  function commit() { return run("正在保存来源地点…", async signal => {
    if (!pending && (!capture || !preview || !confirmed || preview.expectedRevision !== latest.current.revision)) return;
    const request = pending ?? { input: { jobId: target.jobId, listingId: target.listingId, capture: capture!, expectedRevision: preview!.expectedRevision, previewFingerprint: preview!.previewFingerprint, reviewed: true as const }, key: `detail-address-${crypto.randomUUID()}` };
    recoverableWrites.set(scope, { pending: request, capture, preview });
    setPending(request);
    let receipt;
    try { receipt = await client.importDetailLocations(request.input, { signal, idempotencyKey: request.key }); }
    catch (problem) {
      if (problem instanceof AtlasSourceServiceError && ["stale-version", "invalid-input", "source-changed", "idempotency-conflict", "not-authorized"].includes(problem.code)) { recoverableWrites.delete(scope); alive(signal); setPending(undefined); setPreview(undefined); setConfirmed(false); }
      throw problem;
    }
    const result = { revision: receipt.revision, locationIds: preview?.newLocations.map(location => location.id) ?? [] };
    recoverableWrites.set(scope, { saved: result, capture, preview });
    alive(signal); setSaved(result); setPending(undefined); setFresh(undefined);
    try { const next = await client.snapshot({ signal }); alive(signal); publish(next, receipt.revision); }
    catch (problem) { alive(signal); throw new Error(`地点已保存至版本 ${receipt.revision}。请重新读取索引后继续核对办公位置。`, { cause: problem }); }
  }); }
  const locations = saved && fresh && fresh.revision >= saved.revision && fresh.revision >= data.revision
    ? fresh.locations.filter(location => saved.locationIds.includes(location.id) && fresh.jobs.find(job => job.id === target.jobId)?.locationIds.includes(location.id)) : [];
  const office = locations.find(location => location.id === officeId);
  return <>
    <button type="button" className="atlas-detail-address-open" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}><FileSearch size={14} />{expanded ? "收起原岗位地址核对" : "读取原岗位办公地点"}</button>
    {expanded && <div className="atlas-detail-address-body" aria-busy={busy}>
      <p>从 {target.label} 的原岗位详情补充地点。来源未披露门牌时保留已有精度；坐标需另行核对。</p>
      <a href={target.url} target="_blank" rel="noopener noreferrer">打开该岗位原文</a>
      {!saved && <div className="atlas-detail-address-actions"><button type="button" disabled={busy || !!pending} onClick={() => void readStatic()}>读取公开岗位页</button><button type="button" disabled={busy || !!pending || !!session || cleanupStatus.pending > 0 || cleanupStatus.retrying} onClick={() => void openBrowser()}>打开专用岗位页</button></div>}
      {session && <div className="atlas-detail-address-session"><p>本次专用岗位页 · {new Date(session.expiresAt).toLocaleTimeString()} 到期。只读取本岗位。</p><button type="button" disabled={busy || !!pending || !!saved} onClick={() => void readBrowser()}>读取当前岗位页</button><button type="button" disabled={busy} onClick={() => void endBrowser()}>结束本次岗位页</button></div>}
      {cleanupStatus.pending > 0 && <p role="status">有 {cleanupStatus.pending} 个先前岗位页尚未确认结束。<button type="button" disabled={busy || cleanupStatus.retrying} onClick={() => void jdBrowserCleanupTracker.retry()}>重试清理先前岗位页</button></p>}
      {pending && <p role="status">本次保存结果待确认。关闭后重新打开同一岗位，可继续核对原请求回执；页面刷新前请完成核对。</p>}
      {message && !saved && <p role="status">{message}</p>}
      {capture && !saved && <div aria-label="读取到的地点证据">{capture.locations.map((location, index) => <article key={index}><strong>{location.streetAddress ?? location.raw}</strong><p>{[location.countryCode, location.region, location.city, location.postalCode].filter(Boolean).join(" / ") || "行政范围未明确披露"} · {capture.workMode === "remote" ? "远程资格范围，非办公室" : "来源工作地点，坐标未核对"}</p><details><summary>核对地址出处与原文</summary><p>{location.evidence.selector}</p><pre>{location.evidence.quote}</pre></details></article>)}</div>}
      {capture && !saved && <button type="button" disabled={busy || !!pending} onClick={() => void readPreview()}>预览地点变化</button>}
      {preview && !saved && <div className="atlas-detail-address-preview"><p>将补充 {preview.newLocations.length} 个地点，基于索引版本 {preview.expectedRevision}。地点变化可能使旧地区或办公位置确认失效。</p><ul>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul><label><input type="checkbox" checked={confirmed} disabled={busy || !!pending || preview.expectedRevision !== data.revision} onChange={event => setConfirmed(event.target.checked)} />我已核对原岗位与地点出处，确认保存这些来源地点</label>{preview.expectedRevision !== data.revision && <p role="status">索引版本已改变，请重新预览。</p>}</div>}
      {!saved && (preview || pending) && <button type="button" disabled={busy || (!pending && (!confirmed || preview?.expectedRevision !== data.revision))} onClick={() => void commit()}>{pending ? "核对本次保存回执" : "确认保存来源地点"}</button>}
      {saved && <div role="status"><p>来源地点已保存至索引版本 {saved.revision}。办公位置以当前核对记录为准。</p><button type="button" disabled={busy} onClick={() => void refresh()}>重新读取索引</button>{locations.map(location => <article key={location.id}><strong>{location.streetAddress ?? location.raw}</strong>{location.kind === "office" && <button type="button" disabled={busy} onClick={() => setOfficeId(location.id)}><MapPin size={13} />核对这个办公位置</button>}</article>)}</div>}
      {office && fresh && <Suspense fallback={<p role="status">正在打开办公位置核对…</p>}><OfficeConfirmation key={`${office.id}:${fresh.revision}`} endpoint={endpoint} token={token} jobId={target.jobId} location={office} revision={fresh.revision} onClose={() => setOfficeId(undefined)} onSnapshot={next => {
        if (latest.current.closed || fresh.revision < latest.current.revision || next.revision < latest.current.revision) return;
        setOfficeId(undefined); setFresh(next); latest.current.onOfficeSnapshot(next, office);
      }} /></Suspense>}
      {busy && <div className="atlas-detail-address-progress" role="status"><Loader2 size={15} className="animate-spin" /><span>{operation}</span><button type="button" aria-label="停止等待岗位地址操作" onClick={() => active.current?.abort()}><X size={13} />停止等待</button></div>}
      {error && <p role="alert">{error}</p>}
    </div>}
  </>;
}
